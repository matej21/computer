import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { ROOT_INODE } from "../schema/index.js";
import type { Database } from "../storage.js";
import { lookupAdaptiveDirectoryChild, lookupCompleteDirectoryChild } from "./metadataPrefetch.js";
import {
  lookupOperationNodeCache,
  lookupResolveCache,
  storeOperationNodeCache,
  storeOperationStructuralNode,
  storeResolveCache,
} from "./resolveCache.js";
import { flushWriteBatchBeforePathRead } from "./writeBatch.js";

export interface ResolvedInode {
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  // Cached file size from vfs_nodes.size. Always 0 for directories
  // and symlinks; for files this matches SUM(vfs_chunks.size) for
  // the inode. Stat callers consume it directly instead of doing a
  // separate aggregate query.
  size: number;
  // Populated only when type === "symlink". Higher layers (readlink,
  // lstat) consume this; resolveInode follows it transparently unless
  // the caller asks otherwise.
  linkTarget?: string;
}

export interface ResolveOptions {
  // Default true. Pass false to land on a symlink itself — the
  // lstat / readlink code paths rely on this. Loops are still
  // detected when following.
  followSymlinks?: boolean;
}

interface ManyCteRow extends CteRow {
  pid: number;
}

const MANY_QUERY = `
WITH RECURSIVE
  paths(pid, segs, depth) AS (
    SELECT key, value, json_array_length(value) FROM json_each(?)
  ),
  walk(pid, segs, depth, level, inode, type, mode, mtime, size, link_target) AS (
    SELECT p.pid, p.segs, p.depth, 0,
           n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
      FROM paths p JOIN vfs_nodes n ON n.inode = ?
    UNION ALL
    SELECT w.pid, w.segs, w.depth, w.level + 1,
           n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
      FROM walk w
      JOIN vfs_dirents d
        ON d.parent_inode = w.inode
       AND d.name = json_extract(w.segs, '$[' || w.level || ']')
      JOIN vfs_nodes n ON n.inode = d.child_inode
     WHERE w.type = 'dir' AND w.level < w.depth
  )
SELECT pid, level, inode, type, mode, mtime, size, link_target
  FROM walk ORDER BY pid, level`;

export function resolveMany(db: Database, paths: readonly string[]): (ResolvedInode | null)[] {
  if (paths.length === 0) return [];
  const prepared = paths.map((path) => canonicalizePath(path));
  const pending = prepared.map((entry, index) => ({
    index,
    parts: entry.parts,
    follows: 0,
    followed: false,
  }));
  const results = new Array<ResolvedInode | null>(prepared.length).fill(null);

  while (pending.length > 0) {
    const uniqueParts: string[][] = [];
    const uniqueIds = new Map<string, number>();
    const pendingIds: number[] = [];
    for (const entry of pending) {
      const key = JSON.stringify(entry.parts);
      let id = uniqueIds.get(key);
      if (id === undefined) {
        id = uniqueParts.length;
        uniqueIds.set(key, id);
        uniqueParts.push(entry.parts);
      }
      pendingIds.push(id);
    }
    const rows = db.all<ManyCteRow>(MANY_QUERY, JSON.stringify(uniqueParts), ROOT_INODE);
    const byPath = new Map<number, ManyCteRow[]>();
    for (const row of rows) {
      const held = byPath.get(row.pid);
      if (held === undefined) byPath.set(row.pid, [row]);
      else held.push(row);
    }

    const next: typeof pending = [];
    for (const [pendingIndex, entry] of pending.entries()) {
      const walked = byPath.get(pendingIds[pendingIndex]) ?? [];
      const link = walked.find((row) => row.level >= 1 && row.type === "symlink");
      if (link !== undefined) {
        const follows = entry.follows + 1;
        if (follows > MAX_SYMLINK_FOLLOWS) {
          throw createWorkspaceError("ELOOP", "too many symlinks resolving path");
        }
        next.push({
          index: entry.index,
          parts: expandSymlinkParts(entry.parts, link.level, link.link_target ?? ""),
          follows,
          followed: true,
        });
        continue;
      }
      const target = walked.find((row) => row.level === entry.parts.length);
      const node = target === undefined ? null : toResolved(target);
      results[entry.index] = node;
      if (!entry.followed) {
        storeResolveCache(db, prepared[entry.index].path, node === null ? null : node.inode);
      }
      if (node !== null) storeResolvedNode(db, node);
    }
    pending.splice(0, pending.length, ...next);
  }

  return results;
}

