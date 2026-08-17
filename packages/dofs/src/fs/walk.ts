import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import type { Database } from "../storage.js";
import { currentRev } from "../sync/watermarks.js";
import {
  type BulkPage,
  bulkRequestDigest,
  type WalkOptions,
  type WorkspaceWalkEntry,
} from "./publicBulk.js";
import { resolveInode } from "./resolve.js";
import { iteratePendingWriteBuffers, type WriteBufferEntry } from "./writeBuffer.js";

const MAX_LIMIT = 1000;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_EXCLUDES = 256;
const MAX_EXCLUDE_BYTES = 64 * 1024;
const MAX_TRAVERSAL_DEPTH = 1024;
const encoder = new TextEncoder();

interface WalkRow {
  inode: number;
  path: string;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  link_target: string | null;
  order_key: string;
  snapshot_rev: number;
}

type WalkCursor =
  | {
      rev: number;
      rootInode: number;
      mode: "flat" | "tree";
      afterKey: string;
      committedOffset: number;
      pendingOffset: number;
    }
  | {
      rev: number;
      rootInode: number;
      mode: "merged";
      traversal: "flat" | "tree";
      committedOffset: number;
      pendingOffset: number;
    };

interface AvailableEntry {
  entry: WorkspaceWalkEntry;
  orderKey: string;
  mode: "flat" | "tree";
  source: "committed" | "pending";
}

interface WalkCandidate extends WalkRow {
  source: "committed" | "pending";
}

