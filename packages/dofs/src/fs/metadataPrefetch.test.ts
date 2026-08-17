import { describe, expect, it } from "vitest";

import { CountingStorage } from "../bench/counting-storage.js";
import type { DatabaseOperationOptions } from "../operation.js";
import { withDatabaseOperation } from "../operation.js";
import { SQLiteWorkspaceProvider } from "../provider.js";
import { initializeSchema } from "../schema/index.js";
import type { Database } from "../storage.js";
import { Database as DatabaseConstructor } from "../storage.js";
import { SQLiteTestStorage } from "../testing.js";
import { find } from "./find.js";
import { mkdir } from "./mkdir.js";
import { readdir } from "./readdir.js";
import { readFile } from "./readFile.js";
import { resolveInode } from "./resolve.js";
import { clearResolveCache } from "./resolveCache.js";
import { symlink } from "./symlink.js";
import {
  openWriteBufferForCreateSync,
  releaseWriteBufferSync,
  writeFileSync,
  writeRangeSync,
} from "./writeFile.js";

const NOW = (): number => 1000;
const DEFAULT_PREFETCH_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 20_000;

interface MetadataPrefetchOptions extends DatabaseOperationOptions {
  maxMetadataPrefetchBytes: number;
  maxMetadataPrefetchDirectoryEntries: number;
}

async function withCountingDatabase<T>(
  run: (
    db: Database,
    provider: SQLiteWorkspaceProvider,
    counting: CountingStorage,
  ) => T | Promise<T>,
): Promise<T> {
  const storage = new SQLiteTestStorage();
  const counting = new CountingStorage(storage);
  const db = new DatabaseConstructor(counting);
  initializeSchema(db, NOW);
  const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
  try {
    return await run(db, provider, counting);
  } finally {
    storage.close();
  }
}

function prefetchOptions(
  overrides: Partial<MetadataPrefetchOptions> = {},
): MetadataPrefetchOptions {
  return {
    maxReadCacheEntries: 65_536,
    maxMetadataPrefetchBytes: DEFAULT_PREFETCH_BYTES,
    maxMetadataPrefetchDirectoryEntries: DEFAULT_MAX_DIRECTORY_ENTRIES,
    ...overrides,
  };
}

function writeFiles(provider: SQLiteWorkspaceProvider, directory: string, names: string[]): void {
  provider.mkdirSync(directory, { recursive: true });
  for (const name of names) provider.writeFileSync(`${directory}/${name}`, name);
}

