# Architecture reassessment — investigation report

## 1. Current architecture in one page

The clean checkout is `main` at `672ab29ade32c29ff08838a39df32ec8ffe3e15d`; it tracks `origin/main`. This investigation uses that checkout as the source of truth. I read the workflow architecture and role contracts, current source and tests, `workflow-state-report.md`, relevant local commits, and the named GitHub issues. I did not run test suites.

The system has a separate persisted PlanArtifact approval path and an execution Workflow MCP. OpenCode’s built-in Plan mediates planning; the primary Orchestrator creates or resumes an approved workflow, reads `workflow_operator_decision_get`, follows its version 5 executable descriptor, and delegates to Implementer, Reviewer, or Committer. Workers read role-specific views and submit versioned results. SQLite state, Git receipts, runtime identity, optimistic versions, and an append-only audit record are the durable authority.

Current inventory from source:

| Surface | Current size |
|---|---:|
| Workflow phases | 16 |
| Registered workflow actions | 29 |
| Workflow MCP tools | 31: 29 actions, `workflow_create_from_plan`, operator decision getter |
| Other Plan tools | 5 |
| Operator decision kinds | 11 |
| Descriptor modes | 5: dispatch, parent mutation, collect evidence, wait, terminal; repair authorization specializes parent mutation |
| Recovery action labels | 9 |
| Persisted `WorkflowState` fields | 53 |
| Role-specific views | Parent, Implementer, Reviewer, Committer, plus Implementer handoff and review-only Reviewer shape |
| Transition domains | Implementation, review, commit, linked follow-up, with shared, receipt, query, and state modules |

The Orchestrator contract is 547 lines; the Implementer, Reviewer, and Committer contracts are 136, 206, and 166 lines. Workflow MCP production TypeScript is 17,782 lines, including Git, persistence, runtime, and planning machinery. Nine directly relevant protocol/lifecycle test files alone total 10,697 lines. Those counts describe surface area, not an achievable deletion total.

The happy path is: approved plan or authorized direct scope → implementer receipt → fresh independent reviewer and exact validation results → fresh operator decision → separate user commit authorization → staged receipt check → external Git commit → server verification of HEAD/tree/paths.

## 2. What is working and worth keeping

The core safeguards have evidence of value: exact path scope; immutable approved plan and intent; worker role separation; independent review; exact argv validation policy; fresh Git receipts; explicit commit consent; version and runtime checks; verified commit result; and fail-closed behavior. In #190, the Implementer’s refusal to edit an out-of-scope baseline file was correct. The reviewer’s truthful validation failure was also correct.

The actionable finding projection added by #184 worked in #190 and is worth retaining in smaller form: the parent needs enough authoritative finding detail to explain a failed review. It need not retain repair selection, adjudication, or lineage fields if those lifecycles disappear. #183’s exact prior-ID projection is already present at this HEAD despite the issue remaining open.

## 3. Where complexity is hurting us

The recent #190 sequence is a **composition failure**. A five-path `review_only` review ran repository-wide validation; `bun run check` found a committed formatting defect in a sixth path. The reviewer submitted `CHANGES_REQUESTED`. The operator projection offered repair authorization; the user authorized it; the server moved to `REPAIRING`; the Implementer correctly refused the out-of-scope edit. `repairProposalForFindings()` currently returns empty `required_paths` and `forbidden_paths`, and `authorizeRepair()` checks proposal equality and approved-path constraints without proving that the remediation is possible inside scope. `review_only` cannot expand scope. A later resume context cannot add authority. The route was legal locally but impossible end to end.

The stranded original #190 workflow shows a second cost. Its implementation survived a stash/restore and advancing `main`, but its review authority did not. Fresh `review_only` reconciliation recovered the useful tree, at the price of abandoning the old workflow. That is evidence for making **new run over current tree** a normal operation, with explicit approval and receipts.

