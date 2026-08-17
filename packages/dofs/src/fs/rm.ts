import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import { type Database, persistentDatabaseView, registerAfterOutermostCommit } from "../storage.js";
import { recordDelete } from "../sync/changes.js";
import { pathOf } from "../sync/paths.js";
import { assertNotReadOnly } from "./mount-guard.js";
import { resolveInode } from "./resolve.js";
import { invalidateResolveExact, invalidateResolveSubtree } from "./resolveCache.js";
import { unlinkDirent } from "./unlink.js";
import {
  deleteWriteBuffer,
  getWriteBuffer,
  listWriteBufferEntries,
  type WriteBufferEntry,
} from "./writeBuffer.js";

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

const SUBTREE_CTE = `WITH RECURSIVE subtree(inode, type, path) AS (
  SELECT ?, 'dir', ?
  UNION ALL
  SELECT n.inode, n.type,
         CASE WHEN s.path = '/' THEN '/' || d.name ELSE s.path || '/' || d.name END
    FROM subtree s
    JOIN vfs_dirents d ON d.parent_inode = s.inode
    JOIN vfs_nodes n ON n.inode = d.child_inode
   WHERE s.type = 'dir'
)`;

const DELETE_PAGE = 10_000;

interface BufferCleanup {
  inode: number;
  entry: WriteBufferEntry;
}

function removeSubtree(
  db: Database,
  rootInode: number,
  rootPath: string,
  rootParentInode: number,
  rootName: string,
  rev: number,
): void {
  db.run(
    `${SUBTREE_CTE}
     INSERT INTO vfs_changes (rev, path, op)
     SELECT ?, path, 'delete' FROM subtree ORDER BY path`,
    rootInode,
    rootPath,
    rev,
  );

  const keepExternalLinks = `AND NOT EXISTS (
    SELECT 1
      FROM vfs_dirents external
     WHERE external.child_inode = target.inode
       AND external.parent_inode NOT IN (SELECT inode FROM subtree WHERE type = 'dir')
       AND NOT (
         target.inode = ? AND external.parent_inode = ? AND external.name = ?
       )
  )`;
  db.run(
    `${SUBTREE_CTE}
     DELETE FROM vfs_chunks AS target
      WHERE target.inode IN (SELECT inode FROM subtree)
        ${keepExternalLinks}`,
    rootInode,
    rootPath,
    rootInode,
    rootParentInode,
    rootName,
  );
  db.run(
    `${SUBTREE_CTE}
     DELETE FROM vfs_nodes AS target
      WHERE target.inode IN (SELECT inode FROM subtree)
        ${keepExternalLinks}`,
    rootInode,
    rootPath,
    rootInode,
    rootParentInode,
    rootName,
  );
  db.run(
    `WITH RECURSIVE subtree(inode) AS (
       SELECT ?
       UNION
       SELECT d.child_inode
         FROM subtree s
         JOIN vfs_dirents d ON d.parent_inode = s.inode
     )
     DELETE FROM vfs_dirents
      WHERE parent_inode IN (SELECT inode FROM subtree)
         OR (parent_inode = ? AND name = ?)`,
    rootInode,
    rootParentInode,
    rootName,
  );
}

function collectBufferCandidates(
  db: Database,
  rootInode: number,
  rootPath: string,
): BufferCleanup[] {
  const entries = listWriteBufferEntries(db);
  const byInode = new Map(entries.map(({ inode, entry }) => [inode, entry]));
  const candidates: BufferCleanup[] = [];
  const prefix = `${rootPath}/`;
  for (const { inode, entry } of entries) {
    const pending = entry.pending;
    if (pending?.resolvedPath.startsWith(prefix)) {
      candidates.push({ inode, entry });
    }
  }

  const persisted = entries.filter(({ inode }) => inode > 0).map(({ inode }) => inode);
  for (let start = 0; start < persisted.length; start += DELETE_PAGE) {
    const page = JSON.stringify(persisted.slice(start, start + DELETE_PAGE));
    for (const row of db.all<{ inode: number }>(
      `${SUBTREE_CTE}
       SELECT DISTINCT subtree.inode AS inode
         FROM subtree
         JOIN json_each(?) candidate ON candidate.value = subtree.inode`,
      rootInode,
      rootPath,
      page,
    )) {
      const entry = byInode.get(row.inode);
      if (entry !== undefined) candidates.push({ inode: row.inode, entry });
    }
  }
  return candidates;
}

