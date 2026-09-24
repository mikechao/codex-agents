# `bun run validate` structural test investigation

## Finding

The current gate is slow because two independent test tiers run serially, and each tier schedules whole files rather than balancing the work inside them. Core is dominated by real Git, receipt, and store scenarios; runtime has a particularly visible file tail. Bun workers also launch many synchronous Git and other child processes. This makes wall time sensitive to both file placement and unrelated CPU consumers.

There is a second, more serious reliability concern: this investigation observed one core worker continue consuming a full CPU after 387 of 390 tests had reported completion. It had not finished three tests after more than two minutes. Four other orphaned Bun test workers, each several days old and each consuming about one CPU in the sampled process view, were also present. Their origin could not be established. After the user authorized termination of those four workers, core became 7.7 seconds faster in the next comparable successful run. The runtime tier remained about 35 seconds. These observations make machine and process state material to validation time.

The fastest successful full validation after that cleanup took 65.39 seconds. A successful full run before cleanup took 72.73 seconds. A separate pre-task local run was reported at about 106 seconds. The available evidence therefore confirms substantial runtime variability, but does not show that the current normal path intrinsically takes 106 seconds. The 120-second reviewer deadline has little headroom over the reported 106-second run, while the 300-second standalone runtime allowance does not protect a `validate` process whose single outer deadline covers both tiers.

The strongest specific growth since #164 is in the text-heavy contract test: evaluating the same named test with the #164-era source and documents took 2.85 seconds; the current source and documents took 10.92 seconds. In full core runs its callback took 12.08 to 20.18 seconds, depending on load. That growth is confirmed. It does not account for the whole gate: another core file finishes later, and a removed ten seconds from one callback would not necessarily save ten seconds from the parallel suite.

The evidence supports a focused scheduling and gate-boundary follow-up. It does not support replacing the fixture system, reducing core parallelism, reclassifying tests just because they are slow, or raising the aggregate timeout as the primary remedy.

## Baseline and scope

- Investigation date: 2026-09-24.
- Branch: `main`.
- Exact HEAD: `aef9aa34ba50d7bce21a173cfbbb4856f3b2d622` (`Reuse validated repair bindings across operator projections`).
- Initial `git status --short`: empty; working tree clean.
- Bun: `1.3.13`; package manager declaration: `bun@1.3.13`.
- Host: macOS 15.6, Apple M1 Pro, 8 physical and 8 logical CPUs, 16 GiB memory.
- Repository files were not changed during measurement. Instrumentation, traces, and probes were kept under `/tmp/codex-test-investigation.eBNk5f`.

The observed scripts in `package.json` are:

```text
check       = biome check . --error-on-warnings
typecheck   = tsc -p tsconfig.workflow-mcp.json && tsc -p tsconfig.agents.json && tsc -p tsconfig.installer.json
test:core   = bun test --parallel=7 --parallel-delay=0 --timeout=60000 ./.codex/workflow-mcp/tests/*.test.ts ./.codex/agents/tests/*.test.ts ./.codex/installer/tests/*.test.ts
test:runtime= bun test --parallel=2 --parallel-delay=0 --timeout=60000 ./.codex/workflow-mcp/tests/runtime/*.test.ts ./.codex/installer/tests/runtime/*.test.ts
test        = bun run test:core && bun run test:runtime
validate    = bun run check && bun run typecheck && bun run test
```

`validate` therefore serializes check, three TypeScript projects, 27 core files, and 5 runtime files. File parallelism exists only inside each Bun invocation. The package has separate `test:agents`, `test:installer`, and `test:workflow-mcp` commands. `.codex/reviewer-validation.json` authorizes the exact argv `bun run validate` with a 120,000 ms timeout and 65,536-byte output cap. It separately authorizes `bun run test:runtime` with a 300,000 ms timeout. The focused agent, installer, and Workflow MCP commands each have 120,000 ms budgets. The policy does not separately list `check`, `typecheck`, or `test:core` as reviewer-selectable commands.

## Commands and timing results

Measurements used `/usr/bin/time -lp` around each requested `bun run` command. Two serial samples were collected for each component and one successful aggregate completed before stale-worker termination; one more aggregate completed after termination. The reported pre-task 106-second run and the earlier 120-second dogfood termination are supplied observations, not runs from this harness.