Other boundaries add cumulative cost. #178 found acceptance work assigned to the wrong actor and time; #180 required another narrowly granted read-only Reviewer Git command. #124 added semantic postcondition reconciliation for ambiguous parent writes. #182 found that the Orchestrator distrusted an intentional ellipsis in an exact server repair binding. #183 required a new exact prior-finding ID view for re-review. Each correction is sensible inside the present lifecycle; together they indicate a large model-facing contract.

Validation is a separate operational burden. #135 split core/runtime ownership after duplicated heavy gates. #192 replaced aggregate reviewer `validate` with `check`, `typecheck`, `test:core`, and `test:runtime`, which is a better evidence boundary. That change left two stale authorization expectations in Workflow MCP tests, fixed by `9152861`, and a Biome defect, fixed by `67f4f59`. Before those fixes, the defect blocked the unrelated #190 review and exposed the impossible repair route. #191 and open #193 concern worker processes: the recent CPU-bound workers were directly parented and intermittent; later runs through several host paths did not reproduce them. The cause is unresolved and should not be attributed to Workflow MCP.

`reviewer-validation.ts` still earns its exact-argv, shell-free, bounded-output, timeout, and structured-result functions. Its 1,274 lines also fingerprint Git and working-tree state before and after execution. Command policy and target-integrity verification are distinct responsibilities. A smaller workflow would still need both guarantees, but their coupling in one runner deserves a separate design review; removing the workflow repair loop would not remove Bun worker or timeout problems.

## 4. What #140 got right and wrong in hindsight

#140 correctly identified prompt-side reconstruction of tool names, payloads, and post-mutation routes as unsafe. The executable descriptor work addressed that problem, and its dogfood matrix showed real gains. It also correctly retained authoritative server reads and fail-closed worker guards.

The recommendation was **incomplete at the system level**. It made a 16-phase lifecycle more precise without asking enough whether all those lifecycle branches should exist. Current version 5 descriptors, nine recovery labels, fresh-binding rules, ambiguity reconciliation, and the 547-line Orchestrator contract show that complexity moved into precise projection and interpretation. #182 and #190 are particularly strong counterexamples to “better descriptors are enough.” This does not make #140 wrong at its protocol boundary; it means that protocol improvement did not sufficiently reduce total lifecycle complexity.

## 5. Minimal viable workflow architecture

The original **B proposal** is a radically simplified Workflow MCP. It keeps PlanArtifact approval and durable authoritative state and uses a terminal-failure execution lifecycle. Section 14 tests that proposal against an OpenCode-only successor designed independently of this lifecycle:

```text
APPROVED_INTENT
      │ create run
      ▼
IMPLEMENTING ── done ──► REVIEWING ── pass ──► AWAITING_COMMIT_AUTH
      │                     │ fail/unavailable         │ user authorizes
      │                     ▼                          ▼
      └── blocked ───────► FAILED                COMMIT_PENDING
                              ▲                          │
                              └── preparation fails ─────┤
                                                         ├── verified ──► COMMITTED
                                                         └── ambiguous ─► COMMIT_UNKNOWN
```

`review_only` starts at `REVIEWING`. A new run is required after a failed review, scope change, changed intent, stale HEAD, or unavailable review. The new run binds the current HEAD/tree, exact paths, approved intent, and validation policy. Existing changes may be reviewed through a new `review_only` run; this is an explicit reconciliation path, never silent inheritance of old approval.

Persist only: run/schema/runtime identity and version; immutable approved plan or direct intent reference; exact scope and baseline; review target and receipt; bounded implementation and validation results; current review result with actionable findings; commit authorization; prepared attempt and verified outcome; timestamps/audit. A parent or worker can reconnect by run ID and reread authority after an ordinary process restart. An incompatible runtime reload fails closed and requires a new approved run over current reality. No repair cycle, scope expansion, linked/combined review, finding classification history, manual validation retention, or general resume context.

