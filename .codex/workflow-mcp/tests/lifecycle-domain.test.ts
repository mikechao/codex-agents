import { test } from "bun:test";
import assert from "node:assert/strict";
import { roleView, validateWorkflowStateV10, workflowLegality } from "../transitions.js";
import type { GitCommitSha, WorkflowState } from "../types.js";
import { objectDigest } from "../validation.js";
import {
  blockingFinding,
  deterministicReadiness,
  optionalFinding,
  syntheticReceipt,
  workflowState,
} from "./workflow-state-fixtures.js";

const ROLES = ["parent", "implementer", "reviewer", "committer"] as const;

function actions(state: WorkflowState, readiness = deterministicReadiness(state)) {
  return workflowLegality(state, readiness).actions;
}

test("deterministic lifecycle phases expose the complete role action matrix", () => {
  const receipt = syntheticReceipt();
  const blocker = blockingFinding();
  const cases: Array<{
    name: string;
    state: WorkflowState;
    expected: Record<(typeof ROLES)[number], string[]>;
  }> = [
    {
      name: "implementing",
      state: workflowState({ phase: "IMPLEMENTING" }),
      expected: {
        parent: ["workflow_expand_scope"],
        implementer: ["workflow_submit_implementation"],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "reviewing",
      state: workflowState({ phase: "REVIEWING" }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: ["workflow_begin_review"],
        committer: [],
      },
    },
    {
      name: "commit-range review",
      state: workflowState({
        workflow_type: "review_only",
        phase: "REVIEWING",
        review_target: {
          review_mode: "commit_range",
          base_revision: receipt.base_head,
          head_revision: "4444444444444444444444444444444444444444" as GitCommitSha,
          approved_paths: receipt.approved_paths,
          include_staged: false,
          include_unstaged: false,
          include_untracked: false,
        },
      }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: ["workflow_submit_review"],
        committer: [],
      },
    },
    {
      name: "repair required",
      state: workflowState({
        phase: "REPAIR_REQUIRED",
        blocking_findings: [blocker],
      }),
      expected: {
        parent: [
          "workflow_adjudicate_findings",
          "workflow_authorize_repair",
          "workflow_expand_scope",
        ],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "repair exhausted",
      state: workflowState({
        phase: "REPAIR_REQUIRED",
        repair_cycle: 2,
        blocking_findings: [blocker],
      }),
      expected: {
        parent: [
          "workflow_adjudicate_findings",
          "workflow_expand_scope",
          "workflow_finalize_repair_exhausted",
        ],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "repairing",
      state: workflowState({ phase: "REPAIRING" }),
      expected: {
        parent: ["workflow_expand_scope"],
        implementer: ["workflow_submit_implementation"],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "review-only repair required",
      state: workflowState({
        workflow_type: "review_only",
        phase: "REPAIR_REQUIRED",
        blocking_findings: [blocker],
      }),
      expected: {
        parent: ["workflow_adjudicate_findings", "workflow_authorize_repair"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "review-only repairing",
      state: workflowState({ workflow_type: "review_only", phase: "REPAIRING" }),
      expected: {
        parent: [],
        implementer: ["workflow_submit_implementation"],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "approved",
      state: workflowState({ phase: "STOPPED_APPROVED" }),
      expected: {
        parent: ["workflow_authorize_commit"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "approved with a follow-up",
      state: workflowState({
        phase: "STOPPED_APPROVED",
        optional_findings: [optionalFinding()],
      }),
      expected: {
        parent: [
          "workflow_authorize_commit",
          "workflow_create_linked_followup",
          "workflow_create_linked_followup_from_plan",
        ],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "approved commit-range review",
      state: workflowState({
        workflow_type: "review_only",
        phase: "STOPPED_APPROVED",
        review_target: {
          review_mode: "commit_range",
          base_revision: receipt.base_head,
          head_revision: "4444444444444444444444444444444444444444" as GitCommitSha,
          approved_paths: receipt.approved_paths,
          include_staged: false,
          include_unstaged: false,
          include_untracked: false,
        },
      }),
      expected: { parent: [], implementer: [], reviewer: [], committer: [] },
    },
    {
      name: "inconclusive review",
      state: workflowState({ phase: "STOPPED_INCONCLUSIVE" }),
      expected: {
        parent: ["workflow_resume_review"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "implementation concerns",
      state: workflowState({ phase: "STOPPED_CONCERNS" }),
      expected: {
        parent: ["workflow_accept_concerns"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "implementation needs context",
      state: workflowState({ phase: "STOPPED_NEEDS_CONTEXT" }),
      expected: {
        parent: ["workflow_expand_scope", "workflow_resume_implementation"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "implementation blocked",
      state: workflowState({ phase: "STOPPED_IMPLEMENTATION_BLOCKED" }),
      expected: {
        parent: ["workflow_expand_scope", "workflow_resume_implementation"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "bounded continuation",
      state: workflowState({
        phase: "STOPPED_REPAIR_EXHAUSTED",
        blocking_findings: [blocker],
      }),
      expected: {
        parent: ["workflow_create_linked_followup", "workflow_create_linked_followup_from_plan"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "commit authorized",
      state: workflowState({ phase: "COMMIT_AUTHORIZED" }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: [],
        committer: ["workflow_prepare_commit"],
      },
    },
    {
      name: "commit prepared",
      state: workflowState({ phase: "COMMIT_PREPARED" }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: [],
        committer: ["workflow_submit_commit_result"],
      },
    },
    {
      name: "commit retry",
      state: workflowState({ phase: "STOPPED_NOT_COMMITTED" }),
      expected: {
        parent: ["workflow_retry_commit"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "committed terminal",
      state: workflowState({ phase: "COMMITTED" }),
      expected: { parent: [], implementer: [], reviewer: [], committer: [] },
    },
    {
      name: "commit mismatch terminal",
      state: workflowState({ phase: "STOPPED_COMMIT_MISMATCH" }),
      expected: { parent: [], implementer: [], reviewer: [], committer: [] },
    },
  ];

  for (const candidate of cases) {
    validateWorkflowStateV10(candidate.state);
    const readiness = deterministicReadiness(candidate.state);
    assert.deepEqual(actions(candidate.state, readiness), candidate.expected, candidate.name);
    for (const role of ROLES) {
      const view =
        role === "parent"
          ? roleView(candidate.state, "parent", readiness)
          : role === "implementer"
            ? roleView(candidate.state, "implementer", readiness)
            : role === "reviewer"
              ? roleView(candidate.state, "reviewer", readiness)
              : roleView(candidate.state, "committer", readiness);
      assert.deepEqual(
        view.permitted_next_actions,
        candidate.expected[role],
        `${candidate.name}: ${role}`,
      );
    }
  }
});

test("deterministic readiness fails closed without invoking repository integration", () => {
  const implementing = workflowState({ phase: "IMPLEMENTING" });
  assert.deepEqual(workflowLegality(implementing).actions.implementer, []);

  const approved = workflowState({ phase: "STOPPED_APPROVED" });
  assert.deepEqual(workflowLegality(approved).actions.parent, []);

  const prepared = workflowState({ phase: "COMMIT_PREPARED" });
  assert.deepEqual(workflowLegality(prepared).actions.committer, []);
});

test("deterministic fixture histories preserve reachable versions and evidence", () => {
  const reviewing = workflowState({ phase: "REVIEWING" });
  assert.equal(reviewing.version, 1);
  assert.equal(reviewing.implementation_status, "DONE");
  assert.equal(reviewing.implementation_receipt?.paths[0]?.state, "modified");

  const approved = workflowState({ phase: "STOPPED_APPROVED" });
  assert.equal(approved.version, 3);
  assert.equal(approved.review_result_version, 3);
  assert.equal(approved.review_receipt?.paths[0]?.state, "modified");

  const authorized = workflowState({ phase: "COMMIT_AUTHORIZED" });
  const prepared = workflowState({ phase: "COMMIT_PREPARED" });
  const committed = workflowState({ phase: "COMMITTED" });
  assert.equal(authorized.version, 4);
  assert.equal(prepared.version, 5);
  assert.equal(
    prepared.commit_preparation?.review_receipt_digest,
    objectDigest(prepared.review_receipt),
  );
  assert.deepEqual(prepared.commit_preparation?.expected_paths, ["note.txt"]);
  assert.equal(committed.version, 6);
  assert.notEqual(
    committed.commit_result?.outcome === "committed" ? committed.commit_result.commit_hash : null,
    prepared.commit_preparation?.prepared_head,
  );

  const repairRequired = workflowState({ phase: "REPAIR_REQUIRED" });
  const repairing = workflowState({ phase: "REPAIRING" });
  const exhausted = workflowState({ phase: "STOPPED_REPAIR_EXHAUSTED" });
  assert.equal(repairRequired.version, 3);
  assert.equal(repairing.version, 4);
  assert.equal(repairing.repair_cycle, 1);
  assert.equal(exhausted.version, 12);
  assert.equal(exhausted.repair_cycle, 2);
});
