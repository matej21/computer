import { createWorkspaceError, type WorkspaceErrorCode } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { currentRev } from "../sync/watermarks.js";
import { cacheBlobBytes, getBlobBytes } from "./blobCache.js";
import { findPendingWriteBuffer } from "./pendingWriteBuffer.js";
import {
  type BulkEntryError,
  type BulkPage,
  bulkRequestDigest,
  decodeBulkCursor,
  encodeBulkCursor,
  type ReadFilesEntry,
  type ReadFilesOptions,
} from "./publicBulk.js";
import { type ResolvedInode, resolveMany } from "./resolve.js";
import { getWriteBuffer } from "./writeBuffer.js";

const MAX_LIMIT = 256;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
const MAX_PATHS = 4096;
const MAX_PATH_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

interface PendingRead {
  index: number;
  path: string;
  inode: number;
  size: number;
}

interface MutableEntry {
  path: string;
  content?: Uint8Array;
  error?: BulkEntryError;
}

interface ChunkRow {
  inode: number;
  idx: number;
  hash: Uint8Array;
  size: number;
  bytes: Uint8Array | null;
}

export function readFiles(
  db: Database,
  paths: readonly string[],
  options: ReadFilesOptions,
): BulkPage<ReadFilesEntry> {
  validateRequest(paths, options);
  const canonicalPaths = paths.map((path) => canonicalizePath(path).path);
  const digest = bulkRequestDigest({
    paths,
    limit: options.limit,
    maxBytes: options.maxBytes,
  });
  const decoded =
    options.cursor === undefined ? undefined : decodeBulkCursor(options.cursor, "r", digest);
  if (options.cursor !== undefined && decoded === undefined) {
    throw createWorkspaceError("EINVAL", "invalid readFiles cursor");
  }
  const offset = decoded?.offset ?? 0;
  if (offset > paths.length) throw createWorkspaceError("EINVAL", "invalid readFiles cursor");
  const snapshotRev = currentRev(db);
  if (decoded !== undefined && decoded.rev !== snapshotRev) {
    throw createWorkspaceError("ESTALE", "readFiles cursor snapshot is stale");
  }
  if (offset === paths.length) return { entries: [] };

  const pagePaths = canonicalPaths.slice(offset, offset + options.limit);
  const nodes: Array<ResolvedInode | null | undefined> = new Array(pagePaths.length);
  const unresolvedPaths: string[] = [];
  const unresolvedIndexes: number[] = [];
  for (const [index, path] of pagePaths.entries()) {
    const pending = findPendingWriteBuffer(db, path);
    if (pending !== undefined) {
      nodes[index] = {
        inode: pending.pending?.pendingInode ?? 0,
        type: "file",
        mode: pending.mode,
        mtime: pending.pending?.mtime ?? 0,
        size: pending.size,
      };
    } else {
      unresolvedPaths.push(path);
      unresolvedIndexes.push(index);
    }
  }
  const resolved = resolveMany(db, unresolvedPaths);
  unresolvedIndexes.forEach((index, order) => {
    nodes[index] = resolved[order];
  });

  const entries: MutableEntry[] = [];
  const pendingReads: PendingRead[] = [];
  let contentBytes = 0;
  for (let index = 0; index < pagePaths.length; index += 1) {
    if (entries.length > 0 && contentBytes === options.maxBytes) break;
    const path = paths[offset + index];
    const canonical = pagePaths[index];
    const node = nodes[index];
    if (node === undefined || node === null) {
      entries.push({ path, error: entryError("ENOENT", "no such file", path) });
      continue;
    }
    if (node.type !== "file") {
      entries.push({ path, error: entryError("EISDIR", "path is a directory", path) });
      continue;
    }
    const buffered = getWriteBuffer(db, node.inode);
    const effectiveSize = buffered?.dirty === true ? buffered.size : node.size;
    if (effectiveSize > options.maxBytes) {
      entries.push({ path, error: entryError("EFBIG", "file exceeds readFiles maxBytes", path) });
      continue;
    }
    if (contentBytes + effectiveSize > options.maxBytes) break;

    const entryIndex = entries.push({ path }) - 1;
    contentBytes += effectiveSize;
    const pending = findPendingWriteBuffer(db, canonical);
    if (pending !== undefined) {
      entries[entryIndex].content = pending.buf.slice(0, pending.size);
      continue;
    }
    if (buffered?.dirty === true) {
      entries[entryIndex].content = buffered.buf.slice(0, buffered.size);
      continue;
    }
    pendingReads.push({ index: entryIndex, path, inode: node.inode, size: node.size });
  }

  fillPendingReads(db, pendingReads, entries);
  const resultEntries = entries.map(toReadFilesEntry);
  const nextOffset = offset + resultEntries.length;
  return {
    entries: resultEntries,
    ...(nextOffset < paths.length
      ? { cursor: encodeBulkCursor("r", snapshotRev, nextOffset, digest) }
      : {}),
  };
}

