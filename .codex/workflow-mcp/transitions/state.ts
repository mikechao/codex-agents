import { fail } from "../errors.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "../migration.js";
import type {
  ExactRepoPath,
  GitCommitSha,
  LinkedContinuation,
  PlanProvenance,
  PlanRevisionArtifact,
  RemediationContext,
  ReviewFinding,
  ReviewTarget,
  WorkflowId,
  WorkflowState,
  WorkflowType,
  WorkflowVersion,
  WorkItemReference,
} from "../types.js";
import {
  approvedPlan,
  boundedString,
  contractList,
  exactKeys,
  exactPaths,
  optionalText,
  repairCycle,
  revision,
  workItems,
} from "../validation.js";
import { isValue, REVIEW_MODE_VALUES, WORKFLOW_TYPE_VALUES } from "../values.js";
import { clone } from "./shared.js";

interface BaseStateOptions {
  objective: string;
  approvedPlan: string | null;
  approvedPaths: ExactRepoPath[];
  baseHead: GitCommitSha;
  maxRepairCycles: number;
  parentWorkflowId?: WorkflowId | null;
  workflowType?: WorkflowType;
  sourceWorkflowId?: WorkflowId | null;
  linkedFindings?: ReviewFinding[];
  remediationContext?: RemediationContext | null;
  linkedContinuation?: LinkedContinuation | null;
  supersededByWorkflowId?: WorkflowId | null;
  workItems?: WorkItemReference[];
  executionBrief?: string | null;
  planProvenance?: PlanProvenance | null;
}

export function baseState({
  objective,
  approvedPlan,
  approvedPaths,
  baseHead,
  maxRepairCycles,
  parentWorkflowId = null,
  workflowType = "change",
  sourceWorkflowId = null,
  linkedFindings = [],
  remediationContext = null,
  linkedContinuation = null,
  supersededByWorkflowId = null,
  workItems: inheritedWorkItems = [],
  executionBrief = null,
  planProvenance = null,
}: BaseStateOptions): WorkflowState {
  return {
    schema_version: CURRENT_STATE_SCHEMA_VERSION,
    version: 0 as WorkflowVersion, // producer cast; WorkflowVersion is branded
    workflow_id: null,
    workflow_type: workflowType,
    runtime_id: null,
    runtime_revision: null,
    phase: workflowType === "review_only" ? "REVIEWING" : "IMPLEMENTING",
    objective,
    approved_plan: approvedPlan,
    execution_brief: executionBrief,
    plan_provenance: planProvenance,
    work_items: clone(inheritedWorkItems),
    base_head: baseHead,
    approved_paths: approvedPaths,
    scope_expansions: [],
    approved_path_baselines: [],
    acceptance_criteria: [],
    validation_requirements: [],
    review_target: {
      review_mode: "working_tree",
      base_revision: baseHead,
      head_revision: null,
      approved_paths: approvedPaths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
    initial_receipt: null,
    review_start_receipt: null,
    dirty_baseline_paths: [],
    repair_cycle: 0,
    max_repair_cycles: maxRepairCycles,
    parent_workflow_id: parentWorkflowId,
    source_workflow_id: sourceWorkflowId,
    superseded_by_workflow_id: supersededByWorkflowId,
    linked_continuation: linkedContinuation,
    linked_findings: linkedFindings,
    remediation_context: remediationContext,
    implementation_summary: null,
    implementation_status: null,
    agent_touched_paths: [],
    scope_changed_paths: [],
    acceptance_results: [],
    validation_results: [],
    implementation_receipt: null,
    implementation_known_failures: [],
    finding_resolution_map: {},
    prior_finding_classifications: {},
    blocking_findings: [],
    optional_findings: [],
    finding_adjudications: [],
    review_result_version: null,
    review_receipt: null,
    stop_context: null,
    recovery_context: null,
    repair_authorized_ids: [],
    repair_directive: null,
    concern_acceptance: null,
    commit_authorization: null,
    commit_preparation: null,
    commit_result: null,
  };
}

function reviewTarget(
  value: unknown,
  approvedPaths: ReadonlyArray<ExactRepoPath>,
  repositoryRoot: string,
  currentHead: GitCommitSha,
  workflowType: WorkflowType,
): ReviewTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", "review target is invalid");
  }
  const args = exactKeys(
    value,
    [
      "review_mode",
      "base_revision",
      "head_revision",
      "approved_paths",
      "include_staged",
      "include_unstaged",
      "include_untracked",
    ],
    "review target",
  );
  const targetPaths = exactPaths(args.approved_paths, repositoryRoot);
  if (JSON.stringify(targetPaths) !== JSON.stringify(approvedPaths)) {
    fail("ERROR_INVALID_SHAPE", "review target paths do not match approved paths");
  }
  if (args.review_mode === REVIEW_MODE_VALUES[0]) {
    const baseRevision = revision(args.base_revision, "base_revision");
    if (baseRevision !== currentHead) fail("ERROR_STALE_BASE", "base HEAD is not current");
    if (args.head_revision !== null) {
      fail("ERROR_INVALID_SHAPE", "working-tree head revision is invalid");
    }
    if (
      args.include_staged !== true ||
      args.include_unstaged !== true ||
      args.include_untracked !== true
    ) {
      fail("ERROR_INVALID_SHAPE", "working-tree include flags are invalid");
    }
    return {
      review_mode: "working_tree",
      base_revision: baseRevision,
      head_revision: null,
      approved_paths: targetPaths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
  }
  if (args.review_mode === REVIEW_MODE_VALUES[1]) {
    if (workflowType !== "review_only") {
      fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "commit ranges require review-only workflows");
    }
    const baseRevision = revision(args.base_revision, "base_revision");
    const headRevision = revision(args.head_revision, "head_revision");
    if (
      args.include_staged !== false ||
      args.include_unstaged !== false ||
      args.include_untracked !== false
    ) {
      fail("ERROR_INVALID_SHAPE", "commit-range include flags are invalid");
    }
    return {
      review_mode: "commit_range",
      base_revision: baseRevision,
      head_revision: headRevision,
      approved_paths: targetPaths,
      include_staged: false,
      include_unstaged: false,
      include_untracked: false,
    };
  }
  fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "review mode is not supported");
}

