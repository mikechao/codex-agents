# Bun test worker lifecycle investigation

## Summary

**Historical orphaned PID-1 workers:** The prior investigation observed four Bun test workers, several days old, parented to PID 1 and each near one CPU. Their origin cannot be recovered from retained evidence.

**Fresh high-CPU worker:** The prior investigation observed a different current worker near one CPU after 387/390 reports and beyond two minutes. This investigation did not reproduce that core stall, so its callback and worker stack remain unknown.

**Relationship:** There is insufficient evidence to link the two observations. Keep them as separate failure classes.

## Environment and checkout

- Branch: `main`.
- HEAD: `61a1a836e90f3fa214222a5eda3953a48be1fc9e`.
- Bun: `1.3.13` (`bf2e2cec` on the test-runner output).
- Host: macOS Darwin 25.6.0, Apple M1 Pro, arm64; shell `zsh`.
- Initial `git status --short`: clean.
- Host-wide process state was not available: `ps` and `top` were denied (`operation not permitted`), `pgrep` could not get the process list, and the attempted `libproc.proc_pidinfo` query returned no information. For known experiment PIDs, `lsof -p`, `kill(pid, 0)`, fixture self-reports, and Python `os.getpgid()`/`os.getsid()` supplied identity, liveness, process-group, and session evidence. They did not provide a reliable process-state or CPU sample.

## Existing evidence reused

The existing [test investigation](test-investigation.md) records four days-old Bun workers re-parented to PID 1, each near one CPU. Stopping them improved the next comparable `test:core` time. It separately records a current run stalled after 387/390 reports with a worker near one CPU for more than two minutes; a defunct child was also reported. The three unreported callbacks happened to be in `migration.test.ts`, which does not identify a cause. Historical worker provenance was unavailable. This report does not repeat its benchmark tables, broad suite classification, fixture benchmarks, Trace2 analysis, parallelism comparisons, or validation profiling.

