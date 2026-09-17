import { createHash } from "node:crypto";
import { repairProposalForFindings } from "../repair-proposal.js";
import {
  authorizeCommit,
  authorizeRepair,
  beginReview,
  commitMismatch,
  commitPreparationFailed,
  createState,
  finalizeRepairExhausted,
  prepareCommit,
  submitCommitResult,
  submitImplementation,
  submitReview,
  validateWorkflowStateV10,
  type WorkflowLegalityReadiness,
} from "../transitions.js";
import type {
  BlockingFinding,
  ChangeReceipt,
  ContentDigest,
  ExactRepoPath,
  FindingId,
  GitCommitSha,
  GitFileMode,
  GitTreeSha,
  OptionalFinding,
  ReviewTarget,
  WorkflowId,
  WorkflowPhase,
  WorkflowState,
  WorkflowType,
  WorkflowVersion,
} from "../types.js";

export const TEST_HEAD = "1111111111111111111111111111111111111111" as GitCommitSha;
const TEST_TREE = "2222222222222222222222222222222222222222" as GitTreeSha;
const TEST_PATH = "note.txt" as ExactRepoPath;
const TEST_ROOT = "/deterministic-workflow-fixture";
const TEST_WORKFLOW_ID = "00000000-0000-4000-8000-000000000001" as WorkflowId;
const BEFORE_DIGEST =
  "3333333333333333333333333333333333333333333333333333333333333333" as ContentDigest;
const AFTER_DIGEST =
  "5555555555555555555555555555555555555555555555555555555555555555" as ContentDigest;

function resultingCommitHash(): GitCommitSha {
  const body = Buffer.from(
    `tree ${TEST_TREE}\nparent ${TEST_HEAD}\nauthor Workflow Tests <workflow@example.invalid> 1767225600 +0000\ncommitter Workflow Tests <workflow@example.invalid> 1767225600 +0000\n\ndeterministic commit\n`,
  );
  return createHash("sha1")
    .update(`commit ${body.length}\0`)
    .update(body)
    .digest("hex") as GitCommitSha;
}

const TEST_COMMIT = resultingCommitHash();

interface WorkflowStateFixtureOptions {
  phase?: WorkflowPhase;
  workflow_type?: WorkflowType;
  review_target?: ReviewTarget;
  blocking_findings?: BlockingFinding[];
  optional_findings?: OptionalFinding[];
  repair_cycle?: number;
}

function receipt(state: "modified" | "unchanged"): ChangeReceipt {
  const digest = state === "modified" ? AFTER_DIGEST : BEFORE_DIGEST;
  const payload = {
    schema_version: 1 as const,
    base_head: TEST_HEAD,
    approved_paths: [TEST_PATH],
    paths: [
      {
        path: TEST_PATH,
        state,
        kind: "file" as const,
        mode: "100644" as GitFileMode,
        digest,
      },
    ],
  };
  return {
    ...payload,
    overall_scope_hash: createHash("sha256")
      .update(JSON.stringify(payload))
      .digest("hex") as ContentDigest,
  };
}

function persistTransition(previous: WorkflowState, next: WorkflowState): WorkflowState {
  next.version = (previous.version + 1) as WorkflowVersion;
  return validateWorkflowStateV10(next);
}

function createdState(options: WorkflowStateFixtureOptions): WorkflowState {
  const workflowType = options.workflow_type ?? "change";
  const reviewTarget = options.review_target ?? {
    review_mode: "working_tree",
    base_revision: TEST_HEAD,
    head_revision: null,
    approved_paths: [TEST_PATH],
    include_staged: true,
    include_unstaged: true,
    include_untracked: true,
  };
  const state = createState(
    {
      workflow_type: workflowType,
      objective: "deterministic workflow fixture",
      approved_plan: null,
      approved_paths: [TEST_PATH],
      acceptance_criteria: ["the deterministic workflow is accepted"],
      validation_requirements:
        workflowType === "change"
          ? [{ description: "deterministic validation", kind: "command", argv: ["true"] }]
          : [],
      review_target: reviewTarget,
      max_repair_cycles: 2,
    },
    TEST_ROOT,
    TEST_HEAD,
  );
  state.workflow_id = TEST_WORKFLOW_ID;
  state.initial_receipt = reviewTarget.review_mode === "working_tree" ? receipt("unchanged") : null;
  state.dirty_baseline_paths = [];
  return validateWorkflowStateV10(state);
}

