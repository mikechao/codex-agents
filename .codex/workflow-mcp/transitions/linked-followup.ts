import { fail } from "../errors.js";
import type {
  AcceptanceCriterion,
  AuthoritativeImplementationContract,
  ExactRepoPath,
  FindingId,
  GitCommitSha,
  ReviewFinding,
  ValidationRequirement,
  WorkflowId,
  WorkflowState,
  WorkItemReference,
} from "../types.js";
import {
  approvedPlan,
  boundedString,
  contractList,
  exactKeys,
  exactPaths,
  findingIdList,
  revision,
  userAuthorization,
} from "../validation.js";
import { effectiveBlockingFindings, linkedFollowupStateReadiness } from "./queries.js";
import { clone, ensurePhase } from "./shared.js";
import { baseState, createStateFromPlan } from "./state.js";

type LinkedFollowupAuthority =
  | {
      kind: "direct";
      workflow_type: "change";
      objective: string;
      approved_paths: ExactRepoPath[];
      acceptance_criteria: AcceptanceCriterion[];
      validation_requirements: ValidationRequirement[];
    }
  | {
      kind: "approved_plan";
      implementation_contract: AuthoritativeImplementationContract;
    };

export interface LinkedFollowupPlan {
  authority: LinkedFollowupAuthority;
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
  directFollowupPlan(args.approved_plan);
  const approvedPaths = exactPaths(args.approved_paths, repositoryRoot);
  return linkedFollowupInputCore(state, args, currentHead, {
    kind: "direct",
    workflow_type: "change",
    objective: boundedString(args.objective, "objective"),
    approved_paths: approvedPaths,
    acceptance_criteria: contractList(
      args.acceptance_criteria,
      "acceptance_criteria",
      "AC",
      "criterion_id",
    ),
    validation_requirements: contractList(
      args.validation_requirements,
      "validation_requirements",
      "VAL",
      "validation_id",
      true,
      { repositoryRoot, approvedPaths },
    ),
  });
}

function directFollowupPlan(value: unknown): null {
  if (approvedPlan(value) !== null) {
    fail("ERROR_INVALID_FOLLOWUP", "direct linked follow-ups cannot carry approved plan authority");
  }
  return null;
}

/** Adapt a server-resolved approved PlanArtifact to the shared linked-follow-up checks. */
export function linkedFollowupInputFromPlan(
  state: WorkflowState,
  input: unknown,
  contract: AuthoritativeImplementationContract,
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
  if (
    args.plan_id !== contract.plan_provenance.plan_id ||
    args.revision !== contract.plan_provenance.revision
  ) {
    fail("ERROR_INVALID_FOLLOWUP", "resolved plan identity does not match request");
  }
  return linkedFollowupInputCore(state, args, currentHead, {
    kind: "approved_plan",
    implementation_contract: contract,
  });
}

function linkedFollowupInputCore(
  state: WorkflowState,
  args: Record<string, unknown>,
  currentHead: GitCommitSha,
  authority: LinkedFollowupAuthority,
): LinkedFollowupPlan {
  ensurePhase(state, "STOPPED_APPROVED", "STOPPED_REPAIR_EXHAUSTED");
  const readiness = linkedFollowupStateReadiness(state);
  if (readiness === "superseded") {
    fail("ERROR_INVALID_FOLLOWUP", "workflow already has an active linked successor");
  }
  if (readiness === "unavailable") {
    fail("ERROR_INVALID_FOLLOWUP", "workflow has no findings available for follow-up");
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
  const remediationPaths =
    authority.kind === "approved_plan"
      ? authority.implementation_contract.artifact_approved_paths
      : authority.approved_paths;
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
    authority,
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
  const state =
    followup.authority.kind === "approved_plan"
      ? createStateFromPlan(
          followup.authority.implementation_contract,
          followup.base_head,
          followup.max_repair_cycles,
          followup.work_items,
        )
      : baseState({
          workflowType: followup.authority.workflow_type,
          objective: followup.authority.objective,
          approvedPlan: null,
          approvedPaths: followup.authority.approved_paths,
          baseHead: followup.base_head,
          maxRepairCycles: followup.max_repair_cycles,
          workItems: followup.work_items,
        });
  if (followup.authority.kind === "direct") {
    state.acceptance_criteria = clone(followup.authority.acceptance_criteria);
    state.validation_requirements = clone(followup.authority.validation_requirements);
  }
  state.parent_workflow_id = followup.parent_workflow_id;
  state.source_workflow_id = followup.source_workflow_id;
  state.linked_findings = clone(followup.linked_findings);
  state.linked_continuation = {
    root_workflow_id: followup.root_workflow_id,
    predecessor_workflow_id: followup.source_workflow_id as WorkflowId,
    lineage_workflow_ids: clone(followup.lineage_workflow_ids),
    original_base_head: followup.original_base_head,
    combined_review_paths: clone(followup.combined_review_paths),
    review_stage: followup.review_stage,
    remediation_review_receipt: null,
  };
  state.remediation_context = {
    policy: "explicitly_authorized",
    authorized_finding_ids: clone(followup.authorized_finding_ids),
    repair_cycle: 0,
    user_authorization: followup.user_authorization,
  };
  return state;
}