The prior worker command exposed `--test-worker --isolate --timeout=60000 --max-concurrency=20`; its sampled stack was recursive and unsymbolized. The current stalled run was stopped by SIGTERM after about 149 seconds. Neither record preserves ancestry sufficient to connect it to this checkout or a specific callback. Issue [#191](https://github.com/mikechao/codex-agents/issues/191) asks that these symptoms remain separate absent evidence.

## Process topology

The repository test path is caller → `bun run test:core` or `bun run test:runtime` → Bun test coordinator → Bun test workers → repository-owned children where a test starts them. In the inspected current tests, examples include Git/installer subprocesses, Workflow MCP servers, and runtime bootstrap children. Test workers are Bun processes; the test-side `process.argv` in these experiments named the test file but did not expose Bun's internal `--test-worker` flags.

The reviewer path is reviewer-validation process → `node:child_process.spawnSync` of the exact selected argv (commonly `bun run validate`) → Bun run process and its script runner → test coordinator → workers → test-owned children. `reviewer-validation.ts` redirects stdout/stderr to files and sets `shell: false`; it does not create a process group or explicitly clean up descendants.

### Corrected normal completion

The corrected fixture used two test files and an empty release file created before startup. The controller released the callbacks only after observing both workers start. Exact invocation:

```sh
env LIFE_DIR=/tmp/codex-bun-worker-lifecycle-191-20260924 \
  LIFE_LOG=/tmp/codex-bun-worker-lifecycle-191-20260924/normal-final2.jsonl \
  LIFE_MODE=normal \
  bun /tmp/codex-bun-worker-lifecycle-191-20260924/controller.ts
```

The controller ran `bun run lifecycle`; its temporary script ran:

```sh
bun test --parallel=2 --parallel-delay=0 --timeout=60000 ./a.test.ts ./b.test.ts
```

Observed process chain (session 6020): controller PID 6020, PGID/SID 6020 → `bun run` PID 6022, PPID 6020, PGID/SID 6020 → runner PID 6023, PPID 6022, PGID/SID 6020 → coordinator PID 6025, PPID 6023, PGID/SID 6020 → workers 6026 and 6027, each PPID 6025, with respective PGIDs 6026 and 6027 and SID 6020. Both tests passed; coordinator and `bun run` exited 0. The controller found no known process remaining. No test child process was spawned. This is the valid normal-completion observation; the earlier fixture timeout described below is not normal-completion evidence.

## Bun timeout semantics

Bun's official testing documentation describes `--timeout` as a per-test timeout. Its timeout guidance says a timed-out test fails through an uncatchable exception and that child processes spawned by the test are killed. The documentation does not describe `--timeout` as a hard deadline for a test file, coordinator, outer caller, or arbitrary process group. See [Bun test runner](https://bun.sh/docs/test) and [Bun test writing and timeout guidance](https://bun.sh/docs/test/writing-tests). These are current documentation pages, not version-pinned 1.3.13 source.

Version-specific observations here establish that an asynchronous callback waiting on an unreleased file watcher failed after 60 seconds and that its `afterEach` ran. That attempt had a flawed controller synchronization path and is used only for those timeout/hook facts. No child was created in that callback, so the documentation's child-kill behavior was not independently verified for Bun 1.3.13. The separate outer-timeout case shows that an outer `spawnSync` timeout does not itself terminate all processes descended from the selected command.

The experiments do not establish a hard worker or file execution bound from `--timeout=60000`. They also do not establish that timeout hooks/finalizers always finish, or that arbitrary descendants of the outer command are terminated. Under direct coordinator SIGTERM in the corrected experiment, there were no worker teardown records before the workers disappeared; that is termination behavior, not evidence that teardown ran.

## Controlled reproduction matrix

| Path | Exact command / setup | Topology, signals, and exits | Re-parenting, survivors, defunct state | CPU and conclusion |
|---|---|---|---|---|
| Normal completion | Controller invocation and nested `bun test` command are recorded above. | Caller → `bun run` → runner → coordinator → two workers. Two tests passed; coordinator and `bun run` exited 0. No test descendants. | Workers shared the caller's session and had individual process groups. All known PIDs were gone at completion. No process state listing was available. | No CPU sample taken. Ordinary completion was clean in this corrected fixture. |
| Async callback timeout (flawed synchronization fixture) | Temporary `bun run lifecycle` → `bun test --parallel=2 --parallel-delay=0 --timeout=60000 ./a.test.ts ./b.test.ts`; both callbacks awaited an unreleased file watcher. | Each callback reported `this test timed out after 60000ms`; both `afterEach` hooks ran; coordinator exited 1. The controller separately failed to observe its log watcher and was stopped. | No test child was spawned. Later known-PID checks found the workers gone. This run is used only as evidence of per-callback timeout and hook execution, never as normal-completion evidence. | No CPU sample. Confirms this async timeout path and no broader deadline guarantee. |
| Direct coordinator SIGTERM (corrected, controlled run) | `env LIFE_DIR=/tmp/codex-bun-worker-lifecycle-191-20260924/coordinator-term-clean LIFE_LOG=/tmp/codex-bun-worker-lifecycle-191-20260924/coordinator-term-clean/events.jsonl LIFE_MODE=coordinator-term bun /tmp/codex-bun-worker-lifecycle-191-20260924/coordinator-term-clean/controller.ts`; the controller ran `bun run lifecycle`, which launched the same two-file `bun test` command above. | Controller PID 6283 (PPID 6280, PGID/SID 6280) → `bun run` PID 6285 (PGID/SID 6280) → runner PID 6286 (PPID 6285, PGID/SID 6280) → coordinator PID 6288 (PPID 6286, PGID/SID 6280) → workers 6289 and 6290 (PPID 6288; each had its own PGID; SID 6280). The controller sent SIGTERM to live coordinator 6288. It exited with code 130 and `signal: null`; `bun run` also exited code 130. | Both workers were already absent by `kill(pid, 0)` and `lsof -p` when checked after coordinator and `bun run` exit. They did not re-parent as surviving processes. No worker `exit` or `afterEach` event was logged, so their exact termination signal and finalizer behavior were not observed. No descendants existed. Process-state enumeration was unavailable, so no separate zombie-state assertion is made. | No CPU percentage sampled. In this direct-coordinator path, the coordinator and both workers were gone after SIGTERM; no worker survivor was found. |
| Reviewer-style outer timeout (one controlled run) | `env LIFE_DIR=/tmp/codex-bun-worker-lifecycle-191-20260924/reviewer-outer-timeout LIFE_LOG=/tmp/codex-bun-worker-lifecycle-191-20260924/reviewer-outer-timeout/events.jsonl LIFE_MODE=outer-timeout bun /tmp/codex-bun-worker-lifecycle-191-20260924/reviewer-outer-timeout/controller.ts`; the controller called `spawnSync("bun", ["run", "lifecycle"], { shell: false, timeout: 5000, stdio: ["ignore", stdoutFile, stderrFile] })`. The test command used `--timeout=60000`; the outer timeout was 5 seconds. | Controller PID 6338 (PGID/SID 6332) → direct `bun run` PID 6340 → runner PID 6341 → coordinator PID 6343 → workers 6344 and 6345. These main-chain processes shared PGID/SID 6332; each worker had its own PGID. Worker 6344 spawned child 6348, whose PGID was 6344 and SID 6332. `spawnSync` returned `ETIMEDOUT`, `status: null`, `signal: SIGTERM`. PIDs 6340 and 6341 were gone; coordinator 6343, workers 6344/6345, and child 6348 remained alive. SIGUSR1 probes reported worker PPIDs still 6343 and child PPID still 6344, with process groups/sessions unchanged. | The coordinator's PPID after runner exit was not directly available; do not claim PID 1. Workers and child were not re-parented away from their surviving parents. The controller then sent SIGTERM to the exact remaining PIDs; all were absent by final `kill(pid, 0)`/`lsof` checks. No defunct-state listing was available. | No CPU sample. The outer timeout killed the direct command boundary and the runner disappeared, while the coordinator, workers, and worker-owned child survived. This demonstrates why the outer timeout is not process-group cleanup. |
| Outer caller SIGTERM | Not run under the user's narrowed experiment scope. | No observation. | No observation. | No conclusion. |

### Reconciliation of the failed coordinator-fixture attempt

PID 6200 was a genuine live process from an invalid direct-coordinator attempt; it was not a process from the corrected run above. The event log maps it to the `a.test.ts` worker's `spinning callback`: PID 6200, initial PPID 6199 (the attempt's coordinator), PGID 6200, SID 6188, with Bun argv naming the unique `coordinator-term-corrected/a.test.ts` path. The controller had crashed on a JSON parse error before sending its planned SIGTERM. A later controller reused the stale event log, attempted to signal the now-absent coordinator 6199, received ESRCH, and exited. Thus no direct coordinator signal was sent to the tree containing PID 6200.

