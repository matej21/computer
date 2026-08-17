import { createHash } from "node:crypto";

import type { WorkspaceErrorCode } from "../errors.js";

export interface BulkEntryError {
  code: WorkspaceErrorCode | "EFBIG";
  message: string;
  path: string;
}

export interface BulkPage<Entry> {
  entries: Entry[];
  cursor?: string;
}

export interface WorkspaceWalkEntry {
  path: string;
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  linkTarget?: string;
}

export interface WalkOptions {
  limit: number;
  maxBytes: number;
  cursor?: string;
  depth?: number;
  exclude?: readonly string[];
  excludeHidden?: boolean;
}

export type ReadFilesEntry =
  | { path: string; content: Uint8Array; error?: never }
  | { path: string; content?: never; error: BulkEntryError };

export interface ReadFilesOptions {
  limit: number;
  maxBytes: number;
  cursor?: string;
}

export interface WriteFilesEntry {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

export interface WriteFilesOptions {
  maxBytes: number;
}

export interface RmFilesOptions {
  recursive?: boolean;
  force?: boolean;
  maxEntries: number;
  maxMetadataBytes: number;
}

export function bulkRequestDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function encodeBulkCursor(
  kind: "w" | "r",
  rev: number,
  offset: number,
  digest: string,
): string {
  return `${kind}:${rev.toString(36)}:${offset.toString(36)}:${digest}`;
}

export function decodeBulkCursor(
  cursor: string,
  kind: "w" | "r",
  digest: string,
): { rev: number; offset: number } | undefined {
  const parts = cursor.split(":");
  if (parts.length !== 4 || parts[0] !== kind || parts[3] !== digest) return undefined;
  const rev = parseBase36(parts[1]);
  const offset = parseBase36(parts[2]);
  return rev === undefined || offset === undefined ? undefined : { rev, offset };
}

function parseBase36(value: string): number | undefined {
  if (!/^[0-9a-z]+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed.toString(36) === value
    ? parsed
    : undefined;
}
