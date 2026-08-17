// Dedicated runner for deterministic Git staging workload probes.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/git/staging.bench.ts"],
    testTimeout: 120_000,
  },
});
