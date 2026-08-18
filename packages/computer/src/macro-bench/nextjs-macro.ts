import type { ReadFilesEntry } from "@cloudflare/dofs";

export const NEXTJS_MACRO_OPERATIONS: readonly [
  "git.status (loose)",
  "git.commit",
  "git.add (all)",
  "git.diffSummary",
  "git.status (packed)",
  "fs.readFiles ×50",
  "fs.rmFiles ×50",
  "fs.rm ×50 (loop)",
] = [
  "git.status (loose)",
  "git.commit",
  "git.add (all)",
  "git.diffSummary",
  "git.status (packed)",
  "fs.readFiles ×50",
  "fs.rmFiles ×50",
  "fs.rm ×50 (loop)",
];

export type NextjsMacroOperation = (typeof NEXTJS_MACRO_OPERATIONS)[number];

export interface ReadableFile {
  path: string;
  content: Uint8Array;
}

export interface MacroOperationResult {
  operation: NextjsMacroOperation;
  totalMs: number;
  statements: number;
  reads: number;
  writes: number;
  other: number;
  rowsRead: number;
  rowsWritten: number;
}

export interface NextjsMacroReport {
  fixture: {
    url: string;
    ref: string;
    commit: string;
    trackedFiles: number;
    sampledFiles: number;
  };
  operations: MacroOperationResult[];
}

export function selectReadableFiles(
  entries: readonly ReadFilesEntry[],
  count: number,
): ReadableFile[] {
  const selected: ReadableFile[] = [];
  for (const entry of entries) {
    if (entry.content === undefined) continue;
    selected.push({ path: entry.path, content: entry.content });
    if (selected.length === count) return selected;
  }
  throw new Error(`Next.js fixture has fewer than ${count} readable files`);
}

export function formatNextjsMacroReport(report: NextjsMacroReport): string {
  const header = [
    "operation".padEnd(28),
    "time".padStart(11),
    "stmts".padStart(9),
    "reads".padStart(9),
    "writes".padStart(9),
    "rows read".padStart(12),
    "rows written".padStart(14),
  ].join("");
  const rows = NEXTJS_MACRO_OPERATIONS.map((operation) => {
    const result = report.operations.find((entry) => entry.operation === operation);
    if (result === undefined) throw new Error(`Missing macro benchmark result for ${operation}`);
    return [
      result.operation.padEnd(28),
      `${result.totalMs.toFixed(1)}ms`.padStart(11),
      String(result.statements).padStart(9),
      String(result.reads).padStart(9),
      String(result.writes).padStart(9),
      String(result.rowsRead).padStart(12),
      String(result.rowsWritten).padStart(14),
    ].join("");
  });
  return [
    "NEXT.JS WORKSPACE MACRO BENCHMARK",
    `fixture: ${report.fixture.url} ${report.fixture.ref} (${report.fixture.commit})`,
    `tracked files: ${report.fixture.trackedFiles}; sample: ${report.fixture.sampledFiles}`,
    "",
    header,
    "-".repeat(header.length),
    ...rows,
    "",
    "JSON",
    JSON.stringify({ schemaVersion: 1, ...report }),
  ].join("\n");
}
