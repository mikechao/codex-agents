# Coding Authority Protocol: bounded OpenCode-only architecture exploration

## Decision and evidence boundary

**Conclusion: E remains materially smaller and warrants a bounded prototype/proof.** That is a claim about the *proposed protocol surface*, not proof that the pinned OpenCode host already supplies every required authority primitive. Exact human approval binding and atomic progression are open gates. If either needs an MCP-sized service or the resulting kernel converges on simplified Workflow MCP, prefer B. No implementation, migration, test suite, issue mutation, or commit was performed for this report.

At investigation time, `main` was clean apart from the existing untracked `docs/eval-investgation.md`, at `672ab29ade32c29ff08838a39df32ec8ffe3e15d`. The checkout pins `@opencode/plugin` to `2.0.11`; its installed TypeScript declarations, current `opencode.json`, plugin example, role contracts, Git and validation code, and workflow tests are the primary evidence. The local `opencode --version` command could not open its log under this sandbox, so this report makes no claim about the runnable CLI version. The installed package declaration and the repository's documented v2.0.11 integration establish the API baseline. OpenCode host behavior that matters to safety still needs a focused live proof.

The current repository supplies three kinds of evidence. Its receipts, version checks, independent review, and commit verification are an **invariant corpus**. The #190 impossible repair, #124 ambiguous parent mutation, #178 acceptance timing, #182 bounded repair binding, #183 prior finding IDs, #135/#192 validation topology, and #191/#193 worker failures are a **failure corpus**. Its exact path, Git, validation, and digest code is a **technique library**, not a successor structure or automatic source migration.

## 1. Derive the authority boundary from guarantees

The smallest credible trusted component must answer six questions: *What exact change was approved? What repository state did that approval cover? Which actor supplied the implementation and independent review? Did required validation actually run against the reviewed target? Which exact passing target did the user authorize for commit? What did Git actually do?* Conversation and worker summaries cannot answer these durably.

The candidate is one OpenCode plugin that exposes a few direct, role-gated tools backed by a small local transaction store and a Git/validation kernel. OpenCode agents supply planning, implementation, semantic review, and commit-message judgment. The kernel owns authority checks and receipts. It returns the current admissible operation or terminal reason; it does not publish a general executable next-action descriptor, action registry, repair route, or recovery menu. It has one active run per canonical worktree in its first version and no child/parallel topology.

One possible record chain is:

```text
candidate intent --trusted user approval--> approved intent
      --implementer result or review-only capture--> implementation/target receipt
      --independent reviewer + validation--> review result
      --trusted user commit consent--> commit consent
      --staged-tree check--> prepared attempt
      --external Git operation + observation--> verified commit | known no-commit | unknown

Any ordinary defect, unavailable evidence, stale baseline, or unsupported change -> terminal failed run.
```

This is **not stateless**. The chain has ordering and a current head. A losing concurrent write must be rejected, each record must bind to its predecessor, and a restart must read the same authoritative head. Status is derivable from the latest valid record, so a large mutable phase enum is unnecessary. A tiny set of terminal outcomes and a special `commit_unknown` outcome remain unavoidable.

### Challenge each proposed durable concept

| Proposed concept | Minimum justification | Could it be collapsed? |
|---|---|---|
| `IntentCertificate` | Exact immutable text/scope/policy/baseline digest and evidence of separate human approval | Drafts may be ephemeral. Approval must create an immutable record; a revised intent creates another certificate, never mutates it. |
| `RunRecord` | Groups one execution with one approved certificate, canonical worktree, and current record head | A tiny index/head pointer plus append-only records may replace a mutable state object. A run ID is still needed for handoffs and restart. |
| `ImplementationReceipt` | Proves the worker's final tree and path set against the approved baseline | Can be an event payload in the run chain. Worker prose is optional; the kernel recomputes the receipt. |
| `ReviewRecord` | Proves a distinct reviewer inspected the *full final target* and owns actual validation evidence | Pass/fail, findings, receipt, actor/session, and validation results can form one immutable record. No finding history is needed. |
| `CommitConsent` | Separately binds human authorization to the passing review digest and exact changed paths | Cannot be inferred from plan approval or generic tool permission. Keep as a distinct immutable fact. |
| `CommitAttempt` and result | External Git can succeed while the caller loses the response | A prepared attempt must be durable *before* Git executes; verified/no-commit/unknown is appended afterward. Unknown requires read-only reconciliation. |

