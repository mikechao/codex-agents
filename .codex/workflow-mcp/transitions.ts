import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./migration.js";
import type {
  ApprovedPathBaseline,
  ApprovedPathBaselineView,
  BlockingFinding,
  ChangeReceipt,
  CommitAttemptId,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitPreparationFailureCategory,
  CommitterView,
  ExactRepoPath,
  FindingAdjudication,
  FindingAdjudicationDisposition,
  FindingId,
  FindingResolution,
  FindingSeverity,
  GitCommitSha,
  ImplementerView,
  LinkedContinuation,
  ParentView,
  RemediationContext,
  ReviewerView,
  ReviewFinding,
  ReviewRange,
  ReviewTarget,
  Role,
  RoleView,
  StoppingImplementationStatus,
  WorkflowAction,
  WorkflowId,
  WorkflowPhase,
  WorkflowState,
  WorkflowType,
  WorkflowVersion,
  WorkItemReference,
} from "./types.js";
import {
  ACCEPTANCE_STATUSES,
  approvedPlan,
  boundedString,
  canonicalJson,
  contractList,
  evidenceResults,
  exactKeys,
  exactPaths,
  findingIdList,
  findings,
  isoNow,
  MAX_APPROVED_PLAN,
  MAX_CONTRACTS,
  MAX_DETAIL,
  MAX_FINDINGS,
  MAX_PATHS,
  MAX_TEXT,
  objectDigest,
  optionalText,
  RESOLUTION_STATUSES,
  repairCycle,
  resolutionMap,
  revision,
  role,
  stringList,
  userAuthorization,
  VALIDATION_STATUSES,
  workItems,
} from "./validation.js";

export const SCHEMA_VERSION = CURRENT_STATE_SCHEMA_VERSION;

export const IMPLEMENTATION_STOP_PHASES: Record<StoppingImplementationStatus, WorkflowPhase> = {
  DONE_WITH_CONCERNS: "STOPPED_CONCERNS",
  NEEDS_CONTEXT: "STOPPED_NEEDS_CONTEXT",
  BLOCKED: "STOPPED_IMPLEMENTATION_BLOCKED",
};

export function approvedPathBaselineView(value: ApprovedPathBaseline): ApprovedPathBaselineView {
  const { baseline } = value;
  if (baseline.state === "absent") {
    return {
      path: value.path,
      approved_at_version: value.approved_at_version,
      baseline: { path: baseline.path, state: baseline.state, kind: baseline.kind },
    };
  }
  if (baseline.state === "deleted") {
    return {
      path: value.path,
      approved_at_version: value.approved_at_version,
      baseline: {
        path: baseline.path,
        state: baseline.state,
        kind: baseline.kind,
        mode: baseline.mode,
      },
    };
  }
  return {
    path: value.path,
    approved_at_version: value.approved_at_version,
    baseline: {
      path: baseline.path,
      state: baseline.state,
      kind: baseline.kind,
      mode: baseline.mode,
    },
  };
}

export const PHASES: readonly WorkflowPhase[] = [
  "IMPLEMENTING",
  "REVIEWING",
  "REPAIR_REQUIRED",
  "REPAIRING",
  "STOPPED_APPROVED",
  "STOPPED_INCONCLUSIVE",
  "STOPPED_CONCERNS",
  "STOPPED_NEEDS_CONTEXT",
  "STOPPED_IMPLEMENTATION_BLOCKED",
  "STOPPED_REPAIR_EXHAUSTED",
  "COMMIT_AUTHORIZED",
  "COMMIT_PREPARED",
  "STOPPED_COMMIT_PREPARATION",
  "STOPPED_NOT_COMMITTED",
  "STOPPED_COMMIT_MISMATCH",
  "COMMITTED",
];

export const MISMATCH_CATEGORIES: ReadonlySet<CommitMismatchCategory> = new Set([
  "HEAD_CHANGED",
  "PARENT_MISMATCH",
  "TREE_MISMATCH",
  "PATH_MISMATCH",
]);

const V7_STATE_KEYS: readonly string[] = [
  "schema_version",
  "version",
  "workflow_id",
  "workflow_type",
  "runtime_id",
  "runtime_revision",
  "phase",
  "objective",
  "approved_plan",
  "work_items",
  "base_head",
  "approved_paths",
  "scope_expansions",
  "approved_path_baselines",
  "acceptance_criteria",
  "validation_requirements",
  "review_target",
  "initial_receipt",
  "review_start_receipt",
  "dirty_baseline_paths",
  "repair_cycle",
  "max_repair_cycles",
  "parent_workflow_id",
  "source_workflow_id",
  "superseded_by_workflow_id",
  "linked_continuation",
  "linked_findings",
  "remediation_context",
  "implementation_summary",
  "implementation_status",
  "agent_touched_paths",
  "scope_changed_paths",
  "acceptance_results",
  "validation_results",
  "implementation_receipt",
  "implementation_known_failures",
  "finding_resolution_map",
  "prior_finding_classifications",
  "blocking_findings",
  "optional_findings",
  "finding_adjudications",
  "review_result_version",
  "review_receipt",
  "stop_context",
  "recovery_context",
  "repair_authorized_ids",
  "concern_acceptance",
  "commit_authorization",
  "commit_preparation",
  "commit_result",
];

function ensurePhase(state: WorkflowState, ...allowed: WorkflowPhase[]): void {
  if (!allowed.includes(state.phase)) fail("ERROR_INVALID_TRANSITION", `phase ${state.phase}`);
}