Commit needs a small **special case**. An external Git write can succeed before the response arrives. A failed preparation terminates. An ambiguous result must become `COMMIT_UNKNOWN` until read-only HEAD/tree/path verification establishes the outcome; blindly starting another commit run could duplicate or misattribute the commit. This narrow reconciliation is safety, unlike general repair recovery.

## 6. Current → simplified mapping

| Current case | Current path | Simplified path |
|---|---|---|
| Ordinary reviewer defect | `REPAIR_REQUIRED` → authorize → `REPAIRING` → re-review | `FAILED`, findings returned; fresh approved change run |
| Out-of-scope baseline defect | Repair may be advertised; scope cannot expand in `review_only` | `FAILED_BASELINE` reason; separate baseline fix or explicit new scope |
| Implementer needs another path | Stop, authorize scope expansion, resume | `FAILED_SCOPE`; approve new plan/scope and run |
| HEAD changes while paused | Current freshness/recovery gates may stop or allow bounded routes | Mark stale/failed; new run binds new HEAD |
| Validation fails | Blocker and possible repair | Terminal failed result with exact evidence |
| Validation unavailable | Inconclusive/manual recovery possibilities | Terminal inconclusive; new review run when available |
| Commit preparation fails | Multiple stopped states and retry/review/reconcile choices | Terminal failed; fix index outside run, then new review and commit consent |
| Commit result ambiguous | Existing reconcile/result variants | `COMMIT_UNKNOWN`; read-only verification only; escalate if proof impossible |
| OpenCode session dies | Reconnect to durable state and continue where legal | Reread run and continue at its one current step |
| Workflow runtime reloads | Immutable owner/reload boundary | Compatible owner resumes; incompatible authority stops and new approved run |
| User changes intent | New plan or linked/rebind/continuation routes depending on state | Terminate old run; new approval and run |

Termination removes transitions only if the *new-run protocol* is simple. It must define how an already changed tree receives fresh scope, consent, validation, and review. Otherwise repair and scope expansion merely reappear under new names.

## 7. What code/state/actions could disappear

Likely deletion candidates are `repair-proposal.ts`, `transitions/linked-followup.ts`, repair/adjudication/re-review parts of `transitions/review.ts`, scope expansion/adoption and plan rebind in `transitions/implementation.ts`, manual validation retention logic, lineage projection, and many specialized descriptor branches. `types.ts`, `state-validation.ts`, `store.ts`, `queries.ts`, `operator-decision.ts`, `operator-action-descriptor.ts`, the action registry, server schemas, role contracts, and protocol tests would shrink substantially rather than disappear. Runtime supervision, Git receipt logic, PlanArtifact storage, basic role views, exact validation policy, and commit verification should remain.

Candidate removals include `workflow_authorize_repair`, adjudication, resume/finalize repair, linked follow-up creation, scope expansion/adoption/reconciliation, manual-validation recording, plan rebind, concern acceptance, resume implementation/review, retry preparation/commit, and return-to-review. Some commit reconciliation action remains. Most associated repair, lineage, retention, and recovery fields among the 53 could go. Current schema is latest-version-only for resettable internal state, so a new run store can use a new schema without preserving old execution compatibility; existing active runs require an explicit retirement plan.

This is plausibly a **meaningful chunk of control-plane code and tests**, perhaps on the order of a quarter to two-fifths of the workflow-specific surface after a real design, not a measured LOC promise. Git integrity, runtime ownership, plan approval, validation execution, and commit verification remain sizeable.

## 8. Safety properties preserved and lost

The smaller MCP must still enforce approved paths and intent, role permissions, version checks, review independence, exact validation evidence, receipt freshness, explicit commit consent, and Git result verification. Failed validation must be visible and must block commit. A new run must not silently treat prior findings or consent as current.