The minimum semantic gates are: capture candidate; approve exact candidate; open run; accept scoped implementation or capture existing full target; accept independent review and required validation; authorize exact passing review for commit; prepare exact staged tree; execute/verify one commit attempt; read-only reconcile an ambiguous attempt. These gates are *sequential checks*, not generalized transitions. If implementation needs a catalog of alternate legal actions, repair selection, or historical branch reconciliation, it has crossed the intended boundary.

## 2. Exact user authorization is the leading unresolved gate

The trust requirement is a **human action bound to a kernel-produced digest of the displayed candidate**, followed later by a fresh action bound to the passing review digest, target paths, HEAD/tree, and commit summary. The kernel must persist the exact digest and one-use approval evidence before any worker or Git action. A model-supplied `user_authorization` string is a claim, not independent proof. The current PlanArtifact store proves revision/digest consistency but its approval tool also accepts a supplied authorization string; a successor should not simply rename that field.

Candidate OpenCode primitives in the pinned APIs are: a TUI plugin dialog/command backed by a kernel-generated candidate; a plugin-defined tool's permission action evaluated with an exact resource digest; and session user-input hooks. The TUI declaration exposes `dialog.confirm` and keymap commands, but keymap commands can be programmatically dispatched. The promise plugin command API receives a session ID, prompt, and delivery mode, without a declared user-origin proof. `ToolContext` provides session, agent, message, and call IDs, but **no `ask` method** in the installed 2.0.11 declaration. The permission hook may set `effect: "ask"`; the permission reply API supports `once`, `always`, and `reject`. [Pinned OpenCode permission source](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/permission.ts) shows that an `allow` rule can proceed without a prompt and that `always` can save a later allow rule. This makes generic tool permission insufficient for exact consent.

The most promising proof is a kernel-owned candidate whose exact digest and plain-language scope/review summary are presented in an OpenCode-owned, explicitly user-operated UI. The approval callback would pass only the kernel's unforgeable pending candidate reference, and the kernel would atomically consume it once. A tool permission request could substitute **only if** a focused host experiment proves that the exact resource is shown to the human, approval is once-only, `always` and pre-existing allow rules cannot authorize it, the returned action is tied to the same call/digest, and programmatic/session replay cannot masquerade as the user. The currently inspected types do not prove that. A session prompt hook also needs proof that source/provenance is user-originated rather than synthetic or model-driven. Until one route passes, **E cannot claim mechanical exact user authorization**.

The same binding protocol must be repeated at commit time over the **current passing review**, not over an old intent or a model description. Any edit, HEAD/index change, or newer review invalidates the pending commit candidate. Denial or ambiguous response leaves no consent record.

## 3. Actor, session, tool, and worktree provenance

The pinned `@opencode/schema` `Tool.Context` includes host-supplied `agent`, `sessionID`, `messageID`, and tool-call `id`. The plugin tool hook exposes before/after status and the same identities. `ctx.session.get({sessionID})` can return session location and optional `parentID`/fork metadata. The existing Explorer plugin resolves that location's directory through `git rev-parse --show-toplevel` and checks `toolContext.agent` before executing. This is real current integration evidence, not proof that a caller-provided workflow ID establishes authority.

The kernel should trust the host-injected tool context *as a caller identity after host-version verification*, then independently check the expected role, run membership, canonical Git root/worktree, current record head, and exact operation. A session parent link is useful for detecting independent review context, but by itself does not prove cognitive independence: the same actor/model could review its own work in a new session, or a delegated session could share context. First-version rules should require distinct Implementer and Reviewer invocations and deny reviewer edit/commit tools, then verify through dogfood that dispatch actually uses those roles. The kernel must reject a Reviewer submission from the Implementer agent ID even if host permissions were accidentally broadened.

Per-agent OpenCode permissions already deny Reviewer edits and restrict shell commands in this checkout, while the Implementer has broad edit/shell access and a prompt-level approved-path rule. Native permissions are defense in depth; they do not prove that no transient out-of-scope write occurred. Kernel receipts can prove the final accepted/committed path set and reject a changed out-of-scope tree. If **no out-of-scope write at any time** is the required meaning of exact scope, E needs a stronger tool or OS boundary than the current coarse native permissions; that may erase some of its simplicity. Likewise, the Committer must not have a generic `git commit` escape around the prepared-attempt gate. An OpenCode-only successor should expose commit through a trusted gate and deny other commit paths, with host enforcement verified rather than assumed.

