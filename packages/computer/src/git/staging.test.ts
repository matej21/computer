// Behavioural tests for `addWith` and `rmWith`. Drives real
// isomorphic-git + memfs so the index updates are observable
// through subsequent `statusMatrix` rows.

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addWith,
  type IsomorphicGitAddClient,
  type IsomorphicGitRmClient,
  rmWith,
} from "./staging.js";

const DIR = "/repo";
const AUTHOR = { name: "t", email: "t@example.test" };

const addClient: IsomorphicGitAddClient = {
  async add({ fs: _fs, ...args }) {
    await git.add({ fs: memfs, ...args });
  },
  async statusMatrix({ fs: _fs, ...args }) {
    return git.statusMatrix({ fs: memfs, ...args });
  },
  async remove({ fs: _fs, ...args }) {
    await git.remove({ fs: memfs, ...args });
  },
};

async function stage(paths: string[], options: { force?: boolean } = {}): Promise<void> {
  await addWith({
    git: addClient,
    fs: memfs,
    dir: DIR,
    paths,
    force: options.force,
  });
}

async function init() {
  await memfs.promises.mkdir(DIR, { recursive: true });
  await git.init({ fs: memfs, dir: DIR, defaultBranch: "main" });
}

async function statusOf(path: string): Promise<[number, number, number] | undefined> {
  const matrix = await git.statusMatrix({ fs: memfs, dir: DIR });
  const row = matrix.find((r) => r[0] === path);
  if (!row) return undefined;
  return [row[1], row[2], row[3]];
}

