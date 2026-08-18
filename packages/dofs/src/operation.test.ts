import { describe, expect, expectTypeOf, it } from "vitest";
import { CountingStorage } from "./bench/counting-storage.js";
import { resolveInode } from "./fs/resolve.js";
import { clearResolveCache } from "./fs/resolveCache.js";
import { withDB } from "./fs/with-db.js";
import { writeFileSync } from "./fs/writeFile.js";
import type * as publicApi from "./index.js";
import {
  afterOutermostCommit,
  afterOutermostRollback,
  withDatabaseOperation,
  withProviderOperation,
} from "./operation.js";
import { SQLiteWorkspaceProvider } from "./provider.js";
import { initializeSchema } from "./schema/index.js";
import type { Database } from "./storage.js";
import { Database as DatabaseConstructor } from "./storage.js";
import { SQLiteTestStorage } from "./testing.js";

const NOW = (): number => 1000;

type AssertFalse<Value extends false> = Value;

const databaseOperationIsInternal: AssertFalse<
  "withDatabaseOperation" extends keyof typeof publicApi ? true : false
> = false;
const providerOperationIsInternal: AssertFalse<
  "withProviderOperation" extends keyof typeof publicApi ? true : false
> = false;
const commitCallbackIsInternal: AssertFalse<
  "afterOutermostCommit" extends keyof typeof publicApi ? true : false
> = false;
const rollbackCallbackIsInternal: AssertFalse<
  "afterOutermostRollback" extends keyof typeof publicApi ? true : false
> = false;

async function withCountingDatabase<T>(
  run: (db: Database, counting: CountingStorage) => T | Promise<T>,
): Promise<T> {
  const storage = new SQLiteTestStorage();
  const counting = new CountingStorage(storage);
  const db = new DatabaseConstructor(counting);
  initializeSchema(db, NOW);
  try {
    return await run(db, counting);
  } finally {
    storage.close();
  }
}

function statementDelta(counting: CountingStorage, before: number): number {
  return counting.snapshot().statements - before;
}