export function walk(
  db: Database,
  directory: string,
  options: WalkOptions,
): BulkPage<WorkspaceWalkEntry> {
  validateOptions(directory, options);
  const { path: root } = canonicalizePath(directory);
  const exclude = options.exclude ?? [];
  const depth = options.depth ?? MAX_TRAVERSAL_DEPTH;
  const digest = bulkRequestDigest({
    root,
    limit: options.limit,
    maxBytes: options.maxBytes,
    depth: options.depth,
    exclude,
    excludeHidden: options.excludeHidden ?? false,
  });
  const decoded =
    options.cursor === undefined ? undefined : decodeWalkCursor(options.cursor, digest);
  if (options.cursor !== undefined && decoded === undefined) {
    throw createWorkspaceError("EINVAL", "invalid walk cursor", root);
  }
  const committedOffset = decoded?.committedOffset ?? 0;
  const pendingOffset = decoded?.pendingOffset ?? 0;
  const committedQueryOffset = decoded?.mode === "merged" ? committedOffset : 0;
  const pendingQueryOffset = decoded?.mode === "merged" ? pendingOffset : 0;
  const afterKey = decoded?.mode === "flat" || decoded?.mode === "tree" ? decoded.afterKey : "";

  const resolved = resolveInode(db, root);
  if (resolved === null) {
    throw createWorkspaceError("ENOENT", "no such path", root);
  }
  if (resolved.type !== "dir") {
    throw createWorkspaceError("ENOTDIR", "not a directory", root);
  }
  if (decoded !== undefined && decoded.rootInode !== resolved.inode) {
    throw createWorkspaceError("EINVAL", "invalid walk cursor", root);
  }
  const rootInode = resolved.inode;

  if (depth === 0) {
    const snapshotRev = currentRev(db);
    if (decoded !== undefined && decoded.rev !== snapshotRev) {
      throw createWorkspaceError("ESTALE", "walk cursor snapshot is stale", root);
    }
    return { entries: [] };
  }

  const directAfterName =
    decoded === undefined || (decoded.mode === "merged" && decoded.traversal === "flat")
      ? ""
      : decoded.mode === "flat"
        ? nameFromOrderKey(afterKey)
        : undefined;
  let forceMore = false;
  let rows: WalkRow[];
  if (directAfterName !== undefined) {
    rows = readDirectRows(
      db,
      rootInode,
      root,
      directAfterName,
      exclude,
      options.excludeHidden === true,
      options.limit + 1,
      committedQueryOffset,
    );
  } else {
    rows = db.all<WalkRow>(
      `WITH RECURSIVE tree(inode, path, type, mode, mtime, size, link_target, depth, order_key) AS (
       SELECT ?, ?, 'dir', ?, ?, 0, NULL, 0, ''
       UNION ALL
       SELECT n.inode,
              CASE WHEN t.path = '/' THEN '/' || d.name ELSE t.path || '/' || d.name END,
              n.type, n.mode, n.mtime, n.size, n.link_target,
              t.depth + 1,
              t.order_key || hex(CAST(d.name AS BLOB)) || '!'
         FROM tree t
         JOIN vfs_dirents d ON d.parent_inode = t.inode
         JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE t.type = 'dir'
          AND t.depth < ?
          AND (? = 0 OR substr(d.name, 1, 1) <> '.')
          AND NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE e.value = d.name)
          AND (? = '' OR
               t.order_key || hex(CAST(d.name AS BLOB)) || '!' > ? OR
               substr(?, 1, length(t.order_key || hex(CAST(d.name AS BLOB)) || '!')) =
                 t.order_key || hex(CAST(d.name AS BLOB)) || '!')
       ORDER BY 9
     )
     SELECT inode, path, type, mode, mtime, size, link_target, order_key,
            (SELECT v FROM vfs_meta WHERE k = 'rev') AS snapshot_rev
       FROM tree
      WHERE depth > 0 AND order_key > ?
      LIMIT ? OFFSET ?`,
      rootInode,
      root,
      resolved.mode,
      resolved.mtime,
      depth,
      options.excludeHidden === true ? 1 : 0,
      JSON.stringify(exclude),
      afterKey,
      afterKey,
      afterKey,
      afterKey,
      options.limit + 1,
      committedQueryOffset,
    );
  }
  const snapshotRev = rows[0]?.snapshot_rev ?? currentRev(db);
  if (decoded !== undefined && decoded.rev !== snapshotRev) {
    throw createWorkspaceError("ESTALE", "walk cursor snapshot is stale", root);
  }

  const pendingRows = readPendingRows(
    db,
    root,
    depth,
    exclude,
    options.excludeHidden === true,
    afterKey,
    pendingQueryOffset,
    options.limit + 1,
    snapshotRev,
  );
  const seenPaths = new Set(rows.map((row) => row.path));
  const candidates: WalkCandidate[] = rows.map((row) => ({ ...row, source: "committed" }));
  for (const row of pendingRows) {
    if (!seenPaths.has(row.path)) candidates.push({ ...row, source: "pending" });
  }
  candidates.sort((left, right) =>
    left.order_key < right.order_key ? -1 : left.order_key > right.order_key ? 1 : 0,
  );
  if (candidates.length > options.limit + 1) candidates.length = options.limit + 1;
  if (directAfterName !== undefined) {
    const firstDirectory = candidates.findIndex(
      (row, index) => index < options.limit && row.type === "dir",
    );
    if (firstDirectory >= 0) {
      forceMore = true;
      candidates.splice(firstDirectory + 1);
    }
  }

  const available: AvailableEntry[] = candidates.map((row) => {
    const entry: WorkspaceWalkEntry = {
      path: row.path,
      inode: row.inode,
      type: row.type,
      mode: row.mode,
      mtime: row.mtime,
      size: row.size,
    };
    if (row.link_target !== null) entry.linkTarget = row.link_target;
    return {
      entry,
      orderKey: row.order_key,
      mode: directAfterName === undefined || row.type === "dir" ? "tree" : "flat",
      source: row.source,
    };
  });

  const entries: WorkspaceWalkEntry[] = [];
  let nextCommittedOffset = committedOffset;
  let nextPendingOffset = pendingOffset;
  for (let index = 0; index < Math.min(options.limit, available.length); index += 1) {
    const availableEntry = available[index];
    const entry = availableEntry.entry;
    const candidateCommittedOffset =
      nextCommittedOffset + (availableEntry.source === "committed" ? 1 : 0);
    const candidatePendingOffset =
      nextPendingOffset + (availableEntry.source === "pending" ? 1 : 0);
    const hasMore = forceMore || index + 1 < available.length;
    const keyCursor = encodeWalkKeyCursor(
      snapshotRev,
      rootInode,
      digest,
      availableEntry.orderKey,
      availableEntry.mode,
      candidateCommittedOffset,
      candidatePendingOffset,
    );
    const candidate: BulkPage<WorkspaceWalkEntry> = {
      entries: [...entries, entry],
      ...(hasMore ? { cursor: keyCursor } : {}),
    };
    if (encoder.encode(JSON.stringify(candidate)).byteLength > options.maxBytes) {
      const offsetCandidate: BulkPage<WorkspaceWalkEntry> = {
        entries: [...entries, entry],
        ...(hasMore
          ? {
              cursor: encodeWalkMergedCursor(
                snapshotRev,
                rootInode,
                digest,
                availableEntry.mode,
                candidateCommittedOffset,
                candidatePendingOffset,
              ),
            }
          : {}),
      };
      if (encoder.encode(JSON.stringify(offsetCandidate)).byteLength > options.maxBytes) break;
    }
    entries.push(entry);
    nextCommittedOffset = candidateCommittedOffset;
    nextPendingOffset = candidatePendingOffset;
  }

  if (available.length > 0 && entries.length === 0) {
    throw createWorkspaceError("EINVAL", "walk maxBytes cannot fit the next entry", root);
  }
  const hasMore = forceMore || entries.length < available.length;
  const lastAvailable = available[entries.length - 1];
  const keyCursor =
    lastAvailable === undefined
      ? undefined
      : encodeWalkKeyCursor(
          snapshotRev,
          rootInode,
          digest,
          lastAvailable.orderKey,
          lastAvailable.mode,
          nextCommittedOffset,
          nextPendingOffset,
        );
  const page: BulkPage<WorkspaceWalkEntry> = {
    entries,
    ...(hasMore && keyCursor !== undefined ? { cursor: keyCursor } : {}),
  };
  if (encoder.encode(JSON.stringify(page)).byteLength > options.maxBytes) {
    const traversal =
      lastAvailable?.mode ??
      (decoded?.mode === "merged" ? decoded.traversal : (decoded?.mode ?? "flat"));
    page.cursor = encodeWalkMergedCursor(
      snapshotRev,
      rootInode,
      digest,
      traversal,
      nextCommittedOffset,
      nextPendingOffset,
    );
    if (encoder.encode(JSON.stringify(page)).byteLength > options.maxBytes) {
      throw createWorkspaceError("EINVAL", "walk maxBytes cannot fit the page cursor", root);
    }
  }
  return page;
}

