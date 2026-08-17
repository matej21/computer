import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { createProviderOperationView, type SQLiteWorkspaceProvider } from "../provider.js";
import { ROOT_INODE } from "../schema/index.js";
import {
  closeDatabaseOperationView,
  createDatabaseOperationView,
  type Database,
  databaseCoreKey,
  registerDatabaseTransactionBarrier,
  transactDatabaseWithoutBarrier,
} from "../storage.js";
import { type PreparedManifest, prepareManifest } from "../sync/manifests.js";
import { invalidateResolveExact } from "./resolveCache.js";
import type { WriteFileOptions } from "./writeFile.js";
import { chunksOf } from "./writeFile.js";

const HARD_MAX_FILES = 1024;
const HARD_MAX_BYTES = 4 * 1024 * 1024;
const HARD_MAX_BLOB_ROWS = 50;
const HARD_MAX_METADATA_ROWS = 1024;
const HARD_MAX_METADATA_PAGE_BYTES = 1024 * 1024;
const MAX_CACHED_DIRECTORY_NAMES = 1024;

export const DEFAULT_WRITE_BATCH_LIMITS = {
  maxBytes: HARD_MAX_BYTES,
  maxFiles: HARD_MAX_FILES,
  maxBlobRowsPerStatement: HARD_MAX_BLOB_ROWS,
  maxMetadataPageBytes: HARD_MAX_METADATA_PAGE_BYTES,
};

export interface WriteBatchOptions {
  maxBlobRowsPerStatement?: number;
  maxBytes?: number;
  maxFiles?: number;
  maxMetadataPageBytes?: number;
  metadataRowsPerPage?: number;
}

interface WriteBatchLimits {
  maxBlobRowsPerStatement: number;
  maxBytes: number;
  maxFiles: number;
  maxMetadataPageBytes: number;
  metadataRowsPerPage: number;
}

interface PreparedChunk {
  bytes: Uint8Array;
  hash: Uint8Array;
  size: number;
}

interface StagedFile {
  canonicalPath: string;
  chunks: PreparedChunk[];
  leafName: string;
  mode: number;
  mtime: number;
  manifest: PreparedManifest;
  parentInode: number;
  size: number;
}

interface DirectoryState {
  inode: number;
  names: Set<string>;
}

interface WriteBatchState {
  bytes: number;
  checking: boolean;
  entries: StagedFile[];
  failed: boolean;
  failure: unknown;
  flushing: boolean;
  limits: WriteBatchLimits;
  metadataRows: number;
  parents: Map<string, DirectoryState>;
  view: Database;
}

interface BatchCheckpoint {
  bytes: number;
  entries: StagedFile[];
  metadataRows: number;
  parents: Map<string, DirectoryState>;
}

interface ParentRow {
  inode: number;
  level: number;
  type: "file" | "dir" | "symlink";
}

interface NameRow {
  name: string;
}
interface SequenceRow {
  seq: number;
}

interface TargetCheckRow {
  collisions: number;
  missingParents: number;
}

interface RevisionRow {
  v: number;
}

interface BlobMetadataRow {
  hash: string;
  lastSeen: number;
  size: number;
}

interface BlobPayloadRow {
  bytes: Uint8Array;
  hash: Uint8Array;
}

interface ChunkMetadataRow {
  hash: string;
  idx: number;
  inode: number;
  size: number;
}

interface DirentMetadataRow {
  childInode: number;
  name: string;
  parentInode: number;
}

interface ManifestMetadataRow {
  encoded: string;
  hash: string;
  lastSeen: number;
  size: number;
}

interface NodeMetadataRow {
  inode: number;
  manifestHash: string;
  mode: number;
  mtime: number;
  rev: number;
  size: number;
}

const activeBatches = new WeakMap<object, WriteBatchState>();

type SynchronousResult<Result> = Result extends PromiseLike<unknown> ? never : Result;