Deleting repair cycles loses convenient in-place remediation and historical finding classification, not a safety guarantee if every new run gets independent review. Deleting scope expansion loses continuity; it is safe only if new scope gets fresh explicit approval. Deleting general recovery loses convenience and may strand usable work; fresh reconciliation can preserve that work without inheriting stale authority. Deleting commit reconciliation would lose safety and is **not** recommended. Deleting all durable state would risk stale authorization and model guesses unless an alternative immutable, authenticated run record is designed and verified.

## 9. Impact on open issues

- **#182:** disappears with the repair proposal/authorization lifecycle. Its exact-value lesson still applies to any remaining descriptor binding.
- **#183:** the current checkout already implements `required_prior_finding_ids` (`c4bee1e` and current role view), though the issue is still open. A linear new-run design removes the re-review requirement; audit the issue status separately without changing it here.
- **#193:** remains an independent validation infrastructure investigation. Simplifying Workflow MCP may reduce test load but cannot be credited with fixing the worker stall.
- **#189:** repair-binding deduplication becomes obsolete if repair disappears.
- **#26** recovery runbook, **#24** checkpoint commits with unresolved findings, and **#22** durable child workflows conflict with the proposed narrow lifecycle and should be parked or re-scoped. **#21, #18, #46, #78** (managed worktrees, parallel lanes, isolation, multi-instance use) should be deferred until a smaller single-run model proves useful. **#40** observability could remain read-only but should not drive more control-plane state. Other open issues such as plugin updates or explorer retrieval are largely orthogonal.

## 10. Migration strategy if we simplify

Specify the new invariants and commit ambiguity protocol first. Build a separate latest-version run model and concise host contracts. Keep old immutable runtimes available solely to finish already owned runs under their loaded contract, or formally retire those runs with a user-visible reconciliation route; never have the new consumer reinterpret old state. Prove exact scope, approval, reviewer independence, baseline-failure classification, validation visibility, stale-head rejection, and commit verification with a small representative test set and real dogfood. Then remove the old branches and tests as a single coherent migration. Avoid spending another cycle polishing repair descriptors before deciding the lifecycle.

## 11. Case for freezing instead

Freeze/archive is rational if the main value is learning about agent control planes and actual use continues to expose more host/runtime/test complexity than workflow benefit. A smaller design still needs Plan approval, Git receipts, validation, role isolation, and a commit side-effect protocol. If those retained pieces remain too costly in real use, stop rather than rebuild a second large system. Preserve the current code and findings as an experiment, with no new feature issues.

## 12. Recommendation

| Option | Correctness and safety | Model protocol, failure cost, maintenance | Migration and retained value |
|---|---|---|---|
| **A. Continue current** | Mature checks cover many branches; #190 reveals cross-branch feasibility gaps | Highest state, descriptor, contract, and regression burden; dogfood remains hard to reason about | Cheapest immediate choice; preserves all current capabilities |
| **B. Simplify Workflow MCP** | Can retain exact approval, review, validation, receipts, and verified commit | Terminal failures remove repair, lineage, and most recovery branches; new-run reconciliation must stay narrow | Moderate migration; keeps the valuable authority and Git infrastructure |
| **C. Thin orchestration** | Credible only with an immutable authenticated run record, freshness/version checks, and commit verification | Could shrink MCP further, but those guarantees may recreate a state machine elsewhere | Larger redesign and greater risk of model-inferred authority |
| **D. Freeze/archive** | Preserves existing experiment without making new safety claims | Ends operational and maintenance cost; gives up product improvement | No migration; current code remains a research record |
| **E. Freeze and build OpenCode-only successor** | Can retain the core guarantees with a small transactional kernel, subject to new host-boundary proof | Refuses recovery and portability from inception; risks recreating old machinery in plugin records | Preserves this repository as evidence; independent design may avoid its structural inheritance |

The original recommendation was **B for a bounded decision gate**, with **D as fallback**. The Option E investigation below changes this to a conditional preference for a separate OpenCode-only successor. A thinner architecture **C** still needs credible immutable, versioned, restart-safe authority and commit verification; the current Workflow MCP provides those, but need not be the only possible implementation. Continuing **A** preserves current capabilities while retaining the demonstrated composition burden. The #190 repair failure is strong enough to justify changing the lifecycle rather than only patching its next precondition.

