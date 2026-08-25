import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
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

test("plan revisions are complete replacements and stale revisions fail closed", () => {
  const target = fixture();
  const store = new WorkflowStore({ repositoryRoot: target.root, databasePath: ":memory:" });
  const draft = store.planCreate(revisionInput());
  const revised = store.planRevise({
    plan_id: draft.plan_id,
    base_revision: 1,
    ...revisionInput(),
    full_plan: "replacement plan",
  });
  assert.equal(revised.revision, 2);
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
      store.planRevise({ plan_id: draft.plan_id, base_revision: 1, ...revisionInput() }),
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