function seedWideDirectory(db: Database, directory: string, width: number): void {
  mkdir(db, directory, {}, NOW);
  const parent = resolveInode(db, directory);
  if (parent?.type !== "dir") throw new Error("wide fixture directory is missing");
  const firstInode = (db.scalar<number>("SELECT COALESCE(MAX(inode), 0) FROM vfs_nodes") ?? 0) + 1;
  db.transactionSync(() => {
    db.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value + 1 < ?
       )
       INSERT INTO vfs_nodes (type, mode, mtime, rev, size)
       SELECT 'file', ?, ?, 0, 0 FROM sequence`,
      width,
      0o644,
      NOW(),
    );
    db.run(
      `INSERT INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT ?, printf('f%05d', inode - ?), inode
         FROM vfs_nodes
        WHERE inode >= ?
        ORDER BY inode`,
      parent.inode,
      firstInode,
      firstInode,
    );
  });
}

function statementDelta(counting: CountingStorage, before: number): number {
  return counting.snapshot().statements - before;
}

describe("operation-local metadata prefetch", () => {
  it("serves repeated complete listings and known child hits or misses without SQL", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/dir", ["a", "b", "c"]);
      clearResolveCache(db);

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          expect(readdir(operationDb, "/dir").map((entry) => entry.name)).toEqual(["a", "b", "c"]);
          const before = counting.snapshot().statements;

          expect(readdir(operationDb, "/dir").map((entry) => entry.name)).toEqual(["a", "b", "c"]);
          expect(resolveInode(operationDb, "/dir/b")?.type).toBe("file");
          expect(resolveInode(operationDb, "/dir/missing")).toBeNull();
          expect(statementDelta(counting, before)).toBe(0);
        },
        prefetchOptions(),
      );
    });
  });

  it("does not treat a page as a complete directory", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/dir", ["a", "b", "c"]);
      clearResolveCache(db);

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          expect(readdir(operationDb, "/dir", { limit: 1 })[0]?.name).toBe("a");
          const before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/dir/c")?.type).toBe("file");
          expect(readdir(operationDb, "/dir")).toHaveLength(3);
          expect(statementDelta(counting, before)).toBeGreaterThan(0);
        },
        prefetchOptions(),
      );
    });
  });

  it("applies the explicit directory-width threshold", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/fits", ["a", "b"]);
      writeFiles(provider, "/too-wide", ["a", "b", "c"]);
      clearResolveCache(db);
      const options = prefetchOptions({ maxMetadataPrefetchDirectoryEntries: 2 });

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          readdir(operationDb, "/fits");
          let before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/fits/b")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBe(0);

          readdir(operationDb, "/too-wide");
          before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/too-wide/c")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBeGreaterThan(0);
        },
        options,
      );
    });
  });

  it("admits all or none of a directory at the metadata byte-budget boundary", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/dir", ["a", "b"]);
      clearResolveCache(db);

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          readdir(operationDb, "/dir");
          const before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/dir/a")?.type).toBe("file");
          expect(resolveInode(operationDb, "/dir/b")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBe(2);
        },
        prefetchOptions({ maxMetadataPrefetchBytes: 1 }),
      );

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          readdir(operationDb, "/dir");
          const before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/dir/a")?.type).toBe("file");
          expect(resolveInode(operationDb, "/dir/b")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBe(0);
        },
        prefetchOptions(),
      );
    });
  });

  it("refuses a complete directory wider than twenty thousand entries", async () => {
    await withCountingDatabase((db, _provider, counting) => {
      seedWideDirectory(db, "/wide", DEFAULT_MAX_DIRECTORY_ENTRIES + 1);
      clearResolveCache(db);

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          expect(readdir(operationDb, "/wide")).toHaveLength(DEFAULT_MAX_DIRECTORY_ENTRIES + 1);
          const before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/wide/f00000")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBeGreaterThan(0);
        },
        prefetchOptions({ maxMetadataPrefetchBytes: Number.MAX_SAFE_INTEGER }),
      );
    });
  });

  it("invalidates prefetched metadata after filesystem and raw SQL writes", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/dir", ["a"]);
      clearResolveCache(db);

      withDatabaseOperation(db, (operationDb: Database) => {
        readdir(operationDb, "/dir");
        writeFileSync(operationDb, "/dir/b", new TextEncoder().encode("b"), {}, NOW);
        let before = counting.snapshot().statements;
        expect(readdir(operationDb, "/dir").map((entry) => entry.name)).toEqual(["a", "b"]);
        expect(statementDelta(counting, before)).toBeGreaterThan(0);

        const inode = resolveInode(operationDb, "/dir/a")?.inode;
        if (inode === undefined) throw new Error("raw SQL fixture inode is missing");
        readdir(operationDb, "/dir");
        operationDb.run("UPDATE vfs_nodes SET size = ? WHERE inode = ?", 9, inode);
        before = counting.snapshot().statements;
        expect(resolveInode(operationDb, "/dir/a")?.size).toBe(9);
        expect(statementDelta(counting, before)).toBeGreaterThan(0);
      });
    });
  });

  it("bypasses metadata prefetch in transactions and recovers after rollback", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/dir", ["a"]);
      clearResolveCache(db);

      withDatabaseOperation(db, (operationDb: Database) => {
        readdir(operationDb, "/dir");
        const inode = resolveInode(operationDb, "/dir/a")?.inode;
        if (inode === undefined) throw new Error("rollback fixture inode is missing");

        expect(() =>
          operationDb.transactionSync(() => {
            operationDb.run("UPDATE vfs_nodes SET size = ? WHERE inode = ?", 9, inode);
            const before = counting.snapshot().statements;
            expect(readdir(operationDb, "/dir")[0]?.size).toBe(9);
            expect(readdir(operationDb, "/dir")[0]?.size).toBe(9);
            expect(statementDelta(counting, before)).toBeGreaterThan(2);
            throw new Error("roll back metadata change");
          }),
        ).toThrowError("roll back metadata change");

        expect(readdir(operationDb, "/dir")[0]?.size).toBe(1);
      });
    });
  });

  it("does not snapshot directories with live pending write buffers", async () => {
    await withCountingDatabase((db, provider, counting) => {
      provider.mkdirSync("/dir");
      openWriteBufferForCreateSync(db, "/dir/pending", {}, NOW);
      writeRangeSync(db, "/dir/pending", new TextEncoder().encode("one"), 0, {}, NOW);
      clearResolveCache(db);

      withDatabaseOperation(db, (operationDb: Database) => {
        expect(readdir(operationDb, "/dir")[0]?.size).toBe(3);
        writeRangeSync(
          operationDb,
          "/dir/pending",
          new TextEncoder().encode("two-two"),
          0,
          {},
          NOW,
        );
        const before = counting.snapshot().statements;
        expect(readdir(operationDb, "/dir")[0]?.size).toBe(7);
        expect(statementDelta(counting, before)).toBeGreaterThan(0);
      });

      releaseWriteBufferSync(db, "/dir/pending", NOW);
    });
  });

  it("reuses nested prefetch state but isolates sibling root operations", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/dir", ["a", "b"]);
      clearResolveCache(db);

      withDatabaseOperation(db, (first: Database) => {
        readdir(first, "/dir");
        withDatabaseOperation(first, (nested: Database) => {
          const before = counting.snapshot().statements;
          expect(readdir(nested, "/dir")).toHaveLength(2);
          expect(statementDelta(counting, before)).toBe(0);
        });

        withDatabaseOperation(db, (sibling: Database) => {
          const before = counting.snapshot().statements;
          expect(readdir(sibling, "/dir")).toHaveLength(2);
          expect(statementDelta(counting, before)).toBeGreaterThan(0);
        });
      });
    });
  });

  it("does not traverse or cache paths through symlink entries", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/target", ["child"]);
      provider.mkdirSync("/root");
      symlink(db, "/target", "/root/link", NOW);
      clearResolveCache(db);

      withDatabaseOperation(db, (operationDb: Database) => {
        readdir(operationDb, "/root");
        let before = counting.snapshot().statements;
        expect(resolveInode(operationDb, "/root/link/child")?.type).toBe("file");
        expect(statementDelta(counting, before)).toBeGreaterThan(0);
        before = counting.snapshot().statements;
        expect(resolveInode(operationDb, "/root/link/child")?.type).toBe("file");
        expect(statementDelta(counting, before)).toBeGreaterThan(0);
        expect(find(operationDb, "/root", "**/child")).toEqual([]);
      });
    });
  });

  it("prefetches metadata without retaining file bytes", async () => {
    await withCountingDatabase(async (db, provider, counting) => {
      writeFiles(provider, "/dir", ["file"]);
      clearResolveCache(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        readdir(operationDb, "/dir");
        const before = counting.snapshot().statements;
        await expect(readFile(operationDb, "/dir/file", "utf8")).resolves.toBe("file");
        expect(statementDelta(counting, before)).toBeGreaterThan(0);
      });
    });
  });

  it("does not retain child metadata when find stops before completing a directory", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/tree", ["a", "b", "c"]);
      clearResolveCache(db);

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          expect(find(operationDb, "/tree", undefined, { limit: 1 })).toEqual([
            { path: "/tree/a", type: "file" },
          ]);
          const before = counting.snapshot().statements;

          expect(resolveInode(operationDb, "/tree/a")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBeGreaterThan(0);
        },
        prefetchOptions(),
      );
    });
  });

  it("does not retain child metadata when find prefetch has no byte budget", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/tree", ["a", "b", "c"]);
      clearResolveCache(db);

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          expect(find(operationDb, "/tree")).toHaveLength(3);
          for (const name of ["a", "b", "c"]) {
            const before = counting.snapshot().statements;
            expect(resolveInode(operationDb, `/tree/${name}`)?.type).toBe("file");
            expect(statementDelta(counting, before)).toBeGreaterThan(0);
          }
        },
        prefetchOptions({ maxMetadataPrefetchBytes: 0 }),
      );
    });
  });

  it("does not retain child metadata from find when the directory exceeds its entry bound", async () => {
    await withCountingDatabase((db, _provider, counting) => {
      seedWideDirectory(db, "/wide", 129);
      clearResolveCache(db);

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          expect(find(operationDb, "/wide")).toHaveLength(129);
          let before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/wide/f00000")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBeGreaterThan(0);
          before = counting.snapshot().statements;
          expect(resolveInode(operationDb, "/wide/f00128")?.type).toBe("file");
          expect(statementDelta(counting, before)).toBeGreaterThan(0);
        },
        prefetchOptions({ maxMetadataPrefetchDirectoryEntries: 128 }),
      );
    });
  });

  it("lets find warm path and node metadata for the rest of its operation", async () => {
    await withCountingDatabase((db, provider, counting) => {
      writeFiles(provider, "/tree", ["a", "b", "c"]);
      clearResolveCache(db);

      withDatabaseOperation(db, (operationDb: Database) => {
        const entries = find(operationDb, "/tree");
        expect(entries).toHaveLength(3);
        const before = counting.snapshot().statements;
        for (const entry of entries) {
          expect(resolveInode(operationDb, entry.path)?.type).toBe(entry.type);
        }
        expect(resolveInode(operationDb, "/tree/missing")).toBeNull();
        expect(statementDelta(counting, before)).toBe(0);
      });
    });
  });
});
