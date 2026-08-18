// SQLiteWorkspaceProvider — a @platformatic/vfs VirtualProvider backed
// by the dofs SQLite store.
//
// Every method on VirtualProvider is declared. Methods we already have
// synchronous building blocks for delegate to the existing fs/ helpers;
// the rest throw ENOSYS so the gaps are visible at the call site.
// Subsequent commits fill in the stubs (file descriptors, positional
// I/O, truncate, symlinks, watch).

import { createWorkspaceError } from "./errors.js";
import { link as linkImpl } from "./fs/link.js";
import type { MkdirOptions } from "./fs/mkdir.js";
import { mkdir as mkdirImpl } from "./fs/mkdir.js";
import { findPendingWriteBuffer } from "./fs/pendingWriteBuffer.js";
import { readdir as readdirImpl } from "./fs/readdir.js";
import { readRangeSync as readRangeSyncImpl, readWholeFileBytes } from "./fs/readFile.js";
import { readlink as readlinkImpl } from "./fs/readlink.js";
import { rename as renameImpl } from "./fs/rename.js";
import { resolveInode } from "./fs/resolve.js";
import { rm as rmImpl } from "./fs/rm.js";
import { stat as statImpl } from "./fs/stat.js";
import { symlink as symlinkImpl } from "./fs/symlink.js";
import {
  createWatchAsyncIterable,
  createWatcher,
  type WatchEvent,
  type WatchHandle,
  type WatchOptions,
} from "./fs/watch.js";
import { lookupWriteBatchPath } from "./fs/writeBatch.js";
import { deleteWriteBuffer, getWriteBuffer } from "./fs/writeBuffer.js";
import {
  createFileSync as createFileSyncImpl,
  flushPendingByPath,
  flushPendingUnderNode,
  openWriteBufferForCreateSync as openWriteBufferForCreateSyncImpl,
  openWriteBufferSync as openWriteBufferSyncImpl,
  releaseWriteBufferSync as releaseWriteBufferSyncImpl,
  truncateFileSync as truncateFileSyncImpl,
  type WriteFileRange,
  writeFileRangesSync as writeFileRangesSyncImpl,
  writeFileSync as writeFileSyncImpl,
  writeRangeSync as writeRangeSyncImpl,
} from "./fs/writeFile.js";
import { canonicalizePath } from "./path.js";
import { incrementRev } from "./rev.js";
import { assertDatabaseOpen, type Database, persistentDatabaseView } from "./storage.js";

export interface SQLiteWorkspaceProviderOptions {
  // Wall-clock source. Defaults to Date.now so production callers
  // don't need to thread one through; tests pin it.
  now?: () => number;
  // Poll interval for watch() in milliseconds. Defaults to 100 ms
  // to match node's fs.watch on most filesystems; tests can lower
  // it to keep durations short.
  watchIntervalMs?: number;
}

interface VirtualStatsLike {
  dev: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface VirtualDirentLike {
  name: string;
  parentPath: string;
  path: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}

interface FdState {
  path: string;
  position: number;
  readable: boolean;
  writable: boolean;
  // append mode pins every writeSync to current EOF rather than
  // honouring an explicit position argument.
  append: boolean;
}

interface ProviderState {
  readonly fds: Map<number, FdState>;
  readonly persistentDb: Database;
  nextFd: number;
}

const providerStates = new WeakMap<SQLiteWorkspaceProvider, ProviderState>();

function providerState(provider: SQLiteWorkspaceProvider): ProviderState {
  assertDatabaseOpen(provider.db);
  const state = providerStates.get(provider);
  if (state === undefined) throw new Error("SQLiteWorkspaceProvider state is unavailable");
  return state;
}

export class SQLiteWorkspaceProvider {
  readonly db: Database;
  readonly now: () => number;

  // Capability flags consulted by @platformatic/vfs callers.
  readonly readonly = false;
  readonly supportsSymlinks = true;
  readonly supportsWatch = true;

  readonly watchIntervalMs: number;