Worktree identity is resolved from host session location and canonical Git observations, not from a model-supplied path. A path under a different worktree, branch, repository, or root fails. No parallel run, child session topology, or cross-run inherited authority is admitted in the first design. Host permissions and plugin checks are separate layers, and neither is an OS sandbox by itself.

## 4. Atomic durable authority

The pinned plugin `StorageDomain` exposes `get`, `set`, `remove`, and `scan`. Its interface does **not** expose compare-and-swap, conditional insert, transaction, or append-only guarantee. Two tool calls could both read the same head and overwrite each other. Treating that store as the sole authority would require an independently proven single-writer serial execution guarantee across sessions, processes, and reloads; none appears in the inspected type surface.

The smallest credible local boundary is one repository/worktree-scoped SQLite database (or another demonstrably transactional local store) with immutable record rows, a run-head row, a uniqueness constraint on record identity, and a short transaction that validates the expected predecessor and advances the head exactly once. The current store demonstrates this technique with `UPDATE ... WHERE version = ?`, transactions, and append-only audit rows; its large `WorkflowState` JSON and migration/runtime machinery are not required by that observation. A single active-run uniqueness rule prevents overlapping first-version runs for one worktree. Store data outside the repository by default and bind it to canonical repository/worktree identity. Reopen and verify the chain after ordinary process restart. An unknown schema or incompatible plugin release fails closed; do not load an old Workflow MCP database or promise historical runtime recovery.

External Git effects cannot join a SQLite transaction. Persist the prepared attempt, including HEAD, staged tree, exact changed paths, review digest, and attempt ID, **before** invoking `git commit`. A response loss then leaves a durable `unknown` attempt. Reconciliation reads Git only and compares commit parent, tree, and changed paths against the prepared record. If exact proof is unavailable, stop for human inspection; never replay a commit automatically. A database transaction protects authority ordering, while Git observation protects the side effect. This narrow two-boundary protocol survives every architecture.

## 5. Git and validation technique audit

| Intrinsic guarantee | Current evidence | Successor judgment |
|---|---|---|
| Canonical root and exact safe paths | `git.ts` canonical path handling; `change-receipt.ts` normalizes paths and rejects escaping/symlinked parents | **Reusable concept; possible small algorithm reuse** after independent review. Bind to host session root and reject ambiguous paths. |
| Symlink, file mode, deletion, rename scope | `change-receipt.ts` hashes symlink targets and modes; `git.ts` uses `--no-renames`, NUL-delimited path parsing and staged entries | **Reusable concept; possible small algorithm reuse.** A rename must account for source and destination; avoid Git rename heuristics as authority. |
| HEAD/index/worktree receipt | `createReceipt`, `verifyReviewReceipt`, staged entry comparison | **Necessary; possible small reuse.** Use full content/mode/target receipts, not path names alone. |
| Full-target independent review | `workflow_begin_review` captures target; submission rechecks it; Reviewer contract inspects actual changed files | **Necessary concept; current lifecycle glue is too coupled.** Bind review start/end to one full final target. |
| Exact reviewer validation | `.codex/reviewer-validation.json`, `reviewer-validation-policy.ts`, runner's `spawnSync(... shell:false)` | **Necessary concept; policy parser/exact argv matcher are possible small reuse.** Reviewer owns execution and records actual results. |
| Validation mutation detection and bounded evidence | Runner fingerprints before/after, caps output, records timeout/unavailable/mutated result | **Necessary outcome; current 1,274-line all-repository fingerprint implementation needs separate cost/coverage review.** Split command policy from target-integrity checks; never infer a pass after unavailable execution. |
| Staged-tree integrity | `prepareCommitReceipt` checks reviewed receipt, exact staged paths, residue, mode/blob digest, and tree | **Necessary; possible focused algorithm reuse.** Ambient staged files terminate preparation. |
| Post-commit verification | `verifyPreparedCommit` checks parent, tree, and changed paths | **Necessary; possible focused algorithm reuse.** Do not trust a reported SHA or successful shell exit alone. |
| Ambiguous completion | `workflow_reconcile_commit_result` and prepared attempt evidence | **Necessary only for external Git.** No general mutation-specific reconciliation framework. |
| Repair/lineage/manual evidence retention | Review/implementation transitions, linked-followup, validation lifecycle | **Unnecessary under anti-requirements.** A new run gets fresh review and validation. |

