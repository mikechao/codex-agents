import { fail } from "./errors.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./migration.js";
import { effectiveBlockingFindings } from "./transition-queries.js";
import {
  changedReceiptPaths,
  dirtyBaselinePaths,
  rangeDirtyBaselinePaths,
  scopeChangedPaths,
} from "./transition-receipts.js";
import { clone, ensurePhase } from "./transition-shared.js";

export {
  authorizeCommit,
  commitMismatch,
  commitPreparationFailed,
  MISMATCH_CATEGORIES,
  prepareCommit,
  retryCommit,
  retryCommitPreparation,
  returnCommitToReview,
  submitCommitResult,
  validateCommitResult,
} from "./transition-commit.js";
export {
  acceptConcerns,
  adoptDirtyScope,
  expandScope,
  IMPLEMENTATION_STOP_PHASES,
  resumeImplementation,
  submitImplementation,
} from "./transition-implementation.js";
export {
  adjudicateFindings,
  authorizeRepair,
  beginReview,
  finalizeRepairExhausted,
  recordManualValidation,
  resumeReview,
  submitReview,
} from "./transition-review.js";
export { ensurePhase } from "./transition-shared.js";

import { baseState } from "./transition-state.js";
import type {
  AcceptanceCriterion,
  ExactRepoPath,
  FindingId,
  GitCommitSha,
  PlanProvenance,
  PlanRevisionArtifact,
  ReviewFinding,
  ValidationAuthoringRequirement,
  ValidationRequirement,
  WorkflowId,
  WorkflowPhase,
  WorkflowState,
  WorkflowType,
  WorkItemReference,
} from "./types.js";
import {
  approvedPlan,
  boundedString,
  contractList,
  exactKeys,
  exactPaths,
  findingIdList,
  revision,
  userAuthorization,
} from "./validation.js";
import { WORKFLOW_PHASE_VALUES } from "./values.js";

export { V10_STATE_KEYS, validateWorkflowStateV10 } from "./state-validation.js";
export {
  allRequiredValidationsPassed,
  approvedPathBaselineView,
  effectiveBlockingFindings,
  hasFailedRequiredValidation,
  pendingInspectionValidations,
  permittedNextActions,
  REVIEWER_IMPLEMENTER_HANDOFF,
  ROLE_VIEW_COMMON,
  ROLE_VIEW_EXTRA,
  reviewBlockedByPendingInspection,
  roleView,
} from "./transition-queries.js";
export { changedReceiptPaths, dirtyBaselinePaths, rangeDirtyBaselinePaths, scopeChangedPaths };

export const SCHEMA_VERSION = CURRENT_STATE_SCHEMA_VERSION;

export { createState, createStateFromPlan } from "./transition-state.js";

export const PHASES: readonly WorkflowPhase[] = WORKFLOW_PHASE_VALUES;

export interface LinkedFollowupPlan {
  workflow_type: WorkflowType;
  objective: string;
  approved_plan: string | null;
  execution_brief: string | null;
  plan_provenance: PlanProvenance | null;
  approved_paths: ExactRepoPath[];
  acceptance_criteria: AcceptanceCriterion[] | string[];
  validation_requirements: ValidationRequirement[] | ValidationAuthoringRequirement[];
  base_head: GitCommitSha;
  max_repair_cycles: number;
  parent_workflow_id: WorkflowId | null;
  source_workflow_id: WorkflowId | null;
  authorized_finding_ids: FindingId[];
  linked_findings: ReviewFinding[];
  user_authorization: string;
  combined_review_paths: ExactRepoPath[];
  original_base_head: GitCommitSha;
  root_workflow_id: WorkflowId;
  lineage_workflow_ids: WorkflowId[];
  review_stage: "remediation";
  work_items: WorkItemReference[];
}

export function linkedFollowupInput(
  state: WorkflowState,
  input: unknown,
  repositoryRoot: string,
  currentHead: GitCommitSha,
): LinkedFollowupPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_FOLLOWUP", "follow-up input is invalid");
  }
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "expected_version",
      "objective",
      "approved_plan",
      "approved_paths",
      "acceptance_criteria",
      "validation_requirements",
      "finding_ids",
      "user_authorization",
    ],
    "linked follow-up",
  );
  return linkedFollowupInputCore(
    state,
    args,
    exactPaths(args.approved_paths, repositoryRoot),
    currentHead,
    {
      workflow_type: "change",
      objective: boundedString(args.objective, "objective"),
      approved_plan: approvedPlan(args.approved_plan),
      execution_brief: null,
      plan_provenance: null,
      acceptance_criteria: args.acceptance_criteria as string[],
      validation_requirements: args.validation_requirements as ValidationAuthoringRequirement[],
    },
  );
}

/** Adapt a server-resolved approved PlanArtifact to the shared linked-follow-up checks. */
export function linkedFollowupInputFromPlan(
  state: WorkflowState,
  input: unknown,
  artifact: PlanRevisionArtifact,
  provenance: PlanProvenance,
  currentHead: GitCommitSha,
): LinkedFollowupPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_FOLLOWUP", "plan linked follow-up input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "plan_id", "revision", "finding_ids", "user_authorization"],
    "plan linked follow-up",
  );
  if (args.plan_id !== artifact.plan_id || args.revision !== artifact.revision) {
    fail("ERROR_INVALID_FOLLOWUP", "resolved plan identity does not match request");
  }
  return linkedFollowupInputCore(state, args, artifact.approved_paths, currentHead, {
    workflow_type: artifact.workflow_type,
    objective: artifact.objective,
    approved_plan: artifact.full_plan,
    execution_brief: artifact.execution_brief,
    plan_provenance: provenance,
    acceptance_criteria: clone(artifact.acceptance_criteria),
    validation_requirements: clone(artifact.validation_requirements),
  });
}