function readPendingRows(
  db: Database,
  root: string,
  depth: number,
  exclude: readonly string[],
  excludeHidden: boolean,
  afterKey: string,
  offset: number,
  limit: number,
  snapshotRev: number,
): WalkRow[] {
  let pendingAfterKey = afterKey;
  for (let skipped = 0; skipped < offset; skipped += 1) {
    let next: WalkRow | undefined;
    for (const entry of iteratePendingWriteBuffers(db)) {
      const row = toPendingWalkRow(
        entry,
        root,
        depth,
        exclude,
        excludeHidden,
        pendingAfterKey,
        snapshotRev,
      );
      if (row !== undefined && (next === undefined || row.order_key < next.order_key)) next = row;
    }
    if (next === undefined) throw createWorkspaceError("EINVAL", "invalid walk cursor", root);
    pendingAfterKey = next.order_key;
  }

  const rows: WalkRow[] = [];
  for (const entry of iteratePendingWriteBuffers(db)) {
    const row = toPendingWalkRow(
      entry,
      root,
      depth,
      exclude,
      excludeHidden,
      pendingAfterKey,
      snapshotRev,
    );
    if (row === undefined) continue;
    const insertion = rows.findIndex((held) => held.order_key > row.order_key);
    if (insertion < 0) rows.push(row);
    else rows.splice(insertion, 0, row);
    if (rows.length > limit) rows.pop();
  }
  return rows;
}

