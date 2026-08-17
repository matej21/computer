// Deterministic workload probe for explicit Git staging pathspecs.

import { performance } from "node:perf_hooks";

import git from "isomorphic-git";
import { fs as memfs, vol } from "memfs";
import { beforeEach, expect, test, vi } from "vitest";

import { addWith, type IsomorphicGitAddClient } from "./staging.js";

const SCENARIO = {
  fixtureFiles: 10_000,
  changedFiles: 3,
  directory: "/repo",
  pathspec: "src",
};
const AUTHOR = { name: "benchmark", email: "benchmark@example.test" };

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

async function stage(): Promise<void> {
  await addWith({
    git: addClient,
    fs: memfs,
    dir: SCENARIO.directory,
    paths: [SCENARIO.pathspec],
  });
}

beforeEach(() => vol.reset());

test("explicit staging reads contents and extra metadata in proportion to changed paths", async () => {
  const sourceDirectory = `${SCENARIO.directory}/${SCENARIO.pathspec}`;
  await memfs.promises.mkdir(sourceDirectory, { recursive: true });
  for (let index = 0; index < SCENARIO.fixtureFiles; index++) {
    await memfs.promises.writeFile(`${sourceDirectory}/file-${index}.txt`, `before ${index}\n`);
  }
  await git.init({ fs: memfs, dir: SCENARIO.directory, defaultBranch: "main" });
  await stage();
  await git.commit({
    fs: memfs,
    dir: SCENARIO.directory,
    message: "fixture",
    author: AUTHOR,
  });

  for (let index = 0; index < SCENARIO.changedFiles; index++) {
    await memfs.promises.writeFile(`${sourceDirectory}/file-${index}.txt`, `after ${index}\n`);
  }

  const baselineLstat = vi.spyOn(memfs.promises, "lstat");
  const baselineStat = vi.spyOn(memfs.promises, "stat");
  await git.statusMatrix({
    fs: memfs,
    dir: SCENARIO.directory,
    filepaths: [SCENARIO.pathspec],
  });
  const baselineLstatOperations = baselineLstat.mock.calls.length;
  const baselineStatOperations = baselineStat.mock.calls.length;
  baselineLstat.mockRestore();
  baselineStat.mockRestore();

  const readFile = vi.spyOn(memfs.promises, "readFile");
  const lstat = vi.spyOn(memfs.promises, "lstat");
  const stat = vi.spyOn(memfs.promises, "stat");
  const startedAt = performance.now();
  await stage();
  const elapsedMs = performance.now() - startedAt;
  const worktreeReads = readFile.mock.calls
    .map(([path]) => String(path))
    .filter((path) => path.startsWith(`${sourceDirectory}/`));
  const stagingLstatOperations = lstat.mock.calls.length;
  const stagingStatOperations = stat.mock.calls.length;
  const worktreeLstatOperations = lstat.mock.calls.filter(([path]) =>
    String(path).startsWith(`${sourceDirectory}/`),
  ).length;
  const worktreeStatOperations = stat.mock.calls.filter(([path]) =>
    String(path).startsWith(`${sourceDirectory}/`),
  ).length;
  readFile.mockRestore();
  lstat.mockRestore();
  stat.mockRestore();

  const contentFilesRead = [...new Set(worktreeReads)].filter((path) =>
    /\/file-\d+\.txt$/.test(path),
  );
  const changedFilesRead = contentFilesRead.filter((path) => {
    const match = /\/file-(\d+)\.txt$/.exec(path);
    return match !== null && Number(match[1]) < SCENARIO.changedFiles;
  });
  const unchangedFilesRead = contentFilesRead.length - changedFilesRead.length;
  const baselineMetadataOperations = baselineLstatOperations + baselineStatOperations;
  const stagingMetadataOperations = stagingLstatOperations + stagingStatOperations;
  const metadataOperationOverhead = stagingMetadataOperations - baselineMetadataOperations;
  const metadataOperationTarget = SCENARIO.changedFiles * 4 + 2;
  const report = {
    scenario: "explicit-directory-pathspec",
    fixtureFiles: SCENARIO.fixtureFiles,
    changedFiles: SCENARIO.changedFiles,
    worktreeReadOperations: worktreeReads.length,
    contentFilesRead: contentFilesRead.length,
    changedFilesRead: changedFilesRead.length,
    unchangedFilesRead,
    baselineLstatOperations,
    baselineStatOperations,
    stagingLstatOperations,
    stagingStatOperations,
    worktreeLstatOperations,
    worktreeStatOperations,
    metadataOperationOverhead,
    metadataOperationTarget,
    elapsedMs: Number(elapsedMs.toFixed(2)),
  };
  console.log(`GIT_STAGING_BENCH ${JSON.stringify(report)}`);

  for (let index = 0; index < SCENARIO.changedFiles; index++) {
    const [row] = await git.statusMatrix({
      fs: memfs,
      dir: SCENARIO.directory,
      filepaths: [`${SCENARIO.pathspec}/file-${index}.txt`],
    });
    expect(row).toEqual([`${SCENARIO.pathspec}/file-${index}.txt`, 1, 2, 2]);
  }
  expect(unchangedFilesRead).toBe(0);
  expect(contentFilesRead.length).toBeLessThanOrEqual(SCENARIO.changedFiles);
  expect(metadataOperationOverhead).toBeLessThanOrEqual(metadataOperationTarget);
});
