import { expect } from "vitest";
import type { StatementCounts } from "./counting-storage.js";
import type { BenchmarkMetrics } from "./harness.js";

export function expectMetricSignature(
  name: string,
  actual: BenchmarkMetrics,
  expected: StatementCounts,
): void {
  expect(
    {
      statements: actual.statements,
      reads: actual.reads,
      writes: actual.writes,
      other: actual.other,
      rowsRead: actual.rowsRead,
      rowsWritten: actual.rowsWritten,
    },
    name,
  ).toEqual(expected);
}