function scopeExpansion(
  state: WorkflowState,
  input: unknown,
  addedReceipt: ChangeReceipt,
  repositoryRoot: string,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "scope expansion input is invalid");
  }
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "capability",
      "expected_version",
      "added_paths",
      "reason",
      "user_authorization",
    ],
    "scope expansion",
  );
  ensurePhase(
    state,
    "IMPLEMENTING",
    "REPAIR_REQUIRED",
    "REPAIRING",
    "STOPPED_NEEDS_CONTEXT",
    "STOPPED_IMPLEMENTATION_BLOCKED",
  );
  if (state.workflow_type !== "change" || state.review_target.review_mode !== "working_tree") {
    fail(
      "ERROR_UNSUPPORTED_WORKFLOW_TYPE",
      "scope expansion requires a working-tree change workflow",
    );
  }
  const addedPaths = exactPaths(args.added_paths, repositoryRoot);
  if (addedPaths.some((path) => state.approved_paths.includes(path))) {
    fail("ERROR_INVALID_PATHS", "scope expansion path is already approved");
  }
  if (state.approved_paths.length + addedPaths.length > MAX_PATHS) {
    fail("ERROR_INVALID_PATHS", "scope expansion exceeds the path limit");
  }
  if (addedReceipt.base_head !== state.base_head) {
    fail("ERROR_STALE_RECEIPT", "scope expansion baseline is stale");
  }
  if (
    addedReceipt.approved_paths.length !== addedPaths.length ||
    addedReceipt.approved_paths.some((path, index) => path !== addedPaths[index])
  ) {
    fail("ERROR_INVALID_PATHS", "scope expansion baseline scope is invalid");
  }
  if (addedReceipt.paths.some((entry) => entry.state !== "unchanged" && entry.state !== "absent")) {
    fail(
      "ERROR_SCOPE_EXPANSION_DIRTY",
      "scope expansion paths must have clean or absent baselines",
    );
  }
  const priorVersion = state.version;
  const next = clone(state);
  const resultingPaths = [...state.approved_paths, ...addedPaths].sort();
  next.approved_paths = resultingPaths;
  const combinedPaths = next.linked_continuation?.combined_review_paths ?? resultingPaths;
  if (next.linked_continuation) {
    next.linked_continuation.combined_review_paths = [
      ...new Set([...combinedPaths, ...addedPaths]),
    ].sort();
  }
  next.review_target = {
    ...next.review_target,
    approved_paths:
      next.linked_continuation?.review_stage === "combined"
        ? next.linked_continuation.combined_review_paths
        : resultingPaths,
  };
  next.scope_expansions.push({
    expansion_id: randomUUID(),
    added_paths: addedPaths,
    reason: boundedString(args.reason, "reason", MAX_DETAIL),
    user_authorization: userAuthorization(args.user_authorization),
    prior_version: priorVersion,
    resulting_version: (priorVersion + 1) as WorkflowVersion,
    authorized_at: isoNow(),
  });
  next.approved_path_baselines.push(
    ...addedReceipt.paths.map((entry) => ({
      path: entry.path,
      approved_at_version: (priorVersion + 1) as WorkflowVersion,
      baseline: clone(entry),
    })),
  );
  next.implementation_receipt = null;
  next.scope_changed_paths = [];
  next.review_start_receipt = null;
  next.review_receipt = null;
  next.commit_authorization = null;
  next.commit_preparation = null;
  next.commit_result = null;
  return next;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function samePathList(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

const ROLE_VIEW_COMMON: readonly string[] = [
  "workflow_id",
  "schema_version",
  "version",
  "workflow_type",
  "phase",
  "objective",
  "approved_paths",
  "repair_cycle",
  "max_repair_cycles",
  "review_target",
  "superseded_by_workflow_id",
  "linked_continuation",
];

const REVIEWER_IMPLEMENTER_HANDOFF: readonly string[] = [
  "implementation_summary",
  "implementation_status",
  "implementation_receipt",
  "implementation_known_failures",
  "agent_touched_paths",
  "scope_changed_paths",
  "acceptance_results",
  "validation_results",
  "finding_resolution_map",
];

const ROLE_VIEW_EXTRA: Record<"implementer" | "reviewer" | "committer", readonly string[]> = {
  implementer: [
    "approved_plan",
    "acceptance_criteria",
    "validation_requirements",
    "initial_receipt",
    "dirty_baseline_paths",
    "linked_findings",
    "remediation_context",
    "implementation_summary",
    "implementation_status",
    "implementation_receipt",
    "implementation_known_failures",
    "agent_touched_paths",
    "scope_changed_paths",
    "acceptance_results",
    "validation_results",
    "finding_resolution_map",
    "blocking_findings",
    "repair_authorized_ids",
    "stop_context",
    "recovery_context",
  ],
  reviewer: [
    "acceptance_criteria",
    "validation_requirements",
    "dirty_baseline_paths",
    "linked_findings",
    "implementation_summary",
    "implementation_status",
    "implementation_receipt",
    "implementation_known_failures",
    "agent_touched_paths",
    "scope_changed_paths",
    "acceptance_results",
    "validation_results",
    "finding_resolution_map",
    "blocking_findings",
    "optional_findings",
    "prior_finding_classifications",
    "finding_adjudications",
    "review_result_version",
    "concern_acceptance",
    "review_receipt",
    "stop_context",
    "recovery_context",
  ],
  committer: [
    "work_items",
    "acceptance_criteria",
    "validation_requirements",
    "dirty_baseline_paths",
    "agent_touched_paths",
    "scope_changed_paths",
    "implementation_summary",
    "implementation_status",
    "implementation_receipt",
    "implementation_known_failures",
    "acceptance_results",
    "validation_results",
    "blocking_findings",
    "optional_findings",
    "prior_finding_classifications",
    "concern_acceptance",
    "review_receipt",
    "commit_authorization",
    "commit_preparation",
    "commit_result",
    "stop_context",
    "recovery_context",
  ],
};

const ACTION_MATRIX: Partial<
  Record<Role, Partial<Record<WorkflowPhase, readonly WorkflowAction[]>>>
> = {
  implementer: {
    IMPLEMENTING: ["workflow_submit_implementation"],
    REPAIRING: ["workflow_submit_implementation"],
  },
  reviewer: {
    REVIEWING: ["workflow_begin_review", "workflow_submit_review"],
  },
  parent: {
    IMPLEMENTING: ["workflow_expand_scope"],
    REPAIR_REQUIRED: [
      "workflow_authorize_repair",
      "workflow_adjudicate_findings",
      "workflow_expand_scope",
      "workflow_finalize_repair_exhausted",
    ],
    REPAIRING: ["workflow_expand_scope"],
    STOPPED_APPROVED: ["workflow_authorize_commit", "workflow_create_linked_followup"],
    STOPPED_REPAIR_EXHAUSTED: ["workflow_create_linked_followup"],
    STOPPED_CONCERNS: ["workflow_accept_concerns"],
    STOPPED_NEEDS_CONTEXT: ["workflow_expand_scope", "workflow_resume_implementation"],
    STOPPED_IMPLEMENTATION_BLOCKED: ["workflow_expand_scope", "workflow_resume_implementation"],
    STOPPED_INCONCLUSIVE: ["workflow_adopt_dirty_scope", "workflow_resume_review"],
    STOPPED_NOT_COMMITTED: ["workflow_retry_commit"],
    STOPPED_COMMIT_PREPARATION: [
      "workflow_retry_commit_preparation",
      "workflow_return_commit_to_review",
    ],
  },
  committer: {
    COMMIT_AUTHORIZED: ["workflow_prepare_commit"],
    COMMIT_PREPARED: ["workflow_submit_commit_result"],
  },
};

const INTERNAL_RECEIPT_FIELDS = new Set([
  "initial_receipt",
  "review_start_receipt",
  "implementation_receipt",
  "review_receipt",
  "approved_path_baselines",
]);

export function permittedNextActions(state: WorkflowState, actorRole: Role): WorkflowAction[] {
  role(actorRole);
  let actions = [...(ACTION_MATRIX[actorRole]?.[state.phase] ?? [])];
  if (actorRole === "reviewer" && state.phase === "REVIEWING") {
    if (state.review_target.review_mode === "commit_range") {
      actions = ["workflow_submit_review"];
    } else if (state.review_start_receipt) {
      actions = ["workflow_submit_review"];
    } else {
      actions = ["workflow_begin_review"];
    }
  }
  if (actorRole === "parent" && state.phase === "REPAIR_REQUIRED") {
    if (effectiveBlockingFindings(state).length === 0) {
      actions = [];
    }
  }
  if (
    actorRole === "parent" &&
    state.phase === "STOPPED_APPROVED" &&
    state.review_target?.review_mode !== "working_tree"
  ) {
    actions = actions.filter((action) => action !== "workflow_authorize_commit");
  }
  if (actorRole === "parent" && state.phase === "STOPPED_COMMIT_PREPARATION") {
    const recovery =
      state.stop_context?.status === "COMMIT_PREPARATION_FAILED"
        ? state.stop_context.recovery
        : null;
    actions = actions.filter((action) =>
      recovery === "retry"
        ? action === "workflow_retry_commit_preparation"
        : recovery === "review"
          ? action === "workflow_return_commit_to_review"
          : false,
    );
  }
  if (actorRole === "parent" && state.superseded_by_workflow_id) {
    actions = actions.filter(
      (action) =>
        action !== "workflow_authorize_commit" && action !== "workflow_create_linked_followup",
    );
  }
  return actions.sort();
}

export function roleView(state: WorkflowState, actorRole: "parent"): ParentView;
export function roleView(state: WorkflowState, actorRole: "implementer"): ImplementerView;
export function roleView(state: WorkflowState, actorRole: "reviewer"): ReviewerView;
export function roleView(state: WorkflowState, actorRole: "committer"): CommitterView;
export function roleView(state: WorkflowState, actorRole: Role): RoleView {
  role(actorRole);
  const view: Record<string, unknown> = {};
  const raw = state as unknown as Record<string, unknown>;
  for (const key of ROLE_VIEW_COMMON) {
    if (key in raw) {
      if (
        (key === "superseded_by_workflow_id" || key === "linked_continuation") &&
        raw[key] === null
      ) {
        continue;
      }
      if (key === "linked_continuation" && raw[key] !== null) {
        const continuation = raw[key] as LinkedContinuation;
        view[key] = { ...clone(continuation), remediation_review_receipt: null };
      } else {
        view[key] = clone(raw[key]);
      }
    }
  }
  view.permitted_next_actions = permittedNextActions(state, actorRole);
  if (actorRole === "parent") {
    for (const key of Object.keys(state)) {
      if (ROLE_VIEW_COMMON.includes(key)) continue;
      if (key === "approved_path_baselines") {
        view[key] = (raw[key] as ApprovedPathBaseline[]).map(approvedPathBaselineView);
        continue;
      }
      if (INTERNAL_RECEIPT_FIELDS.has(key)) continue;
      if (key === "commit_preparation" && raw[key] !== null) {
        const { review_receipt_digest: _digest, ...sanitized } = raw[key] as Record<
          string,
          unknown
        >;
        view[key] = clone(sanitized);
        continue;
      }
      view[key] = clone(raw[key]);
    }
  } else {
    const extra =
      actorRole === "reviewer" && state.workflow_type === "review_only"
        ? ROLE_VIEW_EXTRA[actorRole].filter((key) => !REVIEWER_IMPLEMENTER_HANDOFF.includes(key))
        : ROLE_VIEW_EXTRA[actorRole];
    for (const key of extra) {
      if (
        key === "linked_findings" &&
        actorRole === "reviewer" &&
        state.linked_continuation === null
      )
        continue;
      if (INTERNAL_RECEIPT_FIELDS.has(key)) continue;
      if (key === "commit_preparation" && raw[key] !== null) {
        const { review_receipt_digest: _digest, ...sanitized } = raw[key] as Record<
          string,
          unknown
        >;
        view[key] = clone(sanitized);
        continue;
      }
      if (key in raw) view[key] = clone(raw[key]);
    }
  }
  return view as RoleView;
}

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
}

