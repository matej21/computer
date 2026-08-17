import { describe, expect, it } from "vitest";

import { CountingStorage } from "./bench/counting-storage.js";
import { clearBlobCache } from "./fs/blobCache.js";
import { getReadOnlyMountRoots, invalidateReadOnlyMountCache } from "./fs/mount-guard.js";
import { resolveInode } from "./fs/resolve.js";
import { withDB } from "./fs/with-db.js";
import { deleteWriteBuffer, getWriteBuffer } from "./fs/writeBuffer.js";
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
import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "./types.js";

const NOW = (): number => 1000;

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

class FailingSavepointStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike;

  constructor(
    private readonly inner: SQLiteTestStorage,
    private readonly failingControl: string,
  ) {
    this.sql = {
      exec: <Row extends object = Record<string, unknown>>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> => {
        const cursor = this.inner.sql.exec<Row>(query, ...bindings);
        if (query.trimStart().startsWith(this.failingControl)) {
          throw new Error(`${this.failingControl} failed after reaching storage`);
        }
        return cursor;
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    return this.inner.transactionSync(closure);
  }
}

async function withFailingSavepointDatabase<T>(
  failingControl: string,
  run: (db: Database) => T | Promise<T>,
): Promise<T> {
  const storage = new SQLiteTestStorage();
  const db = new DatabaseConstructor(new FailingSavepointStorage(storage, failingControl));
  initializeSchema(db, NOW);
  try {
    return await run(db);
  } finally {
    storage.close();
  }
}

const THEN_METHOD = "then";

class DeferredThenable<T> implements PromiseLike<T> {
  readonly #promise: Promise<T>;
  #resolve: ((value: T | PromiseLike<T>) => void) | undefined;

  constructor() {
    this.#promise = new Promise<T>((resolve) => {
      this.#resolve = resolve;
    });
  }

  [THEN_METHOD]<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.#promise.then(onfulfilled, onrejected);
  }

  settle(value: T): void {
    const resolve = this.#resolve;
    if (resolve === undefined) throw new Error("thenable resolver is unavailable");
    resolve(value);
  }
}

type ProviderWatcher = ReturnType<SQLiteWorkspaceProvider["watch"]>;

function nextWatchEvent(
  watcher: ProviderWatcher,
  timeoutMs = 1000,
): Promise<{ eventType: "rename" | "change"; filename: string }> {
  return new Promise((resolve, reject) => {
    const onChange = (eventType: "rename" | "change", filename: string): void => {
      cleanup();
      resolve({ eventType, filename });
    };
    const onError = (error: unknown): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      watcher.off("change", onChange);
      watcher.off("error", onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for operation watcher event"));
    }, timeoutMs);
    watcher.on("change", onChange);
    watcher.on("error", onError);
  });
}

function includesError(error: unknown, expected: Error): boolean {
  if (error === expected) return true;
  if (error instanceof AggregateError) {
    const nested: unknown[] = error.errors;
    return nested.some((item) => includesError(item, expected));
  }
  if (error instanceof Error && error.cause !== undefined) {
    return includesError(error.cause, expected);
  }
  return false;
}