After that failure, `lsof -p 6200` still showed the Bun executable, the exact fixture cwd, and open descriptors/KQUEUEs. `kill(pid, 0)` returned EPERM under the default sandbox, not ESRCH. This rules out a zombie and, together with the matching event-log PID, executable, and cwd, rules out PID reuse. PID 6223 was a second spinning worker created by the stale-log retry and was likewise excluded from the controlled result. Both known spin-worker PIDs were terminated with the authorized exact-PID elevated SIGKILL after the sandbox denied ordinary signaling; final `kill(pid, 0)` returned ESRCH and `lsof` found neither. This fixture/controller failure is process-hygiene evidence only, not evidence about the corrected direct-SIGTERM path.

## Repository interaction

`.codex/agents/reviewer-validation.ts` uses `spawnSync(command.argv[0], command.argv.slice(1), { cwd, shell: false, timeout: command.timeout_ms, stdio: ["ignore", stdoutFile, stderrFile] })`. The policy sets 120,000 ms for `bun run validate`. There is no explicit process-group or descendant cleanup at that outer boundary. The controlled case used the same Bun `spawnSync` timeout shape and file redirection, but a 5 second timeout around a temporary `bun run lifecycle`, not the actual reviewer-validation command or its 120 second timeout. It reproduced survival of the coordinator, workers, and a repository-test-shaped child beyond that boundary. The observation is strong evidence about this process topology; it is not a run of reviewer validation itself.