export function withWriteBatchSync<T>(
  db: Database,
  run: (batchDb: Database) => SynchronousResult<T>,
  options: WriteBatchOptions = {},
): T {
  const key = databaseCoreKey(db);
  const active = activeBatches.get(key);
  if (active !== undefined) {
    if (db !== active.view) throw new Error("Database write batch is already active");
    return runNestedBatch(active, run);
  }

  const view = createDatabaseOperationView(db, 0, 0, 0);
  const state: WriteBatchState = {
    bytes: 0,
    checking: false,
    entries: [],
    failed: false,
    failure: undefined,
    flushing: false,
    limits: normalizeLimits(options),
    metadataRows: 0,
    parents: new Map(),
    view,
  };
  activeBatches.set(key, state);
  const unregisterBarrier = registerDatabaseTransactionBarrier(view, () => {
    flushState(state);
    state.parents.clear();
    state.metadataRows = 0;
  });

  try {
    return transactDatabaseWithoutBarrier(view, () => {
      const result = run(view);
      rejectPromiseLike(result);
      flushState(state);
      return result;
    });
  } finally {
    unregisterBarrier();
    activeBatches.delete(key);
    closeDatabaseOperationView(view);
  }
}

export function withProviderWriteBatchSync<T>(
  provider: SQLiteWorkspaceProvider,
  run: (batchProvider: SQLiteWorkspaceProvider) => SynchronousResult<T>,
  options: WriteBatchOptions = {},
): T {
  return withWriteBatchSync(
    provider.db,
    (batchDb) => run(createProviderOperationView(provider, batchDb)),
    options,
  );
}

export function flushWriteBatchSync(db: Database): void {
  const state = activeBatches.get(databaseCoreKey(db));
  if (state === undefined || db !== state.view) {
    throw new Error("Database write batch is not active");
  }
  flushState(state);
}

export function flushProviderWriteBatchSync(provider: SQLiteWorkspaceProvider): void {
  flushWriteBatchSync(provider.db);
}

export function flushWriteBatchBeforeRead(db: Database): void {
  const state = activeBatches.get(databaseCoreKey(db));
  if (state === undefined || state.checking || state.flushing) return;
  flushState(state);
}

export function flushWriteBatchBeforeMutation(db: Database): void {
  const state = activeBatches.get(databaseCoreKey(db));
  if (state === undefined || state.flushing) return;
  flushState(state);
  state.parents.clear();
  state.metadataRows = 0;
}

export function stageWriteBatchCreateSync(
  db: Database,
  path: string,
  bytes: Uint8Array,
  options: WriteFileOptions,
  now: () => number,
): boolean {
  const state = activeBatches.get(databaseCoreKey(db));
  if (state === undefined || db !== state.view || state.flushing) return false;
  throwStoredFailure(state);
  if (bytes.byteLength > HARD_MAX_BYTES) return false;

  if (state.entries.length >= HARD_MAX_FILES || state.bytes + bytes.byteLength > HARD_MAX_BYTES) {
    flushState(state);
  }

  const { parts, path: canonical } = canonicalizePath(path);
  if (parts.length === 0) return false;
  const leafName = parts[parts.length - 1];
  const parentParts = parts.slice(0, -1);
  if (!jsonValueFitsPage(parentParts, state.limits.maxMetadataPageBytes)) return false;
  const parentPath = parentParts.length === 0 ? "/" : `/${parentParts.join("/")}`;
  const parent = directoryState(state, parentPath, parentParts);
  if (parent === undefined || parent.names.has(leafName)) return false;

  const ownedBytes = bytes.slice();
  const chunks = chunksOf(ownedBytes);
  const entry: StagedFile = {
    canonicalPath: canonical,
    chunks,
    leafName,
    mode: (options.mode ?? 0o644) & 0o7777,
    mtime: now(),
    manifest: prepareManifest(chunks),
    parentInode: parent.inode,
    size: ownedBytes.byteLength,
  };
  if (!metadataRowsFitPage(entry, state.limits.maxMetadataPageBytes)) return false;
  state.entries.push(entry);
  state.bytes += ownedBytes.byteLength;
  parent.names.add(leafName);

  if (state.entries.length >= state.limits.maxFiles || state.bytes >= state.limits.maxBytes) {
    flushState(state);
  }
  return true;
}

