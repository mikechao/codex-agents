import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { WorkflowStore } from "../store.js";
import { disposeFixture, fixture } from "./test-fixtures.js";

function revisionInput() {
  return {
    full_plan: "step one\nstep two\nfinal step",
    execution_brief: "Run the bounded serial implementation.",
    objective: "planning foundation",
    approved_paths: ["note.txt"],
    acceptance_criteria: ["the plan is preserved"],
    validation_requirements: ["bun run check"],
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

function sourceInput(git: (...args: string[]) => string) {
  const approvedPaths = ["note.txt"];
  return {
    workflow_type: "change",
    objective: "source workflow",
    approved_plan: null,
    approved_paths: approvedPaths,
    acceptance_criteria: ["source criterion"],
    validation_requirements: [{ description: "source validation", argv: ["bun", "run", "check"] }],
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
  const id = source.workflow.workflow_id;
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
      { description: "authoritative child validation", argv: ["bun", "run", "check"] },
    ],
  };
}

test("plans preserve exact revisions, approval, and workflow provenance", () => {
  const target = fixture();
  const databasePath = join(target.root, "planning.sqlite");
  const store = new WorkflowStore({ repositoryRoot: target.root, databasePath });
  const draft = store.planCreate(revisionInput());
  assert.equal(draft.metadata.status, "draft");
  assert.equal(draft.full_plan, revisionInput().full_plan);
  const approved = store.planApprove({
    plan_id: draft.plan_id,
    revision: 1,
    user_authorization: "approve exact revision",
  });
  assert.equal(approved.metadata.status, "approved");
  const workflow = store.createFromPlan({ plan_id: draft.plan_id, revision: 1 });
  assert.equal(workflow.workflow.approved_plan, revisionInput().full_plan);
  assert.equal(workflow.workflow.execution_brief, revisionInput().execution_brief);
  assert.deepEqual(workflow.workflow.plan_provenance, {
    plan_id: draft.plan_id,
    revision: 1,
    artifact_digest: approved.artifact_digest,
    approved_at: approved.metadata.approval?.approved_at,
  });
  store.close();
  const reopened = new WorkflowStore({ repositoryRoot: target.root, databasePath });
  assert.equal(
    reopened.planParentGet({ plan_id: draft.plan_id, revision: 1 }).full_plan,
    revisionInput().full_plan,
  );
  reopened.close();
  rmSync(databasePath, { force: true });
  disposeFixture(target.root);
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
  assert.deepEqual(revised.acceptance_criteria, [
    { criterion_id: "AC-001", description: "the plan is preserved" },
  ]);
  assert.deepEqual(revised.validation_requirements, [
    { validation_id: "VAL-001", description: "bun run check", argv: null },
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
        validation_requirements: [{ description: "executable", argv: ["bun", "run", "check"] }],
      },
    });
    assert.deepEqual(revised.approved_paths, ["a.txt", "z.txt"]);
    assert.deepEqual(revised.acceptance_criteria, [
      { criterion_id: "AC-001", description: "first" },
      { criterion_id: "AC-002", description: "second" },
    ]);
    assert.deepEqual(revised.validation_requirements, [
      { validation_id: "VAL-001", description: "executable", argv: ["bun", "run", "check"] },
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
      [{ validation_requirements: [{ description: "bad argv", argv: [] }] }, "ERROR_INVALID_SHAPE"],
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
    assert.equal(unchanged.metadata.approval, null);
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
    assert.deepEqual(workflow.workflow.plan_provenance, {
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
    const { source, id, optional } = approvedSource(store, target.git);
    const draft = store.planCreate(planInput());
    const approved = store.planApprove({
      plan_id: draft.plan_id,
      revision: 1,
      user_authorization: "approve child remediation plan",
    });
    const child = store.createLinkedFollowupFromPlan({
      workflow_id: id,
      capability: source.capability,
      expected_version: 3,
      plan_id: draft.plan_id,
      revision: 1,
      finding_ids: [optional.finding_id],
      user_authorization: "authorize exact child plan remediation",
    });
    const childView = store.parentGet(child.workflow.workflow_id);
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
        argv: ["bun", "run", "check"],
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
    assert.equal(store.parentGet(id).superseded_by_workflow_id, child.workflow.workflow_id);
  } finally {
    store.close();
    disposeFixture(target.root);
  }
});

test("plan-native linked follow-up rejects raw artifact fields and fails atomically", () => {
  const target = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  try {
    const { source, id, optional } = approvedSource(store, target.git);
    const draft = store.planCreate(planInput());
    const beforeVersion = store.parentGet(id).version;
    const beforeAudit = store.audit(id, source.capability).length;
    assert.equal(
      category(() =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          capability: source.capability,
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
    assert.equal(store.audit(id, source.capability).length, beforeAudit);
    assert.equal(
      category(() =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          capability: source.capability,
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
    assert.equal(store.audit(id, source.capability).length, beforeAudit);
    assert.equal(
      category(() =>
        store.createLinkedFollowupFromPlan({
          workflow_id: id,
          capability: source.capability,
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
    assert.equal(store.audit(id, source.capability).length, beforeAudit);
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
    const { source, id, optional } = approvedSource(store, target.git);
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
    const beforeSourceAudit = store.audit(id, source.capability);
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
          capability: source.capability,
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
    assert.deepEqual(store.audit(id, source.capability), beforeSourceAudit);
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
