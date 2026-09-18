# GitHub issue #138 investigation report

## 1. Baseline

- Repository: `mikechao/codex-agents`
- Branch: `main`
- HEAD: `95f1ea8cf553ba4d13ac61d1c2f2f8b4db0bb9fe` (`origin/main` also pointed there)
- Initial working tree: clean (`git status --short` produced no output)
- Live issue: #138 was available through `gh`, open, and its body matches the requested investigation-first scope and historical observations.
- Runtime: Bun 1.3.13 as selected by `package.json`.
- Repository files were not modified. All test fixtures/build outputs were outside the repository or in per-test temporary targets.

## 2. Current validation topology

| Script | Exact command/composition | Scheduling |
|---|---|---|
| `check` | `biome check . --error-on-warnings` | One script stage; read-only. |
| `typecheck` | `tsc -p tsconfig.workflow-mcp.json && tsc -p tsconfig.agents.json && tsc -p tsconfig.installer.json` | Three `tsc` invocations, serial because of `&&`. |
| `test:core` | `bun test --parallel=7 --parallel-delay=0 --timeout=60000 ./.codex/workflow-mcp/tests/*.test.ts ./.codex/agents/tests/*.test.ts ./.codex/installer/tests/*.test.ts` | Exactly 22 top-level files. Bun uses up to 7 worker processes for files, starts workers without delay, implies per-file isolation, and applies 60,000ms per-test timeout. Nested `runtime/` files do not match the non-recursive globs. |
| `test:runtime` | `bun test --parallel=2 --parallel-delay=0 --timeout=60000 ./.codex/workflow-mcp/tests/runtime/*.test.ts ./.codex/installer/tests/runtime/*.test.ts` | Exactly 5 runtime files, up to 2 isolated file workers, 60,000ms per test. |
| `test:installer` | `bun test --parallel=4 --parallel-delay=0 --timeout=60000 ./.codex/installer/tests/*.test.ts` | Exactly 4 top-level installer files, up to 4 isolated file workers, 60,000ms per test. It is not separately invoked by `validate`; those files run once through `test:core`. |
| `test` | `bun run test:core && bun run test:runtime` | Core then runtime, serial at suite level. |
| `validate` | `bun run check && bun run typecheck && bun run test` | Check, three typechecks, core, then runtime; all serial at stage level. Parallelism exists only inside the two Bun test invocations. |

The runtime tier currently contains Workflow MCP `runtime-artifact`, `runtime-supervisor`, and `standalone-runtime`, plus installer runtime `install-into` and `install-opencode`.

## 3. Complete `test:core` inventory and classification

All costs are one isolated `--parallel=1` file run and are rough, not microbenchmarks. “Git” means real external Git subprocesses, often through the shared fixture helper. The workflow fixture helper creates an immutable template per worker and copies it to unique `mkdtemp` roots; test roots/SQLite files are fixture-local and generally removed in `finally`. It has no repository-local or cross-worker target path.