function baseState({
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
}: BaseStateOptions): WorkflowState {
  return {
    schema_version: SCHEMA_VERSION,
    version: 0 as WorkflowVersion, // producer cast; WorkflowVersion is branded
    workflow_id: null,
    workflow_type: workflowType,
    runtime_id: null,
    runtime_revision: null,
    phase: workflowType === "review_only" ? "REVIEWING" : "IMPLEMENTING",
    objective,
    approved_plan: approvedPlan,
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
  if (args.review_mode === "working_tree") {
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
  if (args.review_mode === "commit_range") {
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
  if (args.workflow_type !== "change" && args.workflow_type !== "review_only") {
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

export function submitImplementation(
  state: WorkflowState,
  input: unknown,
  repositoryRoot: string,
  freshReceipt: ChangeReceipt,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "implementation input is invalid");
  }
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "expected_version",
      "status",
      "summary",
      "agent_touched_paths",
      "acceptance_results",
      "validation_results",
      "known_failures",
      "finding_resolution_map",
    ],
    "implementation submission",
  );
  ensurePhase(state, "IMPLEMENTING", "REPAIRING");
  if (
    args.status !== "DONE" &&
    args.status !== "DONE_WITH_CONCERNS" &&
    args.status !== "INCOMPLETE" &&
    args.status !== "NEEDS_CONTEXT" &&
    args.status !== "BLOCKED"
  ) {
    fail("ERROR_INVALID_IMPLEMENTATION", "implementation status is invalid");
  }
  const touchedPaths = exactPaths(args.agent_touched_paths, repositoryRoot, true);
  const approved = new Set(state.approved_paths);
  if (touchedPaths.some((path) => !approved.has(path))) {
    fail("ERROR_INVALID_IMPLEMENTATION", "touched path is not in approved scope");
  }
  const acceptanceResults = evidenceResults(
    args.acceptance_results,
    "acceptance",
    state.acceptance_criteria,
    "criterion_id",
    ACCEPTANCE_STATUSES,
  );
  const validationResults = evidenceResults(
    args.validation_results,
    "validation",
    state.validation_requirements,
    "validation_id",
    VALIDATION_STATUSES,
  );
  const knownFailures = stringList(args.known_failures, "known_failures");
  const priorIds = (
    state.phase === "REPAIRING"
      ? [
          ...(state.linked_continuation?.review_stage === "remediation"
            ? state.linked_findings.map((finding) => finding.finding_id)
            : []),
          ...state.repair_authorized_ids,
        ]
      : state.linked_continuation?.review_stage === "remediation"
        ? state.linked_findings.map((finding) => finding.finding_id)
        : []
  ).filter((id, index, ids) => ids.indexOf(id) === index);
  const resolution = resolutionMap(args.finding_resolution_map, priorIds, "finding_resolution_map");
  if (
    state.phase === "IMPLEMENTING" &&
    state.linked_findings.length === 0 &&
    Object.keys(resolution).length > 0
  ) {
    fail("ERROR_INVALID_FINDING", "initial implementation has prior resolutions");
  }
  const next = clone(state);
  next.implementation_summary = boundedString(args.summary, "summary", 4000);
  next.implementation_status = args.status;
  next.agent_touched_paths = touchedPaths;
  next.acceptance_results = acceptanceResults;
  next.validation_results = validationResults;
  // Documented producer cast: the store verified canonical equality with the fresh receipt first.
  next.implementation_receipt = JSON.parse(JSON.stringify(freshReceipt)) as ChangeReceipt;
  next.implementation_known_failures = knownFailures;
  next.finding_resolution_map = resolution;
  next.scope_changed_paths = scopeChangedPaths(
    state.initial_receipt,
    state.approved_path_baselines,
    next.implementation_receipt,
  );
  if (args.status === "DONE" || args.status === "DONE_WITH_CONCERNS") {
    if (acceptanceResults.some((item) => item.status !== "satisfied")) {
      fail("ERROR_INVALID_IMPLEMENTATION", "complete implementation requires satisfied criteria");
    }
  }
  if (args.status === "DONE") {
    if (validationResults.some((item) => item.status !== "passed")) {
      fail("ERROR_INVALID_IMPLEMENTATION", "done implementation requires passed validations");
    }
    if (knownFailures.length > 0) {
      fail("ERROR_INVALID_IMPLEMENTATION", "done implementation has known failures");
    }
    next.repair_authorized_ids = [];
    next.phase = "REVIEWING";
  }
  if (args.status !== "DONE" && args.status !== "INCOMPLETE") {
    next.stop_context = {
      status: args.status,
      summary: boundedString(args.summary, "summary", 4000),
      // Safe producer-side narrowing: ensurePhase guarantees the phase at runtime.
      stopped_from: state.phase as "IMPLEMENTING" | "REPAIRING",
    };
    if (state.phase === "IMPLEMENTING") next.repair_authorized_ids = [];
  }
  if (args.status !== "DONE" && args.status !== "INCOMPLETE") {
    next.phase = IMPLEMENTATION_STOP_PHASES[args.status];
  }
  return next;
}

export function expandScope(
  state: WorkflowState,
  input: unknown,
  addedReceipt: ChangeReceipt,
  repositoryRoot: string,
): WorkflowState {
  return scopeExpansion(state, input, addedReceipt, repositoryRoot);
}

export function adoptDirtyScope(
  state: WorkflowState,
  input: unknown,
  addedReceipt: ChangeReceipt,
  repositoryRoot: string,
  indexDirtyPaths: ReadonlyArray<string> = [],
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "dirty scope adoption input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "reason", "user_authorization"],
    "dirty scope adoption",
    ["added_paths", "adopted_paths"],
  );
  ensurePhase(state, "STOPPED_INCONCLUSIVE");
  if (state.workflow_type !== "change" || state.review_target.review_mode !== "working_tree") {
    fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "dirty scope adoption requires a working-tree review");
  }
  if ((args.added_paths === undefined) === (args.adopted_paths === undefined)) {
    fail("ERROR_INVALID_SHAPE", "dirty scope adoption paths are invalid");
  }
  const adoptedPaths = exactPaths(args.adopted_paths ?? args.added_paths, repositoryRoot);
  const expansion = state.scope_expansions.find((candidate) =>
    samePathList(candidate.added_paths, adoptedPaths),
  );
  if (!expansion) {
    fail("ERROR_INVALID_PATHS", "dirty scope adoption paths are not from a scope expansion");
  }
  if (addedReceipt.base_head !== state.base_head) {
    fail("ERROR_STALE_RECEIPT", "dirty scope adoption baseline is stale");
  }
  if (
    addedReceipt.approved_paths.length !== adoptedPaths.length ||
    addedReceipt.approved_paths.some((path, index) => path !== adoptedPaths[index])
  ) {
    fail("ERROR_INVALID_PATHS", "dirty scope adoption scope is invalid");
  }
  const indexDirty = new Set(indexDirtyPaths);
  if (
    addedReceipt.paths.some(
      (entry) =>
        !["added", "modified", "deleted"].includes(entry.state) && !indexDirty.has(entry.path),
    )
  ) {
    fail("ERROR_SCOPE_EXPANSION_DIRTY", "scope adoption paths must be dirty");
  }
  const next = clone(state);
  // Adoption changes only the authorization/audit version. The existing expansion remains the
  // immutable provenance for the paths and its historical baseline.
  next.review_start_receipt = null;
  next.review_receipt = null;
  return next;
}

export function resumeImplementation(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "resume input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "resume_context"],
    "implementation resume",
  );
  ensurePhase(state, "STOPPED_NEEDS_CONTEXT", "STOPPED_IMPLEMENTATION_BLOCKED");
  const stoppedFrom = state.stop_context?.stopped_from;
  if (!stoppedFrom || (stoppedFrom !== "IMPLEMENTING" && stoppedFrom !== "REPAIRING")) {
    fail("ERROR_STATE_CORRUPT", "stop context is invalid");
  }
  const next = clone(state);
  next.phase = stoppedFrom;
  next.stop_context = null;
  next.recovery_context = {
    kind: "implementation",
    context: boundedString(args.resume_context, "resume_context", 2000),
    recovered_at: isoNow(),
  };
  return next;
}

export function acceptConcerns(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "concern acceptance input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "user_authorization"],
    "concern acceptance",
  );
  ensurePhase(state, "STOPPED_CONCERNS");
  const next = clone(state);
  next.concern_acceptance = {
    user_authorization: userAuthorization(args.user_authorization),
    accepted_at: isoNow(),
  };
  next.phase = "REVIEWING";
  next.stop_context = null;
  return next;
}

export function beginReview(
  state: WorkflowState,
  input: unknown,
  startReceipt: ChangeReceipt,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REVIEW", "review begin input is invalid");
  }
  exactKeys(input, ["workflow_id", "expected_version"], "review begin");
  ensurePhase(state, "REVIEWING");
  if (state.review_target.review_mode !== "working_tree") {
    fail("ERROR_INVALID_REVIEW", "commit-range reviews do not use review snapshots");
  }
  if (startReceipt.base_head !== state.base_head) {
    fail("ERROR_STALE_RECEIPT", "review snapshot base is stale; begin review again");
  }
  if (
    state.review_start_receipt &&
    canonicalJson(state.review_start_receipt) === canonicalJson(startReceipt)
  ) {
    fail(
      "ERROR_INVALID_REVIEW",
      "review has already begun; submit the review before beginning again",
    );
  }
  const next = clone(state);
  next.review_start_receipt = clone(startReceipt);
  return next;
}