| Command and context | Wall | User | System | Result |
|---|---:|---:|---:|---|
| `bun run check`, sample 1 | 0.34 s | 0.88 s | 0.10 s | Pass |
| `bun run check`, sample 2 | 0.29 s | 0.86 s | 0.08 s | Pass |
| `bun run typecheck`, sample 1 | 0.94 s | 2.22 s | 0.35 s | Pass |
| `bun run typecheck`, sample 2 | 0.95 s | 2.47 s | 0.36 s | Pass |
| `bun run test:core`, sample 1, stale workers present | 38.19 s | 92.65 s | 58.55 s | 389 pass, 1 fail |
| `bun run test:core`, sample 2, stale workers present | 36.48 s | 93.32 s | 60.54 s | 390 pass, 0 fail |
| `bun run test:runtime`, sample 1, stale workers present | 34.99 s | 30.15 s | 19.64 s | 52 pass |
| `bun run test:runtime`, sample 2, stale workers present | 34.70 s | 30.51 s | 20.07 s | 52 pass |
| `bun run validate`, controlled sample 1, stale workers present | 149.15 s before manual stop | unavailable | unavailable | Stopped after core stopped making progress; see below |
| `bun run validate`, controlled sample 2, stale workers present | 72.73 s | 127.02 s | 82.32 s | Pass; 390 core + 52 runtime |
| `bun run validate`, after the four approved stale workers were stopped | 65.39 s | 117.51 s | 79.73 s | Pass; 390 core + 52 runtime |
| User-reported ordinary local `bun run validate` before investigation | about 106 s | 115.14 s | 86.60 s | Pass, as reported |
| User-reported #189 dogfood `bun run validate` | exceeded 120 s | — | — | Reviewer command ended during runtime with exit 130 |

The first controlled aggregate run completed check and typecheck, then stalled in `test:core`. At 149 seconds, a sampled worker was still using about 92% CPU. The run had reported 387 of 390 tests. The three unreported callbacks were in `migration.test.ts`: “documents the current persisted schema version,” “fresh current-schema stores start with no migration audit behavior,” and “rejects inconsistent persisted validation identity and never treats it as commit-complete.” The worker also had a defunct child. No Bun test summary was emitted. I captured a one-second process sample and stopped that investigation-owned process group with SIGTERM. This was not the reviewer’s 120-second kill; the separate #189 event supplies that 120-second observation.

The next aggregate completed in 72.73 seconds. Its measured stages were check 0.29 seconds, typecheck 0.95 seconds, core 36.63 seconds, and runtime 34.87 seconds. Their sum, 72.74 seconds, matches the measured 72.73-second total within rounding. After the stale workers were stopped, a successful validation took 65.39 seconds; its check and typecheck stages took about 1.04 seconds total, core took 28.93 seconds, and runtime took 35.40 seconds. Again, the component sum matches the aggregate within rounding. There is no measured evidence of material orchestration overhead between stages on successful runs. The aggregate does impose one deadline across those sequential stages.

The first core sample’s one failure was `install-into.ts refuses an incompatible existing OpenCode package manifest`. The assertion said the result did not match the expected “malformed” diagnostic. The exact focused file/test-name probe passed in 0.22 seconds afterward. The captured failure output does not identify the actual stderr mismatch, so its cause remains unknown. It is not the historical “Target is not a Git repository” failure from #138.

Additional scheduling measurements were:

| Exact suite variation | Wall | User | System | Result and limitation |
|---|---:|---:|---:|---|
| Core files at `--parallel=4` instead of 7 | 52.08 s | 95.20 s | 59.32 s | All 390 pass; slower than both seven-worker core samples. Stale workers were still present. |
| Runtime files at `--parallel=3` instead of 2 | 23.31 s | 33.30 s | 23.23 s | All 52 pass; one sample with substantial external CPU activity. A promising scheduling result, not a clean-host comparison. |
| `bun run test:core` with Git Trace2 enabled | 42.21 s | 95.11 s | 68.44 s | All pass; tracing adds overhead and is not a normal timing sample. |
| `bun run test:runtime` with Git Trace2 enabled | 39.04 s | 31.92 s | 23.41 s | All 52 pass; tracing adds overhead and is not a normal timing sample. |

