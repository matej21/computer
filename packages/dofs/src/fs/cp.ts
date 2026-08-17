import { createWorkspaceError } from "../errors.js";
import { canonicalizePath } from "../path.js";
import { incrementRev } from "../rev.js";
import type { Database } from "../storage.js";
import { assertNotReadOnly } from "./mount-guard.js";
import type { CpOptions } from "./publicBulk.js";
import { type ResolvedInode, resolveMany } from "./resolve.js";
import { invalidateResolveSubtree } from "./resolveCache.js";
import { flushWriteBatchBeforeMutation } from "./writeBatch.js";

const MAX_ENTRIES = 10_000;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

interface NamedNode extends ResolvedInode {
  kind: "source" | "dest";
}

interface CopyPreflight {
  entries: number;
  metadata_bytes: number;
  type_conflicts: number;
  split_hardlinks: number;
  destination_aliases: number;
}

const COPY_CTES = `
WITH RECURSIVE
  source_tree(
    source_inode, parent_source_inode, name, relpath,
    type, mode, manifest_hash, link_target, size
  ) AS (
    SELECT n.inode, NULL, '', '', n.type, n.mode, n.manifest_hash, n.link_target, n.size
      FROM vfs_nodes n WHERE n.inode = ?
    UNION ALL
    SELECT n.inode, parent.source_inode, d.name,
           CASE WHEN parent.relpath = '' THEN d.name ELSE parent.relpath || '/' || d.name END,
           n.type, n.mode, n.manifest_hash, n.link_target, n.size
      FROM source_tree parent
      JOIN vfs_dirents d ON d.parent_inode = parent.source_inode
      JOIN vfs_nodes n ON n.inode = d.child_inode
     WHERE parent.type = 'dir'
     LIMIT ?
  ),
  dest_tree(source_inode, dest_inode, dest_type) AS (
    SELECT source.source_inode, dest.inode, dest.type
      FROM source_tree source
      JOIN vfs_nodes dest ON dest.inode = ?
     WHERE source.relpath = '' AND ? = 1
    UNION ALL
    SELECT child.source_inode, dest.inode, dest.type
      FROM dest_tree parent
      JOIN source_tree child ON child.parent_source_inode = parent.source_inode
      JOIN vfs_dirents d ON d.parent_inode = parent.dest_inode AND d.name = child.name
      JOIN vfs_nodes dest ON dest.inode = d.child_inode
     WHERE parent.dest_type = 'dir'
  ),
  source_nodes AS (
    SELECT n.inode AS source_inode, n.type, n.mode, n.manifest_hash, n.link_target, n.size
      FROM vfs_nodes n
     WHERE n.inode IN (SELECT source_inode FROM source_tree)
  ),
  existing_candidates(source_inode, dest_inode) AS (
    SELECT source_inode, MIN(dest_inode)
      FROM dest_tree
     WHERE dest_inode NOT IN (SELECT source_inode FROM source_nodes)
     GROUP BY source_inode
  ),
  existing_map(source_inode, dest_inode) AS (
    SELECT candidate.source_inode, candidate.dest_inode
      FROM existing_candidates candidate
     WHERE NOT EXISTS (
       SELECT 1
         FROM existing_candidates earlier
        WHERE earlier.dest_inode = candidate.dest_inode
          AND earlier.source_inode < candidate.source_inode
     )
  )`;

const MAPPING_CTES = `,
  new_nodes AS (
    SELECT source.*, ROW_NUMBER() OVER (ORDER BY source.source_inode) AS new_index
      FROM source_nodes source
      LEFT JOIN existing_map existing ON existing.source_inode = source.source_inode
     WHERE existing.dest_inode IS NULL
  ),
  node_map(source_inode, dest_inode) AS (
    SELECT source_inode, dest_inode FROM existing_map
    UNION ALL
    SELECT source_inode, ? + new_index FROM new_nodes
  )`;

