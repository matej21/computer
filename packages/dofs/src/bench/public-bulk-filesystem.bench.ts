import { expect, it } from "vitest";

import { WorkspaceFilesystem } from "../fs/filesystem.js";
import type { SQLiteWorkspaceProvider } from "../provider.js";
import type { Database } from "../storage.js";
import type { StatementCounts } from "./counting-storage.js";
import type { MutationBenchmarkResult, ReadBenchmarkResult } from "./harness.js";
import { withCountingDb, withRealDb } from "./harness.js";
import { benchmarkReport, mutationTable, readTable } from "./report.js";

const MIB = 1024 * 1024;
const WALK_FILES = 2500;
const READ_FILES = 100;
const MUTATION_FILES = 500;
const WIDE_FILES = 10_000;

type Build = (db: Database, provider: SQLiteWorkspaceProvider) => void;
type ReadOperation = (fs: WorkspaceFilesystem) => Promise<number>;
type MutationOperation = (fs: WorkspaceFilesystem) => Promise<void>;

async function measureRead(
  name: string,
  build: Build,
  operation: ReadOperation,
): Promise<{ result: ReadBenchmarkResult; units: number }> {
  const timing = await withRealDb(async (db, provider) => {
    build(db, provider);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    const start = performance.now();
    const units = await operation(fs);
    return { totalMs: performance.now() - start, units };
  });
  const measured = await withCountingDb(async (db, provider, counting) => {
    build(db, provider);
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
      nsPerOp: timing.totalMs * 1e6,
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
    build(db, provider);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    const start = performance.now();
    await operation(fs);
    return performance.now() - start;
  });
  const counts = await withCountingDb(async (db, provider, counting) => {
    build(db, provider);
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

async function countOperation(
  build: Build,
  operation: (fs: WorkspaceFilesystem) => Promise<void>,
): Promise<StatementCounts> {
  return withCountingDb(async (db, provider, counting) => {
    build(db, provider);
    const fs = new WorkspaceFilesystem(db, { now: () => 1000 });
    counting.reset();
    await operation(fs);
    return counting.snapshot();
  });
}

function buildFiles(provider: SQLiteWorkspaceProvider, directory: string, count: number): void {
  provider.mkdirSync(directory, { recursive: true });
  for (let index = 0; index < count; index++) {
    provider.writeFileSync(`${directory}/f${String(index).padStart(4, "0")}`, `value-${index}`);
  }
}

function buildEmptyFiles(
  db: Database,
  provider: SQLiteWorkspaceProvider,
  directory: string,
  count: number,
  prefix = "f",
): void {
  provider.mkdirSync(directory, { recursive: true });
  if (count === 0) return;
  const parentInode = db.scalar<number>(
    "SELECT child_inode FROM vfs_dirents WHERE parent_inode = 1 AND name = ?",
    directory.slice(1),
  );
  if (parentInode === undefined) throw new Error("benchmark directory is missing");
  const firstInode = (db.scalar<number>("SELECT COALESCE(MAX(inode), 0) FROM vfs_nodes") ?? 0) + 1;
  db.transactionSync(() => {
    db.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value + 1 < ?
       )
       INSERT INTO vfs_nodes (type, mode, mtime, rev, size)
       SELECT 'file', ?, 1000, 0, 0 FROM sequence`,
      count,
      0o644,
    );
    db.run(
      `INSERT INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT ?, ? || printf('%05d', inode - ?), inode
         FROM vfs_nodes
        WHERE inode >= ?
        ORDER BY inode`,
      parentInode,
      prefix,
      firstInode,
      firstInode,
    );
  });
}

function reportRead(result: ReadBenchmarkResult, pages: number, baseline: StatementCounts): void {
  benchmarkReport({
    scenario: result.name,
    title: "dofs public bulk read benchmark",
    note: "total operation counts are deterministic; wall-clock is observational under workerd.",
    sections: [readTable([result])],
    results: {
      reads: [result],
      operation: {
        pages,
        totalNs: result.nsPerOp,
        statementsPerPage: result.statements / pages,
        readsPerPage: result.reads / pages,
      },
      sameFixtureBaseline: baseline,
    },
  });
}

function reportMutation(result: MutationBenchmarkResult, baseline: StatementCounts): void {
  benchmarkReport({
    scenario: result.name,
    title: "dofs public bulk mutation benchmark",
    note: "statement counts are deterministic; wall-clock is observational under workerd.",
    sections: [mutationTable([result])],
    results: { mutations: [result], sameFixtureBaseline: baseline },
  });
}

it("walks 2500 files in bounded pages with at most two reads per page", async () => {
  const { result, units: pages } = await measureRead(
    `walk-pages(${WALK_FILES})`,
    (_db, provider) => buildFiles(provider, "/walk", WALK_FILES),
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
  const baseline = await countOperation(
    (_db, provider) => buildFiles(provider, "/walk", WALK_FILES),
    async (fs) => {
      await fs.find("/walk");
    },
  );
  reportRead(result, pages, baseline);
  expect(pages).toBe(3);
  expect(result.statements).toBeLessThanOrEqual(pages * 2);
  expect(result.reads).toBeLessThanOrEqual(pages * 2);
  expect(result.writes).toBe(0);
  expect(result.statements).toBeLessThan(baseline.statements);
});

it("reads 100 small files in fewer than ten statements", async () => {
  const paths = Array.from(
    { length: READ_FILES },
    (_, index) => `/read/f${String(index).padStart(4, "0")}`,
  );
  const { result } = await measureRead(
    `readFiles(${READ_FILES})`,
    (_db, provider) => buildFiles(provider, "/read", READ_FILES),
    async (fs) => {
      const page = await fs.readFiles(paths, { limit: READ_FILES, maxBytes: 4 * MIB });
      expect(page.entries).toHaveLength(READ_FILES);
      expect(page.cursor).toBeUndefined();
      return 1;
    },
  );
  const baseline = await countOperation(
    (_db, provider) => buildFiles(provider, "/read", READ_FILES),
    async (fs) => {
      for (const path of paths) await fs.readFile(path, "utf8");
    },
  );
  reportRead(result, 1, baseline);
  expect(result.statements).toBeLessThan(10);
  expect(result.writes).toBe(0);
  expect(result.statements).toBeLessThan(baseline.statements);
});

it("writes 500 unique small files in fewer than forty statements", async () => {
  const entries = Array.from({ length: MUTATION_FILES }, (_, index) => ({
    path: `/write/f${String(index).padStart(4, "0")}`,
    content: `value-${index}`,
  }));
  const result = await measureMutation(
    `writeFiles(${MUTATION_FILES})`,
    (_db, provider) => provider.mkdirSync("/write", { recursive: true }),
    (fs) => fs.writeFiles(entries, { maxBytes: 4 * MIB }),
  );
  const baseline = await countOperation(
    (_db, provider) => provider.mkdirSync("/write", { recursive: true }),
    async (fs) => {
      for (const entry of entries) await fs.writeFile(entry.path, entry.content);
    },
  );
  reportMutation(result, baseline);
  expect(result.statements).toBeLessThan(40);
  expect(result.statements).toBeLessThan(baseline.statements);
});

it("removes 500 files in fewer than fifteen statements", async () => {
  const paths = Array.from(
    { length: MUTATION_FILES },
    (_, index) => `/remove/f${String(index).padStart(4, "0")}`,
  );
  const result = await measureMutation(
    `rmFiles(${MUTATION_FILES})`,
    (_db, provider) => buildFiles(provider, "/remove", MUTATION_FILES),
    (fs) =>
      fs.rmFiles(paths, {
        maxEntries: 10_000,
        maxMetadataBytes: 4 * MIB,
      }),
  );
  const baseline = await countOperation(
    (_db, provider) => buildFiles(provider, "/remove", MUTATION_FILES),
    async (fs) => {
      for (const path of paths) await fs.rm(path);
    },
  );
  reportMutation(result, baseline);
  expect(result.statements).toBeLessThan(15);
  expect(result.statements).toBeLessThan(baseline.statements);
});

it("copies a 500-file tree by metadata in fewer than fifteen statements", async () => {
  const result = await measureMutation(
    `cp(${MUTATION_FILES})`,
    (_db, provider) => buildFiles(provider, "/copy-source", MUTATION_FILES),
    (fs) =>
      fs.cp("/copy-source", "/copy-dest", {
        recursive: true,
        maxEntries: 10_000,
        maxMetadataBytes: 4 * MIB,
      }),
  );
  const baseline = await countOperation(
    (_db, provider) => buildFiles(provider, "/copy-source", MUTATION_FILES),
    async (fs) => {
      await fs.mkdir("/copy-dest", { recursive: true });
      for (let index = 0; index < MUTATION_FILES; index++) {
        const name = `f${String(index).padStart(4, "0")}`;
        const content = await fs.readFile(`/copy-source/${name}`, "utf8");
        await fs.writeFile(`/copy-dest/${name}`, content);
      }
    },
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
    return counting.queries.some((query) => query.toLowerCase().includes("vfs_blob_bytes"));
  });
  reportMutation(result, baseline);
  expect(result.statements).toBeLessThan(15);
  expect(touchesBlobBytes).toBe(false);
  expect(result.statements).toBeLessThan(baseline.statements);
});

it("keeps wide walk, readFiles, and cp row work proportional to bounded input", async () => {
  const countWalk = (count: number) =>
    countOperation(
      (db, provider) => buildEmptyFiles(db, provider, "/walk", count),
      async (fs) => {
        let cursor: string | undefined;
        do {
          const page = await fs.walk("/walk", { limit: 1000, maxBytes: MIB, cursor });
          cursor = page.cursor;
        } while (cursor !== undefined);
      },
    );
  const narrowWalk = await countWalk(WALK_FILES);
  const wideWalk = await countWalk(WIDE_FILES);
  expect(wideWalk.rowsRead / WIDE_FILES).toBeLessThanOrEqual(
    (narrowWalk.rowsRead / WALK_FILES) * 2,
  );

  const paths = Array.from(
    { length: READ_FILES },
    (_, index) => `/read/f${String(index).padStart(4, "0")}`,
  );
  const countReads = (width: number) =>
    countOperation(
      (db, provider) => {
        buildFiles(provider, "/read", READ_FILES);
        buildEmptyFiles(db, provider, "/read", width - READ_FILES, "z");
      },
      async (fs) => {
        await fs.readFiles(paths, { limit: READ_FILES, maxBytes: 4 * MIB });
      },
    );
  const narrowReads = await countReads(READ_FILES);
  const wideReads = await countReads(WIDE_FILES);
  expect(wideReads.rowsRead).toBeLessThanOrEqual(narrowReads.rowsRead * 2);

  const countCopy = (count: number) =>
    countOperation(
      (db, provider) => buildEmptyFiles(db, provider, "/copy-source", count),
      async (fs) => {
        await fs.cp("/copy-source", "/copy-dest", {
          recursive: true,
          maxEntries: 10_000,
          maxMetadataBytes: 4 * MIB,
        });
      },
    );
  const narrowCopy = await countCopy(MUTATION_FILES);
  const wideCopy = await countCopy(WIDE_FILES - 1);
  expect(wideCopy.rowsRead / (WIDE_FILES - 1)).toBeLessThanOrEqual(
    (narrowCopy.rowsRead / MUTATION_FILES) * 2,
  );
});
