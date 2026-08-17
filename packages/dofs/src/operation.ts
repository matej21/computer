import { createProviderOperationView, type SQLiteWorkspaceProvider } from "./provider.js";
import {
  closeDatabaseOperationView,
  createDatabaseOperationView,
  type Database,
  isDatabaseOperationView,
  registerAfterOutermostCommit,
  registerAfterOutermostRollback,
} from "./storage.js";

export interface DatabaseOperationOptions {
  maxReadCacheEntries?: number;
}

const DEFAULT_MAX_READ_CACHE_ENTRIES = 8192;

export function withDatabaseOperation<T>(
  db: Database,
  run: (operationDb: Database) => PromiseLike<T>,
  options?: DatabaseOperationOptions,
): Promise<T>;
export function withDatabaseOperation<T>(
  db: Database,
  run: (operationDb: Database) => T,
  options?: DatabaseOperationOptions,
): T;
export function withDatabaseOperation<T>(
  db: Database,
  run: (operationDb: Database) => T | PromiseLike<T>,
  options: DatabaseOperationOptions = {},
): T | Promise<T> {
  return runDatabaseOperation(db, run, options);
}

function runDatabaseOperation<T>(
  db: Database,
  run: (operationDb: Database) => T | PromiseLike<T>,
  options: DatabaseOperationOptions,
): T | Promise<T> {
  if (isDatabaseOperationView(db)) return assimilateResult(run(db));

  const requested = options.maxReadCacheEntries ?? DEFAULT_MAX_READ_CACHE_ENTRIES;
  const maxReadCacheEntries = Number.isFinite(requested)
    ? Math.max(0, Math.floor(requested))
    : DEFAULT_MAX_READ_CACHE_ENTRIES;
  const operationDb = createDatabaseOperationView(db, maxReadCacheEntries);
  try {
    const result = run(operationDb);
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(() => closeDatabaseOperationView(operationDb));
    }
    closeDatabaseOperationView(operationDb);
    return result;
  } catch (error) {
    closeDatabaseOperationView(operationDb);
    throw error;
  }
}

export function withProviderOperation<T>(
  provider: SQLiteWorkspaceProvider,
  run: (operationProvider: SQLiteWorkspaceProvider) => PromiseLike<T>,
  options?: DatabaseOperationOptions,
): Promise<T>;
export function withProviderOperation<T>(
  provider: SQLiteWorkspaceProvider,
  run: (operationProvider: SQLiteWorkspaceProvider) => T,
  options?: DatabaseOperationOptions,
): T;
export function withProviderOperation<T>(
  provider: SQLiteWorkspaceProvider,
  run: (operationProvider: SQLiteWorkspaceProvider) => T | PromiseLike<T>,
  options: DatabaseOperationOptions = {},
): T | Promise<T> {
  if (isDatabaseOperationView(provider.db)) return assimilateResult(run(provider));
  return runDatabaseOperation(
    provider.db,
    (operationDb) => run(createProviderOperationView(provider, operationDb)),
    options,
  );
}

function assimilateResult<T>(result: T | PromiseLike<T>): T | Promise<T> {
  return isPromiseLike(result) ? Promise.resolve(result) : result;
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export function afterOutermostCommit(db: Database, callback: () => void): void {
  registerAfterOutermostCommit(db, callback);
}

export function afterOutermostRollback(db: Database, callback: () => void): void {
  registerAfterOutermostRollback(db, callback);
}