describe("database operation views", () => {
  it("defers provider hardlink counts and reuses resolved file sizes", async () => {
    await withCountingDatabase((db, counting) => {
      writeFileSync(db, "/file.txt", new TextEncoder().encode("content"), {}, NOW);
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });

      withProviderOperation(provider, (operationProvider) => {
        counting.reset();
        const stat = operationProvider.statSync("/file.txt");
        const statementsBeforeNlink = counting.snapshot().statements;
        expect(stat.size).toBe(7);
        expect(counting.queries.some((query) => query.includes("SELECT size FROM vfs_nodes"))).toBe(
          false,
        );
        expect(stat.nlink).toBe(1);
        expect(counting.snapshot().statements).toBe(statementsBeforeNlink + 1);

        counting.reset();
        expect(operationProvider.lstatSync("/file.txt").size).toBe(7);
        expect(counting.queries.some((query) => query.includes("SELECT size FROM vfs_nodes"))).toBe(
          false,
        );
      });
    });
  });

  it("keeps the operation API internal and preserves callback return types", async () => {
    expect(databaseOperationIsInternal).toBe(false);
    expect(providerOperationIsInternal).toBe(false);
    expect(commitCallbackIsInternal).toBe(false);
    expect(rollbackCallbackIsInternal).toBe(false);

    await withDB(async (db) => {
      const syncResult = withDatabaseOperation(db, (operationDb: Database) => {
        expectTypeOf(operationDb).toEqualTypeOf<Database>();
        return 42;
      });
      const asyncResult = withDatabaseOperation(db, async () => "done");

      expectTypeOf(syncResult).toEqualTypeOf<number>();
      expectTypeOf(asyncResult).toEqualTypeOf<Promise<string>>();
      expect(syncResult).toBe(42);
      await expect(asyncResult).resolves.toBe("done");
    });
  });

  it("reuses explicit nesting but isolates overlapping root operations", async () => {
    await withDB(async (db) => {
      const views: Database[] = [];

      await Promise.all([
        withDatabaseOperation(db, async (first: Database) => {
          views.push(first);
          await Promise.resolve();
          await withDatabaseOperation(first, async (nested: Database) => {
            expect(nested).toBe(first);
            await Promise.resolve();
          });
        }),
        withDatabaseOperation(db, async (second: Database) => {
          views.push(second);
          await Promise.resolve();
        }),
      ]);

      expect(views).toHaveLength(2);
      expect(views[0]).not.toBe(views[1]);
    });
  });

  it("keeps an async view alive through await and closes it after settlement", async () => {
    await withDB(async (db) => {
      let escaped: Database | undefined;

      await withDatabaseOperation(db, async (operationDb: Database) => {
        escaped = operationDb;
        await Promise.resolve();
        expect(resolveInode(operationDb, "/")?.type).toBe("dir");
      });

      const closedView = escaped;
      if (closedView === undefined) {
        throw new Error("operation callback did not run");
      }
      expect(() => resolveInode(closedView, "/")).toThrowError("Database operation is closed");
      expect(resolveInode(db, "/")?.type).toBe("dir");
    });
  });

  it("shares transaction ownership and savepoint depth across sibling views", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/file", new TextEncoder().encode("x"), {}, NOW);
      const inode = resolveInode(db, "/file")?.inode;
      if (inode === undefined) {
        throw new Error("fixture inode missing");
      }

      withDatabaseOperation(db, (first: Database) => {
        withDatabaseOperation(db, (second: Database) => {
          first.transactionSync(() => {
            expect(first.inTransaction).toBe(true);
            expect(second.inTransaction).toBe(true);

            expect(() =>
              second.transactionSync(() => {
                second.sql.exec("UPDATE vfs_nodes SET size = 9 WHERE inode = ?", inode);
                throw new Error("roll back savepoint");
              }),
            ).toThrowError("roll back savepoint");

            expect(first.scalar<number>("SELECT size FROM vfs_nodes WHERE inode = ?", inode)).toBe(
              1,
            );
          });
        });
      });
    });
  });

  it("does not read from or fill the operation cache inside a transaction", async () => {
    await withCountingDatabase((db, counting) => {
      writeFileSync(db, "/file", new TextEncoder().encode("x"), {}, NOW);
      clearResolveCache(db);

      withDatabaseOperation(db, (operationDb: Database) => {
        expect(resolveInode(operationDb, "/file")?.size).toBe(1);
        counting.reset();

        operationDb.transactionSync(() => {
          expect(resolveInode(operationDb, "/file")?.size).toBe(1);
          expect(resolveInode(operationDb, "/file")?.size).toBe(1);
        });

        expect(counting.snapshot().statements).toBe(6);
      });
    });
  });
});