After stale-worker termination, the two-worker runtime stage was 35.40 seconds; the earlier two-worker standalone samples were 34.70 and 34.99 seconds. That is essentially unchanged within the observed variance. The four-worker core comparison is especially clear: reducing core workers to four cost about 15.6 seconds relative to the after-cleanup aggregate core result, although the machine state and invocation context are not identical. The evidence does not support lowering core concurrency.

## Current core critical path

The current core suite runs 390 callbacks in 27 files, compared with 360 callbacks in 25 files at #164 completion. Here is the second successful seven-worker sample, with per-file execution timing reconstructed from the timestamped Bun output. “Span” runs from the first callback’s reported start estimate to the last callback completion; callback durations overlap across workers. The span is not additive.

| Core file | Tests | Span (start–end) | Sum of callback durations | Main work |
|---|---:|---:|---:|---|
| `agents/tests/change-receipt.test.ts` | 21 | 0.08–4.97 s | 4.89 s | Temp Git repositories, real Git, Bun receipt subprocesses, blobs and symlinks |
| `agents/tests/contract-consistency.test.ts` | 63 | 5.01–33.81 s | 28.79 s | Generated-contract and source/document assertions; one temporary Git check |
| `agents/tests/model-policy-view.test.ts` | 5 | 16.09–17.74 s | 1.65 s | Policy parsing and a spawned Solid view probe |
| `agents/tests/reviewer-validation.test.ts` | 25 | 0.09–23.35 s | 23.25 s | Git fingerprints, temporary repositories, spawned validation commands, timeout and output cases |
| `agents/tests/type-contract.test.ts` | 1 | 17.77–17.77 s | <0.01 s | In-process type-shape assertion |
| `installer/tests/inspect-git-range.test.ts` | 5 | 5.11–5.89 s | 0.78 s | Temp Git repositories, tool subprocess, large patch fixture |
| `installer/tests/install-into.test.ts` | 14 | 5.91–8.72 s | 2.80 s | Real installer subprocesses; target Git/config preflight; selected successful installs |
| `installer/tests/install-opencode.test.ts` | 21 | 0.10–3.67 s | 3.57 s | Real installer preflight subprocesses and rollback/config cases |
| `installer/tests/opencode-v2-tools.test.ts` | 4 | 3.80–4.80 s | 1.01 s | V2 source and registration assertions |
| `installer/tests/self-host-opencode.test.ts` | 9 | 4.91–4.93 s | 0.02 s | Read-only source/config assertions |
| `workflow-mcp/tests/diagnostics.test.ts` | 4 | 4.95–5.07 s | 0.12 s | Small temp fixture and diagnostics |
| `workflow-mcp/tests/git.test.ts` | 24 | 0.11–10.50 s | 10.39 s | Real Git, filesystem cases, spawned Bun children and barriers |
| `workflow-mcp/tests/lifecycle-domain.test.ts` | 9 | 10.52–10.61 s | 0.09 s | In-process transition logic |
| `workflow-mcp/tests/lifecycle.test.ts` | 33 | 8.76–36.46 s | 27.71 s | Many temp Git repositories, SQLite stores, receipts and lifecycle matrices |
| `workflow-mcp/tests/migration.test.ts` | 10 | 17.79–19.14 s | 1.35 s | SQLite schema and corruption cases; no standalone runtime build |
| `workflow-mcp/tests/operator-decision.test.ts` | 35 | 0.14–13.57 s | 13.43 s | Decision/store assertions over temporary Git and SQLite facts |
| `workflow-mcp/tests/planning.test.ts` | 31 | 13.61–22.48 s | 8.87 s | Plan and store integration over unique fixtures |
| `workflow-mcp/tests/protocol-contract.test.ts` | 5 | 10.70–10.71 s | <0.01 s | Deterministic protocol contract assertions |
| `workflow-mcp/tests/protocol-transport.test.ts` | 4 | 10.81–16.07 s | 5.26 s | Real STDIO children, SDK shutdown, temp Git and SQLite |
| `workflow-mcp/tests/protocol.test.ts` | 7 | 0.25–8.82 s | 8.58 s | Seven source-server sessions over STDIO and temp state |
| `workflow-mcp/tests/runtime-supervisor.test.ts` | 15 | 8.88–13.17 s | 4.29 s | Mostly in-process routing, WAL and injected-child cases; the real immutable runtime scenarios are in `tests/runtime/` |
| `workflow-mcp/tests/type-contract.test.ts` | 1 | 13.24–13.24 s | <0.01 s | In-process type-shape assertion |
| `workflow-mcp/tests/workflow-action-registry.test.ts` | 4 | 13.28–13.28 s | <0.01 s | In-process registry assertions |
| `workflow-mcp/tests/workflow-commit-result.test.ts` | 7 | 0.17–16.92 s | 16.75 s | Real Git and SQLite commit/result matrix |
| `workflow-mcp/tests/workflow-lifecycle-repair.test.ts` | 12 | 16.94–35.90 s | 18.96 s | Real store/Git repair flows and path-capacity cases |
| `workflow-mcp/tests/workflow-runtime-integrity.test.ts` | 13 | 13.31–26.62 s | 13.31 s | Runtime-integrity state/store cases; not a built standalone runtime suite |
| `workflow-mcp/tests/workflow-staged-recovery.test.ts` | 8 | 19.20–33.63 s | 14.43 s | Real Git/store recovery and path-capacity cases |