export function cp(
  db: Database,
  sourcePath: string,
  destPath: string,
  options: CpOptions,
  now: () => number,
): void {
  const source = canonicalizePath(sourcePath);
  const dest = canonicalizePath(destPath);
  const maxEntries = boundedOption(options.maxEntries, MAX_ENTRIES, "cp maxEntries", dest.path);
  const maxMetadataBytes = boundedOption(
    options.maxMetadataBytes,
    MAX_METADATA_BYTES,
    "cp maxMetadataBytes",
    dest.path,
  );

  flushWriteBatchBeforeMutation(db);
  assertNotReadOnly(db, dest.path);
  const mtime = now();

  db.transactionSync(() => {
    const sourceParentPath = source.parentPath ?? "/";
    const destParentPath = dest.parentPath ?? "/";
    const parents = resolveMany(db, [sourceParentPath, destParentPath]);
    const sourceParent = parents[0];
    const destParent = parents[1];
    if (sourceParent === null || sourceParent.type !== "dir") {
      throw createWorkspaceError("ENOENT", "cp source parent does not exist", source.path);
    }
    if (destParent === null || destParent.type !== "dir") {
      throw createWorkspaceError("ENOENT", "cp destination parent does not exist", dest.path);
    }

    const named = readNamedNodes(db, sourceParent.inode, source.name, destParent.inode, dest.name);
    const sourceNode = named.find((node) => node.kind === "source");
    const destNode = named.find((node) => node.kind === "dest");
    if (sourceNode === undefined) {
      throw createWorkspaceError("ENOENT", "cp source does not exist", source.path);
    }
    if (sourceNode.type === "dir" && options.recursive !== true) {
      throw createWorkspaceError("EISDIR", "cp source is a directory", source.path);
    }
    if (sourceNode.inode === destNode?.inode) {
      throw createWorkspaceError("EINVAL", "cp destination is the source", dest.path);
    }
    if (sourceNode.type === "dir" && isDescendant(db, destParent.inode, sourceNode.inode)) {
      throw createWorkspaceError("EINVAL", "cp destination is inside the source", dest.path);
    }
    if (destNode !== undefined && sourceNode.type !== destNode.type) {
      throw createWorkspaceError("EEXIST", "cp destination has an incompatible type", dest.path);
    }

    const merge = destNode !== undefined;
    const destRootInode = destNode?.inode ?? 0;
    const copyParams = [sourceNode.inode, MAX_ENTRIES + 1, destRootInode, merge ? 1 : 0];
    const preflight = db.one<CopyPreflight>(
      `${COPY_CTES}
       SELECT COUNT(*) AS entries,
              COALESCE(SUM(
                length(CAST(source.relpath AS BLOB)) +
                length(CAST(COALESCE(source.link_target, '') AS BLOB))
              ), 0) AS metadata_bytes,
              EXISTS (
                SELECT 1 FROM dest_tree dest
                JOIN source_nodes node ON node.source_inode = dest.source_inode
                WHERE node.type <> dest.dest_type
              ) AS type_conflicts,
              EXISTS (
                SELECT 1 FROM dest_tree
                GROUP BY source_inode HAVING COUNT(DISTINCT dest_inode) > 1
              ) AS split_hardlinks,
              (
                SELECT COUNT(*) FROM (
                  SELECT dest_inode FROM existing_candidates
                  GROUP BY dest_inode HAVING COUNT(DISTINCT source_inode) > 1
                )
              ) AS destination_aliases
         FROM source_tree source`,
      ...copyParams,
    );
    if (preflight === undefined) {
      throw createWorkspaceError("EIO", "cp preflight failed", dest.path);
    }
    if (preflight.entries > maxEntries || preflight.metadata_bytes > maxMetadataBytes) {
      throw createWorkspaceError("EINVAL", "cp source exceeds configured bounds", dest.path);
    }
    if (preflight.type_conflicts !== 0 || preflight.split_hardlinks !== 0) {
      throw createWorkspaceError("EEXIST", "cp destination conflicts with the source", dest.path);
    }

    const baseInode = db.scalar<number>("SELECT COALESCE(MAX(inode), 0) FROM vfs_nodes") ?? 0;
    const rev = incrementRev(db);

    db.run(
      `${COPY_CTES}
       DELETE FROM vfs_chunks
        WHERE inode IN (
          SELECT existing.dest_inode
            FROM existing_map existing
            JOIN source_nodes source ON source.source_inode = existing.source_inode
           WHERE source.type = 'file'
        )`,
      ...copyParams,
    );

    db.run(
      `${COPY_CTES}${MAPPING_CTES}
       INSERT INTO vfs_nodes (
         inode, type, mode, mtime, rev, mount_root, stub_size, manifest_hash, link_target, size
       )
       SELECT ? + new_index, type, mode, ?, ?, NULL, NULL, manifest_hash, link_target, size
         FROM new_nodes ORDER BY new_index`,
      ...copyParams,
      baseInode,
      baseInode,
      mtime,
      rev,
    );

    db.run(
      `${COPY_CTES}
       UPDATE vfs_nodes AS target
          SET mode = (
                SELECT source.mode FROM existing_map existing
                JOIN source_nodes source ON source.source_inode = existing.source_inode
                WHERE existing.dest_inode = target.inode
              ),
              mtime = ?, rev = ?, mount_root = NULL, stub_size = NULL,
              manifest_hash = (
                SELECT source.manifest_hash FROM existing_map existing
                JOIN source_nodes source ON source.source_inode = existing.source_inode
                WHERE existing.dest_inode = target.inode
              ),
              link_target = (
                SELECT source.link_target FROM existing_map existing
                JOIN source_nodes source ON source.source_inode = existing.source_inode
                WHERE existing.dest_inode = target.inode
              ),
              size = (
                SELECT source.size FROM existing_map existing
                JOIN source_nodes source ON source.source_inode = existing.source_inode
                WHERE existing.dest_inode = target.inode
              )
        WHERE target.inode IN (SELECT dest_inode FROM existing_map)`,
      ...copyParams,
      mtime,
      rev,
    );

    db.run(
      `${COPY_CTES}${MAPPING_CTES}
       INSERT INTO vfs_chunks (inode, idx, hash, size)
       SELECT mapped.dest_inode, chunk.idx, chunk.hash, chunk.size
         FROM node_map mapped
         JOIN vfs_chunks chunk ON chunk.inode = mapped.source_inode
        ORDER BY mapped.dest_inode, chunk.idx`,
      ...copyParams,
      baseInode,
    );

    db.run(
      `${COPY_CTES}${MAPPING_CTES}
       INSERT OR REPLACE INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT ?, ?, mapped.dest_inode
         FROM node_map mapped
        WHERE mapped.source_inode = ? AND ? = 0
       UNION ALL
       SELECT parent.dest_inode, source.name, child.dest_inode
         FROM source_tree source
         JOIN node_map parent ON parent.source_inode = source.parent_source_inode
         JOIN node_map child ON child.source_inode = source.source_inode
        WHERE source.relpath <> ''`,
      ...copyParams,
      baseInode,
      destParent.inode,
      dest.name,
      sourceNode.inode,
      merge ? 1 : 0,
    );

    invalidateResolveSubtree(db, dest.path);
  });
}

