import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const DEFAULT_URL = "https://github.com/vercel/next.js";
const DEFAULT_REF = "v15.5.2";
const DEFAULT_COMMIT = "497ec6aa08a33f9e2d65a5c8461f550c2549d3e6";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./tests/wrangler.nextjs-bench.jsonc" },
      miniflare: {
        bindings: {
          NEXTJS_BENCH_URL: process.env.NEXTJS_BENCH_URL ?? DEFAULT_URL,
          NEXTJS_BENCH_REF: process.env.NEXTJS_BENCH_REF ?? DEFAULT_REF,
          NEXTJS_BENCH_COMMIT: process.env.NEXTJS_BENCH_COMMIT ?? DEFAULT_COMMIT,
          NEXTJS_BENCH_PACKED_ONLY: process.env.NEXTJS_BENCH_PACKED_ONLY ?? "0",
        },
      },
    }),
  ],
  test: {
    globals: true,
    include: ["src/macro-bench/nextjs-macro.bench.ts"],
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
  },
});