On that run, `lifecycle.test.ts` was the last core file, ending at 36.46 seconds. It was preceded by `workflow-lifecycle-repair.test.ts` at 35.90 and `workflow-staged-recovery.test.ts` at 33.63. The largest callbacks were the contract/document test (20.18 seconds), staged reconciliation (8.98), combined-review path overflow (8.17), commit preparation (7.12), and Git fingerprint marker matrix (6.77). These values show multiple substantial workers converging on the tail; a single-file fix does not explain the whole suite.

After stale-worker cleanup, core finished in 28.93 seconds. The same named contract/document test took 12.08 seconds, lifecycle took 22.14 seconds of callback time and finished near the core tail, and the largest path/Git cases took 6.56, 6.44, and 5.71 seconds. The lower time is consistent with removing competing CPU workers; the underlying expensive contracts remain.

## Current runtime critical path

The two-worker runtime sample ran 52 callbacks in five files. Bun 1.3.13 sorts test paths lexically and assigns contiguous ranges to workers; a worker receives another file when its current file finishes. The current file durations leave a long tail:

| Runtime file | Tests | Span (start–end) | Sum of callback durations | Main work |
|---|---:|---:|---:|---|
| `installer/tests/runtime/install-into.test.ts` | 8 | 0.06–13.71 s | 13.66 s | Dogfood target creation, copied source/provider, real Git and real installer |
| `installer/tests/runtime/install-opencode.test.ts` | 7 | 13.73–16.15 s | 2.42 s | Real installer and target preservation |
| `workflow-mcp/tests/runtime/standalone-runtime.test.ts` | 5 | 16.22–17.32 s | 1.10 s | Standalone compile/smoke boundaries, including fake compiler cases |
| `workflow-mcp/tests/runtime/runtime-artifact.test.ts` | 13 | 0.13–17.60 s | 17.47 s | Runtime closure, artifact integrity, one compiled-server launch |
| `workflow-mcp/tests/runtime/runtime-supervisor.test.ts` | 19 | 17.36–34.70 s | 17.34 s | Child lifecycle and historical-runtime behavior |

The slowest runtime callbacks were real historical-owner recovery after promotion (13.55 seconds), launching a materialized server (7.87), committed runtime-closure inspection (3.59), and two installer source-copy/provider cases (3.74 and 3.63). Runtime file scheduling, rather than fixture initialization alone, determines the remaining tail: `runtime-supervisor.test.ts` began after the other worker had nearly exhausted its queue and then ran to the end. In the after-cleanup full validation, installer runtime ended at 45.73 seconds, runtime artifact at 46.90, and supervisor at 50.07 after a different assignment; the complete stage still measured 35.40 seconds. A clean full-validation process trace was not retained at per-file granularity, so that last difference is not a controlled scheduler comparison.

