import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { planReference } from "../plan-reference.js";
import { WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { disposeFixture, fixture } from "./test-fixtures.js";

function revisionInput() {
  return {
    workflow_type: "change",
    full_plan: "step one\nstep two\nfinal step",
    execution_brief: "Run the bounded serial implementation.",
    objective: "planning foundation",
    approved_paths: ["note.txt"],
    acceptance_criteria: ["the plan is preserved"],
    validation_requirements: [
      {
        description: "bun run test:workflow-mcp",
        kind: "command",
        argv: ["bun", "run", "test:workflow-mcp"],
      },
    ],
  };
}

function category(action: () => unknown): string {
  try {
    action();
    return "none";
  } catch (error) {
    return error instanceof WorkflowError ? error.category : "unknown";
  }
}

function workflowState(store: any, workflowId: string): Record<string, any> {
  const row = store.db
    .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
    .get(workflowId) as { state_json: string };
  return JSON.parse(row.state_json) as Record<string, any>;
}

function persistWorkflowState(store: any, workflowId: string, state: Record<string, any>): void {
  store.db
    .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
    .run(JSON.stringify(state), objectDigest(state), workflowId);
}

function sourceInput(git: (...args: string[]) => string) {
  const approvedPaths = ["note.txt"];
  return {
    workflow_type: "change",
    objective: "source workflow",
    approved_plan: null,
    approved_paths: approvedPaths,
    acceptance_criteria: ["source criterion"],
    validation_requirements: [
      { description: "source validation", kind: "command", argv: ["bun", "run", "check"] },
    ],
    review_target: {
      review_mode: "working_tree",
      base_revision: git("rev-parse", "HEAD"),
      head_revision: null,
      approved_paths: approvedPaths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
  };
}

function approvedSource(store: any, git: (...args: string[]) => string) {
  const source = store.create(sourceInput(git));
  const id = source.workflow_id;
  store.submitImplementation({
    workflow_id: id,
    expected_version: 0,
    status: "DONE",
    summary: "source implementation",
    agent_touched_paths: [],
    acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "done" }],
    validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "done" }],
    known_failures: [],
    finding_resolution_map: {},
  });
  writeFileSync(join(store.root, "note.txt"), "source change\n");
  store.beginReview({ workflow_id: id, expected_version: 1 });
  const optional = {
    finding_id: "PLAN-OPTIONAL",
    severity: "P3",
    blocking: false,
    file_and_line: "note.txt:1",
    failure_scenario: "scenario",
    impact: "impact",
    violated_requirement: "requirement",
    remediation: "remediation",
    missing_or_inadequate_test: "test",
  };
  store.submitReview({
    workflow_id: id,
    expected_version: 2,
    review_status: "APPROVED",
    blocking_findings: [],
    optional_findings: [optional],
    prior_finding_classifications: {},
    validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "reviewed" }],
  });
  return { source, id, optional };
}

function planInput(path = "planned.txt") {
  return {
    ...revisionInput(),
    objective: "authoritative child objective",
    execution_brief: "authoritative child execution brief",
    approved_paths: [path],
    acceptance_criteria: ["authoritative child criterion"],
    validation_requirements: [
      {
        description: "authoritative child validation",
        kind: "command",
        argv: ["bun", "run", "test:workflow-mcp"],
      },
    ],
  };
}

function blockedPlanWorkflow(store: any, approvedPaths = ["note.txt"]) {
  const draft = store.planCreate({ ...revisionInput(), approved_paths: approvedPaths });
  const approved = store.planApprove({
    plan_id: draft.plan_id,
    revision: draft.revision,
    user_authorization: "approve initial blocked recovery plan",
  });
  const created = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
  const blocked = store.submitImplementation({
    workflow_id: created.workflow_id,
    expected_version: 0,
    status: "BLOCKED",
    summary: "blocked before recovery",
    agent_touched_paths: [],
    acceptance_results: [{ criterion_id: "AC-001", status: "not_satisfied", evidence: "blocked" }],
    validation_results: [{ validation_id: "VAL-001", status: "not_run", evidence: "blocked" }],
    known_failures: ["blocked"],
    finding_resolution_map: {},
  });
  assert.equal(blocked.phase, "STOPPED_IMPLEMENTATION_BLOCKED");
  return { draft, approved, created };
}

test("plan references are deterministic UUID-derived display values", () => {
  const planId = "00000000-0000-4000-8000-000000000001";
  assert.equal(planReference(planId), "elaborate-orange-monkey");
  assert.equal(planReference(planId), planReference(planId));
  assert.notEqual(planReference(planId), planReference("00000000-0000-4000-8000-000000000002"));
});

test("plans preserve exact revisions, approval, and workflow provenance", () => {
  const target = fixture();
  const databasePath = join(target.root, "planning.sqlite");
  const store = new WorkflowStore({ repositoryRoot: target.root, databasePath });
  const draft = store.planCreate(revisionInput());
  assert.equal(draft.metadata.status, "draft");
  assert.equal(draft.full_plan, revisionInput().full_plan);
  assert.equal(draft.plan_ref, planReference(draft.plan_id));
  assert.equal(store.planGet({ plan_id: draft.plan_id, revision: 1 }).plan_ref, draft.plan_ref);
  const approved = store.planApprove({
    plan_id: draft.plan_id,
    revision: 1,
    user_authorization: "approve exact revision",
  });
  assert.equal(approved.metadata.status, "approved");
  const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: 1 });
  assert.equal(workflow.approved_plan, revisionInput().full_plan);
  assert.equal(workflow.execution_brief, revisionInput().execution_brief);
  assert.deepEqual(workflow.plan_provenance, {
    plan_id: draft.plan_id,
    revision: 1,
    artifact_digest: approved.artifact_digest,
    approved_at: approved.metadata.approval?.approved_at,
  });
  store.close();
  const reopened = new WorkflowStore({ repositoryRoot: target.root, databasePath });
  assert.equal(reopened.planGet({ plan_id: draft.plan_id, revision: 1 }).plan_ref, draft.plan_ref);
  assert.equal(
    reopened.planParentGet({ plan_id: draft.plan_id, revision: 1 }).full_plan,
    revisionInput().full_plan,
  );
  reopened.close();
  rmSync(databasePath, { force: true });
  disposeFixture(target.root);
});