## 13. Concrete go/no-go criteria

**Go on B** only if a design/prototype shows: no in-run repair, scope mutation, linked review, or general resume; explicit approval of each new run’s intent and paths; independent Reviewer validation with truthful baseline-failure reporting; safe review of an existing changed tree; ordinary restart by authoritative reread; exact commit consent and receipt check; read-only resolution of ambiguous commit outcomes; materially shorter Orchestrator/worker contracts; and a substantial, demonstrated reduction in workflow-specific state/actions/tests. Dogfood the #190 baseline case, ordinary defect, scope change, stale HEAD, session death, and ambiguous commit. Section 14 adds the direct B-versus-E decision gate.

**No-go / freeze** if the new-run mechanism needs its own lineage, repair history, scope mutation, or recovery-context protocol; if commit safety or review independence weakens; or if real dogfood still requires frequent source archaeology and manual rescue. The decision should use observed maintenance and successful ordinary workflows, not sunk cost or a passing synthetic suite.

## 14. Option E — freeze this repository and build an OpenCode-only successor

### Blank-sheet derivation

Start from the seven guarantees, not from phases or actions. A human approves one exact intent and repository scope. An isolated worker changes files. A different worker inspects the full resulting target and owns validation. A human separately authorizes one exact reviewed commit. A trusted component verifies the external Git effect. Each handoff needs a durable, bounded authority reference, because a session transcript and a model's recollection cannot prove what was approved. This implies **records and gates**, but does not imply the current mutable `WorkflowState`, 16 phases, action registry, or general transition framework.

A candidate successor would be an OpenCode plugin plus a small local transactional record store and Git verifier. Its complete durable concepts are:

1. **Intent certificate:** immutable canonical repository root, exact paths, objective or approved plan text/digest, validation policy identity, baseline HEAD and relevant worktree/index snapshot, user approval bound to the certificate digest, and creation timestamp. A material revision creates a new certificate. No current-schema PlanArtifact revision graph is presumed.
2. **Run record:** opaque ID, intent certificate digest, bound OpenCode session/worktree identity as routing context, implementation receipt or `review_only` target, and a monotonically advanced record head. There is at most one active run per repository/worktree in the first version; no concurrency/child topology is promised.
3. **Review record:** independent reviewer identity, full exact target receipt, command policy and bounded actual validation evidence, pass/fail/inconclusive outcome, and actionable findings. A failed or unavailable result closes the run. Validation failure outside scope is recorded as a baseline blocker; it is never converted into repair authority.
4. **Commit consent and attempt:** fresh user consent bound to one passing review digest and exact commit paths, a prepared Git index/tree/HEAD receipt, an attempt ID, and verified terminal outcome. A possibly completed external commit remains `unknown` until read-only reconciliation proves its result or human intervention resolves it.
5. **Audit linkage:** append-only references from each record to its predecessor inside the *same run*. There is no cross-run repair lineage, inherited approval, inherited validation, or historical finding classification.

These records can be append-only with a small atomic latest-record pointer or database transaction. That is still a monotonic protocol: implementation cannot follow a failed review, commit consent cannot precede a passing review, and competing submissions cannot both win. Calling it “receipts” does not remove the need for atomic ordering, version checks, and trusted gate code. The installed `@opencode/plugin` API exposes `storage.get/set/remove/scan` but no compare-and-swap contract in its TypeScript interface; an implementation must prove single-writer behavior or use its own local transaction boundary. OpenCode session state remains useful context, not durable authorization.

