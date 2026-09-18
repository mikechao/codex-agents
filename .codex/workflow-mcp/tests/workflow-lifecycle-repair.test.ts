import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowStore } from "../store.js";
import { MAX_PATHS } from "../validation.js";
import { fixture } from "./test-fixtures.js";
import {
  category,
  currentVersion,
  finding,
  implementation,
  input,
  rawState,
  repairDirectiveFor,
  review,
  reviewerValidationResults,
} from "./workflow-test-helpers.js";

test("repair retains only manually observed evidence with proven-disjoint exact-path dependencies", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "other.txt"), "other baseline\n");
    git("add", "other.txt");
    git("commit", "-m", "add second validation surface");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(
      input(git, {
        approved_paths: ["note.txt", "other.txt"],
        max_repair_cycles: 2,
        validation_requirements: [
          {
            description: "inspect note",
            kind: "inspection",
            dependencies: { kind: "repository_paths", paths: ["note.txt"] },
          },
          {
            description: "inspect other",
            kind: "inspection",
            dependencies: { kind: "repository_paths", paths: ["other.txt"] },
          },
        ],
      }),
    );
    const id = created.workflow_id;
    const submit = (status: "DONE" | "INCOMPLETE", resolution: Record<string, string> = {}) =>
      store.submitImplementation({
        workflow_id: id,
        expected_version: currentVersion(store, id),
        status,
        summary: "repair submission",
        agent_touched_paths: [],
        acceptance_results: [
          { criterion_id: "AC-001", status: "satisfied", evidence: "satisfied" },
        ],
        validation_results: [
          { validation_id: "VAL-001", status: "not_run", evidence: "parent-owned" },
          { validation_id: "VAL-002", status: "not_run", evidence: "parent-owned" },
        ],
        known_failures: status === "DONE" ? [] : ["repair remains in progress"],
        finding_resolution_map: resolution,
      });

    submit("DONE");
    for (const validationId of ["VAL-001", "VAL-002"]) {
      store.recordManualValidation({
        workflow_id: id,
        expected_version: currentVersion(store, id),
        validation_id: validationId,
        status: "passed",
        evidence: `${validationId} observed`,
      });
    }
    const observed = rawState(store, id).validation_results;
    assert.equal(observed[0].manual_lifecycle.dependency_receipt.approved_paths[0], "note.txt");
    assert.equal(
      "dependency_receipt" in store.parentGet(id).validation_results[0].manual_lifecycle,
      false,
    );
    for (const view of [store.implementerGet(id), store.reviewerGet(id), store.committerGet(id)]) {
      assert.equal(
        "dependency_receipt" in view.validation_results[0].manual_lifecycle,
        false,
        "worker validation projections must redact dependency receipts",
      );
    }

    review(store, created, undefined, "CHANGES_REQUESTED", [finding("REPAIR-1")]);
    store.authorizeRepair({
      workflow_id: id,
      expected_version: currentVersion(store, id),
      finding_ids: ["REPAIR-1"],
      repair_directive: repairDirectiveFor(store, id, ["REPAIR-1"]),
    });
    writeFileSync(join(root, "note.txt"), "first repair\n");
    submit("INCOMPLETE", { "REPAIR-1": "still_present" });
    assert.deepEqual(
      rawState(store, id).validation_results.map((result: any) => result.status),
      ["passed", "passed"],
    );
    submit("DONE", { "REPAIR-1": "resolved" });
    let results = store.parentGet(id).validation_results;
    assert.equal(results[0].status, "not_run");
    assert.equal(results[0].manual_lifecycle.reason, "dependency_intersection");
    assert.deepEqual(results[0].manual_lifecycle.affected_paths, ["note.txt"]);
    assert.equal(results[1].status, "passed");
    assert.equal(results[1].manual_lifecycle.retained_at.length, 1);
    const firstDecision = store.audit(id).at(-1).manual_validation_repair_decision;
    assert.deepEqual(
      firstDecision.retained.map((item: any) => item.validation_id),
      ["VAL-002"],
    );
    assert.deepEqual(
      firstDecision.stale.map((item: any) => item.validation_id),
      ["VAL-001"],
    );
    assert.equal(
      firstDecision.retained[0].baseline_dependency_digest,
      firstDecision.retained[0].repaired_dependency_digest,
    );
    assert.notEqual(
      firstDecision.stale[0].baseline_dependency_digest,
      firstDecision.stale[0].repaired_dependency_digest,
    );
    assert.match(firstDecision.retained[0].baseline_dependency_digest, /^[0-9a-f]{64}$/u);

    assert.equal(store.operatorDecisionGet(id).primary.validations[0].evidence_state, "stale");
    store.recordManualValidation({
      workflow_id: id,
      expected_version: currentVersion(store, id),
      validation_id: "VAL-001",
      status: "passed",
      evidence: "note recollected",
    });
    review(store, created, undefined, "CHANGES_REQUESTED", [finding("REPAIR-2")], [], {
      "REPAIR-1": "resolved",
    });
    store.authorizeRepair({
      workflow_id: id,
      expected_version: currentVersion(store, id),
      finding_ids: ["REPAIR-2"],
      repair_directive: repairDirectiveFor(store, id, ["REPAIR-2"]),
    });
    writeFileSync(join(root, "other.txt"), "second repair\n");
    submit("DONE", { "REPAIR-2": "resolved" });
    results = store.parentGet(id).validation_results;
    assert.equal(results[0].status, "passed");
    assert.equal(results[0].manual_lifecycle.retained_at.length, 1);
    assert.equal(results[1].status, "not_run");
    assert.equal(results[1].manual_lifecycle.reason, "dependency_intersection");
    const retainedAudit = store
      .audit(id)
      .find(
        (event: any) => event.version === firstDecision.submission_version,
      ).manual_validation_repair_decision;
    assert.equal(
      retainedAudit.retained[0].baseline_dependency_digest,
      firstDecision.retained[0].baseline_dependency_digest,
    );
    assert.equal(
      retainedAudit.retained[0].repaired_dependency_digest,
      firstDecision.retained[0].repaired_dependency_digest,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incomplete implementation attempts stay active and preserve repair authorization", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow_id;
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
        acceptance_results: created.acceptance_criteria.map(
          ({ criterion_id }: { criterion_id: string }) => ({
            criterion_id,
            status: options.criterion ?? "satisfied",
            evidence: "acceptance evidence",
          }),
        ),
        validation_results: created.validation_requirements.map(
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
      store.audit(id).map((event: any) => event.event_type),
      ["WORKFLOW_CREATED", "IMPLEMENTATION_INCOMPLETE"],
    );
    assert.equal(store.audit(id).at(-1).summary.outcome, "IMPLEMENTING");
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
      expected_version: store.parentGet(id).version,
      finding_ids: ["REPAIR-1"],
      repair_directive: repairDirectiveFor(store, id, ["REPAIR-1"], "authorize repair"),
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
    assert.equal(repairing.validation_results[0].status, "not_run");
    assert.equal("manual_lifecycle" in repairing.validation_results[0], false);
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
    const id = created.workflow_id;
    const concern = (criterion: "satisfied" | "not_satisfied") =>
      store.submitImplementation({
        workflow_id: id,
        expected_version: store.parentGet(id).version,
        status: "DONE_WITH_CONCERNS",
        summary: "approved work complete with external validation exception",
        agent_touched_paths: [],
        acceptance_results: created.acceptance_criteria.map(
          ({ criterion_id }: { criterion_id: string }) => ({
            criterion_id,
            status: criterion,
            evidence: "acceptance evidence",
          }),
        ),
        validation_results: created.validation_requirements.map(
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

test("repair and re-review use authoritative expected versions", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow_id;
    implementation(store, created);
    const blocker = finding("REPAIR-1");
    assert.equal(
      review(store, created, undefined, "CHANGES_REQUESTED", [blocker]).phase,
      "REPAIR_REQUIRED",
    );
    assert.equal(
      store.authorizeRepair({
        workflow_id: id,
        expected_version: store.parentGet(id).version,
        finding_ids: ["REPAIR-1"],
        repair_directive: repairDirectiveFor(store, id, ["REPAIR-1"], "authorize repair"),
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
    assert.deepEqual(store.parentGet(id).permitted_next_actions, ["workflow_authorize_commit"]);
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
    const id = created.workflow_id;
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
    ]);
    assert.equal(adjudicated.committed_execution.descriptor_version, 5);
    assert.deepEqual(adjudicated.committed_execution.primary.repair_binding, {
      eligible_finding_ids: ["REPAIR-1"],
      selected_finding_ids: ["REPAIR-1"],
      proposal: adjudicated.committed_execution.primary.repair_binding.proposal,
    });
    store.authorizeRepair({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
      finding_ids: ["REPAIR-1"],
      repair_directive: repairDirectiveFor(store, id, ["REPAIR-1"], "authorize repair"),
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
    const audit = store.audit(id);
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

test("repair authorization persists a bounded directive and rejects scope expansion", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    review(store, created, undefined, "CHANGES_REQUESTED", [finding("DIRECTIVE-1")]);
    const valid = repairDirectiveFor(store, id, ["DIRECTIVE-1"]);
    const version = store.parentGet(id).version;
    const events = store.audit(id).length;
    const altered = { ...valid, required_outcome: `${valid.required_outcome} altered` };
    assert.equal(
      category(() =>
        store.authorizeRepair({
          workflow_id: id,
          expected_version: version,
          finding_ids: ["DIRECTIVE-1"],
          repair_directive: altered,
        }),
      ),
      "ERROR_INVALID_REPAIR",
    );
    assert.equal(store.parentGet(id).version, version);
    assert.equal(store.audit(id).length, events);
    for (const changed of [
      { strategy_constraints: `${valid.strategy_constraints} altered` },
      { fallbacks: [{ strategy: "different", condition: "still bounded" }] },
      { required_paths: ["note.txt"] },
      { forbidden_paths: ["note.txt"] },
    ]) {
      assert.equal(
        category(() =>
          store.authorizeRepair({
            workflow_id: id,
            expected_version: version,
            finding_ids: ["DIRECTIVE-1"],
            repair_directive: { ...valid, ...changed },
          }),
        ),
        "ERROR_INVALID_REPAIR",
      );
      assert.equal(store.parentGet(id).version, version);
      assert.equal(store.audit(id).length, events);
    }
    assert.equal(
      category(() =>
        store.authorizeRepair({
          workflow_id: id,
          expected_version: version,
          finding_ids: ["DIRECTIVE-1"],
          repair_directive: { ...valid, required_paths: ["outside.txt"] },
        }),
      ),
      "ERROR_INVALID_REPAIR",
    );
    assert.equal(store.parentGet(id).version, version);
    const repairing = store.authorizeRepair({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
      finding_ids: ["DIRECTIVE-1"],
      repair_directive: valid,
    });
    const { selected_finding_ids: _selectedFindingIds, ...persistedDirective } = valid;
    assert.deepEqual(repairing.repair_directive, persistedDirective);
    assert.deepEqual(store.implementerGet(id).repair_directive, persistedDirective);
    assert.deepEqual(store.reviewerGet(id).repair_authorized_ids, ["DIRECTIVE-1"]);
    assert.deepEqual(store.reviewerGet(id).repair_directive, persistedDirective);
    assert.deepEqual(repairing.committed_execution.primary, {
      mode: "dispatch",
      route: "implement",
      operation: "workflow_submit_implementation",
      workflow_id: id,
      expected_version: version + 1,
    });
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair authorization accepts an exact subset of multiple current blockers", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    review(store, created, undefined, "CHANGES_REQUESTED", [
      finding("SUBSET-1"),
      finding("SUBSET-2"),
    ]);
    const eligible = store.operatorDecisionGet(id);
    assert.equal(eligible.primary.kind, "approve_exact_repairs");
    if (eligible.primary.kind !== "approve_exact_repairs")
      throw new Error("expected all-blocker repair proposal");
    assert.deepEqual(eligible.execution.primary.repair_binding.eligible_finding_ids, [
      "SUBSET-1",
      "SUBSET-2",
    ]);
    const selected = store.operatorDecisionGet(id, ["SUBSET-1"]);
    assert.equal(selected.primary.kind, "approve_exact_repairs");
    if (selected.primary.kind !== "approve_exact_repairs")
      throw new Error("expected selected repair proposal");
    assert.equal(
      selected.primary.proposal.required_outcome,
      "Resolve the selected blocking finding without changing the approved intent.",
    );
    const version = store.parentGet(id).version;
    const events = store.audit(id).length;
    const selectedForFirstBlocker = {
      selected_finding_ids: selected.execution.primary.repair_binding.selected_finding_ids,
      ...selected.primary.proposal,
      user_authorization: "authorize subset",
    };
    assert.deepEqual(
      selected.primary.proposal,
      store.operatorDecisionGet(id, ["SUBSET-2"]).primary.proposal,
    );
    assert.equal(
      category(() =>
        store.authorizeRepair({
          workflow_id: id,
          expected_version: version,
          finding_ids: ["SUBSET-2"],
          repair_directive: selectedForFirstBlocker,
        }),
      ),
      "ERROR_INVALID_REPAIR",
    );
    assert.equal(store.parentGet(id).version, version);
    assert.equal(store.audit(id).length, events);
    assert.equal(
      category(() =>
        store.authorizeRepair({
          workflow_id: id,
          expected_version: version,
          finding_ids: ["SUBSET-1"],
          repair_directive: {
            selected_finding_ids: eligible.execution.primary.repair_binding.selected_finding_ids,
            ...eligible.primary.proposal,
            user_authorization: "authorize subset",
          },
        }),
      ),
      "ERROR_INVALID_REPAIR",
    );
    assert.equal(store.parentGet(id).version, version);
    assert.equal(store.audit(id).length, events);
    const repairing = store.authorizeRepair({
      workflow_id: id,
      expected_version: version,
      finding_ids: ["SUBSET-1"],
      repair_directive: {
        selected_finding_ids: selected.execution.primary.repair_binding.selected_finding_ids,
        ...selected.primary.proposal,
        user_authorization: "authorize subset",
      },
    });
    assert.equal(repairing.phase, "REPAIRING");
    assert.deepEqual(repairing.repair_authorized_ids, ["SUBSET-1"]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair re-review requires explicit conforming evidence before approval", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const created = store.create(input(git, { max_repair_cycles: 1 }));
    const id = created.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    review(store, created, undefined, "CHANGES_REQUESTED", [finding("CONFORMANCE-1")]);
    store.authorizeRepair({
      workflow_id: id,
      expected_version: store.parentGet(id).version,
      finding_ids: ["CONFORMANCE-1"],
      repair_directive: repairDirectiveFor(store, id, ["CONFORMANCE-1"]),
    });
    implementation(store, created, undefined, "DONE", { "CONFORMANCE-1": "resolved" });
    const begin = store.parentGet(id).version;
    store.beginReview({ workflow_id: id, expected_version: begin });
    const submit = (repairConformance?: any) =>
      store.submitReview({
        workflow_id: id,
        expected_version: store.parentGet(id).version,
        review_status: "APPROVED",
        blocking_findings: [],
        optional_findings: [],
        prior_finding_classifications: { "CONFORMANCE-1": "resolved" },
        validation_results: reviewerValidationResults(created),
        ...(repairConformance === undefined ? {} : { repair_conformance: repairConformance }),
      });
    assert.equal(
      category(() => submit()),
      "ERROR_INVALID_REVIEW",
    );
    assert.equal(
      category(() =>
        submit({ status: "nonconforming", evidence: "required path was not reviewed" }),
      ),
      "ERROR_INVALID_REVIEW",
    );
    const approved = submit({
      status: "conforming",
      evidence: "required path and strategy constraints match the repair directive",
    });
    assert.equal(approved.phase, "STOPPED_APPROVED");
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
    const id = created.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    const blocker = finding("PLAN-ONLY");
    review(store, created, undefined, "CHANGES_REQUESTED", [blocker]);
    const decision = store.operatorDecisionGet(id);
    const adjudication = decision.execution.parent_actions.find(
      (action: any) => action.action === "workflow_adjudicate_findings",
    );
    assert.ok(adjudication && adjudication.status === "executable");
    if (adjudication?.status !== "executable")
      throw new Error("expected separately advertised adjudication alternative");
    const invocation = adjudication.descriptor.invocations[0];
    assert.deepEqual(invocation?.adjudication_binding?.finding_ids, ["PLAN-ONLY"]);
    assert.deepEqual(invocation?.required_inputs, [
      { path: ["findings", "*", "finding_id"], source: "server_derived", required: true },
      { path: ["findings", "*", "disposition"], source: "user_authored", required: true },
      { path: ["findings", "*", "reason"], source: "user_authored", required: true },
    ]);
    const serverBoundFindings = invocation?.adjudication_binding?.finding_ids.map(
      (finding_id: string) => ({
        finding_id,
        disposition: "OUTSIDE_APPROVED_SCOPE",
        reason: "the requested work is outside the approved scope",
      }),
    );
    assert.equal(
      store.adjudicateFindings({
        ...invocation?.fixed_arguments,
        findings: serverBoundFindings,
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
    const id = created.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    review(store, created, undefined, "CHANGES_REQUESTED", [finding("VALID"), finding("OTHER")]);
    const version = store.parentGet(id).version;
    const events = store.audit(id).length;
    assert.equal(
      category(() =>
        store.adjudicateFindings({
          workflow_id: id,
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
    assert.equal(store.audit(id).length, events);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked follow-up inherits findings and gets a direct parent view", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const source = store.create(input(git));
    implementation(store, source);
    writeFileSync(join(root, "note.txt"), "source\n");
    const optional = finding("OPTIONAL-1", "P3", false);
    review(store, source, undefined, "APPROVED", [], [optional]);
    const sourceBeforeFollowup = rawState(store, source.workflow_id);
    const child = store.createLinkedFollowup({
      workflow_id: source.workflow_id,
      expected_version: store.parentGet(source.workflow_id).version,
      objective: "authorized child",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["child criterion"],
      validation_requirements: [
        { description: "child validation", kind: "command", argv: ["bun", "run", "check"] },
      ],
      finding_ids: ["OPTIONAL-1"],
      user_authorization: "authorized remediation",
    });
    assert.equal("capability" in child, false);
    assert.equal("capabilities" in child, false);
    assert.deepEqual(store.implementerGet(child.workflow_id).linked_findings, [optional]);
    assert.equal(store.parentGet(child.workflow_id).version, 0);
    const sourceAfterFollowup = rawState(store, source.workflow_id);
    assert.deepEqual(
      {
        ...sourceAfterFollowup,
        version: sourceBeforeFollowup.version,
        superseded_by_workflow_id: sourceBeforeFollowup.superseded_by_workflow_id,
      },
      sourceBeforeFollowup,
    );
    assert.equal(sourceAfterFollowup.version, sourceBeforeFollowup.version + 1);
    assert.equal(sourceAfterFollowup.superseded_by_workflow_id, child.workflow_id);
    const childState = rawState(store, child.workflow_id);
    assert.deepEqual(
      {
        implementation_summary: childState.implementation_summary,
        implementation_status: childState.implementation_status,
        implementation_known_failures: childState.implementation_known_failures,
        agent_touched_paths: childState.agent_touched_paths,
        scope_changed_paths: childState.scope_changed_paths,
        acceptance_results: childState.acceptance_results,
        validation_results: childState.validation_results,
        finding_resolution_map: childState.finding_resolution_map,
        implementation_receipt: childState.implementation_receipt,
        review_start_receipt: childState.review_start_receipt,
        review_receipt: childState.review_receipt,
        blocking_findings: childState.blocking_findings,
        optional_findings: childState.optional_findings,
        prior_finding_classifications: childState.prior_finding_classifications,
        finding_adjudications: childState.finding_adjudications,
        review_result_version: childState.review_result_version,
        repair_authorized_ids: childState.repair_authorized_ids,
        repair_directive: childState.repair_directive,
        concern_acceptance: childState.concern_acceptance,
        commit_authorization: childState.commit_authorization,
        commit_preparation: childState.commit_preparation,
        commit_result: childState.commit_result,
      },
      {
        implementation_summary: null,
        implementation_status: null,
        implementation_known_failures: [],
        agent_touched_paths: [],
        scope_changed_paths: [],
        acceptance_results: [],
        validation_results: [],
        finding_resolution_map: {},
        implementation_receipt: null,
        review_start_receipt: null,
        review_receipt: null,
        blocking_findings: [],
        optional_findings: [],
        prior_finding_classifications: {},
        finding_adjudications: [],
        review_result_version: null,
        repair_authorized_ids: [],
        repair_directive: null,
        concern_acceptance: null,
        commit_authorization: null,
        commit_preparation: null,
        commit_result: null,
      },
    );
    assert.equal(store.audit(source.workflow_id).at(-1).event_type, "LINKED_FOLLOWUP_CREATED");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("combined-review path overflow suppresses reconciliation and preserves unchanged retry", () => {
  const { root, git } = fixture();
  const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
  try {
    const sourcePaths = Array.from({ length: MAX_PATHS - 1 }, (_, index) => `source-${index}.txt`);
    const source = store.create(input(git, { approved_paths: sourcePaths }));
    implementation(store, source);
    for (const path of sourcePaths) writeFileSync(join(root, path), `${path}\n`);
    const optional = finding("COMBINED-LIMIT-OPTIONAL", "P3", false);
    review(store, source, undefined, "APPROVED", [], [optional]);

    const child = store.createLinkedFollowup({
      workflow_id: source.workflow_id,
      expected_version: currentVersion(store, source.workflow_id),
      objective: "bounded child remediation",
      approved_plan: null,
      approved_paths: ["remediation.txt"],
      acceptance_criteria: ["resolve the selected finding"],
      validation_requirements: [
        { description: "verify remediation", kind: "command", argv: ["bun", "run", "check"] },
      ],
      finding_ids: [optional.finding_id],
      user_authorization: "authorize bounded remediation",
    });
    implementation(store, child, undefined, "DONE", { [optional.finding_id]: "resolved" });
    writeFileSync(join(root, "remediation.txt"), "remediated\n");
    assert.equal(
      review(store, child, undefined, "APPROVED", [], [], {
        [optional.finding_id]: "resolved",
      }).phase,
      "REVIEWING",
    );
    assert.equal(review(store, child).phase, "STOPPED_APPROVED");
    assert.equal(
      store.parentGet(child.workflow_id).linked_continuation.combined_review_paths.length,
      MAX_PATHS,
    );
    store.authorizeCommit({
      workflow_id: child.workflow_id,
      expected_version: currentVersion(store, child.workflow_id),
      user_authorization: "authorize the freshly combined-reviewed change",
    });

    writeFileSync(join(root, "outside.txt"), "accidental staged content\n");
    git("add", "--", ...sourcePaths, "remediation.txt", "outside.txt");
    const stopped = store.prepareCommit({
      workflow_id: child.workflow_id,
      expected_version: currentVersion(store, child.workflow_id),
    });
    assert.equal(stopped.stop_context.category, "ERROR_STAGED_SCOPE");
    assert.equal(stopped.stop_context.recovery, "retry");
    assert.equal("reconciliation_paths" in stopped.stop_context, false);
    assert.deepEqual(
      store
        .operatorDecisionGet(child.workflow_id)
        .execution.parent_actions.map((action: any) => action.action),
      ["workflow_retry_commit_preparation"],
    );

    git("reset", "-q", "--", "outside.txt");
    store.retryCommitPreparation({
      workflow_id: child.workflow_id,
      expected_version: currentVersion(store, child.workflow_id),
      retry_context: "remove accidental staging and preserve the approved combined scope",
    });
    assert.equal(
      store.prepareCommit({
        workflow_id: child.workflow_id,
        expected_version: currentVersion(store, child.workflow_id),
      }).phase,
      "COMMIT_PREPARED",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