  constructor(db: Database, options: SQLiteWorkspaceProviderOptions = {}) {
    assertDatabaseOpen(db);
    this.db = db;
    this.now = options.now ?? Date.now;
    this.watchIntervalMs = options.watchIntervalMs ?? 100;
    // Start at 3 so descriptors cannot collide with stdio conventions.
    providerStates.set(this, {
      fds: new Map(),
      persistentDb: persistentDatabaseView(db),
      nextFd: 3,
    });
  }

  #assertOpen(): void {
    assertDatabaseOpen(this.db);
  }

  // -- Essential primitives ------------------------------------------

  open(path: string, flags?: string, mode?: number): Promise<number> {
    return Promise.resolve(this.openSync(path, flags, mode));
  }

  openSync(path: string, flags: string = "r", _mode?: number): number {
    this.#assertOpen();
    const { read, write, truncate, append, create, exclusive } = parseFlags(flags);
    const existing = resolveInode(this.db, path);

    if (existing === null) {
      if (!create) {
        throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
      }
      writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
    } else {
      if (existing.type !== "file") {
        throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
      }
      if (exclusive) {
        throw createWorkspaceError("EEXIST", `path exists: ${path}`, path);
      }
      if (truncate) {
        writeFileSyncImpl(this.db, path, new Uint8Array(), {}, this.now);
      }
    }

    const stat = statImpl(this.db, path);
    const state = providerState(this);
    const fd = state.nextFd++;
    state.fds.set(fd, {
      path,
      position: append ? stat.size : 0,
      readable: read,
      writable: write,
      append,
    });
    return fd;
  }

  stat(path: string, options?: { bigint?: boolean }): Promise<VirtualStatsLike> {
    return Promise.resolve(this.statSync(path, options));
  }

  statSync(path: string, _options?: { bigint?: boolean }): VirtualStatsLike {
    this.#assertOpen();
    const staged = lookupWriteBatchPath(this.db, path);
    if (staged?.kind === "entry") return wrapStagedStats(staged.value);
    if (staged?.kind === "absent") {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    return this.#statSync(this.db, path);
  }

  #statSync(db: Database, path: string): VirtualStatsLike {
    // statImpl resolves the path once (following symlinks) and returns
    // the inode, so nlink comes from the same walk. A pending-create
    // file reports inode 0, which yields nlink 1.
    const s = statImpl(db, path);
    return wrapStats({
      mode: s.mode,
      size: s.size,
      mtimeMs: s.mtime,
      ino: s.inode,
      isFile: s.isFile,
      isDirectory: s.isDirectory,
      isSymbolicLink: false,
      nlink: () => linkCount(db, s.inode),
    });
  }

  lstat(path: string, options?: { bigint?: boolean }): Promise<VirtualStatsLike> {
    return Promise.resolve(this.lstatSync(path, options));
  }

