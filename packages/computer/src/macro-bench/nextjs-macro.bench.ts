import { env, type ProvidedEnv, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { CountingStorage } from "../../../dofs/src/bench/counting-storage.js";
import type { DurableObjectStorageLike } from "../../../dofs/src/types.js";
import type { MacroBenchBindings } from "../../tests/macro-bench-worker.js";
import { createGitClient } from "../git/index.js";
import { Workspace } from "../workspace.js";
import {
  formatNextjsMacroReport,
  type MacroOperationResult,
  NEXTJS_MACRO_OPERATIONS,
  type NextjsMacroOperation,
  selectReadableFiles,
} from "./nextjs-macro.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends MacroBenchBindings {}
}

declare global {
  namespace Cloudflare {
    interface Env extends ProvidedEnv {}
  }
}

const REPOSITORY_DIR = "/nextjs";
const SAMPLE_FILES = 50;
const READ_LIMIT = 256;
const MAX_BULK_BYTES = 4 * 1024 * 1024;
const MAX_SAMPLE_FILE_BYTES = 64 * 1024;
const textFile = /\.(?:c|css|go|h|html|js|json|jsx|md|mjs|rs|sh|toml|ts|tsx|txt|yaml|yml)$/i;

function storageAdapter(storage: DurableObjectStorage): DurableObjectStorageLike {
  return {
    sql: {
      exec: <Row extends object>(query: string, ...bindings: unknown[]) => {
        const cursor = storage.sql.exec<Row & Record<string, SqlStorageValue>>(query, ...bindings);
        return {
          toArray: (): Row[] => cursor.toArray(),
          get rowsRead(): number {
            return cursor.rowsRead;
          },
          get rowsWritten(): number {
            return cursor.rowsWritten;
          },
        };
      },
    },
    transactionSync: storage.transactionSync.bind(storage),
    transaction: (closure) => storage.transaction(async () => await closure()),
  };
}

async function measure(
  operation: NextjsMacroOperation,
  counting: CountingStorage,
  run: () => Promise<void>,
): Promise<MacroOperationResult> {
  counting.reset();
  const started = performance.now();
  await run();
  const totalMs = performance.now() - started;
  const result = { operation, totalMs, ...counting.snapshot() };
  console.log(`[nextjs macro result] ${JSON.stringify(result)}`);
  const queryCounts = new Map<string, number>();
  for (const query of counting.queries) {
    const fingerprint = query.replace(/\s+/g, " ").trim().slice(0, 180);
    queryCounts.set(fingerprint, (queryCounts.get(fingerprint) ?? 0) + 1);
  }
  console.log(
    `[nextjs macro queries] ${JSON.stringify(
      [...queryCounts.entries()]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 12)
        .map(([query, count]) => ({ count, query })),
    )}`,
  );
  return result;
}

async function collectSample(ws: Workspace, tracked: readonly string[]) {
  const readable = [];
  for (
    let offset = 0;
    offset < tracked.length && readable.length < SAMPLE_FILES;
    offset += READ_LIMIT
  ) {
    const paths = tracked
      .slice(offset, offset + READ_LIMIT)
      .filter((path) => textFile.test(path))
      .map((path) => `${REPOSITORY_DIR}/${path}`);
    if (paths.length === 0) continue;

    let cursor: string | undefined;
    do {
      const page = await ws.fs.readFiles(paths, {
        limit: READ_LIMIT,
        maxBytes: MAX_BULK_BYTES,
        cursor,
      });
      for (const entry of page.entries) {
        if (entry.content !== undefined && entry.content.byteLength <= MAX_SAMPLE_FILE_BYTES) {
          readable.push(entry);
        }
      }
      cursor = page.cursor;
    } while (cursor !== undefined && readable.length < SAMPLE_FILES);
  }
  return selectReadableFiles(readable, SAMPLE_FILES);
}

