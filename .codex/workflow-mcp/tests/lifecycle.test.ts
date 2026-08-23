import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";

const ROLES = ["parent", "implementer", "reviewer", "committer"];

function rangeFixture() {
  const { root, git } = fixture();
  mkdirSync(join(root, "dir"));
  writeFileSync(join(root, "dir", "f.txt"), "f\n");
  writeFileSync(join(root, "added.txt"), "added\n");
  git("add", "-A");
  git("commit", "-qm", "range head");
  return { root, git, base: git("rev-parse", "HEAD~1"), head: git("rev-parse", "HEAD") };
}

function createInput(_root: string, git: (...args: string[]) => string, options: any = {}) {
  const approvedPaths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "lifecycle scenario",
    approved_plan: options.approved_plan ?? null,
    approved_paths: approvedPaths,
    acceptance_criteria: options.acceptance_criteria ?? ["criterion A"],
    validation_requirements: options.validation_requirements ?? ["validation A"],
    review_target: options.review_target ?? {
      review_mode: "working_tree",
      base_revision: git("rev-parse", "HEAD"),
      head_revision: null,
      approved_paths: approvedPaths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
    max_repair_cycles: options.max_repair_cycles,
  };
}

const ACTIONS = {
  none: { parent: [], implementer: [], reviewer: [], committer: [] },
  implementing: {
    parent: ["workflow_expand_scope"],
    implementer: ["workflow_submit_implementation"],
    reviewer: [],
    committer: [],
  },
  reviewing: { parent: [], implementer: [], reviewer: ["workflow_begin_review"], committer: [] },
  reviewingRange: {
    parent: [],
    implementer: [],
    reviewer: ["workflow_submit_review"],
    committer: [],
  },
  repairRequired: {
    parent: [
      "workflow_authorize_repair",
      "workflow_expand_scope",
      "workflow_finalize_repair_exhausted",
    ],
    implementer: [],
    reviewer: [],
    committer: [],
  },
  repairing: {
    parent: ["workflow_expand_scope"],
    implementer: ["workflow_submit_implementation"],
    reviewer: [],
    committer: [],
  },
  approved: {
    parent: ["workflow_authorize_commit", "workflow_create_linked_followup"],
    implementer: [],
    reviewer: [],
    committer: [],
  },
  approvedRange: {
    parent: ["workflow_create_linked_followup"],
    implementer: [],
    reviewer: [],
    committer: [],
  },
  inconclusive: {
    parent: ["workflow_adopt_dirty_scope", "workflow_resume_review"],
    implementer: [],
    reviewer: [],
    committer: [],
  },
  concerns: { parent: ["workflow_accept_concerns"], implementer: [], reviewer: [], committer: [] },
  needsContext: {
    parent: ["workflow_expand_scope", "workflow_resume_implementation"],
    implementer: [],
    reviewer: [],
    committer: [],
  },
  implementationBlocked: {
    parent: ["workflow_expand_scope", "workflow_resume_implementation"],
    implementer: [],
    reviewer: [],
    committer: [],
  },
  exhausted: {
    parent: ["workflow_create_linked_followup"],
    implementer: [],
    reviewer: [],
    committer: [],
  },
  commitAuthorized: {
    parent: [],
    implementer: [],
    reviewer: [],
    committer: ["workflow_prepare_commit"],
  },
  commitPrepared: {
    parent: [],
    implementer: [],
    reviewer: [],
    committer: ["workflow_submit_commit_result"],
  },
  notCommitted: { parent: ["workflow_retry_commit"], implementer: [], reviewer: [], committer: [] },
};

const EVENTS = {
  created: ["WORKFLOW_CREATED"],
  incomplete: ["WORKFLOW_CREATED", "IMPLEMENTATION_INCOMPLETE"],
  incompleteSubmitted: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_INCOMPLETE",
    "IMPLEMENTATION_SUBMITTED",
  ],
  submitted: ["WORKFLOW_CREATED", "IMPLEMENTATION_SUBMITTED"],
  reviewSubmitted: ["WORKFLOW_CREATED", "IMPLEMENTATION_SUBMITTED", "REVIEW_SUBMITTED"],
  reviewOnlyReview: ["WORKFLOW_CREATED", "REVIEW_SUBMITTED"],
  stopped: ["WORKFLOW_CREATED", "IMPLEMENTATION_STOPPED"],
  resumed: ["WORKFLOW_CREATED", "IMPLEMENTATION_STOPPED", "IMPLEMENTATION_RESUMED"],
  resumedSubmitted: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_STOPPED",
    "IMPLEMENTATION_RESUMED",
    "IMPLEMENTATION_SUBMITTED",
  ],
  concernsAccepted: ["WORKFLOW_CREATED", "IMPLEMENTATION_STOPPED", "CONCERNS_ACCEPTED"],
  concernsReview: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_STOPPED",
    "CONCERNS_ACCEPTED",
    "REVIEW_SUBMITTED",
  ],
  repairAuthorized: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
  ],
  repairedSubmitted: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
    "IMPLEMENTATION_SUBMITTED",
  ],
  repairedReview: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
  ],
  repairStopped: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
    "IMPLEMENTATION_STOPPED",
  ],
  repairResumed: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
    "IMPLEMENTATION_STOPPED",
    "IMPLEMENTATION_RESUMED",
  ],
  repairResumedSubmitted: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
    "IMPLEMENTATION_STOPPED",
    "IMPLEMENTATION_RESUMED",
    "IMPLEMENTATION_SUBMITTED",
  ],
  repairExhausted: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_EXHAUSTED",
  ],
  approvedLinked: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "LINKED_FOLLOWUP_CREATED",
  ],
  exhaustedLinked: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_AUTHORIZED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REPAIR_EXHAUSTED",
    "LINKED_FOLLOWUP_CREATED",
  ],
  inconclusiveResumed: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REVIEW_RESUMED",
  ],
  inconclusiveReview: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "REVIEW_RESUMED",
    "REVIEW_SUBMITTED",
  ],
  commitAuthorized: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "COMMIT_AUTHORIZED",
  ],
  commitPrepared: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "COMMIT_AUTHORIZED",
    "COMMIT_PREPARED",
  ],
  commitResult: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "COMMIT_AUTHORIZED",
    "COMMIT_PREPARED",
    "COMMIT_RESULT_SUBMITTED",
  ],
  commitRetried: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "COMMIT_AUTHORIZED",
    "COMMIT_PREPARED",
    "COMMIT_RESULT_SUBMITTED",
    "COMMIT_RETRY_AUTHORIZED",
  ],
  commitReprepared: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "COMMIT_AUTHORIZED",
    "COMMIT_PREPARED",
    "COMMIT_RESULT_SUBMITTED",
    "COMMIT_RETRY_AUTHORIZED",
    "COMMIT_PREPARED",
  ],
  commitRetryResult: [
    "WORKFLOW_CREATED",
    "IMPLEMENTATION_SUBMITTED",
    "REVIEW_SUBMITTED",
    "COMMIT_AUTHORIZED",
    "COMMIT_PREPARED",
    "COMMIT_RESULT_SUBMITTED",
    "COMMIT_RETRY_AUTHORIZED",
    "COMMIT_PREPARED",
    "COMMIT_RESULT_SUBMITTED",
  ],
};

