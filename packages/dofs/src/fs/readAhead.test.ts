import { describe, expect, it } from "vitest";

import { CountingStorage } from "../bench/counting-storage.js";
import { withDatabaseOperation } from "../operation.js";
import { SQLiteWorkspaceProvider } from "../provider.js";
import { initializeSchema } from "../schema/index.js";
import { Database } from "../storage.js";
import { SQLiteTestStorage } from "../testing.js";
import { clearBlobCache } from "./blobCache.js";
import { mkdir } from "./mkdir.js";
import { readFile } from "./readFile.js";
import { clearResolveCache } from "./resolveCache.js";
import { symlink } from "./symlink.js";
import {
  openWriteBufferForCreateSync,
  openWriteBufferSync,
  releaseWriteBufferSync,
  writeRangeSync,
} from "./writeFile.js";

const NOW = (): number => 1000;
const SMALL_FILE_MAX_BYTES = 64 * 1024;

interface QueryRecord {
  query: string;
  bindings: readonly unknown[];
}

async function withCountingDatabase<T>(
  run: (
    db: Database,
    provider: SQLiteWorkspaceProvider,
    counting: CountingStorage,
  ) => T | Promise<T>,
): Promise<T> {
  const storage = new SQLiteTestStorage();
  const counting = new CountingStorage(storage);
  const db = new Database(counting);
  initializeSchema(db, NOW);
  const provider = new SQLiteWorkspaceProvider(db, { now: NOW });
  try {
    return await run(db, provider, counting);
  } finally {
    storage.close();
  }
}

function recordQueries(db: Database): { records: QueryRecord[]; stop: () => void } {
  const records: QueryRecord[] = [];
  const originalExec = db.sql.exec.bind(db.sql);
  db.sql.exec = <Row extends object = Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ) => {
    records.push({ query, bindings });
    return originalExec<Row>(query, ...bindings);
  };
  return {
    records,
    stop: () => {
      db.sql.exec = originalExec;
    },
  };
}

function readsBlobPayload(record: QueryRecord): boolean {
  const query = record.query.toLowerCase();
  return query.startsWith("select") && query.includes("vfs_blob_bytes");
}

function payloadReads(records: readonly QueryRecord[], from = 0): QueryRecord[] {
  return records.slice(from).filter(readsBlobPayload);
}

function writeSmallDirectory(
  provider: SQLiteWorkspaceProvider,
  directory: string,
  count: number,
): string[] {
  provider.mkdirSync(directory, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const path = `${directory}/f${index.toString().padStart(4, "0")}`;
    provider.writeFileSync(path, `object ${index}`);
    paths.push(path);
  }
  return paths;
}

function writeFixedSizeDirectory(
  provider: SQLiteWorkspaceProvider,
  directory: string,
  count: number,
  size: number,
): string[] {
  provider.mkdirSync(directory, { recursive: true });
  const paths: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const prefix = `${index.toString().padStart(4, "0")}:`;
    const content = `${prefix}${"x".repeat(size - prefix.length)}`;
    const path = `${directory}/f${index.toString().padStart(4, "0")}`;
    provider.writeFileSync(path, content);
    paths.push(path);
  }
  return paths;
}

function seedEmptyFiles(db: Database, directory: string, count: number): void {
  mkdir(db, directory, { recursive: true }, NOW);
  const parent = db.one<{ inode: number }>(
    `SELECT n.inode AS inode
       FROM vfs_dirents d
       JOIN vfs_nodes n ON n.inode = d.child_inode
      WHERE d.name = ? AND n.type = 'dir'`,
    directory.slice(directory.lastIndexOf("/") + 1),
  );
  if (parent === undefined) throw new Error("empty-file fixture directory is missing");
  const firstInode = (db.scalar<number>("SELECT COALESCE(MAX(inode), 0) FROM vfs_nodes") ?? 0) + 1;
  db.transactionSync(() => {
    db.run(
      `WITH RECURSIVE sequence(value) AS (
         SELECT 0
         UNION ALL
         SELECT value + 1 FROM sequence WHERE value + 1 < ?
       )
       INSERT INTO vfs_nodes (type, mode, mtime, rev, size)
       SELECT 'file', ?, ?, 0, 0 FROM sequence`,
      count,
      0o644,
      NOW(),
    );
    db.run(
      `INSERT INTO vfs_dirents (parent_inode, name, child_inode)
       SELECT ?, printf('m-empty-%05d', inode - ?), inode
         FROM vfs_nodes
        WHERE inode >= ?
        ORDER BY inode`,
      parent.inode,
      firstInode,
      firstInode,
    );
  });
}

async function readText(db: Database, path: string): Promise<string> {
  return readFile(db, path, "utf8");
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      parts.push(value);
      size += value.byteLength;
    }
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function resetReadCaches(db: Database): void {
  clearResolveCache(db);
  clearBlobCache(db);
}