At three workers, the one measured runtime run ended in 23.31 seconds. The supervisor and artifact files overlapped from near the start; the supervisor finished at 23.16 and artifact at 23.30. This suggests the second worker’s file queue is an avoidable part of the current two-worker tail. The run passed all 52 callbacks, but it occurred while external CPU activity was high, and it has not been repeated on the cleaned machine.

## Process and concurrency observations

The test processes are not CPU-isolated test callbacks. The `test:core` coordinator spawned up to seven Bun worker processes. A process snapshot saw 25 processes under the sampled core command, including Bun workers, Git children, and a source Workflow MCP server child. The runtime snapshot saw up to 10 processes at two workers and 12 at three. Within workers, `execFileSync`/`spawnSync` calls block while launching Git, Bun, installers, or server processes. Therefore seven file workers can create nested process and I/O pressure; the `--parallel` value is not a count of all live work.

Git Trace2 counted **16,002 Git process starts** during one core run: 6,675 `rev-parse`, 5,203 `cat-file`, and 1,883 `ls-tree` (13,761 total, 86% of starts). It counted 99 `git init`. The `workflow-state-*` temporary repositories accounted for 12,533 starts; reviewer-validation fixtures accounted for 2,245. Git reported 59.37 seconds summed across command durations during the 42.21-second traced run. These command durations overlap across workers and must not be read as exclusive wall time. They do show that core cost is dominated by repeated required Git reads/process boundaries, while repository initialization is a small share.

Trace2 counted **5,032 Git starts** in runtime: 2,909 `cat-file`, 1,512 `ls-tree`, and 231 `rev-parse`; 47 were `git init`. Git reported 23.04 seconds summed across commands in the 39.04-second traced sample. Repeated runtime-closure reads are visible: committed `types.ts` was probed 72 times at the current HEAD during this run. Runtime artifact and supervisor tests intentionally validate manifests against multiple revisions and tampering states, so the trace does not establish that those reads are redundant or removable without changing the tested contract.

Four pre-existing processes were Bun test workers with `--test-worker --isolate --timeout=60000 --max-concurrency=20`, parent PID 1, and start dates September 18–19. Their elapsed ages were about 4 days 23 hours to 6 days; process samples showed roughly 95–99% CPU for each. A one-second sample of one worker showed a heavily recursive, unsymbolized Bun stack. The command line did not expose its working directory or originating coordinator. These processes are temporally consistent with abandoned test-investigation attempts, including the period of #164, but their origin cannot be confirmed.

The user approved terminating exactly those four PIDs. They exited after SIGTERM. Before termination, successful full validation took 72.73 seconds and core alone took 36.63. The next successful aggregate took 65.39 seconds and core took 28.93, a 7.70-second core reduction and 7.34-second aggregate reduction. Runtime measured 34.87 in the first aggregate and 35.40 after termination. This is direct evidence that competing orphaned workers materially affected core, not evidence that they caused any particular prior timeout. After termination, process snapshots still showed median external CPU activity of about 94% while the measured validation was running, so the host was not otherwise idle.

There were no recursive `bun run validate`, `bun run test`, or validation-command executions by the test suite in the sampled runs. Tests do run the real `install-into.ts`, Bun receipt utilities, Bun children, source Workflow MCP servers, and standalone runtime compilers. They use temporary targets and generally clean them in `finally`. The core installer files had selected successful installation/build paths, but remain inexpensive (2.80 and 3.57 seconds in the successful core sample) alongside many preflight and config cases. They do not explain a 35-second core tail.

Normal samples did not show a material contribution from fixed sleeps or request timeouts. `protocol-transport.test.ts` deliberately tests SDK cleanup after a 25 ms request timeout; Bun’s SDK close path has a 2-second graceful wait before SIGTERM and another 2-second wait before SIGKILL, but the child in the passing case exits promptly. Runtime child harnesses use bounded request waits. #181’s original 10.72-second failing promotion test is consistent with its 10-second request timeout, but the same scenario’s earlier investigation passed in about 1.5–1.8 seconds. No normal 35-second runtime sample was spent waiting for a request timeout.

## Repeated setup and fixture analysis

