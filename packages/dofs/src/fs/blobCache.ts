// In-process LRU cache of vfs_blob_bytes payloads, keyed by hash.
//
// FUSE reads up to 128 KiB at a time (the kernel's default max_read);
// our chunk size is 512 KiB. A sequential read of a chunk-backed file
// re-fetches the same blob 4x by default. Worse, a 64 MiB file of
// repeated content (e.g. `dd if=/dev/zero`) deduplicates to a single
// blob in vfs_blobs, and we then re-fetch that one blob 512 times
// over the lifetime of one read pass.
//
// vfs_blob_bytes is content-addressed. The normal write path
// (upsertChunkBlob) uses ON CONFLICT DO NOTHING, so a correct
// (hash, bytes) pair is never overwritten and the cache stays valid
// for it. The one exception is repair: stageBlob (the sync receiver
// path) uses ON CONFLICT DO UPDATE SET bytes to replace an incomplete
// or size-mismatched payload left by an interrupted or corrupt write,
// and clears this cache afterward so a stale payload is never served
// after a repair.
//
// The cache is bounded (CHUNK_CACHE_MAX_ENTRIES) and per database core so
// root and operation views share payloads. Eviction is
// LRU; access moves an entry to the most-recent position.

import { type Database, databaseCoreKey } from "../storage.js";

// Number of distinct blob payloads kept in memory per database core.
// At 512 KiB per blob this caps the cache at ~8 MiB, large enough
// to hold a handful of hot chunks for sequential reads of large
// files without dominating process memory.
const CHUNK_CACHE_MAX_ENTRIES = 16;

const caches = new WeakMap<object, Map<string, Uint8Array>>();
const completeFiles = new WeakMap<object, Map<number, true>>();

function cacheFor(db: Database): Map<string, Uint8Array> {
  const key = databaseCoreKey(db);
  let cache = caches.get(key);
  if (cache === undefined) {
    cache = new Map();
    caches.set(key, cache);
  }
  return cache;
}

// Stringify a 32-byte hash so it can key a JS Map. Latin-1
// preserves every byte exactly and avoids the allocation cost of
// hex encoding for what is a very hot path.
function hashKey(hash: Uint8Array): string {
  let out = "";
  for (let i = 0; i < hash.byteLength; i++) {
    out += String.fromCharCode(hash[i]);
  }
  return out;
}

function storeBlobBytes(db: Database, hash: Uint8Array, bytes: Uint8Array): void {
  const cache = cacheFor(db);
  const key = hashKey(hash);
  cache.delete(key);
  cache.set(key, bytes);
  while (cache.size > CHUNK_CACHE_MAX_ENTRIES) {
    const first = cache.keys().next();
    if (first.done === true) break;
    cache.delete(first.value);
  }
}

/** Cache payload bytes already returned by another storage query. */
export function cacheBlobBytes(db: Database, hash: Uint8Array, bytes: Uint8Array): void {
  storeBlobBytes(db, hash, bytes);
}

/** Report whether a complete read has primed this inode's payload cache. */
export function hasCompleteFileBytes(db: Database, inode: number): boolean {
  return completeFiles.get(databaseCoreKey(db))?.has(inode) === true;
}

/** Record that a complete read populated every payload for this inode. */
export function markCompleteFileBytes(db: Database, inode: number): void {
  const key = databaseCoreKey(db);
  let inodes = completeFiles.get(key);
  if (inodes === undefined) {
    inodes = new Map();
    completeFiles.set(key, inodes);
  }
  inodes.delete(inode);
  inodes.set(inode, true);
  while (inodes.size > CHUNK_CACHE_MAX_ENTRIES) {
    const first = inodes.keys().next();
    if (first.done === true) break;
    inodes.delete(first.value);
  }
}

// Look up blob bytes by hash. Cache hit returns the cached
// Uint8Array directly (callers must not mutate it). Cache miss
// queries vfs_blob_bytes and stores the result. Returns undefined
// if the blob isn't in the store.
export function getBlobBytes(db: Database, hash: Uint8Array): Uint8Array | undefined {
  const cache = cacheFor(db);
  const key = hashKey(hash);
  const cached = cache.get(key);
  if (cached !== undefined) {
    // Reinsert to move to the most-recent position. Map iteration
    // order is insertion order, so this gives us LRU eviction for
    // free without a separate doubly-linked list.
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const row = db.one<{ bytes: Uint8Array }>(
    "SELECT bytes FROM vfs_blob_bytes WHERE hash = ?",
    hash,
  );
  if (row === undefined) return undefined;
  storeBlobBytes(db, hash, row.bytes);
  return row.bytes;
}

// Reset the cache for `db`. Tests use this to keep cache state from
// leaking between cases that share a Database constructor pattern.
export function clearBlobCache(db: Database): void {
  const key = databaseCoreKey(db);
  caches.delete(key);
  completeFiles.delete(key);
}
