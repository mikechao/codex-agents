import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowStore } from "../store.js";
import { MAX_REPO_PATH_LENGTH, objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";
import {
  authorized,
  category,
  currentVersion,
  implementation,
  input,
  rawState,
  review,
  runtimeAttestation,
} from "./workflow-test-helpers.js";

test("fresh store API exposes direct parent views and role-specific views", () => {
  const { root, git } = fixture();
  try {
    const path = join(root, "state.sqlite");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = store.create(input(git, { approved_plan: "immutable plan" }));
    const id = created.workflow_id;
    assert.equal(Object.hasOwn(created, "workflow"), false);
    assert.equal("workflow" in created, false);
    assert.equal("capability" in created, false);
    assert.equal("workflow" in store.parentGet(id), false);
    assert.equal("capabilities" in created, false);
    assert.equal(store.implementerGet(id).approved_plan, "immutable plan");
    assert.equal("approved_plan" in store.reviewerGet(id), false);
    assert.equal("commit_authorization" in store.committerGet(id), true);
    assert.equal(store.parentGet(id).version, 0);
    assert.equal(store.audit(id).length, 1);
    assert.equal(
      category(() =>
        store.authorizeCommit({
          workflow_id: id,
          capability: "wrong",
          expected_version: 0,
          user_authorization: "no",
        }),
      ),
      "ERROR_INVALID_SHAPE",
    );
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    assert.equal(reopened.parentGet(id).approved_plan, "immutable plan");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker mutations are capability-free and retain optimistic version checks", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git));
    const id = created.workflow_id;
    const implemented = implementation(store, created);
    assert.equal(implemented.phase, "REVIEWING");
    assert.equal(
      category(() => implementation(store, created, 0)),
      "ERROR_VERSION_CONFLICT",
    );
    writeFileSync(join(root, "note.txt"), "changed\n");
    const approved = review(store, created);
    assert.equal(approved.phase, "STOPPED_APPROVED");
    store.authorizeCommit({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
      user_authorization: "authorize",
    });
    git("add", "note.txt");
    const prepared = store.prepareCommit({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    assert.deepEqual(store.committerGet(id).permitted_next_actions, [
      "workflow_submit_commit_result",
    ]);
    const preparedDecision = store.operatorDecisionGet(id);
    assert.deepEqual(preparedDecision.primary, { kind: "no_user_action", route: "commit" });
    assert.deepEqual(preparedDecision.execution.primary, {
      mode: "dispatch",
      route: "commit",
      operation: "workflow_submit_commit_result",
      workflow_id: id,
      expected_version: prepared.version,
    });
    git("commit", "-qm", "workflow test");
    const committed = store.submitCommitResult({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "committed",
      failure_summary: null,
    });
    assert.equal(committed.phase, "COMMITTED");
    assert.deepEqual(
      store.audit(id).map((event: any) => event.event_type),
      [
        "WORKFLOW_CREATED",
        "IMPLEMENTATION_SUBMITTED",
        "REVIEW_STARTED",
        "REVIEW_SUBMITTED",
        "COMMIT_AUTHORIZED",
        "COMMIT_PREPARED",
        "COMMIT_RESULT_SUBMITTED",
      ],
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normal mutation state and audit append roll back together", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git));
    const before = store.db
      .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow_id);
    const beforeAudit = store.db
      .prepare(
        "SELECT version, event_type, actor_role, summary_json FROM audit_events WHERE workflow_id = ? ORDER BY event_id",
      )
      .all(created.workflow_id);
    store.db.exec(`
      CREATE TRIGGER fail_workflow_audit_insert
      BEFORE INSERT ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'test audit append failure');
      END;
    `);
    assert.throws(() => implementation(store, created), /test audit append failure/);
    const after = store.db
      .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow_id);
    const afterAudit = store.db
      .prepare(
        "SELECT version, event_type, actor_role, summary_json FROM audit_events WHERE workflow_id = ? ORDER BY event_id",
      )
      .all(created.workflow_id);
    assert.deepEqual(after, before);
    assert.deepEqual(afterAudit, beforeAudit);
    store.db.exec("DROP TRIGGER fail_workflow_audit_insert");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reconciles an existing commit from a different owning runtime without a second commit", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "reconcile.sqlite");
  const base = git("rev-parse", "HEAD");
  const oldRuntimeId = "a".repeat(64);
  const oldKey = "1".repeat(64);
  const newRuntimeId = "b".repeat(64);
  const newKey = "2".repeat(64);
  try {
    const oldStore: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath,
      runtimeId: oldRuntimeId,
      runtimeRevision: base,
      ...runtimeAttestation(oldRuntimeId, base, oldKey),
    });
    const created = oldStore.create(input(git));
    implementation(oldStore, created);
    writeFileSync(join(root, "note.txt"), "committed once\n");
    review(oldStore, created);
    oldStore.authorizeCommit({
      workflow_id: created.workflow_id,
      expected_version: oldStore.parentGet(created.workflow_id).version,
      user_authorization: "authorize",
    });
    git("add", "note.txt");
    const prepared = oldStore.prepareCommit({
      workflow_id: created.workflow_id,
      expected_version: oldStore.parentGet(created.workflow_id).version,
    });
    const gitHead = join(root, ".git", "HEAD");
    const unavailableHead = join(root, ".git", "HEAD.unavailable");
    renameSync(gitHead, unavailableHead);
    try {
      assert.deepEqual(oldStore.committerGet(created.workflow_id).permitted_next_actions, []);
      assert.equal(
        category(() =>
          oldStore.submitCommitResult({
            workflow_id: created.workflow_id,
            expected_version: prepared.version,
            attempt_id: prepared.commit_preparation.attempt_id,
            outcome: "not_committed",
            failure_summary: "commit was not created",
          }),
        ),
        "ERROR_GIT",
      );
      assert.equal(rawState(oldStore, created.workflow_id).phase, "COMMIT_PREPARED");
    } finally {
      renameSync(unavailableHead, gitHead);
    }
    assert.deepEqual(oldStore.parentGet(created.workflow_id).permitted_next_actions, []);
    assert.equal(
      category(() =>
        oldStore.reconcileCommitResult({
          workflow_id: created.workflow_id,
          expected_version: prepared.version,
          attempt_id: prepared.commit_preparation.attempt_id,
        }),
      ),
      "ERROR_COMMIT_NOT_ALLOWED",
    );
    const unverifiedStore: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath,
      runtimeId: newRuntimeId,
      runtimeRevision: base,
      ...runtimeAttestation(newRuntimeId, base, newKey),
    });
    assert.deepEqual(unverifiedStore.reconciliationPermittedActions(created.workflow_id), [
      "workflow_reconcile_commit_result",
    ]);
    assert.equal(
      unverifiedStore.operatorDecisionGetForReconciliation(created.workflow_id).primary.kind,
      "reconcile_commit",
    );
    assert.equal(rawState(unverifiedStore, created.workflow_id).phase, "COMMIT_PREPARED");
    unverifiedStore.close();
    git("commit", "-qm", "existing commit");
    const current = git("rev-parse", "HEAD");
    oldStore.close();

    const currentStore: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath,
      runtimeId: newRuntimeId,
      runtimeRevision: current,
      ...runtimeAttestation(newRuntimeId, current, newKey),
    });
    const preReconciliationReader: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath,
      runtimeId: newRuntimeId,
      runtimeRevision: current,
      ...runtimeAttestation(newRuntimeId, current, newKey),
    });
    assert.equal(
      category(() => preReconciliationReader.parentGet(created.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    preReconciliationReader.close();
    const reconciled = currentStore.reconcileCommitResult({
      workflow_id: created.workflow_id,
      expected_version: prepared.version,
      attempt_id: prepared.commit_preparation.attempt_id,
    });
    assert.equal(reconciled.phase, "COMMITTED");
    assert.equal(currentStore.parentGet(created.workflow_id).phase, "COMMITTED");
    const stateBeforeAuditCorruption = rawState(currentStore, created.workflow_id);
    const stateRowBeforeAuditCorruption = currentStore.db
      .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow_id);
    const reconciliationAudit = currentStore.db
      .prepare(
        "SELECT summary_json FROM audit_events WHERE workflow_id = ? AND version = ? AND event_type = 'COMMIT_RESULT_SUBMITTED'",
      )
      .get(created.workflow_id, reconciled.version) as { summary_json: string } | undefined;
    assert.ok(reconciliationAudit);
    const corruptedSummary = {
      ...JSON.parse(reconciliationAudit.summary_json),
      state_digest_after: objectDigest({ corrupted: "reconciliation evidence" }),
    };
    assert.notEqual(
      corruptedSummary.state_digest_after,
      stateRowBeforeAuditCorruption.state_digest,
    );
    const corruption = currentStore.db
      .prepare(
        "UPDATE audit_events SET summary_json = ? WHERE workflow_id = ? AND version = ? AND event_type = 'COMMIT_RESULT_SUBMITTED'",
      )
      .run(JSON.stringify(corruptedSummary), created.workflow_id, reconciled.version);
    assert.equal(corruption.changes, 1);
    assert.equal(
      category(() => currentStore.parentGet(created.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    const stateRowAfterAuditCorruption = currentStore.db
      .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow_id);
    assert.deepEqual(rawState(currentStore, created.workflow_id), stateBeforeAuditCorruption);
    assert.deepEqual(stateRowAfterAuditCorruption, stateRowBeforeAuditCorruption);
    assert.equal(
      category(() => currentStore.implementerGet(created.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    assert.equal(
      category(() => currentStore.audit(created.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    assert.equal(git("rev-list", "--count", "HEAD"), "2");
    const oldReader: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath,
      runtimeId: oldRuntimeId,
      runtimeRevision: base,
      ...runtimeAttestation(oldRuntimeId, base, oldKey),
    });
    assert.deepEqual(
      oldReader.audit(created.workflow_id).map((event: any) => event.event_type),
      [
        "WORKFLOW_CREATED",
        "IMPLEMENTATION_SUBMITTED",
        "REVIEW_STARTED",
        "REVIEW_SUBMITTED",
        "COMMIT_AUTHORIZED",
        "COMMIT_PREPARED",
        "COMMIT_RESULT_SUBMITTED",
      ],
    );
    assert.equal(
      category(() =>
        currentStore.reconcileCommitResult({
          workflow_id: created.workflow_id,
          expected_version: reconciled.version,
          attempt_id: prepared.commit_preparation.attempt_id,
        }),
      ),
      "ERROR_INVALID_TRANSITION",
    );
    assert.equal(oldReader.audit(created.workflow_id).length, 7);
    oldReader.close();
    currentStore.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-runtime dirty adoption consumes the same aggregate recovery readiness", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "cross-runtime-adoption-readiness.sqlite");
  const revision = git("rev-parse", "HEAD");
  const ownerRuntimeId = "a".repeat(64);
  const ownerKey = "1".repeat(64);
  const currentRuntimeId = "b".repeat(64);
  const currentKey = "2".repeat(64);
  const owner: any = new WorkflowStore({
    repositoryRoot: root,
    databasePath,
    runtimeId: ownerRuntimeId,
    runtimeRevision: revision,
    ...runtimeAttestation(ownerRuntimeId, revision, ownerKey),
  });
  let current: any;
  try {
    const created = owner.create(input(git));
    owner.expandScope({
      workflow_id: created.workflow_id,
      expected_version: 0,
      added_paths: ["fully-dirty.txt"],
      reason: "first expansion",
      user_authorization: "authorize first expansion",
    });
    owner.submitImplementation({
      workflow_id: created.workflow_id,
      expected_version: 1,
      status: "INCOMPLETE",
      summary: "another expansion is required",
      agent_touched_paths: [],
      acceptance_results: [
        { criterion_id: "AC-001", status: "not_satisfied", evidence: "scope is incomplete" },
      ],
      validation_results: [
        { validation_id: "VAL-001", status: "failed", evidence: "scope is incomplete" },
      ],
      known_failures: ["another expansion is required"],
      finding_resolution_map: {},
    });
    owner.expandScope({
      workflow_id: created.workflow_id,
      expected_version: 2,
      added_paths: ["partially-dirty.txt", "still-clean.txt"],
      reason: "second expansion",
      user_authorization: "authorize second expansion",
    });
    implementation(owner, created);
    review(owner, created, undefined, "INCONCLUSIVE");
    writeFileSync(join(root, "fully-dirty.txt"), "dirty\n");
    writeFileSync(join(root, "partially-dirty.txt"), "dirty\n");
    assert.deepEqual(owner.parentGet(created.workflow_id).permitted_next_actions, []);
    const before = rawState(owner, created.workflow_id);
    const auditLength = owner.audit(created.workflow_id).length;

    current = new WorkflowStore({
      repositoryRoot: root,
      databasePath,
      runtimeId: currentRuntimeId,
      runtimeRevision: revision,
      ...runtimeAttestation(currentRuntimeId, revision, currentKey),
    });
    assert.equal(
      category(() =>
        current.adoptDirtyScopeCrossRuntime({
          workflow_id: created.workflow_id,
          expected_version: before.version,
          adopted_paths: ["fully-dirty.txt"],
          reason: "attempt partial recovery bypass",
          user_authorization: "authorize recovery",
        }),
      ),
      "ERROR_SCOPE_EXPANSION_DIRTY",
    );
    assert.deepEqual(rawState(current, created.workflow_id), before);
    assert.equal(
      current.db
        .prepare("SELECT COUNT(*) AS count FROM audit_events WHERE workflow_id = ?")
        .get(created.workflow_id).count,
      auditLength,
    );
  } finally {
    current?.close();
    owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-runtime dirty adoption is atomic and revalidates pending evidence", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "cross-runtime-adoption-recovery.sqlite");
  const revision = git("rev-parse", "HEAD");
  const ownerRuntimeId = "a".repeat(64);
  const currentRuntimeId = "b".repeat(64);
  const owner: any = new WorkflowStore({
    repositoryRoot: root,
    databasePath,
    runtimeId: ownerRuntimeId,
    runtimeRevision: revision,
    ...runtimeAttestation(ownerRuntimeId, revision, "1".repeat(64)),
  });
  let current: any;
  try {
    const created = owner.create(input(git));
    const id = created.workflow_id;
    owner.expandScope({
      workflow_id: id,
      expected_version: 0,
      added_paths: ["dirty.txt"],
      reason: "planned dirty path",
      user_authorization: "authorized",
    });
    implementation(owner, created, 1);
    review(owner, created, 2, "INCONCLUSIVE");
    writeFileSync(join(root, "dirty.txt"), "authorized\n");

    current = new WorkflowStore({
      repositoryRoot: root,
      databasePath,
      runtimeId: currentRuntimeId,
      runtimeRevision: revision,
      ...runtimeAttestation(currentRuntimeId, revision, "2".repeat(64)),
    });
    const before = rawState(current, id);
    const auditBefore = current.db
      .prepare(
        "SELECT event_type, summary_json FROM audit_events WHERE workflow_id = ? ORDER BY event_id",
      )
      .all(id);
    current.db.exec(`
      CREATE TRIGGER fail_cross_runtime_adoption_audit
      BEFORE INSERT ON audit_events
      BEGIN
        SELECT RAISE(ABORT, 'test cross-runtime audit append failure');
      END;
    `);
    assert.throws(() =>
      current.adoptDirtyScopeCrossRuntime({
        workflow_id: id,
        expected_version: before.version,
        adopted_paths: ["dirty.txt"],
        reason: "recover dirty path",
        user_authorization: "explicit recovery",
      }),
    );
    assert.deepEqual(rawState(current, id), before);
    assert.deepEqual(
      current.db
        .prepare(
          "SELECT event_type, summary_json FROM audit_events WHERE workflow_id = ? ORDER BY event_id",
        )
        .all(id),
      auditBefore,
    );
    current.db.exec("DROP TRIGGER fail_cross_runtime_adoption_audit");

    const adopted = current.adoptDirtyScopeCrossRuntime({
      workflow_id: id,
      expected_version: before.version,
      adopted_paths: ["dirty.txt"],
      reason: "recover dirty path",
      user_authorization: "explicit recovery",
    });
    assert.equal(adopted.version, before.version + 1);
    assert.equal(adopted.phase, "STOPPED_INCONCLUSIVE");
    assert.equal(
      current.db
        .prepare("SELECT event_type FROM audit_events WHERE workflow_id = ? ORDER BY event_id")
        .all(id)
        .at(-1).event_type,
      "DIRTY_SCOPE_ADOPTED",
    );

    current.verifyPendingDirtyScope(id);
    writeFileSync(join(root, "dirty.txt"), "changed after authorization\n");
    assert.equal(
      category(() => current.verifyPendingDirtyScope(id)),
      "ERROR_STALE_ADOPTION",
    );
    writeFileSync(join(root, "dirty.txt"), "authorized\n");

    const resumed = owner.resumeReview({
      workflow_id: id,
      expected_version: adopted.version,
      resume_context: "resume after adoption",
    });
    assert.equal(resumed.version, adopted.version + 1);
    assert.equal(resumed.phase, "REVIEWING");
    const began = current.beginReviewCrossRuntime({
      workflow_id: id,
      expected_version: resumed.version,
    });
    assert.equal(began.version, resumed.version + 1);
    assert.equal(began.phase, "REVIEWING");
  } finally {
    current?.close();
    owner.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("scope expansion and audit integrity remain append-only", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "scope.sqlite");
  try {
    writeFileSync(join(root, "companion.txt"), "committed companion\n");
    git("add", "companion.txt");
    git("commit", "-qm", "scope baseline fixture");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    const created = store.create(input(git, { approved_paths: ["note.txt"] }));
    const incomplete = store.submitImplementation({
      workflow_id: created.workflow_id,
      expected_version: 0,
      status: "INCOMPLETE",
      summary: "companion.txt and extra.txt are outside the approved scope",
      agent_touched_paths: [],
      acceptance_results: [
        { criterion_id: "AC-001", status: "not_satisfied", evidence: "scope remains" },
      ],
      validation_results: [
        { validation_id: "VAL-001", status: "failed", evidence: "scope remains" },
      ],
      known_failures: ["companion.txt is outside scope", "extra.txt is outside scope"],
      finding_resolution_map: {},
    });
    const incompleteAudit = store.audit(created.workflow_id)[1];
    assert.equal(incomplete.phase, "IMPLEMENTING");
    assert.equal(incomplete.version, 1);
    assert.equal(
      store.implementerGet(created.workflow_id).implementation_summary.includes("extra.txt"),
      true,
    );
    const expanded = store.expandScope({
      workflow_id: created.workflow_id,
      expected_version: 1,
      added_paths: ["companion.txt", "extra.txt"],
      reason: "needed",
      user_authorization: "authorized",
    });
    assert.deepEqual(expanded.approved_paths, ["companion.txt", "extra.txt", "note.txt"]);
    assert.deepEqual(expanded.review_target.approved_paths, [
      "companion.txt",
      "extra.txt",
      "note.txt",
    ]);
    for (const view of [
      store.parentGet(created.workflow_id),
      expanded,
      store.reviewerGet(created.workflow_id),
      rawState(store, created.workflow_id),
    ]) {
      assert.equal(view.implementation_summary, null);
      assert.equal(view.implementation_status, null);
      assert.deepEqual(view.implementation_known_failures, []);
      assert.deepEqual(view.agent_touched_paths, []);
      assert.deepEqual(view.scope_changed_paths, []);
      assert.deepEqual(view.acceptance_results, []);
      assert.deepEqual(view.validation_results, []);
      assert.deepEqual(view.finding_resolution_map, {});
    }
    assert.equal(rawState(store, created.workflow_id).implementation_receipt, null);
    assert.equal(rawState(store, created.workflow_id).review_start_receipt, null);
    assert.equal(rawState(store, created.workflow_id).review_receipt, null);
    assert.equal(rawState(store, created.workflow_id).commit_authorization, null);
    assert.equal(rawState(store, created.workflow_id).commit_preparation, null);
    assert.equal(rawState(store, created.workflow_id).commit_result, null);
    assert.deepEqual(expanded.approved_path_baselines, [
      {
        path: "companion.txt",
        approved_at_version: 2,
        baseline: {
          path: "companion.txt",
          state: "unchanged",
          kind: "file",
          mode: "100644",
        },
      },
      {
        path: "extra.txt",
        approved_at_version: 2,
        baseline: { path: "extra.txt", state: "absent", kind: "missing" },
      },
    ]);
    assert.equal("approved_path_baselines" in store.implementerGet(created.workflow_id), false);
    assert.equal(expanded.implementation_receipt, undefined);
    assert.equal(expanded.phase, "IMPLEMENTING");
    assert.equal(expanded.version, 2);
    assert.equal(expanded.workflow_id, created.workflow_id);
    assert.equal(store.reviewerGet(created.workflow_id).implementation_summary, null);
    assert.equal(store.reviewerGet(created.workflow_id).implementation_status, null);
    assert.deepEqual(store.audit(created.workflow_id)[1], incompleteAudit);
    writeFileSync(join(root, "companion.txt"), "expanded companion\n");
    const implemented = implementation(store, expanded, undefined, "DONE", {}, ["companion.txt"]);
    assert.equal(implemented.phase, "REVIEWING");
    assert.ok(rawState(store, created.workflow_id).implementation_receipt);
    const row: any = store.db
      .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow_id);
    assert.equal(row.state_digest, objectDigest(JSON.parse(row.state_json)));
    const audit = store.audit(created.workflow_id);
    assert.equal(audit.at(-2)?.event_type, "SCOPE_EXPANDED");
    assert.deepEqual(audit.at(-2)?.scope_expansion?.baselines, [
      {
        path: "companion.txt",
        approved_at_version: 2,
        baseline: {
          path: "companion.txt",
          state: "unchanged",
          kind: "file",
          mode: "100644",
        },
      },
      {
        path: "extra.txt",
        approved_at_version: 2,
        baseline: { path: "extra.txt", state: "absent", kind: "missing" },
      },
    ]);
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    assert.deepEqual(reopened.parentGet(created.workflow_id).approved_path_baselines, [
      {
        path: "companion.txt",
        approved_at_version: 2,
        baseline: {
          path: "companion.txt",
          state: "unchanged",
          kind: "file",
          mode: "100644",
        },
      },
      {
        path: "extra.txt",
        approved_at_version: 2,
        baseline: { path: "extra.txt", state: "absent", kind: "missing" },
      },
    ]);
    assert.equal(reopened.parentGet(created.workflow_id).version, 3);
    assert.equal(reopened.implementerGet(created.workflow_id).implementation_status, "DONE");
    assert.deepEqual(reopened.audit(created.workflow_id)[1].summary, incompleteAudit.summary);
    assert.equal(reopened.audit(created.workflow_id).at(-2)?.event_type, "SCOPE_EXPANDED");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime ownership rejects role getters and worker mutations before state changes", () => {
  const { root, git } = fixture();
  try {
    const path = join(root, "runtime.sqlite");
    const revision = git("rev-parse", "HEAD");
    const runtimeA = "a".repeat(64);
    const runtimeB = "b".repeat(64);
    const owner: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath: path,
      runtimeId: runtimeA,
      runtimeRevision: revision,
      ...runtimeAttestation(runtimeA, revision),
    });
    const created = owner.create(input(git));
    owner.close();
    const foreign: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath: path,
      runtimeId: runtimeB,
      runtimeRevision: revision,
    });
    assert.equal(
      category(() => foreign.parentGet(created.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    assert.equal(
      category(() =>
        foreign.submitImplementation({
          workflow_id: created.workflow_id,
          expected_version: 0,
          status: "DONE",
          summary: "no",
          agent_touched_paths: [],
          acceptance_results: [],
          validation_results: [],
          known_failures: [],
          finding_resolution_map: {},
        }),
      ),
      "ERROR_RUNTIME_ISOLATION",
    );
    foreign.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approved plan, contracts, and dirty baselines survive restart with least-authority views", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "contracts.sqlite");
  const plan = `# exact approved plan\n\n${"x".repeat(4096)}`;
  try {
    writeFileSync(join(root, "note.txt"), "dirty\n");
    writeFileSync(join(root, "planned.txt"), "new\n");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    const created = store.create(
      input(git, {
        approved_plan: plan,
        approved_paths: ["note.txt", "planned.txt"],
        acceptance_criteria: ["duplicate", "duplicate"],
        validation_requirements: [
          { description: "manual validation", kind: "inspection" },
          { description: "exact validation", kind: "command", argv: ["bun", "run", "test"] },
        ],
      }),
    );
    const id = created.workflow_id;
    assert.equal(created.approved_plan, plan);
    assert.deepEqual(created.dirty_baseline_paths, ["note.txt", "planned.txt"]);
    assert.deepEqual(
      created.acceptance_criteria.map(({ criterion_id }: any) => criterion_id),
      ["AC-001", "AC-002"],
    );
    assert.deepEqual(
      created.validation_requirements.map(({ validation_id }: any) => validation_id),
      ["VAL-001", "VAL-002"],
    );
    assert.equal(store.implementerGet(id).approved_plan, plan);
    assert.equal("approved_plan" in store.reviewerGet(id), false);
    assert.equal("approved_plan" in store.committerGet(id), false);
    assert.equal("approved_path_baselines" in store.implementerGet(id), false);
    assert.equal(
      category(() => store.create({ ...input(git), approved_plan: "" })),
      "ERROR_INVALID_SHAPE",
    );
    assert.equal(
      category(() => store.create({ ...input(git), unexpected: true })),
      "ERROR_INVALID_SHAPE",
    );
    store.close();

    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    assert.equal(reopened.implementerGet(id).approved_plan, plan);
    assert.deepEqual(reopened.parentGet(id).dirty_baseline_paths, ["note.txt", "planned.txt"]);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("state and audit digests remain chained and tampering fails closed", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "integrity.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    const created = store.create(input(git, { objective: "integrity" }));
    const id = created.workflow_id;
    const row = () =>
      store.db
        .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(id);
    const createdRow = row();
    assert.equal(createdRow.state_digest, objectDigest(JSON.parse(createdRow.state_json)));
    implementation(store, created);
    const original = row();
    assert.equal(original.state_digest, objectDigest(JSON.parse(original.state_json)));
    const events = store.audit(id);
    assert.equal(events[0].summary.state_digest_before, null);
    for (let index = 1; index < events.length; index += 1) {
      assert.equal(
        events[index].summary.state_digest_before,
        events[index - 1].summary.state_digest_after,
      );
    }
    const tampered = JSON.parse(row().state_json);
    tampered.objective = "tampered";
    store.db
      .prepare("UPDATE workflows SET state_json = ? WHERE workflow_id = ?")
      .run(JSON.stringify(tampered), id);
    assert.equal(
      category(() => store.parentGet(id)),
      "ERROR_STATE_CORRUPT",
    );
    store.db
      .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
      .run(original.state_json, original.state_digest, id);
    assert.equal(store.parentGet(id).phase, "REVIEWING");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("digest-consistent rows that violate state validation still fail closed", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "validation.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    const created = store.create(input(git, { objective: "runtime validation" }));
    const id = created.workflow_id;
    const original = rawState(store, id);
    for (const invalid of [
      { ...original, phase: "NOT_A_PHASE" },
      { ...original, phase: "COMMIT_AUTHORIZED" },
    ]) {
      store.db
        .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
        .run(JSON.stringify(invalid), objectDigest(invalid), id);
      assert.equal(
        category(() => store.parentGet(id)),
        "ERROR_STATE_CORRUPT",
      );
    }
    store.db
      .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
      .run(JSON.stringify(original), objectDigest(original), id);
    assert.equal(store.parentGet(id).phase, "IMPLEMENTING");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent audit envelopes are sanitized and append-only across accepted and rejected mutations", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { objective: "SECRET-AUDIT-OBJECTIVE" }));
    const id = created.workflow_id;
    const readAudit = () => store.audit(id);
    const envelopeKeys = [
      "changed_fields",
      "linked_workflow_id",
      "outcome",
      "phase_after",
      "phase_before",
      "schema_version",
      "state_digest_after",
      "state_digest_before",
    ];
    const createdEvent = readAudit()[0];
    assert.deepEqual(Object.keys(createdEvent.summary).sort(), envelopeKeys);
    assert.equal(createdEvent.summary.schema_version, 2);
    assert.equal(createdEvent.summary.phase_before, null);
    assert.equal(createdEvent.summary.phase_after, "IMPLEMENTING");
    assert.deepEqual(
      createdEvent.summary.changed_fields,
      Object.keys(rawState(store, id))
        .filter((key) => key !== "version")
        .sort(),
    );

    implementation(store, created);
    const implementationEvent = readAudit()[1];
    assert.deepEqual(Object.keys(implementationEvent.summary).sort(), envelopeKeys);
    assert.deepEqual(
      implementationEvent.summary.changed_fields,
      [...implementationEvent.summary.changed_fields].sort(),
    );
    const auditBeforeRejectedMutation = readAudit();
    assert.equal(
      category(() => implementation(store, created, 0)),
      "ERROR_VERSION_CONFLICT",
    );
    assert.deepEqual(readAudit(), auditBeforeRejectedMutation);
    assert.equal(store.audit(id).length, auditBeforeRejectedMutation.length);

    const serialized = JSON.stringify(readAudit());
    for (const prohibited of ["SECRET-AUDIT-OBJECTIVE", "note.txt", "implementation evidence"]) {
      assert.equal(serialized.includes(prohibited), false, `audit envelope contains ${prohibited}`);
    }
    const eventIds = store.db
      .prepare("SELECT event_id FROM audit_events WHERE workflow_id = ? ORDER BY event_id")
      .all(id)
      .map((row: any) => row.event_id);
    assert.deepEqual(eventIds, [1, 2]);
    assert.deepEqual(
      readAudit().map((event: any) => event.version),
      [0, 1],
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-persistable staged paths retain retry-only recovery without reconciliation", () => {
  const longPath = `${"a".repeat(100)}/${"b".repeat(100)}/${"c".repeat(100)}/unsupported.txt`;
  assert.ok(longPath.length > MAX_REPO_PATH_LENGTH);
  const invalidPaths = [
    { label: "over-length", path: longPath },
    { label: "backslash", path: "bad\\name.txt" },
    { label: "asterisk", path: "bad*.txt" },
    { label: "question mark", path: "bad?.txt" },
    { label: "brackets", path: "bad[1].txt" },
  ];

  for (const candidate of invalidPaths) {
    const { root, git } = fixture();
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    try {
      const workflow = authorized(store, root, git);
      const parentDirectory = candidate.path.slice(0, candidate.path.lastIndexOf("/"));
      if (parentDirectory) mkdirSync(join(root, parentDirectory), { recursive: true });
      writeFileSync(join(root, candidate.path), "unsupported staged path\n");
      git("add", "-A");

      const stopped = store.prepareCommit({
        workflow_id: workflow.id,
        expected_version: currentVersion(store, workflow.id),
      });
      assert.equal(stopped.phase, "STOPPED_COMMIT_PREPARATION", candidate.label);
      assert.equal(stopped.stop_context.category, "ERROR_STAGED_SCOPE", candidate.label);
      assert.equal(stopped.stop_context.recovery, "retry", candidate.label);
      assert.equal("reconciliation_paths" in stopped.stop_context, false, candidate.label);

      const decision = store.operatorDecisionGet(workflow.id);
      assert.deepEqual(
        decision.execution.parent_actions.map((action: any) => action.action),
        ["workflow_retry_commit_preparation"],
        candidate.label,
      );
      assert.deepEqual(
        decision.execution.primary.invocations.map((invocation: any) => invocation.operation),
        ["workflow_retry_commit_preparation"],
        candidate.label,
      );

      git("--literal-pathspecs", "reset", "-q", "--", candidate.path);
      const retry = decision.execution.primary.invocations[0];
      const retried = store.retryCommitPreparation({
        ...retry.fixed_arguments,
        retry_context: "remove unsupported accidental staging and preserve reviewed authority",
      });
      assert.equal(retried.phase, "COMMIT_AUTHORIZED", candidate.label);
      assert.equal(
        store.prepareCommit({
          workflow_id: workflow.id,
          expected_version: currentVersion(store, workflow.id),
        }).phase,
        "COMMIT_PREPARED",
        candidate.label,
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