function expandSymlinkParts(parts: readonly string[], level: number, target: string): string[] {
  const expanded = target.startsWith("/") ? [] : parts.slice(0, level - 1);
  for (const part of [...target.split("/"), ...parts.slice(level)]) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      expanded.pop();
    } else {
      expanded.push(part);
    }
  }
  return expanded;
}

interface NodeRow {
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  link_target: string | null;
}

interface ChildRow {
  child_inode: number;
}

// Cap the total number of symlinks resolved across a single
// resolveInode() call. Matches Linux's default SYMLOOP_MAX of 40.
const MAX_SYMLINK_FOLLOWS = 40;

// Walk vfs_dirents from ROOT_INODE down to `path`. Returns null when
// any segment is missing, when an intermediate segment is a file
// (which a real filesystem would surface as ENOTDIR — callers map
// the `null` to the appropriate POSIX code), or when a final-segment
// symlink dangles. Throws ELOOP when a cycle is detected.
//
// `path` is canonicalized internally so callers can pass user input
// directly. Pre-canonicalized paths are also accepted and incur the
// same trivial re-canonicalization cost.
export function resolveInode(
  db: Database,
  path: string,
  options: ResolveOptions = {},
): ResolvedInode | null {
  flushWriteBatchBeforePathRead(db, path);
  const followFinal = options.followSymlinks !== false;
  const { parts, path: canonical } = canonicalizePath(path);

  // Cache + single-statement CTE serve only cache-eligible reads:
  // follow-symlinks resolutions outside a transaction. Everything else
  // uses the per-component loop:
  //   * followSymlinks:false (lstat / readlink / the provider's
  //     pre-mutation captures) — not cached, and the loop is cheaper
  //     for these shallow one-shot resolves than the recursive CTE.
  //   * inside a transaction (every mutation path) — resolves are
  //     shallow and hot, the CTE competes with the mutation's own
  //     statements for the plan cache (recompiling it is far dearer
  //     than the loop), and the cache must not be populated
  //     mid-transaction anyway (rollback safety).
  // Mutations still invalidate the cache; that is independent of this.
  if (!followFinal || db.inTransaction) {
    return resolveParts(db, parts, followFinal, 0);
  }

  // Repeat reads of the same path are served from the per-Database
  // cache. Only the path -> inode mapping is cached; re-read the node
  // row so mode/size/mtime/type are always current. A stale mapping
  // (inode reaped without invalidation) reads back null and falls
  // through to a full resolve that re-populates the cache.
  const hit = lookupResolveCache(db, canonical);
  if (hit !== undefined) {
    if (hit.kind === "negative") {
      return null;
    }
    const cachedNode = lookupOperationNodeCache(db, hit.inode);
    if (cachedNode !== undefined) {
      return {
        inode: cachedNode.inode,
        type: cachedNode.type,
        mode: cachedNode.mode,
        mtime: cachedNode.mtime,
        size: cachedNode.size,
        linkTarget: cachedNode.linkTarget,
      };
    }
    const node = readNode(db, hit.inode);
    if (node !== null) {
      storeResolvedNode(db, toResolved(node));
      return toResolved(node);
    }
  }

  const metadata = resolveFromMetadataDirectories(db, parts);
  if (metadata.kind === "resolved") {
    storeResolveCache(db, canonical, metadata.node === null ? null : metadata.node.inode);
    if (metadata.node !== null) storeResolvedNode(db, metadata.node);
    return metadata.node;
  }

  // One recursive-CTE statement resolves the common symlink-free
  // case. Any symlink on the path falls back to the per-component loop,
  // which follows links and enforces ELOOP; those resolutions are not
  // cached (a followed path is an alias whose invalidation can't be
  // reasoned about structurally).
  const cte = resolveViaCte(db, parts);
  if (cte.kind === "symlink") {
    return resolveParts(db, parts, followFinal, 0);
  }
  storeResolveCache(db, canonical, cte.node === null ? null : cte.node.inode);
  if (cte.node !== null) storeResolvedNode(db, cte.node);
  return cte.node;
}