describe("outermost transaction lifecycle callbacks", () => {
  it("runs commit callbacks synchronously and exactly once after the outer commit", async () => {
    await withDB(async (db) => {
      const events: string[] = [];

      const result = db.transactionSync(() => {
        afterOutermostCommit(db, () => events.push("commit"));
        afterOutermostRollback(db, () => events.push("rollback"));
        expect(events).toEqual([]);
        return "result";
      });

      expect(result).toBe("result");
      expect(events).toEqual(["commit"]);
    });
  });

  it("does not fire callbacks when a nested savepoint is released", async () => {
    await withDB(async (db) => {
      const events: string[] = [];

      db.transactionSync(() => {
        db.transactionSync(() => {
          afterOutermostCommit(db, () => events.push("nested commit"));
          afterOutermostRollback(db, () => events.push("nested rollback"));
        });

        expect(events).toEqual([]);
      });

      expect(events).toEqual(["nested commit"]);
    });
  });

  it("fires rollback callbacks and discards commit callbacks after an outer rollback", async () => {
    await withDB(async (db) => {
      const events: string[] = [];

      expect(() =>
        db.transactionSync(() => {
          afterOutermostCommit(db, () => events.push("outer commit"));
          afterOutermostRollback(db, () => events.push("outer rollback"));

          db.transactionSync(() => {
            afterOutermostCommit(db, () => events.push("nested commit"));
            afterOutermostRollback(db, () => events.push("nested rollback"));
          });

          expect(events).toEqual([]);
          throw new Error("roll back outer transaction");
        }),
      ).toThrowError("roll back outer transaction");

      expect(events).toEqual(["outer rollback", "nested rollback"]);
    });
  });

  it("registers through a sibling view on the shared transaction owner", async () => {
    await withDB(async (db) => {
      const events: string[] = [];

      withDatabaseOperation(db, (owner: Database) => {
        withDatabaseOperation(db, (sibling: Database) => {
          owner.transactionSync(() => {
            expect(owner.inTransaction).toBe(true);
            expect(sibling.inTransaction).toBe(true);
            afterOutermostCommit(sibling, () => events.push("sibling commit"));
            afterOutermostRollback(sibling, () => events.push("sibling rollback"));
            expect(events).toEqual([]);
          });
        });
      });

      expect(events).toEqual(["sibling commit"]);
    });
  });

  it("does not retain callbacks after either transaction outcome", async () => {
    await withDB(async (db) => {
      const events: string[] = [];

      db.transactionSync(() => {
        afterOutermostCommit(db, () => events.push("first commit"));
        afterOutermostRollback(db, () => events.push("first rollback"));
      });
      db.transactionSync(() => undefined);

      expect(() =>
        db.transactionSync(() => {
          afterOutermostCommit(db, () => events.push("second commit"));
          afterOutermostRollback(db, () => events.push("second rollback"));
          throw new Error("second transaction rollback");
        }),
      ).toThrowError("second transaction rollback");
      db.transactionSync(() => undefined);

      expect(events).toEqual(["first commit", "second rollback"]);
    });
  });
});

