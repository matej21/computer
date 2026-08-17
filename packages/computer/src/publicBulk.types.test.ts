import type { WorkspaceRPC } from "@cloudflare/computer-rpc";
import type {
  BulkEntryError,
  BulkPage,
  CpOptions,
  ReadFilesEntry,
  ReadFilesOptions,
  RmFilesOptions,
  WalkOptions,
  WorkspaceErrorCode,
  WorkspaceFilesystem,
  WorkspaceWalkEntry,
  WriteFilesEntry,
  WriteFilesOptions,
} from "@cloudflare/dofs";
import { it } from "vitest";

import type {
  BulkEntryError as ComputerBulkEntryError,
  BulkPage as ComputerBulkPage,
  CpOptions as ComputerCpOptions,
  ReadFilesEntry as ComputerReadFilesEntry,
  ReadFilesOptions as ComputerReadFilesOptions,
  RmFilesOptions as ComputerRmFilesOptions,
  WalkOptions as ComputerWalkOptions,
  WorkspaceRuntimeFilesystem as ComputerWorkspaceRuntimeFilesystem,
  WorkspaceWalkEntry as ComputerWorkspaceWalkEntry,
  WriteFilesEntry as ComputerWriteFilesEntry,
  WriteFilesOptions as ComputerWriteFilesOptions,
} from "./index.js";
import type { WorkspaceRuntimeFilesystem } from "./runtime/types.js";
import type { WorkspaceFilesystemStub } from "./stub.js";

interface PublicBulkFilesystem {
  walk(directory: string, options: WalkOptions): Promise<BulkPage<WorkspaceWalkEntry>>;
  readFiles(paths: readonly string[], options: ReadFilesOptions): Promise<BulkPage<ReadFilesEntry>>;
  writeFiles(entries: readonly WriteFilesEntry[], options: WriteFilesOptions): Promise<void>;
  rmFiles(paths: readonly string[], options: RmFilesOptions): Promise<void>;
  cp(source: string, dest: string, options?: CpOptions): Promise<void>;
}

interface ExpectedBulkEntryError {
  code: WorkspaceErrorCode | "EFBIG";
  message: string;
  path: string;
}

interface ExpectedBulkPage<Entry> {
  entries: Entry[];
  cursor?: string;
}

interface ExpectedWorkspaceWalkEntry {
  path: string;
  inode: number;
  type: "file" | "dir" | "symlink";
  mode: number;
  mtime: number;
  size: number;
  linkTarget?: string;
}

interface ExpectedWalkOptions {
  limit: number;
  maxBytes: number;
  cursor?: string;
  depth?: number;
  exclude?: readonly string[];
  excludeHidden?: boolean;
}

interface ExpectedReadFilesOptions {
  limit: number;
  maxBytes: number;
  cursor?: string;
}

interface ExpectedWriteFilesEntry {
  path: string;
  content: string | Uint8Array;
  mode?: number;
}

interface ExpectedWriteFilesOptions {
  maxBytes: number;
}

interface ExpectedRmFilesOptions {
  recursive?: boolean;
  force?: boolean;
  maxEntries: number;
  maxMetadataBytes: number;
}

interface ExpectedCpOptions {
  recursive?: boolean;
  maxEntries?: number;
  maxMetadataBytes?: number;
}

type ExpectedReadFilesEntry =
  | { path: string; content: Uint8Array; error?: never }
  | { path: string; content?: never; error: BulkEntryError };

type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;
type IsEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;

type ContainsStream<Value> =
  Value extends ReadableStream<unknown>
    ? true
    : Value extends Uint8Array
      ? false
      : Value extends readonly (infer Entry)[]
        ? ContainsStream<Entry>
        : Value extends object
          ? true extends { [Key in keyof Value]-?: ContainsStream<Value[Key]> }[keyof Value]
            ? true
            : false
          : false;

function assertType<_Condition extends true>(): void {}

it("publishes one assignable plain-value bulk filesystem surface", () => {
  assertType<IsAssignable<WorkspaceFilesystem, PublicBulkFilesystem>>();
  assertType<IsAssignable<WorkspaceFilesystemStub, PublicBulkFilesystem>>();
  assertType<IsAssignable<WorkspaceRuntimeFilesystem, PublicBulkFilesystem>>();

  assertType<IsEqual<ComputerBulkPage<string>, BulkPage<string>>>();
  assertType<IsEqual<ComputerBulkEntryError, BulkEntryError>>();
  assertType<IsEqual<ComputerWorkspaceWalkEntry, WorkspaceWalkEntry>>();
  assertType<IsEqual<ComputerWalkOptions, WalkOptions>>();
  assertType<IsEqual<ComputerReadFilesEntry, ReadFilesEntry>>();
  assertType<IsEqual<ComputerReadFilesOptions, ReadFilesOptions>>();
  assertType<IsEqual<ComputerWriteFilesEntry, WriteFilesEntry>>();
  assertType<IsEqual<ComputerWriteFilesOptions, WriteFilesOptions>>();
  assertType<IsEqual<ComputerRmFilesOptions, RmFilesOptions>>();
  assertType<IsEqual<ComputerCpOptions, CpOptions>>();
  assertType<IsEqual<ComputerWorkspaceRuntimeFilesystem, WorkspaceRuntimeFilesystem>>();
  assertType<IsEqual<BulkPage<string>, ExpectedBulkPage<string>>>();
  assertType<IsEqual<BulkEntryError, ExpectedBulkEntryError>>();
  assertType<IsEqual<WorkspaceWalkEntry, ExpectedWorkspaceWalkEntry>>();
  assertType<IsEqual<WalkOptions, ExpectedWalkOptions>>();
  assertType<IsEqual<ReadFilesEntry, ExpectedReadFilesEntry>>();
  assertType<IsEqual<ReadFilesOptions, ExpectedReadFilesOptions>>();
  assertType<IsEqual<WriteFilesEntry, ExpectedWriteFilesEntry>>();
  assertType<IsEqual<WriteFilesOptions, ExpectedWriteFilesOptions>>();
  assertType<IsEqual<RmFilesOptions, ExpectedRmFilesOptions>>();
  assertType<IsEqual<CpOptions, ExpectedCpOptions>>();

  assertType<IsEqual<ContainsStream<BulkPage<WorkspaceWalkEntry>>, false>>();
  assertType<IsEqual<ContainsStream<BulkPage<ReadFilesEntry>>, false>>();
  assertType<IsEqual<ContainsStream<readonly WriteFilesEntry[]>, false>>();
  assertType<IsEqual<Extract<keyof WorkspaceRPC, keyof PublicBulkFilesystem>, never>>();
});