test("plan-backed workflows remain bound to an approved historical revision", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve historical revision one",
    });
    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
    const revised = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: { full_plan: "new current plan" },
    });

    assert.equal(revised.metadata.status, "draft");
    assert.equal(store.parentGet(workflow.workflow_id).approved_plan, revisionInput().full_plan);

    store.planApprove({
      plan_id: draft.plan_id,
      revision: revised.revision,
      user_authorization: "approve current revision two",
    });
    const historical = store.parentGet(workflow.workflow_id);
    assert.equal(historical.approved_plan, revisionInput().full_plan);
    assert.equal(historical.plan_provenance?.revision, 1);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-backed workflow reads reject frozen contract mismatches", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve snapshot contract",
    });
    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
    const original = workflowState(store, workflow.workflow_id);
    const corruptions: Array<(state: Record<string, any>) => void> = [
      (state) => {
        state.workflow_type = "review_only";
      },
      (state) => {
        state.objective = "different objective";
      },
      (state) => {
        state.approved_plan = "different approved plan";
      },
      (state) => {
        state.execution_brief = "different execution brief";
      },
      (state) => {
        state.acceptance_criteria[0].description = "different acceptance criterion";
      },
      (state) => {
        state.validation_requirements[0].description = "different validation requirement";
      },
      (state) => {
        state.approved_paths = ["different.txt"];
        state.review_target.approved_paths = ["different.txt"];
        state.initial_receipt.approved_paths = ["different.txt"];
        state.initial_receipt.paths[0].path = "different.txt";
      },
    ];

    for (const corrupt of corruptions) {
      const state = structuredClone(original);
      corrupt(state);
      persistWorkflowState(store, workflow.workflow_id, state);
      assert.equal(
        category(() => store.parentGet(workflow.workflow_id)),
        "ERROR_STATE_CORRUPT",
      );
      persistWorkflowState(store, workflow.workflow_id, original);
    }
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-backed workflow reads reject missing or inconsistent historical authority", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve exact historical authority",
    });
    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
    const originalState = workflowState(store, workflow.workflow_id);
    const provenanceCorruptions: Array<(state: Record<string, any>) => void> = [
      (state) => {
        state.plan_provenance.plan_id = "00000000-0000-4000-8000-000000000001";
      },
      (state) => {
        state.plan_provenance.revision = 999;
      },
      (state) => {
        state.plan_provenance.artifact_digest = "0".repeat(64);
      },
      (state) => {
        state.plan_provenance.approved_at = "2020-01-01T00:00:00.000Z";
      },
    ];
    for (const corrupt of provenanceCorruptions) {
      const state = structuredClone(originalState);
      corrupt(state);
      persistWorkflowState(store, workflow.workflow_id, state);
      assert.equal(
        category(() => store.parentGet(workflow.workflow_id)),
        "ERROR_STATE_CORRUPT",
      );
      persistWorkflowState(store, workflow.workflow_id, originalState);
    }

    const revision = store.db
      .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = 1")
      .get(draft.plan_id);
    const approval = store.db
      .prepare("SELECT * FROM plan_approvals WHERE plan_id = ? AND revision = 1")
      .get(draft.plan_id);

    store.db
      .prepare("DELETE FROM plan_approvals WHERE plan_id = ? AND revision = 1")
      .run(draft.plan_id);
    assert.equal(
      category(() => store.parentGet(workflow.workflow_id)),
      "ERROR_STATE_CORRUPT",
    );
    store.db
      .prepare(
        "INSERT INTO plan_approvals (plan_id, revision, artifact_digest, user_authorization, approved_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        approval.plan_id,
        approval.revision,
        approval.artifact_digest,
        approval.user_authorization,
        approval.approved_at,
      );

    store.db
      .prepare("DELETE FROM plan_approvals WHERE plan_id = ? AND revision = 1")
      .run(draft.plan_id);
    store.db
      .prepare("DELETE FROM plan_revisions WHERE plan_id = ? AND revision = 1")
      .run(draft.plan_id);
    assert.equal(
      category(() => store.parentGet(workflow.workflow_id)),
      "ERROR_STATE_CORRUPT",
    );
    store.db
      .prepare(
        "INSERT INTO plan_revisions (plan_id, revision, artifact_json, artifact_digest, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        revision.plan_id,
        revision.revision,
        revision.artifact_json,
        revision.artifact_digest,
        revision.created_at,
      );
    store.db
      .prepare(
        "INSERT INTO plan_approvals (plan_id, revision, artifact_digest, user_authorization, approved_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        approval.plan_id,
        approval.revision,
        approval.artifact_digest,
        approval.user_authorization,
        approval.approved_at,
      );

    store.db
      .prepare("UPDATE plan_revisions SET artifact_digest = ? WHERE plan_id = ? AND revision = 1")
      .run("0".repeat(64), draft.plan_id);
    assert.equal(
      category(() => store.parentGet(workflow.workflow_id)),
      "ERROR_STATE_CORRUPT",
    );
    store.db
      .prepare("UPDATE plan_revisions SET artifact_digest = ? WHERE plan_id = ? AND revision = 1")
      .run(revision.artifact_digest, draft.plan_id);

    store.db
      .prepare("UPDATE plan_approvals SET artifact_digest = ? WHERE plan_id = ? AND revision = 1")
      .run("0".repeat(64), draft.plan_id);
    assert.equal(
      category(() => store.parentGet(workflow.workflow_id)),
      "ERROR_STATE_CORRUPT",
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("persisted snapshot verification fails closed on startup and ignores direct workflows", () => {
  const target = fixture();
  const databasePath = join(target.root, "snapshot-verification.sqlite");
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath });
  const direct = store.create(sourceInput(target.git));
  assert.equal(store.parentGet(direct.workflow_id).plan_provenance, null);
  const draft = store.planCreate(revisionInput());
  store.planApprove({
    plan_id: draft.plan_id,
    revision: draft.revision,
    user_authorization: "approve startup snapshot",
  });
  const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
  const corrupted = workflowState(store, workflow.workflow_id);
  corrupted.objective = "corrupted persisted objective";
  persistWorkflowState(store, workflow.workflow_id, corrupted);
  store.close();

  assert.equal(
    category(() => new WorkflowStore({ repositoryRoot: target.root, databasePath })),
    "ERROR_STATE_CORRUPT",
  );
  rmSync(databasePath, { force: true });
  disposeFixture(target.root);
});

