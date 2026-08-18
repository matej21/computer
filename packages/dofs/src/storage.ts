import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "./types.js";

type TransactionCallback = () => void;

interface OperationState {
  readonly id: number;
  readonly maxReadCacheEntries: number;
  readonly readCache: Map<string, unknown>;
  readonly maxMetadataPrefetchBytes: number;
  readonly maxMetadataPrefetchDirectoryEntries: number;
  readonly metadataDirectories: Map<string, DatabaseOperationDirectory>;
  readonly metadataReservations: Map<number, number>;
  metadataPrefetchBytes: number;
  metadataReservationBytes: number;
  nextMetadataReservationId: number;
  metadataListedDirectories: number;
  readonly metadataPrefetchThreshold: number;
  metadataPrefetchRoot: string | undefined;
  metadataSubtreePrefetched: boolean;
  readonly metadataDirectoryProbes: Map<number, number>;
  readonly readAheadFiles: Map<number, DatabaseOperationReadAheadFile>;
  readonly readAheadProbes: Map<string, Set<number>>;
  readonly readAheadAttemptedDirectories: Set<string>;
  readonly readAheadReadInodes: Set<number>;
  readonly maxReadAheadBytes: number;
  readonly maxReadAheadEntries: number;
  readAheadProbeEntries: number;
  readAheadFetchedBytes: number;
  readAheadFetchedEntries: number;
  generation: number;
  closed: boolean;
}

export interface DatabaseOperationReadAheadBlob {
  hash: Uint8Array;
  offset: number;
  length: number;
}

export interface DatabaseOperationReadAheadFile {
  bytes: Uint8Array;
  blobs: readonly DatabaseOperationReadAheadBlob[];
}

export interface DatabaseOperationReadAheadClaim {
  excludedInodes: readonly number[];
  remainingBytes: number;
  remainingEntries: number;
}

const READ_AHEAD_TRIGGER_READS = 4;
const READ_AHEAD_MAX_HISTORY_ENTRIES = 65_536;

export interface DatabaseOperationDirectoryEntry {
  inode: number;
  name: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  linkTarget?: string;
}

export interface DatabaseOperationDirectory {
  parentInode: number;
  parentPath: string;
  entries: readonly DatabaseOperationDirectoryEntry[];
  entriesByName: ReadonlyMap<string, DatabaseOperationDirectoryEntry>;
  retainedBytes: number;
}

export interface DatabaseOperationDirectoryReservation {
  id: number;
}

class DatabaseCore {
  readonly storage: DurableObjectStorageLike;
  readonly sql: SQLStorageLike;
  transactionDepth = 0;
  coherenceGeneration = 0;
  commitCallbacks: TransactionCallback[] = [];
  rollbackCallbacks: TransactionCallback[] = [];
  nextOperationId = 1;
  persistentDatabase: Database | undefined;

  constructor(storage: DurableObjectStorageLike) {
    this.storage = storage;
    this.sql = {
      exec: <Row extends object = Record<string, unknown>>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> => {
        const cursor = storage.sql.exec<Row>(query, ...bindings);
        if (statementWrites(query)) this.coherenceGeneration += 1;
        return cursor;
      },
    };
  }

  createOperation(
    maxReadCacheEntries: number,
    maxMetadataPrefetchBytes: number,
    maxMetadataPrefetchDirectoryEntries: number,
    metadataPrefetchThreshold: number,
    maxReadAheadBytes: number,
    maxReadAheadEntries: number,
  ): OperationState {
    return {
      id: this.nextOperationId++,
      maxReadCacheEntries,
      readCache: new Map(),
      maxMetadataPrefetchBytes,
      maxMetadataPrefetchDirectoryEntries,
      metadataDirectories: new Map(),
      metadataReservations: new Map(),
      metadataPrefetchBytes: 0,
      metadataReservationBytes: 0,
      nextMetadataReservationId: 1,
      metadataListedDirectories: 0,
      metadataPrefetchThreshold,
      metadataPrefetchRoot: undefined,
      metadataSubtreePrefetched: false,
      metadataDirectoryProbes: new Map(),
      readAheadFiles: new Map(),
      readAheadProbes: new Map(),
      readAheadAttemptedDirectories: new Set(),
      readAheadReadInodes: new Set(),
      maxReadAheadBytes,
      maxReadAheadEntries,
      readAheadProbeEntries: 0,
      readAheadFetchedBytes: 0,
      readAheadFetchedEntries: 0,
      generation: this.coherenceGeneration,
      closed: false,
    };
  }
}