function collectReapedBuffers(db: Database, candidates: readonly BufferCleanup[]): BufferCleanup[] {
  const reaped = candidates.filter((candidate) => candidate.inode < 0);
  const persisted = candidates.filter((candidate) => candidate.inode > 0);
  for (let start = 0; start < persisted.length; start += DELETE_PAGE) {
    const page = persisted.slice(start, start + DELETE_PAGE);
    const surviving = new Set(
      db
        .all<{ inode: number }>(
          "SELECT inode FROM vfs_nodes WHERE inode IN (SELECT value FROM json_each(?))",
          JSON.stringify(page.map((candidate) => candidate.inode)),
        )
        .map((row) => row.inode),
    );
    for (const candidate of page) {
      if (!surviving.has(candidate.inode)) reaped.push(candidate);
    }
  }
  return reaped;
}

function deferBufferCleanup(db: Database, cleanup: readonly BufferCleanup[]): void {
  if (cleanup.length === 0) return;
  const persistentDb = persistentDatabaseView(db);
  registerAfterOutermostCommit(db, () => {
    for (const target of cleanup) {
      if (getWriteBuffer(persistentDb, target.inode) === target.entry) {
        deleteWriteBuffer(persistentDb, target.inode);
      }
    }
  });
}

export function rm(db: Database, path: string, options: RmOptions): void {
  const { parts, path: canonical } = canonicalizePath(path);

  if (parts.length === 0) {
    // The workspace root is structural; refuse to delete it even with
    // recursive+force. Matches the doc's example.
    throw createWorkspaceError("EPERM", `cannot remove the root directory`, canonical);
  }

  // assertNotReadOnly uses the symmetric overlap predicate, so a
  // recursive rm of an ancestor whose subtree contains a read-only
  // mount root is caught here without walking the tree.
  assertNotReadOnly(db, canonical);

  const force = options.force === true;
  const recursive = options.recursive === true;

  db.transactionSync(() => {
    const node = resolveInode(db, canonical, { followSymlinks: false });
    if (node === null) {
      if (force) return;
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }

    if (node.type === "dir" && !recursive) {
      const childCount = db.scalar<number>(
        "SELECT COUNT(*) FROM vfs_dirents WHERE parent_inode = ?",
        node.inode,
      );
      if ((childCount ?? 0) > 0) {
        throw createWorkspaceError("ENOTEMPTY", `directory not empty: ${canonical}`, canonical);
      }
    }

    // Resolve the entry's real path from its parent rather than from
    // the inode: a hardlinked file has several names, and pathOf would
    // pick an arbitrary one. Following symlinks on the parent lets a
    // request through a symlinked directory land on the real container
    // while still removing exactly the requested name.
    const name = parts[parts.length - 1];
    const parentPath = parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`;
    const parent = resolveInode(db, parentPath);
    if (parent === null || parent.type !== "dir") {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    const parentReal = pathOf(db, parent.inode);
    if (parentReal === null) {
      throw createWorkspaceError("ENOENT", `no such path: ${canonical}`, canonical);
    }
    const realPath = parentReal === "/" ? `/${name}` : `${parentReal}/${name}`;
    assertNotReadOnly(db, realPath);

    const rev = incrementRev(db);

    if (node.type !== "dir" || !recursive) {
      // Single entry removal — file, symlink, or empty directory. A
      // file inode may have multiple dirents (hardlinks), so remove
      // only the requested name and reap chunks/node after the final
      // link disappears. `parent` is already resolved above, so unlink
      // by (parent, name) directly rather than re-resolving. The
      // tombstone is recorded at the resolved real path so sync sees
      // the move-aware location.
      unlinkDirent(db, parent.inode, name, node.inode, node.type);
      recordDelete(db, rev, realPath);
      // A single removed entry is a file, symlink, or empty directory:
      // no cached descendants to worry about, so drop it exact.
      invalidateResolveExact(db, realPath);
      return;
    }

    const bufferCandidates = collectBufferCandidates(db, node.inode, realPath);
    removeSubtree(db, node.inode, realPath, parent.inode, name, rev);
    deferBufferCleanup(db, collectReapedBuffers(db, bufferCandidates));
    // The whole subtree under realPath is gone; one subtree drop covers
    // every descendant's cached resolution.
    invalidateResolveSubtree(db, realPath);
  });
}