The gate code should expose a few semantic operations, such as create approved run, submit scoped implementation, submit independent review, authorize exact reviewed commit, prepare commit, and verify/reconcile outcome. These are examples of authority boundaries, **not** a proposal to port today's tool list under new names. The plugin should derive the current allowed operation from the record chain and reject mismatched actor, session/worktree, approval digest, expected record head, HEAD, index, or target receipt. No model needs to supply hidden IDs, finding classifications, or descriptor payload paths; it receives an opaque run reference and narrowly scoped tool inputs. The user-facing agent explains results from bounded authoritative records.

### Challenge to inherited abstractions

| Current abstraction | Blank-sheet E verdict |
|---|---|
| Workflow MCP as the primary boundary | Not intrinsically necessary. A directly registered OpenCode plugin tool can call a small local authority kernel. MCP remains an option only if its process isolation or transport solves a demonstrated need; removing MCP must not move validation into prompts. |
| PlanArtifact v3 | Exact immutable approved intent is necessary; the current full revision, parent/worker read, provenance, approval, and creation workflow is not. A single displayed candidate certificate and a new certificate for every material revision may suffice. |
| Executable next-action descriptor | A complex public descriptor is unnecessary with a handful of gates. The kernel still returns a bounded current status and the one allowed next operation, or a terminal reason. |
| Role-specific workflow projections | Least-authority information still matters. OpenCode agent permissions plus role-gated plugin tools can provide small role inputs, but plugin-side actor checks and redaction must be proven; host permissions alone are not a data-security proof. |
| Action registry and transition modules | No generic registry is justified for a linear run. Explicit gate functions and an exhaustively checked record progression are enough if the protocol stays small. |
| Runtime ownership and historical recovery | The current immutable self-hosting supervisor is not an installed-target necessity. Pin a successor release for active runs or terminate on incompatible reload; ordinary process restart may reread current records. This is a deliberate loss of historical-run continuity. |
| Host-neutral generator and installer | OpenCode-only agent definitions and plugin registration can remove Codex TOML generation, dual-host policy translation, and cross-host consistency testing. Target configuration installation still needs an ownership/merge policy if distribution remains a goal. |

The checkout provides evidence for the proposed OpenCode integration seam: `opencode.json` already configures native V2 agents, ordered permissions, Plan mediation, and subagent depth; `.opencode/plugins/codex-agents-explorer-tools/index.ts` registers direct plugin tools and checks `toolContext.agent` and `sessionID`; the pinned `@opencode/plugin` types expose tool registration/hooks, permission evaluation, session access, command registration, and storage. Those are **candidate primitives**, not proven substitutes for exact approval or Git authority. In particular, the native permission reply type allows `once`, `always`, and `reject`; a generic “tool allowed” answer does not by itself prove approval of the exact displayed intent or review digest. E needs a trusted, single-use user action bound to a digest and verified end to end. A native permission request or command could provide that only if current OpenCode behavior proves the binding and caller provenance. Prompt text or model-supplied `user_authorization` is insufficient as the sole mechanical proof.

### What necessarily survives, and what refusal buys

Exact path normalization, symlink/rename and dirty-index handling, baseline HEAD and content freshness, independent reviewer identity, exact argv validation and non-mutating execution checks, full final-tree review, separate commit consent, pre-commit staged-tree verification, and post-commit HEAD/tree/path verification survive any rewrite. A timeout or lost response during `git commit` requires an attempt record and read-only reconciliation. OpenCode role permissions are defense in depth; a model can still propose incorrect calls, so the trusted kernel rejects them. These are inherent costs of the desired guarantees.

What E saves comes from explicit refusals: no repair proposal/directive, cycle limit, re-review classifications, finding adjudication/history, scope expansion, combined review, linked follow-up, retained inspection evidence, revised-plan rebind, generic stop/recovery context, historical runtime routing, or old-state compatibility. A failed review, validation failure/unavailability, changed HEAD, changed scope/intent, or most worker failures closes the run. A process restart can reread an unambiguous current record; an ambiguous record or incompatible runtime stops. This distinction preserves cheap restart without promising general recovery.