function toPendingWalkRow(
  entry: WriteBufferEntry,
  root: string,
  depth: number,
  exclude: readonly string[],
  excludeHidden: boolean,
  afterKey: string,
  snapshotRev: number,
): WalkRow | undefined {
  const rootPrefix = root === "/" ? "/" : `${root}/`;
  const excluded = new Set(exclude);
  const pending = entry.pending;
  if (pending === undefined) return undefined;
  const sourcePath = pending.resolvedPath.startsWith(rootPrefix)
    ? pending.resolvedPath
    : pending.canonicalPath.startsWith(rootPrefix)
      ? pending.canonicalPath
      : undefined;
  if (sourcePath === undefined) return undefined;
  const relative = sourcePath.slice(rootPrefix.length);
  const parts = relative.split("/");
  if (
    parts.length > depth ||
    parts.some((part) => excluded.has(part) || (excludeHidden && part.startsWith(".")))
  ) {
    return undefined;
  }
  const orderKey = parts.map(encodeOrderPart).join("");
  if (orderKey <= afterKey) return undefined;
  return {
    inode: 0,
    path: root === "/" ? `/${relative}` : `${root}/${relative}`,
    type: "file",
    mode: entry.mode,
    mtime: pending.mtime,
    size: entry.size,
    link_target: null,
    order_key: orderKey,
    snapshot_rev: snapshotRev,
  };
}

function encodeOrderPart(part: string): string {
  let hex = "";
  for (const byte of encoder.encode(part)) hex += byte.toString(16).padStart(2, "0").toUpperCase();
  return `${hex}!`;
}

function encodeWalkKeyCursor(
  rev: number,
  rootInode: number,
  digest: string,
  afterKey: string,
  mode: "flat" | "tree",
  committedOffset: number,
  pendingOffset: number,
): string {
  const offsets = `${committedOffset.toString(36)}${pendingOffset === 0 ? "" : `.${pendingOffset.toString(36)}`}`;
  return `w:${rev.toString(36)}:${rootInode.toString(36)}:${mode === "flat" ? "f" : "t"}:${digest}:${afterKey}~${offsets}`;
}

function encodeWalkMergedCursor(
  rev: number,
  rootInode: number,
  digest: string,
  traversal: "flat" | "tree",
  committedOffset: number,
  pendingOffset: number,
): string {
  const traversalCode = traversal === "flat" ? "F" : "T";
  const offsets = `${committedOffset.toString(36)}${pendingOffset === 0 ? "" : `.${pendingOffset.toString(36)}`}`;
  return `w:${rev.toString(36)}:${rootInode.toString(36)}:${traversalCode}:${digest}:${offsets}`;
}

function decodeWalkCursor(cursor: string, digest: string): WalkCursor | undefined {
  const parts = cursor.split(":");
  if (parts.length !== 6 || parts[0] !== "w" || parts[4] !== digest) return undefined;
  const rev = parseBase36(parts[1]);
  const rootInode = parseBase36(parts[2]);
  if (rev === undefined || rootInode === undefined || rootInode < 1) return undefined;
  const keyed =
    parts[3] === "f" || parts[3] === "t"
      ? /^([0-9A-F!]*)~([0-9a-z]+)(?:\.([0-9a-z]+))?$/.exec(parts[5])
      : null;
  if (keyed !== null) {
    const committedOffset = parseBase36(keyed[2]);
    const pendingOffset = keyed[3] === undefined ? 0 : parseBase36(keyed[3]);
    if (committedOffset === undefined || pendingOffset === undefined) return undefined;
    return {
      rev,
      rootInode,
      mode: parts[3] === "f" ? "flat" : "tree",
      afterKey: keyed[1],
      committedOffset,
      pendingOffset,
    };
  }
  const merged =
    parts[3] === "F" || parts[3] === "T" ? /^([0-9a-z]+)(?:\.([0-9a-z]+))?$/.exec(parts[5]) : null;
  if (merged === null) return undefined;
  const committedOffset = parseBase36(merged[1]);
  const pendingOffset = merged[2] === undefined ? 0 : parseBase36(merged[2]);
  if (committedOffset === undefined || pendingOffset === undefined) return undefined;
  return {
    rev,
    rootInode,
    mode: "merged",
    traversal: parts[3] === "F" ? "flat" : "tree",
    committedOffset,
    pendingOffset,
  };
}