test("stale legacy recovery mutations reject a compatible approved plan revision atomically", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const initial = blockedPlanWorkflow(store);
    const id = initial.created.workflow_id;
    const priorDecision: any = store.operatorDecisionGet(id);
    assert.deepEqual(priorDecision.primary, {
      kind: "approve_recovery",
      recovery: "resume_implementation",
      authorization_required: true,
    });
    const resumeInvocation = priorDecision.execution.primary.invocations[0];
    const scopeInvocation = priorDecision.execution.parent_actions.find(
      (action: any) => action.action === "workflow_expand_scope",
    ).descriptor.invocations[0];
    assert.equal(resumeInvocation.fixed_arguments.expected_version, 1);
    assert.equal(scopeInvocation.fixed_arguments.expected_version, 1);

    const revised = store.planRevise({
      plan_id: initial.draft.plan_id,
      base_revision: initial.draft.revision,
      replacements: {
        approved_paths: ["note.txt", "recovery-new.txt"],
        full_plan: "revision two plan",
      },
    });
    store.planApprove({
      plan_id: initial.draft.plan_id,
      revision: revised.revision,
      user_authorization: "approve compatible revision two",
    });
    assert.equal(store.parentGet(id).version, 1);
    assert.deepEqual(store.operatorDecisionGet(id).primary, {
      kind: "approve_recovery",
      recovery: "rebind_implementation_plan",
      authorization_required: true,
    });

    const snapshot = () => ({
      workflow: store.db
        .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(id),
      auditCount: store.db
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workflow_id = ?")
        .get(id).count,
      status: target.git("status", "--short"),
    });
    const before = snapshot();
    assert.equal(
      category(() =>
        store.resumeImplementation({
          ...resumeInvocation.fixed_arguments,
          resume_context: "stale resume authorization",
        }),
      ),
      "ERROR_PLAN_INVALID",
    );
    assert.equal(
      category(() =>
        store.expandScope({
          ...scopeInvocation.fixed_arguments,
          added_paths: ["recovery-new.txt"],
          reason: "stale scope authorization",
          user_authorization: "stale scope authorization",
        }),
      ),
      "ERROR_PLAN_INVALID",
    );
    assert.deepEqual(snapshot(), before);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("stale legacy recovery mutations fail closed for an incompatible approved plan revision", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const initial = blockedPlanWorkflow(store, ["note.txt", "retained.txt"]);
    const id = initial.created.workflow_id;
    const priorDecision: any = store.operatorDecisionGet(id);
    const resumeInvocation = priorDecision.execution.primary.invocations[0];
    const scopeInvocation = priorDecision.execution.parent_actions.find(
      (action: any) => action.action === "workflow_expand_scope",
    ).descriptor.invocations[0];

    const revised = store.planRevise({
      plan_id: initial.draft.plan_id,
      base_revision: initial.draft.revision,
      replacements: { approved_paths: ["note.txt"] },
    });
    store.planApprove({
      plan_id: initial.draft.plan_id,
      revision: revised.revision,
      user_authorization: "approve incompatible contraction",
    });
    assert.deepEqual(store.operatorDecisionGet(id).primary, {
      kind: "operator_intervention",
      reason: "no supported recovery is available",
    });

    const snapshot = () => ({
      workflow: store.db
        .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(id),
      auditCount: store.db
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workflow_id = ?")
        .get(id).count,
      status: target.git("status", "--short"),
    });
    const before = snapshot();
    assert.equal(
      category(() =>
        store.resumeImplementation({
          ...resumeInvocation.fixed_arguments,
          resume_context: "stale incompatible resume",
        }),
      ),
      "ERROR_PLAN_INVALID",
    );
    assert.equal(
      category(() =>
        store.expandScope({
          ...scopeInvocation.fixed_arguments,
          added_paths: ["ordinary-new.txt"],
          reason: "stale incompatible scope",
          user_authorization: "stale incompatible scope",
        }),
      ),
      "ERROR_PLAN_INVALID",
    );
    assert.deepEqual(snapshot(), before);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-backed blocked workflows preserve ordinary resume and scope recovery without a newer approval", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const resumable = blockedPlanWorkflow(store);
    const expandable = blockedPlanWorkflow(store);
    const resumeDecision: any = store.operatorDecisionGet(resumable.created.workflow_id);
    const scopeDecision: any = store.operatorDecisionGet(expandable.created.workflow_id);
    const resumeInvocation = resumeDecision.execution.primary.invocations[0];
    const scopeInvocation = scopeDecision.execution.parent_actions.find(
      (action: any) => action.action === "workflow_expand_scope",
    ).descriptor.invocations[0];

    const resumed = store.resumeImplementation({
      ...resumeInvocation.fixed_arguments,
      resume_context: "ordinary context recovery",
    });
    assert.equal(resumed.phase, "IMPLEMENTING");
    const expanded = store.expandScope({
      ...scopeInvocation.fixed_arguments,
      added_paths: ["ordinary-new.txt"],
      reason: "ordinary scope expansion",
      user_authorization: "ordinary scope authorization",
    });
    assert.equal(expanded.phase, "STOPPED_IMPLEMENTATION_BLOCKED");
    assert.ok(expanded.approved_paths.includes("ordinary-new.txt"));
    assert.ok(
      store.parentGet(expandable.created.workflow_id).approved_paths.includes("ordinary-new.txt"),
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("blocked implementation rebinds atomically to the exact current approved plan revision", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate({
      ...revisionInput(),
      full_plan: "revision one plan",
      execution_brief: "revision one brief",
      approved_paths: ["note.txt", "partial-new.txt"],
    });
    store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve revision one",
    });
    const created = store.createFromPlan({
      plan_id: draft.plan_id,
      revision: draft.revision,
      work_items: [
        {
          provider: "github",
          id: "159",
          display_ref: "#159",
          url: "https://github.com/example/repository/issues/159",
        },
      ],
    });
    const id = created.workflow_id;

    writeFileSync(join(target.root, "note.txt"), "staged partial\n");
    target.git("add", "note.txt");
    writeFileSync(join(target.root, "note.txt"), "staged partial\nunstaged partial\n");
    writeFileSync(join(target.root, "partial-new.txt"), "untracked partial\n");
    const blocked = store.submitImplementation({
      workflow_id: id,
      expected_version: 0,
      status: "BLOCKED",
      summary: "revision one cannot complete",
      agent_touched_paths: ["note.txt", "partial-new.txt"],
      acceptance_results: [
        { criterion_id: "AC-001", status: "not_satisfied", evidence: "blocked" },
      ],
      validation_results: [{ validation_id: "VAL-001", status: "not_run", evidence: "blocked" }],
      known_failures: ["the original requirement is infeasible"],
      finding_resolution_map: {},
    });
    assert.equal(blocked.phase, "STOPPED_IMPLEMENTATION_BLOCKED");
    const beforeStatus = target.git("status", "--short");
    const beforeStaged = target.git("diff", "--cached", "--", "note.txt");
    const beforeUnstaged = target.git("diff", "--", "note.txt");
    const beforeUntracked = readFileSync(join(target.root, "partial-new.txt"), "utf8");
    const beforeState = JSON.parse(
      store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(id).state_json,
    );

    const revisedDraft = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: {
        full_plan: "revision two corrected plan",
        execution_brief: "revision two brief",
        objective: "revised achievable objective",
        approved_paths: ["note.txt", "partial-new.txt", "recovery-new.txt"],
        acceptance_criteria: ["the revised outcome is complete", "partial work is preserved"],
        validation_requirements: [
          {
            description: "exact workflow suite",
            kind: "command",
            argv: ["bun", "run", "test:workflow-mcp"],
          },
          { description: "manual revised inspection", kind: "inspection" },
        ],
      },
    });
    assert.equal(revisedDraft.revision, 2);
    const draftDecision = store.operatorDecisionGet(id);
    assert.deepEqual(draftDecision.primary, {
      kind: "approve_recovery",
      recovery: "resume_implementation",
      authorization_required: true,
    });

    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: revisedDraft.revision,
      user_authorization: "approve revision two",
    });
    const decision = store.operatorDecisionGet(id);
    assert.deepEqual(decision.primary, {
      kind: "approve_recovery",
      recovery: "rebind_implementation_plan",
      authorization_required: true,
    });
    assert.equal(decision.execution.primary.mode, "parent_mutation");
    if (decision.execution.primary.mode !== "parent_mutation") {
      throw new Error("expected plan rebind descriptor");
    }
    const invocation = decision.execution.primary.invocations[0];
    assert.deepEqual(invocation, {
      operation: "workflow_rebind_implementation_plan",
      semantic_choice: {
        id: "adopt_approved_plan_revision",
        label: "Rebind to the approved plan revision",
        summary:
          "Replace stale plan authority with the exact current approved revision and resume implementation.",
      },
      fixed_arguments: {
        workflow_id: id,
        expected_version: 1,
        plan_id: draft.plan_id,
        revision: 2,
      },
      required_inputs: [],
      authorization: {
        required: true,
        representation: { kind: "field", path: ["user_authorization"] },
        binding: { kind: "all", paths: [["plan_id"], ["revision"]] },
      },
      plan_binding: {
        plan_id: draft.plan_id,
        revision: 2,
        source: "approved_recovery_plan_context",
      },
      stale_binding: {
        workflow_id: id,
        expected_version: 1,
        references: [{ kind: "plan", plan_id: draft.plan_id, revision: 2 }],
      },
      on_success: {
        kind: "refresh_required",
        expected: ["implement", "wait"],
        dispatch_authority: false,
      },
    });

    writeFileSync(join(target.root, "note.txt"), "drifted after block\n");
    assert.equal(
      category(() =>
        store.rebindImplementationPlan({
          ...invocation.fixed_arguments,
          user_authorization: "authorize exact revision two recovery",
        }),
      ),
      "ERROR_STALE_RECEIPT",
    );
    writeFileSync(join(target.root, "note.txt"), "staged partial\nunstaged partial\n");
    writeFileSync(join(target.root, "recovery-new.txt"), "dirty candidate\n");
    assert.equal(
      category(() =>
        store.rebindImplementationPlan({
          ...invocation.fixed_arguments,
          user_authorization: "authorize exact revision two recovery",
        }),
      ),
      "ERROR_SCOPE_EXPANSION_DIRTY",
    );
    rmSync(join(target.root, "recovery-new.txt"));
    assert.equal(store.parentGet(id).version, 1);
    assert.equal(store.audit(id).length, 2);

    const authorization = "authorize exact revision two recovery";
    const rebound = store.rebindImplementationPlan({
      ...invocation.fixed_arguments,
      user_authorization: authorization,
    });
    assert.equal(rebound.workflow_id, id);
    assert.equal(rebound.phase, "IMPLEMENTING");
    assert.equal(rebound.base_head, created.base_head);
    assert.equal(rebound.objective, "revised achievable objective");
    assert.equal(rebound.approved_plan, "revision two corrected plan");
    assert.equal(rebound.execution_brief, "revision two brief");
    assert.deepEqual(rebound.approved_paths, ["note.txt", "partial-new.txt", "recovery-new.txt"]);
    assert.equal(rebound.plan_provenance?.revision, 2);
    assert.equal(rebound.plan_provenance?.artifact_digest, approved.artifact_digest);
    assert.equal(rebound.scope_expansions.at(-1)?.reason, "approved revised plan scope");
    assert.deepEqual(rebound.scope_expansions.at(-1)?.added_paths, ["recovery-new.txt"]);
    assert.equal(rebound.scope_expansions.at(-1)?.user_authorization, authorization);
    assert.equal(rebound.approved_path_baselines.at(-1)?.path, "recovery-new.txt");
    assert.equal(rebound.approved_path_baselines.at(-1)?.baseline.state, "absent");
    assert.equal(rebound.implementation_summary, null);
    assert.equal(rebound.implementation_status, null);
    assert.deepEqual(rebound.implementation_known_failures, []);
    assert.deepEqual(rebound.agent_touched_paths, []);
    assert.deepEqual(rebound.acceptance_results, []);
    assert.deepEqual(rebound.validation_results, []);
    assert.deepEqual(rebound.finding_resolution_map, {});
    assert.equal(rebound.repair_cycle, 0);
    assert.equal(rebound.stop_context, null);
    assert.equal(
      rebound.recovery_context?.context,
      "Implementation resumed after rebinding to approved PlanArtifact revision 2.",
    );
    assert.equal(rebound.recovery_context?.context.includes(authorization), false);
    assert.equal(rebound.recovery_context?.context.includes(draft.plan_id), false);
    assert.deepEqual(rebound.permitted_next_actions, ["workflow_expand_scope"]);
    assert.deepEqual(store.implementerGet(id).permitted_next_actions, [
      "workflow_submit_implementation",
    ]);

    assert.equal(target.git("status", "--short"), beforeStatus);
    assert.equal(target.git("diff", "--cached", "--", "note.txt"), beforeStaged);
    assert.equal(target.git("diff", "--", "note.txt"), beforeUnstaged);
    assert.equal(readFileSync(join(target.root, "partial-new.txt"), "utf8"), beforeUntracked);

    const persisted = JSON.parse(
      store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(id).state_json,
    );
    assert.deepEqual(persisted.initial_receipt, beforeState.initial_receipt);
    assert.deepEqual(persisted.work_items, beforeState.work_items);
    assert.equal(persisted.implementation_receipt, null);
    assert.equal(JSON.stringify(persisted).split(authorization).length - 1, 1);
    const audit = store.audit(id).at(-1);
    assert.equal(audit?.event_type, "IMPLEMENTATION_PLAN_REBOUND");
    assert.deepEqual(audit?.plan_rebind, {
      prior_plan_provenance: beforeState.plan_provenance,
      replacement_plan_provenance: rebound.plan_provenance,
      added_paths: ["recovery-new.txt"],
      user_authorization: authorization,
      rebound_at: rebound.recovery_context?.recovered_at,
    });
    assert.deepEqual(audit?.scope_expansion?.expansion, rebound.scope_expansions.at(-1));
    assert.equal(decision.recovery_summary.recovery_context, null);
    assert.equal(
      store.operatorDecisionGet(id).recovery_summary.recovery_context,
      "Implementation resumed after rebinding to approved PlanArtifact revision 2.",
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan rebind preserves prior scope history and appends baselines only for new paths", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve initial scope-history plan",
    });
    const created = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
    const id = created.workflow_id;
    const expanded = store.expandScope({
      workflow_id: id,
      expected_version: 0,
      added_paths: ["expanded.txt"],
      reason: "authorize pre-rebind expansion",
      user_authorization: "authorize expanded path",
    });
    store.submitImplementation({
      workflow_id: id,
      expected_version: expanded.version,
      status: "BLOCKED",
      summary: "blocked after scope expansion",
      agent_touched_paths: [],
      acceptance_results: [
        { criterion_id: "AC-001", status: "not_satisfied", evidence: "blocked" },
      ],
      validation_results: [{ validation_id: "VAL-001", status: "not_run", evidence: "blocked" }],
      known_failures: ["blocked"],
      finding_resolution_map: {},
    });

    const absorbedDraft = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: {
        full_plan: "revision two absorbs existing expansion",
        approved_paths: ["note.txt", "expanded.txt"],
      },
    });
    store.planApprove({
      plan_id: draft.plan_id,
      revision: absorbedDraft.revision,
      user_authorization: "approve absorbed expansion",
    });
    const beforeAbsorbedRebind = store.parentGet(id);
    const priorExpansions = structuredClone(beforeAbsorbedRebind.scope_expansions);
    const priorBaselines = structuredClone(beforeAbsorbedRebind.approved_path_baselines);
    const absorbed = store.rebindImplementationPlan({
      workflow_id: id,
      expected_version: beforeAbsorbedRebind.version,
      plan_id: draft.plan_id,
      revision: absorbedDraft.revision,
      user_authorization: "authorize absorbed-scope rebind",
    });
    assert.deepEqual(absorbed.scope_expansions, priorExpansions);
    assert.deepEqual(absorbed.approved_path_baselines, priorBaselines);
    assert.deepEqual(absorbed.approved_paths, ["expanded.txt", "note.txt"]);
    assert.equal(store.parentGet(id).plan_provenance?.revision, absorbedDraft.revision);

    store.submitImplementation({
      workflow_id: id,
      expected_version: absorbed.version,
      status: "BLOCKED",
      summary: "blocked before adding one more authorized path",
      agent_touched_paths: [],
      acceptance_results: [
        { criterion_id: "AC-001", status: "not_satisfied", evidence: "blocked again" },
      ],
      validation_results: [
        { validation_id: "VAL-001", status: "not_run", evidence: "blocked again" },
      ],
      known_failures: ["blocked again"],
      finding_resolution_map: {},
    });
    const addedDraft = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: absorbedDraft.revision,
      replacements: {
        full_plan: "revision three adds one path",
        approved_paths: ["note.txt", "expanded.txt", "newly-authorized.txt"],
      },
    });
    store.planApprove({
      plan_id: draft.plan_id,
      revision: addedDraft.revision,
      user_authorization: "approve one new path",
    });
    const beforeAddedRebind = store.parentGet(id);
    const rebound = store.rebindImplementationPlan({
      workflow_id: id,
      expected_version: beforeAddedRebind.version,
      plan_id: draft.plan_id,
      revision: addedDraft.revision,
      user_authorization: "authorize one-path rebind",
    });

    assert.deepEqual(rebound.scope_expansions.slice(0, priorExpansions.length), priorExpansions);
    assert.deepEqual(
      rebound.approved_path_baselines.slice(0, priorBaselines.length),
      priorBaselines,
    );
    assert.equal(rebound.scope_expansions.length, priorExpansions.length + 1);
    assert.deepEqual(rebound.scope_expansions.at(-1)?.added_paths, ["newly-authorized.txt"]);
    assert.equal(rebound.approved_path_baselines.length, priorBaselines.length + 1);
    assert.equal(rebound.approved_path_baselines.at(-1)?.path, "newly-authorized.txt");
    assert.equal(
      rebound.approved_path_baselines.filter((baseline: any) => baseline.path === "expanded.txt")
        .length,
      1,
    );
    assert.deepEqual(rebound.approved_paths, ["expanded.txt", "newly-authorized.txt", "note.txt"]);
    assert.equal(store.parentGet(id).plan_provenance?.revision, addedDraft.revision);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("an incompatible newer approved plan revision fails blocked recovery closed", () => {
  const target = fixture();
  const store = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate({
      ...revisionInput(),
      approved_paths: ["note.txt", "retained.txt"],
    });
    store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve initial recovery plan",
    });
    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
    store.submitImplementation({
      workflow_id: workflow.workflow_id,
      expected_version: 0,
      status: "BLOCKED",
      summary: "blocked before incompatible revision",
      agent_touched_paths: [],
      acceptance_results: [
        { criterion_id: "AC-001", status: "not_satisfied", evidence: "blocked" },
      ],
      validation_results: [{ validation_id: "VAL-001", status: "not_run", evidence: "blocked" }],
      known_failures: ["blocked"],
      finding_resolution_map: {},
    });
    assert.equal(store.operatorDecisionGet(workflow.workflow_id).primary.kind, "approve_recovery");
    const contracted = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: { approved_paths: ["note.txt"] },
    });
    store.planApprove({
      plan_id: draft.plan_id,
      revision: contracted.revision,
      user_authorization: "approve incompatible contraction",
    });
    const decision = store.operatorDecisionGet(workflow.workflow_id);
    assert.deepEqual(decision.primary, {
      kind: "operator_intervention",
      reason: "no supported recovery is available",
    });
    assert.equal(decision.execution.primary.mode, "wait");
    assert.deepEqual(decision.execution.parent_actions, []);
    assert.deepEqual(store.parentGet(workflow.workflow_id).permitted_next_actions, []);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan creation preflights exact validation policy and preserves inspection contracts", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate({
      ...revisionInput(),
      validation_requirements: [
        { description: "manual inspection", kind: "inspection" },
        {
          description: "exact workflow suite",
          kind: "command",
          argv: ["bun", "run", "test:workflow-mcp"],
        },
      ],
    });
    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve exact validation contract",
    });
    const beforePlan = store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision });
    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
    assert.deepEqual(workflow.validation_requirements, [
      { validation_id: "VAL-001", description: "manual inspection", kind: "inspection" },
      {
        validation_id: "VAL-002",
        description: "exact workflow suite",
        kind: "command",
        argv: ["bun", "run", "test:workflow-mcp"],
      },
    ]);
    assert.deepEqual(workflow.plan_provenance, {
      plan_id: draft.plan_id,
      revision: draft.revision,
      artifact_digest: approved.artifact_digest,
      approved_at: approved.metadata.approval?.approved_at,
    });
    assert.deepEqual(
      store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision }),
      beforePlan,
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan creation rejects non-exact or evidence-only validation commands atomically", () => {
  const rejectedArgv = [
    ["bun", "run", "typecheck"],
    ["bun", "run", "test:workflow-mcp", "extra"],
    ["bun", "test:workflow-mcp", "run"],
    ["bun", "run", "test:workflow-mcpx"],
  ];
  for (const argv of rejectedArgv) {
    const target = fixture();
    const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
    try {
      const draft = store.planCreate({
        ...revisionInput(),
        validation_requirements: [{ description: "rejected command", kind: "command", argv }],
      });
      store.planApprove({
        plan_id: draft.plan_id,
        revision: draft.revision,
        user_authorization: "approve rejected command for preflight test",
      });
      const beforePlan = store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision });
      assert.equal(
        category(() => store.createFromPlan({ plan_id: draft.plan_id, revision: 1 })),
        "ERROR_PLAN_INVALID",
      );
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count, 0);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
      assert.deepEqual(
        store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision }),
        beforePlan,
      );
    } finally {
      store.close();
      disposeFixture(target.root);
    }
  }

  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve evidence-only policy test",
    });
    writeFileSync(
      join(target.root, ".codex", "reviewer-validation.json"),
      JSON.stringify({
        version: 1,
        commands: [
          {
            argv: ["bun", "run", "test:workflow-mcp"],
            purpose: "evidence",
            timeout_ms: 120000,
            max_output_bytes: 65536,
          },
        ],
      }),
    );
    const beforePlan = store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision });
    assert.equal(
      category(() => store.createFromPlan({ plan_id: draft.plan_id, revision: 1 })),
      "ERROR_PLAN_INVALID",
    );
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
    assert.deepEqual(
      store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision }),
      beforePlan,
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan creation fails closed for missing or malformed reviewer policy", () => {
  for (const malformed of [false, true]) {
    const target = fixture();
    const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
    try {
      const draft = store.planCreate(revisionInput());
      store.planApprove({
        plan_id: draft.plan_id,
        revision: draft.revision,
        user_authorization: "approve policy failure test",
      });
      const policyPath = join(target.root, ".codex", "reviewer-validation.json");
      if (malformed) writeFileSync(policyPath, "{ malformed policy");
      else rmSync(policyPath);
      const beforePlan = store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision });
      assert.equal(
        category(() => store.createFromPlan({ plan_id: draft.plan_id, revision: 1 })),
        "ERROR_PLAN_INVALID",
      );
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count, 0);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
      assert.deepEqual(
        store.planParentGet({ plan_id: draft.plan_id, revision: draft.revision }),
        beforePlan,
      );
    } finally {
      store.close();
      disposeFixture(target.root);
    }
  }
});

