import {
  clearDatabaseOperationReadCache,
  type Database,
  databaseCoherenceGeneration,
  databaseCoreKey,
  isDatabaseOperationView,
  lookupDatabaseOperationRead,
  storeDatabaseOperationRead,
} from "../storage.js";

const NEGATIVE = -1;
const MAX_ENTRIES = 8192;

interface RootResolveCache {
  readonly paths: Map<string, number>;
  generation: number;
}

interface OperationPathEntry {
  kind: "resolve-path";
  inode: number | null;
}

export interface OperationNodeEntry {
  kind: "resolve-node";
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  linkTarget?: string;
}

const caches = new WeakMap<object, RootResolveCache>();

function cacheFor(db: Database): RootResolveCache {
  const key = databaseCoreKey(db);
  const generation = databaseCoherenceGeneration(db);
  let cache = caches.get(key);
  if (cache === undefined) {
    cache = { paths: new Map(), generation };
    caches.set(key, cache);
  } else if (cache.generation !== generation) {
    cache.paths.clear();
    cache.generation = generation;
  }
  return cache;
}

export type ResolveCacheHit = { kind: "inode"; inode: number } | { kind: "negative" };

export function lookupResolveCache(
  db: Database,
  canonicalPath: string,
): ResolveCacheHit | undefined {
  if (isDatabaseOperationView(db)) {
    const value = lookupDatabaseOperationRead(db, pathKey(canonicalPath));
    if (!isOperationPathEntry(value)) return undefined;
    return value.inode === null ? { kind: "negative" } : { kind: "inode", inode: value.inode };
  }

  const cache = cacheFor(db).paths;
  const value = cache.get(canonicalPath);
  if (value === undefined) return undefined;
  cache.delete(canonicalPath);
  cache.set(canonicalPath, value);
  return value === NEGATIVE ? { kind: "negative" } : { kind: "inode", inode: value };
}

export function storeResolveCache(db: Database, canonicalPath: string, inode: number | null): void {
  if (db.inTransaction) return;
  if (isDatabaseOperationView(db)) {
    storeDatabaseOperationRead(db, pathKey(canonicalPath), {
      kind: "resolve-path",
      inode,
    } satisfies OperationPathEntry);
    return;
  }

  const cache = cacheFor(db).paths;
  cache.delete(canonicalPath);
  cache.set(canonicalPath, inode === null ? NEGATIVE : inode);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export function lookupOperationNodeCache(
  db: Database,
  inode: number,
): OperationNodeEntry | undefined {
  if (!isDatabaseOperationView(db) || db.inTransaction) return undefined;
  const value = lookupDatabaseOperationRead(db, nodeKey(inode));
  return isOperationNodeEntry(value) ? value : undefined;
}

export function storeOperationNodeCache(db: Database, node: OperationNodeEntry): void {
  if (!isDatabaseOperationView(db) || db.inTransaction) return;
  storeDatabaseOperationRead(db, nodeKey(node.inode), node);
}

export function invalidateResolveExact(db: Database, canonicalPath: string): void {
  if (isDatabaseOperationView(db)) {
    clearDatabaseOperationReadCache(db);
    return;
  }
  caches.get(databaseCoreKey(db))?.paths.delete(canonicalPath);
}

export function invalidateResolveSubtree(db: Database, canonicalPath: string): void {
  if (isDatabaseOperationView(db)) {
    clearDatabaseOperationReadCache(db);
    return;
  }
  const cache = caches.get(databaseCoreKey(db))?.paths;
  if (cache === undefined || cache.size === 0) return;
  if (canonicalPath === "/") {
    cache.clear();
    return;
  }
  cache.delete(canonicalPath);
  const prefix = `${canonicalPath}/`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function clearResolveCache(db: Database): void {
  if (isDatabaseOperationView(db)) {
    clearDatabaseOperationReadCache(db);
    return;
  }
  caches.get(databaseCoreKey(db))?.paths.clear();
}

function pathKey(path: string): string {
  return `resolve:path:${path}`;
}

function nodeKey(inode: number): string {
  return `resolve:node:${inode}`;
}

function isOperationPathEntry(value: unknown): value is OperationPathEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "resolve-path" &&
    "inode" in value &&
    (typeof value.inode === "number" || value.inode === null)
  );
}

function isOperationNodeEntry(value: unknown): value is OperationNodeEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "resolve-node" &&
    "inode" in value &&
    typeof value.inode === "number" &&
    "type" in value &&
    (value.type === "file" || value.type === "dir" || value.type === "symlink") &&
    "mode" in value &&
    typeof value.mode === "number" &&
    "mtime" in value &&
    typeof value.mtime === "number" &&
    "size" in value &&
    typeof value.size === "number" &&
    (!("linkTarget" in value) ||
      value.linkTarget === undefined ||
      typeof value.linkTarget === "string")
  );
}
