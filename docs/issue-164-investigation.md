# GitHub issue #164 investigation report

## Conclusion

A bounded implementation change is justified: split only
`.codex/workflow-mcp/tests/workflow.test.ts` into four independently schedulable, logically cohesive
test files, while keeping every existing assertion, real Git/SQLite interaction, fixture boundary,
and `test:core` parallelism setting unchanged.

The repeated out-of-repository simulation reduced `test:core` from a fresh valid current-main range
of 43.06-49.57s to 29.36-32.38s. The split mean was 31.15s, 15.17s (32.8%) below the fresh
unsplit mean of 46.32s and 13.84s (30.8%) below issue #138's three-run mean of 44.99s. Even the
most conservative comparison, the slowest split run against the fastest fresh baseline, saved
10.68s (24.8%). Splitting `lifecycle.test.ts` as well regressed the all-pass suite to 36.06s, so the
remediation should not broaden beyond the dominant workflow file.

## Baseline and repository state

- Branch: `main`
- HEAD, `main`, and `origin/main`: `2cb1c5bdebf116fa003b3057801b7951baba8651`
- Commit subject: `Issue 138 investigation #138`
- Bun: 1.3.13
- Initial worktree: clean
- Code and tests are byte-identical to issue #138's baseline; the only commits since its measured
  HEAD add `docs/issue-138-investigation.md` and `docs/issue-138-timings.md`.
- `test:core` remains the same 22-file, `--parallel=7`, `--parallel-delay=0`, 60-second-per-test
  command.

Issue #138 recorded three all-pass runs of 43.45s, 45.61s, and 45.91s (mean 44.99s). Fresh #164
all-pass runs were:

| Run | Wall time | Result |
|---|---:|---|
| Current main 1 | 43.06s | 360 pass, 0 fail, 22 files |
| Current main 2 | 49.57s | 360 pass, 0 fail, 22 files |
| Mean | 46.32s | all pass |

Two other aggregate attempts were excluded from timing: each stopped making progress in a worker
after other files had completed, and was manually ended only after it was clear no bounded sample
would result. One had reported 327/360 passing tests. A split-suite attempt similarly stalled before
one split worker's first active test after 351 passes. Isolated reruns of the implicated files passed
normally. These are invalid wall-clock samples, not evidence of a test assertion failure or a reason
to change concurrency; the valid aggregate samples and all controlled experiments passed. The
intermittent synchronous-child stall is noted here so it is not silently folded into timing variance.

## Dominant-file profile

### `workflow.test.ts`

An isolated run took 41.25s for 39 tests. Bun-reported per-test durations summed to 41.19s, so the
cost is inside test execution rather than module collection or runner startup. The slowest cases were:

| Test | Time |
|---|---:|
| combined-review path overflow suppresses reconciliation and preserves unchanged retry | 6.54s |
| infeasible staged reconciliation advertises retry after accidental staging is removed | 6.30s |
| commit preparation store matrix preserves Git state and routes every failure | 4.33s |
| non-persistable staged paths retain retry-only recovery without reconciliation | 3.25s |
| commit verification distinguishes every prepared-result mismatch and preserves terminal guards | 2.07s |
| commit preparation failures distinguish staged scope, stale review, and retry recovery | 1.50s |

Those six tests account for 24.0s, about 58% of the isolated file.

Git Trace2 recorded 6,080 Git processes in the file:

| Git operation | Count | Summed Git-internal time |
|---|---:|---:|
| `cat-file` | 2,960 | 5.27s |
| `rev-parse` | 1,970 | 2.00s |
| `ls-tree` | 687 | 1.32s |
| all other Git commands | 463 | 1.52s |
| Total | 6,080 | 10.11s |

The gap between 10.11s of Git-internal time and 41.25s wall time includes thousands of synchronous
process launches/pipe round trips and receipt/store work around those commands. Targeted traces made
the concentration explicit:

- `infeasible staged reconciliation...`: 6.81s, 900 Git processes, including 826 `cat-file` calls.
- `combined-review path overflow...`: 6.58s, 925 Git processes, including 800 `cat-file` calls.
- A representative ordinary `fresh store API...` case: 0.44s and 55 Git processes.

The expensive cases deliberately exercise real receipts and commit-preparation behavior at the
200-path protocol limit. Replacing that work with mocks or smaller matrices would weaken the exact
coverage the issue requires.

### Fixture and SQLite setup

The fixture helper already creates one immutable Git template per worker and copies it into unique
`mkdtemp` roots. A bounded microbenchmark measured:

- first fixture, including template Git initialization and commit: 58.66ms;
- next 50 fixture copies: 48.46ms total, 0.97ms mean;
- 200 in-memory `WorkflowStore` initialize/close cycles: 43.36ms total, 0.22ms mean.

Consequently, cross-test baseline reuse is not a worthwhile target. It would add isolation and cleanup
risk to save milliseconds, while the dominant file spends tens of seconds in observable Git/receipt
operations. Splitting duplicates the one-time template setup in each worker, but that overhead is
small and is already included in the full-suite experimental timings.