  lstatSync(path: string, _options?: { bigint?: boolean }): VirtualStatsLike {
    this.#assertOpen();
    const staged = lookupWriteBatchPath(this.db, path);
    if (staged?.kind === "entry") return wrapStagedStats(staged.value);
    if (staged?.kind === "absent") {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    const pending = findPendingWriteBuffer(this.db, path);
    if (pending !== undefined && pending.pending !== undefined) {
      return wrapStats({
        mode: pending.mode & 0o7777,
        size: pending.size,
        mtimeMs: pending.pending.mtime,
        ino: 0,
        isFile: true,
        isDirectory: false,
        isSymbolicLink: false,
        nlink: () => 1,
      });
    }
    const node = resolveInode(this.db, path, { followSymlinks: false });
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    const isSymlink = node.type === "symlink";
    const buffered = node.type === "file" ? getWriteBuffer(this.db, node.inode) : undefined;
    const size = isSymlink
      ? (node.linkTarget ?? "").length
      : node.type === "file"
        ? buffered?.dirty
          ? buffered.size
          : node.size
        : 0;
    return wrapStats({
      mode: node.mode,
      size,
      mtimeMs: node.mtime,
      ino: node.inode,
      isFile: node.type === "file",
      isDirectory: node.type === "dir",
      isSymbolicLink: isSymlink,
      nlink: () => linkCount(this.db, node.inode),
    });
  }

  readdir(
    path: string,
    options?: { withFileTypes?: boolean },
  ): Promise<string[] | VirtualDirentLike[]> {
    return Promise.resolve(this.readdirSync(path, options));
  }

  readdirSync(path: string, options?: { withFileTypes?: boolean }): string[] | VirtualDirentLike[] {
    this.#assertOpen();
    const entries = readdirImpl(this.db, path);
    if (options?.withFileTypes === true) {
      return entries.map((entry) => wrapDirent(entry));
    }
    return entries.map((entry) => entry.name);
  }

  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined> {
    return Promise.resolve(this.mkdirSync(path, options));
  }

  mkdirSync(path: string, options?: MkdirOptions): string | undefined {
    this.#assertOpen();
    mkdirImpl(this.db, path, options ?? {}, this.now);
    return undefined;
  }

  rmdir(path: string): Promise<void> {
    this.rmdirSync(path);
    return Promise.resolve();
  }

  rmdirSync(path: string): void {
    this.#assertOpen();
    flushPendingUnderNode(this.db, path, this.now);
    rmImpl(this.db, path, {});
  }

  unlink(path: string): Promise<void> {
    this.unlinkSync(path);
    return Promise.resolve();
  }

  unlinkSync(path: string): void {
    this.#assertOpen();
    // If a buffered create is still pending for this path, commit
    // it first so rm sees a real inode to unlink (and so the
    // resulting GC sees the orphaned blob, matching the non-buffered
    // shape). The buffer's open handles continue to address bytes
    // through the inode-keyed cache.
    flushPendingUnderNode(this.db, path, this.now);
    flushPendingByPath(this.db, path, this.now);
    // Capture the target inode before rm runs so we can evict its
    // write-buffer cache entry if rm removed the last link. Without
    // this, a release-after-unlink leaves the buffer dangling on a
    // dead inode and the eventual commit silently affects no rows.
    const target = resolveInode(this.db, path, { followSymlinks: false });
    rmImpl(this.db, path, {});
    if (target !== null) {
      const stillAlive = this.db.scalar<number>(
        "SELECT inode FROM vfs_nodes WHERE inode = ?",
        target.inode,
      );
      if (stillAlive === undefined) {
        deleteWriteBuffer(this.db, target.inode);
      }
    }
  }

  link(existingPath: string, newPath: string): Promise<void> {
    this.linkSync(existingPath, newPath);
    return Promise.resolve();
  }

  linkSync(existingPath: string, newPath: string): void {
    this.#assertOpen();
    // Commit a still-pending source before adding the second dirent,
    // otherwise link has nothing real to point at. Also commit a
    // still-pending destination: link's existence check looks at
    // dirents, so a pending buffer at newPath wouldn't trip it, and
    // the eventual release on that pending buffer would re-check the
    // dirent in commitPendingBuffer, throw EEXIST, drop the entry,
    // and silently lose the user's bytes.
    flushPendingByPath(this.db, existingPath, this.now);
    flushPendingByPath(this.db, newPath, this.now);
    linkImpl(this.db, existingPath, newPath);
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    this.renameSync(oldPath, newPath);
    return Promise.resolve();
  }

  renameSync(oldPath: string, newPath: string): void {
    this.#assertOpen();
    // Commit any still-pending creates at either end before the rename
    // touches dirents: the source needs a real inode to move, and a
    // pending buffer at the destination would otherwise slip past
    // rename's dirent-based existence check and lose bytes on release.
    flushPendingUnderNode(this.db, oldPath, this.now);
    flushPendingUnderNode(this.db, newPath, this.now);
    flushPendingByPath(this.db, oldPath, this.now);
    flushPendingByPath(this.db, newPath, this.now);
    // Capture the destination inode before the rename so we can evict
    // its write-buffer cache entry if the rename displaced and reaped
    // it. Without this, a release on an open destination would commit
    // chunks against a dead inode (0-row UPDATE, silent data loss).
    const displaced = resolveInode(this.db, newPath, { followSymlinks: false });
    renameImpl(this.db, oldPath, newPath);
    if (displaced !== null) {
      const stillAlive = this.db.scalar<number>(
        "SELECT inode FROM vfs_nodes WHERE inode = ?",
        displaced.inode,
      );
      if (stillAlive === undefined) {
        deleteWriteBuffer(this.db, displaced.inode);
      }
    }
  }

  // -- Default implementations ---------------------------------------

  readFile(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Promise<Buffer | string> {
    return Promise.resolve(this.readFileSync(path, options));
  }

  readFileSync(
    path: string,
    options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
  ): Buffer | string {
    this.#assertOpen();
    const encoding = typeof options === "string" ? options : options?.encoding;
    const pending = findPendingWriteBuffer(this.db, path);
    if (pending !== undefined) {
      const snapshot = Buffer.alloc(pending.size);
      snapshot.set(pending.buf.subarray(0, pending.size));
      return encoding ? snapshot.toString(encoding) : snapshot;
    }
    const node = resolveInode(this.db, path);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such file: ${path}`, path);
    }
    if (node.type !== "file") {
      throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
    }
    // While a buffer is open for this inode it owns the latest
    // bytes; serve from it instead of the chunk store.
    const buffered = getWriteBuffer(this.db, node.inode);
    if (buffered?.dirty) {
      const snapshot = Buffer.alloc(buffered.size);
      snapshot.set(buffered.buf.subarray(0, buffered.size));
      return encoding ? snapshot.toString(encoding) : snapshot;
    }
    const bytes = readWholeFileBytes(this.db, path, node.inode, node.size);
    const out = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return encoding ? out.toString(encoding) : out;
  }

  writeFile(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): Promise<void> {
    this.writeFileSync(path, data, options);
    return Promise.resolve();
  }

  writeFileSync(
    path: string,
    data: string | Buffer,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    this.#assertOpen();
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    writeFileSyncImpl(this.db, path, bytes, { mode }, this.now);
  }

  writeFileRangesSync(
    path: string,
    data: string | Buffer,
    ranges: WriteFileRange[],
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    this.#assertOpen();
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    writeFileRangesSyncImpl(this.db, path, bytes, ranges, { mode }, this.now);
  }

  createFileSync(path: string, options?: { mode?: number }): void {
    this.#assertOpen();
    createFileSyncImpl(this.db, path, { mode: options?.mode }, this.now);
  }

  writeRangeSync(
    path: string,
    data: string | Buffer | Uint8Array,
    offset: number,
    options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): number {
    this.#assertOpen();
    const mode = typeof options === "string" ? undefined : options?.mode;
    const bytes =
      typeof data === "string"
        ? new TextEncoder().encode(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return writeRangeSyncImpl(this.db, path, bytes, offset, { mode }, this.now);
  }

  truncateFileSync(path: string, len: number): void {
    this.#assertOpen();
    truncateFileSyncImpl(this.db, path, len, this.now);
  }

  openWriteBufferSync(path: string): void {
    this.#assertOpen();
    openWriteBufferSyncImpl(this.db, path);
  }

  openWriteBufferForCreateSync(path: string, options?: { mode?: number }): void {
    this.#assertOpen();
    openWriteBufferForCreateSyncImpl(this.db, path, { mode: options?.mode }, this.now);
  }

  releaseWriteBufferSync(path: string): void {
    this.#assertOpen();
    releaseWriteBufferSyncImpl(this.db, path, this.now);
  }

  chmodSync(path: string, mode: number): void {
    this.#assertOpen();
    const pending = findPendingWriteBuffer(this.db, path);
    if (pending !== undefined) {
      // Pending-create files don't have a row yet; stash the mode on
      // the buffer so the eventual INSERT picks it up.
      pending.mode = mode & 0o7777;
      return;
    }
    const node = resolveInode(this.db, path, { followSymlinks: false });
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    const rev = incrementRev(this.db);
    this.db.run(
      "UPDATE vfs_nodes SET mode = ?, rev = ? WHERE inode = ?",
      mode & 0o7777,
      rev,
      node.inode,
    );
  }

  appendFile(
    _path: string,
    _data: string | Buffer,
    _options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): Promise<void> {
    this.#assertOpen();
    return Promise.reject(notImplemented("appendFile"));
  }

  appendFileSync(
    _path: string,
    _data: string | Buffer,
    _options?: { encoding?: BufferEncoding; mode?: number } | BufferEncoding,
  ): void {
    this.#assertOpen();
    throw notImplemented("appendFileSync");
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(path));
  }

  existsSync(path: string): boolean {
    this.#assertOpen();
    try {
      if (findPendingWriteBuffer(this.db, path) !== undefined) return true;
      return resolveInode(this.db, path) !== null;
    } catch {
      return false;
    }
  }

  copyFile(_src: string, _dest: string, _mode?: number): Promise<void> {
    this.#assertOpen();
    return Promise.reject(notImplemented("copyFile"));
  }

  copyFileSync(_src: string, _dest: string, _mode?: number): void {
    this.#assertOpen();
    throw notImplemented("copyFileSync");
  }

  internalModuleStat(_path: string): number {
    this.#assertOpen();
    // Used by node:vfs module-resolution hooks. The computerd driver doesn't
    // need it; if this provider is ever mounted via `vfs.mount()` we'll
    // need to return 0 for files, 1 for dirs, -1 for not-found.
    throw notImplemented("internalModuleStat");
  }

  realpath(path: string, _options?: { encoding?: BufferEncoding }): Promise<string> {
    return Promise.resolve(this.realpathSync(path));
  }

  realpathSync(path: string, _options?: { encoding?: BufferEncoding }): string {
    this.#assertOpen();
    const { path: canonical } = canonicalizePath(path);
    if (resolveInode(this.db, canonical) === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    return canonical;
  }

  access(path: string, _mode?: number): Promise<void> {
    this.accessSync(path);
    return Promise.resolve();
  }

  accessSync(path: string, _mode?: number): void {
    this.#assertOpen();
    if (resolveInode(this.db, path) === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
  }

  // -- File descriptors ----------------------------------------------

  closeSync(fd: number): void {
    this.#assertOpen();
    if (!providerState(this).fds.delete(fd)) {
      throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
    }
  }

  readSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): number {
    this.#assertOpen();
    const state = this.#fdOrThrow(fd);
    if (!state.readable) {
      throw createWorkspaceError("EBADF", `fd ${fd} is not readable`);
    }
    const startAt = position ?? state.position;
    const slice = readRangeSyncImpl(providerState(this).persistentDb, state.path, startAt, length);
    const view =
      buffer instanceof Buffer
        ? buffer
        : Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    view.set(slice, offset);
    if (position === null || position === undefined) {
      state.position = startAt + slice.byteLength;
    }
    return slice.byteLength;
  }

  readRangeSync(path: string, offset: number, length: number): Buffer {
    this.#assertOpen();
    const slice = readRangeSyncImpl(this.db, path, offset, length);
    return Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength);
  }

  writeSync(
    fd: number,
    buffer: Buffer | Uint8Array,
    offset: number = 0,
    length: number = buffer.byteLength - offset,
    position: number | null = null,
  ): number {
    this.#assertOpen();
    const state = this.#fdOrThrow(fd);
    if (!state.writable) {
      throw createWorkspaceError("EBADF", `fd ${fd} is not writable`);
    }
    // Append needs the current EOF, so stat only then. A non-append
    // write of >0 bytes doesn't need it: writeRangeSyncImpl resolves the
    // path and raises ENOENT/EISDIR. A zero-length write short-circuits
    // before that resolve, so keep an explicit existence check for it.
    let startAt: number;
    const persistentDb = providerState(this).persistentDb;
    if (state.append) {
      startAt = this.#statSync(persistentDb, state.path).size;
    } else {
      if (length === 0) {
        this.#statSync(persistentDb, state.path);
      }
      startAt = position ?? state.position;
    }
    const view =
      buffer instanceof Buffer
        ? new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length)
        : new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
    writeRangeSyncImpl(persistentDb, state.path, view, startAt, {}, this.now);
    if (position === null || position === undefined) {
      state.position = startAt + length;
    }
    return length;
  }

  fstatSync(fd: number, _options?: { bigint?: boolean }): VirtualStatsLike {
    this.#assertOpen();
    const state = this.#fdOrThrow(fd);
    return this.#statSync(providerState(this).persistentDb, state.path);
  }

  truncateSync(path: string, len: number): void {
    this.#assertOpen();
    this.#truncateSync(this.db, path, len);
  }

  #truncateSync(db: Database, path: string, len: number): void {
    const node = resolveInode(db, path);
    if (node === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${path}`, path);
    }
    if (node.type !== "file") {
      throw createWorkspaceError("EISDIR", `path is a directory: ${path}`, path);
    }
    truncateFileSyncImpl(db, path, len, this.now);
  }