export function submitReview(
  state: WorkflowState,
  input: unknown,
  finalReceipt: ChangeReceipt | null = null,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REVIEW", "review input is invalid");
  }
  ensurePhase(state, "REVIEWING");
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "expected_version",
      "review_status",
      "blocking_findings",
      "optional_findings",
      "prior_finding_classifications",
    ],
    "review submission",
  );
  if (
    args.review_status !== "APPROVED" &&
    args.review_status !== "CHANGES_REQUESTED" &&
    args.review_status !== "INCONCLUSIVE"
  ) {
    fail("ERROR_INVALID_REVIEW", "review status is invalid");
  }
  const blockingFindings = findings(args.blocking_findings ?? [], "blocking_findings", true);
  const optionalFindings = findings(args.optional_findings ?? [], "optional_findings", false);
  const unionIds = [...blockingFindings, ...optionalFindings].map((item) => item.finding_id);
  if (new Set(unionIds).size !== unionIds.length) {
    fail("ERROR_INVALID_FINDING", "finding ID is duplicated across buckets");
  }
  const carriedIds =
    state.linked_continuation?.review_stage === "remediation"
      ? state.linked_findings.map((item) => item.finding_id)
      : [];
  const priorIds = [
    ...carriedIds,
    ...state.blocking_findings.map((item) => item.finding_id),
    ...state.optional_findings.map((item) => item.finding_id),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const classifications = resolutionMap(
    args.prior_finding_classifications,
    priorIds,
    "prior_finding_classifications",
  );
  const adjudicatedIds = new Set(state.finding_adjudications.map((item) => item.finding_id));
  for (const finding of [...blockingFindings, ...optionalFindings]) {
    if (adjudicatedIds.has(finding.finding_id)) {
      fail("ERROR_INVALID_FINDING", "an adjudicated finding cannot be re-emitted");
    }
  }
  for (const finding of state.blocking_findings) {
    if (
      adjudicatedIds.has(finding.finding_id) &&
      classifications[finding.finding_id] !== "superseded"
    ) {
      fail("ERROR_INVALID_FINDING", "adjudicated findings must be classified superseded");
    }
  }
  for (const [id, status] of Object.entries(classifications)) {
    if (status === "still_present") {
      const prior =
        state.blocking_findings.find((item) => item.finding_id === id) ??
        state.optional_findings.find((item) => item.finding_id === id) ??
        (state.linked_continuation?.review_stage === "remediation"
          ? state.linked_findings.find((item) => item.finding_id === id)
          : undefined);
      if (prior) {
        const current = (prior.blocking ? blockingFindings : optionalFindings).find(
          (item) => item.finding_id === id,
        );
        if (
          !current ||
          current.severity !== prior.severity ||
          current.blocking !== prior.blocking
        ) {
          fail("ERROR_INVALID_FINDING", "still-present blocker changed bucket or severity");
        }
        continue;
      }
      fail("ERROR_INVALID_FINDING", "still-present finding changed bucket or severity");
    }
  }
  if (
    blockingFindings.some((item) => (item.severity as FindingSeverity) === "P3") ||
    optionalFindings.some((item) => item.severity !== "P3")
  ) {
    fail("ERROR_INVALID_REVIEW", "finding severity does not match list");
  }
  if (args.review_status === "APPROVED" && blockingFindings.length > 0) {
    fail("ERROR_INVALID_REVIEW", "approved review contains blockers");
  }
  if (args.review_status === "CHANGES_REQUESTED" && blockingFindings.length === 0) {
    fail("ERROR_INVALID_REVIEW", "changes requested without blockers");
  }
  const next = clone(state);
  next.blocking_findings = blockingFindings;
  next.optional_findings = optionalFindings;
  next.prior_finding_classifications = classifications;
  next.review_result_version = (state.version + 1) as WorkflowVersion;
  next.review_receipt = finalReceipt ? clone(finalReceipt) : null;
  next.review_start_receipt = null;
  if (args.review_status === "APPROVED") {
    const continuation = state.linked_continuation;
    if (continuation?.review_stage === "remediation") {
      const unresolvedFinding = state.linked_findings.some(
        (finding) =>
          classifications[finding.finding_id] !== "resolved" &&
          classifications[finding.finding_id] !== "superseded",
      );
      if (unresolvedFinding) {
        fail("ERROR_INVALID_REVIEW", "carried findings must be resolved before combined review");
      }
      if (!finalReceipt) fail("ERROR_INVALID_REVIEW", "remediation approval requires a receipt");
      next.linked_continuation = {
        ...continuation,
        remediation_review_receipt: clone(finalReceipt),
        review_stage: "combined",
      };
      next.review_receipt = null;
      next.review_target = {
        ...next.review_target,
        approved_paths: continuation.combined_review_paths,
        base_revision: continuation.original_base_head,
      };
      next.phase = "REVIEWING";
    } else {
      next.phase = "STOPPED_APPROVED";
    }
  }
  if (args.review_status === "INCONCLUSIVE") {
    next.phase = "STOPPED_INCONCLUSIVE";
    next.stop_context = {
      status: "INCONCLUSIVE",
      summary: "review context unavailable",
      stopped_from: "REVIEWING",
    };
  }
  if (args.review_status === "CHANGES_REQUESTED") next.phase = "REPAIR_REQUIRED";
  return next;
}

export function effectiveBlockingFindings(state: WorkflowState): BlockingFinding[] {
  const adjudicated = new Set(
    state.finding_adjudications
      .filter((item) => item.source_review_version === state.review_result_version)
      .map((item) => item.finding_id),
  );
  return state.blocking_findings.filter((finding) => !adjudicated.has(finding.finding_id));
}

export function adjudicateFindings(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REPAIR", "finding adjudication input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "findings", "user_authorization"],
    "finding adjudication",
  );
  ensurePhase(state, "REPAIR_REQUIRED");
  const authorization = userAuthorization(args.user_authorization);
  if (state.review_result_version === null) {
    fail("ERROR_INVALID_FINDING", "latest review result is missing");
  }
  const current = effectiveBlockingFindings(state);
  if (current.length === 0) fail("ERROR_INVALID_FINDING", "no effective blockers remain");
  if (
    !Array.isArray(args.findings) ||
    args.findings.length === 0 ||
    args.findings.length > current.length
  ) {
    fail("ERROR_INVALID_FINDING", "finding adjudications are invalid");
  }
  const currentById = new Map(current.map((finding) => [finding.finding_id, finding]));
  const historical = new Set(state.finding_adjudications.map((item) => item.finding_id));
  const records: FindingAdjudication[] = [];
  const seen = new Set<string>();
  for (const raw of args.findings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("ERROR_INVALID_FINDING", "finding adjudication is invalid");
    }
    const item = exactKeys(raw, ["finding_id", "disposition", "reason"], "finding adjudication");
    const id = item.finding_id as FindingId;
    if (
      typeof item.finding_id !== "string" ||
      seen.has(id) ||
      historical.has(id) ||
      !currentById.has(id)
    ) {
      fail("ERROR_INVALID_FINDING", "finding ID is stale, reused, or not an effective blocker");
    }
    if (
      item.disposition !== "CONTRACT_INCONSISTENT" &&
      item.disposition !== "OUTSIDE_APPROVED_SCOPE"
    ) {
      fail("ERROR_INVALID_FINDING", "finding disposition is invalid");
    }
    seen.add(id);
    records.push({
      finding_id: id as FindingId,
      finding_snapshot: clone(currentById.get(id as FindingId) as BlockingFinding),
      source_review_version: state.review_result_version,
      disposition: item.disposition as FindingAdjudicationDisposition,
      reason: boundedString(item.reason, "reason", MAX_DETAIL),
      user_authorization: authorization,
      adjudicated_at: isoNow(),
      resulting_workflow_version: (state.version + 1) as WorkflowVersion,
    });
  }
  const next = clone(state);
  next.finding_adjudications.push(...records);
  if (effectiveBlockingFindings(next).length === 0) {
    next.phase = "REVIEWING";
    next.repair_authorized_ids = [];
  }
  return next;
}

export function authorizeRepair(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REPAIR", "repair input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "finding_ids"],
    "repair authorization",
  );
  ensurePhase(state, "REPAIR_REQUIRED");
  const ids = findingIdList(args.finding_ids, "finding_ids", "ERROR_INVALID_REPAIR");
  const effective = effectiveBlockingFindings(state);
  if (ids.length > effective.length) {
    fail("ERROR_INVALID_REPAIR", "finding IDs are invalid");
  }
  const existing = new Set(effective.map((item) => item.finding_id));
  if (ids.some((id) => !existing.has(id)))
    fail("ERROR_INVALID_REPAIR", "finding ID is not a blocker");
  if (state.repair_cycle >= state.max_repair_cycles) {
    fail("ERROR_REPAIR_LIMIT", "repair cycle limit reached");
  }
  const next = clone(state);
  next.repair_cycle += 1;
  next.repair_authorized_ids = [...ids].sort();
  next.phase = "REPAIRING";
  return next;
}

export function resumeReview(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "review resume input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "resume_context"],
    "review resume",
  );
  ensurePhase(state, "STOPPED_INCONCLUSIVE");
  const next = clone(state);
  next.phase = "REVIEWING";
  next.stop_context = null;
  next.recovery_context = {
    kind: "review",
    context: boundedString(args.resume_context, "resume_context", 2000),
    recovered_at: isoNow(),
  };
  return next;
}

export function finalizeRepairExhausted(state: WorkflowState, input: unknown): WorkflowState {
  exactKeys(input, ["workflow_id", "capability", "expected_version"], "repair exhaustion");
  ensurePhase(state, "REPAIR_REQUIRED");
  if (effectiveBlockingFindings(state).length === 0)
    fail("ERROR_INVALID_REPAIR", "no effective blockers remain");
  if (state.repair_cycle < state.max_repair_cycles)
    fail("ERROR_REPAIR_LIMIT", "repair cycles remain");
  const next = clone(state);
  next.phase = "STOPPED_REPAIR_EXHAUSTED";
  return next;
}

