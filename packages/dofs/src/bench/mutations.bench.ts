import { expect, it } from "vitest";
import { rm } from "../fs/rm.js";
import type { SQLiteWorkspaceProvider } from "../provider.js";
import type { StatementCounts } from "./counting-storage.js";
import { chainOf } from "./fixtures.js";
import { type BenchmarkBuild, benchMutation, type MutationBenchmarkResult } from "./harness.js";
import { benchmarkReport, mutationTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

it("benchmarks filesystem mutations against real DO SqlStorage", async () => {
  const results: MutationBenchmarkResult[] = [];
  const files = 2000;
  const recursiveDelete = await benchMutation({
    name: `recursive-delete(${files})`,
    build: (_db, provider) => {
      provider.mkdirSync("/tree", { recursive: true });
      for (let i = 0; i < files; i++) {
        provider.writeFileSync(`/tree/f${i}.txt`, "x");
      }
    },
    batch: (db) => {
      rm(db, "/tree", { recursive: true, force: true });
      return files;
    },
  });
  const recursiveDeleteSignature: StatementCounts = {
    statements: 10010,
    reads: 2006,
    writes: 8004,
    other: 0,
    rowsRead: 4006,
    rowsWritten: 14007,
  };
  const recursiveDeleteTarget = {
    maxStatements: 16,
    maxReadStatements: 6,
    maxWriteStatements: 10,
  };
  results.push(recursiveDelete);

  const depth = 8;
  const count = 1000;
  const { dir } = chainOf(depth);
  const base = dir ?? "";
  const ensureDir: BenchmarkBuild = (_db, provider) => {
    if (dir !== null) {
      provider.mkdirSync(dir, { recursive: true });
    }
  };
  const createAll = (provider: SQLiteWorkspaceProvider, value: string): void => {
    for (let i = 0; i < count; i++) {
      provider.writeFileSync(`${base}/burst${i}.txt`, value);
    }
  };
  const createBurst = await benchMutation({
    name: `write-burst:create(${count})`,
    build: ensureDir,
    batch: (_db, provider) => {
      createAll(provider, "x");
      return count;
    },
  });
  const createBurstSignature: StatementCounts = {
    statements: 22000,
    reads: 15000,
    writes: 7000,
    other: 0,
    rowsRead: 19000,
    rowsWritten: 11004,
  };
  results.push(createBurst);

  const editBurst = await benchMutation({
    name: `write-burst:edit-in-place(${count})`,
    build: (db, provider) => {
      ensureDir(db, provider);
      createAll(provider, "x");
    },
    batch: (_db, provider) => {
      createAll(provider, "yy");
      return count;
    },
  });
  const editBurstSignature: StatementCounts = {
    statements: 23000,
    reads: 16000,
    writes: 7000,
    other: 0,
    rowsRead: 18000,
    rowsWritten: 9004,
  };
  results.push(editBurst);

  const deleteBurst = await benchMutation({
    name: `write-burst:delete(${count})`,
    build: (db, provider) => {
      ensureDir(db, provider);
      createAll(provider, "x");
    },
    batch: (_db, provider) => {
      for (let i = 0; i < count; i++) {
        provider.unlinkSync(`${base}/burst${i}.txt`);
      }
      return count;
    },
  });
  const deleteBurstSignature: StatementCounts = {
    statements: 80000,
    reads: 75000,
    writes: 5000,
    other: 0,
    rowsRead: 83000,
    rowsWritten: 8000,
  };
  results.push(deleteBurst);

  const singleRename = await benchMutation({
    name: `single-rename(${count})`,
    build: (_db, provider) => {
      provider.mkdirSync("/mv", { recursive: true });
      for (let i = 0; i < count; i++) {
        provider.writeFileSync(`/mv/a${i}.txt`, "x");
      }
    },
    batch: (_db, provider) => {
      for (let i = 0; i < count; i++) {
        provider.renameSync(`/mv/a${i}.txt`, `/mv/b${i}.txt`);
      }
      return count;
    },
  });
  const singleRenameSignature: StatementCounts = {
    statements: 32000,
    reads: 27000,
    writes: 5000,
    other: 0,
    rowsRead: 28000,
    rowsWritten: 10000,
  };
  results.push(singleRename);

  const descendants = 500;
  const subtreeRename = await benchMutation({
    name: `subtree-rename(${descendants})`,
    build: (_db, provider) => {
      provider.mkdirSync("/sub/inner", { recursive: true });
      for (let i = 0; i < descendants; i++) {
        provider.writeFileSync(`/sub/inner/f${i}.txt`, "x");
      }
    },
    batch: (_db, provider) => {
      provider.renameSync("/sub", "/moved");
      return descendants;
    },
  });
  const subtreeRenameSignature: StatementCounts = {
    statements: 19,
    reads: 16,
    writes: 3,
    other: 0,
    rowsRead: 1518,
    rowsWritten: 2515,
  };
  results.push(subtreeRename);

  benchmarkReport({
    scenario: "filesystem-mutations",
    title: "dofs mutation benchmark",
    note: "statement counts are deterministic; total and per-item timings are wall-clock under workerd.",
    sections: [mutationTable(results)],
    results: {
      mutations: results,
      baselines: {
        recursiveDelete: recursiveDeleteSignature,
      },
      targets: {
        recursiveDelete: recursiveDeleteTarget,
      },
    },
  });

  expect(recursiveDelete.statements).toBeLessThanOrEqual(recursiveDeleteTarget.maxStatements);
  expect(recursiveDelete.reads).toBeLessThanOrEqual(recursiveDeleteTarget.maxReadStatements);
  expect(recursiveDelete.writes).toBeLessThanOrEqual(recursiveDeleteTarget.maxWriteStatements);
  expectMetricSignature(createBurst.name, createBurst, createBurstSignature);
  expectMetricSignature(editBurst.name, editBurst, editBurstSignature);
  expectMetricSignature(deleteBurst.name, deleteBurst, deleteBurstSignature);
  expectMetricSignature(singleRename.name, singleRename, singleRenameSignature);
  expectMetricSignature(subtreeRename.name, subtreeRename, subtreeRenameSignature);
});
