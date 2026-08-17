import { expect, it } from "vitest";

import { WorkspaceFilesystem } from "../fs/filesystem.js";
import type { SQLiteWorkspaceProvider } from "../provider.js";
import type { MutationBenchmarkResult, ReadBenchmarkResult } from "./harness.js";
import { withCountingDb, withRealDb } from "./harness.js";
import { benchmarkReport, mutationTable, readTable } from "./report.js";

const MIB = 1024 * 1024;
const WALK_FILES = 2500;
const READ_FILES = 100;
const MUTATION_FILES = 500;

type Build = (provider: SQLiteWorkspaceProvider) => void;
type ReadOperation = (fs: WorkspaceFilesystem) => Promise<number>;
type MutationOperation = (fs: WorkspaceFilesystem) => Promise<void>;

async function measureRead(
  name: string,
  build: Build,
  operation: ReadOperation,
): Promise<{ result: ReadBenchmarkResult; units: number }> {
  const timing = await withRealDb(async (db, provider) => {
    build(provider);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    const start = performance.now();
    const units = await operation(fs);
    return { totalMs: performance.now() - start, units };
  });
  const measured = await withCountingDb(async (db, provider, counting) => {
    build(provider);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    counting.reset();
    const units = await operation(fs);
    return { counts: counting.snapshot(), units };
  });
  expect(measured.units).toBe(timing.units);
  return {
    result: {
      name,
      depth: 1,
      nsPerOp: (timing.totalMs * 1e6) / Math.max(1, timing.units),
      ...measured.counts,
    },
    units: measured.units,
  };
}

async function measureMutation(
  name: string,
  build: Build,
  operation: MutationOperation,
): Promise<MutationBenchmarkResult> {
  const totalMs = await withRealDb(async (db, provider) => {
    build(provider);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    const start = performance.now();
    await operation(fs);
    return performance.now() - start;
  });
  const counts = await withCountingDb(async (db, provider, counting) => {
    build(provider);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    counting.reset();
    await operation(fs);
    return counting.snapshot();
  });
  return {
    name,
    items: MUTATION_FILES,
    totalMs,
    nsPerItem: (totalMs * 1e6) / MUTATION_FILES,
    ...counts,
  };
}

function buildFiles(provider: SQLiteWorkspaceProvider, directory: string, count: number): void {
  provider.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index++) {
    provider.writeFileSync(`${directory}/f${String(index).padStart(4, "0")}`, `value-${index}`);
  }
}

function reportRead(result: ReadBenchmarkResult): void {
  benchmarkReport({
    scenario: result.name,
    title: "dofs public bulk read benchmark",
    note: "statement counts are deterministic; wall-clock is observational under workerd.",
    sections: [readTable([result])],
    results: { reads: [result] },
  });
}

function reportMutation(result: MutationBenchmarkResult): void {
  benchmarkReport({
    scenario: result.name,
    title: "dofs public bulk mutation benchmark",
    note: "statement counts are deterministic; wall-clock is observational under workerd.",
    sections: [mutationTable([result])],
    results: { mutations: [result] },
  });
}

it("walks 2500 files in bounded pages with at most two reads per page", async () => {
  const { result, units: pages } = await measureRead(
    `walk-pages(${WALK_FILES})`,
    (provider) => buildFiles(provider, "/walk", WALK_FILES),
    async (fs) => {
      let cursor: string | undefined;
      let pages = 0;
      let entries = 0;
      do {
        const page = await fs.walk("/walk", {
          limit: 1000,
          maxBytes: MIB,
          cursor,
        });
        pages += 1;
        entries += page.entries.length;
        cursor = page.cursor;
      } while (cursor !== undefined);
      expect(entries).toBe(WALK_FILES);
      return pages;
    },
  );
  reportRead(result);
  expect(pages).toBe(3);
  expect(result.statements).toBeLessThanOrEqual(pages * 2);
  expect(result.reads).toBeLessThanOrEqual(pages * 2);
  expect(result.writes).toBe(0);
});

it("reads 100 small files in fewer than ten statements", async () => {
  const paths = Array.from(
    { length: READ_FILES },
    (_, index) => `/read/f${String(index).padStart(4, "0")}`,
  );
  const { result } = await measureRead(
    `readFiles(${READ_FILES})`,
    (provider) => buildFiles(provider, "/read", READ_FILES),
    async (fs) => {
      const page = await fs.readFiles(paths, { limit: READ_FILES, maxBytes: 4 * MIB });
      expect(page.entries).toHaveLength(READ_FILES);
      expect(page.cursor).toBeUndefined();
      return 1;
    },
  );
  reportRead(result);
  expect(result.statements).toBeLessThan(10);
  expect(result.writes).toBe(0);
});

it("writes 500 unique small files in fewer than forty statements", async () => {
  const entries = Array.from({ length: MUTATION_FILES }, (_, index) => ({
    path: `/write/f${String(index).padStart(4, "0")}`,
    content: `value-${index}`,
  }));
  const result = await measureMutation(
    `writeFiles(${MUTATION_FILES})`,
    (provider) => provider.mkdirSync("/write", { recursive: true }),
    (fs) => fs.writeFiles(entries, { maxBytes: 4 * MIB }),
  );
  reportMutation(result);
  expect(result.statements).toBeLessThan(40);
});

it("removes 500 files in fewer than fifteen statements", async () => {
  const paths = Array.from(
    { length: MUTATION_FILES },
    (_, index) => `/remove/f${String(index).padStart(4, "0")}`,
  );
  const result = await measureMutation(
    `rmFiles(${MUTATION_FILES})`,
    (provider) => buildFiles(provider, "/remove", MUTATION_FILES),
    (fs) =>
      fs.rmFiles(paths, {
        maxEntries: 10_000,
        maxMetadataBytes: 4 * MIB,
      }),
  );
  reportMutation(result);
  expect(result.statements).toBeLessThan(15);
});

it("copies a 500-file tree by metadata in fewer than fifteen statements", async () => {
  const result = await measureMutation(
    `cp(${MUTATION_FILES})`,
    (provider) => buildFiles(provider, "/copy-source", MUTATION_FILES),
    (fs) =>
      fs.cp("/copy-source", "/copy-dest", {
        recursive: true,
        maxEntries: 10_000,
        maxMetadataBytes: 4 * MIB,
      }),
  );
  const touchesBlobBytes = await withCountingDb(async (db, provider, counting) => {
    buildFiles(provider, "/copy-source", MUTATION_FILES);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    counting.reset();
    await fs.cp("/copy-source", "/copy-dest", {
      recursive: true,
      maxEntries: 10_000,
      maxMetadataBytes: 4 * MIB,
    });
    return counting.queries.some((query) => query.includes("vfs_blob_bytes"));
  });
  reportMutation(result);
  expect(result.statements).toBeLessThan(15);
  expect(touchesBlobBytes).toBe(false);
});