“Start a new run” is simple **only if it is self-contained**. For already modified files, the user approves a fresh target describing the full current tree/diff against a trusted current HEAD, not merely the last repair delta. The reviewer validates that whole target; the commit gate binds only that new review. An older failed run supplies context to the human, never authority to the new run. If the current tree cannot be unambiguously bounded, refuse creation and ask for explicit cleanup or a clearer target. This loses convenience and may require re-reviewing unchanged work. If the successor starts importing prior findings, receipts, or authorization to avoid that cost, it has recreated lineage and should fail its simplicity test. A changed HEAD similarly requires fresh inspection and consent, without claiming that a prior run remains valid.

### Direct B versus E comparison

| Criterion | B: simplify current Workflow MCP | E: freeze and design OpenCode-only successor |
|---|---|---|
| Conceptual complexity | Linear lifecycle, but existing Plan/MCP/runtime/module boundaries invite retained structure | Records-and-gates design can be smaller; the safety kernel remains nontrivial |
| Model-facing protocol | Fewer descriptors/actions, with existing conventions and role views | Few purpose-built tools and small status views; exact approval UI/transport is an unresolved proof obligation |
| Durable state | Reduced mutable `WorkflowState`, likely existing SQLite/audit/receipt model | Immutable certificates/receipts plus atomic record head and commit attempt; no inherited lifecycle state |
| Failure semantics | Terminal failure can be added to existing transitions | Terminal failure is the default from the start; ambiguous commit is a narrow exception |
| Recoverability | Existing machinery may be hard to delete completely | Explicitly refuses historical recovery; ordinary restart by reread only |
| Safety guarantees | Reuses proven Git, version, review, and commit checks | Must re-establish them independently; risk of a subtle regression is higher |
| OpenCode reliance | OpenCode orchestration still rides portable MCP and dual-host adapters | Direct dependency on OpenCode V2 plugin, permission, session, and tool behavior |
| Composed reasoning | Improves if old branches are actually removed | Potentially clearest if each record gate is small and no hidden host state grants authority |
| Recreating current architecture | Existing abstractions encourage partial retention | New records/gates can grow into the same machine if convenience features return |
| Maintenance and dogfood | Less rewrite risk; old cross-host/runtime test burden may persist | Smaller target is plausible; host-version compatibility and new authority integration are ongoing costs |

If independent E design and dogfood converge on approximately the same narrow transactional kernel as B, with the same meaningful state and tests, that favors **B**: proven receipt/Git logic then outweighs the benefits of rewriting it. If E demonstrates a materially smaller model-facing and durable protocol while preserving the hard guarantees, repeatedly refactoring current MCP structure is unlikely to be the best use of engineering time. This comparison turns on verified conceptual surface and ordinary dogfood, not on a speculative LOC or migration estimate.

### Falsification, risks, and revised decision

The strongest case **against E** is that it can rediscover solved safety problems: stale approvals, ambiguous parent writes, out-of-scope edits, dirty-index contamination, review-target drift, and lost commit responses. A second risk is relying on OpenCode permission/session behavior that does not bind exact user intent; a third is rebuilding a state machine inside plugin tools and append-only records. Excessive host coupling can make a small successor fragile across OpenCode versions. Remembered edge cases can also induce an oversized first design. The successor should carry forward invariant-focused examples and adversarial cases from this repository, while refusing feature parity and source-level porting.

Classify the lessons as follows:

- **Required invariants:** exact approved intent/scope and worktree root; fresh HEAD/target receipts; independent read-only review and truthful validation; role and authority separation; no inherited approval; explicit consent to the reviewed commit; safe Git side-effect reconciliation.
- **Useful techniques:** canonical digests, exact-path normalization, bounded output/evidence, shell-free exact argv policy, optimistic record-head checks, append-only audit records, server/plugin-side Git verification, and one opaque reference per worker handoff. Reuse ideas or small proven algorithms after review, not the existing lifecycle as a template.
- **Explicit anti-requirements:** in-run repair, scope mutation, finding adjudication, combined/linked review, inherited validation/authorization, general recovery, old workflow compatibility, and dual-host portability in the successor's first version.