The Workflow MCP test fixture already provides a reusable immutable Git template per Bun worker. It initializes and commits that template once, then copies it into unique temporary repository roots. Stores and databases are test-owned and closed/removed. A bounded probe recorded:

| Fixture operation | Measured cost |
|---|---:|
| First fixture, including template creation | 54.56 ms |
| Next 50 fixture copies | 42.83 ms total, 0.86 ms mean |
| 200 in-memory `WorkflowStore` create/close cycles | 43.08 ms total, 0.22 ms mean |

This rules out a missing general-purpose shared Git fixture as the main explanation for core’s 29–36 second runtime. Real receipt verification repeatedly calls Git by design, and the Trace2 counts are concentrated in those reads rather than `init`.

Installer dogfood tests have a separate `sourceCopy()` helper that copies repository source while excluding `.git`, `node_modules`, and transient build outputs, then links dependencies and creates an isolated Git source. Several independent provider and manifest cases invoke that setup. The 3.5–3.8-second copied-provider callbacks confirm localized repeated setup. The current tests need independent source mutations and target preservation checks, so shared mutable roots would be unsafe. A reusable immutable source snapshot might reduce this localized cost, but no experiment measured it and it is not the dominant full-suite path.

Runtime artifact tests deliberately create separate caches to test fresh materialization, reuse, tampering, rebuild, and historical revision identity. Runtime-supervisor integration creates committed providers and launches actual children. Their real Git and runtime work is a valid boundary guarantee. No evidence shows that generated-agent definitions or OpenCode config generation is repeated across the aggregate gate outside the test cases that explicitly verify separate installer outcomes.

## Core/runtime classification

Classification remains sensible by behavior. Slow Git/SQLite integration is not, by itself, runtime-tier behavior. The core inventory above includes deterministic registry/type contracts, ordinary store/Git integration, real source-server protocol tests, reviewer-command fingerprint/process tests, and a handful of selected installer processes. None of those core files materializes historical runtime artifacts or launches the real immutable runtime supervisor path.

The five runtime files exercise compiled or committed runtime artifact behavior, runtime-supervisor process/lifecycle behavior, real dogfood installation into isolated targets, or combinations of those boundaries. They are correctly grouped as runtime/integration tests. The two installer runtime files each contain a mix of cheap config assertions and real installation scenarios, but their whole files are still small relative to the runtime tier. Moving one because it takes 13.7 seconds would hide actual dogfood boundary work behind a folder name without reducing the measured work.

The notable taxonomy issue is latency within the runtime tier: a two-worker, five-file suite gives each worker contiguous paths, while `install-into.test.ts`, `runtime-artifact.test.ts`, and `runtime-supervisor.test.ts` each carry a substantial portion of the total work. At three workers the same five files completed in 23.31 seconds. That is a scheduling boundary, not evidence that any file belongs in core.

## Comparison with #138, #164, and #181

**#138 — runtime-like tests in core.** Its main conclusion remains true: installer second-run Git failure did not reproduce, and current slow core files are real Git/SQLite/process integration rather than incorrectly placed immutable-runtime tests. The current standalone focused preflight test passed. This investigation did see one unrelated malformed-package diagnostic assertion fail once in core; it passed on the focused probe. That new failure is not enough to reverse #138’s classification result, but the missing underlying stderr means it remains unexplained.

**#164 — core critical path.** The four-way split of the old 39-test `workflow.test.ts` remains structurally useful. It removed one 38-second worker tail while preserving real Git and store behavior; current seven-worker core still depends on the four separate workflow files. #164’s measurement of 360 callbacks across 25 files and its 31.83-second mean described that checkout and test set, not today’s `main`.

Since #164, core grew from 360 to 390 callbacks and from 25 to 27 files. Current tests include OpenCode V2 and model-policy view coverage, additional workflow/store contracts, and later orchestrator/repair behavior. `contract-consistency.test.ts` now reads substantially expanded orchestrator guidance and orchestration documentation. A bounded out-of-tree probe evaluated the same named callback using the #164-era file/documents and current HEAD: 2.85 seconds total then, 10.92 seconds now. The orchestrator source grew from 28,485 to 33,764 characters in the probe; the orchestration-flow document grew from 42,914 to 43,241. In the current callback, several broad `.*` regular-expression assertions over the flattened document individually took about 1.12–4.31 seconds. Under the successful core suite, that callback took 20.18 seconds with stale workers present and 12.08 after cleanup. This is a confirmed cost increase since #164. The complete suite still ends later in `lifecycle.test.ts`, and file times shift under contention, so the callback’s isolated difference is not an expected full-gate saving.

