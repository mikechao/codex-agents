import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { createRuntimeAttestation, WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";

function input(git: (...args: string[]) => string, options: any = {}) {
  const paths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "workflow test",
    approved_plan: options.approved_plan ?? null,
    approved_paths: paths,
    acceptance_criteria: options.acceptance_criteria ?? ["criterion"],
    validation_requirements: options.validation_requirements ?? [
      { description: "validation", argv: ["bun", "run", "check"] },
    ],
    review_target: options.review_target ?? {
      review_mode: "working_tree",
      base_revision: git("rev-parse", "HEAD"),
      head_revision: null,
      approved_paths: paths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
    max_repair_cycles: options.max_repair_cycles,
    ...(options.work_items === undefined ? {} : { work_items: options.work_items }),
  };
}

function implementation(
  store: any,
  workflow: any,
  version: number | undefined = undefined,
  status = "DONE",
  resolution = {},
  touched: string[] = [],
) {
  return store.submitImplementation({
    workflow_id: workflow.workflow.workflow_id,
    expected_version: version ?? store.parentGet(workflow.workflow.workflow_id).version,
    status,
    summary: "implementation evidence",
    agent_touched_paths: touched,
    acceptance_results: workflow.workflow.acceptance_criteria.map(({ criterion_id }: any) => ({
      criterion_id,
      status: "satisfied",
      evidence: "accepted",
    })),
    validation_results: workflow.workflow.validation_requirements.map(({ validation_id }: any) => ({
      validation_id,
      status: "passed",
      evidence: "validated",
    })),
    known_failures: status === "DONE" ? [] : ["test context"],
    finding_resolution_map: resolution,
  });
}

function review(
  store: any,
  workflow: any,
  _version: number | undefined = undefined,
  status = "APPROVED",
  blocking: any[] = [],
  optional: any[] = [],
  prior = {},
) {
  const id = workflow.workflow.workflow_id;
  if (workflow.workflow.review_target.review_mode === "working_tree") {
    store.beginReview({ workflow_id: id, expected_version: store.parentGet(id).version });
  }
  return store.submitReview({
    workflow_id: id,
    expected_version: store.parentGet(id).version,
    review_status: status,
    blocking_findings: blocking,
    optional_findings: optional,
    prior_finding_classifications: prior,
  });
}

function finding(id: string, severity = "P1", blocking = true) {
  return {
    finding_id: id,
    severity,
    blocking,
    file_and_line: "note.txt:1",
    failure_scenario: "scenario",
    impact: "impact",
    violated_requirement: "requirement",
    remediation: "remediation",
    missing_or_inadequate_test: "test",
  };
}

function category(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof WorkflowError);
    return error.category;
  }
  assert.fail("expected workflow error");
}

function rawState(store: any, workflowId: string): any {
  const row = store.db
    .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
    .get(workflowId);
  assert.ok(row);
  return JSON.parse(row.state_json);
}

function authorized(
  store: any,
  root: string,
  git: (...args: string[]) => string,
  options: any = {},
) {
  const approvedPaths = options.approved_paths ?? ["note.txt"];
  const created = store.create(
    input(git, {
      objective: options.objective ?? "authorized workflow",
      approved_paths: approvedPaths,
    }),
  );
  const id = created.workflow.workflow_id;
  implementation(store, created);
  for (const path of approvedPaths) {
    writeFileSync(
      join(root, path),
      options.contents?.[path] ??
        (path === "note.txt" ? (options.content ?? "changed\n") : `${path}\n`),
    );
  }
  review(store, created);
  store.authorizeCommit({
    workflow_id: id,
    capability: created.capability,
    expected_version: store.parentGet(id).version,
    user_authorization: "authorized",
  });
  return { created, id };
}

