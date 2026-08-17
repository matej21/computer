import { describe, expect, it } from "vitest";

import type { Database } from "../storage.js";
import { link } from "./link.js";
import { mkdir } from "./mkdir.js";
import { readdir } from "./readdir.js";
import { readFile } from "./readFile.js";
import { resolveInode } from "./resolve.js";
import { rm } from "./rm.js";
import { symlink } from "./symlink.js";
import { withDB } from "./with-db.js";
import { listPendingWriteBuffers } from "./writeBuffer.js";
import {
  openWriteBufferForCreateSync,
  openWriteBufferSync,
  releaseWriteBufferSync,
  writeFile,
  writeRangeSync,
} from "./writeFile.js";

interface ChangeRow {
  rev: number;
  path: string;
  op: string;
}

function listChanges(db: Database): ChangeRow[] {
  return db.all<ChangeRow>("SELECT rev, path, op FROM vfs_changes ORDER BY rev");
}

function countBlobs(db: Database): number {
  return db.scalar<number>("SELECT COUNT(*) FROM vfs_blobs") ?? 0;
}

describe("rm", () => {
  it("removes a single file", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hi", {}, () => 0);
      rm(db, "/a.txt", {});
      expect(resolveInode(db, "/a.txt")).toBeNull();
      expect(readdir(db, "/")).toEqual([]);
    });
  });

  it("records a tombstone for the removed path", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hi", {}, () => 0);
      rm(db, "/a.txt", {});
      expect(listChanges(db)).toEqual([expect.objectContaining({ path: "/a.txt", op: "delete" })]);
    });
  });

  it("records tombstones at the resolved path through intermediate symlinks", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real", {}, () => 0);
      await writeFile(db, "/real/file.txt", "content", {}, () => 0);
      symlink(db, "/real", "/link", () => 0);

      rm(db, "/link/file.txt", {});

      expect(listChanges(db)).toContainEqual(
        expect.objectContaining({ path: "/real/file.txt", op: "delete" }),
      );
      expect(listChanges(db)).not.toContainEqual(
        expect.objectContaining({ path: "/link/file.txt", op: "delete" }),
      );
    });
  });

  it("bumps rev once per call", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hi", {}, () => 0);
      const before = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
      rm(db, "/a.txt", {});
      const after = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
      expect(after).toBe(before + 1);
    });
  });

  it("leaves orphan blob rows alive for gc()", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "unique-content", {}, () => 0);
      const before = countBlobs(db);
      expect(before).toBe(1);
      rm(db, "/a.txt", {});
      expect(countBlobs(db)).toBe(1);
    });
  });

  it("removes a symlink itself rather than its target", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/target.txt", "still here", {}, () => 0);
      symlink(db, "/target.txt", "/link.txt", () => 0);

      rm(db, "/link.txt", {});

      expect(resolveInode(db, "/link.txt", { followSymlinks: false })).toBeNull();
      expect(resolveInode(db, "/target.txt")).not.toBeNull();
    });
  });

  it("recursive rm does not follow symlinks out of the removed tree", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/outside.txt", "still here", {}, () => 0);
      mkdir(db, "/d", {}, () => 0);
      symlink(db, "/outside.txt", "/d/link.txt", () => 0);

      rm(db, "/d", { recursive: true });

      expect(resolveInode(db, "/d", { followSymlinks: false })).toBeNull();
      expect(resolveInode(db, "/outside.txt")).not.toBeNull();
    });
  });

  it("removes a dangling symlink", async () => {
    await withDB((db) => {
      symlink(db, "/missing", "/dangling", () => 0);

      rm(db, "/dangling", {});

      expect(resolveInode(db, "/dangling", { followSymlinks: false })).toBeNull();
    });
  });

  it("rejects ENOENT for a missing path", async () => {
    await withDB((db) => {
      expect(() => rm(db, "/missing", {})).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
    });
  });

  it("force swallows ENOENT", async () => {
    await withDB((db) => {
      expect(() => rm(db, "/missing", { force: true })).not.toThrow();
      expect(listChanges(db)).toEqual([]);
    });
  });

  it("rejects EPERM on root", async () => {
    await withDB((db) => {
      expect(() => rm(db, "/", {})).toThrowError(expect.objectContaining({ code: "EPERM" }));
      expect(() => rm(db, "/", { recursive: true })).toThrowError(
        expect.objectContaining({ code: "EPERM" }),
      );
      expect(() => rm(db, "/", { recursive: true, force: true })).toThrowError(
        expect.objectContaining({ code: "EPERM" }),
      );
    });
  });

  it("removes an empty directory without recursive", async () => {
    await withDB((db) => {
      mkdir(db, "/d", {}, () => 0);
      rm(db, "/d", {});
      expect(resolveInode(db, "/d")).toBeNull();
    });
  });

  it("rejects ENOTEMPTY on a non-empty directory without recursive", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", {}, () => 0);
      await writeFile(db, "/d/a", "x", {}, () => 0);
      expect(() => rm(db, "/d", {})).toThrowError(expect.objectContaining({ code: "ENOTEMPTY" }));
    });
  });

  it("recursive removes a directory tree", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d/e/f", { recursive: true }, () => 0);
      await writeFile(db, "/d/a", "x", {}, () => 0);
      await writeFile(db, "/d/e/b", "y", {}, () => 0);
      await writeFile(db, "/d/e/f/c", "z", {}, () => 0);
      rm(db, "/d", { recursive: true });
      expect(resolveInode(db, "/d")).toBeNull();
      expect(resolveInode(db, "/d/a")).toBeNull();
      expect(resolveInode(db, "/d/e/f/c")).toBeNull();
      expect(readdir(db, "/")).toEqual([]);
    });
  });

  it("recursive removes a symlink to a directory without deleting its target", async () => {
    await withDB(async (db) => {
      mkdir(db, "/target/sub", { recursive: true }, () => 0);
      await writeFile(db, "/target/sub/file.txt", "content", {}, () => 0);
      symlink(db, "/target", "/link", () => 0);

      rm(db, "/link", { recursive: true });

      expect(resolveInode(db, "/link", { followSymlinks: false })).toBeNull();
      expect(await readFile(db, "/target/sub/file.txt", "utf8")).toBe("content");
    });
  });

  it("recursive records one tombstone per removed path", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", {}, () => 0);
      await writeFile(db, "/d/a", "x", {}, () => 0);
      await writeFile(db, "/d/b", "y", {}, () => 0);
      rm(db, "/d", { recursive: true });
      const paths = listChanges(db)
        .map((r) => r.path)
        .sort();
      expect(paths).toEqual(["/d", "/d/a", "/d/b"]);
    });
  });

  it("recursive records resolved subtree tombstones through intermediate symlinks", async () => {
    await withDB(async (db) => {
      mkdir(db, "/real/dir", { recursive: true }, () => 0);
      await writeFile(db, "/real/dir/a", "x", {}, () => 0);
      await writeFile(db, "/real/dir/b", "y", {}, () => 0);
      symlink(db, "/real", "/link", () => 0);

      rm(db, "/link/dir", { recursive: true });

      const paths = listChanges(db)
        .map((r) => r.path)
        .sort();
      expect(paths).toEqual(expect.arrayContaining(["/real/dir", "/real/dir/a", "/real/dir/b"]));
      expect(paths).not.toEqual(
        expect.arrayContaining(["/link/dir", "/link/dir/a", "/link/dir/b"]),
      );
    });
  });

  it("recursive still bumps rev only once for the whole tree", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", {}, () => 0);
      await writeFile(db, "/d/a", "x", {}, () => 0);
      await writeFile(db, "/d/b", "y", {}, () => 0);
      const before = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
      rm(db, "/d", { recursive: true });
      const after = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'") ?? 0;
      expect(after).toBe(before + 1);
    });
  });

  it("recursive cleans up chunk rows for removed files", async () => {
    await withDB(async (db) => {
      mkdir(db, "/d", {}, () => 0);
      await writeFile(db, "/d/a", "first", {}, () => 0);
      await writeFile(db, "/d/b", "second", {}, () => 0);
      rm(db, "/d", { recursive: true });
      const chunkRows = db.scalar<number>("SELECT COUNT(*) FROM vfs_chunks") ?? 0;
      expect(chunkRows).toBe(0);
    });
  });

  it("recursive keeps a file named by a hardlink outside the subtree", async () => {
    await withDB(async (db) => {
      mkdir(db, "/tree/inner", { recursive: true }, () => 0);
      await writeFile(db, "/tree/inner/shared", "shared bytes", {}, () => 0);
      await writeFile(db, "/tree/inner/only", "removed bytes", {}, () => 0);
      link(db, "/tree/inner/shared", "/kept");
      const sharedInode = resolveInode(db, "/kept")?.inode;

      rm(db, "/tree", { recursive: true });

      expect(resolveInode(db, "/tree", { followSymlinks: false })).toBeNull();
      expect(resolveInode(db, "/kept")?.inode).toBe(sharedInode);
      expect(await readFile(db, "/kept", "utf8")).toBe("shared bytes");
      expect(
        db.scalar<number>(
          "SELECT COUNT(*) FROM vfs_chunks WHERE inode NOT IN (SELECT child_inode FROM vfs_dirents)",
        ),
      ).toBe(0);
      const deletedPaths = listChanges(db)
        .filter((row) => row.op === "delete")
        .map((row) => row.path);
      expect(deletedPaths).toContain("/tree/inner/shared");
      expect(deletedPaths).not.toContain("/kept");
    });
  });

  it("recursive keeps a live write buffer when an outside hardlink survives", async () => {
    await withDB(async (db) => {
      mkdir(db, "/tree", {}, () => 0);
      await writeFile(db, "/tree/shared", "original", {}, () => 0);
      link(db, "/tree/shared", "/kept");
      openWriteBufferSync(db, "/kept");
      writeRangeSync(db, "/kept", new TextEncoder().encode("updated!"), 0, {}, () => 1);

      rm(db, "/tree", { recursive: true });
      releaseWriteBufferSync(db, "/kept", () => 2);

      expect(await readFile(db, "/kept", "utf8")).toBe("updated!");
    });
  });

  it("recursive removal rolls back every table when one node delete fails", async () => {
    await withDB(async (db) => {
      mkdir(db, "/tree/sub", { recursive: true }, () => 0);
      await writeFile(db, "/tree/a", "a", {}, () => 0);
      await writeFile(db, "/tree/sub/b", "b", {}, () => 0);
      const blockedInode = resolveInode(db, "/tree/sub/b")?.inode;
      if (blockedInode === undefined) throw new Error("fixture inode is missing");
      db.run(`CREATE TRIGGER fail_recursive_rm
        BEFORE DELETE ON vfs_nodes
        WHEN OLD.inode = ${blockedInode}
        BEGIN
          SELECT RAISE(ABORT, 'stop recursive rm');
        END`);
      const beforeRev = db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'");
      const beforeChanges = listChanges(db);

      expect(() => rm(db, "/tree", { recursive: true })).toThrow("stop recursive rm");

      expect(await readFile(db, "/tree/a", "utf8")).toBe("a");
      expect(await readFile(db, "/tree/sub/b", "utf8")).toBe("b");
      expect(db.scalar<number>("SELECT v FROM vfs_meta WHERE k = 'rev'")).toBe(beforeRev);
      expect(listChanges(db)).toEqual(beforeChanges);
    });
  });

  it("defers live-buffer cleanup until the outer transaction commits", async () => {
    await withDB(async (db) => {
      mkdir(db, "/tree", {}, () => 0);
      await writeFile(db, "/tree/live.txt", "original", {}, () => 0);
      openWriteBufferSync(db, "/tree/live.txt");
      writeRangeSync(db, "/tree/live.txt", new TextEncoder().encode("updated!"), 0, {}, () => 1);

      expect(() =>
        db.transactionSync(() => {
          rm(db, "/tree", { recursive: true });
          expect(resolveInode(db, "/tree/live.txt")).toBeNull();
          throw new Error("roll back outer transaction");
        }),
      ).toThrow("roll back outer transaction");

      expect(resolveInode(db, "/tree/live.txt")).not.toBeNull();
      expect(await readFile(db, "/tree/live.txt", "utf8")).toBe("updated!");
      releaseWriteBufferSync(db, "/tree/live.txt", () => 2);
      expect(await readFile(db, "/tree/live.txt", "utf8")).toBe("updated!");
    });
  });

  it("discards pending-create descendants only after recursive rm commits", async () => {
    await withDB(async (db) => {
      mkdir(db, "/tree", {}, () => 0);
      openWriteBufferForCreateSync(db, "/tree/pending.txt", {}, () => 0);
      writeRangeSync(
        db,
        "/tree/pending.txt",
        new TextEncoder().encode("pending bytes"),
        0,
        {},
        () => 1,
      );
      expect(listPendingWriteBuffers(db)).toHaveLength(1);

      rm(db, "/tree", { recursive: true });

      expect(listPendingWriteBuffers(db)).toHaveLength(0);
      await expect(readFile(db, "/tree/pending.txt", "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(() => releaseWriteBufferSync(db, "/tree/pending.txt", () => 2)).toThrowError(
        expect.objectContaining({ code: "ENOENT" }),
      );
      mkdir(db, "/tree", {}, () => 3);
      expect(resolveInode(db, "/tree/pending.txt")).toBeNull();
    });
  });

  it("restores pending-create descendants when an outer recursive rm rolls back", async () => {
    await withDB(async (db) => {
      mkdir(db, "/tree", {}, () => 0);
      openWriteBufferForCreateSync(db, "/tree/pending.txt", {}, () => 0);
      writeRangeSync(
        db,
        "/tree/pending.txt",
        new TextEncoder().encode("pending bytes"),
        0,
        {},
        () => 1,
      );

      expect(() =>
        db.transactionSync(() => {
          rm(db, "/tree", { recursive: true });
          throw new Error("roll back pending removal");
        }),
      ).toThrow("roll back pending removal");

      expect(listPendingWriteBuffers(db)).toHaveLength(1);
      expect(await readFile(db, "/tree/pending.txt", "utf8")).toBe("pending bytes");
      releaseWriteBufferSync(db, "/tree/pending.txt", () => 2);
      expect(await readFile(db, "/tree/pending.txt", "utf8")).toBe("pending bytes");
    });
  });

  it("recursive removes a subtree just beyond one delete page", async () => {
    await withDB((db) => {
      const descendants = 10_001;
      mkdir(db, "/tree", {}, () => 0);
      const treeInode = resolveInode(db, "/tree")?.inode;
      if (treeInode === undefined) throw new Error("fixture tree inode is missing");
      const firstInode = (db.scalar<number>("SELECT MAX(inode) FROM vfs_nodes") ?? 0) + 1;
      const inodes = Array.from({ length: descendants }, (_, index) => firstInode + index);
      const encodedInodes = JSON.stringify(inodes);
      db.run(
        `INSERT INTO vfs_nodes (inode, type, mode, mtime, rev, size)
         SELECT value, 'file', 420, 0, 0, 0 FROM json_each(?)`,
        encodedInodes,
      );
      db.run(
        `INSERT INTO vfs_dirents (parent_inode, name, child_inode)
         SELECT ?, printf('f%05d', key), value FROM json_each(?)`,
        treeInode,
        encodedInodes,
      );

      rm(db, "/tree", { recursive: true });

      expect(resolveInode(db, "/tree")).toBeNull();
      expect(
        db.scalar<number>(
          "SELECT COUNT(*) FROM vfs_nodes WHERE inode IN (SELECT value FROM json_each(?))",
          encodedInodes,
        ),
      ).toBe(0);
      expect(db.scalar<number>("SELECT COUNT(*) FROM vfs_changes WHERE path LIKE '/tree/%'")).toBe(
        descendants,
      );
    });
  });

  it("force is idempotent on missing intermediate segments", async () => {
    await withDB((db) => {
      expect(() => rm(db, "/no/such/path", { force: true })).not.toThrow();
    });
  });

  it("accepts recursive: false / force: false for node:fs/promises parity", async () => {
    await withDB(async (db) => {
      await writeFile(db, "/a.txt", "hello", {}, () => 0);
      // boolean false should be accepted by the type and behave as default.
      rm(db, "/a.txt", { recursive: false, force: false });
      expect(resolveInode(db, "/a.txt")).toBeNull();
    });
  });
});
