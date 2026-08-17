import { describe, expect, expectTypeOf, it } from "vitest";

import { CountingStorage } from "../bench/counting-storage.js";
import type * as publicApi from "../index.js";
import { initializeSchema } from "../schema/index.js";
import { Database, type Database as DatabaseType, isDatabaseOperationView } from "../storage.js";
import { SQLiteTestStorage } from "../testing.js";
import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "../types.js";
import { mkdir } from "./mkdir.js";
import { readdir } from "./readdir.js";
import { readFile } from "./readFile.js";
import { resolveInode } from "./resolve.js";
import { stat } from "./stat.js";
import { withDB } from "./with-db.js";
import {
  DEFAULT_WRITE_BATCH_LIMITS,
  flushWriteBatchSync,
  withWriteBatchSync,
} from "./writeBatch.js";
import { writeFileSync } from "./writeFile.js";

const NOW = (): number => 1000;
const encoder = new TextEncoder();

type AssertFalse<Value extends false> = Value;

const batchIsInternal: AssertFalse<
  "withWriteBatchSync" extends keyof typeof publicApi ? true : false
> = false;
const flushIsInternal: AssertFalse<
  "flushWriteBatchSync" extends keyof typeof publicApi ? true : false
> = false;

interface ExecutedStatement {
  bindings: unknown[];
  query: string;
}

class InspectingStorage implements DurableObjectStorageLike {
  readonly statements: ExecutedStatement[] = [];
  readonly sql: SQLStorageLike;
  transactionCalls = 0;

  constructor(private readonly inner: SQLiteTestStorage) {
    this.sql = {
      exec: <Row extends object = Record<string, unknown>>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> => {
        this.statements.push({ query, bindings: [...bindings] });
        return this.inner.sql.exec<Row>(query, ...bindings);
      },
    };
  }

  transactionSync<T>(closure: () => T): T {
    this.transactionCalls += 1;
    return this.inner.transactionSync(closure);
  }

  reset(): void {
    this.statements.length = 0;
    this.transactionCalls = 0;
  }
}

async function withInspectingDatabase<T>(
  run: (db: DatabaseType, storage: InspectingStorage) => T | Promise<T>,
): Promise<T> {
  const inner = new SQLiteTestStorage();
  const storage = new InspectingStorage(inner);
  const db = new Database(storage);
  initializeSchema(db, NOW);
  storage.reset();
  try {
    return await run(db, storage);
  } finally {
    inner.close();
  }
}

async function withCountingDatabase<T>(
  run: (db: DatabaseType, counting: CountingStorage) => T | Promise<T>,
): Promise<T> {
  const inner = new SQLiteTestStorage();
  const counting = new CountingStorage(inner);
  const db = new Database(counting);
  initializeSchema(db, NOW);
  counting.reset();
  try {
    return await run(db, counting);
  } finally {
    inner.close();
  }
}

function prepareDirectory(db: DatabaseType, path = "/ready"): number {
  mkdir(db, path, {}, NOW);
  const inode = resolveInode(db, path)?.inode;
  if (inode === undefined) throw new Error(`fixture directory is missing: ${path}`);
  return inode;
}

function childCount(db: DatabaseType, parentInode: number): number {
  return (
    db.scalar<number>("SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?", parentInode) ?? 0
  );
}

function childNames(db: DatabaseType, parentInode: number): string[] {
  return db
    .all<{ name: string }>(
      "SELECT name FROM vfs_dirents WHERE parent_inode = ? ORDER BY name",
      parentInode,
    )
    .map((row) => row.name);
}

function writeText(db: DatabaseType, path: string, content: string): void {
  writeFileSync(db, path, encoder.encode(content), {}, NOW);
}

function jsonArrayLength(value: unknown): number {
  if (typeof value !== "string") throw new Error("metadata page is not JSON text");
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded)) throw new Error("metadata page is not a JSON array");
  return decoded.length;
}

const THEN_METHOD = "then";

class ProbeThenable implements PromiseLike<string> {
  called = false;

