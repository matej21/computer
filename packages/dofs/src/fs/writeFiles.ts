import { createWorkspaceError } from "../errors.js";
import type { Database } from "../storage.js";
import type { WriteFilesEntry, WriteFilesOptions } from "./publicBulk.js";
import { withWriteBatchSync } from "./writeBatch.js";
import { writeFileSync } from "./writeFile.js";

const MAX_ENTRIES = 1024;
const MAX_BYTES = 4 * 1024 * 1024;
const encoder = new TextEncoder();

interface PreparedEntry {
  path: string;
  bytes: Uint8Array;
  mode?: number;
  index: number;
}

export async function writeFiles(
  db: Database,
  entries: readonly WriteFilesEntry[],
  options: WriteFilesOptions,
  now: () => number,
): Promise<void> {
  validateOptions(entries, options);

  const lastByPath = new Map<string, PreparedEntry>();
  let totalBytes = 0;
  for (const [index, entry] of entries.entries()) {
    const bytes =
      typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content.slice();
    totalBytes += bytes.byteLength;
    if (totalBytes > options.maxBytes) {
      throw createWorkspaceError("EINVAL", "writeFiles content exceeds maxBytes", entry.path);
    }
    lastByPath.set(entry.path, { path: entry.path, bytes, mode: entry.mode, index });
  }

  const prepared = [...lastByPath.values()].sort((left, right) => left.index - right.index);
  withWriteBatchSync(
    db,
    (batchDb) => {
      for (const entry of prepared) {
        writeFileSync(batchDb, entry.path, entry.bytes, { mode: entry.mode }, now);
      }
    },
    { maxBytes: options.maxBytes, maxFiles: MAX_ENTRIES },
  );
}

function validateOptions(entries: readonly WriteFilesEntry[], options: WriteFilesOptions): void {
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > MAX_BYTES
  ) {
    throw createWorkspaceError("EINVAL", "invalid writeFiles maxBytes");
  }
  if (entries.length > MAX_ENTRIES) {
    throw createWorkspaceError("EINVAL", "too many writeFiles entries");
  }
}
