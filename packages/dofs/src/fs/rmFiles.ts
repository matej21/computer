import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import { pathOf } from "../sync/paths.js";
import { assertNotReadOnly } from "./mount-guard.js";
import type { RmFilesOptions } from "./publicBulk.js";
import { resolveMany } from "./resolve.js";
import { type RemovalRoot, removeRootSet } from "./rm.js";
import { listWriteBufferEntries } from "./writeBuffer.js";

const MAX_ENTRIES = 10_000;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

interface TargetRow {
  requestIndex: number;
  inode: number | null;
  type: "file" | "dir" | "symlink" | null;
  childCount: number;
}

interface ResolvedRequest {
  requestIndex: number;
  parentInode: number | null;
  name: string;
}

interface ExpandedRow {
  inode: number;
  type: "file" | "dir" | "symlink";
  path: string;
  parentInode: number;
  name: string;
}

export function rmFiles(db: Database, paths: readonly string[], options: RmFilesOptions): void {
  validateRawRequest(paths, options);
  const canonical = paths.map((path) => canonicalizePath(path));
  for (const entry of canonical) {
    if (entry.parts.length === 0) {
      throw createWorkspaceError("EPERM", "cannot remove the root directory", entry.path);
    }
    assertNotReadOnly(db, entry.path);
  }
  if (canonical.length === 0) return;

  db.transactionSync(() => {
    const parentPaths = canonical.map((entry) =>
      entry.parts.length === 1 ? "/" : `/${entry.parts.slice(0, -1).join("/")}`,
    );
    const uniqueParentPaths = [...new Set(parentPaths)];
    const parentNodes = resolveMany(db, uniqueParentPaths);
    const parentByPath = new Map(
      uniqueParentPaths.map((path, index) => [path, parentNodes[index]]),
    );
    const requests: ResolvedRequest[] = canonical.map((entry, index) => {
      const parent = parentByPath.get(parentPaths[index]);
      return {
        requestIndex: index,
        parentInode: parent?.type === "dir" ? parent.inode : null,
        name: entry.parts[entry.parts.length - 1],
      };
    });
    const targets = db.all<TargetRow>(
      `WITH requests AS (
         SELECT json_extract(value, '$.requestIndex') AS requestIndex,
                json_extract(value, '$.parentInode') AS parentInode,
                json_extract(value, '$.name') AS name
           FROM json_each(?)
       )
       SELECT r.requestIndex AS requestIndex,
              n.inode AS inode,
              n.type AS type,
              CASE WHEN n.type = 'dir'
                   THEN (SELECT COUNT(*) FROM vfs_dirents child WHERE child.parent_inode = n.inode)
                   ELSE 0 END AS childCount
         FROM requests r
         LEFT JOIN vfs_dirents d ON d.parent_inode = r.parentInode AND d.name = r.name
         LEFT JOIN vfs_nodes n ON n.inode = d.child_inode
        ORDER BY r.requestIndex`,
      JSON.stringify(requests),
    );

    const realParents = new Map<number, string>();
    const rootsByDirent = new Map<string, RemovalRoot>();
    for (const target of targets) {
      const request = requests[target.requestIndex];
      const requestedPath = canonical[target.requestIndex].path;
      if (request.parentInode === null || target.inode === null || target.type === null) {
        if (options.force === true) continue;
        throw createWorkspaceError("ENOENT", `no such path: ${requestedPath}`, requestedPath);
      }
      if (target.type === "dir" && options.recursive !== true && target.childCount > 0) {
        throw createWorkspaceError(
          "ENOTEMPTY",
          `directory not empty: ${requestedPath}`,
          requestedPath,
        );
      }
      let realParent = realParents.get(request.parentInode);
      if (realParent === undefined) {
        const resolved = pathOf(db, request.parentInode);
        if (resolved === null) {
          throw createWorkspaceError("ENOENT", `no such path: ${requestedPath}`, requestedPath);
        }
        realParent = resolved;
        realParents.set(request.parentInode, realParent);
      }
      const realPath = realParent === "/" ? `/${request.name}` : `${realParent}/${request.name}`;
      assertNotReadOnly(db, realPath);
      rootsByDirent.set(`${request.parentInode}\0${request.name}`, {
        inode: target.inode,
        type: target.type,
        path: realPath,
        parentInode: request.parentInode,
        name: request.name,
      });
    }
    const roots = [...rootsByDirent.values()];
    if (roots.length === 0) return;

    const expanded = discoverRemovalSet(db, roots, options.maxEntries + 1);
    let metadataBytes = 0;
    for (const entry of expanded) metadataBytes += encoder.encode(entry.path).byteLength;
    preflightRemovalBudget(db, roots, expanded, metadataBytes, options);

    const rev = incrementRev(db);
    removeRootSet(db, roots, expanded, rev);
  });
}

