import { expect, it } from "vitest";
import type { SQLiteWorkspaceProvider } from "../provider.js";
import type { StatementCounts } from "./counting-storage.js";
import { withCountingDb, withRealDb } from "./harness.js";
import { benchmarkReport } from "./report.js";
import { expectMetricSignature } from "./signature.js";

function writeDedupFixture(provider: SQLiteWorkspaceProvider): void {
  const oneMiB = "a".repeat(1024 * 1024);
  provider.mkdirSync("/dup", { recursive: true });
  for (let i = 0; i < 100; i++) {
    provider.writeFileSync(`/dup/f${i}.bin`, oneMiB);
  }
}

it("guards content deduplication against real DO SqlStorage", async () => {
  const dedup = await withRealDb((_db, provider, storage) => {
    writeDedupFixture(provider);
    return { bytes: storage.databaseSize ?? 0, files: 100, logicalMiB: 100 };
  });
  const metrics = await withCountingDb((_db, provider, counting) => {
    writeDedupFixture(provider);
    return counting.snapshot();
  });
  const storageSignature: StatementCounts = {
    statements: 1305,
    reads: 302,
    writes: 1003,
    other: 0,
    rowsRead: 706,
    rowsWritten: 1410,
  };
  const table = [
    "DB SIZE / DEDUP GUARD",
    `100 x 1 MiB identical files -> logical ${dedup.logicalMiB} MiB, on-disk ${(dedup.bytes / (1024 * 1024)).toFixed(2)} MiB (${dedup.bytes} bytes)`,
    `statements ${metrics.statements}, reads ${metrics.reads}, writes ${metrics.writes}, other ${metrics.other}, rows read ${metrics.rowsRead}, rows written ${metrics.rowsWritten}`,
  ];
  benchmarkReport({
    scenario: "storage-deduplication",
    title: "dofs storage benchmark",
    note: "database size is reported by the real Durable Object SqlStorage backend.",
    sections: [table],
    results: {
      dedup,
      metrics,
    },
  });

  expect(dedup.bytes).toBeLessThan(2 * 1024 * 1024);
  expectMetricSignature("storage-deduplication", metrics, storageSignature);
});
