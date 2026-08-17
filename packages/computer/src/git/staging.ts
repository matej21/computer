// `git add` and `git rm` — index manipulation.
//
// Both surface an array of `paths` rather than the single
// `filepath` isomorphic-git takes, because the CLI's positional
// arguments naturally come in plural and a `paths: string[]`
// shape removes the per-call loop from every caller.

import {
  GitError,
  isNotARepositoryCause,
  NotARepositoryError,
  PathspecNotFoundError,
} from "./errors.js";
import type { StatusMatrixRow } from "./status.js";

/** Subset of `isomorphic-git`'s API used for `add`. */
export interface IsomorphicGitAddClient {
  add(args: {
    fs: object;
    dir: string;
    filepath: string | string[];
    cache?: object;
    force?: boolean;
  }): Promise<void>;
  /** Used to enumerate changed paths, for `all` mode and for pathspecs alike. */
  statusMatrix(args: {
    fs: object;
    dir: string;
    cache?: object;
    filepaths?: string[];
  }): Promise<StatusMatrixRow[]>;
  /** Used by `all` mode to stage deletions. */
  remove(args: { fs: object; dir: string; filepath: string; cache?: object }): Promise<void>;
}

/** Subset of `isomorphic-git`'s API used for `rm`. */
export interface IsomorphicGitRmClient {
  remove(args: { fs: object; dir: string; filepath: string; cache?: object }): Promise<void>;
}

export interface GitAddOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /**
   * Paths to stage, relative to `dir`. Empty array is a no-op
   * (matching `git add` with no arguments — which exits 0 with a
   * usage message; the CLI catches the no-arg case before
   * calling). Absolute or `..`-bearing paths are rejected at the
   * call site.
   */
  paths: string[];
  /**
   * Stage even paths that match `.gitignore`. isomorphic-git's
   * `add` honours ignore patterns by default; pass `true` to
   * override.
   */
  force?: boolean;
  /**
   * Stage every change under the repository — new, modified, and
   * deleted tracked files — the way `git add -A` / `--all` does.
   * When set, `paths` is ignored. Deletions are staged through
   * `remove`, which `add` alone cannot express.
   */
  all?: boolean;
  /**
   * Restrict `all` mode to paths already tracked in HEAD — the
   * `git commit -a` semantics, which stage modifications and
   * deletions but never add untracked files. Ignored unless
   * `all` is set.
   */
  trackedOnly?: boolean;
}

export interface AddWithDeps extends GitAddOptions {
  git: IsomorphicGitAddClient;
  fs: object;
  cache?: object;
}

export async function addWith(opts: AddWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  if (opts.all) {
    return addAll(opts, dir);
  }
  if (opts.paths.length === 0) return;
  if (opts.force === true) {
    return addFilepaths(opts, dir, opts.paths);
  }
  return addChanged(opts, dir);
}