describe("provider operation semantic state", () => {
  it("shares a dirty existing-file buffer across operation and root releases", async () => {
    await withDB(async (db) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
      provider.writeFileSync("/file", "initial");
      provider.openWriteBufferSync("/file");
      provider.writeRangeSync("/file", "ROOTIAL", 0);

      withProviderOperation(provider, (operationProvider: SQLiteWorkspaceProvider) => {
        expect(operationProvider.readFileSync("/file", "utf8")).toBe("ROOTIAL");
        operationProvider.writeRangeSync("/file", "UPDATED", 0);
        operationProvider.releaseWriteBufferSync("/file");
      });

      provider.releaseWriteBufferSync("/file");
      expect(provider.readFileSync("/file", "utf8")).toBe("UPDATED");
    });
  });

  it("shares a pending-create buffer and commits its latest bytes once", async () => {
    await withDB(async (db) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
      provider.openWriteBufferForCreateSync("/pending", { mode: 0o600 });
      provider.writeRangeSync("/pending", "root", 0);

      withProviderOperation(provider, (operationProvider: SQLiteWorkspaceProvider) => {
        expect(operationProvider.readFileSync("/pending", "utf8")).toBe("root");
        operationProvider.writeRangeSync("/pending", "operation", 0);
        operationProvider.releaseWriteBufferSync("/pending");
      });

      provider.releaseWriteBufferSync("/pending");
      expect(provider.readFileSync("/pending", "utf8")).toBe("operation");
      expect(provider.statSync("/pending").mode & 0o777).toBe(0o600);
    });
  });

  it("shares the blob payload cache between root and operation views", async () => {
    await withCountingDatabase((db, counting) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
      provider.writeFileSync("/file", "cached payload");
      clearBlobCache(db);
      expect(provider.readFileSync("/file", "utf8")).toBe("cached payload");
      counting.reset();

      withProviderOperation(provider, (operationProvider: SQLiteWorkspaceProvider) => {
        expect(operationProvider.readFileSync("/file", "utf8")).toBe("cached payload");
      });

      expect(counting.snapshot().statements).toBe(2);
    });
  });

  it("shares the read-only mount cache and guard with the root view", async () => {
    await withCountingDatabase((db, counting) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
      db.run(
        "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, ?, 1, 'read-only')",
        "/readonly",
        "test",
      );
      invalidateReadOnlyMountCache(db);
      expect(getReadOnlyMountRoots(db)).toEqual(["/readonly"]);
      counting.reset();

      withProviderOperation(provider, (operationProvider: SQLiteWorkspaceProvider) => {
        expect(getReadOnlyMountRoots(operationProvider.db)).toEqual(["/readonly"]);
        expect(() => operationProvider.writeFileSync("/readonly/new", "blocked")).toThrowError(
          expect.objectContaining({ code: "EROFS" }),
        );
      });

      expect(counting.snapshot().statements).toBe(0);
    });
  });

  it("lets an operation commit hook clean up the root write buffer", async () => {
    await withDB(async (db) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
      provider.writeFileSync("/file", "initial");
      provider.openWriteBufferSync("/file");
      provider.writeRangeSync("/file", "DIRTIED", 0);
      const inode = resolveInode(db, "/file")?.inode;
      if (inode === undefined) throw new Error("fixture inode missing");

      withProviderOperation(provider, (operationProvider: SQLiteWorkspaceProvider) => {
        operationProvider.db.transactionSync(() => {
          afterOutermostCommit(operationProvider.db, () => {
            operationProvider.releaseWriteBufferSync("/file");
          });
        });
      });

      expect(getWriteBuffer(db, inode) === undefined).toBe(true);
      expect(provider.readFileSync("/file", "utf8")).toBe("DIRTIED");
    });
  });

  it("runs operation cleanup after a surrounding root transaction commits", async () => {
    await withDB(async (db) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
      provider.writeFileSync("/file", "initial");
      provider.openWriteBufferSync("/file");
      provider.writeRangeSync("/file", "DIRTIED", 0);
      const inode = resolveInode(db, "/file")?.inode;
      if (inode === undefined) throw new Error("fixture inode missing");

      let escaped: SQLiteWorkspaceProvider | undefined;
      db.transactionSync(() => {
        withProviderOperation(provider, (operationProvider: SQLiteWorkspaceProvider) => {
          escaped = operationProvider;
          afterOutermostCommit(operationProvider.db, () => {
            deleteWriteBuffer(operationProvider.db, inode);
          });
        });

        const closedProvider = escaped;
        if (closedProvider === undefined) throw new Error("operation callback did not run");
        expect(() => closedProvider.statSync("/file")).toThrowError("Database operation is closed");
        expect(getWriteBuffer(db, inode)).toBeDefined();
      });

      expect(getWriteBuffer(db, inode)).toBeUndefined();
    });
  });
});

describe("provider operation watcher lifetime", () => {
  it("keeps a returned watcher functional after the operation callback settles", async () => {
    await withDB(async (db) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW, watchIntervalMs: 10 });
      provider.mkdirSync("/watched");
      const watcher = withProviderOperation(
        provider,
        (operationProvider: SQLiteWorkspaceProvider) =>
          operationProvider.watch("/watched", { interval: 10 }),
      );

      try {
        const event = nextWatchEvent(watcher);
        provider.writeFileSync("/watched/file", "content");
        await expect(event).resolves.toEqual({ eventType: "change", filename: "file" });
      } finally {
        watcher.close();
      }
    });
  });

  it("keeps created handles alive but rejects calls through the escaped provider", async () => {
    await withDB(async (db) => {
      const provider = new SQLiteWorkspaceProvider(db, { now: NOW, watchIntervalMs: 10 });
      provider.writeFileSync("/file", "hello");
      provider.mkdirSync("/watched");

      let escaped: SQLiteWorkspaceProvider | undefined;
      let fd: number | undefined;
      let watcher: ProviderWatcher | undefined;
      withProviderOperation(provider, (operationProvider: SQLiteWorkspaceProvider) => {
        escaped = operationProvider;
        fd = operationProvider.openSync("/file", "r+");
        watcher = operationProvider.watch("/watched", { interval: 10 });
      });

      const closedProvider = escaped;
      const openFd = fd;
      const openWatcher = watcher;
      if (closedProvider === undefined || openFd === undefined || openWatcher === undefined) {
        throw new Error("operation handles were not created");
      }

      let lateWatcher: ProviderWatcher | undefined;
      try {
        provider.writeSync(openFd, Buffer.from("HELLO"), 0, 5, 0);
        const bytes = Buffer.alloc(5);
        expect(provider.readSync(openFd, bytes, 0, 5, 0)).toBe(5);
        expect(bytes.toString()).toBe("HELLO");

        const event = nextWatchEvent(openWatcher);
        provider.writeFileSync("/watched/event", "content");
        await expect(event).resolves.toEqual({ eventType: "change", filename: "event" });

        expect
          .soft(() => closedProvider.statSync("/file"))
          .toThrowError("Database operation is closed");
        expect
          .soft(() => {
            lateWatcher = closedProvider.watch("/watched", { interval: 10 });
          })
          .toThrowError("Database operation is closed");
        expect
          .soft(() => closedProvider.readSync(openFd, Buffer.alloc(1), 0, 1, 0))
          .toThrowError("Database operation is closed");
        expect
          .soft(() => closedProvider.writeSync(openFd, Buffer.from("WORLD"), 0, 5, 0))
          .toThrowError("Database operation is closed");
        expect
          .soft(() => closedProvider.fstatSync(openFd))
          .toThrowError("Database operation is closed");
        expect
          .soft(() => closedProvider.ftruncateSync(openFd, 5))
          .toThrowError("Database operation is closed");
        expect
          .soft(() => closedProvider.closeSync(openFd))
          .toThrowError("Database operation is closed");
      } finally {
        lateWatcher?.close();
        openWatcher.close();
        try {
          provider.closeSync(openFd);
        } catch {
          // The rejected implementation closes the shared descriptor through the escaped view.
        }
      }
    });
  });
});