  ftruncateSync(fd: number, len: number): void {
    this.#assertOpen();
    const state = this.#fdOrThrow(fd);
    this.#truncateSync(providerState(this).persistentDb, state.path, len);
  }

  #fdOrThrow(fd: number): FdState {
    const state = providerState(this).fds.get(fd);
    if (state === undefined) {
      throw createWorkspaceError("EBADF", `unknown fd ${fd}`);
    }
    return state;
  }

  // -- Symlinks ------------------------------------------------------

  readlink(path: string, _options?: { encoding?: BufferEncoding }): Promise<string> {
    return Promise.resolve(this.readlinkSync(path));
  }

  readlinkSync(path: string, _options?: { encoding?: BufferEncoding }): string {
    this.#assertOpen();
    return readlinkImpl(this.db, path);
  }

  symlink(target: string, path: string, _type?: string): Promise<void> {
    this.symlinkSync(target, path);
    return Promise.resolve();
  }

  symlinkSync(target: string, path: string, _type?: string): void {
    this.#assertOpen();
    symlinkImpl(this.db, target, path, this.now);
  }

  // -- Watch ----------------------------------------------------------
  //
  // The watcher polls vfs_meta.rev on a timer. Each tick
  // coalesceChanges yields every path touched since the last
  // observed rev; we filter by the watched directory (and
  // recursive flag) and emit one 'change' event per path. Cheap
  // because coalesceChanges is one indexed range scan on
  // vfs_nodes.rev plus a path walk per touched inode.
  //
  // Event types follow node's fs.watch convention:
  //   - 'rename' for deletes (path went away)
  //   - 'change' for everything else (file/dir/symlink mutation)
  // We don't distinguish first-time creation from in-place edit
  // — the cost is a per-watcher state map that's bigger than
  // the signal is worth. Callers that need rename-vs-change
  // semantics can stat the path themselves.

  watch(path: string, options: WatchOptions = {}): WatchHandle {
    this.#assertOpen();
    return createWatcher(providerState(this).persistentDb, path, options, this.watchIntervalMs);
  }

  watchAsync(path: string, options: WatchOptions = {}): AsyncIterable<WatchEvent> {
    return createWatchAsyncIterable(this.watch(path, options));
  }

  // watchFile / unwatchFile fire on stat changes at a single path
  // (not the directory under it). Different semantics from watch();
  // editors typically use watch() instead. Leave as ENOSYS until a
  // real call site shows up.
  watchFile(
    _path: string,
    _options?: unknown,
    _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void,
  ): unknown {
    this.#assertOpen();
    throw notImplemented("watchFile");
  }

  unwatchFile(
    _path: string,
    _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void,
  ): void {
    this.#assertOpen();
    throw notImplemented("unwatchFile");
  }
}