interface LinkedFollowupContract {
  workflow_type: WorkflowType;
  objective: string;
  approved_plan: string | null;
  execution_brief: string | null;
  plan_provenance: PlanProvenance | null;
  acceptance_criteria: AcceptanceCriterion[] | string[];
  validation_requirements: ValidationRequirement[] | ValidationAuthoringRequirement[];
}

function linkedFollowupInputCore(
  state: WorkflowState,
  args: Record<string, unknown>,
  remediationPaths: ExactRepoPath[],
  currentHead: GitCommitSha,
  contract: LinkedFollowupContract,
): LinkedFollowupPlan {
  ensurePhase(state, "STOPPED_APPROVED", "STOPPED_REPAIR_EXHAUSTED");
  if (state.superseded_by_workflow_id) {
    fail("ERROR_INVALID_FOLLOWUP", "workflow already has an active linked successor");
  }
  const ids = findingIdList(args.finding_ids, "finding_ids", "ERROR_INVALID_FOLLOWUP");
  const blocking = new Set(effectiveBlockingFindings(state).map((finding) => finding.finding_id));
  const optional = new Set(state.optional_findings.map((finding) => finding.finding_id));
  const fromBlocking = ids.every((id) => blocking.has(id));
  const fromOptional = ids.every((id) => optional.has(id));
  if (fromBlocking === fromOptional) {
    fail("ERROR_INVALID_FOLLOWUP", "finding IDs must come from one bucket");
  }
  const linkedFindings = [...effectiveBlockingFindings(state), ...state.optional_findings].filter(
    (finding) => ids.includes(finding.finding_id),
  );
  const isWorkingTree = state.review_target.review_mode === "working_tree";
  const inheritedCombined =
    state.linked_continuation?.combined_review_paths ?? state.review_target.approved_paths;
  const combinedPaths = [...new Set([...inheritedCombined, ...remediationPaths])].sort();
  const originalBase = isWorkingTree
    ? (state.linked_continuation?.original_base_head ?? state.base_head)
    : currentHead;
  if (currentHead !== originalBase) fail("ERROR_STALE_BASE", "linked follow-up base is stale");
  const root = state.linked_continuation?.root_workflow_id ?? state.workflow_id;
  if (!root || !state.workflow_id)
    fail("ERROR_STATE_CORRUPT", "linked workflow provenance is missing");
  const lineage = state.linked_continuation
    ? [...state.linked_continuation.lineage_workflow_ids, state.workflow_id]
    : [state.workflow_id];
  return {
    workflow_type: contract.workflow_type,
    objective: contract.objective,
    approved_plan: contract.approved_plan,
    execution_brief: contract.execution_brief,
    plan_provenance: contract.plan_provenance,
    approved_paths: remediationPaths,
    acceptance_criteria: contract.acceptance_criteria,
    validation_requirements: contract.validation_requirements,
    base_head: revision(originalBase, "base_head"),
    max_repair_cycles: state.max_repair_cycles,
    parent_workflow_id: state.workflow_id,
    source_workflow_id: state.workflow_id,
    authorized_finding_ids: ids.slice().sort(),
    linked_findings: linkedFindings,
    user_authorization: userAuthorization(args.user_authorization),
    combined_review_paths: combinedPaths,
    original_base_head: revision(originalBase, "original_base_head"),
    root_workflow_id: root,
    lineage_workflow_ids: lineage,
    review_stage: "remediation",
    work_items: clone(state.work_items),
  };
}

export function linkedFollowupChildState(followup: LinkedFollowupPlan): WorkflowState {
  const state = baseState({
    workflowType: followup.workflow_type,
    objective: followup.objective,
    approvedPlan: followup.approved_plan,
    executionBrief: followup.execution_brief,
    planProvenance: followup.plan_provenance,
    approvedPaths: followup.approved_paths,
    baseHead: followup.base_head,
    maxRepairCycles: followup.max_repair_cycles,
    parentWorkflowId: followup.parent_workflow_id,
    sourceWorkflowId: followup.source_workflow_id,
    linkedFindings: followup.linked_findings,
    linkedContinuation: {
      root_workflow_id: followup.root_workflow_id,
      predecessor_workflow_id: followup.source_workflow_id as WorkflowId,
      lineage_workflow_ids: followup.lineage_workflow_ids,
      original_base_head: followup.original_base_head,
      combined_review_paths: followup.combined_review_paths,
      review_stage: followup.review_stage,
      remediation_review_receipt: null,
    },
    workItems: followup.work_items,
    remediationContext: {
      policy: "explicitly_authorized",
      authorized_finding_ids: followup.authorized_finding_ids,
      repair_cycle: 0,
      user_authorization: followup.user_authorization,
    },
  });
  if (followup.plan_provenance) {
    state.acceptance_criteria = clone(followup.acceptance_criteria) as AcceptanceCriterion[];
    state.validation_requirements = clone(
      followup.validation_requirements,
    ) as ValidationRequirement[];
  } else {
    state.acceptance_criteria = contractList(
      followup.acceptance_criteria,
      "acceptance_criteria",
      "AC",
      "criterion_id",
    );
    state.validation_requirements = contractList(
      followup.validation_requirements,
      "validation_requirements",
      "VAL",
      "validation_id",
    );
  }
  return state;
}
