import {
  createDatabaseOperationDirectoryReservation,
  type Database,
  type DatabaseOperationDirectory,
  type DatabaseOperationDirectoryEntry,
  type DatabaseOperationDirectoryReservation,
  databaseOperationDirectoryMaxEntries,
  lookupDatabaseOperationDirectory,
  releaseDatabaseOperationDirectoryReservation,
  reserveDatabaseOperationDirectoryBytes,
  storeDatabaseOperationDirectory,
} from "../storage.js";
import { isOperationStructuralPath, storeOperationStructuralNode } from "./resolveCache.js";
import { listPendingByParent } from "./writeBuffer.js";

const DIRECTORY_BYTES = 64;
const ENTRY_BYTES = 128;

export type DirectoryMetadataEntry = Readonly<DatabaseOperationDirectoryEntry>;

export type DirectoryChildLookup =
  | { kind: "entry"; entry: DirectoryMetadataEntry }
  | { kind: "absent" };

export class DirectoryMetadataCollector {
  readonly #reservation: DatabaseOperationDirectoryReservation;
  readonly #maxEntries: number;
  readonly #entries: DirectoryMetadataEntry[] = [];
  #retainedBytes: number;
  #active = true;

  constructor(
    reservation: DatabaseOperationDirectoryReservation,
    maxEntries: number,
    retainedBytes: number,
  ) {
    this.#reservation = reservation;
    this.#maxEntries = maxEntries;
    this.#retainedBytes = retainedBytes;
  }

  collect(db: Database, parentPath: string, entry: DirectoryMetadataEntry): void {
    if (!this.#active) return;
    const bytes = entryBytes(parentPath, entry);
    if (
      this.#entries.length >= this.#maxEntries ||
      !reserveDatabaseOperationDirectoryBytes(db, this.#reservation, bytes)
    ) {
      this.discard(db);
      return;
    }
    this.#entries.push(Object.freeze(copyEntry(entry)));
    this.#retainedBytes += bytes;
  }

  admit(
    db: Database,
    parentPath: string,
    parentInode: number,
  ): DatabaseOperationDirectory | undefined {
    if (!this.#active) return undefined;
    this.#active = false;
    const entries = Object.freeze(this.#entries);
    const directory: DatabaseOperationDirectory = {
      parentInode,
      parentPath,
      entries,
      entriesByName: new Map(entries.map((entry) => [entry.name, entry])),
      retainedBytes: this.#retainedBytes,
    };
    if (!storeDatabaseOperationDirectory(db, directory, this.#reservation)) {
      releaseDatabaseOperationDirectoryReservation(db, this.#reservation);
      return undefined;
    }
    return directory;
  }

  discard(db: Database): void {
    if (!this.#active) return;
    this.#active = false;
    this.#entries.length = 0;
    this.#retainedBytes = 0;
    releaseDatabaseOperationDirectoryReservation(db, this.#reservation);
  }
}

export function lookupCompleteDirectory(
  db: Database,
  parentPath: string,
  parentInode: number,
): readonly DirectoryMetadataEntry[] | undefined {
  return lookupDatabaseOperationDirectory(db, parentPath, parentInode)?.entries;
}

export function lookupCompleteDirectoryChild(
  db: Database,
  parentPath: string,
  childName: string,
): DirectoryChildLookup | undefined {
  const directory = lookupDatabaseOperationDirectory(db, parentPath);
  if (directory === undefined) return undefined;
  const entry = directory.entriesByName.get(childName);
  return entry === undefined ? { kind: "absent" } : { kind: "entry", entry };
}

export function createDirectoryMetadataCollector(
  db: Database,
  parentPath: string,
  parentInode: number,
): DirectoryMetadataCollector | undefined {
  if (
    !isOperationStructuralPath(db, parentPath, parentInode) ||
    listPendingByParent(db, parentInode).length > 0
  ) {
    return undefined;
  }
  const maxEntries = databaseOperationDirectoryMaxEntries(db);
  const retainedBytes = directoryBaseBytes(parentPath);
  if (maxEntries === undefined) return undefined;
  const reservation = createDatabaseOperationDirectoryReservation(db, retainedBytes);
  return reservation === undefined
    ? undefined
    : new DirectoryMetadataCollector(reservation, maxEntries, retainedBytes);
}

export function collectDirectoryMetadata(
  db: Database,
  collector: DirectoryMetadataCollector | undefined,
  parentPath: string,
  entry: DirectoryMetadataEntry,
): void {
  collector?.collect(db, parentPath, entry);
}

export function admitCollectedDirectory(
  db: Database,
  parentPath: string,
  parentInode: number,
  collector: DirectoryMetadataCollector | undefined,
): boolean {
  const directory = collector?.admit(db, parentPath, parentInode);
  if (directory === undefined) return false;
  for (const entry of directory.entries) {
    storeKnownDirectoryChild(db, parentPath, parentInode, entry);
  }
  return true;
}

export function discardDirectoryMetadataCollector(
  db: Database,
  collector: DirectoryMetadataCollector | undefined,
): void {
  collector?.discard(db);
}

export function storeKnownDirectoryChild(
  db: Database,
  parentPath: string,
  parentInode: number,
  entry: DirectoryMetadataEntry,
): void {
  if (entry.type === "symlink" || !isOperationStructuralPath(db, parentPath, parentInode)) {
    return;
  }
  const path = parentPath === "/" ? `/${entry.name}` : `${parentPath}/${entry.name}`;
  storeOperationStructuralNode(db, path, entry);
}

function copyEntry(entry: DirectoryMetadataEntry): DirectoryMetadataEntry {
  return {
    inode: entry.inode,
    name: entry.name,
    type: entry.type,
    mode: entry.mode,
    mtime: entry.mtime,
    size: entry.size,
    linkTarget: entry.linkTarget,
  };
}

function directoryBaseBytes(parentPath: string): number {
  return DIRECTORY_BYTES + parentPath.length * 2;
}

function entryBytes(parentPath: string, entry: DirectoryMetadataEntry): number {
  const separatorBytes = parentPath === "/" ? 0 : 2;
  return (
    ENTRY_BYTES +
    parentPath.length * 2 +
    separatorBytes +
    entry.name.length * 2 +
    (entry.linkTarget?.length ?? 0) * 2
  );
}
