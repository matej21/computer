import { expect, it } from "vitest";

import { resolveInode } from "../fs/resolve.js";
import { clearResolveCache } from "../fs/resolveCache.js";
import type { Database } from "../storage.js";
import { buildChainFile } from "./fixtures.js";
import { type ReadBenchmarkResult, withCountingDb, withRealDb } from "./harness.js";
import { benchmarkReport, readTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

const DEPTH = 20;
const REPEATS = 100;
const TIMING_GROUPS = 200;

function resolveRepeatedly(db: Database, path: string): void {
  for (let index = 0; index < REPEATS; index++) {
    const node = resolveInode(db, path);
    if (node?.type !== "file") {
      throw new Error(`benchmark fixture did not resolve: ${path}`);
    }
  }
}

async function measureBaseline(): Promise<ReadBenchmarkResult> {
  const nsPerOp = await withRealDb((db, provider) => {
    const path = buildChainFile(provider, DEPTH);
    clearResolveCache(db);
    const started = performance.now();
    for (let group = 0; group < TIMING_GROUPS; group++) {
      resolveRepeatedly(db, path);
    }
    return ((performance.now() - started) * 1e6) / (TIMING_GROUPS * REPEATS);
  });
  const counts = await withCountingDb((db, provider, counting) => {
    const path = buildChainFile(provider, DEPTH);
    clearResolveCache(db);
    counting.reset();
    resolveRepeatedly(db, path);
    return counting.snapshot();
  });
  return {
    name: "root-view repeated resolve",
    depth: DEPTH,
    nsPerOp,
    ...counts,
  };
}

it("benchmarks an operation-bound resolution cache against real DO SqlStorage", async () => {
  const baseline = await measureBaseline();
  benchmarkReport({
    scenario: "operation-context-baseline",
    title: "dofs operation-context baseline",
    note: "The signature is deterministic. Wall time is observational. The operation target is one cold CTE for 100 repeated resolutions.",
    sections: [readTable([baseline])],
    results: { baseline, target: { statements: 1, reads: 1, rowsRead: 503 } },
  });
  expectMetricSignature("root-view repeated resolve", baseline, {
    statements: 100,
    reads: 100,
    writes: 0,
    other: 0,
    rowsRead: 602,
    rowsWritten: 0,
  });

  const { withDatabaseOperation } = await import("../operation.js");
  const operationNsPerOp = await withRealDb((db, provider) => {
    const path = buildChainFile(provider, DEPTH);
    clearResolveCache(db);
    const started = performance.now();
    for (let group = 0; group < TIMING_GROUPS; group++) {
      withDatabaseOperation(db, (operationDb: Database) => {
        resolveRepeatedly(operationDb, path);
      });
    }
    return ((performance.now() - started) * 1e6) / (TIMING_GROUPS * REPEATS);
  });
  const operation: ReadBenchmarkResult = await withCountingDb((db, provider, counting) => {
    const path = buildChainFile(provider, DEPTH);
    clearResolveCache(db);
    counting.reset();
    withDatabaseOperation(db, (operationDb: Database) => {
      resolveRepeatedly(operationDb, path);
    });
    return {
      name: "operation-view repeated resolve",
      depth: DEPTH,
      nsPerOp: operationNsPerOp,
      ...counting.snapshot(),
    };
  });
  expectMetricSignature("operation-view repeated resolve", operation, {
    statements: 1,
    reads: 1,
    writes: 0,
    other: 0,
    rowsRead: 503,
    rowsWritten: 0,
  });

  const bounded = await withCountingDb((db, provider, counting) => {
    for (const name of ["a", "b", "c", "d", "e"]) {
      provider.writeFileSync(`/${name}`, name);
    }
    clearResolveCache(db);
    counting.reset();
    withDatabaseOperation(
      db,
      (operationDb: Database) => {
        for (const name of ["a", "b", "c", "d", "e"]) {
          resolveInode(operationDb, `/${name}`);
        }
        resolveInode(operationDb, "/e");
        resolveInode(operationDb, "/a");
      },
      { maxReadCacheEntries: 8 },
    );
    return counting.snapshot();
  });
  expectMetricSignature("bounded operation cache", bounded, {
    statements: 6,
    reads: 6,
    writes: 0,
    other: 0,
    rowsRead: 54,
    rowsWritten: 0,
  });
  expect(operation.statements).toBeLessThan(baseline.statements);
  benchmarkReport({
    scenario: "operation-context",
    title: "dofs operation-context benchmark",
    note: "Statement and row signatures are deterministic. Wall time is observational. Cache capacity counts path and node entries together.",
    sections: [readTable([baseline, operation])],
    results: { baseline, operation, bounded },
  });
});