describe("transaction callback failures", () => {
  it("runs every commit callback after commit and reports callback failure", async () => {
    await withDB(async (db) => {
      const callbackError = new Error("commit callback failed");
      const events: string[] = [];
      let observed: unknown;

      try {
        db.transactionSync(() => {
          db.run("INSERT INTO vfs_meta (k, v) VALUES ('callback_probe', 1)");
          afterOutermostCommit(db, () => {
            events.push("first");
            expect(db.inTransaction).toBe(false);
            throw callbackError;
          });
          afterOutermostCommit(db, () => {
            events.push("second");
          });
        });
      } catch (error) {
        observed = error;
      }

      expect(events).toEqual(["first", "second"]);
      expect(includesError(observed, callbackError)).toBe(true);
      expect(db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'callback_probe'")).toBe(1);
    });
  });

  it("runs every rollback callback without replacing the transaction error", async () => {
    await withDB(async (db) => {
      const transactionError = new Error("transaction failed");
      const callbackError = new Error("rollback callback failed");
      const events: string[] = [];
      let observed: unknown;

      try {
        db.transactionSync(() => {
          afterOutermostRollback(db, () => {
            events.push("first");
            expect(db.inTransaction).toBe(false);
            throw callbackError;
          });
          afterOutermostRollback(db, () => {
            events.push("second");
          });
          throw transactionError;
        });
      } catch (error) {
        observed = error;
      }

      expect(events).toEqual(["first", "second"]);
      expect(observed).toBe(transactionError);
    });
  });
});

for (const failingControl of ["ROLLBACK TO", "RELEASE"]) {
  describe(`${failingControl} failure callback isolation`, () => {
    it("does not leak nested commit callbacks into the outer commit", async () => {
      await withFailingSavepointDatabase(failingControl, (db) => {
        const events: string[] = [];

        db.transactionSync(() => {
          try {
            db.transactionSync(() => {
              afterOutermostCommit(db, () => events.push("nested commit"));
              afterOutermostRollback(db, () => events.push("nested rollback"));
              if (failingControl === "ROLLBACK TO") throw new Error("nested body failed");
            });
          } catch {
            events.push("nested failed");
          }
          afterOutermostCommit(db, () => events.push("outer commit"));
        });

        expect(events).toEqual(["nested failed", "outer commit"]);
      });
    });

    it("does not leak nested rollback callbacks into the outer rollback", async () => {
      await withFailingSavepointDatabase(failingControl, (db) => {
        const outerError = new Error("outer transaction failed");
        const events: string[] = [];
        let observed: unknown;

        try {
          db.transactionSync(() => {
            try {
              db.transactionSync(() => {
                afterOutermostCommit(db, () => events.push("nested commit"));
                afterOutermostRollback(db, () => events.push("nested rollback"));
                if (failingControl === "ROLLBACK TO") throw new Error("nested body failed");
              });
            } catch {
              events.push("nested failed");
            }
            afterOutermostRollback(db, () => events.push("outer rollback"));
            throw outerError;
          });
        } catch (error) {
          observed = error;
        }

        expect(observed).toBe(outerError);
        expect(events).toEqual(["nested failed", "outer rollback"]);
      });
    });
  });
}

describe("thenable operation lifetime", () => {
  it("keeps a PromiseLike result open through settlement and returns a native Promise", async () => {
    await withDB(async (db) => {
      const deferred = new DeferredThenable<string>();
      let escaped: Database | undefined;
      const result: Promise<string> = withDatabaseOperation(
        db,
        (operationDb: Database): PromiseLike<string> => {
          escaped = operationDb;
          return deferred;
        },
      );

      const openView = escaped;
      if (openView === undefined) throw new Error("operation callback did not run");
      expect(resolveInode(openView, "/")?.type).toBe("dir");

      deferred.settle("settled");
      await expect(result).resolves.toBe("settled");
      expect(() => resolveInode(openView, "/")).toThrowError("Database operation is closed");
    });
  });
});
