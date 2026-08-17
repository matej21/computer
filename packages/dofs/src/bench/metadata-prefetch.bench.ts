import { expect, it } from "vitest";

import { readdir } from "../fs/readdir.js";
import { resolveInode } from "../fs/resolve.js";
import type { DatabaseOperationOptions } from "../operation.js";
import { withDatabaseOperation } from "../operation.js";
import type { SQLiteWorkspaceProvider } from "../provider.js";
import type { Database } from "../storage.js";
import { type ReadBenchmarkResult, withCountingDb, withRealDb } from "./harness.js";
import { benchmarkReport, readTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

const WIDTH = 200;
const REPEATS = 100;
const TIMING_GROUPS = 100;

const noPrefetchOptions = {
  maxReadCacheEntries: 8192,
  maxMetadataPrefetchBytes: 0,
} satisfies DatabaseOperationOptions & { maxMetadataPrefetchBytes: number };

function buildWideDirectory(provider: SQLiteWorkspaceProvider): void {
  provider.mkdirSync("/wide");
  for (let index = 0; index < WIDTH; index += 1) {
    provider.writeFileSync(`/wide/f${index.toString().padStart(3, "0")}`, "x");
  }
}

function repeatListingAndMiss(db: Database): void {
  for (let index = 0; index < REPEATS; index += 1) {
    const entries = readdir(db, "/wide");
    if (entries.length !== WIDTH) throw new Error("benchmark directory width changed");
    if (resolveInode(db, "/wide/missing") !== null) {
      throw new Error("benchmark missing path resolved");
    }
  }
}

async function measure(options?: DatabaseOperationOptions): Promise<ReadBenchmarkResult> {
  const nsPerOp = await withRealDb((db, provider) => {
    buildWideDirectory(provider);
    const started = performance.now();
    for (let group = 0; group < TIMING_GROUPS; group += 1) {
      withDatabaseOperation(
        db,
        (operationDb: Database) => repeatListingAndMiss(operationDb),
        options,
      );
    }
    return ((performance.now() - started) * 1e6) / (TIMING_GROUPS * REPEATS);
  });
  const counts = await withCountingDb((db, provider, counting) => {
    buildWideDirectory(provider);
    counting.reset();
    withDatabaseOperation(
      db,
      (operationDb: Database) => repeatListingAndMiss(operationDb),
      options,
    );
    return counting.snapshot();
  });
  return {
    name: options === undefined ? "metadata-prefetch" : "C1 listing cache",
    depth: 1,
    nsPerOp,
    ...counts,
  };
}

it("benchmarks operation-local metadata prefetch against real DO SqlStorage", async () => {
  const baseline = await measure(noPrefetchOptions);
  const operation = await measure();
  benchmarkReport({
    scenario: "metadata-prefetch",
    title: "dofs operation-local metadata prefetch benchmark",
    note: "Each operation repeats one complete 200-entry listing and one missing-child resolve 100 times. Statement signatures are deterministic; wall time is observational.",
    sections: [readTable([baseline, operation])],
    results: {
      baseline,
      operation,
      target: { statements: 2, reads: 2, rowsRead: 1010 },
    },
  });

  expectMetricSignature("C1 listing cache", baseline, {
    statements: 102,
    reads: 102,
    writes: 0,
    other: 0,
    rowsRead: 41_421,
    rowsWritten: 0,
  });
  expectMetricSignature("metadata prefetch target", operation, {
    statements: 2,
    reads: 2,
    writes: 0,
    other: 0,
    rowsRead: 1010,
    rowsWritten: 0,
  });
  expect(operation.statements).toBeLessThan(baseline.statements);
});
