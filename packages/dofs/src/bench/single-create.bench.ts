import { it } from "vitest";
import type { StatementCounts } from "./counting-storage.js";
import { benchMutation } from "./harness.js";
import { benchmarkReport, mutationTable } from "./report.js";
import { expectMetricSignature } from "./signature.js";

const FILE_COUNT = 100;

const baselineSignature: StatementCounts = {
  statements: 1100,
  reads: 300,
  writes: 800,
  other: 0,
  rowsRead: 700,
  rowsWritten: 1304,
};

const completeNodeSignature: StatementCounts = {
  statements: 1000,
  reads: 300,
  writes: 700,
  other: 0,
  rowsRead: 700,
  rowsWritten: 1104,
};

function signatureLine(label: string, signature: StatementCounts): string {
  return `${label}: ${signature.statements} statements, ${signature.reads} reads, ${signature.writes} writes, ${signature.rowsRead} rows read, ${signature.rowsWritten} rows written`;
}

it("benchmarks complete node creation against real DO SqlStorage", async () => {
  const creation = await benchMutation({
    name: `writeFileSync:new(${FILE_COUNT})`,
    build: (_db, provider) => {
      provider.mkdirSync("/create");
    },
    batch: (_db, provider) => {
      for (let index = 0; index < FILE_COUNT; index++) {
        provider.writeFileSync(`/create/file-${index}.txt`, "x");
      }
      return FILE_COUNT;
    },
  });

  benchmarkReport({
    scenario: "single-file-creation",
    title: "dofs single-file creation benchmark",
    note: "statement counts are deterministic; total and per-item timings are observational wall-clock measurements under workerd.",
    sections: [
      mutationTable([creation]),
      [
        "SIGNATURE CONTRACT",
        signatureLine("baseline blank-node then update", baselineSignature),
        signatureLine("target complete-node insert", completeNodeSignature),
      ],
    ],
    results: {
      creation,
      baselineSignature,
      completeNodeSignature,
    },
  });

  expectMetricSignature(creation.name, creation, completeNodeSignature);
});