| File | Actual execution characteristics | Runtime/build/server and isolation assessment | Cost |
|---|---|---|---:|
| `workflow-mcp/tests/diagnostics.test.ts` | Mostly deterministic diagnostic/FS behavior; unique temp dirs; one temp Git + SQLite store fixture. | No runtime build or server. Default home path is computed only; writes use explicit temp dirs. Low concurrency risk. | 0.10s |
| `workflow-mcp/tests/git.test.ts` | FS-heavy temporary Git lifecycle; many real sync/async Git subprocesses; selected Bun CLI children and local Git shims/barriers. | No runtime build/server. Unique repos and shim dirs; moderate load sensitivity, no shared mutable target. | 5.75s |
| `workflow-mcp/tests/lifecycle-domain.test.ts` | Deterministic in-process state/transition logic. | No temp repo, child, build, or server; low sensitivity. | 0.06s |
| `workflow-mcp/tests/lifecycle.test.ts` | Mixed domain/store integration; many unique temp Git repositories, SQLite stores, and real Git operations. | No runtime build/server. FS/Git-heavy but fixture-local; slow ordinary integration, not runtime-system work. | 18.69s |
| `workflow-mcp/tests/migration.test.ts` | Temporary SQLite schema/corruption fixtures plus selected temp Git fixtures. | No server/build; local cleanup; low shared-resource risk. | 0.91s |
| `workflow-mcp/tests/operator-decision.test.ts` | In-process decision logic combined with many unique Git/SQLite fixtures and live Git facts. | No server/build; fixture-local; ordinary integration. | 7.78s |
| `workflow-mcp/tests/planning.test.ts` | Plan/store integration over unique Git/SQLite fixtures and source/policy reads. | No server/build; fixture-local; ordinary integration. | 5.17s |
| `workflow-mcp/tests/protocol-contract.test.ts` | Deterministic registry/schema assertions and source reads. | No child/server/build; low sensitivity. | 0.08s |
| `workflow-mcp/tests/protocol-transport.test.ts` | Real Bun child/server lifecycle over STDIO, SDK transport cleanup, corrupt SQLite startup, diagnostics, and temp Git fixtures. | Genuine process integration, but no standalone build/dependency install. Each DB/repo/home is unique and children are awaited/killed. Moderate process-load sensitivity; correctly an ordinary protocol integration test. | 4.91s |
| `workflow-mcp/tests/protocol.test.ts` | Seven real Workflow MCP source-server sessions via SDK STDIO, with temp Git/SQLite state. | Server/process lifecycle in every test; no standalone build. Explicit close + fixture disposal; ordinary protocol integration. | 4.77s |
| `workflow-mcp/tests/runtime-supervisor.test.ts` | Primarily in-process routing/affinity/attestation logic, SQLite/WAL connections, temp Git fixtures, and injected/mocked child behavior. | Despite its name, it does not materialize, build, or launch historical runtime artifacts. Heavy real runtime scenarios are already in `tests/runtime/runtime-supervisor.test.ts`. Correctly core. | 2.66s |
| `workflow-mcp/tests/type-contract.test.ts` | Deterministic runtime-observable constant/type registry checks. | No FS lifecycle, child, build, or server. | 0.07s |
| `workflow-mcp/tests/workflow-action-registry.test.ts` | Deterministic in-process registry/adapter assertions. | No FS lifecycle, child, build, or server. | 0.07s |
| `workflow-mcp/tests/workflow.test.ts` | Extensive SQLite/store + temporary Git lifecycle, real Git commands, hooks, receipt and commit-verification matrices. | No runtime materialization/build/server. Unique repos and DBs; very expensive ordinary integration but no shared mutable resource. Dominant isolated core cost. | 38.18s |
| `agents/tests/change-receipt.test.ts` | Temp Git repositories, real Git, repeated real Bun CLI execution of `change-receipt.ts`, large blobs, symlinks, and one Unix-domain socket lifecycle. | No runtime build. Unique roots/socket; explicit close/removal; moderate process/FS sensitivity. | 2.69s |
| `agents/tests/contract-consistency.test.ts` | Mostly deterministic source/config/generator contract assertions; one temp Git repository validates commit paragraphs. | No real agent/runtime launch or build. Unique repo cleanup. Slow computation/text-contract file, not runtime-like. | 8.09s |
| `agents/tests/reviewer-validation.test.ts` | FS-heavy temp Git repositories, real Git fingerprints, many bounded Bun child commands, timeout/backpressure/mutation cases. | Real child-process execution but no runtime/server build. Every target is unique and cleaned; process-load sensitive in principle, no shared target. | 13.93s |
| `agents/tests/type-contract.test.ts` | Compile-time/type-shape runtime assertions only. | No FS, child, build, or server. | 0.02s |
| `installer/tests/inspect-git-range.test.ts` | Temp Git lifecycle, real Git subprocesses through the actual tool, dynamic copied tool import, hostile helper suppression, and a 100k-line patch fixture. | No installer or runtime build/server. Unique roots and cleanup; ordinary Git-tool integration. | 0.48s |
| `installer/tests/install-into.test.ts` | FS-heavy unique targets and temp Git lifecycle; 11 real `install-into.ts` child invocations. Four selected successful installs run standalone Workflow MCP compile + protocol smoke + verification; other invocations fail during preflight. | Mixed file. Real installer/build behavior occurs only in selected cases. Build roots and targets are unique; shared Bun compiler/cache is the only ambient resource. Whole file is cheap and mostly core preflight/config behavior. | 1.73s |
| `installer/tests/install-opencode.test.ts` | FS-heavy unique targets; 22 real installer invocations (mostly preflight failures), real `mv` children for rollback injection, and direct commit/rollback logic. The historical second-run test performs one successful first install and therefore one standalone compile/smoke before the second preflight refusal. | Mixed file; only that successful setup reaches runtime build. Unique targets/staging/build roots and `finally` cleanup. No observed concurrency sensitivity. | 1.67s |
| `installer/tests/self-host-opencode.test.ts` | Deterministic repository config/source/permission contract reads; imports tool definitions for metadata. | Does not execute installer, build runtime, or launch a server. Correctly core. | 0.08s |