function fillPendingReads(
  db: Database,
  pending: readonly PendingRead[],
  entries: MutableEntry[],
): void {
  const wanted = [...new Set(pending.map((entry) => entry.inode))];
  const rows =
    wanted.length === 0
      ? []
      : db.all<ChunkRow>(
          `SELECT c.inode AS inode, c.idx AS idx, c.hash AS hash, c.size AS size,
                  b.bytes AS bytes
             FROM json_each(?) wanted
             JOIN vfs_chunks c ON c.inode = wanted.value
             LEFT JOIN vfs_blob_bytes b ON b.hash = c.hash
            ORDER BY c.inode, c.idx`,
          JSON.stringify(wanted),
        );
  const grouped = new Map<number, ChunkRow[]>();
  for (const row of rows) {
    const held = grouped.get(row.inode);
    if (held === undefined) grouped.set(row.inode, [row]);
    else held.push(row);
  }
  const assembled = new Map<number, Uint8Array | undefined>();
  for (const file of pending) {
    if (assembled.has(file.inode)) continue;
    const chunks = grouped.get(file.inode) ?? [];
    let total = 0;
    let valid = true;
    const parts: Uint8Array[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const bytes = chunk.bytes ?? getBlobBytes(db, chunk.hash);
      if (chunk.idx !== index || bytes === undefined || bytes.byteLength !== chunk.size) {
        valid = false;
        break;
      }
      if (chunk.bytes !== null) cacheBlobBytes(db, chunk.hash, chunk.bytes);
      parts.push(bytes);
      total += bytes.byteLength;
    }
    if (!valid || total !== file.size) {
      assembled.set(file.inode, undefined);
      continue;
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.byteLength;
    }
    assembled.set(file.inode, bytes);
  }
  for (const file of pending) {
    const content = assembled.get(file.inode);
    if (content === undefined) {
      entries[file.index].error = entryError("EIO", "missing file data", file.path);
    } else {
      entries[file.index].content = content.slice();
    }
  }
}

function toReadFilesEntry(entry: MutableEntry): ReadFilesEntry {
  if (entry.error !== undefined) return { path: entry.path, error: entry.error };
  if (entry.content === undefined) {
    return { path: entry.path, error: entryError("EIO", "missing file data", entry.path) };
  }
  return { path: entry.path, content: entry.content };
}

function entryError(
  code: WorkspaceErrorCode | "EFBIG",
  message: string,
  path: string,
): BulkEntryError {
  return { code, message, path };
}

function validateRequest(paths: readonly string[], options: ReadFilesOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    throw createWorkspaceError("EINVAL", "invalid readFiles limit");
  }
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MAX_CONTENT_BYTES
  ) {
    throw createWorkspaceError("EINVAL", "invalid readFiles maxBytes");
  }
  if (paths.length > MAX_PATHS) throw createWorkspaceError("EINVAL", "too many readFiles paths");
  let pathBytes = 0;
  for (const path of paths) pathBytes += encoder.encode(path).byteLength;
  if (pathBytes > MAX_PATH_BYTES) {
    throw createWorkspaceError("EINVAL", "readFiles paths are too large");
  }
}