**#181 — runtime-supervision diagnostics/stability.** Its test-harness improvements remain relevant and the runtime file remains correctly in `tests/runtime/`. The suite now has 52 callbacks rather than the 40 in #181’s original failure report; the #181 implementation itself added 12 diagnostic/cleanup cases, most of which are short in current output. Current runtime samples pass all 52 in about 35 seconds at two workers. The real historical-owner adoption case remains an approximately 13.55-second callback. #181 fixed diagnostic blind spots and child cleanup behavior in its target harness; it did not change the two-worker scheduling topology or address core worker orphaning. Its earlier 52.85-second failing output is a useful historic run, not a comparable all-pass timing baseline.

## Validation deadline assessment

On successful runs, standalone stage measurements reconcile with aggregate execution; aggregation itself adds no meaningful observed cost. The deadline risk comes from serial stage composition and failure modes that can outlive a normal test callback, not from the shell script adding time. The current 120-second aggregate cap is about 1.8 times the post-cleanup 65.39-second run, 1.65 times the loaded 72.73-second run, and only 14 seconds above the separately reported 106-second run. The observed stalled worker had not finished after 149 seconds. In the supplied #189 dogfood event, the 120-second reviewer allowance killed validation while runtime was active, while the independently authorized runtime command allows 300 seconds.

Keeping one aggregate convenience command is useful, but its single 120-second reviewer boundary does not represent the independently authorized component budgets. Canonical reviewer validation should make the component outcomes explicit and require both core and runtime results for a complete pass. Splitting the policy boundary alone will not repair a stuck Bun worker; it will prevent an unrelated completed stage from being hidden inside an undifferentiated aggregate timeout and will preserve the runtime stage’s documented budget. No evidence supports a larger timeout as the sole fix.

## Strongest structural explanation

The strongest explanation is the combination of three measured effects:

1. **Process-heavy, file-parallel core work plus orphaned CPU consumers.** Core launched up to seven Bun workers; individual workers launch many synchronous Git processes. The stale workers consumed several CPU cores for days and the next comparable core run improved by 7.70 seconds when they were removed. A separate current worker stall passed 120 seconds with no test summary. Repeated caller-by-caller fixture micro-optimizations cannot provide reliable timing while worker/process ownership can escape the invoking gate.
2. **Unweighted runtime file scheduling.** Two-worker runtime completed in about 35 seconds, with its last supervisor file occupying almost the entire final half. The three-worker sample completed in 23.31 seconds by overlapping the major files. Bun’s lexical contiguous file assignment does not account for current file durations.
3. **A larger current core workload.** The core set is 30 callbacks and two files larger than #164’s set. A text-heavy callback alone grew from 2.85 to 10.92 seconds in the bounded historical/current probe. Core still runs in 29–36 seconds because other real integration files also determine the tail.

Fixture initialization is not the structural root: shared Git templates already exist, 50 copies cost 42.83 ms, 200 store cycles cost 43.08 ms, and Git tracing saw 99 initializations against 16,002 Git invocations. Nor does one test-tier misclassification explain the timing: real runtime cases are already separated, and the core files are correctly classified by behavior.

## Smallest evidence-backed follow-ups