describe("addWith", () => {
  beforeEach(() => vol.reset());

  it("stages a single file (workdir == stage after add)", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "hello\n");
    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: ["a.txt"],
    });
    // [head=0, workdir=2, stage=2] — added file, identical in workdir and stage.
    expect(await statusOf("a.txt")).toEqual([0, 2, 2]);
  });

  it("stages changed explicit paths while leaving unchanged paths unchanged", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/same.txt`, "same\n");
    await memfs.promises.writeFile(`${DIR}/changed.txt`, "before\n");
    await stage(["same.txt", "changed.txt"]);
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    await memfs.promises.writeFile(`${DIR}/changed.txt`, "after\n");

    await stage(["same.txt", "changed.txt"]);

    expect(await statusOf("same.txt")).toEqual([1, 1, 1]);
    expect(await statusOf("changed.txt")).toEqual([1, 2, 2]);
  });

  it("stages a same-size overwrite when whole-second stat data matches the index", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-17T12:00:00.250Z"));
    try {
      const path = `${DIR}/racy.txt`;
      const timestamp = new Date("2026-08-17T12:00:00.250Z");
      await init();
      await memfs.promises.writeFile(path, "alpha\n");
      await memfs.promises.utimes(path, timestamp, timestamp);
      const indexedStat = await memfs.promises.stat(path);
      await stage(["racy.txt"]);
      await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

      await memfs.promises.writeFile(path, "bravo\n");
      await memfs.promises.utimes(path, timestamp, timestamp);
      const overwrittenStat = await memfs.promises.stat(path);

      expect(overwrittenStat.size).toBe(indexedStat.size);
      expect(Math.floor(overwrittenStat.mtime.getTime() / 1000)).toBe(
        Math.floor(indexedStat.mtime.getTime() / 1000),
      );
      expect(Math.floor(overwrittenStat.ctime.getTime() / 1000)).toBe(
        Math.floor(indexedStat.ctime.getTime() / 1000),
      );
      expect(await statusOf("racy.txt")).toEqual([1, 1, 1]);

      await stage(["racy.txt"]);

      expect(await statusOf("racy.txt")).toEqual([1, 2, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reread a tracked file already equal to the index", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/tracked.txt`, "tracked\n");
    await stage(["tracked.txt"]);
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

    const readFile = vi.spyOn(memfs.promises, "readFile");
    await stage(["tracked.txt"]);
    const contentReads = readFile.mock.calls.filter(
      ([path]) => String(path) === `${DIR}/tracked.txt`,
    );
    readFile.mockRestore();

    expect(await statusOf("tracked.txt")).toEqual([1, 1, 1]);
    expect(contentReads).toHaveLength(0);
  });

  it("does not reread an untracked file already equal to the index", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/untracked.txt`, "untracked\n");
    await stage(["untracked.txt"]);
    expect(await statusOf("untracked.txt")).toEqual([0, 2, 2]);

    const readFile = vi.spyOn(memfs.promises, "readFile");
    await stage(["untracked.txt"]);
    const contentReads = readFile.mock.calls.filter(
      ([path]) => String(path) === `${DIR}/untracked.txt`,
    );
    readFile.mockRestore();

    expect(await statusOf("untracked.txt")).toEqual([0, 2, 2]);
    expect(contentReads).toHaveLength(0);
  });

  it("does not read unchanged files below an explicit directory pathspec", async () => {
    await init();
    await memfs.promises.mkdir(`${DIR}/src`, { recursive: true });
    for (let index = 0; index < 12; index++) {
      await memfs.promises.writeFile(`${DIR}/src/stable-${index}.txt`, `stable ${index}\n`);
    }
    await memfs.promises.writeFile(`${DIR}/src/changed.txt`, "before\n");
    await stage(["src"]);
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    await memfs.promises.writeFile(`${DIR}/src/changed.txt`, "after\n");
    await memfs.promises.writeFile(`${DIR}/src/new.txt`, "new\n");

    const readFile = vi.spyOn(memfs.promises, "readFile");
    await stage(["src"]);
    const unchangedReads = readFile.mock.calls.filter(([path]) =>
      String(path).includes("/src/stable-"),
    );
    readFile.mockRestore();

    expect(await statusOf("src/changed.txt")).toEqual([1, 2, 2]);
    expect(await statusOf("src/new.txt")).toEqual([0, 2, 2]);
    expect(await statusOf("src/stable-0.txt")).toEqual([1, 1, 1]);
    expect(unchangedReads).toHaveLength(0);
  });

  it("preserves a missing pathspec error", async () => {
    await init();
    await expect(stage(["missing.txt"])).rejects.toMatchObject({
      code: "EPATHSPEC",
      message: "pathspec 'missing.txt' did not match any files",
    });
  });

  it("leaves an ignored path unstaged without force", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/.gitignore`, "secret.txt\n");
    await memfs.promises.writeFile(`${DIR}/secret.txt`, "secret\n");

    await stage(["secret.txt"]);

    expect(await statusOf("secret.txt")).toBeUndefined();
  });

  it("accepts an empty directory pathspec as a no-op", async () => {
    await init();
    await memfs.promises.mkdir(`${DIR}/empty`);

    await expect(stage(["empty"])).resolves.toBeUndefined();
    expect(await git.statusMatrix({ fs: memfs, dir: DIR })).toEqual([]);
  });

  it("force stages an ignored explicit path without filtering it", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/.gitignore`, "secret.txt\n");
    await memfs.promises.writeFile(`${DIR}/secret.txt`, "secret\n");

    await stage(["secret.txt"], { force: true });

    expect(await statusOf("secret.txt")).toEqual([0, 2, 2]);
  });

  it("preserves the missing-path error for an explicit deletion", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/gone.txt`, "gone\n");
    await stage(["gone.txt"]);
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    await memfs.promises.unlink(`${DIR}/gone.txt`);

    await expect(stage(["gone.txt"])).rejects.toMatchObject({ code: "EPATHSPEC" });

    expect(await statusOf("gone.txt")).toEqual([1, 0, 1]);
  });

  it("stages multiple paths in one call", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "a\n");
    await memfs.promises.writeFile(`${DIR}/b.txt`, "b\n");
    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: ["a.txt", "b.txt"],
    });
    expect(await statusOf("a.txt")).toEqual([0, 2, 2]);
    expect(await statusOf("b.txt")).toEqual([0, 2, 2]);
  });

  it("empty paths is a no-op", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/a.txt`, "x\n");
    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: [],
    });
    // a.txt remains untracked: head=0, workdir=2, stage=0.
    expect(await statusOf("a.txt")).toEqual([0, 2, 0]);
  });

  it("all: true stages new, modified, and deleted paths", async () => {
    await init();
    // Commit a baseline with two files.
    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k1\n");
    await memfs.promises.writeFile(`${DIR}/gone.txt`, "g1\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "keep.txt" });
    await git.add({ fs: memfs, dir: DIR, filepath: "gone.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

    // Modify one, delete one, add one new untracked file.
    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k2 changed\n");
    await memfs.promises.unlink(`${DIR}/gone.txt`);
    await memfs.promises.writeFile(`${DIR}/new.txt`, "n1\n");

    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: [],
      all: true,
    });

    // Modified file staged: workdir == stage.
    expect(await statusOf("keep.txt")).toEqual([1, 2, 2]);
    // New file staged.
    expect(await statusOf("new.txt")).toEqual([0, 2, 2]);
    // Deleted file unstaged from the index: stage=0.
    expect(await statusOf("gone.txt")).toEqual([1, 0, 0]);
  });

  it("all: true unstages a new file that was deleted after staging", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/new.txt`, "n1\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "new.txt" });
    expect(await statusOf("new.txt")).toEqual([0, 2, 2]);
    await memfs.promises.unlink(`${DIR}/new.txt`);
    expect(await statusOf("new.txt")).toEqual([0, 0, 3]);

    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: [],
      all: true,
    });

    expect(await statusOf("new.txt")).toBeUndefined();
  });

  it("all + trackedOnly stages tracked changes but leaves untracked files alone", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k1\n");
    await memfs.promises.writeFile(`${DIR}/gone.txt`, "g1\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "keep.txt" });
    await git.add({ fs: memfs, dir: DIR, filepath: "gone.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });

    await memfs.promises.writeFile(`${DIR}/keep.txt`, "k2 changed\n");
    await memfs.promises.unlink(`${DIR}/gone.txt`);
    await memfs.promises.writeFile(`${DIR}/new.txt`, "n1\n");

    await addWith({
      git: git as unknown as IsomorphicGitAddClient,
      fs: memfs,
      dir: DIR,
      paths: [],
      all: true,
      trackedOnly: true,
    });

    // Tracked modification staged.
    expect(await statusOf("keep.txt")).toEqual([1, 2, 2]);
    // Tracked deletion staged.
    expect(await statusOf("gone.txt")).toEqual([1, 0, 0]);
    // Untracked file left unstaged: head=0, workdir=2, stage=0.
    expect(await statusOf("new.txt")).toEqual([0, 2, 0]);
  });
});

describe("rmWith", () => {
  beforeEach(() => vol.reset());

  it("removes a previously-committed path from the index", async () => {
    await init();
    await memfs.promises.writeFile(`${DIR}/gone.txt`, "bye\n");
    await git.add({ fs: memfs, dir: DIR, filepath: "gone.txt" });
    await git.commit({ fs: memfs, dir: DIR, message: "init", author: AUTHOR });
    await rmWith({
      git: git as unknown as IsomorphicGitRmClient,
      fs: memfs,
      dir: DIR,
      paths: ["gone.txt"],
    });
    // The file is gone from the index (stage=0). isomorphic-git's
    // `remove` only unstages — the working tree copy still exists.
    // workdirStatus reads 1 ("== HEAD") because the file on disk
    // still matches what HEAD recorded.
    expect(await statusOf("gone.txt")).toEqual([1, 1, 0]);
  });
});