describe("operation-local small-file read-ahead", () => {
  it("reads forty small siblings with one speculative payload query after four reads", async () => {
    await withCountingDatabase(async (db, provider) => {
      const paths = writeSmallDirectory(provider, "/objects/ab", 40);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        const recording = recordQueries(operationDb);
        try {
          for (let index = 0; index < paths.length; index += 1) {
            await expect(readText(operationDb, paths[index])).resolves.toBe(`object ${index}`);
          }
          expect(payloadReads(recording.records)).toHaveLength(5);
          expect(recording.records).toHaveLength(11);
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("does not speculate for two incidental complete reads", async () => {
    await withCountingDatabase(async (db, provider) => {
      const paths = writeSmallDirectory(provider, "/objects/cd", 40);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        const recording = recordQueries(operationDb);
        try {
          await readText(operationDb, paths[0]);
          await readText(operationDb, paths[1]);
          expect(payloadReads(recording.records)).toHaveLength(2);
          expect(recording.records).toHaveLength(4);
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("does not count range, large-file, or symlink reads toward the threshold", async () => {
    await withCountingDatabase(async (db, provider) => {
      const small = writeSmallDirectory(provider, "/mixed", 8);
      const large = writeFixedSizeDirectory(provider, "/large", 4, SMALL_FILE_MAX_BYTES + 1);
      provider.mkdirSync("/targets");
      provider.mkdirSync("/links");
      for (let index = 0; index < 6; index += 1) {
        provider.writeFileSync(`/targets/t${index}`, `target ${index}`);
        symlink(db, `/targets/t${index}`, `/links/l${index}`, NOW);
      }
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (const path of small.slice(0, 4)) {
          await drain(await readFile(operationDb, path, { byteOffset: 0, byteLength: 1 }));
        }
        let recording = recordQueries(operationDb);
        try {
          await readText(operationDb, small[4]);
          await readText(operationDb, small[5]);
          expect(payloadReads(recording.records)).toHaveLength(2);
        } finally {
          recording.stop();
        }

        for (const path of large) await readText(operationDb, path);
        recording = recordQueries(operationDb);
        try {
          await readText(operationDb, small[6]);
          await readText(operationDb, small[7]);
          expect(payloadReads(recording.records)).toHaveLength(2);
        } finally {
          recording.stop();
        }

        for (let index = 0; index < 5; index += 1) {
          await readText(operationDb, `/links/l${index}`);
        }
        recording = recordQueries(operationDb);
        try {
          await expect(readText(operationDb, "/targets/t5")).resolves.toBe("target 5");
          expect(payloadReads(recording.records)).toHaveLength(1);
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("includes 64 KiB files but excludes larger, dirty, and pending files", async () => {
    await withCountingDatabase(async (db, provider) => {
      const prime = writeSmallDirectory(provider, "/bounded", 4);
      provider.writeFileSync("/bounded/f5000-at-limit", "a".repeat(SMALL_FILE_MAX_BYTES));
      provider.writeFileSync("/bounded/f5001-tail", "tail");
      provider.writeFileSync("/bounded/f5002-too-large", "b".repeat(SMALL_FILE_MAX_BYTES + 1));
      provider.writeFileSync("/bounded/f5003-dirty", "before");
      openWriteBufferSync(db, "/bounded/f5003-dirty");
      writeRangeSync(db, "/bounded/f5003-dirty", new TextEncoder().encode("after!"), 0, {}, NOW);
      openWriteBufferForCreateSync(db, "/bounded/f5004-pending", {}, NOW);
      writeRangeSync(db, "/bounded/f5004-pending", new TextEncoder().encode("pending"), 0, {}, NOW);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (const path of prime) await readText(operationDb, path);
        const recording = recordQueries(operationDb);
        try {
          await readText(operationDb, "/bounded/f5000-at-limit");
          await expect(readText(operationDb, "/bounded/f5001-tail")).resolves.toBe("tail");
          await readText(operationDb, "/bounded/f5002-too-large");
          await expect(readText(operationDb, "/bounded/f5003-dirty")).resolves.toBe("after!");
          await expect(readText(operationDb, "/bounded/f5004-pending")).resolves.toBe("pending");
          expect(payloadReads(recording.records)).toHaveLength(2);
        } finally {
          recording.stop();
        }
      });

      releaseWriteBufferSync(db, "/bounded/f5003-dirty", NOW);
      releaseWriteBufferSync(db, "/bounded/f5004-pending", NOW);
    });
  });

  it("uses 4 MiB pages and excludes inodes already read from the 8 MiB operation budget", async () => {
    await withCountingDatabase(async (db, provider) => {
      const paths = writeFixedSizeDirectory(provider, "/bytes", 132, SMALL_FILE_MAX_BYTES);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (const path of paths.slice(0, 4)) await readText(operationDb, path);
        const recording = recordQueries(operationDb);
        try {
          await readText(operationDb, paths[4]);
          expect(payloadReads(recording.records)).toHaveLength(2);

          const afterAhead = recording.records.length;
          await readText(operationDb, paths[131]);
          expect(payloadReads(recording.records, afterAhead)).toHaveLength(0);
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("counts empty files toward the 2000-entry page and 4000-entry operation limits", async () => {
    await withCountingDatabase(async (db, provider) => {
      provider.mkdirSync("/entries", { recursive: true });
      for (let index = 0; index < 5; index += 1) {
        provider.writeFileSync(`/entries/a-prime-${index}`, `prime ${index}`);
      }
      seedEmptyFiles(db, "/entries", 4001);
      provider.writeFileSync("/entries/z-marker-0", "marker zero");
      provider.writeFileSync("/entries/z-marker-1", "marker one");
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (let index = 0; index < 4; index += 1) {
          await readText(operationDb, `/entries/a-prime-${index}`);
        }
        const recording = recordQueries(operationDb);
        try {
          await readText(operationDb, "/entries/a-prime-4");
          expect(payloadReads(recording.records)).toHaveLength(2);

          const afterAttempt = recording.records.length;
          await expect(readText(operationDb, "/entries/z-marker-0")).resolves.toBe("marker zero");
          await expect(readText(operationDb, "/entries/z-marker-1")).resolves.toBe("marker one");
          expect(payloadReads(recording.records, afterAttempt)).toHaveLength(2);
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("stops probing when the complete-read exclusion history is full", async () => {
    await withCountingDatabase(async (db, provider) => {
      const readHistoryEntries = 4000;
      seedEmptyFiles(db, "/history", readHistoryEntries);
      const targetPaths = writeSmallDirectory(provider, "/after-history", 5);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (let index = 0; index < readHistoryEntries; index += 1) {
          const name = `m-empty-${index.toString().padStart(5, "0")}`;
          await expect(readText(operationDb, `/history/${name}`)).resolves.toBe("");
        }

        for (const path of targetPaths.slice(0, 4)) {
          await readText(operationDb, path);
        }
        const recording = recordQueries(operationDb);
        try {
          await expect(readText(operationDb, targetPaths[0])).resolves.toBe("object 0");
          expect.soft(payloadReads(recording.records)).toHaveLength(0);
          expect(
            recording.records.some((record) =>
              record.query.includes("candidate_input AS MATERIALIZED"),
            ),
          ).toBe(false);
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("keeps speculative bytes local while handing requested bytes to the shared cache", async () => {
    await withCountingDatabase(async (db, provider) => {
      const paths = writeSmallDirectory(provider, "/shared", 12);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (const path of paths.slice(0, 5)) await readText(operationDb, path);

        await withDatabaseOperation(db, async (siblingDb: Database) => {
          let recording = recordQueries(siblingDb);
          try {
            await readText(siblingDb, paths[4]);
            expect(payloadReads(recording.records)).toHaveLength(0);
          } finally {
            recording.stop();
          }

          recording = recordQueries(siblingDb);
          try {
            await readText(siblingDb, paths[10]);
            expect(payloadReads(recording.records)).toHaveLength(1);
          } finally {
            recording.stop();
          }
        });
      });

      const recording = recordQueries(db);
      try {
        await readText(db, paths[11]);
        expect(payloadReads(recording.records)).toHaveLength(1);
      } finally {
        recording.stop();
      }
    });
  });

  it("clears speculative bytes when a write advances the generation", async () => {
    await withCountingDatabase(async (db, provider) => {
      const paths = writeSmallDirectory(provider, "/generation", 12);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (const path of paths.slice(0, 5)) await readText(operationDb, path);
        provider.writeFileSync(paths[6], "rewritten");

        const recording = recordQueries(operationDb);
        try {
          await expect(readText(operationDb, paths[6])).resolves.toBe("rewritten");
          await readText(operationDb, paths[10]);
          expect(payloadReads(recording.records)).toHaveLength(2);
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("keeps binary open and cancel lazy, then may speculate on the first pull", async () => {
    await withCountingDatabase(async (db, provider) => {
      const paths = writeSmallDirectory(provider, "/lazy", 12);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (const path of paths.slice(0, 4)) await readText(operationDb, path);
        const recording = recordQueries(operationDb);
        try {
          const canceled = await readFile(operationDb, paths[4]);
          expect(payloadReads(recording.records)).toHaveLength(0);
          await canceled.cancel();
          expect(payloadReads(recording.records)).toHaveLength(0);

          const stream = await readFile(operationDb, paths[5]);
          expect(payloadReads(recording.records)).toHaveLength(0);
          const reader = stream.getReader();
          const first = await reader.read();
          expect(new TextDecoder().decode(first.value)).toBe("object 5");
          expect(payloadReads(recording.records)).toHaveLength(1);
          await reader.cancel();
        } finally {
          recording.stop();
        }
      });
    });
  });

  it("does not let caller mutation poison content handed off from read-ahead", async () => {
    await withCountingDatabase(async (db, provider) => {
      const paths = writeSmallDirectory(provider, "/copies", 12);
      resetReadCaches(db);

      await withDatabaseOperation(db, async (operationDb: Database) => {
        for (const path of paths.slice(0, 4)) await readText(operationDb, path);
        const stream = await readFile(operationDb, paths[4]);
        const reader = stream.getReader();
        const first = await reader.read();
        if (first.value === undefined) throw new Error("read-ahead fixture returned no bytes");
        first.value.fill(0);
        await reader.cancel();

        await expect(readText(operationDb, paths[4])).resolves.toBe("object 4");
      });
    });
  });
});