function boundedOption(
  value: number | undefined,
  hardMax: number,
  label: string,
  path: string,
): number {
  if (value === undefined) return hardMax;
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMax) {
    throw createWorkspaceError("EINVAL", `invalid ${label}`, path);
  }
  return value;
}

function readNamedNodes(
  db: Database,
  sourceParent: number,
  sourceName: string,
  destParent: number,
  destName: string,
): NamedNode[] {
  return db.all<NamedNode>(
    `WITH requested(kind, parent_inode, name) AS (
       VALUES ('source', ?, ?), ('dest', ?, ?)
     )
     SELECT requested.kind AS kind, node.inode AS inode, node.type AS type,
            node.mode AS mode, node.mtime AS mtime, node.size AS size,
            node.link_target AS linkTarget
       FROM requested
       LEFT JOIN vfs_dirents dirent
         ON requested.name <> ''
        AND dirent.parent_inode = requested.parent_inode
        AND dirent.name = requested.name
       JOIN vfs_nodes node
         ON node.inode = CASE
              WHEN requested.name = '' THEN requested.parent_inode
              ELSE dirent.child_inode
            END`,
    sourceParent,
    sourceName,
    destParent,
    destName,
  );
}

function isDescendant(db: Database, candidate: number, ancestor: number): boolean {
  return (
    db.one<{ found: number }>(
      `WITH RECURSIVE ancestors(inode) AS (
         SELECT ?
         UNION
         SELECT dirent.parent_inode
           FROM ancestors current
           JOIN vfs_dirents dirent ON dirent.child_inode = current.inode
       )
       SELECT 1 AS found FROM ancestors WHERE inode = ? LIMIT 1`,
      candidate,
      ancestor,
    ) !== undefined
  );
}
