import { expect, it } from "vitest";

import { clearBlobCache } from "../fs/blobCache.js";
import { readFile } from "../fs/readFile.js";
import { clearResolveCache } from "../fs/resolveCache.js";
import { withDatabaseOperation } from "../operation.js";
import type { SQLiteWorkspaceProvider } from "../provider.js";
import type { Database } from "../storage.js";
import type { StatementCounts } from "./counting-storage.js";
import { type ReadBenchmarkResult, withCountingDb, withRealDb } from "./harness.js";
import { benchmarkReport, readTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

const DIRECTORY_WIDTH = 40;
const TIMING_GROUPS = 100;

const baselineFortyReads: StatementCounts = {
  statements: 80,
  reads: 80,
  writes: 0,
  other: 0,
  rowsRead: 440,
  rowsWritten: 0,
};

const targetFortyReads: StatementCounts = {
  statements: 11,
  reads: 11,
  writes: 0,
  other: 0,
  rowsRead: 326,
  rowsWritten: 0,
};

const targetTwoReads: StatementCounts = {
  statements: 4,
  reads: 4,
  writes: 0,
  other: 0,
  rowsRead: 22,
  rowsWritten: 0,
};

function buildDirectory(provider: SQLiteWorkspaceProvider): string[] {
  provider.mkdirSync("/objects/ab", { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < DIRECTORY_WIDTH; index += 1) {
    const path = `/objects/ab/o${index.toString().padStart(3, "0")}`;
    provider.writeFileSync(path, `object ${index}`);
    paths.push(path);
  }
  return paths;
}

function resetReadCaches(db: Database): void {
  clearResolveCache(db);
  clearBlobCache(db);
}

async function readPaths(db: Database, paths: readonly string[]): Promise<void> {
  await withDatabaseOperation(db, async (operationDb: Database) => {
    for (const path of paths) await readFile(operationDb, path, "utf8");
  });
}

async function measure(readCount: number, name: string): Promise<ReadBenchmarkResult> {
  const nsPerOp = await withRealDb(async (db, provider) => {
    const paths = buildDirectory(provider).slice(0, readCount);
    for (let group = 0; group < 10; group += 1) {
      resetReadCaches(db);
      await readPaths(db, paths);
    }
    const started = performance.now();
    for (let group = 0; group < TIMING_GROUPS; group += 1) {
      resetReadCaches(db);
      await readPaths(db, paths);
    }
    return ((performance.now() - started) * 1e6) / TIMING_GROUPS;
  });
  const counts = await withCountingDb(async (db, provider, counting) => {
    const paths = buildDirectory(provider).slice(0, readCount);
    resetReadCaches(db);
    counting.reset();
    await readPaths(db, paths);
    return counting.snapshot();
  });
  return { name, depth: 2, nsPerOp, ...counts };
}

it("benchmarks one-shot small sibling read-ahead against real DO SqlStorage", async () => {
  const forty = await measure(DIRECTORY_WIDTH, "40 complete sibling reads");
  const incidental = await measure(2, "2 incidental sibling reads");

  benchmarkReport({
    scenario: "small-file-read-ahead",
    title: "dofs operation-local small-file read-ahead benchmark",
    note: "One operation reads forty unique small siblings, while the control reads two. Statement signatures are deterministic; wall time is observational.",
    sections: [readTable([forty, incidental])],
    results: {
      forty,
      incidental,
      baselineFortyReads,
      targetFortyReads,
      targetTwoReads,
      triggerReads: 4,
      maxFileBytes: 64 * 1024,
      maxPageBytes: 4 * 1024 * 1024,
      maxPageEntries: 2000,
      maxOperationBytes: 8 * 1024 * 1024,
      maxOperationEntries: 4000,
    },
  });

  expectMetricSignature(forty.name, forty, targetFortyReads);
  expectMetricSignature(incidental.name, incidental, targetTwoReads);
  expect(forty.statements).toBeLessThan(baselineFortyReads.statements);
});
