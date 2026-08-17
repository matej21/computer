import { it } from "vitest";
import { resolveInode } from "../fs/resolve.js";
import { clearResolveCache } from "../fs/resolveCache.js";
import { stat } from "../fs/stat.js";
import type { StatementCounts } from "./counting-storage.js";
import { buildChainFile, chainOf } from "./fixtures.js";
import { benchRead, type ReadBenchmarkResult, withRealDb } from "./harness.js";
import { benchmarkReport, formatDurationNs, leftPad, readTable, rightPad } from "./report.js";
import { expectMetricSignature } from "./signature.js";

interface ColdWarmResult {
  name: string;
  depth: number;
  coldNsPerOp: number;
  warmNsPerOp: number;
}

const depthCases = [
  { depth: 1, resolvedRows: 9 },
  { depth: 2, resolvedRows: 17 },
  { depth: 4, resolvedRows: 39 },
  { depth: 8, resolvedRows: 107 },
  { depth: 16, resolvedRows: 339 },
  { depth: 20, resolvedRows: 503 },
];

function readSignature(statements: number, rowsRead: number): StatementCounts {
  return {
    statements,
    reads: statements,
    writes: 0,
    other: 0,
    rowsRead,
    rowsWritten: 0,
  };
}

it("benchmarks path resolution against real DO SqlStorage", async () => {
  const results: ReadBenchmarkResult[] = [];

  for (const { depth } of depthCases) {
    results.push(
      await benchRead({
        name: "fs.stat",
        depth,
        build: (_db, provider) => {
          buildChainFile(provider, depth);
        },
        op: (db) => {
          stat(db, chainOf(depth).file);
        },
        iterations: 4000,
      }),
    );
    results.push(
      await benchRead({
        name: "provider.statSync",
        depth,
        build: (_db, provider) => {
          buildChainFile(provider, depth);
        },
        op: (_db, provider) => {
          provider.statSync(chainOf(depth).file);
        },
        iterations: 4000,
      }),
    );
    const holder = { inode: 0 };
    results.push(
      await benchRead({
        name: "flat-baseline(inode)",
        depth,
        build: (db, provider) => {
          const file = buildChainFile(provider, depth);
          holder.inode = resolveInode(db, file)?.inode ?? 0;
        },
        op: (db) => {
          db.one(
            "SELECT inode, type, mode, mtime, size FROM vfs_nodes WHERE inode = ?",
            holder.inode,
          );
        },
        iterations: 4000,
      }),
    );
  }

  for (const depth of [8, 16]) {
    results.push(
      await benchRead({
        name: "exists(present)",
        depth,
        build: (_db, provider) => {
          buildChainFile(provider, depth);
        },
        op: (_db, provider) => {
          provider.existsSync(chainOf(depth).file);
        },
        iterations: 4000,
      }),
    );
    results.push(
      await benchRead({
        name: "exists(missing)",
        depth,
        build: (_db, provider) => {
          const { dir } = chainOf(depth);
          if (dir !== null) {
            provider.mkdirSync(dir, { recursive: true });
          }
        },
        op: (_db, provider) => {
          provider.existsSync(chainOf(depth).file);
        },
        iterations: 4000,
      }),
    );
  }

  const depth = 8;
  const content = "x".repeat(4096);
  results.push(
    await benchRead({
      name: "readFile(4KiB)",
      depth,
      build: (_db, provider) => {
        buildChainFile(provider, depth, content);
      },
      op: (_db, provider) => {
        provider.readFileSync(chainOf(depth).file, "utf8");
      },
      iterations: 2000,
    }),
  );
  results.push(
    await benchRead({
      name: "readRange(1KiB)",
      depth,
      build: (_db, provider) => {
        buildChainFile(provider, depth, content);
      },
      op: (_db, provider) => {
        provider.readRangeSync(chainOf(depth).file, 0, 1024);
      },
      iterations: 2000,
    }),
  );

  const coldWarm: ColdWarmResult[] = [];
  for (const coldDepth of [4, 20]) {
    const measured = await withRealDb((db, provider) => {
      buildChainFile(provider, coldDepth);
      const file = chainOf(coldDepth).file;
      const iterations = 4000;
      const warmup = 200;
      for (let i = 0; i < warmup; i++) {
        clearResolveCache(db);
        stat(db, file);
      }
      const cold0 = performance.now();
      for (let i = 0; i < iterations; i++) {
        clearResolveCache(db);
        stat(db, file);
      }
      const cold1 = performance.now();
      for (let i = 0; i < warmup; i++) {
        stat(db, file);
      }
      const warm0 = performance.now();
      for (let i = 0; i < iterations; i++) {
        stat(db, file);
      }
      const warm1 = performance.now();
      return {
        cold: ((cold1 - cold0) * 1e6) / iterations,
        warm: ((warm1 - warm0) * 1e6) / iterations,
      };
    });
    coldWarm.push({
      name: "fs.stat",
      depth: coldDepth,
      coldNsPerOp: measured.cold,
      warmNsPerOp: measured.warm,
    });
  }

  const coldWarmTable = [
    "COLD (CTE walk) VS WARM (cached) RESOLVE — fs.stat",
    `${rightPad("operation", 22)}${leftPad("depth", 6)}${leftPad("cold ns/op", 12)}${leftPad("warm ns/op", 12)}`,
    "-".repeat(52),
    ...coldWarm.map(
      (result) =>
        `${rightPad(result.name, 22)}${leftPad(result.depth, 6)}${leftPad(formatDurationNs(result.coldNsPerOp), 12)}${leftPad(formatDurationNs(result.warmNsPerOp), 12)}`,
    ),
  ];
  benchmarkReport({
    scenario: "path-resolution",
    title: "dofs path-resolution benchmark",
    note: "statement counts are deterministic; ns/op is wall-clock under workerd. The depth sweep is cache-warm; the cold/warm table isolates the CTE walk.",
    sections: [readTable(results), coldWarmTable],
    results: {
      reads: results,
      coldWarm,
    },
  });

  const find = (name: string, resultDepth: number): ReadBenchmarkResult => {
    const result = results.find((row) => row.name === name && row.depth === resultDepth);
    if (result === undefined) {
      throw new Error(`benchmark result missing: ${name} depth=${resultDepth}`);
    }
    return result;
  };
  for (const { depth: resultDepth, resolvedRows } of depthCases) {
    const filesystemStat = find("fs.stat", resultDepth);
    expectMetricSignature(
      `fs.stat depth=${resultDepth}`,
      filesystemStat,
      readSignature(1, resolvedRows),
    );
    const providerStat = find("provider.statSync", resultDepth);
    expectMetricSignature(
      `provider.statSync depth=${resultDepth}`,
      providerStat,
      readSignature(2, resolvedRows + 1),
    );
    const flatLookup = find("flat-baseline(inode)", resultDepth);
    expectMetricSignature(`flat-baseline depth=${resultDepth}`, flatLookup, readSignature(1, 1));
  }
  expectMetricSignature(
    "exists(present) depth=8",
    find("exists(present)", 8),
    readSignature(1, 107),
  );
  expectMetricSignature(
    "exists(missing) depth=8",
    find("exists(missing)", 8),
    readSignature(1, 94),
  );
  expectMetricSignature(
    "exists(present) depth=16",
    find("exists(present)", 16),
    readSignature(1, 339),
  );
  expectMetricSignature(
    "exists(missing) depth=16",
    find("exists(missing)", 16),
    readSignature(1, 318),
  );
  expectMetricSignature("readFile(4KiB)", find("readFile(4KiB)", 8), readSignature(2, 109));
  expectMetricSignature("readRange(1KiB)", find("readRange(1KiB)", 8), readSignature(3, 109));
});