  [THEN_METHOD]<TResult1 = string, TResult2 = never>(
    _onfulfilled?: ((value: string) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.called = true;
    return Promise.reject(new Error("write batch must not assimilate a PromiseLike"));
  }
}

describe("synchronous write batches", () => {
  it("keeps the seam internal and preserves synchronous callback types", async () => {
    expect(batchIsInternal).toBe(false);
    expect(flushIsInternal).toBe(false);
    expect(DEFAULT_WRITE_BATCH_LIMITS).toEqual({
      maxBytes: 4 * 1024 * 1024,
      maxFiles: 1024,
      maxBlobRowsPerStatement: 50,
    });

    await withDB(async (db) => {
      const result = withWriteBatchSync(db, (batchDb: DatabaseType) => {
        expectTypeOf(batchDb).toEqualTypeOf<DatabaseType>();
        return 42;
      });

      expectTypeOf(result).toEqualTypeOf<number>();
      expect(result).toBe(42);
    });
  });

  it("runs the callback and final flush in one transaction, then closes its view", async () => {
    await withInspectingDatabase((db, storage) => {
      const parentInode = prepareDirectory(db);
      storage.reset();
      let escaped: DatabaseType | undefined;

      const result = withWriteBatchSync(db, (batchDb: DatabaseType) => {
        escaped = batchDb;
        expect(batchDb).not.toBe(db);
        expect(isDatabaseOperationView(batchDb)).toBe(true);
        expect(batchDb.inTransaction).toBe(true);
        writeText(batchDb, "/ready/file.txt", "content");
        return "done";
      });

      expect(result).toBe("done");
      expect(storage.transactionCalls).toBe(1);
      expect(childNames(db, parentInode)).toEqual(["file.txt"]);
      const closed = escaped;
      if (closed === undefined) throw new Error("batch callback did not run");
      expect(() => closed.scalar<number>("SELECT 1")).toThrowError("Database operation is closed");
      expect(db.scalar<number>("SELECT 1")).toBe(1);
    });
  });

  it("keeps staged rows out of raw SQL until flush and rolls a flushed batch back", async () => {
    await withDB(async (db) => {
      const parentInode = prepareDirectory(db);
      const rollback = new Error("roll back batch");

      expect(() =>
        withWriteBatchSync(db, (batchDb: DatabaseType) => {
          writeText(batchDb, "/ready/a.txt", "a");
          writeText(batchDb, "/ready/b.txt", "b");
          expect(childCount(batchDb, parentInode)).toBe(0);
          expect(childCount(db, parentInode)).toBe(0);

          flushWriteBatchSync(batchDb);
          expect(childCount(batchDb, parentInode)).toBe(2);
          expect(childCount(db, parentInode)).toBe(2);
          throw rollback;
        }),
      ).toThrow(rollback);

      expect(childCount(db, parentInode)).toBe(0);
      withWriteBatchSync(db, (batchDb: DatabaseType) => {
        writeText(batchDb, "/ready/recovered.txt", "ok");
      });
      expect(childNames(db, parentInode)).toEqual(["recovered.txt"]);
    });
  });

  it("rejects PromiseLike callbacks synchronously, rolls back, and closes the view", async () => {
    await withDB(async (db) => {
      const parentInode = prepareDirectory(db);
      const thenable = new ProbeThenable();
      let escaped: DatabaseType | undefined;

      expect(() =>
        withWriteBatchSync(db, (batchDb: DatabaseType): PromiseLike<string> => {
          escaped = batchDb;
          writeText(batchDb, "/ready/async.txt", "not committed");
          return thenable;
        }),
      ).toThrowError("Database write batch callback must be synchronous");

      expect(thenable.called).toBe(false);
      expect(childCount(db, parentInode)).toBe(0);
      const closed = escaped;
      if (closed === undefined) throw new Error("batch callback did not run");
      expect(() => closed.scalar<number>("SELECT 1")).toThrowError("Database operation is closed");
    });
  });

  it("restores a nested savepoint checkpoint while the outer batch stays open", async () => {
    await withInspectingDatabase((db, storage) => {
      const parentInode = prepareDirectory(db);
      storage.reset();
      const nestedFailure = new Error("nested batch failed");

      withWriteBatchSync(db, (outer: DatabaseType) => {
        writeText(outer, "/ready/outer-a.txt", "a");

        expect(() =>
          withWriteBatchSync(outer, (inner: DatabaseType) => {
            expect(inner).toBe(outer);
            writeText(inner, "/ready/inner.txt", "inner");
            flushWriteBatchSync(inner);
            throw nestedFailure;
          }),
        ).toThrow(nestedFailure);

        expect(childCount(db, parentInode)).toBe(0);
        writeText(outer, "/ready/outer-b.txt", "b");
      });

      expect(childNames(db, parentInode)).toEqual(["outer-a.txt", "outer-b.txt"]);
      expect(
        storage.statements.some((statement) => statement.query.trimStart().startsWith("SAVEPOINT")),
      ).toBe(true);
      expect(
        storage.statements.some((statement) =>
          statement.query.trimStart().startsWith("ROLLBACK TO"),
        ),
      ).toBe(true);
    });
  });

  it("rejects an overlapping sibling batch opened from the root view", async () => {
    await withDB(async (db) => {
      prepareDirectory(db);
      let siblingRan = false;

      withWriteBatchSync(db, (outer: DatabaseType) => {
        expect(() =>
          withWriteBatchSync(db, () => {
            siblingRan = true;
          }),
        ).toThrowError("Database write batch is already active");
        writeText(outer, "/ready/outer.txt", "outer");
      });

      expect(siblingRan).toBe(false);
      expect(resolveInode(db, "/ready/outer.txt")?.size).toBe(5);
    });
  });

  it("flushes all staged creates before metadata and directory reads", async () => {
    await withDB(async (db) => {
      const parentInode = prepareDirectory(db);

      withWriteBatchSync(db, (batchDb: DatabaseType) => {
        writeText(batchDb, "/ready/a.txt", "alpha");
        writeText(batchDb, "/ready/b.txt", "bravo");
        expect(childCount(db, parentInode)).toBe(0);

        expect(stat(batchDb, "/ready/a.txt").size).toBe(5);
        expect(childCount(db, parentInode)).toBe(2);

        writeText(batchDb, "/ready/c.txt", "charlie");
        expect(childCount(db, parentInode)).toBe(2);
        expect(
          readdir(batchDb, "/ready")
            .map((entry) => entry.name)
            .sort(),
        ).toEqual(["a.txt", "b.txt", "c.txt"]);
        expect(childCount(db, parentInode)).toBe(3);
      });
    });
  });

  it("only stages creates whose parent directory already has a SQL row", async () => {
    await withDB(async (db) => {
      const parentInode = prepareDirectory(db);

      withWriteBatchSync(db, (batchDb: DatabaseType) => {
        expect(() => writeText(batchDb, "/missing/file.txt", "no parent")).toThrowError(
          expect.objectContaining({ code: "ENOENT" }),
        );
        writeText(batchDb, "/ready/file.txt", "valid");
      });

      expect(childNames(db, parentInode)).toEqual(["file.txt"]);
      expect(resolveInode(db, "/missing")).toBeNull();
    });
  });

  it("copies caller-owned input before returning from a staged write", async () => {
    await withDB(async (db) => {
      prepareDirectory(db);
      const bytes = encoder.encode("original");

      withWriteBatchSync(db, (batchDb: DatabaseType) => {
        writeFileSync(batchDb, "/ready/file.txt", bytes, {}, NOW);
        bytes.fill(0);
      });

      expect(await readFile(db, "/ready/file.txt", "utf8")).toBe("original");
    });
  });

  it("auto-flushes independently at configured file and byte bounds", async () => {
    await withDB(async (db) => {
      const parentInode = prepareDirectory(db);

      withWriteBatchSync(
        db,
        (batchDb: DatabaseType) => {
          writeText(batchDb, "/ready/a.txt", "aa");
          expect(childCount(db, parentInode)).toBe(0);
          writeText(batchDb, "/ready/b.txt", "bb");
          expect(childCount(db, parentInode)).toBe(2);
        },
        { maxBytes: 100, maxFiles: 2 },
      );

      withWriteBatchSync(
        db,
        (batchDb: DatabaseType) => {
          writeText(batchDb, "/ready/c.txt", "ccc");
          expect(childCount(db, parentInode)).toBe(2);
          writeText(batchDb, "/ready/d.txt", "ddd");
          expect(childCount(db, parentInode)).toBe(4);
        },
        { maxBytes: 5, maxFiles: 10 },
      );

      expect(childNames(db, parentInode)).toEqual(["a.txt", "b.txt", "c.txt", "d.txt"]);
    });
  });

  it("caps blob payload inserts at 50 distinct rows per statement", async () => {
    await withInspectingDatabase((db, storage) => {
      prepareDirectory(db);
      storage.reset();

      withWriteBatchSync(db, (batchDb: DatabaseType) => {
        for (let index = 0; index < 51; index += 1) {
          writeText(batchDb, `/ready/file-${index}.txt`, `unique payload ${index}`);
        }
      });

      const payloadInserts = storage.statements.filter((statement) =>
        statement.query.includes("INSERT INTO vfs_blob_bytes"),
      );
      expect(payloadInserts.map((statement) => statement.bindings.length)).toEqual([100, 2]);
    });
  });

  it("pages metadata through one JSON bind per statement", async () => {
    await withInspectingDatabase((db, storage) => {
      prepareDirectory(db);
      storage.reset();

      withWriteBatchSync(
        db,
        (batchDb: DatabaseType) => {
          for (let index = 0; index < 5; index += 1) {
            writeText(batchDb, `/ready/file-${index}.txt`, `content ${index}`);
          }
        },
        { metadataRowsPerPage: 2 },
      );

      for (const table of [
        "vfs_nodes",
        "vfs_dirents",
        "vfs_blobs",
        "vfs_chunks",
        "vfs_manifests",
      ]) {
        const pages = storage.statements.filter(
          (statement) =>
            statement.query.includes(`INSERT INTO ${table}`) &&
            statement.query.includes("json_each"),
        );
        expect(
          pages.map((statement) => statement.bindings.length),
          table,
        ).toEqual([1, 1, 1]);
        expect(
          pages.map((statement) => jsonArrayLength(statement.bindings[0])),
          table,
        ).toEqual([2, 2, 1]);
      }
    });
  });

  it("does not pay one SQL transaction per staged create", async () => {
    await withCountingDatabase((db, counting) => {
      prepareDirectory(db);
      counting.reset();

      withWriteBatchSync(db, (batchDb: DatabaseType) => {
        for (let index = 0; index < 10; index += 1) {
          writeText(batchDb, `/ready/file-${index}.txt`, `content ${index}`);
        }
      });

      expect(counting.snapshot().statements).toBeLessThan(40);
    });
  });
});