test("fresh store API persists singular parent capability and role-specific views", () => {
  const { root, git } = fixture();
  try {
    const path = join(root, "state.sqlite");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = store.create(input(git, { approved_plan: "immutable plan" }));
    const id = created.workflow.workflow_id;
    assert.equal(typeof created.capability, "string");
    assert.equal("capabilities" in created, false);
    assert.equal(store.implementerGet(id).approved_plan, "immutable plan");
    assert.equal("approved_plan" in store.reviewerGet(id), false);
    assert.equal("commit_authorization" in store.committerGet(id), true);
    assert.equal(store.parentGet(id).version, 0);
    assert.equal(store.audit(id, created.capability).length, 1);
    assert.equal(
      category(() =>
        store.authorizeCommit({
          workflow_id: id,
          capability: "wrong",
          expected_version: 0,
          user_authorization: "no",
        }),
      ),
      "ERROR_CAPABILITY_DENIED",
    );
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    assert.equal(reopened.parentGet(id).approved_plan, "immutable plan");
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incomplete implementation attempts stay active and preserve repair authorization", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow.workflow_id;
    const submit = (options: {
      status: string;
      criterion?: "satisfied" | "not_satisfied";
      validation?: "passed" | "failed" | "not_run";
      resolution?: Record<string, string>;
    }) =>
      store.submitImplementation({
        workflow_id: id,
        expected_version: store.parentGet(id).version,
        status: options.status,
        summary: `${options.status.toLowerCase()} attempt`,
        agent_touched_paths: [],
        acceptance_results: created.workflow.acceptance_criteria.map(
          ({ criterion_id }: { criterion_id: string }) => ({
            criterion_id,
            status: options.criterion ?? "satisfied",
            evidence: "acceptance evidence",
          }),
        ),
        validation_results: created.workflow.validation_requirements.map(
          ({ validation_id }: { validation_id: string }) => ({
            validation_id,
            status: options.validation ?? "passed",
            evidence: "validation evidence",
          }),
        ),
        known_failures: options.status === "DONE" ? [] : ["remaining approved work"],
        finding_resolution_map: options.resolution ?? {},
      });

    const incomplete = submit({
      status: "INCOMPLETE",
      criterion: "not_satisfied",
      validation: "failed",
    });
    assert.equal(incomplete.phase, "IMPLEMENTING");
    assert.equal(incomplete.version, 1);
    assert.equal(incomplete.stop_context, null);
    assert.deepEqual(store.parentGet(id).permitted_next_actions, ["workflow_expand_scope"]);
    assert.deepEqual(store.implementerGet(id).permitted_next_actions, [
      "workflow_submit_implementation",
    ]);
    assert.deepEqual(store.reviewerGet(id).permitted_next_actions, []);
    assert.deepEqual(
      store.audit(id, created.capability).map((event: any) => event.event_type),
      ["WORKFLOW_CREATED", "IMPLEMENTATION_INCOMPLETE"],
    );
    assert.equal(store.audit(id, created.capability).at(-1).summary.outcome, "IMPLEMENTING");
    const persisted = rawState(store, id);
    assert.equal(persisted.phase, "IMPLEMENTING");
    assert.equal(persisted.stop_context, null);
    assert.equal("continuation_count" in persisted, false);

    writeFileSync(join(root, "note.txt"), "implemented\n");
    assert.equal(submit({ status: "DONE" }).phase, "REVIEWING");
    const blocker = finding("REPAIR-1");
    assert.equal(
      review(store, created, undefined, "CHANGES_REQUESTED", [blocker]).phase,
      "REPAIR_REQUIRED",
    );
    store.authorizeRepair({
      workflow_id: id,
      capability: created.capability,
      expected_version: store.parentGet(id).version,
      finding_ids: ["REPAIR-1"],
    });
    const repairBefore = store.parentGet(id);
    const repairing = submit({
      status: "INCOMPLETE",
      criterion: "not_satisfied",
      validation: "not_run",
      resolution: { "REPAIR-1": "still_present" },
    });
    assert.equal(repairing.phase, "REPAIRING");
    assert.equal(repairing.repair_cycle, repairBefore.repair_cycle);
    assert.deepEqual(repairing.repair_authorized_ids, ["REPAIR-1"]);
    assert.equal(repairing.stop_context, null);
    assert.deepEqual(store.implementerGet(id).permitted_next_actions, [
      "workflow_submit_implementation",
    ]);
    assert.deepEqual(store.reviewerGet(id).permitted_next_actions, []);
    assert.equal(
      submit({ status: "DONE", resolution: { "REPAIR-1": "resolved" } }).phase,
      "REVIEWING",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("complete implementation statuses require satisfied acceptance criteria", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git));
    const id = created.workflow.workflow_id;
    const concern = (criterion: "satisfied" | "not_satisfied") =>
      store.submitImplementation({
        workflow_id: id,
        expected_version: store.parentGet(id).version,
        status: "DONE_WITH_CONCERNS",
        summary: "approved work complete with external validation exception",
        agent_touched_paths: [],
        acceptance_results: created.workflow.acceptance_criteria.map(
          ({ criterion_id }: { criterion_id: string }) => ({
            criterion_id,
            status: criterion,
            evidence: "acceptance evidence",
          }),
        ),
        validation_results: created.workflow.validation_requirements.map(
          ({ validation_id }: { validation_id: string }) => ({
            validation_id,
            status: "not_run",
            evidence: "external validation unavailable",
          }),
        ),
        known_failures: ["manual environment validation remains"],
        finding_resolution_map: {},
      });

    assert.equal(
      category(() => concern("not_satisfied")),
      "ERROR_INVALID_IMPLEMENTATION",
    );
    assert.equal(store.parentGet(id).version, 0);
    assert.equal(concern("satisfied").phase, "STOPPED_CONCERNS");
    assert.deepEqual(store.parentGet(id).permitted_next_actions, ["workflow_accept_concerns"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker mutations are capability-free and retain optimistic version checks", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git));
    const id = created.workflow.workflow_id;
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
      capability: created.capability,
      expected_version: store.parentGet(id).version,
      user_authorization: "authorize",
    });
    git("add", "note.txt");
    const prepared = store.prepareCommit({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
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
      store.audit(id, created.capability).map((event: any) => event.event_type),
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

test("repair and re-review use authoritative expected versions", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow.workflow_id;
    implementation(store, created);
    const blocker = finding("REPAIR-1");
    assert.equal(
      review(store, created, undefined, "CHANGES_REQUESTED", [blocker]).phase,
      "REPAIR_REQUIRED",
    );
    assert.equal(
      store.authorizeRepair({
        workflow_id: id,
        capability: created.capability,
        expected_version: store.parentGet(id).version,
        finding_ids: ["REPAIR-1"],
      }).phase,
      "REPAIRING",
    );
    assert.equal(
      implementation(store, created, undefined, "DONE", { "REPAIR-1": "resolved" }).phase,
      "REVIEWING",
    );
    writeFileSync(join(root, "note.txt"), "repaired\n");
    assert.equal(
      review(store, created, undefined, "APPROVED", [], [], { "REPAIR-1": "resolved" }).phase,
      "STOPPED_APPROVED",
    );
    assert.deepEqual(store.parentGet(id).permitted_next_actions, [
      "workflow_authorize_commit",
      "workflow_create_linked_followup",
      "workflow_create_linked_followup_from_plan",
    ]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent adjudication removes only the dismissed blocker and avoids a no-op repair", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    const repaired = finding("REPAIR-1");
    const inconsistent = finding("PLAN-1");
    assert.equal(
      review(store, created, undefined, "CHANGES_REQUESTED", [repaired, inconsistent]).phase,
      "REPAIR_REQUIRED",
    );
    const adjudicated = store.adjudicateFindings({
      workflow_id: id,
      capability: created.capability,
      expected_version: store.parentGet(id).version,
      findings: [
        {
          finding_id: "PLAN-1",
          disposition: "CONTRACT_INCONSISTENT",
          reason: "the finding conflicts with the approved plan",
        },
      ],
      user_authorization: "User explicitly rejected PLAN-1 as inconsistent with the plan",
    });
    assert.equal(adjudicated.phase, "REPAIR_REQUIRED");
    assert.deepEqual(adjudicated.repair_authorized_ids, []);
    assert.deepEqual(
      adjudicated.finding_adjudications.map((item: any) => item.finding_id),
      ["PLAN-1"],
    );
    assert.equal(adjudicated.finding_adjudications[0].finding_snapshot.finding_id, "PLAN-1");
    assert.equal(adjudicated.finding_adjudications[0].source_review_version, 3);
    assert.deepEqual(adjudicated.permitted_next_actions, [
      "workflow_adjudicate_findings",
      "workflow_authorize_repair",
      "workflow_expand_scope",
      "workflow_finalize_repair_exhausted",
    ]);
    store.authorizeRepair({
      workflow_id: id,
      capability: created.capability,
      expected_version: store.parentGet(id).version,
      finding_ids: ["REPAIR-1"],
    });
    assert.equal(
      implementation(store, created, undefined, "DONE", { "REPAIR-1": "resolved" }).phase,
      "REVIEWING",
    );
    writeFileSync(join(root, "note.txt"), "repaired\n");
    assert.equal(
      review(store, created, undefined, "APPROVED", [], [], {
        "REPAIR-1": "resolved",
        "PLAN-1": "superseded",
      }).phase,
      "STOPPED_APPROVED",
    );
    const audit = store.audit(id, created.capability);
    const event = audit.find((item: any) => item.event_type === "FINDINGS_ADJUDICATED");
    assert.ok(event);
    assert.equal(
      event.finding_adjudications[0].reason,
      "the finding conflicts with the approved plan",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("all blockers can be adjudicated directly into a fresh review", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git));
    const id = created.workflow.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    const blocker = finding("PLAN-ONLY");
    review(store, created, undefined, "CHANGES_REQUESTED", [blocker]);
    assert.equal(
      store.adjudicateFindings({
        workflow_id: id,
        capability: created.capability,
        expected_version: store.parentGet(id).version,
        findings: [
          {
            finding_id: "PLAN-ONLY",
            disposition: "OUTSIDE_APPROVED_SCOPE",
            reason: "the requested work is outside the approved scope",
          },
        ],
        user_authorization: "User explicitly authorized this disposition",
      }).phase,
      "REVIEWING",
    );
    assert.deepEqual(store.parentGet(id).permitted_next_actions, []);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    assert.equal(
      review(store, created, undefined, "APPROVED", [], [], { "PLAN-ONLY": "superseded" }).phase,
      "STOPPED_APPROVED",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mixed or reused adjudication IDs fail atomically", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git));
    const id = created.workflow.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    review(store, created, undefined, "CHANGES_REQUESTED", [finding("VALID"), finding("OTHER")]);
    const version = store.parentGet(id).version;
    const events = store.audit(id, created.capability).length;
    assert.equal(
      category(() =>
        store.adjudicateFindings({
          workflow_id: id,
          capability: created.capability,
          expected_version: version,
          findings: [
            {
              finding_id: "VALID",
              disposition: "CONTRACT_INCONSISTENT",
              reason: "valid reason",
            },
            {
              finding_id: "OPTIONAL",
              disposition: "OUTSIDE_APPROVED_SCOPE",
              reason: "not a current blocker",
            },
          ],
          user_authorization: "explicit authorization",
        }),
      ),
      "ERROR_INVALID_FINDING",
    );
    assert.equal(store.parentGet(id).version, version);
    assert.equal(store.audit(id, created.capability).length, events);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked follow-up inherits findings and gets its own singular parent capability", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const source = store.create(input(git));
    implementation(store, source);
    writeFileSync(join(root, "note.txt"), "source\n");
    const optional = finding("OPTIONAL-1", "P3", false);
    review(store, source, undefined, "APPROVED", [], [optional]);
    const child = store.createLinkedFollowup({
      workflow_id: source.workflow.workflow_id,
      capability: source.capability,
      expected_version: store.parentGet(source.workflow.workflow_id).version,
      objective: "authorized child",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["child criterion"],
      validation_requirements: [{ description: "child validation", argv: ["bun", "run", "check"] }],
      finding_ids: ["OPTIONAL-1"],
      user_authorization: "authorized remediation",
    });
    assert.equal(typeof child.capability, "string");
    assert.notEqual(child.capability, source.capability);
    assert.equal("capabilities" in child, false);
    assert.deepEqual(store.implementerGet(child.workflow.workflow_id).linked_findings, [optional]);
    assert.equal(store.parentGet(child.workflow.workflow_id).version, 0);
    assert.equal(
      store.audit(source.workflow.workflow_id, source.capability).at(-1).event_type,
      "LINKED_FOLLOWUP_CREATED",
    );
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
      workflow_id: created.workflow.workflow_id,
      capability: created.capability,
      expected_version: oldStore.parentGet(created.workflow.workflow_id).version,
      user_authorization: "authorize",
    });
    git("add", "note.txt");
    const prepared = oldStore.prepareCommit({
      workflow_id: created.workflow.workflow_id,
      expected_version: oldStore.parentGet(created.workflow.workflow_id).version,
    });
    assert.deepEqual(oldStore.parentGet(created.workflow.workflow_id).permitted_next_actions, []);
    assert.equal(
      category(() =>
        oldStore.reconcileCommitResult({
          workflow_id: created.workflow.workflow_id,
          capability: created.capability,
          expected_version: prepared.version,
          attempt_id: prepared.commit_preparation.attempt_id,
        }),
      ),
      "ERROR_COMMIT_NOT_ALLOWED",
    );
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
      category(() => preReconciliationReader.parentGet(created.workflow.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    preReconciliationReader.close();
    const reconciled = currentStore.reconcileCommitResult({
      workflow_id: created.workflow.workflow_id,
      capability: created.capability,
      expected_version: prepared.version,
      attempt_id: prepared.commit_preparation.attempt_id,
    });
    assert.equal(reconciled.phase, "COMMITTED");
    assert.equal(currentStore.parentGet(created.workflow.workflow_id).phase, "COMMITTED");
    const stateBeforeAuditCorruption = rawState(currentStore, created.workflow.workflow_id);
    const stateRowBeforeAuditCorruption = currentStore.db
      .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow.workflow_id);
    const reconciliationAudit = currentStore.db
      .prepare(
        "SELECT summary_json FROM audit_events WHERE workflow_id = ? AND version = ? AND event_type = 'COMMIT_RESULT_SUBMITTED'",
      )
      .get(created.workflow.workflow_id, reconciled.version) as
      | { summary_json: string }
      | undefined;
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
      .run(JSON.stringify(corruptedSummary), created.workflow.workflow_id, reconciled.version);
    assert.equal(corruption.changes, 1);
    assert.equal(
      category(() => currentStore.parentGet(created.workflow.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    const stateRowAfterAuditCorruption = currentStore.db
      .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow.workflow_id);
    assert.deepEqual(
      rawState(currentStore, created.workflow.workflow_id),
      stateBeforeAuditCorruption,
    );
    assert.deepEqual(stateRowAfterAuditCorruption, stateRowBeforeAuditCorruption);
    assert.equal(
      category(() => currentStore.implementerGet(created.workflow.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    assert.equal(
      category(() => currentStore.audit(created.workflow.workflow_id, created.capability)),
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
      oldReader
        .audit(created.workflow.workflow_id, created.capability)
        .map((event: any) => event.event_type),
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
          workflow_id: created.workflow.workflow_id,
          capability: created.capability,
          expected_version: reconciled.version,
          attempt_id: prepared.commit_preparation.attempt_id,
        }),
      ),
      "ERROR_INVALID_TRANSITION",
    );
    assert.equal(oldReader.audit(created.workflow.workflow_id, created.capability).length, 7);
    oldReader.close();
    currentStore.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked remediation and combined review retain receipts through a committed result", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const source = store.create(input(git));
    implementation(store, source);
    writeFileSync(join(root, "note.txt"), "source change\n");
    review(store, source, undefined, "APPROVED", [], [finding("LINKED-OPTIONAL", "P3", false)]);
    const child = store.createLinkedFollowup({
      workflow_id: source.workflow.workflow_id,
      capability: source.capability,
      expected_version: store.parentGet(source.workflow.workflow_id).version,
      objective: "linked remediation",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["child criterion"],
      validation_requirements: [{ description: "child validation", argv: ["bun", "run", "check"] }],
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
    const id = child.workflow.workflow_id;
    store.authorizeCommit({
      workflow_id: id,
      capability: child.capability,
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
    assert.equal(store.audit(id, child.capability).at(-1).event_type, "COMMIT_RESULT_SUBMITTED");
    store.close();
  } finally {
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
      workflow_id: created.workflow.workflow_id,
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
    const incompleteAudit = store.audit(created.workflow.workflow_id, created.capability)[1];
    assert.equal(incomplete.phase, "IMPLEMENTING");
    assert.equal(incomplete.version, 1);
    assert.equal(
      store
        .implementerGet(created.workflow.workflow_id)
        .implementation_summary.includes("extra.txt"),
      true,
    );
    const expanded = store.expandScope({
      workflow_id: created.workflow.workflow_id,
      capability: created.capability,
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
      store.parentGet(created.workflow.workflow_id),
      expanded,
      store.reviewerGet(created.workflow.workflow_id),
      rawState(store, created.workflow.workflow_id),
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
    assert.equal(rawState(store, created.workflow.workflow_id).implementation_receipt, null);
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
    assert.equal(
      "approved_path_baselines" in store.implementerGet(created.workflow.workflow_id),
      false,
    );
    assert.equal(expanded.implementation_receipt, undefined);
    assert.equal(expanded.phase, "IMPLEMENTING");
    assert.equal(expanded.version, 2);
    assert.equal(expanded.workflow_id, created.workflow.workflow_id);
    assert.equal(store.reviewerGet(created.workflow.workflow_id).implementation_summary, null);
    assert.equal(store.reviewerGet(created.workflow.workflow_id).implementation_status, null);
    assert.deepEqual(
      store.audit(created.workflow.workflow_id, created.capability)[1],
      incompleteAudit,
    );
    writeFileSync(join(root, "companion.txt"), "expanded companion\n");
    const implemented = implementation(store, { workflow: expanded }, undefined, "DONE", {}, [
      "companion.txt",
    ]);
    assert.equal(implemented.phase, "REVIEWING");
    assert.ok(rawState(store, created.workflow.workflow_id).implementation_receipt);
    const row: any = store.db
      .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(created.workflow.workflow_id);
    assert.equal(row.state_digest, objectDigest(JSON.parse(row.state_json)));
    const audit = store.audit(created.workflow.workflow_id, created.capability);
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
    assert.deepEqual(reopened.parentGet(created.workflow.workflow_id).approved_path_baselines, [
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
    assert.equal(reopened.parentGet(created.workflow.workflow_id).version, 3);
    assert.equal(
      reopened.implementerGet(created.workflow.workflow_id).implementation_status,
      "DONE",
    );
    assert.deepEqual(
      reopened.audit(created.workflow.workflow_id, created.capability)[1].summary,
      incompleteAudit.summary,
    );
    assert.equal(
      reopened.audit(created.workflow.workflow_id, created.capability).at(-2)?.event_type,
      "SCOPE_EXPANDED",
    );
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
      category(() => foreign.parentGet(created.workflow.workflow_id)),
      "ERROR_RUNTIME_ISOLATION",
    );
    assert.equal(
      category(() =>
        foreign.submitImplementation({
          workflow_id: created.workflow.workflow_id,
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
          { description: "manual validation", argv: null },
          { description: "exact validation", argv: ["bun", "run", "test"] },
        ],
      }),
    );
    const id = created.workflow.workflow_id;
    assert.equal(created.workflow.approved_plan, plan);
    assert.deepEqual(created.workflow.dirty_baseline_paths, ["note.txt", "planned.txt"]);
    assert.deepEqual(
      created.workflow.acceptance_criteria.map(({ criterion_id }: any) => criterion_id),
      ["AC-001", "AC-002"],
    );
    assert.deepEqual(
      created.workflow.validation_requirements.map(({ validation_id }: any) => validation_id),
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
          workflow_id: created.workflow.workflow_id,
          capability: created.capability,
          expected_version: 0,
          added_paths: ["note.txt"],
          reason: "tracked companion file",
          user_authorization: "authorized scope expansion",
        }),
      ),
      "ERROR_SCOPE_EXPANSION_DIRTY",
    );
    assert.equal(store.parentGet(created.workflow.workflow_id).version, 0);
    assert.equal(store.audit(created.workflow.workflow_id, created.capability).length, 1);
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
    const initial = rawState(store, created.workflow.workflow_id).initial_receipt;
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
    const reviewReceipt = rawState(store, created.workflow.workflow_id).review_receipt;
    assert.deepEqual(
      reviewReceipt.paths.map(({ path, state, kind }: any) => ({ path, state, kind })),
      initial.paths.map(({ path, state, kind }: any) => ({ path, state, kind })),
    );
    store.close();
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
    const id = created.workflow.workflow_id;
    const row = () =>
      store.db
        .prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(id);
    const createdRow = row();
    assert.equal(createdRow.state_digest, objectDigest(JSON.parse(createdRow.state_json)));
    implementation(store, created);
    const original = row();
    assert.equal(original.state_digest, objectDigest(JSON.parse(original.state_json)));
    const events = store.audit(id, created.capability);
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
    const id = created.workflow.workflow_id;
    const original = rawState(store, id);
    const invalid = { ...original, phase: "NOT_A_PHASE" };
    store.db
      .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
      .run(JSON.stringify(invalid), objectDigest(invalid), id);
    assert.equal(
      category(() => store.parentGet(id)),
      "ERROR_STATE_CORRUPT",
    );
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
    const id = created.workflow.workflow_id;
    const readAudit = () => store.audit(id, created.capability);
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
    assert.equal(
      category(() => store.audit(id, "not-the-parent-capability")),
      "ERROR_CAPABILITY_DENIED",
    );

    const serialized = JSON.stringify(readAudit());
    for (const prohibited of [
      "SECRET-AUDIT-OBJECTIVE",
      "note.txt",
      created.capability,
      "implementation evidence",
    ]) {
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

test("commit preparation failures distinguish staged scope, stale review, and retry recovery", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const first = authorized(store, root, git, { objective: "scope failure" });
    const failed = store.prepareCommit({
      workflow_id: first.id,
      expected_version: store.parentGet(first.id).version,
    });
    assert.equal(failed.phase, "STOPPED_COMMIT_PREPARATION");
    assert.equal(failed.stop_context.category, "ERROR_STAGED_SCOPE");
    assert.equal(failed.stop_context.recovery, "retry");
    assert.deepEqual(store.parentGet(first.id).permitted_next_actions, [
      "workflow_retry_commit_preparation",
    ]);
    git("add", "note.txt");
    const retried = store.retryCommitPreparation({
      workflow_id: first.id,
      capability: first.created.capability,
      expected_version: store.parentGet(first.id).version,
      retry_context: "stage the reviewed path",
    });
    assert.equal(retried.phase, "COMMIT_AUTHORIZED");
    const prepared = store.prepareCommit({
      workflow_id: first.id,
      expected_version: store.parentGet(first.id).version,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");

    const second = authorized(store, root, git, { objective: "stale review" });
    writeFileSync(join(root, "note.txt"), "changed after approval\n");
    const stale = store.prepareCommit({
      workflow_id: second.id,
      expected_version: store.parentGet(second.id).version,
    });
    assert.equal(stale.phase, "STOPPED_COMMIT_PREPARATION");
    assert.equal(stale.stop_context.category, "ERROR_STALE_RECEIPT");
    assert.equal(stale.stop_context.recovery, "review");
    assert.deepEqual(store.parentGet(second.id).permitted_next_actions, [
      "workflow_return_commit_to_review",
    ]);
    const returned = store.returnCommitToReview({
      workflow_id: second.id,
      capability: second.created.capability,
      expected_version: store.parentGet(second.id).version,
      review_context: "review changed worktree",
    });
    assert.equal(returned.phase, "REVIEWING");
    assert.equal(returned.commit_authorization, null);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit preparation store matrix preserves Git state and routes every failure", () => {
  const scopeCases = [
    {
      name: "empty",
      stage: (_git: (...args: string[]) => string, _root: string) => {},
    },
    {
      name: "partial",
      stage: (git: (...args: string[]) => string) => git("add", "note.txt"),
    },
    {
      name: "extra and untracked",
      stage: (git: (...args: string[]) => string, root: string) => {
        writeFileSync(join(root, "untracked.txt"), "untracked\n");
        git("add", "note.txt", "other.txt", "untracked.txt");
      },
    },
  ];
  for (const candidate of scopeCases) {
    const { root, git } = fixture();
    let store: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath: candidate.name === "empty" ? join(root, "matrix.sqlite") : ":memory:",
    });
    try {
      const workflow = authorized(store, root, git, {
        objective: `scope ${candidate.name}`,
        approved_paths: ["note.txt", "other.txt"],
      });
      candidate.stage(git, root);
      const id = workflow.id;
      const headBefore = git("rev-parse", "HEAD");
      const statusBefore = git("status", "--porcelain");
      const stagedBefore = git("diff", "--cached", "--name-status");
      const stopped = store.prepareCommit({
        workflow_id: id,
        expected_version: store.parentGet(id).version,
      });
      assert.equal(stopped.phase, "STOPPED_COMMIT_PREPARATION", candidate.name);
      assert.equal(stopped.stop_context.category, "ERROR_STAGED_SCOPE", candidate.name);
      assert.equal(stopped.stop_context.recovery, "retry", candidate.name);
      assert.equal(stopped.commit_preparation, null);
      assert.equal(stopped.commit_result, null);
      assert.equal(git("rev-parse", "HEAD"), headBefore, candidate.name);
      assert.equal(git("status", "--porcelain"), statusBefore, candidate.name);
      assert.equal(git("diff", "--cached", "--name-status"), stagedBefore, candidate.name);
      assert.deepEqual(store.parentGet(id).permitted_next_actions, [
        "workflow_retry_commit_preparation",
      ]);
      if (candidate.name === "empty") {
        const version = stopped.version;
        store.close();
        store = new WorkflowStore({
          repositoryRoot: root,
          databasePath: join(root, "matrix.sqlite"),
        });
        assert.equal(store.parentGet(id).version, version);
        assert.equal(
          store.audit(id, workflow.created.capability).at(-1).event_type,
          "COMMIT_PREPARATION_FAILED",
        );
      }
      const retried = store.retryCommitPreparation({
        workflow_id: id,
        capability: workflow.created.capability,
        expected_version: store.parentGet(id).version,
        retry_context: `repair ${candidate.name}`,
      });
      assert.equal(retried.phase, "COMMIT_AUTHORIZED", candidate.name);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  const contentAndModeCases = [
    {
      name: "content",
      mutate: (root: string, git: (...args: string[]) => string) => {
        const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
          input: "tampered\n",
          encoding: "utf8",
        }).trim();
        git("update-index", "--cacheinfo", "100644", blob, "note.txt");
      },
    },
    {
      name: "mode",
      mutate: (_root: string, git: (...args: string[]) => string) =>
        git("update-index", "--chmod=+x", "note.txt"),
    },
  ];
  for (const candidate of contentAndModeCases) {
    const { root, git } = fixture();
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    try {
      const workflow = authorized(store, root, git, { objective: candidate.name });
      git("add", "note.txt");
      candidate.mutate(root, git);
      const headBefore = git("rev-parse", "HEAD");
      const statusBefore = git("status", "--porcelain");
      const stopped = store.prepareCommit({
        workflow_id: workflow.id,
        expected_version: store.parentGet(workflow.id).version,
      });
      assert.equal(stopped.stop_context.category, "ERROR_STAGED_CONTENT", candidate.name);
      assert.equal(stopped.stop_context.recovery, "retry", candidate.name);
      assert.equal(git("rev-parse", "HEAD"), headBefore, candidate.name);
      assert.equal(git("status", "--porcelain"), statusBefore, candidate.name);
      assert.deepEqual(store.parentGet(workflow.id).permitted_next_actions, [
        "workflow_retry_commit_preparation",
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  const staleCases = [
    {
      name: "stale receipt",
      mutate: (root: string, _git: (...args: string[]) => string) =>
        writeFileSync(join(root, "note.txt"), "changed after approval\n"),
    },
    {
      name: "changed HEAD",
      mutate: (_root: string, git: (...args: string[]) => string) =>
        git("commit", "--allow-empty", "-qm", "external head"),
    },
  ];
  for (const candidate of staleCases) {
    const { root, git } = fixture();
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    try {
      const workflow = authorized(store, root, git, { objective: candidate.name });
      candidate.mutate(root, git);
      const stopped = store.prepareCommit({
        workflow_id: workflow.id,
        expected_version: store.parentGet(workflow.id).version,
      });
      assert.equal(stopped.stop_context.category, "ERROR_STALE_RECEIPT", candidate.name);
      assert.equal(stopped.stop_context.recovery, "review", candidate.name);
      assert.deepEqual(store.parentGet(workflow.id).permitted_next_actions, [
        "workflow_return_commit_to_review",
      ]);
      const returned = store.returnCommitToReview({
        workflow_id: workflow.id,
        capability: workflow.created.capability,
        expected_version: store.parentGet(workflow.id).version,
        review_context: `refresh ${candidate.name}`,
      });
      assert.equal(returned.phase, "REVIEWING", candidate.name);
      assert.equal(returned.commit_authorization, null, candidate.name);
      assert.equal(returned.review_receipt, undefined, candidate.name);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "range.txt"), "range\n");
    git("add", "range.txt");
    git("commit", "-qm", "range head");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const range = store.create(
      input(git, {
        workflow_type: "review_only",
        approved_paths: ["range.txt"],
        validation_requirements: [],
        review_target: {
          review_mode: "commit_range",
          base_revision: base,
          head_revision: head,
          approved_paths: ["range.txt"],
          include_staged: false,
          include_unstaged: false,
          include_untracked: false,
        },
      }),
    );
    const rangeId = range.workflow.workflow_id;
    store.submitReview({
      workflow_id: rangeId,
      expected_version: store.parentGet(rangeId).version,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    const beforeVersion = store.parentGet(rangeId).version;
    const beforeAudit = store.audit(rangeId, range.capability);
    assert.equal(
      category(() =>
        store.prepareCommit({
          workflow_id: rangeId,
          expected_version: beforeVersion,
        }),
      ),
      "ERROR_COMMIT_NOT_ALLOWED",
    );
    assert.equal(store.parentGet(rangeId).version, beforeVersion);
    assert.deepEqual(store.audit(rangeId, range.capability), beforeAudit);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit result rejects malformed claims and records terminal verification mismatches", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const first = authorized(store, root, git, { objective: "result validation" });
    git("add", "note.txt");
    const prepared = store.prepareCommit({
      workflow_id: first.id,
      expected_version: store.parentGet(first.id).version,
    });
    const submit = (overrides: any = {}) =>
      store.submitCommitResult({
        workflow_id: first.id,
        expected_version: store.parentGet(first.id).version,
        attempt_id: prepared.commit_preparation.attempt_id,
        outcome: "committed",
        failure_summary: null,
        ...overrides,
      });
    assert.equal(
      category(() => submit({ outcome: "mismatch" })),
      "ERROR_INVALID_SHAPE",
    );
    assert.equal(
      category(() => submit({ outcome: "committed", failure_summary: "unexpected" })),
      "ERROR_INVALID_SHAPE",
    );
    assert.equal(
      category(() => submit({ attempt_id: "0".repeat(36) })),
      "ERROR_COMMIT_MISMATCH",
    );
    const before = store.parentGet(first.id).version;
    assert.equal(store.parentGet(first.id).version, before);

    git("commit", "-qm", "unexpected head");
    git("commit", "--allow-empty", "-qm", "unexpected second head");
    const mismatch = submit();
    assert.equal(mismatch.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(mismatch.commit_result.mismatch_category, "PARENT_MISMATCH");
    assert.deepEqual(store.parentGet(first.id).permitted_next_actions, []);
    assert.equal(
      category(() =>
        store.retryCommit({
          workflow_id: first.id,
          capability: first.created.capability,
          expected_version: store.parentGet(first.id).version,
          retry_context: "cannot retry terminal mismatch",
        }),
      ),
      "ERROR_INVALID_TRANSITION",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit verification distinguishes every prepared-result mismatch and preserves terminal guards", () => {
  const cases = [
    {
      name: "HEAD_CHANGED",
      mutate: (_root: string, _git: (...args: string[]) => string) => {},
      outcome: "committed",
      expected: "HEAD_CHANGED",
    },
    {
      name: "TREE_MISMATCH",
      mutate: (root: string, git: (...args: string[]) => string) => {
        writeFileSync(join(root, "note.txt"), "tree changed after preparation\n");
        git("add", "note.txt");
        git("commit", "-qm", "tree mismatch");
      },
      outcome: "committed",
      expected: "TREE_MISMATCH",
    },
    {
      name: "PATH_MISMATCH",
      mutate: (_root: string, _git: (...args: string[]) => string, store: any, id: string) => {
        const state = rawState(store, id);
        _git("commit", "-qm", "path mismatch source");
        state.commit_preparation.expected_paths = ["other.txt"];
        store.db
          .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
          .run(JSON.stringify(state), objectDigest(state), id);
      },
      outcome: "committed",
      expected: "PATH_MISMATCH",
    },
    {
      name: "changed-head not-committed",
      mutate: (_root: string, git: (...args: string[]) => string) => {
        git("commit", "--allow-empty", "-qm", "head changed before failure report");
      },
      outcome: "not_committed",
      expected: "HEAD_CHANGED",
    },
  ];
  for (const candidate of cases) {
    const { root, git } = fixture();
    try {
      const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
      const authorizedWorkflow = authorized(store, root, git, { objective: candidate.name });
      git("add", "note.txt");
      const prepared = store.prepareCommit({
        workflow_id: authorizedWorkflow.id,
        expected_version: store.parentGet(authorizedWorkflow.id).version,
      });
      candidate.mutate(root, git, store, authorizedWorkflow.id);
      const result = store.submitCommitResult({
        workflow_id: authorizedWorkflow.id,
        expected_version: store.parentGet(authorizedWorkflow.id).version,
        attempt_id: prepared.commit_preparation.attempt_id,
        outcome: candidate.outcome,
        failure_summary: candidate.outcome === "committed" ? null : "external commit failed",
      });
      assert.equal(result.phase, "STOPPED_COMMIT_MISMATCH", candidate.name);
      assert.equal(result.commit_result.mismatch_category, candidate.expected, candidate.name);
      assert.deepEqual(store.parentGet(authorizedWorkflow.id).permitted_next_actions, []);
      assert.equal(
        category(() =>
          store.retryCommit({
            workflow_id: authorizedWorkflow.id,
            capability: authorizedWorkflow.created.capability,
            expected_version: store.parentGet(authorizedWorkflow.id).version,
            retry_context: "terminal mismatch cannot retry",
          }),
        ),
        "ERROR_INVALID_TRANSITION",
        candidate.name,
      );
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("post-commit hook-created extra commits are rejected as a parent mismatch", () => {
  const { root, git } = fixture();
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(root, ".git", "hooks", "post-commit"),
      "#!/bin/sh\nif [ ! -f .hook-ran ]; then\n  touch .hook-ran\n  git commit --allow-empty -qm 'hook extra commit'\nfi\n",
    );
    chmodSync(join(root, ".git", "hooks", "post-commit"), 0o755);
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const authorizedWorkflow = authorized(store, root, git, { objective: "hook extra commit" });
    git("add", "note.txt");
    const prepared = store.prepareCommit({
      workflow_id: authorizedWorkflow.id,
      expected_version: store.parentGet(authorizedWorkflow.id).version,
    });
    git("commit", "-qm", "primary commit");
    const result = store.submitCommitResult({
      workflow_id: authorizedWorkflow.id,
      expected_version: store.parentGet(authorizedWorkflow.id).version,
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "committed",
      failure_summary: null,
    });
    assert.equal(result.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(result.commit_result.mismatch_category, "PARENT_MISMATCH");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit preparation binds exact modify, add, delete, and mode paths", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "mod.txt"), "before\n");
    writeFileSync(join(root, "del.txt"), "delete\n");
    writeFileSync(join(root, "mode.txt"), "mode\n");
    git("add", ".");
    git("commit", "-qm", "preparation fixture");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const approvedPaths = ["add.txt", "del.txt", "mod.txt", "mode.txt"];
    const created = store.create(input(git, { approved_paths: approvedPaths }));
    const id = created.workflow.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "mod.txt"), "after\n");
    writeFileSync(join(root, "add.txt"), "added\n");
    unlinkSync(join(root, "del.txt"));
    chmodSync(join(root, "mode.txt"), 0o755);
    review(store, created);
    store.authorizeCommit({
      workflow_id: id,
      capability: created.capability,
      expected_version: store.parentGet(id).version,
      user_authorization: "exact preparation",
    });
    for (const path of approvedPaths) git("add", path);
    const tree = git("write-tree");
    const prepared = store.prepareCommit({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    assert.deepEqual(prepared.commit_preparation.expected_paths, approvedPaths);
    assert.equal(prepared.commit_preparation.prepared_tree, tree);
    assert.equal(git("rev-parse", "HEAD"), created.workflow.base_head);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function runtimeAttestation(runtimeId: string, revision: string, key = "2".repeat(64)) {
  const nonce = "1".repeat(64);
  return {
    runtimeAttestation: createRuntimeAttestation(runtimeId, revision, nonce, key),
    runtimeAttestationNonce: nonce,
    runtimeAttestationKey: key,
  };
}