function blocker(id: string) {
  return {
    finding_id: id,
    severity: "P1",
    blocking: true,
    file_and_line: "note.txt:1",
    failure_scenario: "fails",
    impact: "bad",
    violated_requirement: "safe",
    remediation: "fix",
    missing_or_inadequate_test: "test",
  };
}

function optionalFinding(id: string) {
  return {
    finding_id: id,
    severity: "P3",
    blocking: false,
    file_and_line: "note.txt:1",
    failure_scenario: "might fail",
    impact: "small",
    violated_requirement: "quality",
    remediation: "consider",
    missing_or_inadequate_test: "optional",
  };
}

function doCreate(ctx: any, options: any = {}) {
  ctx.created = ctx.store.create(createInput(ctx.root, ctx.git, options));
}

function doImplementation(ctx: any, _version: number, options: any = {}) {
  const { workflow } = ctx.created;
  ctx.store.submitImplementation({
    workflow_id: workflow.workflow_id,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    status: options.status ?? "DONE",
    summary: options.summary ?? "implemented",
    agent_touched_paths: options.touched ?? [],
    acceptance_results: workflow.acceptance_criteria.map(({ criterion_id }: any) => ({
      criterion_id,
      status: options.criterionStatus ?? "satisfied",
      evidence: "acceptance evidence",
    })),
    validation_results: workflow.validation_requirements.map(({ validation_id }: any) => ({
      validation_id,
      status: options.validationStatus ?? "passed",
      evidence: "validation evidence",
    })),
    known_failures: options.knownFailures ?? [],
    finding_resolution_map: options.resolution ?? {},
  });
}

function doReview(ctx: any, _version: number, options: any = {}) {
  const { workflow } = ctx.created;
  const status = options.status ?? "APPROVED";
  const expectedVersion = ctx.store.parentGet(workflow.workflow_id).version;
  if (workflow.review_target?.review_mode !== "commit_range") {
    ctx.store.beginReview({
      workflow_id: workflow.workflow_id,
      expected_version: expectedVersion,
    });
  }
  ctx.store.submitReview({
    workflow_id: workflow.workflow_id,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    review_status: status,
    blocking_findings: options.blocking ?? [],
    optional_findings: options.optional ?? [],
    prior_finding_classifications: options.prior ?? {},
  });
}

function doAuthorizeRepair(ctx: any, _version: number, ids: string[]) {
  const { workflow, capability } = ctx.created;
  ctx.store.authorizeRepair({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    finding_ids: ids,
  });
}

function doResumeImplementation(ctx: any, _version: number) {
  const { workflow, capability } = ctx.created;
  ctx.store.resumeImplementation({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    resume_context: "resumed",
  });
}

function doResumeReview(ctx: any, _version: number) {
  const { workflow, capability } = ctx.created;
  ctx.store.resumeReview({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    resume_context: "resumed",
  });
}

function doAcceptConcerns(ctx: any, _version: number) {
  const { workflow, capability } = ctx.created;
  ctx.store.acceptConcerns({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    user_authorization: "user accepted concerns",
  });
}

function doAuthorizeCommit(ctx: any, _version: number) {
  const { workflow, capability } = ctx.created;
  ctx.store.authorizeCommit({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    user_authorization: "user authorized commit",
  });
}

function doPrepareCommit(ctx: any, _version: number) {
  const { workflow } = ctx.created;
  ctx.prepared = ctx.store.prepareCommit({
    workflow_id: workflow.workflow_id,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
  });
}

function doSubmitCommitResult(ctx: any, _version: number, options: any) {
  const { workflow } = ctx.created;
  ctx.store.submitCommitResult({
    workflow_id: workflow.workflow_id,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    attempt_id: options.attemptId ?? ctx.prepared.commit_preparation.attempt_id,
    outcome: options.outcome,
    failure_summary: options.failure_summary ?? null,
  });
}