**Revised recommendation:** prefer **E as a bounded blank-sheet design and proof-of-boundaries effort**, while keeping B as the fallback if the independent design converges on the same kernel. This is a recommendation to investigate and prove E, not to declare the rewrite safe or begin implementation under this report. Freeze `codex-agents` only when that decision is made; the current repository remains the evidence baseline. E would create no old-workflow-state migration or backward-compatibility path. Option D remains rational if even the minimal kernel's operational cost is not justified by real coding-agent use.

**Go on E** only if a written design and focused host proof demonstrate: trusted single-use approval tied to the exact displayed intent/review digest; plugin-side role and session/worktree checks; atomic per-run progression; full-target new-run review with no cross-run authority; exact validation execution and mutation detection; stale HEAD/index rejection; and commit preparation, verification, and unknown-outcome reconciliation. The first dogfood matrix must include the #190 out-of-scope baseline failure, ordinary defect, already modified tree, changed HEAD, session/reload interruption, staged ambient file, and ambiguous commit result. Compare actual gate/tool/record concepts and user-visible recovery steps with B after these proofs.

**Reject E in favor of B** if approval binding or atomic persistence requires an MCP-sized service, if host tools cannot reliably isolate roles, if the new-run path needs lineage/inherited authority, or if the independently derived kernel is materially the same as simplified MCP. **Freeze without a successor** if neither design materially improves successful ordinary workflows relative to its upkeep. Do not use estimated LOC savings or sunk cost as the deciding evidence.

## Evidence anchors

Current source: `.codex/workflow-mcp/{values,types,workflow-action-registry,operator-action-descriptor,operator-decision,repair-proposal,server,store,state-validation}.ts`, `.codex/workflow-mcp/transitions/*.ts`, `.codex/agents/reviewer-validation.ts`, `.codex/agents/contracts/{implementer,code_reviewer,committer}.md`, `.opencode/agents/orchestrator.md`, `.codex/reviewer-validation.json`, and `package.json`. Test surface: `.codex/workflow-mcp/tests/{lifecycle,lifecycle-domain,operator-decision,workflow-lifecycle-repair,workflow-staged-recovery,workflow-commit-result,workflow-action-registry,protocol-contract,type-contract}.test.ts`. Architectural and dogfood records: `.codex/workflow-mcp/ARCHITECTURE.md`, `.codex/agents/WORKFLOW.md`, `workflow-state-report.md`, `docs/test-investigation.md`, `docs/bun-worker-lifecycle-investigation.md`, and `docs/opencode-orchestration-flow.md`. Option E host evidence: `opencode.json`, `.opencode/plugins/codex-agents-explorer-tools/index.ts`, `.opencode/package.json`, and pinned local `node_modules/@opencode/plugin/dist/promise/{plugin,tool,permission,session,storage,command}.d.ts`. These TypeScript surfaces establish available interface shapes, not end-to-end safety behavior. Issue history: [#140](https://github.com/mikechao/codex-agents/issues/140), [#182](https://github.com/mikechao/codex-agents/issues/182), [#183](https://github.com/mikechao/codex-agents/issues/183), [#184](https://github.com/mikechao/codex-agents/issues/184), [#124](https://github.com/mikechao/codex-agents/issues/124), [#178](https://github.com/mikechao/codex-agents/issues/178), [#180](https://github.com/mikechao/codex-agents/issues/180), [#135](https://github.com/mikechao/codex-agents/issues/135), [#191](https://github.com/mikechao/codex-agents/issues/191), [#192](https://github.com/mikechao/codex-agents/issues/192), and [#193](https://github.com/mikechao/codex-agents/issues/193). The exact last #190 repair sequence and later non-reproduction across host paths were supplied in the reassessment prompt; source and local history corroborate the relevant mechanics and commits but this investigation did not replay those runs.