export function authorizeCommit(state: WorkflowState, authorization: unknown): WorkflowState {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
    fail("ERROR_INVALID_SHAPE", "commit authorization is invalid");
  }
  const args = exactKeys(
    authorization,
    ["workflow_id", "capability", "expected_version", "user_authorization"],
    "commit authorization",
  );
  ensurePhase(state, "STOPPED_APPROVED");
  const next = clone(state);
  next.commit_authorization = {
    user_authorization: userAuthorization(args.user_authorization),
    authorized_at: isoNow(),
  };
  next.phase = "COMMIT_AUTHORIZED";
  return next;
}

export function commitMismatch(
  state: WorkflowState,
  category: CommitMismatchCategory,
): WorkflowState {
  if (!MISMATCH_CATEGORIES.has(category)) {
    fail("ERROR_STATE_CORRUPT", "mismatch category is invalid");
  }
  const next = clone(state);
  next.commit_result = { outcome: "mismatch", mismatch_category: category };
  next.phase = "STOPPED_COMMIT_MISMATCH";
  return next;
}

export function commitPreparationFailed(
  state: WorkflowState,
  category: CommitPreparationFailureCategory,
  summary: string,
): WorkflowState {
  ensurePhase(state, "COMMIT_AUTHORIZED");
  const next = clone(state);
  next.phase = "STOPPED_COMMIT_PREPARATION";
  next.stop_context = {
    status: "COMMIT_PREPARATION_FAILED",
    category,
    summary: boundedString(summary, "preparation failure summary", 2000),
    recovery: category === "ERROR_STALE_RECEIPT" ? "review" : "retry",
    failed_at: isoNow(),
    failed_version: (state.version + 1) as WorkflowVersion,
    stopped_from: "COMMIT_AUTHORIZED",
  };
  next.commit_preparation = null;
  next.commit_result = null;
  return next;
}

export function prepareCommit(
  state: WorkflowState,
  input: unknown,
  evidence: CommitPreparationEvidence,
): WorkflowState {
  exactKeys(input, ["workflow_id", "expected_version"], "commit preparation");
  ensurePhase(state, "COMMIT_AUTHORIZED");
  const next = clone(state);
  next.commit_preparation = {
    attempt_id: randomUUID() as CommitAttemptId, // documented brand cast
    prepared_head: evidence.prepared_head,
    prepared_tree: evidence.prepared_tree,
    expected_paths: evidence.expected_paths,
    review_receipt_digest: objectDigest(state.review_receipt),
    prepared_at: isoNow(),
  };
  next.phase = "COMMIT_PREPARED";
  return next;
}

export function retryCommitPreparation(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit preparation retry input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "retry_context"],
    "commit preparation retry",
  );
  ensurePhase(state, "STOPPED_COMMIT_PREPARATION");
  if (
    state.stop_context?.status !== "COMMIT_PREPARATION_FAILED" ||
    state.stop_context.recovery !== "retry"
  ) {
    fail("ERROR_INVALID_TRANSITION", "preparation failure requires review recovery");
  }
  const next = clone(state);
  next.phase = "COMMIT_AUTHORIZED";
  next.stop_context = null;
  next.recovery_context = {
    kind: "commit",
    context: boundedString(args.retry_context, "retry_context", 2000),
    recovered_at: isoNow(),
  };
  return next;
}

export function returnCommitToReview(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit review recovery input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "review_context"],
    "commit review recovery",
  );
  ensurePhase(state, "STOPPED_COMMIT_PREPARATION");
  if (
    state.stop_context?.status !== "COMMIT_PREPARATION_FAILED" ||
    state.stop_context.recovery !== "review"
  ) {
    fail("ERROR_INVALID_TRANSITION", "preparation failure is retryable");
  }
  const next = clone(state);
  next.phase = "REVIEWING";
  next.stop_context = null;
  next.recovery_context = {
    kind: "review",
    context: boundedString(args.review_context, "review_context", 2000),
    recovered_at: isoNow(),
  };
  next.review_receipt = null;
  next.review_start_receipt = null;
  next.commit_authorization = null;
  next.commit_preparation = null;
  next.commit_result = null;
  return next;
}

function commitResultInput(state: WorkflowState, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit result input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "attempt_id", "outcome", "failure_summary"],
    "commit result",
  );
  ensurePhase(state, "COMMIT_PREPARED");
  if (state.commit_preparation?.attempt_id !== args.attempt_id) {
    fail("ERROR_COMMIT_MISMATCH", "attempt ID does not match the prepared attempt");
  }
  if (args.outcome !== "committed" && args.outcome !== "not_committed") {
    fail("ERROR_INVALID_SHAPE", "commit outcome is invalid");
  }
  if (args.outcome === "committed" && args.failure_summary !== null) {
    fail("ERROR_INVALID_SHAPE", "committed result cannot include a failure summary");
  }
  if (args.outcome === "not_committed") {
    if (args.failure_summary === null || typeof args.failure_summary !== "string") {
      fail("ERROR_INVALID_SHAPE", "not-committed result requires a failure summary");
    }
    boundedString(args.failure_summary, "failure_summary", 2000);
  }
  return args;
}

export function validateCommitResult(state: WorkflowState, input: unknown): void {
  commitResultInput(state, input);
}

export function submitCommitResult(
  state: WorkflowState,
  input: unknown,
  verifiedCommitHash: GitCommitSha | null,
): WorkflowState {
  const args = commitResultInput(state, input);
  const next = clone(state);
  if (args.outcome === "committed") {
    if (verifiedCommitHash === null) {
      fail("ERROR_COMMIT_MISMATCH", "committed result was not verified");
    }
    next.commit_result = {
      outcome: "committed",
      commit_hash: verifiedCommitHash,
      failure_summary: null,
    };
    next.phase = "COMMITTED";
  } else {
    next.commit_result = {
      outcome: "not_committed",
      commit_hash: null,
      failure_summary: boundedString(args.failure_summary, "failure_summary", 2000),
    };
    next.phase = "STOPPED_NOT_COMMITTED";
  }
  return next;
}

export function retryCommit(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit retry input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "retry_context"],
    "commit retry",
  );
  ensurePhase(state, "STOPPED_NOT_COMMITTED");
  const next = clone(state);
  next.commit_preparation = null;
  next.commit_result = null;
  next.phase = "COMMIT_AUTHORIZED";
  next.recovery_context = {
    kind: "commit",
    context: boundedString(args.retry_context, "retry_context", 2000),
    recovered_at: isoNow(),
  };
  return next;
}

export interface LinkedFollowupPlan {
  objective: string;
  approved_plan: string | null;
  approved_paths: ExactRepoPath[];
  acceptance_criteria: string[]; // raw caller order; contractList runs in child
  validation_requirements: string[];
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
      "capability",
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
  const remediationPaths = exactPaths(args.approved_paths, repositoryRoot);
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
    objective: boundedString(args.objective, "objective"),
    approved_plan: approvedPlan(args.approved_plan),
    approved_paths: remediationPaths,
    acceptance_criteria: args.acceptance_criteria as string[], // raw passthrough to the child
    validation_requirements: args.validation_requirements as string[],
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
    objective: followup.objective,
    approvedPlan: followup.approved_plan,
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
  return state;
}

export function changedReceiptPaths(receipt: ChangeReceipt | null | undefined): ExactRepoPath[] {
  if (!receipt || !Array.isArray(receipt.paths)) return [];
  return receipt.paths
    .filter((item) => item.state !== "unchanged")
    .map((item) => item.path)
    .sort();
}

export function dirtyBaselinePaths(receipt: ChangeReceipt | null | undefined): ExactRepoPath[] {
  if (!receipt || !Array.isArray(receipt.paths)) return [];
  return receipt.paths
    .filter((item) => ["added", "modified", "deleted"].includes(item.state))
    .map((item) => item.path)
    .sort();
}

export function rangeDirtyBaselinePaths(range: ReviewRange | null | undefined): ExactRepoPath[] {
  if (!range || !Array.isArray(range.paths)) return [];
  return range.paths
    .filter((item) => ["added", "modified", "deleted"].includes(item.kind))
    .map((item) => item.path)
    .sort();
}

export function scopeChangedPaths(
  initialReceipt: ChangeReceipt | null,
  approvedPathBaselines: ApprovedPathBaseline[],
  finalReceipt: ChangeReceipt | null,
): ExactRepoPath[] {
  if (
    !initialReceipt ||
    !Array.isArray(initialReceipt.paths) ||
    !finalReceipt ||
    !Array.isArray(finalReceipt.paths)
  ) {
    fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
  }
  const baselines = [
    ...initialReceipt.paths,
    ...approvedPathBaselines.map((entry) => entry.baseline),
  ];
  const initialByPath = new Map(baselines.map((entry) => [entry.path, entry]));
  const finalByPath = new Map(finalReceipt.paths.map((entry) => [entry.path, entry]));
  const changed: ExactRepoPath[] = [];
  for (const entry of baselines) {
    const initialEntry = initialByPath.get(entry.path);
    const finalEntry = finalByPath.get(entry.path);
    if (!initialEntry || !finalEntry) fail("ERROR_STATE_CORRUPT", "receipt scope is invalid");
    const { state: _initialState, ...initialRest } = initialEntry;
    const { state: _finalState, ...finalRest } = finalEntry;
    if (canonicalJson(initialRest) !== canonicalJson(finalRest)) changed.push(entry.path);
  }
  return changed.sort();
}