test("approved plan-authored review_only binds reviewer-first working-tree state", () => {
  const target = fixture();
  const store = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate({
      ...planInput("planned-review.txt"),
      workflow_type: "review_only",
    });
    assert.equal(draft.workflow_type, "review_only");
    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: draft.revision,
      user_authorization: "approve reviewer-first plan",
    });
    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: draft.revision });
    assert.equal(workflow.workflow_type, "review_only");
    assert.equal(workflow.phase, "REVIEWING");
    assert.deepEqual(workflow.review_target, {
      review_mode: "working_tree",
      base_revision: target.git("rev-parse", "HEAD"),
      head_revision: null,
      approved_paths: ["planned-review.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    });
    assert.equal(workflow.plan_provenance?.artifact_digest, approved.artifact_digest);
    assert.deepEqual(store.implementerGet(workflow.workflow_id).permitted_next_actions, []);
    assert.deepEqual(store.reviewerGet(workflow.workflow_id).permitted_next_actions, [
      "workflow_begin_review",
    ]);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("retained pre-change plan artifacts require reset and recreation", () => {
  const target = fixture();
  const databasePath = join(target.root, "pre-change-plan.sqlite");
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath });
  const draft = store.planCreate(revisionInput());
  const row = store.db
    .prepare("SELECT artifact_json FROM plan_revisions WHERE plan_id = ? AND revision = 1")
    .get(draft.plan_id) as { artifact_json: string };
  const artifact = JSON.parse(row.artifact_json) as Record<string, unknown>;
  delete artifact.workflow_type;
  artifact.plan_schema_version = 1;
  store.db
    .prepare("UPDATE plan_revisions SET artifact_json = ?, artifact_digest = ? WHERE plan_id = ?")
    .run(JSON.stringify(artifact), objectDigest(artifact), draft.plan_id);
  store.close();
  assert.equal(
    category(() => new WorkflowStore({ repositoryRoot: target.root, databasePath })),
    "ERROR_MIGRATION_REQUIRED",
  );
  rmSync(databasePath, { force: true });
  disposeFixture(target.root);
});

test("planner reads round-trip directly while parent reads retain persisted contract IDs", () => {
  const target = fixture();
  const store = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate({
      workflow_type: "review_only",
      full_plan: "round-trip plan",
      execution_brief: "round-trip brief",
      objective: "round-trip objective",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["first criterion", "second criterion"],
      validation_requirements: [
        { description: "manual inspection", kind: "inspection" },
        {
          description: "exact check",
          kind: "command",
          argv: ["bun", "run", "test:workflow-mcp"],
        },
      ],
    });
    const content = {
      full_plan: draft.full_plan,
      execution_brief: draft.execution_brief,
      objective: draft.objective,
      approved_paths: draft.approved_paths,
      acceptance_criteria: draft.acceptance_criteria,
      validation_requirements: draft.validation_requirements,
    };
    assert.equal("approval" in draft.metadata, false);
    const unchanged = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: content,
    });
    assert.equal(unchanged.revision, 1);
    assert.deepEqual(unchanged.acceptance_criteria, ["first criterion", "second criterion"]);
    assert.deepEqual(unchanged.validation_requirements, [
      { description: "manual inspection", kind: "inspection" },
      {
        description: "exact check",
        kind: "command",
        argv: ["bun", "run", "test:workflow-mcp"],
      },
    ]);

    const acceptanceEdit = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: unchanged.revision,
      replacements: {
        acceptance_criteria: [...unchanged.acceptance_criteria.slice(0, 1), "refined criterion"],
      },
    });
    assert.equal(acceptanceEdit.revision, 2);
    assert.equal(acceptanceEdit.plan_ref, draft.plan_ref);
    assert.deepEqual(acceptanceEdit.acceptance_criteria, ["first criterion", "refined criterion"]);

    const validationEdit = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: acceptanceEdit.revision,
      replacements: {
        validation_requirements: [
          ...acceptanceEdit.validation_requirements.slice(0, 1),
          {
            description: "refined exact check",
            kind: "command",
            argv: ["bun", "run", "test:workflow-mcp"],
          },
        ],
      },
    });
    assert.equal(validationEdit.revision, 3);

    const combined = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: validationEdit.revision,
      replacements: {
        acceptance_criteria: ["combined criterion"],
        validation_requirements: [{ description: "combined check", kind: "inspection" }],
      },
    });
    assert.equal(combined.revision, 4);
    assert.equal(combined.plan_ref, draft.plan_ref);

    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: combined.revision,
      user_authorization: "approve round-trip plan",
    });
    const parent = store.planParentGet({ plan_id: draft.plan_id, revision: combined.revision });
    assert.equal(parent.plan_ref, draft.plan_ref);
    assert.deepEqual(parent.acceptance_criteria, [
      { criterion_id: "AC-001", description: "combined criterion" },
    ]);
    assert.deepEqual(parent.validation_requirements, [
      { validation_id: "VAL-001", description: "combined check", kind: "inspection" },
    ]);
    assert.equal(parent.artifact_digest, approved.artifact_digest);
    assert.ok(parent.metadata.approval);

    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: combined.revision });
    assert.deepEqual(workflow.acceptance_criteria, parent.acceptance_criteria);
    assert.deepEqual(workflow.validation_requirements, parent.validation_requirements);
    assert.equal(
      category(() => store.planGet({ plan_id: draft.plan_ref, revision: combined.revision })),
      "ERROR_PLAN_INVALID",
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan revisions copy forward omitted fields and stale revisions fail closed", () => {
  const target = fixture();
  const store = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  const draft = store.planCreate(revisionInput());
  const revised = store.planRevise({
    plan_id: draft.plan_id,
    base_revision: 1,
    replacements: { full_plan: "replacement plan" },
  });
  assert.equal(revised.revision, 2);
  assert.equal(revised.execution_brief, revisionInput().execution_brief);
  assert.equal(revised.objective, revisionInput().objective);
  assert.deepEqual(revised.approved_paths, ["note.txt"]);
  assert.deepEqual(revised.acceptance_criteria, ["the plan is preserved"]);
  assert.deepEqual(revised.validation_requirements, [
    {
      description: "bun run test:workflow-mcp",
      kind: "command",
      argv: ["bun", "run", "test:workflow-mcp"],
    },
  ]);
  assert.equal(
    store.planGet({ plan_id: draft.plan_id, revision: 1 }).full_plan,
    revisionInput().full_plan,
  );
  assert.equal(
    category(() =>
      store.planApprove({ plan_id: draft.plan_id, revision: 1, user_authorization: "stale" }),
    ),
    "ERROR_PLAN_STALE",
  );
  assert.equal(
    category(() =>
      store.planRevise({
        plan_id: draft.plan_id,
        base_revision: 1,
        replacements: { full_plan: revisionInput().full_plan },
      }),
    ),
    "ERROR_VERSION_CONFLICT",
  );
  assert.equal(
    category(() => store.createFromPlan({ plan_id: draft.plan_id, revision: 2 })),
    "ERROR_PLAN_UNAPPROVED",
  );
  store.close();
  disposeFixture(target.root);
});