function runNestedBatch<T>(
  state: WriteBatchState,
  run: (batchDb: Database) => SynchronousResult<T>,
): T {
  const checkpoint = createCheckpoint(state);
  try {
    return transactDatabaseWithoutBarrier(state.view, () => {
      const result = run(state.view);
      rejectPromiseLike(result);
      return result;
    });
  } catch (error) {
    restoreCheckpoint(state, checkpoint);
    throw error;
  }
}

function createCheckpoint(state: WriteBatchState): BatchCheckpoint {
  return {
    bytes: state.bytes,
    entries: [...state.entries],
    metadataRows: state.metadataRows,
    parents: cloneParents(state.parents),
  };
}

function restoreCheckpoint(state: WriteBatchState, checkpoint: BatchCheckpoint): void {
  state.bytes = checkpoint.bytes;
  state.entries = checkpoint.entries;
  state.metadataRows = checkpoint.metadataRows;
  state.parents = checkpoint.parents;
  state.failed = false;
  state.failure = undefined;
}

function cloneParents(parents: Map<string, DirectoryState>): Map<string, DirectoryState> {
  const clone = new Map<string, DirectoryState>();
  for (const [path, parent] of parents) {
    clone.set(path, { inode: parent.inode, names: new Set(parent.names) });
  }
  return clone;
}

function rejectPromiseLike(value: unknown): void {
  if (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    throw new Error("Database write batch callback must be synchronous");
  }
}