1. **Make validation’s latency boundary explicit.** Keep `validate` as a local full-gate convenience, while reviewer validation runs and records independently budgeted core/check/typecheck and runtime outcomes and requires all of them for a complete validation result. The exact component policy surface needs a core owner; the current selectable policy has `test:runtime` but not `test:core`, `check`, or `typecheck`. Expected benefit: avoid having one 120-second reviewer invocation erase which serial stage completed and align the runtime check with its existing 300-second component allowance. This does not reduce successful local wall time or cure the captured spinning worker. Likely targets: `package.json`, `.codex/reviewer-validation.json`, and the command-contract assertions in `.codex/agents/tests/reviewer-validation.test.ts`.
2. **Evaluate a third runtime file worker.** One direct three-worker run passed all 52 tests in 23.31 seconds versus 34.70–35.40 seconds in two-worker samples, a measured 11.4–12.1-second reduction (about 33–34%). It overlapped the supervisor and artifact files and removed the long two-worker queue tail. This is a strong candidate, but the single three-worker sample ran amid heavy external CPU activity. Confirm it on a clean host before adopting it; the tradeoff is a third worker and more simultaneous Git, compiler, and child-process load. Likely targets: the `test:runtime` script in `package.json`, its exact expected command in `.codex/agents/tests/reviewer-validation.test.ts`, and any architecture guidance that records the chosen worker cap.

## Changes the evidence does not justify

- Lowering `test:core` parallelism: the four-worker sample took 52.08 seconds; successful seven-worker samples took 36.48 seconds loaded and 28.93 seconds after stale-worker cleanup.
- Moving tests from core to runtime because they use Git, SQLite, or real children. That would change ownership without removing work; existing real immutable-runtime scenarios already live in the runtime tier.
- Replacing real Git/receipt/runtime integration with mocks, sharing mutable repositories or stores, adding retries, or broadly weakening assertions.
- A repository-wide fixture rewrite as the primary performance change. Its measured template/copy/store costs are milliseconds; the expensive core contract performs thousands of required Git reads.
- Treating the 10.92-second contract callback as a guaranteed 8-second full-gate win. It is a real regression, but current core’s last file is `lifecycle.test.ts` and aggregate benefit has not been measured.
- Raising the aggregate reviewer timeout by itself. A worker that consumes CPU without reporting completion will use the extra time without making validation more reliable; the issue is ownership and gate boundaries as well as duration.

## Remaining uncertainty

- The originating coordinator, working directory, and test run for the four orphaned Bun workers were not observable. Their timing overlaps the #164 investigation period but does not establish provenance.
- The unsymbolized spinning worker’s exact code path is unknown. Three migration callbacks were pending, but the evidence does not prove that a migration callback caused the CPU loop. The Bun 60-second test timeout did not produce a summary before the worker had run for more than two minutes.
- The one malformed-package assertion failure did not reproduce in the focused probe; its actual stderr and cause were not captured in the summarized assertion output.
- The reported 106-second run has no per-stage trace. We cannot attribute its roughly 40-second difference from the post-cleanup 65.39-second aggregate to one specific file or environmental factor.
- Only one three-worker runtime run was measured, and it ran under high external CPU load. Its 23.31-second result should be repeated on a clean host before changing the cap.
- Git Trace2 durations overlap. The trace counts prove frequent process starts, but they do not identify how much wall time a hypothetical Git API or batching change would save while preserving subprocess semantics.
- The out-of-tree contract probe shows higher work in current source and documents; exact improvement from narrowing those assertions or changing the document-test seam was not tested against the complete core critical path.

Useful next measurements before implementation are a clean-host repeat of runtime at two and three workers, a bounded reproduction with per-process exit/parent tracking for the worker stall, and one current-core critical-path sample that separates the contract callback from lifecycle/recovery file completion. Those are investigation gaps, not evidence for a particular code change.

## Reproduction commands

The requested baseline/component invocations were run serially as written:

```sh
bun run check
bun run typecheck
bun run test:core
bun run test:runtime
bun run validate
```

The bounded scheduler comparisons used the same current test file sets with these explicit Bun options: core `--parallel=4 --parallel-delay=0 --timeout=60000`, runtime `--parallel=3 --parallel-delay=0 --timeout=60000`. The repository’s configured comparison values are core 7 and runtime 2. One run of each suite also inherited `GIT_TRACE2_EVENT` pointing to an out-of-repository JSONL trace. Process samples used `ps`; host capacity used `sysctl`; one-second stacks used macOS `sample`. Focused probes evaluated the historical/current named contract callback and measured the existing fixture helper; the malformed-manifest test-name probe passed in 0.22 seconds. No repository tests, scripts, or production files were changed for these measurements.
