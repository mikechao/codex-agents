import { test } from "bun:test";
import assert from "node:assert/strict";
import { renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowStore } from "../store.js";
import { stagedScopeReconciliationFeasible } from "../transitions.js";
import { MAX_PATHS } from "../validation.js";
import { fixture } from "./test-fixtures.js";
import { workflowState } from "./workflow-state-fixtures.js";
import {
  authorized,
  category,
  currentVersion,
  deterministicParentActions,
  finding,
  implementation,
  input,
  rawState,
  review,
} from "./workflow-test-helpers.js";

test("linked remediation and combined review retain receipts through a committed result", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const source = store.create(input(git));
    implementation(store, source);
    writeFileSync(join(root, "note.txt"), "source change\n");
    review(store, source, undefined, "APPROVED", [], [finding("LINKED-OPTIONAL", "P3", false)]);
    const child = store.createLinkedFollowup({
      workflow_id: source.workflow_id,
      expected_version: store.parentGet(source.workflow_id).version,
      objective: "linked remediation",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["child criterion"],
      validation_requirements: [
        { description: "child validation", kind: "command", argv: ["bun", "run", "check"] },
      ],
      finding_ids: ["LINKED-OPTIONAL"],
      user_authorization: "authorized linked remediation",
    });
    implementation(store, child, undefined, "DONE", { "LINKED-OPTIONAL": "resolved" });
    writeFileSync(join(root, "note.txt"), "remediation change\n");
    assert.equal(
      review(store, child, undefined, "APPROVED", [], [], { "LINKED-OPTIONAL": "resolved" }).phase,
      "REVIEWING",
    );
    assert.equal(review(store, child, undefined, "APPROVED", [], [], {}).phase, "STOPPED_APPROVED");
    const id = child.workflow_id;
    store.authorizeCommit({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
      user_authorization: "authorize linked commit",
    });
    git("add", "note.txt");
    const prepared = store.prepareCommit({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
    });
    git("commit", "-qm", "linked commit");
    const committed = store.submitCommitResult({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "committed",
      failure_summary: null,
    });
    assert.equal(committed.phase, "COMMITTED");
    assert.equal(rawState(store, id).linked_continuation.remediation_review_receipt !== null, true);
    assert.equal(rawState(store, id).review_receipt !== null, true);
    assert.equal(store.audit(id).at(-1).event_type, "COMMIT_RESULT_SUBMITTED");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope expansion requires a clean baseline and preserves state on rejection", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { approved_paths: ["new.txt"] }));
    writeFileSync(join(root, "note.txt"), "staged change\n");
    git("add", "note.txt");
    git("restore", "--source=HEAD", "--worktree", "--", "note.txt");
    assert.equal(
      category(() =>
        store.expandScope({
          workflow_id: created.workflow_id,
          expected_version: 0,
          added_paths: ["note.txt"],
          reason: "tracked companion file",
          user_authorization: "authorized scope expansion",
        }),
      ),
      "ERROR_SCOPE_EXPANSION_DIRTY",
    );
    assert.equal(store.parentGet(created.workflow_id).version, 0);
    assert.equal(store.audit(created.workflow_id).length, 1);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("initial and review receipts classify absent, deleted, and symlink paths", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "target.txt"), "target\n");
    symlinkSync("target.txt", join(root, "link.txt"));
    git("add", ".");
    git("commit", "-qm", "receipt fixture");
    unlinkSync(join(root, "note.txt"));
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(
      input(git, {
        objective: "receipt classifications",
        approved_paths: ["link.txt", "missing.txt", "note.txt"],
      }),
    );
    const initial = rawState(store, created.workflow_id).initial_receipt;
    assert.deepEqual(
      initial.paths.map(({ path, state, kind }: any) => ({ path, state, kind })),
      [
        { path: "link.txt", state: "unchanged", kind: "symlink" },
        { path: "missing.txt", state: "absent", kind: "missing" },
        { path: "note.txt", state: "deleted", kind: "missing" },
      ],
    );
    implementation(store, created);
    const reviewed = review(store, created);
    assert.equal(reviewed.phase, "STOPPED_APPROVED");
    const reviewReceipt = rawState(store, created.workflow_id).review_receipt;
    assert.deepEqual(
      reviewReceipt.paths.map(({ path, state, kind }: any) => ({ path, state, kind })),
      initial.paths.map(({ path, state, kind }: any) => ({ path, state, kind })),
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incomplete reviewed rename authority reconciles exact staged paths before fresh review", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(
      input(git, {
        objective: "incomplete rename authority",
        approved_paths: ["moved.txt"],
      }),
    );
    implementation(store, created);
    renameSync(join(root, "note.txt"), join(root, "moved.txt"));
    writeFileSync(join(root, "moved.txt"), "complete rewrite with no rename similarity\n");
    git("add", "-A");
    assert.deepEqual(git("diff", "--cached", "--no-renames", "--name-status").split("\n"), [
      "A\tmoved.txt",
      "D\tnote.txt",
    ]);
    review(store, created);
    store.authorizeCommit({
      workflow_id: created.workflow_id,
      expected_version: currentVersion(store, created.workflow_id),
      user_authorization: "authorize reviewed destination",
    });

    const stopped = store.prepareCommit({
      workflow_id: created.workflow_id,
      expected_version: currentVersion(store, created.workflow_id),
    });
    assert.equal(stopped.stop_context.category, "ERROR_STAGED_SCOPE");
    assert.equal(stopped.stop_context.recovery, "choose");
    assert.deepEqual(stopped.stop_context.reconciliation_paths, ["note.txt"]);
    assert.deepEqual(deterministicParentActions(store, created.workflow_id), [
      "workflow_reconcile_staged_scope",
    ]);
    const execution = store.operatorDecisionGet(created.workflow_id).execution;
    assert.equal(execution.primary.mode, "parent_mutation");
    if (execution.primary.mode !== "parent_mutation") throw new Error("expected recovery mutation");
    assert.equal(execution.primary.selection, "single");
    const reconciliation = execution.primary.invocations.find(
      (invocation: any) => invocation.operation === "workflow_reconcile_staged_scope",
    );
    assert.ok(reconciliation);
    assert.deepEqual(reconciliation?.scope_reconciliation_binding, {
      reviewed_paths: ["moved.txt"],
      added_paths: ["note.txt"],
    });
    assert.deepEqual(reconciliation?.required_inputs, [
      { path: ["added_paths"], source: "server_derived", required: true },
      { path: ["review_context"], source: "user_authored", required: true },
    ]);
    const reconciliationMutation = {
      ...reconciliation?.fixed_arguments,
      added_paths: reconciliation?.scope_reconciliation_binding.added_paths,
      review_context: "reconcile the complete move scope",
      user_authorization: "authorize the source and destination paths",
    };
    store.reconcileStagedScope(reconciliationMutation);
    assert.deepEqual(store.parentGet(created.workflow_id).approved_paths, [
      "moved.txt",
      "note.txt",
    ]);
    assert.equal(store.parentGet(created.workflow_id).phase, "REVIEWING");
    review(store, created);
    store.authorizeCommit({
      workflow_id: created.workflow_id,
      expected_version: currentVersion(store, created.workflow_id),
      user_authorization: "authorize the freshly reviewed move",
    });
    assert.equal(
      store.prepareCommit({
        workflow_id: created.workflow_id,
        expected_version: currentVersion(store, created.workflow_id),
      }).phase,
      "COMMIT_PREPARED",
    );
    assert.equal(
      category(() =>
        store.retryCommitPreparation({
          workflow_id: created.workflow_id,
          expected_version: currentVersion(store, created.workflow_id),
          retry_context: "repeat the incomplete reviewed scope",
        }),
      ),
      "ERROR_INVALID_TRANSITION",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh staged recovery fails closed when live scope changes after a descriptor", () => {
  const { root, git } = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
  try {
    const workflow = authorized(store, root, git, {
      approved_paths: ["note.txt"],
      objective: "staged recovery freshness",
    });
    writeFileSync(join(root, "b.txt"), "staged outside scope\n");
    git("add", "note.txt", "b.txt");
    const stopped = store.prepareCommit({
      workflow_id: workflow.id,
      expected_version: currentVersion(store, workflow.id),
    });
    assert.deepEqual(stopped.stop_context.reconciliation_paths, ["b.txt"]);
    const beforeVersion = currentVersion(store, workflow.id);
    const descriptor = store.operatorDecisionGet(workflow.id).execution.primary;
    assert.equal(descriptor.mode, "parent_mutation");
    if (descriptor.mode !== "parent_mutation")
      throw new Error("expected reconciliation descriptor");
    assert.equal(descriptor.selection, "single");
    assert.equal(descriptor.invocations[0].operation, "workflow_reconcile_staged_scope");

    git("reset", "-q", "--", "b.txt");
    writeFileSync(join(root, "c.txt"), "changed outside scope\n");
    git("add", "c.txt");
    const afterExternalChange = {
      status: git("status", "--porcelain"),
      staged: git("diff", "--cached", "--name-status"),
    };
    assert.equal(
      category(() =>
        store.reconcileStagedScope({
          ...descriptor.invocations[0].fixed_arguments,
          added_paths: ["b.txt"],
          review_context: "reconcile the originally observed scope",
          user_authorization: "authorize the exact originally observed scope",
        }),
      ),
      "ERROR_STALE_RECEIPT",
    );
    assert.equal(currentVersion(store, workflow.id), beforeVersion);
    assert.equal(git("status", "--porcelain"), afterExternalChange.status);
    assert.equal(git("diff", "--cached", "--name-status"), afterExternalChange.staged);

    const fresh = store.operatorDecisionGet(workflow.id);
    assert.deepEqual(fresh.execution.parent_actions, []);
    assert.equal(fresh.execution.primary.mode, "wait");
    assert.doesNotMatch(JSON.stringify(fresh), /b\.txt/iu);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh staged recovery fails closed when HEAD advances after preparation", () => {
  const { root, git } = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
  try {
    const workflow = authorized(store, root, git, {
      approved_paths: ["note.txt"],
      objective: "staged recovery head freshness",
    });
    writeFileSync(join(root, "b.txt"), "staged outside scope\n");
    git("add", "note.txt", "b.txt");
    const stopped = store.prepareCommit({
      workflow_id: workflow.id,
      expected_version: currentVersion(store, workflow.id),
    });
    assert.equal(stopped.stop_context.category, "ERROR_STAGED_SCOPE");
    assert.deepEqual(stopped.stop_context.reconciliation_paths, ["b.txt"]);
    assert.deepEqual(deterministicParentActions(store, workflow.id), [
      "workflow_reconcile_staged_scope",
    ]);

    const state = rawState(store, workflow.id);
    const headRef = git("symbolic-ref", "--quiet", "HEAD");
    const advancedHead = git(
      "commit-tree",
      git("rev-parse", "HEAD^{tree}"),
      "-p",
      state.base_head,
      "-m",
      "advance HEAD without changing the index",
    );
    git("update-ref", headRef, advancedHead);
    assert.deepEqual(git("diff", "--cached", "--name-only").split("\n"), ["b.txt", "note.txt"]);

    const fresh = store.operatorDecisionGet(workflow.id);
    assert.deepEqual(fresh.execution.parent_actions, []);
    assert.equal(fresh.execution.primary.mode, "wait");
    assert.doesNotMatch(JSON.stringify(fresh), /workflow_reconcile_staged_scope/iu);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciliation feasibility respects persisted and combined path caps", () => {
  const state = workflowState() as any;
  assert.equal(stagedScopeReconciliationFeasible(state, ["outside.txt"], "/repo"), true);

  const fullApprovedScope = structuredClone(state);
  fullApprovedScope.approved_paths = Array.from(
    { length: MAX_PATHS },
    (_, index) => `approved-${index}.txt`,
  );
  assert.equal(
    stagedScopeReconciliationFeasible(fullApprovedScope, ["outside.txt"], "/repo"),
    false,
  );

  const fullCombinedScope = structuredClone(state);
  fullCombinedScope.linked_continuation = {
    combined_review_paths: Array.from({ length: MAX_PATHS }, (_, index) => `combined-${index}.txt`),
  };
  assert.equal(
    stagedScopeReconciliationFeasible(fullCombinedScope, ["outside.txt"], "/repo"),
    false,
  );

  const fullExpansionHistory = structuredClone(state);
  fullExpansionHistory.scope_expansions = Array.from({ length: MAX_PATHS }, () => ({}));
  assert.equal(
    stagedScopeReconciliationFeasible(fullExpansionHistory, ["outside.txt"], "/repo"),
    false,
  );

  const fullBaselineHistory = structuredClone(state);
  fullBaselineHistory.approved_path_baselines = Array.from({ length: MAX_PATHS }, () => ({}));
  assert.equal(
    stagedScopeReconciliationFeasible(fullBaselineHistory, ["outside.txt"], "/repo"),
    false,
  );

  assert.equal(
    stagedScopeReconciliationFeasible(
      state,
      Array.from({ length: MAX_PATHS + 1 }, (_, index) => `outside-${index}.txt`),
      "/repo",
    ),
    false,
  );
});

test("infeasible staged reconciliation advertises retry after accidental staging is removed", () => {
  const { root, git } = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
  try {
    const approvedPaths = [
      "note.txt",
      ...Array.from({ length: MAX_PATHS - 1 }, (_, index) => `capacity-${index}.txt`),
    ];
    const workflow = authorized(store, root, git, { approved_paths: approvedPaths });
    writeFileSync(join(root, "outside.txt"), "accidental staged content\n");
    git("add", "--", ...approvedPaths, "outside.txt");

    const stopped = store.prepareCommit({
      workflow_id: workflow.id,
      expected_version: currentVersion(store, workflow.id),
    });
    assert.equal(stopped.phase, "STOPPED_COMMIT_PREPARATION");
    assert.equal(stopped.stop_context.category, "ERROR_STAGED_SCOPE");
    assert.equal(stopped.stop_context.recovery, "retry");
    assert.equal("reconciliation_paths" in stopped.stop_context, false);
    const decision = store.operatorDecisionGet(workflow.id);
    assert.deepEqual(
      decision.execution.parent_actions.map((action: any) => action.action),
      ["workflow_retry_commit_preparation"],
    );
    assert.deepEqual(
      decision.execution.primary.invocations.map((invocation: any) => invocation.operation),
      ["workflow_retry_commit_preparation"],
    );

    git("reset", "-q", "--", "outside.txt");
    const retry = decision.execution.primary.invocations[0];
    const retried = store.retryCommitPreparation({
      ...retry.fixed_arguments,
      retry_context: "remove accidental out-of-scope staging and preserve reviewed authority",
    });
    assert.equal(retried.phase, "COMMIT_AUTHORIZED");
    assert.equal(
      store.prepareCommit({
        workflow_id: workflow.id,
        expected_version: currentVersion(store, workflow.id),
      }).phase,
      "COMMIT_PREPARED",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
