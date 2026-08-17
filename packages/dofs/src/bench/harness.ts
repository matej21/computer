import { env, type ProvidedEnv, runInDurableObject } from "cloudflare:test";
import type { TestBindings } from "../../tests/worker.js";
import { SQLiteWorkspaceProvider } from "../provider.js";
import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import type { DurableObjectStorageLike } from "../types.js";
import { CountingStorage, type StatementCounts } from "./counting-storage.js";

const NOW = (): number => 1000;

declare module "cloudflare:test" {
  interface ProvidedEnv extends TestBindings {}
}

declare global {
  namespace Cloudflare {
    interface Env extends ProvidedEnv {}
  }
}

export interface EstimatedMemory {
  // Scenario estimate only; workerd does not expose per-operation heap usage.
  estimatedRetainedBytes?: number;
  estimatedTransientBytes?: number;
  basis: string;
}

export interface BenchmarkMetrics extends StatementCounts {
  estimatedMemory?: EstimatedMemory;
}

export interface ReadBenchmarkResult extends BenchmarkMetrics {
  name: string;
  depth: number;
  nsPerOp: number;
}

export interface MutationBenchmarkResult extends BenchmarkMetrics {
  name: string;
  items: number;
  totalMs: number;
  nsPerItem: number;
}

export interface RealSqlStorageDetails {
  readonly databaseSize?: number;
}

export type BenchmarkBuild = (db: Database, provider: SQLiteWorkspaceProvider) => void;
export type BenchmarkOperation = (db: Database, provider: SQLiteWorkspaceProvider) => void;
export type MemoryEstimator = () => EstimatedMemory;

function freshStub(): DurableObjectStub {
  const ns = env.TestStorage;
  return ns.get(ns.newUniqueId());
}

function storageAdapter(storage: DurableObjectStorage): DurableObjectStorageLike {
  return {
    sql: {
      exec: <Row extends object>(query: string, ...bindings: unknown[]) => {
        const cursor = storage.sql.exec<Row & Record<string, SqlStorageValue>>(query, ...bindings);
        return {
          toArray: (): Row[] => cursor.toArray(),
          get rowsRead(): number {
            return cursor.rowsRead;
          },
          get rowsWritten(): number {
            return cursor.rowsWritten;
          },
        };
      },
    },
    transactionSync: storage.transactionSync.bind(storage),
    transaction: (closure) => storage.transaction(async () => await closure()),
  };
}

export async function withRealDb<T>(
  fn: (db: Database, provider: SQLiteWorkspaceProvider, storage: RealSqlStorageDetails) => T,
): Promise<T> {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
    const storage = storageAdapter(state.storage);
    const db = new Database(storage);
    initializeSchema(db, NOW);
    const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
    return fn(db, provider, state.storage.sql);
  });
}

export async function withCountingDb<T>(
  fn: (db: Database, provider: SQLiteWorkspaceProvider, counting: CountingStorage) => T,
): Promise<T> {
  const stub = freshStub();
  return runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
    const counting = new CountingStorage(storageAdapter(state.storage));
    const db = new Database(counting);
    initializeSchema(db, NOW);
    counting.reset();
    const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
    return fn(db, provider, counting);
  });
}

export async function benchRead(options: {
  name: string;
  depth: number;
  build: BenchmarkBuild;
  op: BenchmarkOperation;
  iterations: number;
  estimateMemory?: MemoryEstimator;
}): Promise<ReadBenchmarkResult> {
  const { name, depth, build, op, iterations, estimateMemory } = options;
  const warmup = Math.min(200, iterations);
  const nsPerOp = await withRealDb((db, provider) => {
    build(db, provider);
    for (let i = 0; i < warmup; i++) {
      op(db, provider);
    }
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      op(db, provider);
    }
    const t1 = performance.now();
    return ((t1 - t0) * 1e6) / iterations;
  });
  const counts = await withCountingDb((db, provider, counting) => {
    build(db, provider);
    counting.reset();
    op(db, provider);
    return counting.snapshot();
  });
  return {
    name,
    depth,
    nsPerOp,
    ...counts,
    estimatedMemory: estimateMemory?.(),
  };
}

export async function benchMutation(options: {
  name: string;
  build: BenchmarkBuild;
  batch: (db: Database, provider: SQLiteWorkspaceProvider) => number;
  estimateMemory?: MemoryEstimator;
}): Promise<MutationBenchmarkResult> {
  const { name, build, batch, estimateMemory } = options;
  const timing = await withRealDb((db, provider) => {
    build(db, provider);
    const t0 = performance.now();
    const items = batch(db, provider);
    const t1 = performance.now();
    return { totalMs: t1 - t0, items };
  });
  const counts = await withCountingDb((db, provider, counting) => {
    build(db, provider);
    counting.reset();
    batch(db, provider);
    return counting.snapshot();
  });
  const items = Math.max(1, timing.items);
  return {
    name,
    items: timing.items,
    totalMs: timing.totalMs,
    nsPerItem: (timing.totalMs * 1e6) / items,
    ...counts,
    estimatedMemory: estimateMemory?.(),
  };
}