// Views over one storage share transaction and coherence ownership.
const cores = new WeakMap<DurableObjectStorageLike, DatabaseCore>();
const databaseCores = new WeakMap<Database, DatabaseCore>();
const operations = new WeakMap<Database, OperationState>();
const transactionBarriers = new WeakMap<DatabaseCore, () => void>();

function coreForStorage(storage: DurableObjectStorageLike): DatabaseCore {
  let core = cores.get(storage);
  if (core === undefined) {
    core = new DatabaseCore(storage);
    cores.set(storage, core);
  }
  return core;
}

function coreForDatabase(db: Database): DatabaseCore {
  const core = databaseCores.get(db);
  if (core === undefined) throw new Error("Database core is unavailable");
  return core;
}

function assertOpen(db: Database): void {
  if (operations.get(db)?.closed === true) {
    throw new Error("Database operation is closed");
  }
}

function runCallbacks(callbacks: TransactionCallback[]): unknown[] {
  const errors: unknown[] = [];
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function throwCallbackErrors(errors: unknown[]): void {
  if (errors.length === 0) return;
  if (errors.length === 1) throw errors[0];
  throw new AggregateError(errors, "Database commit callbacks failed");
}

export class Database {
  readonly sql: SQLStorageLike;
  readonly transactionSync: <T>(closure: () => T) => T;

  constructor(storage: DurableObjectStorageLike) {
    const core = coreForStorage(storage);
    databaseCores.set(this, core);
    core.persistentDatabase ??= this;
    this.sql = {
      exec: <Row extends object = Record<string, unknown>>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> => {
        assertOpen(this);
        return core.sql.exec<Row>(query, ...bindings);
      },
    };
    this.transactionSync = <T>(closure: () => T): T => {
      assertOpen(this);
      transactionBarriers.get(core)?.();
      return transact(core, closure);
    };
  }

  get inTransaction(): boolean {
    assertOpen(this);
    return coreForDatabase(this).transactionDepth > 0;
  }

  run(query: string, ...bindings: unknown[]): void {
    this.sql.exec(query, ...bindings);
  }

  all<Row extends object>(query: string, ...bindings: unknown[]): Row[] {
    const rows = this.sql.exec<Row>(query, ...bindings).toArray();
    return rows.map((row) => normalizeRow(row as Record<string, unknown>)) as Row[];
  }

  one<Row extends object>(query: string, ...bindings: unknown[]): Row | undefined {
    return this.all<Row>(query, ...bindings)[0];
  }

  scalar<T>(query: string, ...bindings: unknown[]): T | undefined {
    const row = this.one<Record<string, T>>(query, ...bindings);
    if (row === undefined) return undefined;
    const [value] = Object.values(row);
    return value;
  }
}

function transact<T>(core: DatabaseCore, closure: () => T): T {
  if (core.transactionDepth > 0) return transactNested(core, closure);

  core.transactionDepth = 1;
  core.commitCallbacks = [];
  core.rollbackCallbacks = [];
  let result: T;
  try {
    if (core.storage.transactionSync !== undefined) {
      result = core.storage.transactionSync(closure);
    } else if (core.storage.transaction !== undefined) {
      const transactionResult = core.storage.transaction(closure);
      if (
        transactionResult !== undefined &&
        transactionResult !== null &&
        typeof transactionResult === "object" &&
        "then" in transactionResult
      ) {
        throw new Error("Durable Object storage adapter requires synchronous transactions");
      }
      result = transactionResult;
    } else {
      result = closure();
    }
  } catch (error) {
    core.transactionDepth = 0;
    const callbacks = core.rollbackCallbacks;
    core.commitCallbacks = [];
    core.rollbackCallbacks = [];
    runCallbacks(callbacks);
    throw error;
  }

  core.transactionDepth = 0;
  const callbacks = core.commitCallbacks;
  core.commitCallbacks = [];
  core.rollbackCallbacks = [];
  throwCallbackErrors(runCallbacks(callbacks));
  return result;
}

function transactNested<T>(core: DatabaseCore, closure: () => T): T {
  const savepoint = `_t${core.transactionDepth}`;
  const commitLength = core.commitCallbacks.length;
  const rollbackLength = core.rollbackCallbacks.length;
  core.sql.exec(`SAVEPOINT ${savepoint}`);
  core.transactionDepth += 1;
  try {
    const result = closure();
    core.sql.exec(`RELEASE ${savepoint}`);
    return result;
  } catch (error) {
    core.commitCallbacks.length = commitLength;
    core.rollbackCallbacks.length = rollbackLength;
    try {
      core.sql.exec(`ROLLBACK TO ${savepoint}`);
    } catch {
      // Preserve the original nested failure.
    }
    try {
      core.sql.exec(`RELEASE ${savepoint}`);
    } catch {
      // Preserve the original nested failure.
    }
    throw error;
  } finally {
    core.transactionDepth -= 1;
  }
}

export function createDatabaseOperationView(
  db: Database,
  maxReadCacheEntries: number,
  maxMetadataPrefetchBytes: number,
  maxMetadataPrefetchDirectoryEntries: number,
  metadataPrefetchThreshold: number,
  maxReadAheadBytes: number,
  maxReadAheadEntries: number,
): Database {
  assertOpen(db);
  const core = coreForDatabase(db);
  const view = new Database(core.storage);
  operations.set(
    view,
    core.createOperation(
      maxReadCacheEntries,
      maxMetadataPrefetchBytes,
      maxMetadataPrefetchDirectoryEntries,
      metadataPrefetchThreshold,
      maxReadAheadBytes,
      maxReadAheadEntries,
    ),
  );
  return view;
}

export function isDatabaseOperationView(db: Database): boolean {
  assertOpen(db);
  return operations.has(db);
}

export function closeDatabaseOperationView(db: Database): void {
  const operation = operations.get(db);
  if (operation === undefined || operation.closed) return;
  operation.closed = true;
  clearOperationCaches(operation);
}

export function transactDatabaseWithoutBarrier<T>(db: Database, closure: () => T): T {
  assertOpen(db);
  return transact(coreForDatabase(db), closure);
}

export function registerDatabaseTransactionBarrier(db: Database, barrier: () => void): () => void {
  assertOpen(db);
  const core = coreForDatabase(db);
  transactionBarriers.set(core, barrier);
  return () => {
    if (transactionBarriers.get(core) === barrier) transactionBarriers.delete(core);
  };
}

export function databaseCoherenceGeneration(db: Database): number {
  assertOpen(db);
  return coreForDatabase(db).coherenceGeneration;
}

export function databaseCoreKey(db: Database): object {
  assertOpen(db);
  return coreForDatabase(db);
}

export function assertDatabaseOpen(db: Database): void {
  assertOpen(db);
}

// Deferred cleanup may resolve the persistent view after an operation closes.
export function persistentDatabaseView(db: Database): Database {
  const persistent = coreForDatabase(db).persistentDatabase;
  if (persistent === undefined) throw new Error("Persistent database view is unavailable");
  return persistent;
}

export function lookupDatabaseOperationRead(db: Database, key: string): unknown {
  const operation = readableOperation(db);
  if (operation === undefined) return undefined;
  const value = operation.readCache.get(key);
  if (value === undefined) return undefined;
  operation.readCache.delete(key);
  operation.readCache.set(key, value);
  return value;
}

export function storeDatabaseOperationRead(db: Database, key: string, value: unknown): void {
  const operation = readableOperation(db);
  if (operation === undefined || operation.maxReadCacheEntries === 0) return;
  operation.readCache.delete(key);
  operation.readCache.set(key, value);
  while (operation.readCache.size > operation.maxReadCacheEntries) {
    const oldest = operation.readCache.keys().next();
    if (oldest.done) break;
    operation.readCache.delete(oldest.value);
  }
}

export function clearDatabaseOperationReadCache(db: Database): void {
  assertOpen(db);
  const operation = operations.get(db);
  if (operation === undefined) return;
  clearOperationCaches(operation);
  operation.generation = coreForDatabase(db).coherenceGeneration;
}

export function acceptDatabaseOperationFileWrites(db: Database, paths: readonly string[]): boolean {
  assertOpen(db);
  const operation = operations.get(db);
  if (operation === undefined) return false;
  operation.generation = coreForDatabase(db).coherenceGeneration;
  operation.readCache.clear();
  operation.metadataDirectoryProbes.clear();
  operation.metadataReservations.clear();
  operation.metadataReservationBytes = 0;
  operation.readAheadFiles.clear();
  operation.readAheadProbes.clear();
  operation.readAheadAttemptedDirectories.clear();
  operation.readAheadReadInodes.clear();
  operation.readAheadProbeEntries = 0;
  operation.readAheadFetchedBytes = 0;
  operation.readAheadFetchedEntries = 0;

  const changedDirectories = new Set<string>();
  for (const path of paths) {
    changedDirectories.add(path);
    const separator = path.lastIndexOf("/");
    changedDirectories.add(separator <= 0 ? "/" : path.slice(0, separator));
  }
  for (const path of changedDirectories) {
    const directory = operation.metadataDirectories.get(path);
    if (directory === undefined) continue;
    operation.metadataDirectories.delete(path);
    operation.metadataPrefetchBytes -= directory.retainedBytes;
  }
  return true;
}

export function lookupDatabaseOperationDirectory(
  db: Database,
  parentPath: string,
  parentInode?: number,
): DatabaseOperationDirectory | undefined {
  const operation = readableOperation(db);
  if (operation === undefined) return undefined;
  const directory = operation.metadataDirectories.get(parentPath);
  return parentInode === undefined || directory?.parentInode === parentInode
    ? directory
    : undefined;
}

export function storeDatabaseOperationDirectory(
  db: Database,
  directory: DatabaseOperationDirectory,
  reservation: DatabaseOperationDirectoryReservation,
): boolean {
  const operation = readableOperation(db);
  const reservedBytes = operation?.metadataReservations.get(reservation.id);
  if (
    operation === undefined ||
    reservedBytes === undefined ||
    reservedBytes !== directory.retainedBytes ||
    directory.entries.length > operation.maxMetadataPrefetchDirectoryEntries ||
    directory.retainedBytes > operation.maxMetadataPrefetchBytes - operation.metadataPrefetchBytes
  ) {
    return false;
  }
  releaseDirectoryReservation(operation, reservation.id);
  if (operation.metadataDirectories.has(directory.parentPath)) return true;
  operation.metadataDirectories.set(directory.parentPath, directory);
  operation.metadataPrefetchBytes += directory.retainedBytes;
  return true;
}

export function createDatabaseOperationDirectoryReservation(
  db: Database,
  bytes: number,
): DatabaseOperationDirectoryReservation | undefined {
  const operation = readableOperation(db);
  if (operation === undefined || !reserveDirectoryBytes(operation, bytes)) return undefined;
  const id = operation.nextMetadataReservationId++;
  operation.metadataReservations.set(id, bytes);
  return { id };
}

export function reserveDatabaseOperationDirectoryBytes(
  db: Database,
  reservation: DatabaseOperationDirectoryReservation,
  bytes: number,
): boolean {
  const operation = readableOperation(db);
  if (operation === undefined || !operation.metadataReservations.has(reservation.id)) return false;
  if (!reserveDirectoryBytes(operation, bytes)) return false;
  operation.metadataReservations.set(
    reservation.id,
    (operation.metadataReservations.get(reservation.id) ?? 0) + bytes,
  );
  return true;
}

export function releaseDatabaseOperationDirectoryReservation(
  db: Database,
  reservation: DatabaseOperationDirectoryReservation,
): void {
  const operation = operations.get(db);
  if (operation === undefined) return;
  releaseDirectoryReservation(operation, reservation.id);
}

export function databaseOperationDirectoryMaxEntries(db: Database): number | undefined {
  return readableOperation(db)?.maxMetadataPrefetchDirectoryEntries;
}

export function claimDatabaseOperationMetadataSubtreePrefetch(
  db: Database,
  canonicalPath: string,
): string | undefined {
  const operation = readableOperation(db);
  if (operation === undefined || operation.metadataSubtreePrefetched) return undefined;
  operation.metadataListedDirectories += 1;
  operation.metadataPrefetchRoot =
    operation.metadataPrefetchRoot === undefined
      ? canonicalPath
      : commonPathAncestor(operation.metadataPrefetchRoot, canonicalPath);
  if (operation.metadataListedDirectories < operation.metadataPrefetchThreshold) return undefined;
  operation.metadataSubtreePrefetched = true;
  return operation.metadataPrefetchRoot;
}

export function claimDatabaseOperationDirectoryListing(db: Database, parentInode: number): boolean {
  const operation = readableOperation(db);
  if (operation === undefined) return false;
  const probes = (operation.metadataDirectoryProbes.get(parentInode) ?? 0) + 1;
  operation.metadataDirectoryProbes.set(parentInode, probes);
  return probes === 4;
}

export function noteDatabaseOperationReadAheadRead(
  db: Database,
  parentPath: string,
  inode: number,
): void {
  const operation = readableOperation(db);
  if (operation === undefined) return;
  if (operation.readAheadReadInodes.size >= READ_AHEAD_MAX_HISTORY_ENTRIES) return;
  operation.readAheadReadInodes.add(inode);
  if (operation.readAheadReadInodes.size >= READ_AHEAD_MAX_HISTORY_ENTRIES) {
    operation.readAheadProbes.clear();
    operation.readAheadProbeEntries = 0;
    return;
  }
  if (operation.readAheadAttemptedDirectories.has(parentPath)) return;

  let probes = operation.readAheadProbes.get(parentPath);
  if (probes?.has(inode) === true) return;
  if (operation.readAheadProbeEntries >= READ_AHEAD_MAX_HISTORY_ENTRIES) return;
  if (probes === undefined) {
    probes = new Set();
    operation.readAheadProbes.set(parentPath, probes);
  }
  probes.add(inode);
  operation.readAheadProbeEntries += 1;
}

export function claimDatabaseOperationReadAhead(
  db: Database,
  parentPath: string,
): DatabaseOperationReadAheadClaim | undefined {
  const operation = readableOperation(db);
  const probes = operation?.readAheadProbes.get(parentPath);
  if (
    operation === undefined ||
    probes === undefined ||
    probes.size < READ_AHEAD_TRIGGER_READS ||
    operation.readAheadReadInodes.size >= READ_AHEAD_MAX_HISTORY_ENTRIES ||
    operation.readAheadAttemptedDirectories.has(parentPath) ||
    operation.readAheadAttemptedDirectories.size >= READ_AHEAD_MAX_HISTORY_ENTRIES ||
    operation.readAheadFetchedEntries >= operation.maxReadAheadEntries
  ) {
    return undefined;
  }
  operation.readAheadAttemptedDirectories.add(parentPath);
  operation.readAheadProbes.delete(parentPath);
  operation.readAheadProbeEntries -= probes.size;
  return {
    excludedInodes: [...operation.readAheadReadInodes, ...operation.readAheadFiles.keys()],
    remainingBytes: operation.maxReadAheadBytes - operation.readAheadFetchedBytes,
    remainingEntries: operation.maxReadAheadEntries - operation.readAheadFetchedEntries,
  };
}

export function storeDatabaseOperationReadAheadPage(
  db: Database,
  files: ReadonlyMap<number, DatabaseOperationReadAheadFile>,
  fetchedBytes: number,
  fetchedEntries: number,
): boolean {
  const operation = readableOperation(db);
  if (operation === undefined) return false;
  const admitted = [...files].filter(
    ([inode]) => !operation.readAheadReadInodes.has(inode) && !operation.readAheadFiles.has(inode),
  );
  const admittedBytes = admitted.reduce((total, [, file]) => total + file.bytes.byteLength, 0);
  if (
    fetchedBytes < 0 ||
    fetchedEntries < 0 ||
    admittedBytes > operation.maxReadAheadBytes - operation.readAheadFetchedBytes ||
    admitted.length > operation.maxReadAheadEntries - operation.readAheadFetchedEntries
  ) {
    return false;
  }
  operation.readAheadFetchedBytes += admittedBytes;
  operation.readAheadFetchedEntries += admitted.length;
  for (const [inode, file] of admitted) {
    operation.readAheadFiles.set(inode, file);
  }
  return true;
}

export function takeDatabaseOperationReadAheadFile(
  db: Database,
  inode: number,
): DatabaseOperationReadAheadFile | undefined {
  const operation = readableOperation(db);
  const file = operation?.readAheadFiles.get(inode);
  if (operation === undefined || file === undefined) return undefined;
  operation.readAheadFiles.delete(inode);
  operation.readAheadFetchedBytes -= file.bytes.byteLength;
  operation.readAheadFetchedEntries -= 1;
  return file;
}

function reserveDirectoryBytes(operation: OperationState, bytes: number): boolean {
  const available =
    operation.maxMetadataPrefetchBytes -
    operation.metadataPrefetchBytes -
    operation.metadataReservationBytes;
  if (bytes > available) return false;
  operation.metadataReservationBytes += bytes;
  return true;
}

function releaseDirectoryReservation(operation: OperationState, id: number): void {
  const bytes = operation.metadataReservations.get(id);
  if (bytes === undefined) return;
  operation.metadataReservations.delete(id);
  operation.metadataReservationBytes -= bytes;
}

function readableOperation(db: Database): OperationState | undefined {
  assertOpen(db);
  const operation = operations.get(db);
  const core = coreForDatabase(db);
  if (operation === undefined || core.transactionDepth > 0) return undefined;
  if (operation.generation !== core.coherenceGeneration) {
    clearOperationCaches(operation);
    operation.generation = core.coherenceGeneration;
  }
  return operation;
}

function clearOperationCaches(operation: OperationState): void {
  operation.readCache.clear();
  operation.metadataDirectories.clear();
  operation.metadataReservations.clear();
  operation.metadataPrefetchBytes = 0;
  operation.metadataReservationBytes = 0;
  operation.metadataListedDirectories = 0;
  operation.metadataPrefetchRoot = undefined;
  operation.metadataSubtreePrefetched = false;
  operation.metadataDirectoryProbes.clear();
  operation.readAheadFiles.clear();
  operation.readAheadProbes.clear();
  operation.readAheadAttemptedDirectories.clear();
  operation.readAheadReadInodes.clear();
  operation.readAheadProbeEntries = 0;
  operation.readAheadFetchedBytes = 0;
  operation.readAheadFetchedEntries = 0;
}

function commonPathAncestor(left: string, right: string): string {
  const leftParts = left.split("/");
  const rightParts = right.split("/");
  const shared: string[] = [];
  const limit = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < limit && leftParts[index] === rightParts[index]; index += 1) {
    shared.push(leftParts[index]);
  }
  return shared.length <= 1 ? "/" : shared.join("/");
}

