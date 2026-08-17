import { expect, it } from "vitest";
import { writeFileSync } from "../fs/writeFile.js";
import type { Database } from "../storage.js";
import { benchMutation, type MutationBenchmarkResult } from "./harness.js";
import { benchmarkReport, mutationTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

const FILES = 500;
const NOW = (): number => 1000;
const encoder = new TextEncoder();

function createFixtureDirectory(
  _db: Database,
  provider: { mkdirSync(path: string): unknown },
): void {
  provider.mkdirSync("/bulk");
}

function writeUniqueFiles(db: Database): void {
  for (let index = 0; index < FILES; index += 1) {
    writeFileSync(
      db,
      `/bulk/file-${index}.txt`,
      encoder.encode(`unique content ${index}`),
      {},
      NOW,
    );
  }
}

function baselineBenchmark(): Promise<MutationBenchmarkResult> {
  return benchMutation({
    name: `sequential-small-create(${FILES})`,
    build: createFixtureDirectory,
    batch: (db) => {
      writeUniqueFiles(db);
      return FILES;
    },
  });
}

it("benchmarks sequential creates against a synchronous write batch", async () => {
  const baseline = await baselineBenchmark();
  console.log(`WRITE_BATCH_BASELINE ${JSON.stringify(baseline)}`);
  expectMetricSignature("sequential create baseline", baseline, {
    statements: 5500,
    reads: 1500,
    writes: 4000,
    other: 0,
    rowsRead: 3500,
    rowsWritten: 8500,
  });

  const { withWriteBatchSync } = await import("../fs/writeBatch.js");
  const batched = await benchMutation({
    name: `batched-small-create(${FILES})`,
    build: createFixtureDirectory,
    batch: (db) => {
      withWriteBatchSync(db, (batchDb: Database) => writeUniqueFiles(batchDb));
      return FILES;
    },
  });

  benchmarkReport({
    scenario: "write-batch",
    title: "dofs synchronous write-batch benchmark",
    note: "statement counts are deterministic; wall time is observational under workerd.",
    sections: [mutationTable([baseline, batched])],
    results: { baseline, batched, targetStatements: 40 },
  });

  expect(baseline.statements).toBeGreaterThan(1000);
  expect(batched.statements).toBeLessThan(40);
  expect(batched.statements).toBeLessThan(baseline.statements);
});
