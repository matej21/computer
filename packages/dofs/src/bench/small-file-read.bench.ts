import { it } from "vitest";
import { clearBlobCache } from "../fs/blobCache.js";
import { readFile } from "../fs/readFile.js";
import { clearResolveCache } from "../fs/resolveCache.js";
import type { SQLiteWorkspaceProvider } from "../provider.js";
import type { Database } from "../storage.js";
import type { StatementCounts } from "./counting-storage.js";
import { benchRead, type ReadBenchmarkResult, withCountingDb, withRealDb } from "./harness.js";
import { benchmarkReport, readTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

const SMALL_FILE_MAX_BYTES = 64 * 1024;
const ITERATIONS = 2000;

const baselineCompleteRead: StatementCounts = {
  statements: 3,
  reads: 3,
  writes: 0,
  other: 0,
  rowsRead: 11,
  rowsWritten: 0,
};

const targetSmallCompleteRead: StatementCounts = {
  statements: 2,
  reads: 2,
  writes: 0,
  other: 0,
  rowsRead: 10,
  rowsWritten: 0,
};

function resetReadCaches(db: Database): void {
  clearResolveCache(db);
  clearBlobCache(db);
}

async function benchAsyncRead(options: {
  name: string;
  content: string;
  op: (db: Database) => Promise<void>;
}): Promise<ReadBenchmarkResult> {
  const { name, content, op } = options;
  const path = "/file.txt";
  const nsPerOp = await withRealDb(async (db, provider) => {
    provider.writeFileSync(path, content);
    for (let index = 0; index < 200; index++) {
      resetReadCaches(db);
      await op(db);
    }
    const start = performance.now();
    for (let index = 0; index < ITERATIONS; index++) {
      resetReadCaches(db);
      await op(db);
    }
    return ((performance.now() - start) * 1e6) / ITERATIONS;
  });
  const counts = await withCountingDb(async (db, provider, counting) => {
    provider.writeFileSync(path, content);
    resetReadCaches(db);
    counting.reset();
    await op(db);
    return counting.snapshot();
  });
  return { name, depth: 1, nsPerOp, ...counts };
}

function buildFile(content: string): (_db: Database, provider: SQLiteWorkspaceProvider) => void {
  return (_db, provider) => {
    provider.writeFileSync("/file.txt", content);
  };
}

it("benchmarks complete small-file reads against real DO SqlStorage", async () => {
  const fourKiB = "x".repeat(4 * 1024);
  const atThreshold = "x".repeat(SMALL_FILE_MAX_BYTES);
  const aboveThreshold = "x".repeat(SMALL_FILE_MAX_BYTES + 1);

  const filesystemSmall = await benchAsyncRead({
    name: "fs.readFile(4KiB)",
    content: fourKiB,
    op: async (db) => {
      await readFile(db, "/file.txt", "utf8");
    },
  });
  const providerSmall = await benchRead({
    name: "provider.readFileSync(4KiB)",
    depth: 1,
    build: buildFile(fourKiB),
    op: (db, provider) => {
      resetReadCaches(db);
      provider.readFileSync("/file.txt", "utf8");
    },
    iterations: ITERATIONS,
  });
  const providerAtThreshold = await benchRead({
    name: "provider.readFileSync(64KiB)",
    depth: 1,
    build: buildFile(atThreshold),
    op: (db, provider) => {
      resetReadCaches(db);
      provider.readFileSync("/file.txt", "utf8");
    },
    iterations: ITERATIONS,
  });
  const providerAboveThreshold = await benchRead({
    name: "provider.readFileSync(64KiB+1)",
    depth: 1,
    build: buildFile(aboveThreshold),
    op: (db, provider) => {
      resetReadCaches(db);
      provider.readFileSync("/file.txt", "utf8");
    },
    iterations: ITERATIONS,
  });
  const rangedSmall = await benchRead({
    name: "provider.readRangeSync(1KiB/4KiB)",
    depth: 1,
    build: buildFile(fourKiB),
    op: (db, provider) => {
      resetReadCaches(db);
      provider.readRangeSync("/file.txt", 0, 1024);
    },
    iterations: ITERATIONS,
  });
  const results = [
    filesystemSmall,
    providerSmall,
    providerAtThreshold,
    providerAboveThreshold,
    rangedSmall,
  ];

  benchmarkReport({
    scenario: "small-complete-file-read",
    title: "dofs small complete-file read benchmark",
    note: "statement signatures are deterministic; ns/op is observational wall-clock under workerd with read caches cleared per operation.",
    sections: [readTable(results)],
    results: {
      reads: results,
      baselineCompleteRead,
      targetSmallCompleteRead,
      smallFileMaxBytes: SMALL_FILE_MAX_BYTES,
    },
  });

  expectMetricSignature(filesystemSmall.name, filesystemSmall, targetSmallCompleteRead);
  expectMetricSignature(providerSmall.name, providerSmall, targetSmallCompleteRead);
  expectMetricSignature(providerAtThreshold.name, providerAtThreshold, targetSmallCompleteRead);
  expectMetricSignature(providerAboveThreshold.name, providerAboveThreshold, baselineCompleteRead);
  expectMetricSignature(rangedSmall.name, rangedSmall, baselineCompleteRead);
});
