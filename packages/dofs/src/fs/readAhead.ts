import { canonicalizePath } from "../path.js";
import {
  claimDatabaseOperationReadAhead,
  type Database,
  type DatabaseOperationReadAheadBlob,
  type DatabaseOperationReadAheadFile,
  noteDatabaseOperationReadAheadRead,
  storeDatabaseOperationReadAheadPage,
  takeDatabaseOperationReadAheadFile,
} from "../storage.js";
import { cacheBlobBytes, markCompleteFileBytes } from "./blobCache.js";
import { resolveInode } from "./resolve.js";
import { isOperationStructuralPath, storeOperationStructuralNode } from "./resolveCache.js";
import { listDirtyWriteBufferInodes } from "./writeBuffer.js";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_ENTRIES = 2000;

interface ReadContext {
  parentPath: string;
}

interface PageRow {
  name: string;
  inode: number;
  size: number;
  mode: number;
  mtime: number;
  idx: number | null;
  hash: Uint8Array | null;
  chunk_size: number | null;
  bytes: Uint8Array | null;
  candidate_count: number;
  input_has_more: number;
}

interface ReadAheadPage {
  lastName: string;
  fetchedBytes: number;
  fetchedEntries: number;
  files: ReadonlyMap<number, DatabaseOperationReadAheadFile>;
  hasMore: boolean;
  entries: readonly ReadAheadEntry[];
}

interface ReadAheadEntry {
  name: string;
  inode: number;
  mode: number;
  mtime: number;
  size: number;
}

interface FileAssembly {
  name: string;
  inode: number;
  size: number;
  nextChunk: number;
  total: number;
  broken: boolean;
  parts: Uint8Array[];
  blobs: DatabaseOperationReadAheadBlob[];
}

export function takeOrReadAheadCompleteFile(
  db: Database,
  path: string,
  inode: number,
  size: number,
): Uint8Array | undefined {
  const context = readContext(db, path, inode, size);
  if (context === undefined) return undefined;

  const held = takeDatabaseOperationReadAheadFile(db, inode);
  if (held !== undefined) return handOff(db, inode, held);

  const claim = claimDatabaseOperationReadAhead(db, context.parentPath);
  if (claim === undefined || claim.remainingEntries === 0) return undefined;
  const parent = resolveInode(db, context.parentPath);
  if (parent?.type !== "dir" || !isOperationStructuralPath(db, context.parentPath, parent.inode)) {
    return undefined;
  }

  const excluded = new Set([...claim.excludedInodes, ...listDirtyWriteBufferInodes(db)]);
  let remainingBytes = claim.remainingBytes;
  let remainingEntries = claim.remainingEntries;
  let afterName = "";
  while (remainingEntries > 0) {
    const page = readPage(
      db,
      parent.inode,
      afterName,
      excluded,
      Math.min(MAX_PAGE_BYTES, remainingBytes),
      Math.min(MAX_PAGE_ENTRIES, remainingEntries),
    );
    if (page === undefined) break;
    if (
      !storeDatabaseOperationReadAheadPage(db, page.files, page.fetchedBytes, page.fetchedEntries)
    ) {
      break;
    }
    remainingBytes -= page.fetchedBytes;
    remainingEntries -= page.fetchedEntries;
    afterName = page.lastName;
    for (const entry of page.entries) {
      const childPath =
        context.parentPath === "/" ? `/${entry.name}` : `${context.parentPath}/${entry.name}`;
      storeOperationStructuralNode(db, childPath, {
        inode: entry.inode,
        type: "file",
        mode: entry.mode,
        mtime: entry.mtime,
        size: entry.size,
      });
    }
    if (!page.hasMore) break;
  }

  const prefetched = takeDatabaseOperationReadAheadFile(db, inode);
  return prefetched === undefined ? undefined : handOff(db, inode, prefetched);
}

export function noteCompleteSmallFileRead(
  db: Database,
  path: string,
  inode: number,
  size: number,
): void {
  const context = readContext(db, path, inode, size);
  if (context === undefined) return;
  noteDatabaseOperationReadAheadRead(db, context.parentPath, inode);
}

function readContext(
  db: Database,
  path: string,
  inode: number,
  size: number,
): ReadContext | undefined {
  if (size > MAX_FILE_BYTES) return undefined;
  const { parts, path: canonicalPath } = canonicalizePath(path);
  if (parts.length === 0 || !isOperationStructuralPath(db, canonicalPath, inode)) return undefined;
  return {
    parentPath: parts.length === 1 ? "/" : `/${parts.slice(0, -1).join("/")}`,
  };
}