function doRetryCommit(ctx: any, _version: number) {
  const { workflow, capability } = ctx.created;
  ctx.store.retryCommit({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    retry_context: "retrying",
  });
}

function doFinalize(ctx: any, _version: number) {
  const { workflow, capability } = ctx.created;
  ctx.store.finalizeRepairExhausted({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
  });
}

function doLinkedFollowup(ctx: any, _version: number, findingIds: string[]) {
  const { workflow, capability } = ctx.created;
  ctx.child = ctx.store.createLinkedFollowup({
    workflow_id: workflow.workflow_id,
    capability,
    expected_version: ctx.store.parentGet(workflow.workflow_id).version,
    objective: "linked child",
    approved_plan: null,
    approved_paths: ["note.txt"],
    acceptance_criteria: ["child criterion"],
    validation_requirements: ["child validation"],
    finding_ids: findingIds,
    user_authorization: "user authorized follow-up",
  });
}

function doStage(ctx: any) {
  ctx.git("add", "note.txt");
}

function doWriteChange(ctx: any) {
  writeFileSync(join(ctx.root, "note.txt"), "changed\n");
}

function snap(wf: string, phase: string, version: number, actions: any, events: string[]) {
  return { wf, phase, version, actions, events };
}

function assertSnapshot(store: any, ctx: any, snap: any, label: string) {
  const entry = snap.wf === "child" ? ctx.child : ctx.created;
  assert.ok(entry, `${label}: workflow exists`);
  const { workflow, capability } = entry;
  const id = workflow.workflow_id;
  const expectedVersion = store.parentGet(id).version;
  for (const role of ROLES) {
    const view =
      role === "parent"
        ? store.parentGet(id)
        : role === "implementer"
          ? store.implementerGet(id)
          : role === "reviewer"
            ? store.reviewerGet(id)
            : store.committerGet(id);
    assert.equal(view.phase, snap.phase, `${label}: ${role} phase`);
    assert.equal(view.version, expectedVersion, `${label}: ${role} version`);
    assert.deepEqual(
      view.permitted_next_actions,
      snap.actions[role],
      `${label}: ${role} permitted actions`,
    );
  }
  const row = store.db
    .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
    .get(id);
  assert.ok(row, `${label}: persisted row exists`);
  const parsed = JSON.parse(row.state_json);
  assert.equal(row.version, expectedVersion, `${label}: persisted row version`);
  assert.equal(parsed.version, expectedVersion, `${label}: persisted state version`);
  assert.equal(parsed.phase, snap.phase, `${label}: persisted state phase`);
  assert.equal(row.state_digest, objectDigest(parsed), `${label}: stored digest matches state`);
  const audit = store.audit(id, capability);
  assert.deepEqual(
    audit.map((event: any) => event.event_type),
    snap.events.flatMap((event: string) =>
      event === "REVIEW_SUBMITTED" && workflow.review_target?.review_mode === "working_tree"
        ? ["REVIEW_STARTED", event]
        : [event],
    ),
    `${label}: exact event sequence`,
  );
  for (let index = 0; index < audit.length; index += 1) {
    if (index === 0) {
      assert.equal(
        audit[index].summary.state_digest_before,
        null,
        `${label}: first audit digest before`,
      );
    } else {
      assert.equal(
        audit[index].summary.state_digest_before,
        audit[index - 1].summary.state_digest_after,
        `${label}: audit digest chain`,
      );
    }
  }
  assert.equal(
    audit[audit.length - 1].summary.state_digest_after,
    row.state_digest,
    `${label}: last audit digest equals stored digest`,
  );
}