One design hazard is the existing commit split: the current Committer stages through shell and Workflow MCP verifies before the external commit. E should test whether a narrow kernel-owned commit operation can reduce bypass and response ambiguity while still respecting Git hooks and the user's commit-message intent. It must check the index again immediately before Git execution and verify afterward. No local protocol can make SQLite and Git one atomic transaction or prevent an unrelated actor from racing the repository without stronger worktree/index isolation. If a race produces an unverified commit, report it as an external side effect requiring human inspection rather than claim success. The predecessor's Git checks provide concrete regression cases.

## 6. Failure semantics and the new-run boundary

| Case | First-version disposition | Safety condition |
|---|---|---|
| Ordinary reviewer defect | Terminal failed review; return actionable findings | No commit consent possible; new run gets fresh intent/target/review. |
| #190 out-of-scope baseline defect | Terminal validation failure tagged as baseline evidence | Do not offer repair inside the five-path run; changing the sixth path requires a new approved scope. |
| Implementer needs another path | Terminal scope-blocked run | No mutable expansion; subsequent run approves complete new scope. |
| Validation unavailable | Terminal inconclusive | Never turn `not_run` into passed or failed evidence. |
| HEAD changes | Terminal stale run | Rebind nothing; inspect current reality for a new candidate. |
| User changes intent | Terminal old run | New immutable certificate and human approval. |
| Agent/session dies | Read unambiguous durable head after restart; otherwise terminate | Do not infer completed worker work from transcript or message history. |
| Plugin/runtime reloads | Reread only compatible current records; otherwise terminate | No old-state interpreter or historical runtime dispatcher. |
| Ambient staged file appears | Refuse/terminate commit preparation | Never absorb it into reviewed scope or silently unstage it. |
| Commit preparation fails | Terminal failed attempt before external commit | Index may need user cleanup; next run requires fresh review and consent. |
| Commit result ambiguous | Retain only `commit_unknown` and perform read-only verification | Never retry Git commit until external outcome is proven; human intervention if proof fails. |

The most dangerous place to accidentally recreate lineage is a *new run over a failed run's dirty tree*. The new run must independently capture the entire current target against a trusted current HEAD: approved paths, staged/unstaged/untracked state, and final content. The user approves that self-contained target and the Reviewer reviews it all. A small repair delta is insufficient if the older implementation remains in the tree. Prior findings may be shown as non-authoritative context but are neither a required classification set nor an approval/validation source. If the tree has unrelated or unbounded changes, refuse the new run until the user makes the target clear. This repetition costs time; eliminating it by importing prior approval or review evidence would reintroduce lineage.

## 7. Current-repo lessons

**Required invariants to carry forward**

- Canonical repository/worktree identity, exact approved paths and intent, and fresh HEAD/content baseline.
- No worker self-authorizes a broader scope, review result, or commit; stale/contradictory inputs fail closed.
- Independent Reviewer inspects the full target and owns actual command evidence; failed or unavailable validation remains visible.
- Commit requires new user consent to one passing review and exact changed paths, then staged and post-commit Git verification.
- An ambiguous external Git side effect is never treated as permission to retry.

**Useful techniques worth reconsidering**

- Canonical JSON digesting, exact-path and symlink checks, NUL-delimited Git parsing, content/mode receipts, and no-rename staged accounting.
- Small optimistic transaction with append-only audit and record-head comparison.
- Shell-free exact argv validation with bounded output and explicit mutation detection.
- Host-provided agent/session/tool context checked again at the trusted gate; worker handoff contains one opaque run reference.
- Representative adversarial cases from #190, #124, #178, #180, #182/#183, and #191/#193, without porting their recovery protocols.

**Anti-requirements for the first successor**

- In-run repair, mutable scope expansion, adjudication, finding/repair history, linked or combined review, and inherited validation or approval.
- General resume/recovery, changed-HEAD recovery, historical runtime routing, old Workflow MCP compatibility, and cross-host generated contracts.
- Parallel/child workflows, checkpoint commits with unresolved findings, and descriptor machinery to advertise optional continuations.