export function createState(
  input: unknown,
  repositoryRoot: string,
  currentHead: GitCommitSha,
  options: { internal?: boolean } = {},
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "workflow input is invalid");
  }
  if (options.internal === true) {
    const args = exactKeys(
      input,
      ["objective", "approved_paths", "base_head", "max_repair_cycles", "parent_workflow_id"],
      "workflow input",
      ["base_head", "max_repair_cycles", "parent_workflow_id"],
    );
    const objective = boundedString(args.objective, "objective");
    const approvedPaths = exactPaths(args.approved_paths, repositoryRoot);
    const baseHead = revision(args.base_head ?? currentHead, "base_head");
    if (baseHead !== currentHead) fail("ERROR_STALE_BASE", "base HEAD is not current");
    const maxRepairCycles = repairCycle(args.max_repair_cycles ?? 2);
    return baseState({
      objective,
      approvedPlan: null,
      approvedPaths,
      baseHead,
      maxRepairCycles,
      parentWorkflowId: optionalText(
        args.parent_workflow_id,
        "parent_workflow_id",
        100,
      ) as WorkflowId | null, // brand cast; documented
      workItems: [],
    });
  }
  const args = exactKeys(
    input,
    [
      "workflow_type",
      "objective",
      "approved_plan",
      "approved_paths",
      "acceptance_criteria",
      "validation_requirements",
      "review_target",
      "max_repair_cycles",
    ],
    "workflow create",
    ["max_repair_cycles", "work_items"],
  );
  if (!isValue(WORKFLOW_TYPE_VALUES, args.workflow_type)) {
    fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "workflow type is not supported");
  }
  const objective = boundedString(args.objective, "objective");
  const plan = approvedPlan(args.approved_plan);
  const approvedPaths = exactPaths(args.approved_paths, repositoryRoot);
  const target = reviewTarget(
    args.review_target,
    approvedPaths,
    repositoryRoot,
    currentHead,
    args.workflow_type,
  );
  const maxRepairCycles = repairCycle(args.max_repair_cycles ?? 2);
  const state = baseState({
    objective,
    approvedPlan: plan,
    approvedPaths,
    baseHead: target.base_revision,
    maxRepairCycles,
    workflowType: args.workflow_type,
    workItems: workItems(args.work_items ?? []),
  });
  state.acceptance_criteria = contractList(
    args.acceptance_criteria,
    "acceptance_criteria",
    "AC",
    "criterion_id",
  );
  state.validation_requirements =
    args.workflow_type === "review_only"
      ? contractList(
          args.validation_requirements,
          "validation_requirements",
          "VAL",
          "validation_id",
          true,
        )
      : contractList(
          args.validation_requirements,
          "validation_requirements",
          "VAL",
          "validation_id",
        );
  state.review_target = target;
  return state;
}

/** Construct a workflow from an already-normalized, server-verified plan revision. */
export function createStateFromPlan(
  artifact: PlanRevisionArtifact,
  provenance: PlanProvenance,
  baseHead: GitCommitSha,
  maxRepairCycles: number,
  inheritedWorkItems: WorkItemReference[] = [],
): WorkflowState {
  const state = baseState({
    objective: artifact.objective,
    workflowType: artifact.workflow_type,
    approvedPlan: artifact.full_plan,
    executionBrief: artifact.execution_brief,
    planProvenance: provenance,
    approvedPaths: artifact.approved_paths,
    baseHead,
    maxRepairCycles,
    workItems: inheritedWorkItems,
  });
  state.acceptance_criteria = clone(artifact.acceptance_criteria);
  state.validation_requirements = clone(artifact.validation_requirements);
  state.review_target = {
    review_mode: "working_tree",
    base_revision: baseHead,
    head_revision: null,
    approved_paths: clone(artifact.approved_paths),
    include_staged: true,
    include_unstaged: true,
    include_untracked: true,
  };
  return state;
}