function normalizeLimits(options: WriteBatchOptions): WriteBatchLimits {
  return {
    maxBlobRowsPerStatement: boundedInteger(
      options.maxBlobRowsPerStatement,
      HARD_MAX_BLOB_ROWS,
      HARD_MAX_BLOB_ROWS,
    ),
    maxBytes: boundedInteger(options.maxBytes, HARD_MAX_BYTES, HARD_MAX_BYTES),
    maxFiles: boundedInteger(options.maxFiles, HARD_MAX_FILES, HARD_MAX_FILES),
    maxMetadataPageBytes: boundedInteger(
      options.maxMetadataPageBytes,
      HARD_MAX_METADATA_PAGE_BYTES,
      HARD_MAX_METADATA_PAGE_BYTES,
    ),
    metadataRowsPerPage: boundedInteger(
      options.metadataRowsPerPage,
      HARD_MAX_METADATA_ROWS,
      HARD_MAX_METADATA_ROWS,
    ),
  };
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function directoryState(
  state: WriteBatchState,
  parentPath: string,
  parentParts: string[],
): DirectoryState | undefined {
  const cached = state.parents.get(parentPath);
  if (cached !== undefined) return cached;

  state.checking = true;
  try {
    const rows = state.view.all<ParentRow>(
      `WITH RECURSIVE
         segs(level, name) AS (
           SELECT key, value FROM json_each(?)
         ),
         walk(level, inode, type) AS (
           SELECT 0, inode, type FROM vfs_nodes WHERE inode = ?
           UNION ALL
           SELECT w.level + 1, n.inode, n.type
             FROM walk w
             JOIN segs s ON s.level = w.level
             JOIN vfs_dirents d ON d.parent_inode = w.inode AND d.name = s.name
             JOIN vfs_nodes n ON n.inode = d.child_inode
            WHERE w.type = 'dir'
         )
       SELECT level, inode, type FROM walk ORDER BY level`,
      JSON.stringify(parentParts),
      ROOT_INODE,
    );
    const parent = rows.at(-1);
    if (
      parent === undefined ||
      parent.level !== parentParts.length ||
      parent.type !== "dir" ||
      rows.some((row) => row.type !== "dir")
    ) {
      return undefined;
    }

    const childCount =
      state.view.scalar<number>(
        "SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?",
        parent.inode,
      ) ?? 0;
    if (
      childCount > MAX_CACHED_DIRECTORY_NAMES ||
      state.metadataRows + childCount + 1 > HARD_MAX_METADATA_ROWS
    ) {
      return undefined;
    }
    const names = state.view.all<NameRow>(
      "SELECT name FROM vfs_dirents WHERE parent_inode = ? ORDER BY name",
      parent.inode,
    );
    const directory = { inode: parent.inode, names: new Set(names.map((row) => row.name)) };
    state.parents.set(parentPath, directory);
    state.metadataRows += names.length + 1;
    return directory;
  } finally {
    state.checking = false;
  }
}

function flushState(state: WriteBatchState): void {
  throwStoredFailure(state);
  if (state.entries.length === 0 || state.flushing) return;
  state.flushing = true;
  const entries = [...state.entries];
  try {
    writeEntries(state.view, entries, state.limits);
    state.entries.splice(0, entries.length);
    state.bytes = 0;
    for (const entry of entries) invalidateResolveExact(state.view, entry.canonicalPath);
  } catch (error) {
    state.failed = true;
    state.failure = error;
    throw error;
  } finally {
    state.flushing = false;
  }
}

function throwStoredFailure(state: WriteBatchState): void {
  if (state.failed) throw state.failure;
}

function writeEntries(db: Database, entries: StagedFile[], limits: WriteBatchLimits): void {
  verifyCreateTargets(db, entries, limits);
  const revision = db.one<RevisionRow>(
    "UPDATE vfs_meta SET v = v + ? WHERE k = 'rev' RETURNING v",
    entries.length,
  );
  if (revision === undefined)
    throw new Error("vfs_meta.rev row missing; was initializeSchema run?");
  const sequence = db.one<SequenceRow>("SELECT seq FROM sqlite_sequence WHERE name = 'vfs_nodes'");
  const firstInode = (sequence?.seq ?? ROOT_INODE) + 1;
  const firstRevision = revision.v - entries.length + 1;

  const blobs = new Map<string, BlobMetadataRow>();
  const payloads = new Map<string, BlobPayloadRow>();
  const manifests = new Map<string, ManifestMetadataRow>();
  const chunks: ChunkMetadataRow[] = [];
  const dirents: DirentMetadataRow[] = [];
  const nodes: NodeMetadataRow[] = [];

  for (let fileIndex = 0; fileIndex < entries.length; fileIndex += 1) {
    const entry = entries[fileIndex];
    const inode = firstInode + fileIndex;
    const manifest = entry.manifest;
    const manifestHash = toHex(manifest.hash);
    nodes.push({
      inode,
      manifestHash,
      mode: entry.mode,
      mtime: entry.mtime,
      rev: firstRevision + fileIndex,
      size: entry.size,
    });
    dirents.push({
      childInode: inode,
      name: entry.leafName,
      parentInode: entry.parentInode,
    });
    manifests.set(manifestHash, {
      encoded: toHex(manifest.encoded),
      hash: manifestHash,
      lastSeen: entry.mtime,
      size: manifest.size,
    });
    for (let chunkIndex = 0; chunkIndex < entry.chunks.length; chunkIndex += 1) {
      const chunk = entry.chunks[chunkIndex];
      const hash = toHex(chunk.hash);
      blobs.set(hash, { hash, lastSeen: entry.mtime, size: chunk.size });
      payloads.set(hash, { bytes: chunk.bytes, hash: chunk.hash });
      chunks.push({ hash, idx: chunkIndex, inode, size: chunk.size });
    }
  }

  writeBlobMetadata(
    db,
    [...blobs.values()],
    limits.metadataRowsPerPage,
    limits.maxMetadataPageBytes,
  );
  writeBlobPayloads(db, [...payloads.values()], limits.maxBlobRowsPerStatement);
  writeManifestMetadata(
    db,
    [...manifests.values()],
    limits.metadataRowsPerPage,
    limits.maxMetadataPageBytes,
  );
  writeNodeMetadata(db, nodes, limits.metadataRowsPerPage, limits.maxMetadataPageBytes);
  writeChunkMetadata(db, chunks, limits.metadataRowsPerPage, limits.maxMetadataPageBytes);
  writeDirentMetadata(db, dirents, limits.metadataRowsPerPage, limits.maxMetadataPageBytes);
}

function metadataRowsFitPage(entry: StagedFile, maxBytes: number): boolean {
  const inode = Number.MAX_SAFE_INTEGER;
  const manifestHash = toHex(entry.manifest.hash);
  const rows: object[] = [
    {
      encoded: toHex(entry.manifest.encoded),
      hash: manifestHash,
      lastSeen: entry.mtime,
      size: entry.manifest.size,
    },
    {
      inode,
      manifestHash,
      mode: entry.mode,
      mtime: entry.mtime,
      rev: Number.MAX_SAFE_INTEGER,
      size: entry.size,
    },
    { childInode: inode, name: entry.leafName, parentInode: entry.parentInode },
  ];
  for (let index = 0; index < entry.chunks.length; index += 1) {
    const chunk = entry.chunks[index];
    const hash = toHex(chunk.hash);
    rows.push({ hash, lastSeen: entry.mtime, size: chunk.size });
    rows.push({ hash, idx: index, inode, size: chunk.size });
  }
  return rows.every((row) => jsonBytes(row) + 2 <= maxBytes);
}

function verifyCreateTargets(db: Database, entries: StagedFile[], limits: WriteBatchLimits): void {
  const targets = entries.map((entry) => ({
    name: entry.leafName,
    parentInode: entry.parentInode,
  }));
  let missingParents = 0;
  let collisions = 0;
  forJsonPages(targets, limits.metadataRowsPerPage, limits.maxMetadataPageBytes, (page) => {
    const check = db.one<TargetCheckRow>(
      `WITH targets AS (
           SELECT json_extract(value, '$.parentInode') AS parent_inode,
                  json_extract(value, '$.name') AS name
             FROM json_each(?)
         )
         SELECT COALESCE(SUM(CASE WHEN p.inode IS NULL OR p.type <> 'dir' THEN 1 ELSE 0 END), 0)
                  AS missingParents,
                COALESCE(SUM(CASE WHEN d.child_inode IS NOT NULL THEN 1 ELSE 0 END), 0)
                  AS collisions
           FROM targets t
           LEFT JOIN vfs_nodes p ON p.inode = t.parent_inode
           LEFT JOIN vfs_dirents d ON d.parent_inode = t.parent_inode AND d.name = t.name`,
      page,
    );
    if (check === undefined) throw new Error("write batch target check returned no row");
    missingParents += check.missingParents;
    collisions += check.collisions;
  });
  const firstPath = entries[0]?.canonicalPath;
  if (missingParents > 0) {
    throw createWorkspaceError("ENOENT", "write batch parent directory is missing", firstPath);
  }
  if (collisions > 0) {
    throw createWorkspaceError("EEXIST", "write batch target already exists", firstPath);
  }
}

function writeBlobMetadata(
  db: Database,
  rows: BlobMetadataRow[],
  pageSize: number,
  pageBytes: number,
): void {
  forJsonPages(rows, pageSize, pageBytes, (page) => {
    db.run(
      `INSERT INTO vfs_blobs (hash, size, last_seen)
       SELECT unhex(json_extract(value, '$.hash')),
              json_extract(value, '$.size'),
              json_extract(value, '$.lastSeen')
         FROM json_each(?)
        WHERE true
       ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen`,
      page,
    );
  });
}

function writeBlobPayloads(db: Database, rows: BlobPayloadRow[], pageSize: number): void {
  forPages(rows, pageSize, (page) => {
    const bindings: unknown[] = [];
    const values: string[] = [];
    for (const row of page) {
      values.push("(?, ?)");
      bindings.push(row.hash, row.bytes);
    }
    db.run(
      `INSERT INTO vfs_blob_bytes (hash, bytes) VALUES ${values.join(", ")}
       ON CONFLICT(hash) DO NOTHING`,
      ...bindings,
    );
  });
}

function writeManifestMetadata(
  db: Database,
  rows: ManifestMetadataRow[],
  pageSize: number,
  pageBytes: number,
): void {
  forJsonPages(rows, pageSize, pageBytes, (page) => {
    db.run(
      `INSERT INTO vfs_manifests (hash, size, encoded, last_seen)
       SELECT unhex(json_extract(value, '$.hash')),
              json_extract(value, '$.size'),
              unhex(json_extract(value, '$.encoded')),
              json_extract(value, '$.lastSeen')
         FROM json_each(?)
        WHERE true
       ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen`,
      page,
    );
  });
}

function writeNodeMetadata(
  db: Database,
  rows: NodeMetadataRow[],
  pageSize: number,
  pageBytes: number,
): void {
  forJsonPages(rows, pageSize, pageBytes, (page) => {
    db.run(
      `INSERT INTO vfs_nodes
         (inode, type, mode, mtime, rev, size, manifest_hash)
       SELECT json_extract(value, '$.inode'),
              'file',
              json_extract(value, '$.mode'),
              json_extract(value, '$.mtime'),
              json_extract(value, '$.rev'),
              json_extract(value, '$.size'),
              unhex(json_extract(value, '$.manifestHash'))
         FROM json_each(?)`,
      page,
    );
  });
}

function writeChunkMetadata(
  db: Database,
  rows: ChunkMetadataRow[],
  pageSize: number,
  pageBytes: number,
): void {
  forJsonPages(rows, pageSize, pageBytes, (page) => {
    db.run(
      `INSERT INTO vfs_chunks (inode, idx, hash, size)
       SELECT json_extract(value, '$.inode'),
              json_extract(value, '$.idx'),
              unhex(json_extract(value, '$.hash')),
              json_extract(value, '$.size')
         FROM json_each(?)`,
      page,
    );
  });
}

function writeDirentMetadata(
  db: Database,
  rows: DirentMetadataRow[],
  pageSize: number,
  pageBytes: number,
): void {
  forJsonPages(rows, pageSize, pageBytes, (page) => {
    db.run(
      `INSERT INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT json_extract(value, '$.parentInode'),
              json_extract(value, '$.name'),
              json_extract(value, '$.childInode')
         FROM json_each(?)`,
      page,
    );
  });
}

function forPages<Row>(rows: Row[], pageSize: number, run: (page: Row[]) => void): void {
  for (let offset = 0; offset < rows.length; offset += pageSize) {
    run(rows.slice(offset, offset + pageSize));
  }
}

const jsonEncoder = new TextEncoder();

function jsonBytes(value: object): number {
  return jsonEncoder.encode(JSON.stringify(value)).byteLength;
}

function jsonValueFitsPage(value: object, maxBytes: number): boolean {
  return jsonBytes(value) <= maxBytes;
}

function forJsonPages<Row>(
  rows: Row[],
  maxRows: number,
  maxBytes: number,
  run: (page: string) => void,
): void {
  let encodedRows: string[] = [];
  let encodedBytes = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const rowBytes = jsonEncoder.encode(encoded).byteLength;
    const separatorBytes = encodedRows.length === 0 ? 0 : 1;
    if (
      encodedRows.length > 0 &&
      (encodedRows.length >= maxRows || encodedBytes + separatorBytes + rowBytes > maxBytes)
    ) {
      run(`[${encodedRows.join(",")}]`);
      encodedRows = [];
      encodedBytes = 2;
    }
    encodedRows.push(encoded);
    encodedBytes += (encodedRows.length === 1 ? 0 : 1) + rowBytes;
  }
  if (encodedRows.length > 0) run(`[${encodedRows.join(",")}]`);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