function nameFromOrderKey(key: string): string | undefined {
  if (!key.endsWith("!") || key.slice(0, -1).includes("!")) return undefined;
  const hex = key.slice(0, -1);
  if (hex.length % 2 !== 0) return undefined;
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const value = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isInteger(value)) return undefined;
    bytes[index] = value;
  }
  return new TextDecoder().decode(bytes);
}

function readDirectRows(
  db: Database,
  parentInode: number,
  root: string,
  afterName: string,
  exclude: readonly string[],
  excludeHidden: boolean,
  limit: number,
  offset: number,
): WalkRow[] {
  if (exclude.length === 0 && !excludeHidden) {
    return db.all<WalkRow>(
      `SELECT n.inode AS inode,
              CASE WHEN ? = '/' THEN '/' || d.name ELSE ? || '/' || d.name END AS path,
              n.type AS type, n.mode AS mode, n.mtime AS mtime, n.size AS size,
              n.link_target AS link_target,
              hex(CAST(d.name AS BLOB)) || '!' AS order_key,
              (SELECT v FROM vfs_meta WHERE k = 'rev') AS snapshot_rev
         FROM vfs_dirents d
         CROSS JOIN vfs_nodes n ON n.inode = d.child_inode
        WHERE d.parent_inode = ? AND d.name > ?
        ORDER BY d.name
        LIMIT ? OFFSET ?`,
      root,
      root,
      parentInode,
      afterName,
      limit,
      offset,
    );
  }
  return db.all<WalkRow>(
    `SELECT n.inode AS inode,
            CASE WHEN ? = '/' THEN '/' || d.name ELSE ? || '/' || d.name END AS path,
            n.type AS type, n.mode AS mode, n.mtime AS mtime, n.size AS size,
            n.link_target AS link_target,
            hex(CAST(d.name AS BLOB)) || '!' AS order_key,
            (SELECT v FROM vfs_meta WHERE k = 'rev') AS snapshot_rev
       FROM vfs_dirents d
       CROSS JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.parent_inode = ? AND d.name > ?
        AND (? = 0 OR substr(d.name, 1, 1) <> '.')
        AND NOT EXISTS (SELECT 1 FROM json_each(?) e WHERE e.value = d.name)
      ORDER BY d.name
      LIMIT ? OFFSET ?`,
    root,
    root,
    parentInode,
    afterName,
    excludeHidden ? 1 : 0,
    JSON.stringify(exclude),
    limit,
    offset,
  );
}

function parseBase36(value: string): number | undefined {
  if (!/^[0-9a-z]+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value, 36);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed.toString(36) === value
    ? parsed
    : undefined;
}

function validateOptions(path: string, options: WalkOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_LIMIT) {
    throw createWorkspaceError("EINVAL", "invalid walk limit", path);
  }
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MAX_PAGE_BYTES
  ) {
    throw createWorkspaceError("EINVAL", "invalid walk maxBytes", path);
  }
  if (
    options.depth !== undefined &&
    (!Number.isSafeInteger(options.depth) ||
      options.depth < 0 ||
      options.depth > MAX_TRAVERSAL_DEPTH)
  ) {
    throw createWorkspaceError("EINVAL", "invalid walk depth", path);
  }
  const exclude = options.exclude ?? [];
  if (exclude.length > MAX_EXCLUDES) {
    throw createWorkspaceError("EINVAL", "too many walk exclusions", path);
  }
  let bytes = 0;
  for (const name of exclude) bytes += encoder.encode(name).byteLength;
  if (bytes > MAX_EXCLUDE_BYTES) {
    throw createWorkspaceError("EINVAL", "walk exclusions are too large", path);
  }
}