async function addFilepaths(opts: AddWithDeps, dir: string, filepath: string[]): Promise<void> {
  try {
    // isomorphic-git 1.27+ accepts an array; older versions only
    // accept a single string. We pass the array and let it fan
    // out; the version pinned by the repo (^1.x) supports this.
    await opts.git.add({
      fs: opts.fs,
      dir,
      filepath,
      cache: opts.cache,
      force: opts.force,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    if (looksLikePathspecMiss(cause)) {
      throw new PathspecNotFoundError(firstPathspec(filepath), { cause });
    }
    throw new GitError("EADDFAIL", `git add failed: ${errorMessage(cause)}`, { cause });
  }
}

/** Stage only changed files covered by the explicit pathspecs. */
async function addChanged(opts: AddWithDeps, dir: string): Promise<void> {
  const indexMetadata = await readFileMetadata(opts.fs, joinPath(dir, ".git/index"));
  if (indexMetadata === undefined) return addFilepaths(opts, dir, opts.paths);

  const specs = opts.paths.map(normalizePathspec);
  const racyPaths = new Map<string, true>();
  let rows: StatusMatrixRow[];
  try {
    rows = await opts.git.statusMatrix({
      fs: trackRacyPaths(opts.fs, indexMetadata.mtimeMs, racyPaths),
      dir,
      cache: opts.cache,
      filepaths: specs,
    });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    return addFilepaths(opts, dir, opts.paths);
  }

  const toAdd = new Set<string>();
  const matched = new Set<string>();
  for (const [filepath, , workdir, stage] of rows) {
    const coveredSpecs = specs.filter((spec) => covers(spec, filepath));
    if (coveredSpecs.length === 0) continue;

    if (workdir !== 0) {
      for (const spec of coveredSpecs) matched.add(spec);
    }
    if (workdir === 0) continue;
    if (workdir !== stage) {
      toAdd.add(filepath);
      continue;
    }

    const fullpath = joinPath(dir, filepath);
    if (racyPaths.has(fullpath)) {
      toAdd.add(filepath);
      continue;
    }

    // Some injected clients ignore the fs argument. Preserve exact-file
    // behavior without turning a directory pathspec into a second tree walk.
    if (specs.includes(filepath)) {
      const fallbackMetadata = await readFileMetadata(opts.fs, fullpath);
      if (fallbackMetadata === undefined || isRacy(fallbackMetadata, indexMetadata.mtimeMs)) {
        toAdd.add(filepath);
      }
    }
  }

  if (toAdd.size > 0) await addFilepaths(opts, dir, [...toAdd]);

  const unmatched = opts.paths.filter((_path, index) => !matched.has(specs[index]));
  if (unmatched.length > 0) await addFilepaths(opts, dir, unmatched);
}

function normalizePathspec(path: string): string {
  const trimmed = path.replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}

function covers(spec: string, filepath: string): boolean {
  return spec === "." || spec === filepath || filepath.startsWith(`${spec}/`);
}

interface PromiseLstatFs {
  promises: {
    lstat(path: string): Promise<unknown>;
  };
}

interface PromiseFs {
  promises: object;
}

interface FileMetadata {
  mtimeMs: number;
}

function hasPromiseLstat(fs: object): fs is PromiseLstatFs {
  if (!("promises" in fs) || typeof fs.promises !== "object" || fs.promises === null) {
    return false;
  }
  return "lstat" in fs.promises && typeof fs.promises.lstat === "function";
}

function hasPromiseFs(fs: object): fs is PromiseFs {
  return "promises" in fs && typeof fs.promises === "object" && fs.promises !== null;
}

function trackRacyPaths(fs: object, indexMtimeMs: number, racyPaths: Map<string, true>): object {
  if (!hasPromiseFs(fs)) return fs;
  const trackedPromises = new Proxy(fs.promises, {
    get(target, property): unknown {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property !== "lstat") {
        return (...args: unknown[]) => Reflect.apply(value, target, args);
      }
      return async (...args: unknown[]): Promise<unknown> => {
        const result: unknown = await Reflect.apply(value, target, args);
        const [path] = args;
        const fileMetadata = statMetadata(result);
        if (
          typeof path === "string" &&
          fileMetadata !== undefined &&
          isRacy(fileMetadata, indexMtimeMs)
        ) {
          racyPaths.set(path, true);
        }
        return result;
      };
    },
  });
  return new Proxy(fs, {
    get(target, property): unknown {
      if (property === "promises") return trackedPromises;
      return Reflect.get(target, property, target);
    },
  });
}

function statMetadata(stat: unknown): FileMetadata | undefined {
  if (
    typeof stat !== "object" ||
    stat === null ||
    !("mtimeMs" in stat) ||
    typeof stat.mtimeMs !== "number"
  ) {
    return undefined;
  }
  return { mtimeMs: stat.mtimeMs };
}

function isRacy(metadata: FileMetadata, indexMtimeMs: number): boolean {
  return Math.floor(metadata.mtimeMs / 1000) >= Math.floor(indexMtimeMs / 1000);
}

async function readFileMetadata(fs: object, path: string): Promise<FileMetadata | undefined> {
  if (!hasPromiseLstat(fs)) return undefined;
  try {
    const stat = await fs.promises.lstat(path);
    return statMetadata(stat);
  } catch {
    return undefined;
  }
}

function joinPath(dir: string, path: string): string {
  return dir.endsWith("/") ? `${dir}${path}` : `${dir}/${path}`;
}

/**
 * Stage every working-tree change. Walks the status matrix and
 * splits the work: present-but-changed paths go through `add`,
 * worktree-deleted paths go through `remove` (which `add` cannot
 * express). The status-matrix tuple is `[path, head, workdir,
 * stage]`; `workdir === 0` means the file is gone from disk.
 */
async function addAll(opts: AddWithDeps, dir: string): Promise<void> {
  let matrix: StatusMatrixRow[];
  try {
    matrix = await opts.git.statusMatrix({ fs: opts.fs, dir, cache: opts.cache });
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EADDFAIL", `git add failed: ${errorMessage(cause)}`, { cause });
  }

  const toAdd: string[] = [];
  const toRemove: string[] = [];
  for (const [filepath, head, workdir, stage] of matrix) {
    // `commit -a` semantics: only touch paths already in HEAD,
    // so untracked files (head === 0) are left alone.
    if (opts.trackedOnly && head !== 1) continue;
    if (workdir === 0) {
      // Gone from the working tree. Remove any staged entry so
      // the index matches the absence on disk. trackedOnly above
      // keeps `commit -a` from touching staged-but-untracked paths.
      if (stage !== 0) toRemove.push(filepath);
      continue;
    }
    // Present on disk and differs from the staged copy.
    if (workdir !== 1 || stage !== 1) toAdd.push(filepath);
  }

  try {
    if (toAdd.length > 0) {
      await opts.git.add({
        fs: opts.fs,
        dir,
        filepath: toAdd,
        cache: opts.cache,
        force: opts.force,
      });
    }
    for (const filepath of toRemove) {
      await opts.git.remove({ fs: opts.fs, dir, filepath, cache: opts.cache });
    }
  } catch (cause) {
    if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
    throw new GitError("EADDFAIL", `git add failed: ${errorMessage(cause)}`, { cause });
  }
}

export interface GitRmOptions {
  /** Working-tree directory inside the VFS. Defaults to `/`. */
  dir?: string;
  /** Paths to unstage, relative to `dir`. */
  paths: string[];
}

export interface RmWithDeps extends GitRmOptions {
  git: IsomorphicGitRmClient;
  fs: object;
  cache?: object;
}

export async function rmWith(opts: RmWithDeps): Promise<void> {
  const dir = opts.dir ?? "/";
  for (const filepath of opts.paths) {
    try {
      await opts.git.remove({ fs: opts.fs, dir, filepath, cache: opts.cache });
    } catch (cause) {
      if (isNotARepositoryCause(cause)) throw new NotARepositoryError(dir, { cause });
      if (looksLikePathspecMiss(cause)) {
        throw new PathspecNotFoundError(filepath, { cause });
      }
      throw new GitError("ERMFAIL", `git rm failed: ${errorMessage(cause)}`, { cause });
    }
  }
}

function looksLikePathspecMiss(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  const m = cause.message.toLowerCase();
  return m.includes("could not find") || m.includes("not in the index") || m.includes("enoent");
}

function firstPathspec(paths: string[]): string {
  return paths[0] ?? "";
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
