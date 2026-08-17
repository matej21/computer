import { createHash } from "node:crypto";

import { flushWriteBatchBeforeMutation } from "../fs/writeBatch.js";
import type { Database } from "../storage.js";

// A manifest names the ordered chunk list for a single file. Two
// files whose bytes chunk identically share one manifest row, which
// is what lets the sync wire say "this file is the same as the one
// I just sent you" by hash alone.
//
// Encoding is JSON for now — readable, debuggable, and structurally
// identical to casync's `.caidx`. A future commit can swap the
// encoding to the `.caidx` byte layout without a schema change.

export interface ManifestChunk {
  hash: Uint8Array;
  size: number;
}

export const MANIFEST_VERSION = 1;

interface EncodedManifest {
  version: number;
  chunks: { hash: string; size: number }[];
}

export interface PreparedManifest {
  encoded: Uint8Array;
  hash: Uint8Array;
  size: number;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

// Serialize a chunk list into the canonical manifest bytes. The
// hash is taken over these bytes and the same bytes are stored, so
// producing them once keeps the two in step.
function encodeManifest(chunks: ManifestChunk[]): Uint8Array {
  const encoded: EncodedManifest = {
    version: MANIFEST_VERSION,
    chunks: chunks.map((c) => ({ hash: toHex(c.hash), size: c.size })),
  };
  return new TextEncoder().encode(JSON.stringify(encoded));
}

// Compute the manifest hash for a chunk list without touching the
// DB. Used by the apply path to short-circuit when an upstream
// entry already matches the local node — the manifest hash is
// content-addressed so identical chunks always produce the same
// hash.
export function computeManifestHash(chunks: ManifestChunk[]): Uint8Array {
  return sha256(encodeManifest(chunks));
}

export function prepareManifest(chunks: ManifestChunk[]): PreparedManifest {
  const encoded = encodeManifest(chunks);
  return {
    encoded,
    hash: sha256(encoded),
    size: chunks.reduce((acc, chunk) => acc + chunk.size, 0),
  };
}

// Build a manifest row for the given chunk list. Idempotent: a
// second call with the same chunks no-ops on the UNIQUE(hash). The
// returned hash is what the caller writes onto
// `vfs_nodes.manifest_hash`.
export function buildManifest(db: Database, chunks: ManifestChunk[], now: number): Uint8Array {
  flushWriteBatchBeforeMutation(db);
  const { encoded, hash, size } = prepareManifest(chunks);
  db.run(
    "INSERT INTO vfs_manifests (hash, size, encoded, last_seen) VALUES (?, ?, ?, ?) ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen",
    hash,
    size,
    encoded,
    now,
  );
  return hash;
}