export function createProviderOperationView(
  provider: SQLiteWorkspaceProvider,
  db: Database,
): SQLiteWorkspaceProvider {
  const view = new SQLiteWorkspaceProvider(db, {
    now: provider.now,
    watchIntervalMs: provider.watchIntervalMs,
  });
  providerStates.set(view, providerState(provider));
  return view;
}

function notImplemented(method: string) {
  return createWorkspaceError("ENOSYS", `SQLiteWorkspaceProvider.${method} is not implemented yet`);
}

// -- VirtualStats / VirtualDirent shim ------------------------------
//
// @platformatic/vfs callers (and FUSE drivers built on top) consult
// the full Node-style stat shape. Most fields don't map onto our
// content-addressed store, so they get sensible constants. The fields
// that do map — mode, size, mtime, ino — are populated for real.

interface StatsInputs {
  mode: number;
  size: number;
  mtimeMs: number;
  ino: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  nlink: () => number;
}

function wrapStagedStats(input: {
  mode: number;
  mtime: number;
  size: number;
  type: "dir" | "file";
}): VirtualStatsLike {
  return wrapStats({
    mode: input.mode,
    size: input.size,
    mtimeMs: input.mtime,
    ino: 0,
    isFile: input.type === "file",
    isDirectory: input.type === "dir",
    isSymbolicLink: false,
    nlink: () => 1,
  });
}