function changedContent(content: Uint8Array, index: number): Uint8Array {
  const marker = new TextEncoder().encode(`\n/* macro benchmark change ${index} */\n`);
  const changed = new Uint8Array(content.byteLength + marker.byteLength);
  changed.set(content);
  changed.set(marker, content.byteLength);
  return changed;
}

async function assertPackedRepository(ws: Workspace): Promise<void> {
  const entries = await ws.fs.readdir(`${REPOSITORY_DIR}/.git/objects/pack`);
  expect(entries.some((entry) => entry.name.endsWith(".pack"))).toBe(true);
}

async function clonePinnedFixture(ws: Workspace): Promise<void> {
  try {
    await ws.git.clone({
      url: env.NEXTJS_BENCH_URL,
      ref: env.NEXTJS_BENCH_REF,
      dir: REPOSITORY_DIR,
      depth: 1,
      singleBranch: true,
      noTags: false,
    });
  } catch (cause) {
    const expectedMiss = `Could not find origin/${env.NEXTJS_BENCH_REF}.`;
    if (!(cause instanceof Error) || cause.message !== expectedMiss) throw cause;
  }
  await ws.git.checkout({
    dir: REPOSITORY_DIR,
    ref: env.NEXTJS_BENCH_COMMIT,
    force: true,
  });
}

async function seedRemovalFixtures(
  ws: Workspace,
  sample: Awaited<ReturnType<typeof collectSample>>,
) {
  await ws.fs.mkdir("/macro-rm/set", { recursive: true });
  await ws.fs.mkdir("/macro-rm/loop", { recursive: true });
  const setEntries = sample.map((entry, index) => ({
    path: `/macro-rm/set/f${String(index).padStart(2, "0")}`,
    content: entry.content,
  }));
  const loopEntries = sample.map((entry, index) => ({
    path: `/macro-rm/loop/f${String(index).padStart(2, "0")}`,
    content: entry.content,
  }));
  await ws.fs.writeFiles(setEntries, { maxBytes: MAX_BULK_BYTES });
  await ws.fs.writeFiles(loopEntries, { maxBytes: MAX_BULK_BYTES });
  return {
    setPaths: setEntries.map((entry) => entry.path),
    loopPaths: loopEntries.map((entry) => entry.path),
  };
}

async function withMacroWorkspace(
  run: (ws: Workspace, counting: CountingStorage) => Promise<void>,
) {
  const id = env.NEXTJS_MACRO_DO.newUniqueId();
  const stub = env.NEXTJS_MACRO_DO.get(id);
  await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
    const counting = new CountingStorage(storageAdapter(state.storage));
    const ws = new Workspace({
      storage: counting,
      git: createGitClient(),
      defaultGitIdentity: { name: "Macro Benchmark", email: "benchmark@example.com" },
    });
    try {
      await run(ws, counting);
    } finally {
      await ws.close();
    }
  });
}

it("stages files through Git on real Durable Object storage", async () => {
  await withMacroWorkspace(async (ws) => {
    await ws.fs.mkdir("/repo", { recursive: true });
    await ws.git.init({ dir: "/repo" });
    await ws.fs.writeFile("/repo/file.txt", "content");
    await ws.git.add({ dir: "/repo", paths: [], all: true });
    expect(await ws.git.lsFiles({ dir: "/repo" })).toEqual(["file.txt"]);
    await ws.git.commit({ dir: "/repo", message: "Commit smoke fixture" });
    expect(await ws.git.status({ dir: "/repo" })).toHaveLength(0);
  });
});