function readPage(
  db: Database,
  parentInode: number,
  afterName: string,
  excluded: ReadonlySet<number>,
  maxBytes: number,
  maxEntries: number,
): ReadAheadPage | undefined {
  const maxCandidateEntries = Math.min(maxEntries + excluded.size, MAX_PAGE_ENTRIES * 2);
  const rows = db.all<PageRow>(
    `SELECT page.name AS name,
            page.inode AS inode,
            page.size AS size,
            page.mode AS mode,
            page.mtime AS mtime,
            page.candidate_count AS candidate_count,
            page.input_has_more AS input_has_more,
            c.idx AS idx,
            c.hash AS hash,
            c.size AS chunk_size,
            b.bytes AS bytes
       FROM (
         WITH candidate_input AS MATERIALIZED (
           SELECT d.name AS name,
                  d.child_inode AS inode
             FROM vfs_dirents d
            WHERE d.parent_inode = ?
              AND d.name > ?
            ORDER BY d.name
            LIMIT ?
         ),
         eligible AS MATERIALIZED (
           SELECT input.name AS name,
                  n.inode AS inode,
                  n.size AS size,
             n.mode AS mode,
             n.mtime AS mtime
             FROM candidate_input input
             CROSS JOIN vfs_nodes n ON n.inode = input.inode
            WHERE n.type = 'file'
              AND n.size <= ?
              AND n.inode NOT IN (SELECT value FROM json_each(?))
         )
         SELECT ranked.name,
                ranked.inode,
                ranked.size,
                ranked.mode,
                ranked.mtime,
                ranked.candidate_count,
                ranked.input_has_more
           FROM (
             SELECT eligible.name AS name,
                    eligible.inode AS inode,
                    eligible.size AS size,
                    eligible.mode AS mode,
                    eligible.mtime AS mtime,
                    ROW_NUMBER() OVER (ORDER BY eligible.name) AS entry_number,
                    SUM(eligible.size) OVER (
                      ORDER BY eligible.name ROWS UNBOUNDED PRECEDING
                    ) AS cumulative_bytes,
                    COUNT(*) OVER () AS candidate_count,
                    EXISTS(
                      SELECT 1 FROM candidate_input LIMIT 1 OFFSET ?
                    ) AS input_has_more
               FROM eligible
           ) ranked
          WHERE ranked.entry_number <= ? AND ranked.cumulative_bytes <= ?
       ) page
       LEFT JOIN vfs_chunks c ON c.inode = page.inode
       LEFT JOIN vfs_blob_bytes b ON b.hash = c.hash
      ORDER BY page.name, c.idx`,
    parentInode,
    afterName,
    maxCandidateEntries + 1,
    MAX_FILE_BYTES,
    JSON.stringify([...excluded]),
    maxCandidateEntries,
    maxEntries,
    maxBytes,
  );
  if (rows.length === 0) return undefined;

  const files = new Map<number, DatabaseOperationReadAheadFile>();
  let fetchedBytes = 0;
  let fetchedEntries = 0;
  let current: FileAssembly | undefined;
  let lastName = "";
  const entries: ReadAheadEntry[] = [];
  for (const row of rows) {
    if (current === undefined || current.inode !== row.inode || current.name !== row.name) {
      if (current !== undefined) finishAssembly(current, files);
      current = {
        name: row.name,
        inode: row.inode,
        size: row.size,
        nextChunk: 0,
        total: 0,
        broken: false,
        parts: [],
        blobs: [],
      };
      fetchedBytes += row.size;
      fetchedEntries += 1;
      entries.push({
        name: row.name,
        inode: row.inode,
        mode: row.mode,
        mtime: row.mtime,
        size: row.size,
      });
      lastName = row.name;
    }
    collectChunk(current, row);
  }
  if (current !== undefined) finishAssembly(current, files);
  return {
    lastName,
    fetchedBytes,
    fetchedEntries,
    files,
    hasMore: rows[0].input_has_more !== 0 || fetchedEntries < rows[0].candidate_count,
    entries,
  };
}

function collectChunk(file: FileAssembly, row: PageRow): void {
  if (row.idx === null) {
    if (file.size !== 0) file.broken = true;
    return;
  }
  if (
    row.idx !== file.nextChunk ||
    row.hash === null ||
    row.chunk_size === null ||
    row.bytes === null ||
    row.bytes.byteLength !== row.chunk_size
  ) {
    file.broken = true;
    return;
  }
  file.nextChunk += 1;
  file.blobs.push({ hash: row.hash, offset: file.total, length: row.chunk_size });
  file.total += row.chunk_size;
  file.parts.push(row.bytes);
}

function finishAssembly(
  file: FileAssembly,
  files: Map<number, DatabaseOperationReadAheadFile>,
): void {
  if (file.broken || file.total !== file.size) return;
  const bytes = new Uint8Array(file.size);
  let offset = 0;
  for (const part of file.parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  files.set(file.inode, { bytes, blobs: file.blobs });
}

function handOff(db: Database, inode: number, file: DatabaseOperationReadAheadFile): Uint8Array {
  for (const blob of file.blobs) {
    cacheBlobBytes(db, blob.hash, file.bytes.slice(blob.offset, blob.offset + blob.length));
  }
  markCompleteFileBytes(db, inode);
  return file.bytes;
}
