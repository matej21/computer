import type { MutationBenchmarkResult, ReadBenchmarkResult } from "./harness.js";

const SCHEMA_VERSION = 1;

export function formatDurationNs(value: number): string {
  if (value >= 1e6) {
    return `${(value / 1e6).toFixed(3)}ms`;
  }
  if (value >= 1e3) {
    return `${(value / 1e3).toFixed(2)}\u00b5s`;
  }
  return `${value.toFixed(0)}ns`;
}

function pad(value: string | number, width: number): string {
  return String(value).padStart(width);
}

function padEnd(value: string | number, width: number): string {
  return String(value).padEnd(width);
}

export function readTable(results: readonly ReadBenchmarkResult[]): string[] {
  const lines = [
    "READ / RESOLVE OPS",
    `${padEnd("operation", 22)}${pad("depth", 6)}${pad("ns/op", 12)}${pad("stmts", 8)}${pad("reads", 7)}${pad("writes", 8)}${pad("other", 7)}${pad("rowsRd", 9)}${pad("rowsWr", 9)}`,
    "-".repeat(95),
  ];
  for (const result of results) {
    lines.push(
      `${padEnd(result.name, 22)}${pad(result.depth, 6)}${pad(formatDurationNs(result.nsPerOp), 12)}${pad(result.statements, 8)}${pad(result.reads, 7)}${pad(result.writes, 8)}${pad(result.other, 7)}${pad(result.rowsRead, 9)}${pad(result.rowsWritten, 9)}`,
    );
  }
  return lines;
}

export function mutationTable(results: readonly MutationBenchmarkResult[]): string[] {
  const lines = [
    "MUTATION BATCHES (per-item amortized)",
    `${padEnd("operation", 30)}${pad("items", 7)}${pad("total", 11)}${pad("ns/item", 12)}${pad("stmts", 8)}${pad("reads", 8)}${pad("writes", 8)}${pad("other", 7)}${pad("rowsRd", 9)}${pad("rowsWr", 9)}`,
    "-".repeat(116),
  ];
  for (const result of results) {
    lines.push(
      `${padEnd(result.name, 30)}${pad(result.items, 7)}${pad(`${result.totalMs.toFixed(1)}ms`, 11)}${pad(formatDurationNs(result.nsPerItem), 12)}${pad(result.statements, 8)}${pad(result.reads, 8)}${pad(result.writes, 8)}${pad(result.other, 7)}${pad(result.rowsRead, 9)}${pad(result.rowsWritten, 9)}`,
    );
  }
  return lines;
}

export function benchmarkReport(options: {
  scenario: string;
  title: string;
  note: string;
  sections: readonly (readonly string[])[];
  results: object;
}): void {
  const lines = [
    "=".repeat(96),
    `${options.title} — backend: REAL Durable Object SqlStorage (vitest-pool-workers)`,
    `generated: ${new Date().toISOString()}`,
    `note: ${options.note}`,
    "=".repeat(96),
  ];
  for (const section of options.sections) {
    lines.push("", ...section);
  }
  lines.push(
    "",
    "JSON",
    JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      scenario: options.scenario,
      backend: "durable-object-sqlstorage",
      results: options.results,
    }),
    "=".repeat(96),
  );
  console.log(`\n${lines.join("\n")}\n`);
}

export function leftPad(value: string | number, width: number): string {
  return pad(value, width);
}

export function rightPad(value: string | number, width: number): string {
  return padEnd(value, width);
}