function implementationResult(
  state: WorkflowState,
  status: "BLOCKED" | "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT",
): WorkflowState {
  const findingResolutionMap = Object.fromEntries(
    (state.phase === "REPAIRING" ? state.repair_authorized_ids : []).map((id) => [
      id,
      "still_present",
    ]),
  );
  return persistTransition(
    state,
    submitImplementation(
      state,
      {
        workflow_id: state.workflow_id,
        expected_version: state.version,
        status,
        summary:
          status === "DONE"
            ? "deterministic implementation completed"
            : "deterministic implementation stopped",
        agent_touched_paths: [TEST_PATH],
        acceptance_results: state.acceptance_criteria.map(({ criterion_id }) => ({
          criterion_id,
          status: "satisfied",
          evidence: "deterministic acceptance evidence",
        })),
        validation_results: state.validation_requirements.map(({ validation_id }) => ({
          validation_id,
          status: "passed",
          evidence: "deterministic validation evidence",
        })),
        known_failures: [],
        finding_resolution_map: findingResolutionMap,
      },
      TEST_ROOT,
      receipt("modified"),
    ),
  );
}

function reviewingState(options: WorkflowStateFixtureOptions): WorkflowState {
  const created = createdState(options);
  return created.workflow_type === "change" ? implementationResult(created, "DONE") : created;
}

function reviewResult(
  state: WorkflowState,
  status: "APPROVED" | "CHANGES_REQUESTED" | "INCONCLUSIVE",
  blockingFindings: BlockingFinding[] = [],
  optionalFindings: OptionalFinding[] = [],
): WorkflowState {
  let reviewing = state;
  if (reviewing.review_target.review_mode === "working_tree") {
    reviewing = persistTransition(
      reviewing,
      beginReview(
        reviewing,
        { workflow_id: reviewing.workflow_id, expected_version: reviewing.version },
        receipt("modified"),
      ),
    );
  }
  const priorFindingClassifications = Object.fromEntries(
    reviewing.blocking_findings.map((finding) => [finding.finding_id, "still_present"]),
  );
  return persistTransition(
    reviewing,
    submitReview(
      reviewing,
      {
        workflow_id: reviewing.workflow_id,
        expected_version: reviewing.version,
        review_status: status,
        blocking_findings: blockingFindings,
        optional_findings: optionalFindings,
        prior_finding_classifications: priorFindingClassifications,
        ...(reviewing.validation_requirements.length > 0
          ? {
              validation_results: reviewing.validation_requirements.map(({ validation_id }) => ({
                validation_id,
                status: "passed",
                evidence: "fresh deterministic reviewer evidence",
              })),
            }
          : {}),
        ...(reviewing.repair_directive
          ? {
              repair_conformance: {
                status: "conforming",
                evidence: "the deterministic repair follows its directive",
              },
            }
          : {}),
      },
      reviewing.review_target.review_mode === "working_tree" ? receipt("modified") : null,
    ),
  );
}

function authorizeRepairResult(state: WorkflowState): WorkflowState {
  const findings = state.blocking_findings;
  const findingIds = findings.map((finding) => finding.finding_id);
  return persistTransition(
    state,
    authorizeRepair(
      state,
      {
        workflow_id: state.workflow_id,
        expected_version: state.version,
        finding_ids: findingIds,
        repair_directive: {
          selected_finding_ids: findingIds,
          ...repairProposalForFindings(findings),
          user_authorization: "deterministic repair authorization",
        },
      },
      TEST_ROOT,
    ),
  );
}

function repairRequiredState(
  options: WorkflowStateFixtureOptions,
  completedRepairCycles: number,
): WorkflowState {
  const findings = options.blocking_findings ?? [blockingFinding()];
  let state = reviewResult(reviewingState(options), "CHANGES_REQUESTED", findings);
  for (let cycle = 0; cycle < completedRepairCycles; cycle += 1) {
    state = authorizeRepairResult(state);
    state = implementationResult(state, "DONE");
    state = reviewResult(state, "CHANGES_REQUESTED", findings);
  }
  return state;
}

function approvedState(options: WorkflowStateFixtureOptions): WorkflowState {
  return reviewResult(reviewingState(options), "APPROVED", [], options.optional_findings ?? []);
}

function commitAuthorizedState(options: WorkflowStateFixtureOptions): WorkflowState {
  const approved = approvedState(options);
  return persistTransition(
    approved,
    authorizeCommit(approved, {
      workflow_id: approved.workflow_id,
      expected_version: approved.version,
      user_authorization: "deterministic commit authorization",
    }),
  );
}

function commitPreparedState(options: WorkflowStateFixtureOptions): WorkflowState {
  const authorized = commitAuthorizedState(options);
  return persistTransition(
    authorized,
    prepareCommit(
      authorized,
      { workflow_id: authorized.workflow_id, expected_version: authorized.version },
      {
        prepared_head: TEST_HEAD,
        prepared_tree: TEST_TREE,
        expected_paths: [TEST_PATH],
      },
    ),
  );
}

