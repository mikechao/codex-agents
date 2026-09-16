import { test } from "bun:test";
import assert from "node:assert/strict";
import { authoritativeImplementationContract } from "../implementation-contract.js";
import { replaceAuthoritativeImplementationContract } from "../transitions/state.js";
import {
  rebindImplementationPlan,
  roleView,
  submitImplementation,
  validateWorkflowStateV10,
  workflowLegality,
} from "../transitions.js";
import type {
  AcceptanceCriterionId,
  ContentDigest,
  ExactRepoPath,
  GitCommitSha,
  IsoTimestamp,
  PlanId,
  PlanRevision,
  PlanRevisionArtifact,
  ValidationRequirementId,
  WorkflowState,
  WorkflowVersion,
} from "../types.js";
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

test("authoritative contract replacement reports scope reconciliation without clearing overlays", () => {
  const state = workflowState({ workflow_type: "review_only", phase: "REVIEWING" });
  const planId = "00000000-0000-4000-8000-000000000158" as PlanId;
  const artifact: PlanRevisionArtifact = {
    plan_schema_version: 3,
    plan_id: planId,
    revision: 2 as PlanRevision,
    workflow_type: "change",
    full_plan: "replacement plan",
    execution_brief: "replacement brief",
    objective: "replacement objective",
    approved_paths: [...state.approved_paths, "new.txt" as ExactRepoPath].sort(),
    acceptance_criteria: [
      {
        criterion_id: "AC-001" as AcceptanceCriterionId,
        description: "replacement acceptance",
      },
    ],
    validation_requirements: [
      {
        validation_id: "VAL-001" as ValidationRequirementId,
        description: "replacement validation",
        kind: "command",
        argv: ["true"],
      },
    ],
    created_at: "2026-01-02T00:00:00.000Z" as IsoTimestamp,
  };
  const provenance = {
    plan_id: planId,
    revision: artifact.revision,
    artifact_digest:
      "2222222222222222222222222222222222222222222222222222222222222222" as ContentDigest,
    approved_at: "2026-01-02T00:01:00.000Z" as IsoTimestamp,
  };
  const before = structuredClone(state);
  const replacement = replaceAuthoritativeImplementationContract(
    state,
    authoritativeImplementationContract(artifact, provenance),
  );

  assert.deepEqual(replacement.prior_effective_paths, before.approved_paths);
  assert.deepEqual(replacement.artifact_declared_paths, artifact.approved_paths);
  assert.deepEqual(replacement.added_paths, ["new.txt"]);
  assert.deepEqual(state, before);
  const changedFields = Object.keys(replacement.state)
    .filter(
      (key) =>
        JSON.stringify(replacement.state[key as keyof WorkflowState]) !==
        JSON.stringify(before[key as keyof WorkflowState]),
    )
    .sort();
  assert.deepEqual(changedFields, [
    "acceptance_criteria",
    "approved_paths",
    "approved_plan",
    "execution_brief",
    "objective",
    "plan_provenance",
    "validation_requirements",
    "workflow_type",
  ]);
});

test("plan rebind after a repair block clears active lifecycle authority and resumes fresh implementation", () => {
  const repairing = workflowState({ phase: "REPAIRING" });
  const planId = "00000000-0000-4000-8000-000000000155" as PlanId;
  repairing.approved_plan = "revision one plan";
  repairing.execution_brief = "revision one brief";
  repairing.plan_provenance = {
    plan_id: planId,
    revision: 1 as PlanRevision,
    artifact_digest:
      "1111111111111111111111111111111111111111111111111111111111111111" as ContentDigest,
    approved_at: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
  };
  const blocked = submitImplementation(
    repairing,
    {
      workflow_id: repairing.workflow_id,
      expected_version: repairing.version,
      status: "BLOCKED",
      summary: "repair plan is blocked",
      agent_touched_paths: ["note.txt"],
      acceptance_results: repairing.acceptance_criteria.map(({ criterion_id }) => ({
        criterion_id,
        status: "not_satisfied",
        evidence: "blocked",
      })),
      validation_results: repairing.validation_requirements.map(({ validation_id }) => ({
        validation_id,
        status: "not_run",
        evidence: "blocked",
      })),
      known_failures: ["blocked repair"],
      finding_resolution_map: Object.fromEntries(
        repairing.repair_authorized_ids.map((id) => [id, "still_present"]),
      ),
    },
    "/deterministic-workflow-fixture",
    syntheticReceipt(),
  );
  blocked.version = (repairing.version + 1) as WorkflowVersion;
  const adjudications = blocked.finding_adjudications;
  const remediation = blocked.remediation_context;
  const replacementArtifact: PlanRevisionArtifact = {
    plan_schema_version: 3,
    plan_id: planId,
    revision: 2 as PlanRevision,
    workflow_type: "change",
    full_plan: "revision two plan",
    execution_brief: "revision two brief",
    objective: "revision two objective",
    approved_paths: blocked.approved_paths,
    acceptance_criteria: [
      {
        criterion_id: "AC-001" as AcceptanceCriterionId,
        description: "revision two acceptance",
      },
    ],
    validation_requirements: [
      {
        validation_id: "VAL-001" as ValidationRequirementId,
        description: "revision two validation",
        kind: "command",
        argv: ["true"],
      },
    ],
    created_at: "2026-01-02T00:00:00.000Z" as IsoTimestamp,
  };
  const replacementProvenance = {
    plan_id: planId,
    revision: 2 as PlanRevision,
    artifact_digest:
      "2222222222222222222222222222222222222222222222222222222222222222" as ContentDigest,
    approved_at: "2026-01-02T00:01:00.000Z" as IsoTimestamp,
  };
  const rebound = rebindImplementationPlan(
    blocked,
    authoritativeImplementationContract(replacementArtifact, replacementProvenance),
    syntheticReceipt(),
    "authorization must not enter semantic state",
  );

  assert.equal(rebound.phase, "IMPLEMENTING");
  assert.equal(rebound.repair_cycle, 0);
  assert.deepEqual(rebound.blocking_findings, []);
  assert.deepEqual(rebound.optional_findings, []);
  assert.deepEqual(rebound.prior_finding_classifications, {});
  assert.equal(rebound.review_result_version, null);
  assert.equal(rebound.review_start_receipt, null);
  assert.equal(rebound.review_receipt, null);
  assert.deepEqual(rebound.repair_authorized_ids, []);
  assert.equal(rebound.repair_directive, null);
  assert.equal(rebound.concern_acceptance, null);
  assert.equal(rebound.commit_authorization, null);
  assert.equal(rebound.commit_preparation, null);
  assert.equal(rebound.commit_result, null);
  assert.deepEqual(rebound.finding_adjudications, adjudications);
  assert.deepEqual(rebound.remediation_context, remediation);
  assert.equal(
    JSON.stringify(rebound).includes("authorization must not enter semantic state"),
    false,
  );
  assert.doesNotThrow(() =>
    validateWorkflowStateV10({
      ...rebound,
      version: (blocked.version + 1) as WorkflowVersion,
    }),
  );
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