it("measures the Next.js Git and bulk filesystem workload", async () => {
  await withMacroWorkspace(async (ws, counting) => {
    const results: MacroOperationResult[] = [];
    try {
      console.log("[nextjs macro] cloning packed fixture");
      await clonePinnedFixture(ws);
      expect(await ws.git.revParse({ dir: REPOSITORY_DIR, ref: "HEAD" })).toBe(
        env.NEXTJS_BENCH_COMMIT,
      );
      await assertPackedRepository(ws);

      const packedTracked = await ws.git.lsFiles({ dir: REPOSITORY_DIR });
      console.log(`[nextjs macro] packed fixture has ${packedTracked.length} tracked files`);
      const packedSample = await collectSample(ws, packedTracked);
      const removal = await seedRemovalFixtures(ws, packedSample);

      console.log("[nextjs macro] measuring packed status and bulk filesystem operations");
      results.push(
        await measure("git.status (packed)", counting, async () => {
          expect(await ws.git.status({ dir: REPOSITORY_DIR })).toHaveLength(0);
        }),
      );
      if (env.NEXTJS_BENCH_PACKED_ONLY === "1") return;
      results.push(
        await measure("fs.readFiles ×50", counting, async () => {
          const page = await ws.fs.readFiles(
            packedSample.map((entry) => entry.path),
            { limit: SAMPLE_FILES, maxBytes: MAX_BULK_BYTES },
          );
          expect(selectReadableFiles(page.entries, SAMPLE_FILES)).toHaveLength(SAMPLE_FILES);
          expect(page.cursor).toBeUndefined();
        }),
      );
      results.push(
        await measure("fs.rmFiles ×50", counting, async () => {
          await ws.fs.rmFiles(removal.setPaths, {
            maxEntries: SAMPLE_FILES,
            maxMetadataBytes: MAX_BULK_BYTES,
          });
          expect(await ws.fs.readdir("/macro-rm/set")).toHaveLength(0);
        }),
      );
      results.push(
        await measure("fs.rm ×50 (loop)", counting, async () => {
          for (const path of removal.loopPaths) await ws.fs.rm(path);
          expect(await ws.fs.readdir("/macro-rm/loop")).toHaveLength(0);
        }),
      );

      console.log("[nextjs macro] rebuilding the repository with loose objects");
      await ws.fs.rm(`${REPOSITORY_DIR}/.git`, { recursive: true });
      await ws.git.init({ dir: REPOSITORY_DIR, defaultBranch: "main" });
      console.log("[nextjs macro] measuring add all");
      results.push(
        await measure("git.add (all)", counting, async () => {
          await ws.git.add({ dir: REPOSITORY_DIR, paths: [], all: true });
        }),
      );
      console.log("[nextjs macro] measuring commit");
      results.push(
        await measure("git.commit", counting, async () => {
          await ws.git.commit({ dir: REPOSITORY_DIR, message: "Create loose fixture" });
        }),
      );
      for (const [index, entry] of packedSample.entries()) {
        await ws.fs.writeFile(entry.path, changedContent(entry.content, index));
      }
      console.log("[nextjs macro] measuring diff summary");
      results.push(
        await measure("git.diffSummary", counting, async () => {
          expect(await ws.git.diffSummary({ dir: REPOSITORY_DIR })).toHaveLength(SAMPLE_FILES);
        }),
      );
      for (const entry of packedSample) await ws.fs.writeFile(entry.path, entry.content);
      console.log("[nextjs macro] measuring loose status");
      results.push(
        await measure("git.status (loose)", counting, async () => {
          expect(await ws.git.status({ dir: REPOSITORY_DIR })).toHaveLength(0);
        }),
      );

      expect(results.map((result) => result.operation).sort()).toEqual(
        [...NEXTJS_MACRO_OPERATIONS].sort(),
      );
      console.log(
        `\n${formatNextjsMacroReport({
          fixture: {
            url: env.NEXTJS_BENCH_URL,
            ref: env.NEXTJS_BENCH_REF,
            commit: env.NEXTJS_BENCH_COMMIT,
            trackedFiles: packedTracked.length,
            sampledFiles: SAMPLE_FILES,
          },
          operations: results,
        })}\n`,
      );
    } finally {
      counting.reset();
    }
  });
});