export function deterministicReadiness(
  state: WorkflowState,
  overrides: WorkflowLegalityReadiness = {},
): WorkflowLegalityReadiness {
  return {
    head: { status: "readable", current_head: state.base_head },
    implementation_submission: { status: "ready" },
    review: {
      status:
        state.review_target.review_mode === "commit_range" || state.review_start_receipt
          ? "submit"
          : "begin",
    },
    review_recovery: { status: "resume" },
    approved_review: { status: "current" },
    commit_preparation: { status: "ready" },
    commit_review_return: { status: "ready" },
    commit_result: { status: "ready", authority: "committer" },
    ...overrides,
  };
}

export function workflowState(options: WorkflowStateFixtureOptions = {}): WorkflowState {
  const phase =
    options.phase ?? (options.workflow_type === "review_only" ? "REVIEWING" : "IMPLEMENTING");
  let state: WorkflowState;
  switch (phase) {
    case "IMPLEMENTING":
      state = createdState(options);
      break;
    case "REVIEWING":
      state = reviewingState(options);
      break;
    case "REPAIR_REQUIRED":
      state = repairRequiredState(options, options.repair_cycle ?? 0);
      break;
    case "REPAIRING":
      state = authorizeRepairResult(repairRequiredState(options, (options.repair_cycle ?? 1) - 1));
      break;
    case "STOPPED_REPAIR_EXHAUSTED": {
      const exhausted = repairRequiredState(options, 2);
      state = persistTransition(
        exhausted,
        finalizeRepairExhausted(exhausted, {
          workflow_id: exhausted.workflow_id,
          expected_version: exhausted.version,
        }),
      );
      break;
    }
    case "STOPPED_APPROVED":
      state = approvedState(options);
      break;
    case "STOPPED_INCONCLUSIVE":
      state = reviewResult(reviewingState(options), "INCONCLUSIVE");
      break;
    case "STOPPED_CONCERNS":
      state = implementationResult(createdState(options), "DONE_WITH_CONCERNS");
      break;
    case "STOPPED_NEEDS_CONTEXT":
      state = implementationResult(createdState(options), "NEEDS_CONTEXT");
      break;
    case "STOPPED_IMPLEMENTATION_BLOCKED":
      state = implementationResult(createdState(options), "BLOCKED");
      break;
    case "COMMIT_AUTHORIZED":
      state = commitAuthorizedState(options);
      break;
    case "COMMIT_PREPARED":
      state = commitPreparedState(options);
      break;
    case "STOPPED_COMMIT_PREPARATION": {
      const authorized = commitAuthorizedState(options);
      state = persistTransition(
        authorized,
        commitPreparationFailed(
          authorized,
          "ERROR_STAGED_CONTENT",
          "deterministic commit preparation failure",
        ),
      );
      break;
    }
    case "STOPPED_NOT_COMMITTED": {
      const prepared = commitPreparedState(options);
      state = persistTransition(
        prepared,
        submitCommitResult(
          prepared,
          {
            workflow_id: prepared.workflow_id,
            expected_version: prepared.version,
            attempt_id: prepared.commit_preparation?.attempt_id,
            outcome: "not_committed",
            failure_summary: "deterministic commit failure",
          },
          null,
        ),
      );
      break;
    }
    case "COMMITTED": {
      const prepared = commitPreparedState(options);
      state = persistTransition(
        prepared,
        submitCommitResult(
          prepared,
          {
            workflow_id: prepared.workflow_id,
            expected_version: prepared.version,
            attempt_id: prepared.commit_preparation?.attempt_id,
            outcome: "committed",
            failure_summary: null,
          },
          TEST_COMMIT,
        ),
      );
      break;
    }
    case "STOPPED_COMMIT_MISMATCH": {
      const prepared = commitPreparedState(options);
      state = persistTransition(prepared, commitMismatch(prepared, "HEAD_CHANGED"));
      break;
    }
    default:
      throw new Error(`unsupported deterministic fixture phase: ${phase}`);
  }
  return validateWorkflowStateV10(state);
}

export function blockingFinding(id = "F-1"): BlockingFinding {
  return {
    finding_id: id as FindingId,
    severity: "P1" as const,
    blocking: true,
    file_and_line: "note.txt:1",
    failure_scenario: "the deterministic scenario fails",
    impact: "the contract is violated",
    violated_requirement: "the workflow must remain safe",
    remediation: "apply the bounded repair",
    missing_or_inadequate_test: "cover the repaired behavior",
  };
}

export function optionalFinding(id = "F-OPTIONAL"): OptionalFinding {
  return {
    ...blockingFinding(id),
    severity: "P3",
    blocking: false,
  };
}

export function syntheticReceipt(): ChangeReceipt {
  return receipt("modified");
}