type MetadataResolution = { kind: "resolved"; node: ResolvedInode | null } | { kind: "unknown" };

function resolveFromMetadataDirectories(
  db: Database,
  parts: readonly string[],
): MetadataResolution {
  for (let depth = parts.length - 1; depth >= 0; depth -= 1) {
    let parentPath = depth === 0 ? "/" : `/${parts.slice(0, depth).join("/")}`;
    let child = lookupCompleteDirectoryChild(db, parentPath, parts[depth] ?? "");
    if (child === undefined) continue;

    for (let index = depth; index < parts.length; index += 1) {
      if (child.kind === "absent") return { kind: "resolved", node: null };
      if (child.entry.type === "symlink") return { kind: "unknown" };
      if (index < parts.length - 1 && child.entry.type !== "dir") {
        return { kind: "resolved", node: null };
      }
      if (index === parts.length - 1) {
        return {
          kind: "resolved",
          node: {
            inode: child.entry.inode,
            type: child.entry.type,
            mode: child.entry.mode,
            mtime: child.entry.mtime,
            size: child.entry.size,
            linkTarget: child.entry.linkTarget,
          },
        };
      }
      const name = parts[index] ?? "";
      parentPath = parentPath === "/" ? `/${name}` : `${parentPath}/${name}`;
      child = lookupCompleteDirectoryChild(db, parentPath, parts[index + 1] ?? "");
      if (child === undefined) return { kind: "unknown" };
    }
  }
  return { kind: "unknown" };
}

function storeResolvedNode(db: Database, node: ResolvedInode): void {
  storeOperationNodeCache(db, {
    kind: "resolve-node",
    inode: node.inode,
    type: node.type,
    mode: node.mode,
    mtime: node.mtime,
    size: node.size,
    linkTarget: node.linkTarget,
  });
}

interface CteRow {
  level: number;
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  link_target: string | null;
}

type CteResolution =
  // Walk completed with no symlink on the path: `node` is the resolved
  // final node, or null when a segment was missing or an intermediate
  // was not a directory (both map to null, exactly like the loop).
  | { kind: "resolved"; node: ResolvedInode | null }
  // A symlink was encountered anywhere on the path (intermediate or
  // final). The CTE can't follow links, so the caller must fall back to
  // the loop for byte-identical follow / ELOOP / dangling behaviour.
  | { kind: "symlink" };

// Single-statement path walk. Binds the canonical path segments as a
// JSON array and walks vfs_dirents -> vfs_nodes from ROOT_INODE, one
// level per segment. Descends only through directories (WHERE
// w.type = 'dir'), so a file intermediate stalls the walk (ENOTDIR)
// and a missing dirent produces no row (ENOENT) — both surface as a
// missing level-D row, matching the loop's null. Every node the walk
// touches is returned so the caller can detect any symlink and fall
// back.
function resolveViaCte(db: Database, parts: string[]): CteResolution {
  const rows = db.all<CteRow>(
    `WITH RECURSIVE
       segs(level, name) AS (
         SELECT key, value FROM json_each(?)
       ),
       walk(level, inode, type, mode, mtime, size, link_target) AS (
         SELECT 0, n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
           FROM vfs_nodes n
          WHERE n.inode = ?
         UNION ALL
         SELECT w.level + 1, n.inode, n.type, n.mode, n.mtime, n.size, n.link_target
           FROM walk w
           JOIN segs s ON s.level = w.level
           JOIN vfs_dirents d ON d.parent_inode = w.inode AND d.name = s.name
           JOIN vfs_nodes n ON n.inode = d.child_inode
          WHERE w.type = 'dir'
       )
     SELECT level, inode, type, mode, mtime, size, link_target
       FROM walk
      ORDER BY level`,
    JSON.stringify(parts),
    ROOT_INODE,
  );

  const depth = parts.length;
  let target: CteRow | undefined;
  for (const row of rows) {
    // Any symlink on the walk (root is level 0 and always a dir) means
    // the loop must take over to follow it.
    if (row.level >= 1 && row.type === "symlink") {
      return { kind: "symlink" };
    }
    if (row.level === depth) {
      target = row;
    }
  }
  return {
    kind: "resolved",
    node: target === undefined ? null : toResolved(target),
  };
}

