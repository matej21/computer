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
  generation: number;
  closed: boolean;
}

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
      generation: this.coherenceGeneration,
      closed: false,
    };
  }
}

// Views over one storage share transaction and coherence ownership.
const cores = new WeakMap<DurableObjectStorageLike, DatabaseCore>();
const databaseCores = new WeakMap<Database, DatabaseCore>();
const operations = new WeakMap<Database, OperationState>();

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