test("bounded revisions replace arrays wholesale and reject invalid envelopes atomically", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    const revised = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: 1,
      replacements: {
        full_plan: "all fields",
        execution_brief: "all fields brief",
        objective: "all fields objective",
        approved_paths: ["z.txt", "a.txt"],
        acceptance_criteria: ["first", "second"],
        validation_requirements: [
          {
            description: "executable",
            kind: "command",
            argv: ["bun", "run", "test:workflow-mcp"],
          },
        ],
      },
    });
    assert.deepEqual(revised.approved_paths, ["a.txt", "z.txt"]);
    assert.deepEqual(revised.acceptance_criteria, ["first", "second"]);
    assert.deepEqual(revised.validation_requirements, [
      {
        description: "executable",
        kind: "command",
        argv: ["bun", "run", "test:workflow-mcp"],
      },
    ]);

    const before = store.db
      .prepare("SELECT current_revision FROM plans WHERE plan_id = ?")
      .get(draft.plan_id).current_revision;
    const invalidReplacements: Array<[Record<string, unknown>, string]> = [
      [{ unknown: "value" }, "ERROR_INVALID_SHAPE"],
      [{}, "ERROR_INVALID_SHAPE"],
      [{ full_plan: null }, "ERROR_INVALID_SHAPE"],
      [{ objective: undefined }, "ERROR_INVALID_SHAPE"],
      [{ approved_paths: [] }, "ERROR_INVALID_PATHS"],
      [{ validation_requirements: [] }, "ERROR_INVALID_SHAPE"],
      [{ validation_requirements: ["legacy string requirement"] }, "ERROR_INVALID_SHAPE"],
      [
        { validation_requirements: [{ description: "legacy null requirement", argv: null }] },
        "ERROR_INVALID_SHAPE",
      ],
      [
        { validation_requirements: [{ description: "bad argv", kind: "command", argv: [] }] },
        "ERROR_INVALID_SHAPE",
      ],
    ];
    for (const [replacements, expectedCategory] of invalidReplacements) {
      assert.equal(
        category(() =>
          store.planRevise({
            plan_id: draft.plan_id,
            base_revision: before,
            replacements,
          }),
        ),
        expectedCategory,
      );
      assert.equal(
        store.db.prepare("SELECT current_revision FROM plans WHERE plan_id = ?").get(draft.plan_id)
          .current_revision,
        before,
      );
    }
    const corrected = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: before,
      replacements: { full_plan: "corrected" },
    });
    assert.equal(corrected.revision, before + 1);
    assert.equal(corrected.execution_brief, revised.execution_brief);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("identical current plan revisions are persisted no-ops", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    const beforePlan = store.db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(draft.plan_id);
    const beforeRevision = store.db
      .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = 1")
      .get(draft.plan_id);
    const beforeRevisionCount = store.db
      .prepare("SELECT COUNT(*) AS count FROM plan_revisions WHERE plan_id = ?")
      .get(draft.plan_id).count;

    const unchanged = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: 1,
      replacements: { full_plan: revisionInput().full_plan },
    });

    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.metadata.current_revision, 1);
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM plan_revisions WHERE plan_id = ?")
        .get(draft.plan_id).count,
      beforeRevisionCount,
    );
    assert.deepEqual(
      store.db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(draft.plan_id),
      beforePlan,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = 1")
        .get(draft.plan_id),
      beforeRevision,
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("identical approved current revisions preserve approval and plan provenance", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: 1,
      user_authorization: "approve exact revision",
    });
    const beforePlan = store.db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(draft.plan_id);
    const beforeRevision = store.db
      .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = 1")
      .get(draft.plan_id);
    const beforeApproval = store.db
      .prepare("SELECT * FROM plan_approvals WHERE plan_id = ? AND revision = 1")
      .get(draft.plan_id);

    const unchanged = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: 1,
      replacements: { full_plan: revisionInput().full_plan },
    });

    assert.equal(unchanged.revision, 1);
    assert.equal(unchanged.metadata.status, "approved");
    assert.equal("approval" in unchanged.metadata, false);
    assert.deepEqual(
      store.planParentGet({ plan_id: draft.plan_id, revision: 1 }).metadata.approval,
      approved.metadata.approval,
    );
    assert.deepEqual(
      store.db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(draft.plan_id),
      beforePlan,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = 1")
        .get(draft.plan_id),
      beforeRevision,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM plan_approvals WHERE plan_id = ? AND revision = 1")
        .get(draft.plan_id),
      beforeApproval,
    );
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM plan_revisions WHERE plan_id = ?")
        .get(draft.plan_id).count,
      1,
    );

    const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: 1 });
    assert.deepEqual(workflow.plan_provenance, {
      plan_id: draft.plan_id,
      revision: 1,
      artifact_digest: approved.artifact_digest,
      approved_at: approved.metadata.approval?.approved_at,
    });
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("material revisions advance once and identical stale revisions fail without mutation", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const draft = store.planCreate(revisionInput());
    store.planApprove({
      plan_id: draft.plan_id,
      revision: 1,
      user_authorization: "approve exact revision",
    });
    const revised = store.planRevise({
      plan_id: draft.plan_id,
      base_revision: 1,
      replacements: { full_plan: "replacement plan" },
    });
    assert.equal(revised.revision, 2);
    assert.equal(revised.metadata.current_revision, 2);
    assert.equal(revised.metadata.status, "draft");
    assert.equal(
      store.db
        .prepare("SELECT COUNT(*) AS count FROM plan_revisions WHERE plan_id = ?")
        .get(draft.plan_id).count,
      2,
    );
    assert.equal(
      store.planParentGet({ plan_id: draft.plan_id, revision: 1 }).metadata.status,
      "approved",
    );
    assert.equal(
      store.planParentGet({ plan_id: draft.plan_id, revision: 2 }).metadata.approval,
      null,
    );

    const beforePlanRows = store.db
      .prepare("SELECT * FROM plans WHERE plan_id = ?")
      .all(draft.plan_id);
    const beforeRevisionRows = store.db
      .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision")
      .all(draft.plan_id);
    const beforeApprovalRows = store.db
      .prepare("SELECT * FROM plan_approvals WHERE plan_id = ? ORDER BY revision")
      .all(draft.plan_id);
    assert.equal(
      category(() =>
        store.planRevise({
          plan_id: draft.plan_id,
          base_revision: 1,
          replacements: { full_plan: "replacement plan" },
        }),
      ),
      "ERROR_VERSION_CONFLICT",
    );
    assert.deepEqual(
      store.db.prepare("SELECT * FROM plans WHERE plan_id = ?").all(draft.plan_id),
      beforePlanRows,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision")
        .all(draft.plan_id),
      beforeRevisionRows,
    );
    assert.deepEqual(
      store.db
        .prepare("SELECT * FROM plan_approvals WHERE plan_id = ? ORDER BY revision")
        .all(draft.plan_id),
      beforeApprovalRows,
    );
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-native linked follow-up binds only the exact current approved child artifact", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const { id, optional } = approvedSource(store, target.git);
    const draft = store.planCreate(planInput());
    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: 1,
      user_authorization: "approve child remediation plan",
    });
    const decision = store.operatorDecisionGet(id, undefined, draft.plan_id, 1);
    const planFollowup = decision.execution.parent_actions.find(
      (action: any) => action.action === "workflow_create_linked_followup_from_plan",
    );
    assert.ok(planFollowup && planFollowup.status === "executable");
    if (planFollowup?.status !== "executable")
      throw new Error("expected descriptor-bound approved child plan follow-up");
    const invocation = planFollowup.descriptor.invocations[0];
    assert.deepEqual(invocation?.fixed_arguments, {
      workflow_id: id,
      expected_version: 3,
      plan_id: draft.plan_id,
      revision: 1,
    });
    assert.deepEqual(invocation?.plan_binding, {
      plan_id: draft.plan_id,
      revision: 1,
      source: "approved_child_plan_context",
    });
    assert.deepEqual(invocation?.authorization.binding, {
      kind: "all",
      paths: [["plan_id"], ["revision"], ["finding_ids"]],
    });
    assert.deepEqual(invocation?.linked_followup_binding, {
      selection_rule: "nonempty_subset_from_one_bucket",
      blocking_findings: [],
      optional_findings: [
        {
          finding_id: optional.finding_id,
          severity: optional.severity,
          summary: optional.impact,
        },
      ],
    });
    const currentFindingIds = invocation?.linked_followup_binding.optional_findings.map(
      (finding: any) => finding.finding_id,
    );
    assert.deepEqual(currentFindingIds, [optional.finding_id]);
    assert.equal(store.parentGet(id).plan_provenance, null);
    const child = store.createLinkedFollowupFromPlan({
      ...invocation?.fixed_arguments,
      finding_ids: currentFindingIds,
      user_authorization: "authorize exact child plan remediation",
    });
    const childView = store.parentGet(child.workflow_id);
    assert.equal("workflow" in child, false);
    assert.equal(childView.objective, planInput().objective);
    assert.equal(childView.approved_plan, planInput().full_plan);
    assert.equal(childView.execution_brief, planInput().execution_brief);
    assert.deepEqual(childView.approved_paths, ["planned.txt"]);
    assert.deepEqual(childView.acceptance_criteria, [
      { criterion_id: "AC-001", description: "authoritative child criterion" },
    ]);
    assert.deepEqual(childView.validation_requirements, [
      {
        validation_id: "VAL-001",
        description: "authoritative child validation",
        kind: "command",
        argv: ["bun", "run", "test:workflow-mcp"],
      },
    ]);
    assert.deepEqual(childView.plan_provenance, {
      plan_id: draft.plan_id,
      revision: 1,
      artifact_digest: approved.artifact_digest,
      approved_at: approved.metadata.approval?.approved_at,
    });
    assert.deepEqual(childView.linked_findings, [optional]);
    assert.equal(childView.repair_cycle, 0);
    assert.equal(childView.remediation_context.authorized_finding_ids[0], optional.finding_id);
    assert.equal(store.parentGet(id).superseded_by_workflow_id, child.workflow_id);

    store.submitImplementation({
      workflow_id: child.workflow_id,
      expected_version: 0,
      status: "DONE",
      summary: "completed plan-backed linked remediation",
      agent_touched_paths: ["planned.txt"],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "remediated" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      known_failures: [],
      finding_resolution_map: { [optional.finding_id]: "resolved" },
    });
    writeFileSync(join(target.root, "planned.txt"), "linked remediation\n");
    store.beginReview({ workflow_id: child.workflow_id, expected_version: 1 });
    const remediationApproved = store.submitReview({
      workflow_id: child.workflow_id,
      expected_version: 2,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: { [optional.finding_id]: "resolved" },
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "reviewed" }],
    });
    assert.equal(remediationApproved.phase, "REVIEWING");
    const combined = store.parentGet(child.workflow_id);
    assert.equal(combined.linked_continuation.review_stage, "combined");
    assert.deepEqual(
      combined.review_target.approved_paths,
      combined.linked_continuation.combined_review_paths,
    );
    assert.ok(combined.review_target.approved_paths.includes("planned.txt"));
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("direct linked follow-up from a plan-backed source remains null-plan", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const sourcePlan = store.planCreate({
      ...revisionInput(),
      objective: "source PlanArtifact objective",
      full_plan: "stale source plan that must not reach a direct child",
    });
    store.planApprove({
      plan_id: sourcePlan.plan_id,
      revision: 1,
      user_authorization: "approve exact source plan",
    });
    const source = store.createFromPlan({ plan_id: sourcePlan.plan_id, revision: 1 });
    const sourceId = source.workflow_id;
    store.submitImplementation({
      workflow_id: sourceId,
      expected_version: 0,
      status: "DONE",
      summary: "source implementation",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "done" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "done" }],
      known_failures: [],
      finding_resolution_map: {},
    });
    writeFileSync(join(target.root, "note.txt"), "source change\n");
    store.beginReview({ workflow_id: sourceId, expected_version: 1 });
    const optional = {
      finding_id: "DIRECT-FOLLOWUP-OPTIONAL",
      severity: "P3",
      blocking: false,
      file_and_line: "note.txt:1",
      failure_scenario: "scenario",
      impact: "impact",
      violated_requirement: "requirement",
      remediation: "remediation",
      missing_or_inadequate_test: "test",
    };
    store.submitReview({
      workflow_id: sourceId,
      expected_version: 2,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [optional],
      prior_finding_classifications: {},
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "reviewed" }],
    });

    const sourceView = store.parentGet(sourceId);
    assert.equal(sourceView.approved_plan, "stale source plan that must not reach a direct child");
    assert.ok(sourceView.plan_provenance);
    const decision = store.operatorDecisionGet(sourceId);
    const direct = decision.execution.parent_actions.find(
      (action: any) => action.action === "workflow_create_linked_followup",
    );
    assert.ok(direct && direct.status === "executable");
    if (direct?.status !== "executable") throw new Error("expected direct follow-up");
    const invocation = direct.descriptor.invocations[0];
    assert.equal(
      invocation?.required_inputs.some((item: any) => item.path.join(".") === "approved_plan"),
      false,
    );
    assert.equal(invocation?.fixed_arguments.approved_plan, null);

    const childInputs = {
      ...invocation?.fixed_arguments,
      objective: "directly authored remediation",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["address the selected finding"],
      validation_requirements: [
        { description: "verify remediation", kind: "command", argv: ["bun", "run", "check"] },
      ],
      finding_ids: [optional.finding_id],
      user_authorization: "authorize directly authored remediation",
    };
    assert.equal(
      category(() =>
        store.createLinkedFollowup({ ...childInputs, approved_plan: sourceView.approved_plan }),
      ),
      "ERROR_INVALID_FOLLOWUP",
    );
    assert.equal(store.parentGet(sourceId).version, 3);

    const child = store.createLinkedFollowup(childInputs);
    const childView = store.parentGet(child.workflow_id);
    assert.equal(childView.objective, "directly authored remediation");
    assert.equal(childView.approved_plan, null);
    assert.equal(childView.execution_brief, null);
    assert.equal(childView.plan_provenance, null);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-native linked follow-up rejects unauthorized validation requirements atomically", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const { id, optional } = approvedSource(store, target.git);
    const draft = store.planCreate({
      ...planInput(),
      validation_requirements: [
        {
          description: "unauthorized child validation",
          kind: "command",
          argv: ["bun", "run", "typecheck"],
        },
      ],
    });
    store.planApprove({
      plan_id: draft.plan_id,
      revision: 1,
      user_authorization: "approve unauthorized child validation for preflight test",
    });
    const beforeVersion = store.parentGet(id).version;
    const beforeSourceRow = store.db
      .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(id);
    const beforeSourceAudit = store.audit(id);
    const beforeWorkflowCount = store.db
      .prepare("SELECT COUNT(*) AS count FROM workflows")
      .get().count;
    const beforeAuditCount = store.db
      .prepare("SELECT COUNT(*) AS count FROM audit_events")
      .get().count;
    const beforePlan = store.planParentGet({ plan_id: draft.plan_id, revision: 1 });

    assert.equal(
      category(() =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          expected_version: beforeVersion,
          plan_id: draft.plan_id,
          revision: 1,
          finding_ids: [optional.finding_id],
          user_authorization: "authorize child plan preflight test",
        }),
      ),
      "ERROR_PLAN_INVALID",
    );
    assert.equal(store.parentGet(id).version, beforeVersion);
    assert.deepEqual(
      store.db
        .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(id),
      beforeSourceRow,
    );
    assert.deepEqual(store.audit(id), beforeSourceAudit);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count,
      beforeWorkflowCount,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
      beforeAuditCount,
    );
    assert.deepEqual(store.planParentGet({ plan_id: draft.plan_id, revision: 1 }), beforePlan);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-native linked follow-up rejects raw artifact fields and fails atomically", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const { id, optional } = approvedSource(store, target.git);
    const draft = store.planCreate(planInput());
    const beforeVersion = store.parentGet(id).version;
    const beforeAudit = store.audit(id).length;
    assert.equal(
      category(() =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          expected_version: beforeVersion,
          plan_id: draft.plan_id,
          revision: 1,
          finding_ids: [optional.finding_id],
          user_authorization: "authorized",
          full_plan: "model supplied plan",
        }),
      ),
      "ERROR_INVALID_SHAPE",
    );
    assert.equal(store.parentGet(id).version, beforeVersion);
    assert.equal(store.audit(id).length, beforeAudit);
    assert.equal(
      category(() =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          expected_version: beforeVersion,
          plan_id: "00000000-0000-4000-8000-000000000000",
          revision: 1,
          finding_ids: [optional.finding_id],
          user_authorization: "authorized",
        }),
      ),
      "ERROR_PLAN_NOT_FOUND",
    );
    assert.equal(store.parentGet(id).version, beforeVersion);
    assert.equal(store.audit(id).length, beforeAudit);
    assert.equal(
      category(() =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          expected_version: beforeVersion,
          plan_id: draft.plan_id,
          revision: 1,
          finding_ids: [optional.finding_id],
          user_authorization: "authorized",
        }),
      ),
      "ERROR_PLAN_UNAPPROVED",
    );
    assert.equal(store.parentGet(id).version, beforeVersion);
    assert.equal(store.audit(id).length, beforeAudit);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-native linked follow-up rolls back child and source succession after injection", () => {
  const target = fixture();
  const store: any = new WorkflowStore({
    repositoryRoot: target.root,
    databasePath: ":memory:",
    faultAfterLinkedChildInsert: true,
  });
  try {
    const { id, optional } = approvedSource(store, target.git);
    const draft = store.planCreate(planInput());
    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: 1,
      user_authorization: "approve child remediation plan",
    });
    const beforeVersion = store.parentGet(id).version;
    const beforeSourceRow = store.db
      .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(id);
    const beforeSourceAudit = store.audit(id);
    const beforeWorkflowCount = store.db
      .prepare("SELECT COUNT(*) AS count FROM workflows")
      .get().count;
    const beforeAuditCount = store.db
      .prepare("SELECT COUNT(*) AS count FROM audit_events")
      .get().count;
    const beforeAuditRows = store.db
      .prepare(
        "SELECT event_id, workflow_id, version, event_type, actor_role, summary_json FROM audit_events ORDER BY event_id",
      )
      .all();

    assert.throws(
      () =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          expected_version: beforeVersion,
          plan_id: draft.plan_id,
          revision: 1,
          finding_ids: [optional.finding_id],
          user_authorization: "authorize exact child plan remediation",
        }),
      (error: any) => error instanceof WorkflowError && error.category === "ERROR_INJECTED_FAILURE",
    );

    assert.equal(store.parentGet(id).version, beforeVersion);
    assert.deepEqual(
      store.db
        .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(id),
      beforeSourceRow,
    );
    assert.deepEqual(store.audit(id), beforeSourceAudit);
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count,
      beforeWorkflowCount,
    );
    assert.equal(
      store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count,
      beforeAuditCount,
    );
    assert.deepEqual(
      store.db
        .prepare(
          "SELECT event_id, workflow_id, version, event_type, actor_role, summary_json FROM audit_events ORDER BY event_id",
        )
        .all(),
      beforeAuditRows,
    );
    assert.equal(approved.artifact_digest, draft.artifact_digest);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("malformed persisted plan artifacts fail closed as state corruption", () => {
  const corruptions: Array<(artifact: Record<string, unknown>) => void> = [
    (artifact) => {
      artifact.acceptance_criteria = null;
    },
    (artifact) => {
      artifact.validation_requirements = [null];
    },
    (artifact) => {
      artifact.acceptance_criteria = [{}];
    },
  ];

  for (const corrupt of corruptions) {
    const target = fixture();
    const databasePath = join(target.root, "corrupt-planning.sqlite");
    const store: any = new WorkflowStore({
      repositoryRoot: target.root,
      databasePath,
    });
    const draft = store.planCreate(revisionInput());
    const row = store.db
      .prepare("SELECT artifact_json FROM plan_revisions WHERE plan_id = ? AND revision = 1")
      .get(draft.plan_id) as { artifact_json: string };
    const artifact = JSON.parse(row.artifact_json) as Record<string, unknown>;
    corrupt(artifact);
    store.db
      .prepare("UPDATE plan_revisions SET artifact_json = ? WHERE plan_id = ? AND revision = 1")
      .run(JSON.stringify(artifact), draft.plan_id);
    store.close();
    assert.equal(
      category(() => new WorkflowStore({ repositoryRoot: target.root, databasePath })),
      "ERROR_STATE_CORRUPT",
    );
    rmSync(databasePath, { force: true });
    disposeFixture(target.root);
  }

  const target = fixture();
  const databasePath = join(target.root, "corrupt-planning-digest.sqlite");
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath });
  const draft = store.planCreate(revisionInput());
  store.db
    .prepare("UPDATE plan_revisions SET artifact_digest = ? WHERE plan_id = ? AND revision = 1")
    .run("0".repeat(64), draft.plan_id);
  store.close();
  assert.equal(
    category(() => new WorkflowStore({ repositoryRoot: target.root, databasePath })),
    "ERROR_STATE_CORRUPT",
  );
  rmSync(databasePath, { force: true });
  disposeFixture(target.root);

  const aggregateTarget = fixture();
  const aggregateDatabasePath = join(aggregateTarget.root, "corrupt-planning-aggregate.sqlite");
  const aggregateStore: any = new WorkflowStore({
    repositoryRoot: aggregateTarget.root,
    databasePath: aggregateDatabasePath,
  });
  const aggregateDraft = aggregateStore.planCreate(revisionInput());
  aggregateStore.db
    .prepare("UPDATE plans SET current_revision = 0 WHERE plan_id = ?")
    .run(aggregateDraft.plan_id);
  assert.equal(
    category(() => aggregateStore.planGet({ plan_id: aggregateDraft.plan_id, revision: 1 })),
    "ERROR_STATE_CORRUPT",
  );
  aggregateStore.close();
  assert.equal(
    category(
      () =>
        new WorkflowStore({
          repositoryRoot: aggregateTarget.root,
          databasePath: aggregateDatabasePath,
        }),
    ),
    "ERROR_STATE_CORRUPT",
  );
  rmSync(aggregateDatabasePath, { force: true });
  disposeFixture(aggregateTarget.root);

  const approvalTarget = fixture();
  const approvalDatabasePath = join(approvalTarget.root, "corrupt-planning-approval.sqlite");
  const approvalStore: any = new WorkflowStore({
    repositoryRoot: approvalTarget.root,
    databasePath: approvalDatabasePath,
  });
  const approvalDraft = approvalStore.planCreate(revisionInput());
  approvalStore.planApprove({
    plan_id: approvalDraft.plan_id,
    revision: 1,
    user_authorization: "approve exact revision",
  });
  approvalStore.db
    .prepare("UPDATE plan_approvals SET user_authorization = '' WHERE plan_id = ? AND revision = 1")
    .run(approvalDraft.plan_id);
  assert.equal(
    category(() => approvalStore.planParentGet({ plan_id: approvalDraft.plan_id, revision: 1 })),
    "ERROR_STATE_CORRUPT",
  );
  approvalStore.close();
  assert.equal(
    category(
      () =>
        new WorkflowStore({
          repositoryRoot: approvalTarget.root,
          databasePath: approvalDatabasePath,
        }),
    ),
    "ERROR_STATE_CORRUPT",
  );
  rmSync(approvalDatabasePath, { force: true });
  disposeFixture(approvalTarget.root);
});