// POSIX mode-bit constants. Linux FUSE rejects a stat whose mode
// has no S_IF* bits set with EIO — it can't decide whether
// the inode is a regular file, a directory, or a symlink.
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

function fileTypeBits(input: StatsInputs): number {
  if (input.isDirectory) return S_IFDIR;
  if (input.isSymbolicLink) return S_IFLNK;
  if (input.isFile) return S_IFREG;
  return 0;
}

function linkCount(db: Database, inode: number): number {
  const count = db.scalar<number>("SELECT COUNT(*) FROM vfs_dirents WHERE child_inode = ?", inode);
  return Math.max(1, count ?? 0);
}

function wrapStats(input: StatsInputs): VirtualStatsLike {
  const mtime = new Date(input.mtimeMs);
  let nlink: number | undefined;
  return {
    dev: 0,
    mode: (input.mode & 0o7777) | fileTypeBits(input),
    get nlink() {
      if (nlink === undefined) nlink = input.nlink();
      return nlink;
    },
    uid: 0,
    gid: 0,
    rdev: 0,
    blksize: 4096,
    ino: input.ino,
    size: input.size,
    blocks: Math.ceil(input.size / 512),
    atimeMs: input.mtimeMs,
    mtimeMs: input.mtimeMs,
    ctimeMs: input.mtimeMs,
    birthtimeMs: input.mtimeMs,
    atime: mtime,
    mtime,
    ctime: mtime,
    birthtime: mtime,
    isFile: () => input.isFile,
    isDirectory: () => input.isDirectory,
    isSymbolicLink: () => input.isSymbolicLink,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

interface DirentInput {
  name: string;
  parentPath: string;
  isFile: boolean;
  isDirectory: boolean;
}

function wrapDirent(input: DirentInput): VirtualDirentLike {
  const fullPath =
    input.parentPath === "/" ? `/${input.name}` : `${input.parentPath}/${input.name}`;
  return {
    name: input.name,
    parentPath: input.parentPath,
    path: fullPath,
    isFile: () => input.isFile,
    isDirectory: () => input.isDirectory,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

interface ParsedFlags {
  read: boolean;
  write: boolean;
  create: boolean;
  truncate: boolean;
  append: boolean;
  exclusive: boolean;
}

// Translate Node's fs flag strings into the boolean flag set the fd
// table uses. Mirrors the documented behaviour of fs.open(flags) at
// https://nodejs.org/api/fs.html#file-system-flags.
function parseFlags(flags: string): ParsedFlags {
  switch (flags) {
    case "r":
      return {
        read: true,
        write: false,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "r+":
      return {
        read: true,
        write: true,
        create: false,
        truncate: false,
        append: false,
        exclusive: false,
      };
    case "w":
      return {
        read: false,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "w+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: true,
        append: false,
        exclusive: false,
      };
    case "wx":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "wx+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: false,
        exclusive: true,
      };
    case "a":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "a+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: false,
      };
    case "ax":
      return {
        read: false,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    case "ax+":
      return {
        read: true,
        write: true,
        create: true,
        truncate: false,
        append: true,
        exclusive: true,
      };
    default:
      throw createWorkspaceError("EINVAL", `unsupported fs flag: ${flags}`);
  }
}
