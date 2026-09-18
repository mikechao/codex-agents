# Issue 138 raw timing/result notes

Baseline: `main` at `95f1ea8cf553ba4d13ac61d1c2f2f8b4db0bb9fe`; initial status clean.
Timing source: `/usr/bin/time -p` `real` values. Commands were run serially unless explicitly comparing Bun worker parallelism.

## Requested commands

- `bun run check`: 0.28s pass; 0.18s pass; 0.18s pass. Output: 77 files checked, no fixes.
- `bun run typecheck`: 0.60s pass; 0.53s pass; 0.53s pass.
- `bun run test:core`: 43.45s pass; 45.61s pass; 45.91s pass. Each: 360 pass, 0 fail, 22 files.
- `bun run test:runtime`: 43.70s fail; 43.91s fail; 43.90s fail. Each: 38 pass, 1 fail, 5 files. Failing test: `bootstrap executes committed supervisor source despite dirty checkout launchers`; managed execution stderr included `bun is unable to write files to tempdir: PermissionDenied` and the test timed out at about 15.13s.
- `bun run test:installer`: 1.99s pass; 2.01s pass; 1.89s pass. Each: 46 pass, 0 fail, 4 files.
- `bun run validate`: 89.29s fail; 89.75s fail; 88.51s fail. In every run, check/typecheck/core passed and the same runtime bootstrap test failed; runtime phase was about 44.0-44.3s.

An approved read-only unsandboxed diagnostic `bun run test:runtime` took 44.24s and failed in the same test. Its child exposed a different underlying diagnostic from the user-global Bun cache: `@kwsites/file-exists` raised `TypeError: debug_1.default is not a function`. This rules out the managed write sandbox as the sole cause but is separate from the core/installer symptom.

## Historical installer reproduction

- Exact test (`--parallel=1`, test-name filter): 0.46s pass; 0.39s pass; 0.37s pass.
- Whole `install-opencode.test.ts` (`--parallel=1`): 1.90s pass; 1.81s pass; 1.86s pass; 19 pass each.
- Current `test:installer` (`--parallel=4`): the three requested-command runs above, all pass.
- Current `test:core` (`--parallel=7`): the three requested-command runs above, all pass.
- No run emitted `Target is not a Git repository`.

## Controlled concurrency

- Same 22-file core set, `--parallel=7`: 43.45s, 45.61s, 45.91s; all pass.
- Same 22-file core set, `--parallel=1`: 119.21s; pass.
- Same four-file installer set, `--parallel=4`: 1.99s, 2.01s, 1.89s; all pass.
- Same four-file installer set, `--parallel=1`: 3.89s, 3.89s, 3.86s; all pass.

## One-pass isolated file timings (`--parallel=1`)

- workflow diagnostics 0.10s; git 5.75s; lifecycle-domain 0.06s; lifecycle 18.69s; migration 0.91s; operator-decision 7.78s; planning 5.17s; protocol-contract 0.08s; protocol-transport 4.91s; protocol 4.77s; top-level runtime-supervisor 2.66s; workflow type-contract 0.07s; workflow-action-registry 0.07s; workflow 38.18s.
- agents change-receipt 2.69s; contract-consistency 8.09s; reviewer-validation 13.93s; type-contract 0.02s.
- installer inspect-git-range 0.48s; install-into 1.73s; install-opencode 1.67s; self-host-opencode 0.08s.

One initial isolated-file probe omitted Bun's required `./` path prefix; Bun ran zero tests and returned its no-match diagnostic. Those zero-test probes were discarded and immediately rerun correctly as recorded above.
