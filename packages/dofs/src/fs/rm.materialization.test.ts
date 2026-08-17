import { expect, it } from "vitest";

import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SQLiteTestStorage } from "../testing.js";
import type { DurableObjectStorageLike, SQLCursorLike, SQLStorageLike } from "../types.js";
import { mkdir } from "./mkdir.js";
import { resolveInode } from "./resolve.js";
import { rm } from "./rm.js";

const MAX_MATERIALIZED_ROWS = 10_000;
const DESCENDANTS = MAX_MATERIALIZED_ROWS + 1;
const NOW = (): number => 0;

class MaterializationLimitStorage implements DurableObjectStorageLike {
  readonly sql: SQLStorageLike;
  readonly transactionSync?: <T>(closure: () => T) => T;
  readonly transaction?: <T>(closure: () => T | Promise<T>) => T | Promise<T>;

  constructor(inner: DurableObjectStorageLike, maxRows: number) {
    this.sql = {
      exec: <Row extends object = Record<string, unknown>>(
        query: string,
        ...bindings: unknown[]
      ): SQLCursorLike<Row> => {
        const cursor = inner.sql.exec<Row>(query, ...bindings);
        return {
          toArray: (): Row[] => {
            const rows = cursor.toArray();
            if (rows.length > maxRows) {
              throw new Error(`SQL cursor materialized ${rows.length} rows; limit is ${maxRows}`);
            }
            return rows;
          },
        };
      },
    };

    if (inner.transactionSync !== undefined) {
      const delegate = inner.transactionSync.bind(inner);
      this.transactionSync = <T>(closure: () => T): T => delegate(closure);
    }
    if (inner.transaction !== undefined) {
      const delegate = inner.transaction.bind(inner);
      this.transaction = <T>(closure: () => T | Promise<T>): T | Promise<T> => delegate(closure);
    }
  }
}

function seedWideTree(db: Database): void {
  mkdir(db, "/tree", {}, NOW);
  const treeInode = resolveInode(db, "/tree")?.inode;
  if (treeInode === undefined) throw new Error("fixture tree inode is missing");
  const firstInode = (db.scalar<number>("SELECT COALESCE(MAX(inode), 0) FROM vfs_nodes") ?? 0) + 1;

  db.transactionSync(() => {
    db.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value + 1 < ?
       )
       INSERT INTO vfs_nodes (type, mode, mtime, rev, size)
       SELECT 'file', ?, 0, 0, 0 FROM sequence`,
      DESCENDANTS,
      0o644,
    );
    db.run(
      `INSERT INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT ?, printf('f%05d', inode - ?), inode
         FROM vfs_nodes
        WHERE inode >= ?
        ORDER BY inode`,
      treeInode,
      firstInode,
      firstInode,
    );
  });
}

it("bounds recursive subtree discovery to one delete page", () => {
  const storage = new SQLiteTestStorage();
  const limited = new MaterializationLimitStorage(storage, MAX_MATERIALIZED_ROWS);
  const db = new Database(limited);
  initializeSchema(db, NOW);

  try {
    seedWideTree(db);

    expect(() => rm(db, "/tree", { recursive: true })).not.toThrow();
    expect(resolveInode(db, "/tree")).toBeNull();
  } finally {
    storage.close();
  }
});