function corrupt(): never {
  fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const STATE_FINDING_KEYS: readonly string[] = [
  "finding_id",
  "severity",
  "blocking",
  "file_and_line",
  "failure_scenario",
  "impact",
  "violated_requirement",
  "remediation",
  "missing_or_inadequate_test",
];

const STATE_FINDING_SEVERITIES: ReadonlySet<unknown> = new Set(["P0", "P1", "P2", "P3"]);
const GIT_MODES: ReadonlySet<unknown> = new Set(["100644", "100755", "120000"]);
const IMPLEMENTATION_STATUSES: ReadonlySet<unknown> = new Set([
  "DONE",
  "DONE_WITH_CONCERNS",
  "INCOMPLETE",
  "NEEDS_CONTEXT",
  "BLOCKED",
]);
const STOPPING_IMPLEMENTATION_STATUSES: ReadonlySet<unknown> = new Set([
  "DONE_WITH_CONCERNS",
  "NEEDS_CONTEXT",
  "BLOCKED",
]);

// Hand-written runtime validation for persisted current-schema states. Every failure is
// ERROR_STATE_CORRUPT.
function checkKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...new Set([...required, ...optional])].sort();
  const needed = required.filter((key) => !optional.includes(key));
  if (actual.some((key) => !allowed.includes(key)) || needed.some((key) => !actual.includes(key))) {
    corrupt();
  }
}

function bounded(value: unknown, max: number): void {
  if (typeof value !== "string" || value.length === 0 || value.length > max) corrupt();
}

function nullableBounded(value: unknown, max: number): void {
  if (value === null || value === undefined) return;
  bounded(value, max);
}

function sha40(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) corrupt();
}

function sha64(value: unknown): void {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) corrupt();
}

function nullableString(value: unknown, max: number): void {
  if (value === null || value === undefined) return;
  bounded(value, max);
}

function stringArrayShape(value: unknown, maxItems: number, maxLength: number): void {
  if (!Array.isArray(value) || value.length > maxItems) corrupt();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > maxLength) corrupt();
  }
}

function workItemsShape(value: unknown): void {
  try {
    const parsed = workItems(value);
    if (canonicalJson(parsed) !== canonicalJson(value)) corrupt();
  } catch {
    corrupt();
  }
}

function pathList(value: unknown, allowEmpty: boolean): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_PATHS) {
    corrupt();
  }
  let previous: string | null = null;
  for (const path of value) {
    if (typeof path !== "string" || path.length === 0 || path.length > 300 || path.includes("\0")) {
      corrupt();
    }
    if (previous !== null && previous >= path) corrupt();
    previous = path;
  }
}

function contractsShape(value: unknown, prefix: "AC" | "VAL"): void {
  if (!Array.isArray(value) || value.length > MAX_CONTRACTS) corrupt();
  const idField = prefix === "AC" ? "criterion_id" : "validation_id";
  for (const item of value) {
    if (!isObject(item)) corrupt();
    checkKeys(item, prefix === "VAL" ? [idField, "description", "argv"] : [idField, "description"]);
    const id = item[idField];
    if (typeof id !== "string" || !new RegExp(`^${prefix}-\\d{3}$`, "u").test(id)) corrupt();
    bounded(item.description, MAX_TEXT);
    if (prefix === "VAL") {
      if (item.argv !== null) {
        if (!Array.isArray(item.argv) || item.argv.length === 0 || item.argv.length > 50) corrupt();
        for (const argument of item.argv) bounded(argument, MAX_TEXT);
      }
    }
  }
}

function resultsShape(
  value: unknown,
  idField: "criterion_id" | "validation_id",
  prefix: "AC" | "VAL",
  statuses: ReadonlySet<string>,
): void {
  if (!Array.isArray(value) || value.length > MAX_CONTRACTS) corrupt();
  for (const item of value) {
    if (!isObject(item)) corrupt();
    checkKeys(item, [idField, "status", "evidence"]);
    const id = item[idField];
    if (typeof id !== "string" || !new RegExp(`^${prefix}-\\d{3}$`, "u").test(id)) corrupt();
    if (!statuses.has(item.status as string)) corrupt();
    bounded(item.evidence, MAX_DETAIL);
  }
}

function resolutionMapShape(value: unknown): void {
  if (!isObject(value)) corrupt();
  for (const [id, status] of Object.entries(value)) {
    if (id.length === 0 || id.length > 80) corrupt();
    if (!RESOLUTION_STATUSES.has(status as FindingResolution)) corrupt();
  }
}

function findingShape(value: unknown, expectedBlocking: boolean | undefined): void {
  if (!isObject(value)) corrupt();
  checkKeys(value, STATE_FINDING_KEYS);
  if (
    typeof value.finding_id !== "string" ||
    value.finding_id.length === 0 ||
    value.finding_id.length > 80
  ) {
    corrupt();
  }
  if (!STATE_FINDING_SEVERITIES.has(value.severity)) corrupt();
  if (value.blocking !== (value.severity !== "P3")) corrupt();
  if (expectedBlocking !== undefined && value.blocking !== expectedBlocking) corrupt();
  bounded(value.file_and_line, 300);
  bounded(value.failure_scenario, MAX_DETAIL);
  bounded(value.impact, MAX_DETAIL);
  bounded(value.violated_requirement, MAX_DETAIL);
  bounded(value.remediation, MAX_DETAIL);
  bounded(value.missing_or_inadequate_test, MAX_DETAIL);
}

function findingsShape(value: unknown, expectedBlocking?: boolean): void {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) corrupt();
  const ids = new Set<string>();
  for (const item of value) {
    if (!isObject(item) || typeof item.finding_id !== "string" || ids.has(item.finding_id)) {
      corrupt();
    }
    ids.add(item.finding_id);
    findingShape(item, expectedBlocking);
  }
}

function findingAdjudicationsShape(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS * 10) corrupt();
  let previousResultingVersion = -1;
  const ids = new Set<string>();
  for (const item of value) {
    if (!isObject(item)) corrupt();
    checkKeys(item, [
      "finding_id",
      "finding_snapshot",
      "source_review_version",
      "disposition",
      "reason",
      "user_authorization",
      "adjudicated_at",
      "resulting_workflow_version",
    ]);
    if (
      typeof item.finding_id !== "string" ||
      item.finding_id.length === 0 ||
      item.finding_id.length > 80 ||
      ids.has(item.finding_id)
    )
      corrupt();
    ids.add(item.finding_id);
    findingShape(item.finding_snapshot, true);
    if (
      !Number.isSafeInteger(item.source_review_version) ||
      (item.source_review_version as number) < 0 ||
      (item.source_review_version as number) > (item.resulting_workflow_version as number) ||
      !Number.isSafeInteger(item.resulting_workflow_version) ||
      (item.resulting_workflow_version as number) < 1 ||
      (item.resulting_workflow_version as number) < previousResultingVersion
    )
      corrupt();
    if ((item.finding_snapshot as { finding_id?: unknown }).finding_id !== item.finding_id)
      corrupt();
    if (
      item.disposition !== "CONTRACT_INCONSISTENT" &&
      item.disposition !== "OUTSIDE_APPROVED_SCOPE"
    )
      corrupt();
    bounded(item.reason, MAX_DETAIL);
    bounded(item.user_authorization, MAX_DETAIL);
    bounded(item.adjudicated_at, 64);
    previousResultingVersion = item.resulting_workflow_version as number;
  }
}

function receiptPathShape(value: unknown): void {
  if (!isObject(value)) corrupt();
  const path = value.path;
  if (typeof path !== "string" || path.length === 0 || path.length > 300) corrupt();
  const state = value.state;
  if (state === "absent") {
    checkKeys(value, ["path", "state", "kind"]);
    if (value.kind !== "missing") corrupt();
  } else if (state === "deleted") {
    checkKeys(value, ["path", "state", "kind", "mode"]);
    if (value.kind !== "missing" || !GIT_MODES.has(value.mode)) corrupt();
  } else if (state === "added" || state === "modified" || state === "unchanged") {
    checkKeys(value, ["path", "state", "kind", "mode", "digest"]);
    if (!(value.kind === "file" || value.kind === "symlink")) corrupt();
    if (!GIT_MODES.has(value.mode)) corrupt();
    sha64(value.digest);
  } else {
    corrupt();
  }
}

function receiptShape(value: unknown): void {
  if (!isObject(value)) corrupt();
  checkKeys(value, [
    "schema_version",
    "base_head",
    "approved_paths",
    "paths",
    "overall_scope_hash",
  ]);
  if (value.schema_version !== 1) corrupt();
  sha40(value.base_head);
  pathList(value.approved_paths, false);
  if (!Array.isArray(value.paths) || value.paths.length > MAX_PATHS) corrupt();
  let previousPath: string | null = null;
  for (const entry of value.paths) {
    receiptPathShape(entry);
    const path = (entry as { path: string }).path;
    if (previousPath !== null && previousPath >= path) corrupt();
    previousPath = path;
  }
  if (
    (value.paths as Array<{ path: string }>).length !== (value.approved_paths as string[]).length ||
    (value.paths as Array<{ path: string }>).some(
      (entry, index) => entry.path !== (value.approved_paths as string[])[index],
    )
  )
    corrupt();
  sha64(value.overall_scope_hash);
}

