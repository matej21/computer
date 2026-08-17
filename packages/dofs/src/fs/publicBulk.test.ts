import { describe, expect, it } from "vitest";
import { SQLiteWorkspaceProvider } from "../provider.js";
import { clearBlobCache } from "./blobCache.js";
import { WorkspaceFilesystem } from "./filesystem.js";
import { link } from "./link.js";
import { invalidateReadOnlyMountCache } from "./mount-guard.js";
import { withDB } from "./with-db.js";

const MIB = 1024 * 1024;
const WALK_MAX_BYTES = MIB;
const FILE_MAX_BYTES = 4 * MIB;
const MUTATION_MAX_ENTRIES = 10_000;
const MUTATION_MAX_METADATA_BYTES = 4 * MIB;
const READ_FILES_MAX_PATHS = 4096;
const READ_FILES_MAX_PATH_BYTES = MIB;
const WALK_MAX_EXCLUDES = 256;
const WALK_MAX_EXCLUDE_BYTES = 64 * 1024;

async function withFs<T>(run: (fs: WorkspaceFilesystem) => T | Promise<T>): Promise<T> {
  return withDB((db) => run(new WorkspaceFilesystem(db, { now: () => 1000 })));
}

function decode(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
}

async function seedEmptyFiles(
  fs: WorkspaceFilesystem,
  directory: string,
  count: number,
): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const parent = await fs.stat(directory);
  const firstInode =
    (fs.db.scalar<number>("SELECT COALESCE(MAX(inode), 0) FROM vfs_nodes") ?? 0) + 1;
  fs.db.transactionSync(() => {
    fs.db.run(
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
    fs.db.run(
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

describe("public bounded bulk filesystem", () => {
  it("walks stable depth-first pages without following symlinks", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree/a", { recursive: true });
      await fs.mkdir("/tree/b", { recursive: true });
      await fs.mkdir("/tree/skip/deep", { recursive: true });
      await fs.mkdir("/tree/.hidden/deep", { recursive: true });
      await fs.mkdir("/outside", { recursive: true });
      await fs.writeFile("/tree/a/one", "one");
      link(fs.db, "/tree/a/one", "/tree/b/alias");
      await fs.writeFile("/tree/skip/deep/no", "no");
      await fs.writeFile("/tree/.hidden/deep/no", "no");
      await fs.writeFile("/outside/not-walked", "outside");
      await fs.symlink("/outside", "/tree/link");

      const entries = [];
      let cursor: string | undefined;
      do {
        const page = await fs.walk("/tree", {
          limit: 2,
          maxBytes: WALK_MAX_BYTES,
          cursor,
          exclude: ["skip"],
          excludeHidden: true,
        });
        entries.push(...page.entries);
        cursor = page.cursor;
      } while (cursor !== undefined);

      expect(entries.map((entry) => entry.path)).toEqual([
        "/tree/a",
        "/tree/a/one",
        "/tree/b",
        "/tree/b/alias",
        "/tree/link",
      ]);
      expect(entries.find((entry) => entry.path === "/tree/link")).toMatchObject({
        type: "symlink",
        linkTarget: "/outside",
      });
      expect(entries.some((entry) => entry.path.includes("not-walked"))).toBe(false);
      expect(entries.find((entry) => entry.path === "/tree/a/one")?.inode).toBe(
        entries.find((entry) => entry.path === "/tree/b/alias")?.inode,
      );
    });
  });

  it("uses state-free snapshot cursors bound to the root and every traversal option", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree", { recursive: true });
      await fs.mkdir("/other", { recursive: true });
      await fs.writeFile("/tree/a", "a");
      await fs.writeFile("/tree/b", "b");
      const options = {
        limit: 1,
        maxBytes: WALK_MAX_BYTES,
        depth: 2,
        exclude: ["skip"],
        excludeHidden: true,
      };
      const first = await fs.walk("/tree", options);
      expect(first.cursor).toEqual(expect.any(String));

      const independent = new WorkspaceFilesystem(fs.db, { now: () => 1000 });
      await expect(
        independent.walk("/tree", { ...options, cursor: first.cursor }),
      ).resolves.toMatchObject({ entries: [{ path: "/tree/b" }] });

      await expect(fs.walk("/other", { ...options, cursor: first.cursor })).rejects.toMatchObject({
        code: "EINVAL",
      });
      await expect(
        fs.walk("/tree", {
          ...options,
          cursor: first.cursor,
          depth: 1,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", { ...options, cursor: first.cursor, exclude: ["other"] }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", { ...options, cursor: first.cursor, excludeHidden: false }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.walk("/tree", { ...options, cursor: "not-a-cursor" })).rejects.toMatchObject({
        code: "EINVAL",
      });

      await fs.writeFile("/tree/c", "c");
      await expect(fs.walk("/tree", { ...options, cursor: first.cursor })).rejects.toMatchObject({
        code: "ESTALE",
      });
    });
  });

  it("validates a walk cursor root inode against the requested directory", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree", { recursive: true });
      await fs.mkdir("/other", { recursive: true });
      await fs.writeFile("/tree/a", "a");
      await fs.writeFile("/tree/b", "b");
      await fs.writeFile("/other/z-secret", "secret");
      const options = { limit: 1, maxBytes: WALK_MAX_BYTES };
      const first = await fs.walk("/tree", options);
      if (first.cursor === undefined) throw new Error("walk cursor is missing");
      const other = await fs.stat("/other");
      const cursorParts = first.cursor.split(":");
      if (cursorParts.length !== 6) throw new Error("unexpected walk cursor shape");
      cursorParts[2] = other.inode.toString(36);

      await expect(
        fs.walk("/tree", { ...options, cursor: cursorParts.join(":") }),
      ).rejects.toMatchObject({ code: "EINVAL", path: "/tree" });
    });
  });

  it("enforces walk depth, serialized byte pages, and hard ceilings", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree/deep", { recursive: true });
      for (const name of ["a".repeat(80), "b".repeat(80), "c".repeat(80)]) {
        await fs.writeFile(`/tree/${name}`, "x");
      }
      await fs.writeFile("/tree/deep/file", "x");

      const page = await fs.walk("/tree", { limit: 1000, maxBytes: 256, depth: 1 });
      expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(256);
      expect(page.entries.every((entry) => !entry.path.endsWith("/deep/file"))).toBe(true);
      expect(page.cursor).toEqual(expect.any(String));

      await expect(
        fs.walk("/tree", { limit: 1001, maxBytes: WALK_MAX_BYTES }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", { limit: 1, maxBytes: WALK_MAX_BYTES + 1 }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", { limit: 1, maxBytes: WALK_MAX_BYTES, depth: -1 }),
      ).rejects.toMatchObject({ code: "EINVAL" });

      await expect(
        fs.walk("/tree", {
          limit: 1,
          maxBytes: WALK_MAX_BYTES,
          exclude: Array.from({ length: WALK_MAX_EXCLUDES + 1 }, () => "x"),
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", {
          limit: 1,
          maxBytes: WALK_MAX_BYTES,
          exclude: ["x".repeat(WALK_MAX_EXCLUDE_BYTES + 1)],
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", {
          limit: 1,
          maxBytes: WALK_MAX_BYTES,
          exclude: ["x".repeat(WALK_MAX_EXCLUDE_BYTES)],
        }),
      ).resolves.toEqual(expect.objectContaining({ entries: expect.any(Array) }));
    });
  });

  it("returns no descendants when walk depth is zero", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree/deep", { recursive: true });
      await fs.writeFile("/tree/file", "file");
      await fs.writeFile("/tree/deep/file", "deep");

      await expect(
        fs.walk("/tree", { limit: 1000, maxBytes: WALK_MAX_BYTES, depth: 0 }),
      ).resolves.toEqual({ entries: [] });
    });
  });

  it("includes pending creates in walk with their current metadata", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree", { recursive: true });
      const provider = new SQLiteWorkspaceProvider(fs.db, { now: () => 1000 });
      provider.openWriteBufferForCreateSync("/tree/pending", { mode: 0o600 });
      provider.writeRangeSync("/tree/pending", "pending", 0);

      await expect(fs.walk("/tree", { limit: 1000, maxBytes: WALK_MAX_BYTES })).resolves.toEqual({
        entries: [
          {
            path: "/tree/pending",
            inode: 0,
            type: "file",
            mode: 0o600,
            mtime: 1000,
            size: 7,
          },
        ],
      });
    });
  });

  it("reads ordered pages with structured per-entry errors", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/dir", { recursive: true });
      await fs.writeFile("/file", "file");
      await fs.writeFile("/broken", "broken");
      await fs.symlink("/file", "/link");
      clearBlobCache(fs.db);
      const broken = await fs.stat("/broken");
      fs.db.run(
        "DELETE FROM vfs_blob_bytes WHERE hash IN (SELECT hash FROM vfs_chunks WHERE inode = ?)",
        broken.inode,
      );

      const page = await fs.readFiles(["/file", "/missing", "/dir", "/link", "/broken"], {
        limit: 5,
        maxBytes: FILE_MAX_BYTES,
      });
      expect(page.cursor).toBeUndefined();
      expect(page.entries.map((entry) => entry.path)).toEqual([
        "/file",
        "/missing",
        "/dir",
        "/link",
        "/broken",
      ]);
      expect(decode(page.entries[0]?.content)).toBe("file");
      expect(page.entries[1]?.error).toMatchObject({ code: "ENOENT", path: "/missing" });
      expect(page.entries[2]?.error).toMatchObject({ code: "EISDIR", path: "/dir" });
      expect(decode(page.entries[3]?.content)).toBe("file");
      expect(page.entries[4]?.error).toMatchObject({ code: "EIO", path: "/broken" });
      for (const entry of page.entries.filter((entry) => entry.error !== undefined)) {
        expect(entry.error?.message).toEqual(expect.any(String));
      }
    });
  });

  it("paginates readFiles by input position and content bytes", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/a", "aaaa");
      await fs.writeFile("/b", "bbbb");
      await fs.writeFile("/exact", "exact");
      await fs.writeFile("/large", "large!");
      const paths = ["/a", "/b", "/exact", "/large"];

      const first = await fs.readFiles(paths, { limit: 3, maxBytes: 5 });
      expect(first.entries.map((entry) => entry.path)).toEqual(["/a"]);
      expect(first.cursor).toEqual(expect.any(String));
      const second = await fs.readFiles(paths, {
        limit: 3,
        maxBytes: 5,
        cursor: first.cursor,
      });
      expect(second.entries.map((entry) => entry.path)).toEqual(["/b"]);
      const third = await fs.readFiles(paths, {
        limit: 3,
        maxBytes: 5,
        cursor: second.cursor,
      });
      expect(decode(third.entries[0]?.content)).toBe("exact");
      expect(third.cursor).toEqual(expect.any(String));
      const fourth = await fs.readFiles(paths, {
        limit: 3,
        maxBytes: 5,
        cursor: third.cursor,
      });
      expect(fourth.entries[0]?.error).toMatchObject({ code: "EFBIG", path: "/large" });
      expect(fourth.cursor).toBeUndefined();

      await expect(
        fs.readFiles(["/a", "/exact"], {
          limit: 3,
          maxBytes: 5,
          cursor: first.cursor,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.readFiles(paths, { limit: 257, maxBytes: FILE_MAX_BYTES }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.readFiles(paths, { limit: 1, maxBytes: FILE_MAX_BYTES + 1 }),
      ).rejects.toMatchObject({ code: "EINVAL" });
    });
  });

  it("bounds readFiles request metadata and invalidates cursors after any new revision", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/a", "aaaa");
      await fs.writeFile("/b", "bbbb");
      const paths = ["/a", "/b"];
      const first = await fs.readFiles(paths, { limit: 1, maxBytes: FILE_MAX_BYTES });
      expect(first.cursor).toEqual(expect.any(String));

      const independent = new WorkspaceFilesystem(fs.db, { now: () => 1000 });
      await expect(
        independent.readFiles(paths, {
          limit: 1,
          maxBytes: FILE_MAX_BYTES,
          cursor: first.cursor,
        }),
      ).resolves.toMatchObject({ entries: [{ path: "/b" }] });
      await expect(
        fs.readFiles(paths, {
          limit: 1,
          maxBytes: FILE_MAX_BYTES,
          cursor: "not-a-cursor",
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });

      const exactMetadataPath = `/${"x".repeat(READ_FILES_MAX_PATH_BYTES - 1)}`;
      const exact = await fs.readFiles([exactMetadataPath], {
        limit: 1,
        maxBytes: FILE_MAX_BYTES,
      });
      expect(exact.entries[0]?.error).toMatchObject({ code: "ENOENT", path: exactMetadataPath });
      await expect(
        fs.readFiles([`/${"x".repeat(READ_FILES_MAX_PATH_BYTES)}`], {
          limit: 1,
          maxBytes: FILE_MAX_BYTES,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.readFiles(
          Array.from({ length: READ_FILES_MAX_PATHS + 1 }, () => "/a"),
          {
            limit: 1,
            maxBytes: FILE_MAX_BYTES,
          },
        ),
      ).rejects.toMatchObject({ code: "EINVAL" });

      await fs.writeFile("/unrelated", "change");
      await expect(
        fs.readFiles(paths, { limit: 1, maxBytes: FILE_MAX_BYTES, cursor: first.cursor }),
      ).rejects.toMatchObject({ code: "ESTALE" });
    });
  });

  it("returns independent copies for duplicate and hardlinked reads", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/original", "original");
      link(fs.db, "/original", "/hardlink");
      const page = await fs.readFiles(["/original", "/original", "/hardlink"], {
        limit: 3,
        maxBytes: FILE_MAX_BYTES,
      });
      page.entries[0]?.content?.fill(0);
      expect(decode(page.entries[1]?.content)).toBe("original");
      expect(decode(page.entries[2]?.content)).toBe("original");
      await expect(fs.readFile("/original", "utf8")).resolves.toBe("original");
    });
  });

  it("budgets readFiles from the current dirty buffer size", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/exact", "x");
      await fs.writeFile("/over", "x");
      const provider = new SQLiteWorkspaceProvider(fs.db, { now: () => 1000 });
      provider.openWriteBufferSync("/exact");
      provider.openWriteBufferSync("/over");
      provider.writeRangeSync("/exact", "exact", 0);
      provider.writeRangeSync("/over", "large!", 0);

      const exact = await fs.readFiles(["/exact"], { limit: 1, maxBytes: 5 });
      expect(decode(exact.entries[0]?.content)).toBe("exact");
      expect(exact.cursor).toBeUndefined();

      const over = await fs.readFiles(["/over"], { limit: 1, maxBytes: 5 });
      expect(over).toEqual({
        entries: [
          {
            path: "/over",
            error: {
              code: "EFBIG",
              message: expect.any(String),
              path: "/over",
            },
          },
        ],
      });
    });
  });

  it("writes the whole bounded set atomically and copies byte inputs", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/out", { recursive: true });
      const bytes = new TextEncoder().encode("copied");
      const writing = fs.writeFiles(
        [
          { path: "/out/a", content: bytes, mode: 0o600 },
          { path: "/out/duplicate", content: "first" },
          { path: "/out/duplicate", content: "last" },
        ],
        { maxBytes: FILE_MAX_BYTES },
      );
      bytes.fill(0);
      await writing;

      await expect(fs.readFile("/out/a", "utf8")).resolves.toBe("copied");
      expect((await fs.stat("/out/a")).mode).toBe(0o600);
      await expect(fs.readFile("/out/duplicate", "utf8")).resolves.toBe("last");

      await expect(
        fs.writeFiles(
          [
            { path: "/out/rolled-back", content: "written first" },
            { path: "/missing/parent", content: "fails second" },
          ],
          { maxBytes: FILE_MAX_BYTES },
        ),
      ).rejects.toMatchObject({ code: "ENOENT", path: "/missing/parent" });
      await expect(fs.stat("/out/rolled-back")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preserves single-write symlink and hardlink semantics in writeFiles", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/symlink-target", "before");
      await fs.symlink("/symlink-target", "/symlink-name");
      await fs.writeFile("/hard-target", "before");
      link(fs.db, "/hard-target", "/hard-name");

      await fs.writeFiles(
        [
          { path: "/symlink-name", content: "through link" },
          { path: "/hard-name", content: "through hardlink" },
        ],
        { maxBytes: FILE_MAX_BYTES },
      );
      await expect(fs.readFile("/symlink-target", "utf8")).resolves.toBe("through link");
      await expect(fs.readFile("/hard-target", "utf8")).resolves.toBe("through hardlink");
      expect((await fs.lstat("/symlink-name")).isSymbolicLink).toBe(true);

      await fs.writeFiles(
        [
          { path: "/hard-name", content: "first alias" },
          { path: "/hard-target", content: "last alias" },
          { path: "/symlink-name", content: "first symlink alias" },
          { path: "/symlink-target", content: "last symlink alias" },
        ],
        { maxBytes: FILE_MAX_BYTES },
      );
      await expect(fs.readFile("/hard-name", "utf8")).resolves.toBe("last alias");
      await expect(fs.readFile("/symlink-name", "utf8")).resolves.toBe("last symlink alias");
    });
  });

  it("rejects write hard bounds without leaving partial files", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/out", { recursive: true });
      const tooMany = Array.from({ length: 1025 }, (_, index) => ({
        path: `/out/f${index}`,
        content: "x",
      }));
      await expect(fs.writeFiles(tooMany, { maxBytes: FILE_MAX_BYTES })).rejects.toMatchObject({
        code: "EINVAL",
      });
      expect(await fs.readdir("/out")).toEqual([]);

      await expect(
        fs.writeFiles(
          Array.from({ length: 1025 }, () => ({ path: "/out/repeated", content: "x" })),
          { maxBytes: FILE_MAX_BYTES },
        ),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/out/repeated")).rejects.toMatchObject({ code: "ENOENT" });

      await expect(
        fs.writeFiles([{ path: "/out/large", content: "x".repeat(5) }], { maxBytes: 4 }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/out/large")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.writeFiles(
          [
            { path: "/out/duplicate", content: "abc" },
            { path: "/out/duplicate", content: "def" },
          ],
          { maxBytes: 5 },
        ),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/out/duplicate")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.writeFiles([], { maxBytes: FILE_MAX_BYTES + 1 })).rejects.toMatchObject({
        code: "EINVAL",
      });
    });
  });

  it("removes a normalized set atomically without following final symlinks", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree/sub", { recursive: true });
      await fs.writeFile("/tree/sub/file", "file");
      await fs.writeFile("/target", "target");
      await fs.symlink("/target", "/tree/link");
      await fs.writeFile("/hard-target", "hard");
      link(fs.db, "/hard-target", "/tree/hard-name");

      await fs.rmFiles(["/tree/sub/file", "/tree/sub", "/tree/link", "/tree/hard-name"], {
        recursive: true,
        maxEntries: MUTATION_MAX_ENTRIES,
        maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
      });
      await expect(fs.stat("/tree/sub")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat("/tree/link")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile("/target", "utf8")).resolves.toBe("target");
      await expect(fs.readFile("/hard-target", "utf8")).resolves.toBe("hard");

      await fs.writeFile("/keep", "keep");
      await expect(
        fs.rmFiles(["/keep", "/missing"], {
          maxEntries: MUTATION_MAX_ENTRIES,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
        }),
      ).rejects.toMatchObject({ code: "ENOENT", path: "/missing" });
      await expect(fs.readFile("/keep", "utf8")).resolves.toBe("keep");

      await fs.rmFiles(["/missing", "/keep"], {
        force: true,
        maxEntries: MUTATION_MAX_ENTRIES,
        maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
      });
      await expect(fs.stat("/keep")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("preflights recursive removal entry and metadata budgets", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree", { recursive: true });
      await fs.writeFile("/tree/a", "a");
      await fs.writeFile("/tree/b", "b");

      await expect(
        fs.rmFiles(["/tree"], { recursive: true, maxEntries: 2, maxMetadataBytes: 4 * MIB }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.readFile("/tree/a", "utf8")).resolves.toBe("a");
      await expect(
        fs.rmFiles(["/tree"], { recursive: true, maxEntries: 10, maxMetadataBytes: 1 }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.readFile("/tree/b", "utf8")).resolves.toBe("b");
      await expect(
        fs.rmFiles([], {
          maxEntries: MUTATION_MAX_ENTRIES + 1,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.rmFiles([], {
          maxEntries: MUTATION_MAX_ENTRIES,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES + 1,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
    });
  });

  it("normalizes rmFiles only after raw bounds and preserves single-rm path semantics", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/minimal/sub", { recursive: true });
      await fs.writeFile("/minimal/sub/file", "file");
      await expect(
        fs.rmFiles(["/minimal/sub/file", "/minimal/sub/file"], {
          recursive: true,
          maxEntries: 1,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.readFile("/minimal/sub/file", "utf8")).resolves.toBe("file");

      await fs.writeFile("/raw-byte", "file");
      await expect(
        fs.rmFiles(["/raw-byte", "/raw-byte"], {
          maxEntries: 10,
          maxMetadataBytes: new TextEncoder().encode("/raw-byte").byteLength,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.readFile("/raw-byte", "utf8")).resolves.toBe("file");

      await fs.rmFiles(["/minimal/sub/file", "/minimal/sub/file", "/minimal/sub"], {
        recursive: true,
        maxEntries: 10,
        maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
      });
      await expect(fs.stat("/minimal/sub")).rejects.toMatchObject({ code: "ENOENT" });

      await fs.mkdir("/real", { recursive: true });
      await fs.writeFile("/real/file", "file");
      await fs.symlink("/real", "/alias");
      await fs.rmFiles(["/alias/file"], {
        maxEntries: 10,
        maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
      });
      await expect(fs.stat("/real/file")).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readlink("/alias")).toBe("/real");

      await expect(
        fs.rmFiles(["/"], {
          recursive: true,
          force: true,
          maxEntries: MUTATION_MAX_ENTRIES,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
        }),
      ).rejects.toMatchObject({ code: "EPERM", path: "/" });

      await fs.mkdir("/protected", { recursive: true });
      await fs.writeFile("/protected/file", "protected");
      fs.db.run(
        "INSERT INTO _vfs_mounts (root, kind, indexed, mode) VALUES (?, 'test', 1, 'read-only')",
        "/protected",
      );
      invalidateReadOnlyMountCache(fs.db);
      await expect(
        fs.rmFiles(["/protected/file"], {
          maxEntries: 10,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
        }),
      ).rejects.toMatchObject({ code: "EROFS", path: "/protected/file" });
      await expect(fs.readFile("/protected/file", "utf8")).resolves.toBe("protected");
    });
  });

  it("copies trees atomically by metadata while preserving links", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/source", { mode: 0o700 });
      await fs.mkdir("/source/sub");
      await fs.writeFile("/source/file", "file");
      link(fs.db, "/source/file", "/source/sub/hard");
      link(fs.db, "/source/file", "/outside-hardlink");
      await fs.symlink("../file", "/source/sub/link");
      const sourceDirectory = await fs.stat("/source");
      fs.db.run("UPDATE vfs_nodes SET mtime = ? WHERE inode = ?", 500, sourceDirectory.inode);

      await fs.cp("/source", "/copy", { recursive: true });
      await expect(fs.readFile("/copy/file", "utf8")).resolves.toBe("file");
      expect((await fs.stat("/copy")).mode).toBe(0o700);
      expect((await fs.stat("/copy")).mtime).toBe(1000);
      expect(await fs.readlink("/copy/sub/link")).toBe("../file");
      expect((await fs.stat("/copy/file")).inode).toBe((await fs.stat("/copy/sub/hard")).inode);
      expect((await fs.stat("/copy/file")).inode).not.toBe((await fs.stat("/source/file")).inode);
      expect((await fs.stat("/copy/file")).inode).not.toBe(
        (await fs.stat("/outside-hardlink")).inode,
      );

      await fs.writeFile("/copy/sub/hard", "changed");
      await expect(fs.readFile("/copy/file", "utf8")).resolves.toBe("changed");
      await expect(fs.readFile("/source/file", "utf8")).resolves.toBe("file");
      await expect(fs.readFile("/outside-hardlink", "utf8")).resolves.toBe("file");
    });
  });

  it("copies files and symlinks with explicit metadata and destination semantics", async () => {
    await withFs(async (fs) => {
      await fs.writeFile("/file", "file", { mode: 0o600 });
      const source = await fs.stat("/file");
      fs.db.run("UPDATE vfs_nodes SET mtime = ? WHERE inode = ?", 500, source.inode);
      await fs.cp("/file", "/file-copy");
      await expect(fs.readFile("/file-copy", "utf8")).resolves.toBe("file");
      expect((await fs.stat("/file-copy")).mode).toBe(0o600);
      expect((await fs.stat("/file-copy")).mtime).toBe(1000);

      await fs.symlink("/file", "/file-link");
      await fs.cp("/file-link", "/link-copy");
      expect(await fs.readlink("/link-copy")).toBe("/file");
      expect((await fs.lstat("/link-copy")).isSymbolicLink).toBe(true);

      await fs.mkdir("/source-dir", { recursive: true });
      await fs.writeFile("/source-dir/replaced", "new");
      await fs.mkdir("/dest-dir", { recursive: true });
      await fs.writeFile("/dest-dir/replaced", "old");
      await fs.writeFile("/dest-dir/kept", "kept");
      await fs.cp("/source-dir", "/dest-dir", { recursive: true });
      await expect(fs.readFile("/dest-dir/replaced", "utf8")).resolves.toBe("new");
      await expect(fs.readFile("/dest-dir/kept", "utf8")).resolves.toBe("kept");

      await fs.writeFile("/replace-file", "old");
      await fs.cp("/file", "/replace-file");
      await expect(fs.readFile("/replace-file", "utf8")).resolves.toBe("file");

      await expect(fs.cp("/file", "/missing-parent/file")).rejects.toMatchObject({
        code: "ENOENT",
        path: "/missing-parent/file",
      });
    });
  });

  it("rejects recursive copy bounds and invalid destinations without partial output", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/source/sub", { recursive: true });
      await fs.writeFile("/source/a", "a");
      await fs.writeFile("/source/sub/b", "b");

      await expect(fs.cp("/source", "/nonrecursive")).rejects.toMatchObject({ code: "EISDIR" });
      await expect(
        fs.cp("/source", "/too-small", {
          recursive: true,
          maxEntries: 2,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/too-small")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        fs.cp("/source", "/too-small-metadata", {
          recursive: true,
          maxEntries: MUTATION_MAX_ENTRIES,
          maxMetadataBytes: 1,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/too-small-metadata")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.cp("/source", "/source/inside", { recursive: true })).rejects.toMatchObject({
        code: "EINVAL",
      });
      await fs.symlink("/source", "/source-alias");
      await expect(
        fs.cp("/source", "/source-alias/inside", { recursive: true }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/source/inside")).rejects.toMatchObject({ code: "ENOENT" });
      await fs.writeFile("/occupied", "unchanged");
      await expect(fs.cp("/source", "/occupied", { recursive: true })).rejects.toMatchObject({
        code: "EEXIST",
      });
      await expect(fs.readFile("/occupied", "utf8")).resolves.toBe("unchanged");
      await expect(
        fs.cp("/source", "/invalid-hard-limit", {
          recursive: true,
          maxEntries: MUTATION_MAX_ENTRIES + 1,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.cp("/source", "/invalid-metadata-limit", {
          recursive: true,
          maxMetadataBytes: MUTATION_MAX_METADATA_BYTES + 1,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });

      await seedEmptyFiles(fs, "/oversized-source", MUTATION_MAX_ENTRIES + 1);
      await expect(
        fs.cp("/oversized-source", "/default-bounds", { recursive: true }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/default-bounds")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
