import {
  claimDatabaseOperationMetadataSubtreePrefetch,
  type Database,
  databaseOperationDirectoryMaxEntries,
} from "../storage.js";
import {
  admitCollectedDirectory,
  collectDirectoryMetadata,
  createPrefetchedDirectoryMetadataCollector,
  type DirectoryMetadataEntry,
} from "./metadataPrefetch.js";
import { resolveInode } from "./resolve.js";
import { storeOperationStructuralNode } from "./resolveCache.js";

const MAX_DEPTH = 64;
const PARENT_PAGE = 128;
const MAX_LEVEL_ROWS = 20_001;

interface Parent {
  inode: number;
  path: string;
}

interface LevelRow {
  parent_order: number;
  parent_inode: number;
  inode: number | null;
  name: string | null;
  type: "file" | "dir" | "symlink" | null;
  mode: number | null;
  mtime: number | null;
  size: number | null;
  link_target: string | null;
}

export function prefetchMetadataSubtreeIfWalking(db: Database, canonicalPath: string): void {
  const rootPath = claimDatabaseOperationMetadataSubtreePrefetch(db, canonicalPath);
  if (rootPath === undefined) return;
  const root = resolveInode(db, rootPath);
  if (root === null || root.type !== "dir") return;
  storeOperationStructuralNode(db, rootPath, root);
  prefetchMetadataSubtree(db, rootPath, root.inode);
}

function prefetchMetadataSubtree(db: Database, rootPath: string, rootInode: number): void {
  let parents: Parent[] = [{ inode: rootInode, path: rootPath }];
  for (let depth = 0; depth < MAX_DEPTH && parents.length > 0; depth += 1) {
    const next: Parent[] = [];
    for (let offset = 0; offset < parents.length; offset += PARENT_PAGE) {
      const page = parents.slice(offset, offset + PARENT_PAGE);
      const complete = prefetchParentPage(db, page, next);
      if (!complete) return;
    }
    parents = next;
  }
}

function prefetchParentPage(db: Database, parents: readonly Parent[], next: Parent[]): boolean {
  const rows = readParentPage(db, parents);
  const truncated = rows.length === MAX_LEVEL_ROWS;
  const lastOrder = rows.at(-1)?.parent_order ?? -1;
  const completeParents = truncated ? lastOrder : parents.length;
  const byParent = new Map<number, LevelRow[]>();
  for (const row of rows) {
    if (row.parent_order >= completeParents || row.inode === null) continue;
    const held = byParent.get(row.parent_order);
    if (held === undefined) byParent.set(row.parent_order, [row]);
    else held.push(row);
  }

  for (let order = 0; order < completeParents; order += 1) {
    const parent = parents[order];
    if (parent === undefined) continue;
    const collector = createPrefetchedDirectoryMetadataCollector(db, parent.path, parent.inode);
    if (collector === undefined) return false;
    const children = byParent.get(order) ?? [];
    for (const row of children) {
      const entry = toEntry(row);
      collectDirectoryMetadata(db, collector, parent.path, entry);
    }
    if (!admitCollectedDirectory(db, parent.path, parent.inode, collector)) return false;
    for (const row of children) {
      const entry = toEntry(row);
      if (entry.type === "dir") {
        next.push({
          inode: entry.inode,
          path: parent.path === "/" ? `/${entry.name}` : `${parent.path}/${entry.name}`,
        });
      }
    }
  }
  return !truncated;
}

function readParentPage(db: Database, parents: readonly Parent[]): LevelRow[] {
  const maxEntries = databaseOperationDirectoryMaxEntries(db);
  if (maxEntries === undefined || maxEntries === 0) return [];
  return db.all<LevelRow>(
    `WITH parent_list AS MATERIALIZED (
       SELECT key AS parent_order, value AS parent_inode
         FROM json_each(?)
     )
     SELECT p.parent_order AS parent_order,
            p.parent_inode AS parent_inode,
            n.inode AS inode,
            d.name AS name,
            n.type AS type,
            n.mode AS mode,
            n.mtime AS mtime,
            n.size AS size,
            n.link_target AS link_target
       FROM parent_list p
       LEFT JOIN vfs_dirents d ON d.parent_inode = p.parent_inode
       LEFT JOIN vfs_nodes n ON n.inode = d.child_inode
      ORDER BY p.parent_order, d.name
      LIMIT ?`,
    JSON.stringify(parents.map((parent) => parent.inode)),
    Math.min(MAX_LEVEL_ROWS, maxEntries + 1),
  );
}

function toEntry(row: LevelRow): DirectoryMetadataEntry {
  if (
    row.inode === null ||
    row.name === null ||
    row.type === null ||
    row.mode === null ||
    row.mtime === null ||
    row.size === null
  ) {
    throw new Error("Incomplete metadata prefetch row");
  }
  return {
    inode: row.inode,
    name: row.name,
    type: row.type,
    mode: row.mode,
    mtime: row.mtime,
    size: row.size,
    linkTarget: row.link_target ?? undefined,
  };
}