function scopeExpansionShape(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_PATHS) corrupt();
  const ids = new Set<string>();
  let previousVersion = -1;
  for (const item of value) {
    if (!isObject(item)) corrupt();
    checkKeys(item, [
      "expansion_id",
      "added_paths",
      "reason",
      "user_authorization",
      "prior_version",
      "resulting_version",
      "authorized_at",
    ]);
    if (
      typeof item.expansion_id !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(item.expansion_id) ||
      ids.has(item.expansion_id)
    )
      corrupt();
    ids.add(item.expansion_id);
    pathList(item.added_paths, false);
    if (new Set(item.added_paths as string[]).size !== (item.added_paths as string[]).length)
      corrupt();
    bounded(item.reason, MAX_DETAIL);
    bounded(item.user_authorization, MAX_DETAIL);
    if (
      !Number.isSafeInteger(item.prior_version) ||
      !Number.isSafeInteger(item.resulting_version) ||
      (item.prior_version as number) < 0 ||
      (item.resulting_version as number) !== (item.prior_version as number) + 1 ||
      (item.prior_version as number) <= previousVersion
    )
      corrupt();
    previousVersion = item.prior_version as number;
    bounded(item.authorized_at, 64);
  }
}

function approvedPathBaselinesShape(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_PATHS) corrupt();
  const paths = new Set<string>();
  let previousVersion = -1;
  let previousPath: string | null = null;
  for (const item of value) {
    if (!isObject(item)) corrupt();
    checkKeys(item, ["path", "approved_at_version", "baseline"]);
    pathList([item.path], false);
    if (paths.has(item.path as string)) corrupt();
    paths.add(item.path as string);
    if (
      !Number.isSafeInteger(item.approved_at_version) ||
      (item.approved_at_version as number) < 1 ||
      (item.approved_at_version as number) < previousVersion ||
      ((item.approved_at_version as number) === previousVersion &&
        previousPath !== null &&
        previousPath >= (item.path as string))
    )
      corrupt();
    previousVersion = item.approved_at_version as number;
    previousPath = item.path as string;
    receiptPathShape(item.baseline);
    if ((item.baseline as { path?: unknown }).path !== item.path) corrupt();
    const baseline = item.baseline as { state?: unknown };
    if (baseline.state !== "unchanged" && baseline.state !== "absent") corrupt();
  }
}

function nullableReceipt(value: unknown): void {
  if (value === null || value === undefined) return;
  receiptShape(value);
}

function reviewTargetShape(value: unknown): void {
  if (!isObject(value)) corrupt();
  checkKeys(value, [
    "review_mode",
    "base_revision",
    "head_revision",
    "approved_paths",
    "include_staged",
    "include_unstaged",
    "include_untracked",
  ]);
  sha40(value.base_revision);
  pathList(value.approved_paths, false);
  if (value.review_mode === "working_tree") {
    if (value.head_revision !== null) corrupt();
    if (
      value.include_staged !== true ||
      value.include_unstaged !== true ||
      value.include_untracked !== true
    ) {
      corrupt();
    }
  } else if (value.review_mode === "commit_range") {
    sha40(value.head_revision);
    if (
      value.include_staged !== false ||
      value.include_unstaged !== false ||
      value.include_untracked !== false
    ) {
      corrupt();
    }
  } else {
    corrupt();
  }
}

function remediationContextShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, ["policy", "authorized_finding_ids", "repair_cycle", "user_authorization"]);
  if (value.policy !== "explicitly_authorized") corrupt();
  stringArrayShape(value.authorized_finding_ids, MAX_FINDINGS, 80);
  if (value.repair_cycle !== 0) corrupt();
  bounded(value.user_authorization, MAX_DETAIL);
}

function linkedContinuationShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, [
    "root_workflow_id",
    "predecessor_workflow_id",
    "lineage_workflow_ids",
    "original_base_head",
    "combined_review_paths",
    "review_stage",
    "remediation_review_receipt",
  ]);
  for (const key of ["root_workflow_id", "predecessor_workflow_id"] as const) {
    if (typeof value[key] !== "string" || !/^[0-9a-f-]{36}$/u.test(value[key] as string)) corrupt();
  }
  stringArrayShape(value.lineage_workflow_ids, MAX_PATHS, 100);
  if ((value.lineage_workflow_ids as string[]).length === 0) corrupt();
  sha40(value.original_base_head);
  pathList(value.combined_review_paths, false);
  if (value.review_stage !== "remediation" && value.review_stage !== "combined") corrupt();
  nullableReceipt(value.remediation_review_receipt);
  if (
    value.review_stage === "remediation" &&
    value.remediation_review_receipt !== null &&
    value.remediation_review_receipt !== undefined
  )
    corrupt();
}

function stopContextShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  if (value.status === "COMMIT_PREPARATION_FAILED") {
    checkKeys(value, [
      "status",
      "category",
      "summary",
      "recovery",
      "failed_at",
      "failed_version",
      "stopped_from",
    ]);
    if (
      value.category !== "ERROR_STAGED_SCOPE" &&
      value.category !== "ERROR_STAGED_CONTENT" &&
      value.category !== "ERROR_STALE_RECEIPT"
    ) {
      corrupt();
    }
    if (value.recovery !== "retry" && value.recovery !== "review") corrupt();
    if (value.stopped_from !== "COMMIT_AUTHORIZED") corrupt();
    if (!Number.isSafeInteger(value.failed_version) || (value.failed_version as number) < 0) {
      corrupt();
    }
    if (
      (value.category === "ERROR_STALE_RECEIPT" && value.recovery !== "review") ||
      (value.category !== "ERROR_STALE_RECEIPT" && value.recovery !== "retry")
    ) {
      corrupt();
    }
    bounded(value.summary, 2000);
    bounded(value.failed_at, 64);
    return;
  }
  checkKeys(value, ["status", "summary", "stopped_from"]);
  if (value.status === "INCONCLUSIVE") {
    if (value.stopped_from !== "REVIEWING") corrupt();
  } else {
    if (!STOPPING_IMPLEMENTATION_STATUSES.has(value.status)) corrupt();
    if (value.stopped_from !== "IMPLEMENTING" && value.stopped_from !== "REPAIRING") {
      corrupt();
    }
  }
  bounded(value.summary, MAX_TEXT);
}

function recoveryContextShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, ["kind", "context", "recovered_at"]);
  if (!(value.kind === "implementation" || value.kind === "review" || value.kind === "commit")) {
    corrupt();
  }
  bounded(value.context, MAX_DETAIL);
  bounded(value.recovered_at, 64);
}

function concernAcceptanceShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, ["user_authorization", "accepted_at"]);
  bounded(value.user_authorization, MAX_DETAIL);
  bounded(value.accepted_at, 64);
}

function commitAuthorizationShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, ["user_authorization", "authorized_at"]);
  bounded(value.user_authorization, MAX_DETAIL);
  bounded(value.authorized_at, 64);
}

function commitPreparationShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, [
    "attempt_id",
    "prepared_head",
    "prepared_tree",
    "expected_paths",
    "review_receipt_digest",
    "prepared_at",
  ]);
  bounded(value.attempt_id, 80);
  sha40(value.prepared_head);
  sha40(value.prepared_tree);
  pathList(value.expected_paths, true);
  sha64(value.review_receipt_digest);
  bounded(value.prepared_at, 64);
}

function commitResultShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  if (value.outcome === "committed") {
    checkKeys(value, ["outcome", "commit_hash", "failure_summary"]);
    sha40(value.commit_hash);
    if (value.failure_summary !== null) corrupt();
  } else if (value.outcome === "not_committed") {
    checkKeys(value, ["outcome", "failure_summary", "commit_hash"]);
    bounded(value.failure_summary, MAX_DETAIL);
    if (value.commit_hash !== null) corrupt();
  } else if (value.outcome === "mismatch") {
    checkKeys(value, ["outcome", "mismatch_category"]);
    if (!MISMATCH_CATEGORIES.has(value.mismatch_category as CommitMismatchCategory)) corrupt();
  } else {
    corrupt();
  }
}