export function registerAfterOutermostCommit(db: Database, callback: TransactionCallback): void {
  assertOpen(db);
  const core = coreForDatabase(db);
  if (core.transactionDepth === 0) throw new Error("No active database transaction");
  core.commitCallbacks.push(callback);
}

export function registerAfterOutermostRollback(db: Database, callback: TransactionCallback): void {
  assertOpen(db);
  const core = coreForDatabase(db);
  if (core.transactionDepth === 0) throw new Error("No active database transaction");
  core.rollbackCallbacks.push(callback);
}

function statementWrites(query: string): boolean {
  const first = firstTopLevelKeyword(query);
  return (
    first !== "SELECT" &&
    first !== "SAVEPOINT" &&
    first !== "RELEASE" &&
    first !== "ROLLBACK" &&
    first !== "BEGIN" &&
    first !== "COMMIT" &&
    first !== "END"
  );
}

function firstTopLevelKeyword(query: string): string | undefined {
  let depth = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;
  let lineComment = false;
  let blockComment = false;
  let sawWith = false;

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];
    const next = query[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== undefined) {
      if (char === quote || (quote === "]" && char === "]")) {
        if (next === char && quote !== "]") index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") {
      quote = "]";
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth !== 0 || !/[A-Za-z]/.test(char)) continue;

    let end = index + 1;
    while (end < query.length && /[A-Za-z]/.test(query[end])) end += 1;
    const keyword = query.slice(index, end).toUpperCase();
    index = end - 1;
    if (!sawWith) {
      if (keyword !== "WITH") return keyword;
      sawWith = true;
      continue;
    }
    if (
      keyword === "SELECT" ||
      keyword === "INSERT" ||
      keyword === "UPDATE" ||
      keyword === "DELETE" ||
      keyword === "REPLACE"
    ) {
      return keyword;
    }
  }
  return undefined;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    const value = row[key];
    out[key] = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  }
  return out;
}
