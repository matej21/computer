# Next.js macro benchmark

This benchmark exercises the filesystem through the same high-level Git and
workspace APIs used by Computer. It uses a real Durable Object SQLite backend,
not an in-memory SQL substitute.

The fixture is Next.js `v15.5.2` at commit
`497ec6aa08a33f9e2d65a5c8461f550c2549d3e6`. The checkout contains 24,252
tracked files. Clone, checkout, fixture creation, and sample selection happen
outside the measured sections.

## Run the benchmark

Reserve an otherwise idle physical core. Wall-clock results are not useful
without a CPU lease.

```sh
cpu-lease run -n 2 --no-smt -- \
  npm run bench:macro:nextjs --workspace @cloudflare/computer
```

The normal mode measures these operations:

- packed and loose `git.status`
- `git.add` over the complete checkout
- `git.commit`
- `git.diffSummary` after changing 50 files
- one `readFiles` call for 50 files
- one `rmFiles` call for 50 files
- 50 individual `rm` calls as a control

The report includes wall time, SQL statement counts, read and write statement
counts, and rows read and written. Treat statement counts as the primary signal.
They are deterministic for a fixed revision and fixture. Treat wall time as an
observation from one leased run.

## Compare revisions without bulk APIs

The legacy mode avoids `readFiles` and `rmFiles`. It uses 50 `readFile` calls
and 50 `rm` calls instead, while keeping every Git operation identical. This
lets the benchmark run on revisions from before the bulk filesystem API.

```sh
cpu-lease run -n 2 --no-smt -- \
  npm run bench:macro:nextjs:legacy --workspace @cloudflare/computer
```

To test an older revision, create a temporary worktree at that revision and
copy or cherry-pick the two benchmark-only commits at the tip of
`perf/nextjs-macro-benchmark`. Run the legacy mode in that worktree. Do not
compare a leased result with an unleased result.

## Reference result

The following results were recorded on 2026-08-18. The baseline is
`origin/main` at `849759b`. The current result is the complete optimized stack
at `0eee305`; its tree matches `perf/nextjs-macro-benchmark` before this README
was added. Git rows compare legacy mode on both revisions. Bulk rows compare
the legacy single-file loops with normal mode on the optimized stack.

| Operation | Baseline SQL | Current SQL | Reduction | Baseline time | Current time |
| --- | ---: | ---: | ---: | ---: | ---: |
| `git.status` packed | 875,152 | 117 | 7,480x | 12.375 s | 5.519 s |
| `git.status` loose | 877,542 | 2,095 | 419x | 28.061 s | 6.873 s |
| `git.add` all | 1,702,422 | 76,432 | 22.3x | 82.611 s | 57.259 s |
| `git.commit` | 199,875 | 1,225 | 163x | 26.644 s | 6.107 s |
| `git.diffSummary` | 876,349 | 2,338 | 375x | 20.222 s | 7.714 s |
| 50 file reads versus `readFiles` | 150 | 3 | 50x | 8 ms | 3 ms |
| 50 removals versus `rmFiles` | 1,002 | 12 | 83.5x | 9 ms | 10 ms |
| 50 individual removals | 1,002 | 1,002 | 1x | 40 ms | 12 ms |

Normal mode records 119 statements for packed `git.status`. Legacy mode
records 117 because its individual sample reads warm two lookups before the
measurement. Compare statement counts only between runs that use the same
mode.
