import { it } from "vitest";
import { ls } from "../fs/ls.js";
import type { StatementCounts } from "./counting-storage.js";
import type { BenchmarkBuild } from "./harness.js";
import { benchRead, type ReadBenchmarkResult } from "./harness.js";
import { benchmarkReport, readTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

it("benchmarks directory listings against real DO SqlStorage", async () => {
  const results: ReadBenchmarkResult[] = [];
  const width = 200;
  const buildWide: BenchmarkBuild = (_db, provider) => {
    provider.mkdirSync("/wide", { recursive: true });
    for (let i = 0; i < width; i++) {
      provider.writeFileSync(`/wide/f${i}.txt`, "x");
    }
  };
  const readdir = await benchRead({
    name: `readdir(${width})`,
    depth: 1,
    build: buildWide,
    op: (_db, provider) => {
      provider.readdirSync("/wide");
    },
    iterations: 1000,
  });
  const readdirSignature: StatementCounts = {
    statements: 2,
    reads: 2,
    writes: 0,
    other: 0,
    rowsRead: 1010,
    rowsWritten: 0,
  };
  results.push(readdir);

  const list = await benchRead({
    name: `ls(${width})`,
    depth: 1,
    build: buildWide,
    op: (db) => {
      ls(db, "/wide");
    },
    iterations: 500,
  });
  const listSignature: StatementCounts = {
    statements: 2,
    reads: 2,
    writes: 0,
    other: 0,
    rowsRead: 804,
    rowsWritten: 0,
  };
  results.push(list);

  benchmarkReport({
    scenario: "directory-listing",
    title: "dofs directory-listing benchmark",
    note: "statement counts are deterministic; ns/op is wall-clock under workerd.",
    sections: [readTable(results)],
    results: {
      reads: results,
    },
  });

  expectMetricSignature(readdir.name, readdir, readdirSignature);
  expectMetricSignature(list.name, list, listSignature);
});