## 8. Falsify the rewrite before committing to it

The favorable case for E is conceptual: six immutable/monotonic evidence facts and a few gates are easier to compose than the current repair/recovery lifecycle. The unfavorable case is also concrete:

1. **Exact approval may force a new service/UI.** The inspected plugin types expose dialogs, commands, hooks, and permission evaluation but no proved once-only digest-bound human confirmation. A generic permission answer, including saved `always`, is insufficient.
2. **Caller provenance may be too weak.** Tool context carries agent/session/call IDs and session metadata can expose parent/worktree, but the host behavior and trusted user-origin path require verification. Permissions alone do not isolate writes or commits.
3. **Atomic records are still state.** Plugin storage lacks an advertised CAS. SQLite or equivalent is needed; if its schema, coordinator, and recovery layer grow toward Workflow MCP, B wins.
4. **Git remains a distributed side effect.** Prepared attempt, durable write-ahead evidence, post-commit verification, and unknown outcome are mandatory. They should stay one bounded protocol, not general mutation recovery.
5. **Fresh runs are expensive.** Full-tree recapture and re-review can be costly. If dogfood demands inherited findings/approval to make this tolerable, E loses its main simplification.
6. **Host coupling has cost.** Native plugin and TUI APIs may change; pinned releases and focused host checks replace dual-host generator tests. The direct `opencode --version` check was unavailable under this sandbox, so there is no live host proof in this investigation.

The bounded proof order is: (a) demonstrate exact once-only human approval of an immutable digest in OpenCode; (b) prove host-injected actor/session/worktree identity and deny role bypass; (c) prove atomic record-head rejection across competing calls/reload; (d) prove full-target new-run review and exact validation; (e) prove staged and ambiguous-commit behavior. Use disposable repositories and the #190 baseline case. Stop if any proof needs repair lineage, broad descriptors, or historical runtime routing. Compare the resulting *actual* record/gate/tool surface with a similarly specified B design. E wins only if it is materially clearer in ordinary dogfood while preserving the invariants. If both converge on the same transactional kernel, reusing simplified MCP's proven Git and persistence work favors B.

## Sources

Repository source: [OpenCode configuration](../opencode.json), [OpenCode flow](opencode-orchestration-flow.md), [Explorer plugin](../.opencode/plugins/codex-agents-explorer-tools/index.ts), [session worktree resolution](../.opencode/plugins/codex-agents-explorer-tools/worktree.ts), [Git checks](../.codex/workflow-mcp/git.ts), [receipt algorithm](../.codex/agents/change-receipt.ts), [reviewer validation runner](../.codex/agents/reviewer-validation.ts), [exact argv policy](../.codex/workflow-mcp/reviewer-validation-policy.ts), [transaction store](../.codex/workflow-mcp/store.ts), [review transition](../.codex/workflow-mcp/transitions/review.ts), and [prior reassessment](eval-investgation.md). Pinned local interfaces inspected: `node_modules/@opencode/plugin/dist/promise/{plugin,tool,permission,session,storage,command}.d.ts`, `node_modules/@opencode/plugin/dist/tui/context.d.ts`, and `node_modules/@opencode/schema/dist/{tool,session,permission}.d.ts`. The [pinned OpenCode v2.0.11 permission implementation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/permission.ts) supports the specific observation about ask/allow/always; no broader claim about current unpinned releases is made. Issue evidence: [#124](https://github.com/mikechao/codex-agents/issues/124), [#178](https://github.com/mikechao/codex-agents/issues/178), [#180](https://github.com/mikechao/codex-agents/issues/180), [#182](https://github.com/mikechao/codex-agents/issues/182), [#183](https://github.com/mikechao/codex-agents/issues/183), [#191](https://github.com/mikechao/codex-agents/issues/191), [#192](https://github.com/mikechao/codex-agents/issues/192), and [#193](https://github.com/mikechao/codex-agents/issues/193). The detailed final #190 repair sequence is the supplied dogfood account, corroborated at its feasibility boundaries by current source; it was not rerun here.

**Final conclusion: E remains materially smaller and warrants a bounded prototype/proof.**
