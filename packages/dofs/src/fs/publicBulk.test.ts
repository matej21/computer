import { describe, expect, it } from "vitest";
import { clearBlobCache } from "./blobCache.js";
import { WorkspaceFilesystem } from "./filesystem.js";
import { link } from "./link.js";
import { withDB } from "./with-db.js";

const MIB = 1024 * 1024;
const WALK_MAX_BYTES = MIB;
const FILE_MAX_BYTES = 4 * MIB;
const MUTATION_MAX_ENTRIES = 10_000;
const MUTATION_MAX_METADATA_BYTES = 4 * MIB;

async function withFs<T>(run: (fs: WorkspaceFilesystem) => T | Promise<T>): Promise<T> {
  return withDB((db) => run(new WorkspaceFilesystem(db, { now: () => 1000 })));
}

function decode(bytes: Uint8Array | undefined): string | undefined {
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
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

  it("binds walk cursors to the root and traversal options", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/tree", { recursive: true });
      await fs.mkdir("/other", { recursive: true });
      await fs.writeFile("/tree/a", "a");
      await fs.writeFile("/tree/b", "b");
      const first = await fs.walk("/tree", { limit: 1, maxBytes: WALK_MAX_BYTES });
      expect(first.cursor).toEqual(expect.any(String));

      await expect(
        fs.walk("/other", { limit: 1, maxBytes: WALK_MAX_BYTES, cursor: first.cursor }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", {
          limit: 1,
          maxBytes: WALK_MAX_BYTES,
          cursor: first.cursor,
          depth: 1,
        }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(
        fs.walk("/tree", { limit: 1, maxBytes: WALK_MAX_BYTES, cursor: "not-a-cursor" }),
      ).rejects.toMatchObject({ code: "EINVAL" });
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
      await fs.writeFile("/large", "large");
      const paths = ["/a", "/b", "/large"];

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
      expect(third.entries[0]?.error).toMatchObject({ code: "EFBIG", path: "/large" });
      expect(third.cursor).toBeUndefined();

      await expect(
        fs.readFiles(["/a", "/large"], {
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
        fs.writeFiles([{ path: "/out/large", content: "x".repeat(5) }], { maxBytes: 4 }),
      ).rejects.toMatchObject({ code: "EINVAL" });
      await expect(fs.stat("/out/large")).rejects.toMatchObject({ code: "ENOENT" });
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

  it("copies trees atomically by metadata while preserving links", async () => {
    await withFs(async (fs) => {
      await fs.mkdir("/source/sub", { recursive: true });
      await fs.writeFile("/source/file", "file");
      link(fs.db, "/source/file", "/source/sub/hard");
      await fs.symlink("../file", "/source/sub/link");

      await fs.cp("/source", "/copy", { recursive: true });
      await expect(fs.readFile("/copy/file", "utf8")).resolves.toBe("file");
      expect(await fs.readlink("/copy/sub/link")).toBe("../file");
      expect((await fs.stat("/copy/file")).inode).toBe((await fs.stat("/copy/sub/hard")).inode);
      expect((await fs.stat("/copy/file")).inode).not.toBe((await fs.stat("/source/file")).inode);

      await fs.writeFile("/copy/sub/hard", "changed");
      await expect(fs.readFile("/copy/file", "utf8")).resolves.toBe("changed");
      await expect(fs.readFile("/source/file", "utf8")).resolves.toBe("file");
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
    });
  });
});