The runtime-supervisor tests include explicit child close handling and, for detached bootstrap cases, bounded process-group cleanup; they also cover a descendant holding output pipes open. Protocol transport tests close the SDK transport or send SIGTERM to the raw STDIO server and await child close. Generic workflow fixtures remove temporary repositories but do not own Bun test workers. Installer tests use synchronous Git/installer children; no separate installer worker-ownership path was found in the inspected call sites. No runtime or installer suite was run for this lifecycle report.

The outer timeout result is consistent with a direct-child timeout boundary interacting with Bun's nested run/runner/coordinator processes and test-owned children. Because the reproduction did not execute the actual reviewer-validation module or its full 120 second command, it does not by itself establish that the repository's current reviewer behavior violates its intended contract.

## Fresh 387/390 stall

The 387/390 event did not reproduce in this investigation because `bun run test:core` was not run. The prior run's worker sample was unsymbolized and its process ancestry was not retained. No current process tree or useful stack can be added here.

The three unreported callbacks in `migration.test.ts` concern schema-version documentation, opening/current-schema migration behavior, and rejection of inconsistent persisted validation identity. They exercise SQLite-backed schema/state checks and their fixtures; their position at the end of the report is not causal evidence. The available record does not distinguish JavaScript/SQLite/Git work, a Bun-internal spin, a child wait/spin, teardown, or coordinator/worker protocol trouble. Stop at that uncertainty; do not attribute the incident to those callbacks.

## Historical orphans vs. fresh spin

**Insufficient evidence; keep them separate.** The historical PID-1 workers have no recoverable provenance. The fresh stall has one prior current-run observation but no captured ancestry, useful symbolized stack, or reproduced callback. The bounded lifecycle experiments establish ownership boundaries, not a link between those two incidents.

## Layer attribution

- **Confirmed, normal test/harness completion:** A corrected two-file suite completed with exit 0 and no known test workers or descendants remaining.
- **Confirmed, Bun coordinator/worker lifecycle:** Direct SIGTERM to the live coordinator produced coordinator and `bun run` exit code 130; both workers were gone by the immediate known-PID checks. The workers' exact terminating signal was not observed.
- **Confirmed, per-test timeout:** The asynchronous 60 second callback timeout fired and `afterEach` ran in that flawed synchronization attempt. It does not establish a file, coordinator, outer-caller, or process-group deadline.
- **Confirmed, outer caller/timeout and process-group handling:** The reviewer-shaped `spawnSync` timeout returned ETIMEDOUT/SIGTERM for its direct `bun run` child while the coordinator, workers, and one worker-owned child survived in the caller's session. The direct timeout did not terminate their shared process group. The repository's reviewer boundary has no explicit group cleanup; the experiment did not execute that module itself.
- **Repository-owned test child cleanup:** Runtime-supervisor and protocol tests contain explicit cleanup for their owned child/server cases. Their presence does not change the observed outer `spawnSync` boundary, and the complete runtime suite was not run.
- **Unresolved:** The fresh 387/390 high-CPU worker's cause and its relationship, if any, to historical PID-1 workers.

## Smallest follow-up

1. If reviewer timeout cleanup is required to own the whole command tree, add a focused test around the exact `reviewer-validation.ts` timeout path using a temporary command that leaves a marked child alive. Specify the expected ownership boundary before a separate implementation plan; the smallest likely repository surface is that runner and its timeout test.
2. If the fresh core stall recurs, capture the owning process tree and a useful native or symbolized worker sample before termination. If a minimal standalone Bun fixture then reproduces a Bun-specific worker/coordinator defect, an upstream report should include Bun 1.3.13's exact build, host/OS, minimal files and command, PID/PPID/PGID/session observations, signals and exits, and a CPU/stack sample. No such upstream defect is established by these experiments.