function preflightRemovalBudget(
  db: Database,
  roots: readonly RemovalRoot[],
  expanded: readonly ExpandedRow[],
  expandedMetadataBytes: number,
  options: RmFilesOptions,
): void {
  let entries = expanded.length;
  let metadataBytes = expandedMetadataBytes;
  if (entries > options.maxEntries) {
    throw createWorkspaceError("EINVAL", "rmFiles expansion exceeds maxEntries");
  }
  if (metadataBytes > options.maxMetadataBytes) {
    throw createWorkspaceError("EINVAL", "rmFiles expansion exceeds maxMetadataBytes");
  }

  const persistedPaths = new Set(expanded.map((entry) => entry.path));
  const rootPaths = new Set(roots.map((root) => root.path));
  const pendingInodes = new Set<number>();
  const pendingPaths = new Set<string>();
  for (const { inode, entry } of listWriteBufferEntries(db)) {
    const pendingPath = entry.pending?.resolvedPath;
    if (
      pendingPath === undefined ||
      persistedPaths.has(pendingPath) ||
      pendingInodes.has(inode) ||
      pendingPaths.has(pendingPath) ||
      !hasRemovalRoot(pendingPath, rootPaths)
    ) {
      continue;
    }
    pendingInodes.add(inode);
    pendingPaths.add(pendingPath);
    entries += 1;
    metadataBytes += encoder.encode(pendingPath).byteLength;
    if (entries > options.maxEntries) {
      throw createWorkspaceError("EINVAL", "rmFiles expansion exceeds maxEntries");
    }
    if (metadataBytes > options.maxMetadataBytes) {
      throw createWorkspaceError("EINVAL", "rmFiles expansion exceeds maxMetadataBytes");
    }
  }
}

function hasRemovalRoot(path: string, roots: ReadonlySet<string>): boolean {
  let candidate = path;
  while (candidate !== "/") {
    if (roots.has(candidate)) return true;
    const separator = candidate.lastIndexOf("/");
    candidate = separator === 0 ? "/" : candidate.slice(0, separator);
  }
  return roots.has("/");
}

function discoverRemovalSet(
  db: Database,
  roots: readonly RemovalRoot[],
  candidateLimit: number,
): ExpandedRow[] {
  return db.all<ExpandedRow>(
    `WITH RECURSIVE
       roots(inode, type, path, parentInode, name) AS (
         SELECT json_extract(value, '$.inode'),
                json_extract(value, '$.type'),
                json_extract(value, '$.path'),
                json_extract(value, '$.parentInode'),
                json_extract(value, '$.name')
           FROM json_each(?)
       ),
       subtree(inode, type, path, parentInode, name) AS (
         SELECT inode, type, path, parentInode, name FROM roots
         UNION
         SELECT n.inode, n.type,
                CASE WHEN s.path = '/' THEN '/' || d.name ELSE s.path || '/' || d.name END,
                d.parent_inode, d.name
           FROM subtree s
           JOIN vfs_dirents d ON d.parent_inode = s.inode
           JOIN vfs_nodes n ON n.inode = d.child_inode
          WHERE s.type = 'dir'
          LIMIT ?
       )
     SELECT inode, type, path, parentInode, name FROM subtree ORDER BY path`,
    JSON.stringify(roots),
    candidateLimit,
  );
}

function validateRawRequest(paths: readonly string[], options: RmFilesOptions): void {
  if (
    !Number.isSafeInteger(options.maxEntries) ||
    options.maxEntries < 1 ||
    options.maxEntries > MAX_ENTRIES ||
    !Number.isSafeInteger(options.maxMetadataBytes) ||
    options.maxMetadataBytes < 1 ||
    options.maxMetadataBytes > MAX_METADATA_BYTES
  ) {
    throw createWorkspaceError("EINVAL", "invalid rmFiles bounds");
  }
  if (paths.length > options.maxEntries) {
    throw createWorkspaceError("EINVAL", "too many rmFiles paths");
  }
  let metadataBytes = 0;
  for (const path of paths) metadataBytes += encoder.encode(path).byteLength;
  if (metadataBytes > options.maxMetadataBytes) {
    throw createWorkspaceError("EINVAL", "rmFiles paths exceed maxMetadataBytes");
  }
}