The only standalone runtime builds left in top-level core are five successful installer setups across the two mixed installer files. That fact alone does not make the files runtime-like: the behavior is selected, isolated, currently cheap, and supports preflight/preservation/second-run semantics. Moving either entire file would misclassify many cheap unit/integration cases. A finer split would be technically possible, but current measurements provide no reason to do it.

## 4. Requested timings and variance

`real` wall-clock values from `/usr/bin/time -p`; three serial repetitions per requested command.

| Command | Runs | Result | Range / observation |
|---|---|---|---|
| `bun run check` | 0.28, 0.18, 0.18s | 3/3 pass | Mean 0.21s; 77 files, no fixes. |
| `bun run typecheck` | 0.60, 0.53, 0.53s | 3/3 pass | Mean 0.55s; stable. |
| `bun run test:core` | 43.45, 45.61, 45.91s | 3/3 pass | Mean 44.99s; range 2.46s; 360 tests/22 files each. |
| `bun run test:runtime` | 43.70, 43.91, 43.90s | 0/3 pass | Mean 43.84s; stable failure in one already-runtime test after 38 passes. Managed stderr: Bun tempdir `PermissionDenied`. |
| `bun run test:installer` | 1.99, 2.01, 1.89s | 3/3 pass | Mean 1.96s; range 0.12s; 46 tests/4 files. |
| `bun run validate` | 89.29, 89.75, 88.51s | 0/3 pass | Mean 89.18s. `check`, `typecheck`, and all core tests passed; same runtime-tier bootstrap test then failed. |

The failing runtime case was `bootstrap executes committed supervisor source despite dirty checkout launchers`. A read-only rerun outside the managed sandbox still failed in the same case at 44.24s, but exposed a user-global Bun cache/module interop error (`@kwsites/file-exists` calling a non-function `debug_1.default`) rather than `PermissionDenied`. This is an environment/global-cache anomaly in a test already assigned to the runtime tier. It is not evidence that a core file is misclassified, and repairing it is outside #138's core/installer investigation.

Dominant isolated core files were `workflow.test.ts` 38.18s, `lifecycle.test.ts` 18.69s, `reviewer-validation.test.ts` 13.93s, `contract-consistency.test.ts` 8.09s, `operator-decision.test.ts` 7.78s, and `git.test.ts` 5.75s. The installer files were 1.73s and 1.67s.

## 5. Historical failure reproduction matrix

Historical test: `install-into.ts refuses a second run without overwriting either host adapter`.

| Context | Repetitions | Timing | Result |
|---|---:|---:|---|
| Exact test only, `--parallel=1` | 3 | 0.46, 0.39, 0.37s | 3 pass; no symptom. |
| Whole `install-opencode.test.ts`, `--parallel=1` | 3 | 1.90, 1.81, 1.86s | 3 pass; 19/19 tests each; no symptom. |
| Current `test:installer`, `--parallel=4` | 3 | 1.99, 2.01, 1.89s | 3 pass; no symptom. |
| Current `test:core`, `--parallel=7` | 3 | 43.45, 45.61, 45.91s | 3 pass; no symptom. |

Thus the historical test passed 12/12 times across isolated, file, suite, and aggregate contexts. No run reported `Target is not a Git repository`, lost fixture state, cleanup race, or unusual Git output.

The observable production check is exact: `spawnSync(["git", "-C", target, "rev-parse", "--show-toplevel"], { cwd: target, stdout: "pipe", stderr: "pipe" })`; it returns true only for exit code 0 and non-empty trimmed stdout. Any nonzero result or empty stdout is collapsed to `false`; stderr/error details are discarded before `Target is not a Git repository` is printed. Therefore the historical message could have represented an underlying Git launch/resource/environment failure, but no current run produced a result to inspect. The current fixture initializes/configures its unique Git repository synchronously, and the first installer call occurs before cleanup or any test-controlled deletion.

## 6. Controlled concurrency comparison

| Same test set | Current parallelism | Reduced parallelism | Reliability result |
|---|---:|---:|---|
| 22 core files | `parallel=7`: 43.45-45.91s (3 runs) | `parallel=1`: 119.21s (1 bounded run) | All pass. Serial was 2.6x the parallel mean and gave no reliability improvement. |
| 4 installer files | `parallel=4`: 1.89-2.01s (3 runs) | `parallel=1`: 3.86-3.89s (3 runs) | All pass. Serial was about 2x slower and no less variable in a meaningful way. |

Current parallel execution materially improves wall time. There was no failure, stderr anomaly, Git misclassification, or reliability difference in the same-set comparisons. Broadly lowering core or installer parallelism is contradicted by these measurements.

## 7. Classification evaluation

No top-level file is demonstrated to be genuinely misplaced relative to #135's boundary.

Watch-list, not remediation candidates:

