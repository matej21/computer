import { env, type ProvidedEnv, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";

import { CountingStorage } from "../../../dofs/src/bench/counting-storage.js";
import type { DurableObjectStorageLike } from "../../../dofs/src/types.js";
import type { MacroBenchBindings } from "../../tests/macro-bench-worker.js";
import { createGitClient } from "../git/index.js";
import { Workspace } from "../workspace.js";

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
const MAX_SAMPLE_FILE_BYTES = 64 * 1024;
const textFile = /\.(?:c|css|go|h|html|js|json|jsx|md|mjs|rs|sh|toml|ts|tsx|txt|yaml|yml)$/i;

interface SampleFile {
  path: string;
  content: string;
}

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
  operation: string,
  counting: CountingStorage,
  run: () => Promise<void>,
): Promise<void> {
  counting.reset();
  const started = performance.now();
  await run();
  const result = {
    operation,
    totalMs: performance.now() - started,
    ...counting.snapshot(),
  };
  console.log(`[nextjs macro result] ${JSON.stringify(result)}`);
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
  await ws.git.checkout({ dir: REPOSITORY_DIR, ref: env.NEXTJS_BENCH_COMMIT, force: true });
}

async function collectSample(ws: Workspace, tracked: readonly string[]): Promise<SampleFile[]> {
  const sample: SampleFile[] = [];
  for (const relativePath of tracked) {
    if (!textFile.test(relativePath)) continue;
    const path = `${REPOSITORY_DIR}/${relativePath}`;
    const content = await ws.fs.readFile(path, "utf8");
    if (new TextEncoder().encode(content).byteLength > MAX_SAMPLE_FILE_BYTES) continue;
    sample.push({ path, content });
    if (sample.length === SAMPLE_FILES) return sample;
  }
  throw new Error(`Next.js fixture has fewer than ${SAMPLE_FILES} readable files`);
}

async function seedRemovalFixtures(ws: Workspace, sample: readonly SampleFile[]) {
  await ws.fs.mkdir("/macro-rm/set", { recursive: true });
  await ws.fs.mkdir("/macro-rm/loop", { recursive: true });
  const setPaths: string[] = [];
  const loopPaths: string[] = [];
  for (const [index, entry] of sample.entries()) {
    const suffix = `f${String(index).padStart(2, "0")}`;
    const setPath = `/macro-rm/set/${suffix}`;
    const loopPath = `/macro-rm/loop/${suffix}`;
    await ws.fs.writeFile(setPath, entry.content);
    await ws.fs.writeFile(loopPath, entry.content);
    setPaths.push(setPath);
    loopPaths.push(loopPath);
  }
  return { setPaths, loopPaths };
}

it("measures the pre-optimization Next.js workload", async () => {
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
      console.log("[nextjs macro] cloning packed fixture");
      await clonePinnedFixture(ws);
      expect(await ws.git.revParse({ dir: REPOSITORY_DIR, ref: "HEAD" })).toBe(
        env.NEXTJS_BENCH_COMMIT,
      );
      const packedTracked = await ws.git.lsFiles({ dir: REPOSITORY_DIR });
      console.log(`[nextjs macro] packed fixture has ${packedTracked.length} tracked files`);
      const sample = await collectSample(ws, packedTracked);
      const removal = await seedRemovalFixtures(ws, sample);

      await measure("git.status (packed)", counting, async () => {
        expect(await ws.git.status({ dir: REPOSITORY_DIR })).toHaveLength(0);
      });
      await measure("fs.readFiles ×50 [50× readFile]", counting, async () => {
        for (const entry of sample)
          expect(await ws.fs.readFile(entry.path, "utf8")).toBe(entry.content);
      });
      await measure("fs.rmFiles ×50 [50× rm]", counting, async () => {
        for (const path of removal.setPaths) await ws.fs.rm(path);
        expect(await ws.fs.readdir("/macro-rm/set")).toHaveLength(0);
      });
      await measure("fs.rm ×50 (loop)", counting, async () => {
        for (const path of removal.loopPaths) await ws.fs.rm(path);
        expect(await ws.fs.readdir("/macro-rm/loop")).toHaveLength(0);
      });

      console.log("[nextjs macro] rebuilding the repository with loose objects");
      await ws.fs.rm(`${REPOSITORY_DIR}/.git`, { recursive: true });
      await ws.git.init({ dir: REPOSITORY_DIR, defaultBranch: "main" });
      await measure("git.add (all)", counting, async () => {
        await ws.git.add({ dir: REPOSITORY_DIR, paths: [], all: true });
      });
      await measure("git.commit", counting, async () => {
        await ws.git.commit({ dir: REPOSITORY_DIR, message: "Create loose fixture" });
      });

      for (const [index, entry] of sample.entries()) {
        await ws.fs.writeFile(
          entry.path,
          `${entry.content}\n/* macro benchmark change ${index} */\n`,
        );
      }
      await measure("git.diffSummary", counting, async () => {
        expect(await ws.git.diffSummary({ dir: REPOSITORY_DIR })).toHaveLength(SAMPLE_FILES);
      });
      for (const entry of sample) await ws.fs.writeFile(entry.path, entry.content);
      await measure("git.status (loose)", counting, async () => {
        expect(await ws.git.status({ dir: REPOSITORY_DIR })).toHaveLength(0);
      });
    } finally {
      await ws.close();
    }
  });
});