function scenario(name: string, steps: any[], options: any = {}) {
  test(name, () => {
    const base = options.fixture ? options.fixture() : fixture();
    const { root, git } = base;
    const dbPath = join(root, "state.sqlite");
    let store: any = new WorkflowStore({ repositoryRoot: root, databasePath: dbPath });
    const ctx = {
      root,
      git,
      store,
      dbPath,
      created: null,
      child: null,
      prepared: null,
      ...base,
    };
    try {
      for (const step of steps) {
        step.run(ctx);
        for (const snap of step.snapshots) {
          assertSnapshot(store, ctx, snap, `${name}: ${step.name} (${snap.wf})`);
        }
        store.close();
        store = new WorkflowStore({ repositoryRoot: root, databasePath: dbPath });
        ctx.store = store;
        for (const snap of step.snapshots) {
          assertSnapshot(store, ctx, snap, `${name}: ${step.name} (${snap.wf}) after reopen`);
        }
      }
    } finally {
      ctx.store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

scenario("clean change lifecycle ends committed", [
  {
    name: "create change workflow",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "write worktree change",
    run: doWriteChange,
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "review approved",
    run: (ctx: any) => doReview(ctx, 1),
    snapshots: [snap("parent", "STOPPED_APPROVED", 2, ACTIONS.approved, EVENTS.reviewSubmitted)],
  },
  {
    name: "authorize commit",
    run: (ctx: any) => doAuthorizeCommit(ctx, 2),
    snapshots: [
      snap("parent", "COMMIT_AUTHORIZED", 3, ACTIONS.commitAuthorized, EVENTS.commitAuthorized),
    ],
  },
  {
    name: "stage approved change",
    run: doStage,
    snapshots: [
      snap("parent", "COMMIT_AUTHORIZED", 3, ACTIONS.commitAuthorized, EVENTS.commitAuthorized),
    ],
  },
  {
    name: "prepare commit",
    run: (ctx: any) => doPrepareCommit(ctx, 3),
    snapshots: [
      snap("parent", "COMMIT_PREPARED", 4, ACTIONS.commitPrepared, EVENTS.commitPrepared),
    ],
  },
  {
    name: "external commit succeeds",
    run: (ctx: any) => ctx.git("commit", "-qm", "lifecycle change"),
    snapshots: [
      snap("parent", "COMMIT_PREPARED", 4, ACTIONS.commitPrepared, EVENTS.commitPrepared),
    ],
  },
  {
    name: "submit committed result",
    run: (ctx: any) =>
      doSubmitCommitResult(ctx, 4, {
        outcome: "committed",
      }),
    snapshots: [snap("parent", "COMMITTED", 5, ACTIONS.none, EVENTS.commitResult)],
  },
]);

scenario("#34 absent working-tree path is reviewed and approved in one pass", [
  {
    name: "create workflow with an intentionally absent approved path",
    run: (ctx: any) =>
      doCreate(ctx, {
        approved_paths: ["note.txt", "planned.txt"],
      }),
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "implement without creating the planned path",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "approve without parent clarification or a second review",
    run: (ctx: any) => {
      doReview(ctx, 1);
      const state = JSON.parse(
        ctx.store.db
          .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
          .get(ctx.created.workflow.workflow_id).state_json,
      );
      assert.deepEqual(
        state.review_receipt.paths.map(({ path, state: pathState, kind }: any) => ({
          path,
          state: pathState,
          kind,
        })),
        [
          { path: "note.txt", state: "unchanged", kind: "file" },
          { path: "planned.txt", state: "absent", kind: "missing" },
        ],
      );
    },
    snapshots: [snap("parent", "STOPPED_APPROVED", 2, ACTIONS.approved, EVENTS.reviewSubmitted)],
  },
]);

scenario("repair cycle and approval lifecycle", [
  {
    name: "create change workflow",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "review changes requested",
    run: (ctx: any) =>
      doReview(ctx, 1, { status: "CHANGES_REQUESTED", blocking: [blocker("F-1")] }),
    snapshots: [
      snap("parent", "REPAIR_REQUIRED", 2, ACTIONS.repairRequired, EVENTS.reviewSubmitted),
    ],
  },
  {
    name: "authorize repair",
    run: (ctx: any) => doAuthorizeRepair(ctx, 2, ["F-1"]),
    snapshots: [snap("parent", "REPAIRING", 3, ACTIONS.repairing, EVENTS.repairAuthorized)],
  },
  {
    name: "implement repair done",
    run: (ctx: any) => doImplementation(ctx, 3, { resolution: { "F-1": "resolved" } }),
    snapshots: [snap("parent", "REVIEWING", 4, ACTIONS.reviewing, EVENTS.repairedSubmitted)],
  },
  {
    name: "write worktree change",
    run: doWriteChange,
    snapshots: [snap("parent", "REVIEWING", 4, ACTIONS.reviewing, EVENTS.repairedSubmitted)],
  },
  {
    name: "review approved",
    run: (ctx: any) => doReview(ctx, 4, { prior: { "F-1": "resolved" } }),
    snapshots: [snap("parent", "STOPPED_APPROVED", 5, ACTIONS.approved, EVENTS.repairedReview)],
  },
]);

scenario("both implementation resumes restore their prior phase", [
  {
    name: "needs context from implementing: create",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "needs context from implementing: stop",
    run: (ctx: any) =>
      doImplementation(ctx, 0, { status: "NEEDS_CONTEXT", summary: "need context" }),
    snapshots: [snap("parent", "STOPPED_NEEDS_CONTEXT", 1, ACTIONS.needsContext, EVENTS.stopped)],
  },
  {
    name: "needs context from implementing: resume",
    run: (ctx: any) => doResumeImplementation(ctx, 1),
    snapshots: [snap("parent", "IMPLEMENTING", 2, ACTIONS.implementing, EVENTS.resumed)],
  },
  {
    name: "needs context from implementing: complete",
    run: (ctx: any) => doImplementation(ctx, 2),
    snapshots: [snap("parent", "REVIEWING", 3, ACTIONS.reviewing, EVENTS.resumedSubmitted)],
  },
  {
    name: "blocked from repairing: create",
    run: (ctx: any) => doCreate(ctx, { max_repair_cycles: 2 }),
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "blocked from repairing: implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "blocked from repairing: review changes requested",
    run: (ctx: any) =>
      doReview(ctx, 1, { status: "CHANGES_REQUESTED", blocking: [blocker("F-1")] }),
    snapshots: [
      snap("parent", "REPAIR_REQUIRED", 2, ACTIONS.repairRequired, EVENTS.reviewSubmitted),
    ],
  },
  {
    name: "blocked from repairing: authorize repair",
    run: (ctx: any) => doAuthorizeRepair(ctx, 2, ["F-1"]),
    snapshots: [snap("parent", "REPAIRING", 3, ACTIONS.repairing, EVENTS.repairAuthorized)],
  },
  {
    name: "blocked from repairing: stop blocked",
    run: (ctx: any) =>
      doImplementation(ctx, 3, {
        status: "BLOCKED",
        summary: "blocked",
        resolution: { "F-1": "still_present" },
      }),
    snapshots: [
      snap(
        "parent",
        "STOPPED_IMPLEMENTATION_BLOCKED",
        4,
        ACTIONS.implementationBlocked,
        EVENTS.repairStopped,
      ),
    ],
  },
  {
    name: "blocked from repairing: resume",
    run: (ctx: any) => doResumeImplementation(ctx, 4),
    snapshots: [snap("parent", "REPAIRING", 5, ACTIONS.repairing, EVENTS.repairResumed)],
  },
  {
    name: "blocked from repairing: complete",
    run: (ctx: any) => doImplementation(ctx, 5, { resolution: { "F-1": "resolved" } }),
    snapshots: [snap("parent", "REVIEWING", 6, ACTIONS.reviewing, EVENTS.repairResumedSubmitted)],
  },
]);

scenario("concern acceptance enters review and approves", [
  {
    name: "create change workflow",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "implement with concerns",
    run: (ctx: any) =>
      doImplementation(ctx, 0, {
        status: "DONE_WITH_CONCERNS",
        summary: "done with concerns",
        knownFailures: ["flaky test"],
      }),
    snapshots: [snap("parent", "STOPPED_CONCERNS", 1, ACTIONS.concerns, EVENTS.stopped)],
  },
  {
    name: "accept concerns",
    run: (ctx: any) => doAcceptConcerns(ctx, 1),
    snapshots: [snap("parent", "REVIEWING", 2, ACTIONS.reviewing, EVENTS.concernsAccepted)],
  },
  {
    name: "write worktree change",
    run: doWriteChange,
    snapshots: [snap("parent", "REVIEWING", 2, ACTIONS.reviewing, EVENTS.concernsAccepted)],
  },
  {
    name: "review approved",
    run: (ctx: any) => doReview(ctx, 2),
    snapshots: [snap("parent", "STOPPED_APPROVED", 3, ACTIONS.approved, EVENTS.concernsReview)],
  },
]);

scenario("unfinished approved test migration continues before independent review", [
  {
    name: "create workflow with implementation and migration work",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "core protocol complete but planned tests remain",
    run: (ctx: any) =>
      doImplementation(ctx, 0, {
        status: "INCOMPLETE",
        summary: "core protocol complete; approved test migration remains",
        criterionStatus: "not_satisfied",
        validationStatus: "failed",
        knownFailures: ["legacy tests still encode the old protocol"],
      }),
    snapshots: [snap("parent", "IMPLEMENTING", 1, ACTIONS.implementing, EVENTS.incomplete)],
  },
  {
    name: "continued implementation completes migration",
    run: (ctx: any) => doImplementation(ctx, 1),
    snapshots: [snap("parent", "REVIEWING", 2, ACTIONS.reviewing, EVENTS.incompleteSubmitted)],
  },
]);

scenario(
  "both review-only modes approve without implementation",
  [
    {
      name: "working-tree review-only: create",
      run: (ctx: any) =>
        doCreate(ctx, { workflow_type: "review_only", validation_requirements: [] }),
      snapshots: [snap("parent", "REVIEWING", 0, ACTIONS.reviewing, EVENTS.created)],
    },
    {
      name: "working-tree review-only: write worktree change",
      run: doWriteChange,
      snapshots: [snap("parent", "REVIEWING", 0, ACTIONS.reviewing, EVENTS.created)],
    },
    {
      name: "working-tree review-only: approve",
      run: (ctx: any) => doReview(ctx, 0),
      snapshots: [snap("parent", "STOPPED_APPROVED", 1, ACTIONS.approved, EVENTS.reviewOnlyReview)],
    },
    {
      name: "commit-range review-only: create",
      run: (ctx: any) =>
        doCreate(ctx, {
          workflow_type: "review_only",
          validation_requirements: [],
          approved_paths: ["added.txt", "note.txt"],
          review_target: {
            review_mode: "commit_range",
            base_revision: ctx.base,
            head_revision: ctx.head,
            approved_paths: ["added.txt", "note.txt"],
            include_staged: false,
            include_unstaged: false,
            include_untracked: false,
          },
        }),
      snapshots: [snap("parent", "REVIEWING", 0, ACTIONS.reviewingRange, EVENTS.created)],
    },
    {
      name: "commit-range review-only: approve",
      run: (ctx: any) =>
        doReview(ctx, 0, { target: ctx.created.workflow.review_target, receipt: null }),
      snapshots: [
        snap("parent", "STOPPED_APPROVED", 1, ACTIONS.approvedRange, EVENTS.reviewOnlyReview),
      ],
    },
  ],
  { fixture: rangeFixture },
);

scenario("inconclusive review resumes and approves", [
  {
    name: "create change workflow",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "review inconclusive",
    run: (ctx: any) => doReview(ctx, 1, { status: "INCONCLUSIVE", receipt: null }),
    snapshots: [
      snap("parent", "STOPPED_INCONCLUSIVE", 2, ACTIONS.inconclusive, EVENTS.reviewSubmitted),
    ],
  },
  {
    name: "resume review",
    run: (ctx: any) => doResumeReview(ctx, 2),
    snapshots: [snap("parent", "REVIEWING", 3, ACTIONS.reviewing, EVENTS.inconclusiveResumed)],
  },
  {
    name: "write worktree change",
    run: doWriteChange,
    snapshots: [snap("parent", "REVIEWING", 3, ACTIONS.reviewing, EVENTS.inconclusiveResumed)],
  },
  {
    name: "review approved",
    run: (ctx: any) => doReview(ctx, 3),
    snapshots: [snap("parent", "STOPPED_APPROVED", 4, ACTIONS.approved, EVENTS.inconclusiveReview)],
  },
]);

scenario("linked follow-ups copy optional and blocking findings into fresh children", [
  {
    name: "optional from approved: create",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "optional from approved: implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "optional from approved: write worktree change",
    run: doWriteChange,
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "optional from approved: approve with optional finding",
    run: (ctx: any) => doReview(ctx, 1, { optional: [optionalFinding("F-OPT")] }),
    snapshots: [snap("parent", "STOPPED_APPROVED", 2, ACTIONS.approved, EVENTS.reviewSubmitted)],
  },
  {
    name: "optional from approved: link optional child",
    run: (ctx: any) => doLinkedFollowup(ctx, 2, ["F-OPT"]),
    snapshots: [
      snap("parent", "STOPPED_APPROVED", 3, ACTIONS.none, EVENTS.approvedLinked),
      snap("child", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created),
    ],
  },
  {
    name: "blocker from exhausted: create",
    run: (ctx: any) => doCreate(ctx, { max_repair_cycles: 1 }),
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "blocker from exhausted: implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "blocker from exhausted: review changes requested",
    run: (ctx: any) =>
      doReview(ctx, 1, { status: "CHANGES_REQUESTED", blocking: [blocker("F-BLK")] }),
    snapshots: [
      snap("parent", "REPAIR_REQUIRED", 2, ACTIONS.repairRequired, EVENTS.reviewSubmitted),
    ],
  },
  {
    name: "blocker from exhausted: authorize repair",
    run: (ctx: any) => doAuthorizeRepair(ctx, 2, ["F-BLK"]),
    snapshots: [snap("parent", "REPAIRING", 3, ACTIONS.repairing, EVENTS.repairAuthorized)],
  },
  {
    name: "blocker from exhausted: implement still present",
    run: (ctx: any) => doImplementation(ctx, 3, { resolution: { "F-BLK": "still_present" } }),
    snapshots: [snap("parent", "REVIEWING", 4, ACTIONS.reviewing, EVENTS.repairedSubmitted)],
  },
  {
    name: "blocker from exhausted: review changes requested again",
    run: (ctx: any) =>
      doReview(ctx, 4, {
        status: "CHANGES_REQUESTED",
        blocking: [blocker("F-BLK")],
        prior: { "F-BLK": "still_present" },
      }),
    snapshots: [
      snap("parent", "REPAIR_REQUIRED", 5, ACTIONS.repairRequired, EVENTS.repairedReview),
    ],
  },
  {
    name: "blocker from exhausted: finalize exhausted",
    run: (ctx: any) => doFinalize(ctx, 5),
    snapshots: [
      snap("parent", "STOPPED_REPAIR_EXHAUSTED", 6, ACTIONS.exhausted, EVENTS.repairExhausted),
    ],
  },
  {
    name: "blocker from exhausted: link blocker child",
    run: (ctx: any) => doLinkedFollowup(ctx, 6, ["F-BLK"]),
    snapshots: [
      snap("parent", "STOPPED_REPAIR_EXHAUSTED", 7, ACTIONS.none, EVENTS.exhaustedLinked),
      snap("child", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created),
    ],
  },
]);

scenario("repair exhaustion is terminal at the max cycle", [
  {
    name: "create change workflow",
    run: (ctx: any) => doCreate(ctx, { max_repair_cycles: 1 }),
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "review changes requested",
    run: (ctx: any) =>
      doReview(ctx, 1, { status: "CHANGES_REQUESTED", blocking: [blocker("F-1")] }),
    snapshots: [
      snap("parent", "REPAIR_REQUIRED", 2, ACTIONS.repairRequired, EVENTS.reviewSubmitted),
    ],
  },
  {
    name: "authorize repair",
    run: (ctx: any) => doAuthorizeRepair(ctx, 2, ["F-1"]),
    snapshots: [snap("parent", "REPAIRING", 3, ACTIONS.repairing, EVENTS.repairAuthorized)],
  },
  {
    name: "implement still present",
    run: (ctx: any) => doImplementation(ctx, 3, { resolution: { "F-1": "still_present" } }),
    snapshots: [snap("parent", "REVIEWING", 4, ACTIONS.reviewing, EVENTS.repairedSubmitted)],
  },
  {
    name: "review changes requested again",
    run: (ctx: any) =>
      doReview(ctx, 4, {
        status: "CHANGES_REQUESTED",
        blocking: [blocker("F-1")],
        prior: { "F-1": "still_present" },
      }),
    snapshots: [
      snap("parent", "REPAIR_REQUIRED", 5, ACTIONS.repairRequired, EVENTS.repairedReview),
    ],
  },
  {
    name: "finalize repair exhausted",
    run: (ctx: any) => doFinalize(ctx, 5),
    snapshots: [
      snap("parent", "STOPPED_REPAIR_EXHAUSTED", 6, ACTIONS.exhausted, EVENTS.repairExhausted),
    ],
  },
]);

scenario(
  "commit failure is retryable and then succeeds",
  [
    {
      name: "create change workflow",
      run: doCreate,
      snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
    },
    {
      name: "implement done",
      run: (ctx: any) => doImplementation(ctx, 0),
      snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
    },
    {
      name: "write worktree change",
      run: doWriteChange,
      snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
    },
    {
      name: "review approved",
      run: (ctx: any) => doReview(ctx, 1),
      snapshots: [snap("parent", "STOPPED_APPROVED", 2, ACTIONS.approved, EVENTS.reviewSubmitted)],
    },
    {
      name: "authorize commit",
      run: (ctx: any) => doAuthorizeCommit(ctx, 2),
      snapshots: [
        snap("parent", "COMMIT_AUTHORIZED", 3, ACTIONS.commitAuthorized, EVENTS.commitAuthorized),
      ],
    },
    {
      name: "stage approved change",
      run: doStage,
      snapshots: [
        snap("parent", "COMMIT_AUTHORIZED", 3, ACTIONS.commitAuthorized, EVENTS.commitAuthorized),
      ],
    },
    {
      name: "prepare commit",
      run: (ctx: any) => doPrepareCommit(ctx, 3),
      snapshots: [
        snap("parent", "COMMIT_PREPARED", 4, ACTIONS.commitPrepared, EVENTS.commitPrepared),
      ],
    },
    {
      name: "external commit rejected by hook",
      run: (ctx: any) => {
        let failed = false;
        try {
          ctx.git("commit", "-qm", "rejected");
        } catch {
          failed = true;
        }
        assert.equal(failed, true, "pre-commit hook must reject the first commit");
      },
      snapshots: [
        snap("parent", "COMMIT_PREPARED", 4, ACTIONS.commitPrepared, EVENTS.commitPrepared),
      ],
    },
    {
      name: "submit not-committed result",
      run: (ctx: any) =>
        doSubmitCommitResult(ctx, 4, {
          outcome: "not_committed",
          failure_summary: "pre-commit hook rejected",
        }),
      snapshots: [
        snap("parent", "STOPPED_NOT_COMMITTED", 5, ACTIONS.notCommitted, EVENTS.commitResult),
      ],
    },
    {
      name: "retry commit",
      run: (ctx: any) => doRetryCommit(ctx, 5),
      snapshots: [
        snap("parent", "COMMIT_AUTHORIZED", 6, ACTIONS.commitAuthorized, EVENTS.commitRetried),
      ],
    },
    {
      name: "prepare commit again",
      run: (ctx: any) => doPrepareCommit(ctx, 6),
      snapshots: [
        snap("parent", "COMMIT_PREPARED", 7, ACTIONS.commitPrepared, EVENTS.commitReprepared),
      ],
    },
    {
      name: "external commit succeeds",
      run: (ctx: any) => ctx.git("commit", "-qm", "retried commit"),
      snapshots: [
        snap("parent", "COMMIT_PREPARED", 7, ACTIONS.commitPrepared, EVENTS.commitReprepared),
      ],
    },
    {
      name: "submit committed result",
      run: (ctx: any) =>
        doSubmitCommitResult(ctx, 7, {
          outcome: "committed",
        }),
      snapshots: [snap("parent", "COMMITTED", 8, ACTIONS.none, EVENTS.commitRetryResult)],
    },
  ],
  {
    fixture: () => {
      const { root, git } = fixture();
      mkdirSync(join(root, ".git", "hooks"), { recursive: true });
      writeFileSync(
        join(root, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\nif [ ! -f hook-passed ]; then\n  touch hook-passed\n  exit 1\nfi\nexit 0\n",
      );
      chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
      return { root, git };
    },
  },
);

scenario("commit mismatch stops terminally", [
  {
    name: "create change workflow",
    run: doCreate,
    snapshots: [snap("parent", "IMPLEMENTING", 0, ACTIONS.implementing, EVENTS.created)],
  },
  {
    name: "implement done",
    run: (ctx: any) => doImplementation(ctx, 0),
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "write worktree change",
    run: doWriteChange,
    snapshots: [snap("parent", "REVIEWING", 1, ACTIONS.reviewing, EVENTS.submitted)],
  },
  {
    name: "review approved",
    run: (ctx: any) => doReview(ctx, 1),
    snapshots: [snap("parent", "STOPPED_APPROVED", 2, ACTIONS.approved, EVENTS.reviewSubmitted)],
  },
  {
    name: "authorize commit",
    run: (ctx: any) => doAuthorizeCommit(ctx, 2),
    snapshots: [
      snap("parent", "COMMIT_AUTHORIZED", 3, ACTIONS.commitAuthorized, EVENTS.commitAuthorized),
    ],
  },
  {
    name: "stage approved change",
    run: doStage,
    snapshots: [
      snap("parent", "COMMIT_AUTHORIZED", 3, ACTIONS.commitAuthorized, EVENTS.commitAuthorized),
    ],
  },
  {
    name: "prepare commit",
    run: (ctx: any) => doPrepareCommit(ctx, 3),
    snapshots: [
      snap("parent", "COMMIT_PREPARED", 4, ACTIONS.commitPrepared, EVENTS.commitPrepared),
    ],
  },
  {
    name: "external commit moves head twice",
    run: (ctx: any) => {
      ctx.git("commit", "-qm", "committed anyway");
      ctx.git("commit", "--allow-empty", "-qm", "unexpected second commit");
    },
    snapshots: [
      snap("parent", "COMMIT_PREPARED", 4, ACTIONS.commitPrepared, EVENTS.commitPrepared),
    ],
  },
  {
    name: "submit stale committed claim",
    run: (ctx: any) =>
      doSubmitCommitResult(ctx, 4, {
        outcome: "committed",
      }),
    snapshots: [snap("parent", "STOPPED_COMMIT_MISMATCH", 5, ACTIONS.none, EVENTS.commitResult)],
  },
]);

test("dirty scope adoption is committed and guarded at both review recovery boundaries", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "adoption.sqlite");
  const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const head = git("rev-parse", "HEAD");
    const created = store.create({
      workflow_type: "change",
      objective: "dirty adoption",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: head,
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const id = created.workflow.workflow_id;
    const capability = created.capability;
    store.expandScope({
      workflow_id: id,
      capability,
      expected_version: 0,
      added_paths: ["dirty.txt"],
      reason: "planned path",
      user_authorization: "authorized",
    });
    store.submitImplementation({
      workflow_id: id,
      expected_version: 1,
      status: "DONE",
      summary: "implemented",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }],
      known_failures: [],
      finding_resolution_map: {},
    });
    store.beginReview({ workflow_id: id, expected_version: 2 });
    store.submitReview({
      workflow_id: id,
      expected_version: 3,
      review_status: "INCONCLUSIVE",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    writeFileSync(join(root, "dirty.txt"), "authorized\n");
    store.adoptDirtyScope({
      workflow_id: id,
      capability,
      expected_version: 4,
      adopted_paths: ["dirty.txt"],
      reason: "recover dirty path",
      user_authorization: "explicit recovery",
    });
    const adoptionAudit = store.audit(id, capability);
    assert.equal(adoptionAudit.at(-1).event_type, "DIRTY_SCOPE_ADOPTED");
    assert.ok(adoptionAudit.at(-1).dirty_scope_adoption.current_state_commitment);
    const beforeResume = store.parentGet(id);
    writeFileSync(join(root, "dirty.txt"), "changed after adoption\n");
    assert.throws(
      () =>
        store.resumeReview({
          workflow_id: id,
          capability,
          expected_version: beforeResume.version,
          resume_context: "resume",
        }),
      (error: any) => error.category === "ERROR_STALE_ADOPTION",
    );
    assert.equal(store.parentGet(id).version, beforeResume.version);
    assert.equal(store.audit(id, capability).length, adoptionAudit.length);

    writeFileSync(join(root, "dirty.txt"), "authorized\n");
    store.resumeReview({
      workflow_id: id,
      capability,
      expected_version: beforeResume.version,
      resume_context: "resume",
    });
    const beforeBegin = store.parentGet(id);
    writeFileSync(join(root, "dirty.txt"), "changed before review start\n");
    assert.throws(
      () => store.beginReview({ workflow_id: id, expected_version: beforeBegin.version }),
      (error: any) => error.category === "ERROR_STALE_ADOPTION",
    );
    assert.equal(store.parentGet(id).version, beforeBegin.version);
    assert.equal(store.audit(id, capability).length, adoptionAudit.length + 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty scope adoption binds staged-only index state", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "staged-adoption.sqlite");
  const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const head = git("rev-parse", "HEAD");
    const created = store.create({
      workflow_type: "change",
      objective: "staged dirty adoption",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: head,
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const id = created.workflow.workflow_id;
    const capability = created.capability;
    store.expandScope({
      workflow_id: id,
      capability,
      expected_version: 0,
      added_paths: ["staged.txt"],
      reason: "planned path",
      user_authorization: "authorized",
    });
    store.submitImplementation({
      workflow_id: id,
      expected_version: 1,
      status: "DONE",
      summary: "implemented",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }],
      known_failures: [],
      finding_resolution_map: {},
    });
    store.beginReview({ workflow_id: id, expected_version: 2 });
    store.submitReview({
      workflow_id: id,
      expected_version: 3,
      review_status: "INCONCLUSIVE",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });

    writeFileSync(join(root, "staged.txt"), "indexed\n");
    git("add", "staged.txt");
    git("restore", "--worktree", "--source=HEAD", "--", "staged.txt");
    store.adoptDirtyScope({
      workflow_id: id,
      capability,
      expected_version: 4,
      adopted_paths: ["staged.txt"],
      reason: "recover staged path",
      user_authorization: "explicit recovery",
    });
    const adoptionAudit = store.audit(id, capability);
    assert.equal(adoptionAudit.at(-1).event_type, "DIRTY_SCOPE_ADOPTED");
    assert.equal(adoptionAudit.at(-1).dirty_scope_adoption.index_states[0].state, "added");
    const beforeResume = store.parentGet(id);

    writeFileSync(join(root, "staged.txt"), "changed-index\n");
    git("add", "staged.txt");
    git("restore", "--worktree", "--source=HEAD", "--", "staged.txt");
    assert.throws(
      () =>
        store.resumeReview({
          workflow_id: id,
          capability,
          expected_version: beforeResume.version,
          resume_context: "resume",
        }),
      (error: any) => error.category === "ERROR_STALE_ADOPTION",
    );
    assert.equal(store.parentGet(id).version, beforeResume.version);
    assert.equal(store.audit(id, capability).length, adoptionAudit.length);

    git("reset", "-q", "HEAD", "--", "staged.txt");
    writeFileSync(join(root, "staged.txt"), "indexed\n");
    git("add", "staged.txt");
    git("restore", "--worktree", "--source=HEAD", "--", "staged.txt");
    store.resumeReview({
      workflow_id: id,
      capability,
      expected_version: beforeResume.version,
      resume_context: "resume",
    });
    const beforeBegin = store.parentGet(id);
    writeFileSync(join(root, "staged.txt"), "changed-worktree\n");
    assert.throws(
      () => store.beginReview({ workflow_id: id, expected_version: beforeBegin.version }),
      (error: any) => error.category === "ERROR_STALE_ADOPTION",
    );
    assert.equal(store.parentGet(id).version, beforeBegin.version);
    assert.equal(store.audit(id, capability).length, adoptionAudit.length + 1);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