- `install-into.test.ts`: four selected tests perform real successful installation/build/smoke work; the rest are helper, preflight, refusal, and config behavior. It costs 1.73s isolated. Moving the whole file is inappropriate; extracting only those cases would add organization/duplication without meaningful measured benefit.
- `install-opencode.test.ts`: the historical case performs one successful install/build as setup, while nearly all real installer invocations stop at preflight and half the file directly tests rollback helpers. It costs 1.67s isolated. Again, only fine-grained extraction could preserve the taxonomy, and no current reliability/cost evidence supports it.
- `protocol.test.ts` and `protocol-transport.test.ts` launch real source servers, but they test the current protocol/transport directly, use unique repos/DBs, clean up children, perform no runtime materialization/dependency installation, and pass under current parallelism. They are ordinary integration tests.
- Top-level `runtime-supervisor.test.ts` looks suspicious by name but contains the lightweight/in-process/store half; the actual historical runtime/materialization/process scenarios are already under `tests/runtime/`.
- `workflow.test.ts`, `lifecycle.test.ts`, and `reviewer-validation.test.ts` are slow, but their cost comes from real Git/SQLite/process integration required by their contracts, not runtime-system behavior or shared targets. Moving them merely for speed would violate the issue's classification rule and would make `validate` slower if run in the bounded runtime tier.
- `self-host-opencode.test.ts` only inspects configuration/source and imported metadata; it neither launches nor builds the self-host runtime.

## 8. Ranked root-cause hypotheses for the historical installer symptom

1. **A transient nonzero/empty Git subprocess result was collapsed into the generic diagnostic.** Strongest code-level possibility: `isGitRepository()` intentionally discards stderr and the spawn error. This explains how a valid fixture could receive that message. Contradicting evidence: 12/12 current reproductions passed and there is no current underlying result to identify.
2. **Historical aggregate process/filesystem pressure caused a transient Git launch/read failure.** The historical observation occurred under aggregate execution, and core is process/Git intensive. Contradicting evidence: three current `parallel=7` core runs, three `parallel=4` installer runs, and all serial comparisons passed; current parallelism improves wall time rather than reliability degrading.
3. **A fixture cleanup/path race removed or altered `.git`.** Weak: every test uses a unique `mkdtemp` target; installer calls are synchronous; cleanup is in the same test's `finally` after both calls; no other test knows the path. Current isolated and aggregate passes contradict it.
4. **The fixture genuinely was never a Git repository.** Very weak: `git init` and configuration complete synchronously before the test calls the installer, and all current runs validate that sequence.
5. **Standalone runtime build/verification directly caused the first repository check to fail.** Mechanically unlikely within the same installer invocation because `isGitRepository()` runs before build/verification. Ambient pressure from other concurrent builds remains theoretically possible but was not observed, and the installer suite is only ~2s.

Separate current observation: the already-separated runtime bootstrap test consistently fails in this machine/session because of environment/global Bun temp/cache behavior. That supports retaining runtime isolation; it does not support moving more core tests or explain the historical installer Git result.

## 9. Final conclusion

### B. No implementation change is currently justified

Tested: every current core file was statically classified and run in an isolated cost pass; all requested commands received three repetitions; the historical test was exercised in four contexts for 12 total passes; and identical core/installer sets were compared at current and serial parallelism.

What no longer reproduces: the historical `Target is not a Git repository` installer failure did not occur once. The exact test, whole file, installer suite, and aggregate core all passed. No fixture-loss or concurrency interaction was observed.

Current timing/variance: core is stable at 43.45-45.91s and installer at 1.89-2.01s. Serializing the same sets makes them substantially slower (119.21s core; 3.86-3.89s installer) without changing reliability. Core's dominant cost is ordinary Git/SQLite/process integration, not the selected installer runtime builds.

Runtime-like behavior that remains in core: five selected successful installer setups compile and smoke the standalone Workflow MCP. They are isolated, collectively small, embedded in otherwise core-focused mixed files, and stable under current concurrency. Real runtime/dogfood/materialization ownership already resides in the five-file `test:runtime` tier. Process-launching protocol and reviewer tests are ordinary integration tests with fixture-local resources.

Why change would be speculative: there is no reproduced installer defect, no current parallel-only failure, no shared fixture collision, no dominant installer cost, and no whole file whose actual behavior warrants reclassification. Splitting five setup cases, reducing parallelism, or changing diagnostics solely for an unreproduced historical event would not address a demonstrated current #138 problem. The separate runtime bootstrap environment failure should be tracked at its owning runtime/cache boundary if it reproduces in a normal supported environment; it is not a reason to alter core layout or concurrency in this issue.