function toResolved(node: NodeRow): ResolvedInode {
  return {
    inode: node.inode,
    type: node.type,
    mode: node.mode,
    mtime: node.mtime,
    size: node.size,
    linkTarget: node.link_target ?? undefined,
  };
}

function resolveParts(
  db: Database,
  parts: string[],
  followFinal: boolean,
  follows: number,
): ResolvedInode | null {
  const root = readNode(db, ROOT_INODE);
  if (root === null) {
    return null;
  }

  const pendingParts = [...parts];
  const nodeStack: NodeRow[] = [root];
  const pathStack: Array<string | undefined> = ["/"];
  storeOperationStructuralNode(db, "/", toResolved(root));
  while (pendingParts.length > 0) {
    const name = pendingParts.shift();
    if (name === undefined) continue;
    const current = nodeStack[nodeStack.length - 1];
    if (current.type !== "dir") return null;
    if (name === "" || name === ".") continue;
    if (name === "..") {
      if (nodeStack.length > 1) {
        nodeStack.pop();
        pathStack.pop();
      }
      continue;
    }

    const parentPath = pathStack[pathStack.length - 1];
    const listed =
      parentPath === undefined
        ? undefined
        : lookupAdaptiveDirectoryChild(db, parentPath, current.inode, name);
    if (listed?.kind === "absent") return null;
    let next: NodeRow | null;
    if (listed?.kind === "entry") {
      next = {
        inode: listed.entry.inode,
        type: listed.entry.type,
        mode: listed.entry.mode,
        mtime: listed.entry.mtime,
        size: listed.entry.size,
        link_target: listed.entry.linkTarget ?? null,
      };
    } else {
      const child = db.one<ChildRow>(
        "SELECT child_inode FROM vfs_dirents WHERE parent_inode = ? AND name = ?",
        current.inode,
        name,
      );
      if (child === undefined) return null;
      next = readNode(db, child.child_inode);
    }
    if (next === null) return null;

    // Intermediate symlinks always get followed; final-segment symlinks
    // are only followed when the caller wants. Keep target components in
    // the queue so links before `..` are expanded in filesystem order.
    if (next.type === "symlink" && (pendingParts.length > 0 || followFinal)) {
      follows += 1;
      if (follows > MAX_SYMLINK_FOLLOWS) {
        throw createWorkspaceError("ELOOP", "too many symlinks resolving path");
      }
      const target = next.link_target ?? "";
      if (target.startsWith("/")) {
        nodeStack.splice(1);
        pathStack.splice(1);
      }
      pathStack.fill(undefined);
      pendingParts.unshift(...target.split("/"));
      continue;
    }
    nodeStack.push(next);
    const nextPath =
      parentPath === undefined || next.type === "symlink"
        ? undefined
        : parentPath === "/"
          ? `/${name}`
          : `${parentPath}/${name}`;
    pathStack.push(nextPath);
    if (nextPath !== undefined) storeOperationStructuralNode(db, nextPath, toResolved(next));
  }

  return toResolved(nodeStack[nodeStack.length - 1]);
}

function readNode(db: Database, inode: number): NodeRow | null {
  const cached = lookupOperationNodeCache(db, inode);
  if (cached !== undefined) {
    return {
      inode: cached.inode,
      type: cached.type,
      mode: cached.mode,
      mtime: cached.mtime,
      size: cached.size,
      link_target: cached.linkTarget ?? null,
    };
  }
  const row = db.one<NodeRow>(
    "SELECT inode, type, mode, mtime, size, link_target FROM vfs_nodes WHERE inode = ?",
    inode,
  );
  if (row !== undefined) storeResolvedNode(db, toResolved(row));
  return row ?? null;
}