describe("operation read coherence", () => {
  it("reuses a nested cache without sharing it with a sibling operation", async () => {
    await withCountingDatabase((db, counting) => {
      writeFileSync(db, "/file", new TextEncoder().encode("x"), {}, NOW);
      clearResolveCache(db);
      counting.reset();

      withDatabaseOperation(db, (first: Database) => {
        expect(resolveInode(first, "/file")?.type).toBe("file");
        expect(counting.snapshot().statements).toBe(1);

        withDatabaseOperation(first, (nested: Database) => {
          expect(resolveInode(nested, "/file")?.type).toBe("file");
          expect(counting.snapshot().statements).toBe(1);
        });

        withDatabaseOperation(db, (second: Database) => {
          expect(resolveInode(second, "/file")?.type).toBe("file");
          expect(counting.snapshot().statements).toBe(2);
        });

        expect(resolveInode(first, "/file")?.type).toBe("file");
        expect(counting.snapshot().statements).toBe(2);
      });
    });
  });

  it("serves a repeated symlink-free resolution without another statement", async () => {
    await withCountingDatabase((db, counting) => {
      writeFileSync(db, "/file", new TextEncoder().encode("x"), {}, NOW);
      clearResolveCache(db);
      counting.reset();

      withDatabaseOperation(db, (operationDb: Database) => {
        expect(resolveInode(operationDb, "/file")?.size).toBe(1);
        const afterFirst = counting.snapshot().statements;
        expect(afterFirst).toBe(1);

        expect(resolveInode(operationDb, "/file")?.size).toBe(1);
        expect(statementDelta(counting, afterFirst)).toBe(0);
      });
    });
  });

  it("invalidates a view after a sibling writes through raw sql", async () => {
    await withCountingDatabase((db) => {
      writeFileSync(db, "/file", new TextEncoder().encode("x"), {}, NOW);
      clearResolveCache(db);

      withDatabaseOperation(db, (reader: Database) => {
        const inode = resolveInode(reader, "/file")?.inode;
        if (inode === undefined) {
          throw new Error("fixture inode missing");
        }
        expect(resolveInode(reader, "/file")?.size).toBe(1);

        withDatabaseOperation(db, (writer: Database) => {
          writer.sql.exec("UPDATE vfs_nodes SET size = 9 WHERE inode = ?", inode);
        });

        expect(resolveInode(reader, "/file")?.size).toBe(9);
      });
    });
  });

  it("drops transaction reads after rollback instead of retaining uncommitted data", async () => {
    await withDB(async (db) => {
      writeFileSync(db, "/file", new TextEncoder().encode("x"), {}, NOW);
      clearResolveCache(db);

      withDatabaseOperation(db, (operationDb: Database) => {
        const inode = resolveInode(operationDb, "/file")?.inode;
        if (inode === undefined) {
          throw new Error("fixture inode missing");
        }

        expect(() =>
          operationDb.transactionSync(() => {
            operationDb.sql.exec("UPDATE vfs_nodes SET size = 9 WHERE inode = ?", inode);
            expect(resolveInode(operationDb, "/file")?.size).toBe(9);
            throw new Error("roll back operation");
          }),
        ).toThrowError("roll back operation");

        expect(resolveInode(operationDb, "/file")?.size).toBe(1);
      });
    });
  });

  it("bounds path and node entries with one least-recently-used admission limit", async () => {
    await withCountingDatabase((db, counting) => {
      for (const name of ["a", "b", "c"]) {
        writeFileSync(db, `/${name}`, new TextEncoder().encode(name), {}, NOW);
      }
      clearResolveCache(db);
      counting.reset();

      withDatabaseOperation(
        db,
        (operationDb: Database) => {
          for (const name of ["a", "b", "c"]) {
            expect(resolveInode(operationDb, `/${name}`)?.type).toBe("file");
          }
          const afterFill = counting.snapshot().statements;
          expect(afterFill).toBe(3);

          expect(resolveInode(operationDb, "/c")?.type).toBe("file");
          expect(statementDelta(counting, afterFill)).toBe(0);

          expect(resolveInode(operationDb, "/a")?.type).toBe("file");
          expect(statementDelta(counting, afterFill)).toBe(1);
        },
        { maxReadCacheEntries: 4 },
      );
    });
  });

  it("does not cache a path that follows a symlink alias", async () => {
    await withCountingDatabase((db, counting) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
      provider.mkdirSync("/target");
      provider.writeFileSync("/target/file", "x");
      provider.symlinkSync("/target", "/alias");
      clearResolveCache(db);
      counting.reset();

      withDatabaseOperation(db, (operationDb: Database) => {
        expect(resolveInode(operationDb, "/alias/file")?.type).toBe("file");
        const afterFirst = counting.snapshot().statements;
        expect(afterFirst).toBeGreaterThan(0);

        expect(resolveInode(operationDb, "/alias/file")?.type).toBe("file");
        expect(statementDelta(counting, afterFirst)).toBeGreaterThan(0);
      });
    });
  });
});

describe("provider operation views", () => {
  it("swaps only the database view and shares provider file-descriptor state", async () => {
    await withDB(async (db) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW, watchIntervalMs: 7 });
      provider.writeFileSync("/file", "hello");
      const fd = provider.openSync("/file", "r");

      await withProviderOperation(provider, async (operationProvider: SQLiteWorkspaceProvider) => {
        expectTypeOf(operationProvider).toEqualTypeOf<SQLiteWorkspaceProvider>();
        expect(operationProvider).not.toBe(provider);
        expect(operationProvider.db).not.toBe(db);
        expect(operationProvider.now).toBe(provider.now);
        expect(operationProvider.watchIntervalMs).toBe(7);

        const first = Buffer.alloc(2);
        expect(operationProvider.readSync(fd, first, 0, 2, null)).toBe(2);
        expect(first.toString()).toBe("he");
      });

      const second = Buffer.alloc(2);
      expect(provider.readSync(fd, second, 0, 2, null)).toBe(2);
      expect(second.toString()).toBe("ll");
      provider.closeSync(fd);
    });
  });
});