// Runtime validation of a parsed, digest-verified schema-v7 state before it enters the domain as
// WorkflowState. See store.#parseValidated; every failure is ERROR_STATE_CORRUPT.
export function validateWorkflowStateV7(value: unknown): WorkflowState {
  if (!isObject(value)) corrupt();
  const actual = Object.keys(value).sort();
  const required = [...V7_STATE_KEYS].sort();
  if (actual.some((key) => !required.includes(key)) || required.some((key) => !(key in value))) {
    corrupt();
  }
  if (value.schema_version !== SCHEMA_VERSION) corrupt();
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 0) corrupt();
  if (typeof value.workflow_id !== "string" || !/^[0-9a-f-]{36}$/u.test(value.workflow_id))
    corrupt();
  if (value.workflow_type !== "change" && value.workflow_type !== "review_only") corrupt();
  if (value.runtime_id !== null && !/^[0-9a-f]{64}$/u.test(String(value.runtime_id))) corrupt();
  if (value.runtime_revision !== null) sha40(value.runtime_revision);
  if ((value.runtime_id === null) !== (value.runtime_revision === null)) corrupt();
  if (typeof value.phase !== "string" || !PHASES.includes(value.phase as WorkflowPhase)) corrupt();
  bounded(value.objective, MAX_TEXT);
  if (value.approved_plan !== null) bounded(value.approved_plan, MAX_APPROVED_PLAN);
  workItemsShape(value.work_items);
  sha40(value.base_head);
  pathList(value.approved_paths, false);
  scopeExpansionShape(value.scope_expansions);
  approvedPathBaselinesShape(value.approved_path_baselines);
  reviewTargetShape(value.review_target);
  if (
    value.workflow_type === "review_only" &&
    ((value.scope_expansions as unknown[]).length > 0 ||
      (value.approved_path_baselines as unknown[]).length > 0)
  )
    corrupt();
  const linked = value.linked_continuation;
  if (
    linked === null &&
    canonicalJson((value.review_target as { approved_paths: unknown }).approved_paths) !==
      canonicalJson(value.approved_paths)
  )
    corrupt();
  linkedContinuationShape(linked);
  if (
    value.superseded_by_workflow_id !== null &&
    (typeof value.superseded_by_workflow_id !== "string" ||
      !/^[0-9a-f-]{36}$/u.test(value.superseded_by_workflow_id))
  )
    corrupt();
  const initialPaths = new Set(
    value.initial_receipt && isObject(value.initial_receipt)
      ? Array.isArray(value.initial_receipt.paths)
        ? (value.initial_receipt.paths as Array<{ path: string }>).map((entry) => entry.path)
        : corrupt()
      : [],
  );
  if ((value.review_target as { review_mode: string }).review_mode === "working_tree") {
    if (value.initial_receipt === null || value.initial_receipt === undefined) corrupt();
    if (
      canonicalJson([...initialPaths].sort()) !==
      canonicalJson((value.initial_receipt as { approved_paths: unknown }).approved_paths)
    )
      corrupt();
  }
  const expanded = new Set<string>();
  const evolvingScope = new Set<string>(initialPaths);
  let evolvingVersion = -1;
  for (const expansion of value.scope_expansions as Array<{
    added_paths: string[];
    prior_version: number;
    resulting_version: number;
  }>) {
    if (
      expansion.resulting_version > (value.version as number) ||
      expansion.prior_version <= evolvingVersion
    )
      corrupt();
    for (const path of expansion.added_paths) {
      if (expanded.has(path)) corrupt();
      expanded.add(path);
      if (evolvingScope.has(path)) corrupt();
      evolvingScope.add(path);
    }
    evolvingVersion = expansion.resulting_version;
  }
  const baselinePaths = new Set(
    (value.approved_path_baselines as Array<{ path: string }>).map((entry) => entry.path),
  );
  if ([...expanded].some((path) => !baselinePaths.has(path))) corrupt();
  if ([...baselinePaths].some((path) => !expanded.has(path))) corrupt();
  const baselineEntries = value.approved_path_baselines as Array<{
    path: string;
    approved_at_version: number;
  }>;
  const expectedBaselines = (
    value.scope_expansions as Array<{ added_paths: string[]; resulting_version: number }>
  ).flatMap((expansion) =>
    expansion.added_paths.map((path) => ({
      path,
      approved_at_version: expansion.resulting_version,
    })),
  );
  if (
    baselineEntries.length !== expectedBaselines.length ||
    baselineEntries.some(
      (entry, index) =>
        entry.path !== expectedBaselines[index]?.path ||
        entry.approved_at_version !== expectedBaselines[index]?.approved_at_version,
    )
  )
    corrupt();
  const covered = new Set([...initialPaths, ...baselinePaths]);
  if (
    value.review_target &&
    (value.review_target as { review_mode?: string }).review_mode === "working_tree" &&
    (value.approved_paths as string[]).some((path) => !covered.has(path))
  )
    corrupt();
  if (
    value.review_target &&
    (value.review_target as { review_mode?: string }).review_mode === "working_tree" &&
    canonicalJson([...evolvingScope].sort()) !== canonicalJson(value.approved_paths)
  )
    corrupt();
  if (linked) {
    const continuation = linked as {
      combined_review_paths: string[];
      original_base_head: string;
      review_stage: "remediation" | "combined";
      predecessor_workflow_id: string;
      root_workflow_id: string;
      lineage_workflow_ids: string[];
    };
    if (
      (value.approved_paths as string[]).some(
        (path) => !continuation.combined_review_paths.includes(path),
      )
    )
      corrupt();
    if (continuation.original_base_head !== value.base_head) corrupt();
    if (continuation.predecessor_workflow_id !== value.source_workflow_id) corrupt();
    if (
      continuation.review_stage === "combined" &&
      canonicalJson((value.review_target as { approved_paths: unknown }).approved_paths) !==
        canonicalJson(continuation.combined_review_paths)
    )
      corrupt();
    if (
      continuation.review_stage === "remediation" &&
      canonicalJson((value.review_target as { approved_paths: unknown }).approved_paths) !==
        canonicalJson(value.approved_paths)
    )
      corrupt();
    if (continuation.lineage_workflow_ids.at(-1) !== continuation.predecessor_workflow_id)
      corrupt();
    if (continuation.lineage_workflow_ids[0] !== continuation.root_workflow_id) corrupt();
    if (
      value.review_receipt !== null &&
      value.review_receipt !== undefined &&
      value.phase !== "STOPPED_APPROVED" &&
      value.phase !== "COMMIT_AUTHORIZED" &&
      value.phase !== "COMMIT_PREPARED" &&
      value.phase !== "STOPPED_COMMIT_PREPARATION" &&
      value.phase !== "STOPPED_NOT_COMMITTED" &&
      value.phase !== "STOPPED_COMMIT_MISMATCH" &&
      value.phase !== "COMMITTED"
    )
      corrupt();
  }
  if (value.superseded_by_workflow_id !== null && value.commit_authorization !== null) corrupt();
  contractsShape(value.acceptance_criteria, "AC");
  contractsShape(value.validation_requirements, "VAL");
  reviewTargetShape(value.review_target);
  nullableReceipt(value.initial_receipt);
  nullableReceipt(value.review_start_receipt);
  pathList(value.dirty_baseline_paths, true);
  if (
    !Number.isSafeInteger(value.repair_cycle) ||
    (value.repair_cycle as number) < 0 ||
    (value.repair_cycle as number) > 2
  ) {
    corrupt();
  }
  if (
    !Number.isSafeInteger(value.max_repair_cycles) ||
    (value.max_repair_cycles as number) < 0 ||
    (value.max_repair_cycles as number) > 2
  ) {
    corrupt();
  }
  nullableString(value.parent_workflow_id, 100);
  nullableString(value.source_workflow_id, 100);
  findingsShape(value.linked_findings);
  remediationContextShape(value.remediation_context);
  nullableBounded(value.implementation_summary, MAX_TEXT);
  if (
    value.implementation_status !== null &&
    !IMPLEMENTATION_STATUSES.has(value.implementation_status)
  ) {
    corrupt();
  }
  pathList(value.agent_touched_paths, true);
  pathList(value.scope_changed_paths, true);
  resultsShape(
    value.acceptance_results,
    "criterion_id",
    "AC",
    ACCEPTANCE_STATUSES as ReadonlySet<string>,
  );
  resultsShape(
    value.validation_results,
    "validation_id",
    "VAL",
    VALIDATION_STATUSES as ReadonlySet<string>,
  );
  nullableReceipt(value.implementation_receipt);
  stringArrayShape(value.implementation_known_failures, 50, MAX_DETAIL);
  resolutionMapShape(value.finding_resolution_map);
  resolutionMapShape(value.prior_finding_classifications);
  findingsShape(value.blocking_findings, true);
  findingsShape(value.optional_findings, false);
  findingAdjudicationsShape(value.finding_adjudications);
  if (
    (value.finding_adjudications as Array<{ resulting_workflow_version: number }>).some(
      (item) => item.resulting_workflow_version > (value.version as number),
    )
  )
    corrupt();
  if (
    value.review_result_version !== null &&
    (!Number.isSafeInteger(value.review_result_version) ||
      (value.review_result_version as number) < 1 ||
      (value.review_result_version as number) > (value.version as number))
  )
    corrupt();
  nullableReceipt(value.review_receipt);
  if (
    linked &&
    (linked as { review_stage?: string }).review_stage === "remediation" &&
    value.review_receipt !== null &&
    value.review_receipt !== undefined
  )
    corrupt();
  stopContextShape(value.stop_context);
  recoveryContextShape(value.recovery_context);
  stringArrayShape(value.repair_authorized_ids, MAX_FINDINGS, 80);
  concernAcceptanceShape(value.concern_acceptance);
  commitAuthorizationShape(value.commit_authorization);
  commitPreparationShape(value.commit_preparation);
  commitResultShape(value.commit_result);
  return value as unknown as WorkflowState; // validated producer cast at the persistence boundary
}

/** @deprecated retained for source compatibility; persisted state is schema v7 only. */
export const validateWorkflowStateV6 = validateWorkflowStateV7;

/** @deprecated retained for source compatibility; persisted state is schema v7 only. */
export const validateWorkflowStateV5 = validateWorkflowStateV7;

/** @deprecated retained for source compatibility; persisted state is schema v7 only. */
export const validateWorkflowStateV4 = validateWorkflowStateV7;
export const validateWorkflowStateV3 = validateWorkflowStateV7;