## Secondary-file profile

| File | Isolated time | Main attribution | Critical-path conclusion |
|---|---:|---|---|
| `lifecycle.test.ts` | 17.41s untraced; 19.98s with Trace2 | 2,982 Git processes; top dirty-adoption case 2.02s | Important after workflow is split, but splitting it too made the suite slower. |
| `reviewer-validation.test.ts` | 14.91s | 2,276 Git processes; fixed-operation-marker fingerprint matrix 4.56s; bounded timeout case 1.20s | Real fingerprint/process coverage; not the new single-file tail after scheduling effects. |
| `contract-consistency.test.ts` | 8.41s | CPU-heavy descriptor/source assertions; only 9 Git processes/0.047s | Not setup, generation, or Git bound; too small to justify further fragmentation. |

No-match import/collection probes took only 0.03-0.09s for the primary files. This rules out large
top-level source generation/parsing as the explanation for their isolated costs.

## File-organization experiments

All experiments ran in a disposable `/tmp` mirror. Production source was unchanged. Each active test
body and assertion was copied byte-for-byte; excluded bodies in each simulated part were registered
as skipped, so each original test ran exactly once. The mirror used the repository's same dependencies
and read-only Git metadata. The package glob automatically scheduled the additional files at the
unchanged `--parallel=7` setting.

### Four duration-balanced workflow files

The 39 tests were assigned to four independent parts using the isolated per-test measurements. Every
test owns a unique fixture root and store; the shared fixture template is worker-local and immutable,
so there is no cross-test ordering or mutable-state dependency.

| Run | Full `test:core` wall time | Result |
|---|---:|---|
| Split 1 | 29.36s | 360 pass, 0 fail |
| Split 2 | 31.71s | 360 pass, 0 fail |
| Split 3 | 32.38s | 360 pass, 0 fail |
| Mean / range | 31.15s / 3.02s | repeatable all-pass improvement |

Per-part Bun-reported execution time under full-suite contention:

| Part | Tests | Run 1 | Run 2 | Run 3 | Mean |
|---|---:|---:|---:|---:|---:|
| Part 1 | 9 | 15.14s | 16.00s | 16.40s | 15.85s |
| Part 2 | 10 | 12.04s | 13.38s | 13.46s | 12.96s |
| Part 3 | 9 | 14.69s | 15.71s | 15.77s | 15.39s |
| Part 4 | 11 | 12.36s | 14.11s | 14.21s | 13.56s |

No part recreates the original 41.25s single-worker tail. The roughly balanced parts let Bun overlap
the max-path and commit matrices with lifecycle, reviewer-validation, and contract-consistency work.

A five-file contiguous semantic grouping also passed in 32.97s. It was still materially faster than
the unsplit baseline, but slower than the balanced four-way organization. This shows that the final
split should preserve coherent domains while using the measured case weights to avoid placing both
6.3-6.5s path-capacity cases in one part.

### Splitting lifecycle too

With workflow still split, partitioning `lifecycle.test.ts` into four additional independently
scheduled parts produced an all-pass 36.06s run. That is 3.68-6.70s slower than the three focused
workflow-only runs. Additional module/template duplication and worker queue displacement outweighed
the available lifecycle parallelism. No lifecycle split is recommended.

## Recommended bounded remediation

Plan one organizational-only change:

1. Replace `.codex/workflow-mcp/tests/workflow.test.ts` with four focused files, for example:
   - `workflow-lifecycle-repair.test.ts`
   - `workflow-runtime-integrity.test.ts`
   - `workflow-staged-recovery.test.ts`
   - `workflow-commit-result.test.ts`
2. Keep common helper functions in a test-only helper module if needed to avoid copying helper code;
   do not share mutable fixtures or stores.
3. Assign the two 200-path capacity cases and the 4.33s preparation matrix across different files,
   using this report's measured weights, while retaining coherent scenario groupings.
4. Do not change `package.json`: its existing workflow test glob will discover all four files and
   retain `--parallel=7`.
5. Preserve every existing assertion and real Git/SQLite/process boundary. Do not alter Workflow MCP
   production/state-machine behavior.

Expected benefit: approximately 11-15s from current `test:core` wall time, with the measured target
range around 29-32s rather than 43-50s. Require at least three all-pass `bun run test:core` repetitions
and the full authorized `bun run validate` gate during implementation. If a cohesive final allocation
cannot retain a repeatable material gain, do not merge the split.

Not recommended for #164:

- splitting `lifecycle.test.ts` or other secondary files;
- changing parallelism;
- moving tests to `runtime/`;
- mocking Git, SQLite, receipts, or process behavior;
- sharing mutable repositories/stores across tests;
- production receipt/Git batching in this change. The Trace2 data may motivate a separate semantic
  optimization investigation, but it is broader and riskier than the proven file-organization fix.

## Final state

Repository files were not modified during this investigation. All instrumentation, copied test
files, logs, traces, and timing files were created under `/tmp` only. The disposable experiment state
was removed after this report was written, and the repository worktree was verified clean.
