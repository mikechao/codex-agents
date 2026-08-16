import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import {
  ACCEPTANCE_STATUSES,
  VALIDATION_STATUSES,
  boundedString,
  canonicalJson,
  contractList,
  evidenceResults,
  exactKeys,
  exactPaths,
  findings,
  findingIdList,
  isoNow,
  objectDigest,
  optionalText,
  repairCycle,
  resolutionMap,
  revision,
  role,
  stringList,
  userAuthorization,
} from "./validation.js";
import type {
  AcceptanceCriterion,
  AcceptanceResult,
  BlockingFinding,
  ChangeReceipt,
  CommitAttemptId,
  CommitAuthorization,
  CommitMismatchCategory,
  CommitPreparation,
  CommitPreparationEvidence,
  CommitResult,
  CommitVerification,
  ExactRepoPath,
  FindingId,
  FindingResolutionMap,
  FindingSeverity,
  GitCommitSha,
  ImplementationStatus,
  IsoTimestamp,
  OptionalFinding,
  ParentView,
  ImplementerView,
  ReviewerView,
  CommitterView,
  RemediationContext,
  ReviewFinding,
  ReviewRange,
  ReviewTarget,
  Role,
  RoleView,
  StopContext,
  ValidationRequirement,
  ValidationResult,
  WorkflowAction,
  WorkflowId,
  WorkflowPhase,
  WorkflowState,
  WorkflowType,
  WorkflowVersion,
} from "./types.js";

export const SCHEMA_VERSION = 2;

export const IMPLEMENTATION_STOP_PHASES: Record<
  "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED",
  WorkflowPhase
> = {
  DONE_WITH_CONCERNS: "STOPPED_CONCERNS",
  NEEDS_CONTEXT: "STOPPED_NEEDS_CONTEXT",
  BLOCKED: "STOPPED_IMPLEMENTATION_BLOCKED",
};

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

const V1_PHASES: readonly string[] = [
  "IMPLEMENTING",
  "REVIEWING",
  "REPAIR_REQUIRED",
  "REPAIRING",
  "STOPPED_APPROVED",
  "STOPPED_INCONCLUSIVE",
  "STOPPED_CONCERNS",
  "STOPPED_NEEDS_CONTEXT",
  "STOPPED_BLOCKED",
  "COMMIT_AUTHORIZED",
  "COMMITTED",
];

const V1_STATE_KEYS: readonly string[] = [
  "schema_version",
  "version",
  "workflow_id",
  "phase",
  "objective",
  "base_head",
  "approved_paths",
  "repair_cycle",
  "max_repair_cycles",
  "parent_workflow_id",
  "implementation_summary",
  "implementation_status",
  "implementation_changed_paths",
  "implementation_acceptance_evidence",
  "implementation_validation_evidence",
  "implementation_receipt",
  "implementation_known_failures",
  "finding_resolution_map",
  "prior_finding_classifications",
  "blocking_findings",
  "optional_findings",
  "review_receipt",
  "commit_authorization",
  "commit_result",
  "repair_authorized_ids",
  "authorized_optional_ids",
  "user_authorization_summary",
];

function ensurePhase(state: WorkflowState, ...allowed: WorkflowPhase[]): void {
  if (!allowed.includes(state.phase)) fail("ERROR_INVALID_TRANSITION", `phase ${state.phase}`);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
];

const TEMPORARY_COMPATIBILITY_KEYS: readonly string[] = [
  "implementation_changed_paths",
  "implementation_acceptance_evidence",
  "implementation_validation_evidence",
  "authorized_optional_ids",
  "user_authorization_summary",
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
    "concern_acceptance",
    "review_receipt",
    "stop_context",
    "recovery_context",
  ],
  committer: [
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
    REVIEWING: ["workflow_submit_review"],
  },
  parent: {
    REPAIR_REQUIRED: ["workflow_authorize_repair", "workflow_finalize_repair_exhausted"],
    STOPPED_APPROVED: ["workflow_authorize_commit", "workflow_create_linked_followup"],
    STOPPED_REPAIR_EXHAUSTED: ["workflow_create_linked_followup"],
    STOPPED_CONCERNS: ["workflow_accept_concerns"],
    STOPPED_NEEDS_CONTEXT: ["workflow_resume_implementation"],
    STOPPED_IMPLEMENTATION_BLOCKED: ["workflow_resume_implementation"],
    STOPPED_INCONCLUSIVE: ["workflow_resume_review"],
    STOPPED_NOT_COMMITTED: ["workflow_retry_commit"],
  },
  committer: {
    COMMIT_AUTHORIZED: ["workflow_prepare_commit", "workflow_record_commit"],
    COMMIT_PREPARED: ["workflow_submit_commit_result"],
  },
};

export function permittedNextActions(state: WorkflowState, actorRole: Role): WorkflowAction[] {
  role(actorRole);
  let actions = [...(ACTION_MATRIX[actorRole]?.[state.phase] ?? [])];
  if (
    actorRole === "parent" &&
    state.phase === "STOPPED_APPROVED" &&
    state.review_target?.review_mode !== "working_tree"
  ) {
    actions = actions.filter((action) => action !== "workflow_authorize_commit");
  }
  if (
    actorRole === "committer" &&
    state.phase === "COMMIT_AUTHORIZED" &&
    state.legacy_v1 !== true
  ) {
    actions = actions.filter((action) => action !== "workflow_record_commit");
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
    if (key in raw) view[key] = clone(raw[key]);
  }
  view.permitted_next_actions = permittedNextActions(state, actorRole);
  if (actorRole === "parent") {
    for (const key of Object.keys(state)) {
      if (ROLE_VIEW_COMMON.includes(key)) continue;
      if (key === "legacy_evidence") continue;
      if (TEMPORARY_COMPATIBILITY_KEYS.includes(key)) continue;
      view[key] = clone(raw[key]);
    }
  } else {
    const extra =
      actorRole === "reviewer" && state.workflow_type === "review_only"
        ? ROLE_VIEW_EXTRA[actorRole].filter(
            (key) => !REVIEWER_IMPLEMENTER_HANDOFF.includes(key),
          )
        : ROLE_VIEW_EXTRA[actorRole];
    for (const key of extra) {
      if (key in raw) view[key] = clone(raw[key]);
    }
  }
  return view as RoleView;
}

interface BaseStateOptions {
  objective: string;
  approvedPaths: ExactRepoPath[];
  baseHead: GitCommitSha;
  maxRepairCycles: number;
  parentWorkflowId?: WorkflowId | null;
  workflowType?: WorkflowType;
  sourceWorkflowId?: WorkflowId | null;
  linkedFindings?: ReviewFinding[];
  remediationContext?: RemediationContext | null;
}

function baseState({
  objective,
  approvedPaths,
  baseHead,
  maxRepairCycles,
  parentWorkflowId = null,
  workflowType = "change",
  sourceWorkflowId = null,
  linkedFindings = [],
  remediationContext = null,
}: BaseStateOptions): WorkflowState {
  return {
    schema_version: SCHEMA_VERSION,
    version: 0 as WorkflowVersion, // producer cast; WorkflowVersion is branded
    workflow_id: null,
    workflow_type: workflowType,
    legacy_v1: false,
    phase: workflowType === "review_only" ? "REVIEWING" : "IMPLEMENTING",
    objective,
    base_head: baseHead,
    approved_paths: approvedPaths,
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
    dirty_baseline_paths: [],
    repair_cycle: 0,
    max_repair_cycles: maxRepairCycles,
    parent_workflow_id: parentWorkflowId,
    source_workflow_id: sourceWorkflowId,
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
      approvedPaths,
      baseHead,
      maxRepairCycles,
      parentWorkflowId: optionalText(
        args.parent_workflow_id,
        "parent_workflow_id",
        100,
      ) as WorkflowId | null, // brand cast; documented
    });
  }
  const args = exactKeys(
    input,
    [
      "workflow_type",
      "objective",
      "approved_paths",
      "acceptance_criteria",
      "validation_requirements",
      "review_target",
      "max_repair_cycles",
    ],
    "workflow create",
    ["max_repair_cycles"],
  );
  if (args.workflow_type !== "change" && args.workflow_type !== "review_only") {
    fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "workflow type is not supported");
  }
  const objective = boundedString(args.objective, "objective");
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
    approvedPaths,
    baseHead: target.base_revision,
    maxRepairCycles,
    workflowType: args.workflow_type,
  });
  state.acceptance_criteria = contractList(
    args.acceptance_criteria,
    "acceptance_criteria",
    "AC",
    "criterion_id",
  );
  state.validation_requirements =
    args.workflow_type === "review_only"
      ? contractList(args.validation_requirements, "validation_requirements", "VAL", "validation_id", true)
      : contractList(args.validation_requirements, "validation_requirements", "VAL", "validation_id");
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
  if (state.legacy_v1 === true) {
    fail("ERROR_LEGACY_WORKFLOW", "migrated workflows cannot submit implementation");
  }
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "capability",
      "expected_version",
      "status",
      "summary",
      "agent_touched_paths",
      "acceptance_results",
      "validation_results",
      "implementation_receipt",
      "known_failures",
      "finding_resolution_map",
    ],
    "implementation submission",
  );
  ensurePhase(state, "IMPLEMENTING", "REPAIRING");
  if (
    args.status !== "DONE" &&
    args.status !== "DONE_WITH_CONCERNS" &&
    args.status !== "NEEDS_CONTEXT" &&
    args.status !== "BLOCKED"
  ) {
    fail("ERROR_INVALID_IMPLEMENTATION", "implementation status is invalid");
  }
  const receipt = args.implementation_receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    fail("ERROR_INVALID_IMPLEMENTATION", "implementation receipt is required");
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
  const priorIds = state.blocking_findings.map((finding) => finding.finding_id);
  const resolution = resolutionMap(args.finding_resolution_map, priorIds, "finding_resolution_map");
  if (state.phase === "IMPLEMENTING" && Object.keys(resolution).length > 0) {
    fail("ERROR_INVALID_FINDING", "initial implementation has prior resolutions");
  }
  const next = clone(state);
  next.implementation_summary = boundedString(args.summary, "summary", 4000);
  next.implementation_status = args.status;
  next.agent_touched_paths = touchedPaths;
  next.acceptance_results = acceptanceResults;
  next.validation_results = validationResults;
  // Documented producer cast: the store verified canonical equality with the fresh receipt first.
  next.implementation_receipt = JSON.parse(JSON.stringify(freshReceipt ?? receipt)) as ChangeReceipt;
  next.implementation_known_failures = knownFailures;
  next.finding_resolution_map = resolution;
  next.scope_changed_paths = scopeChangedPaths(state.initial_receipt, next.implementation_receipt);
  if (args.status === "DONE") {
    if (acceptanceResults.some((item) => item.status !== "satisfied")) {
      fail("ERROR_INVALID_IMPLEMENTATION", "done implementation requires satisfied criteria");
    }
    if (validationResults.some((item) => item.status !== "passed")) {
      fail("ERROR_INVALID_IMPLEMENTATION", "done implementation requires passed validations");
    }
    if (knownFailures.length > 0) {
      fail("ERROR_INVALID_IMPLEMENTATION", "done implementation has known failures");
    }
    next.phase = "REVIEWING";
  }
  if (args.status !== "DONE") {
    next.stop_context = {
      status: args.status,
      summary: boundedString(args.summary, "summary", 4000),
      // Safe producer-side narrowing: ensurePhase guarantees the phase at runtime.
      stopped_from: state.phase as "IMPLEMENTING" | "REPAIRING",
    };
    next.repair_authorized_ids = [];
  }
  if (args.status !== "DONE") next.phase = IMPLEMENTATION_STOP_PHASES[args.status];
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

export function submitReview(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REVIEW", "review input is invalid");
  }
  ensurePhase(state, "REVIEWING");
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "capability",
      "expected_version",
      "review_status",
      "blocking_findings",
      "optional_findings",
      "review_receipt",
      "review_target",
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
  const priorIds = [
    ...state.blocking_findings.map((item) => item.finding_id),
    ...state.optional_findings.map((item) => item.finding_id),
  ];
  const classifications = resolutionMap(
    args.prior_finding_classifications,
    priorIds,
    "prior_finding_classifications",
  );
  for (const [id, status] of Object.entries(classifications)) {
    if (status === "still_present") {
      const prior = state.blocking_findings.find((item) => item.finding_id === id);
      const current = blockingFindings.find((item) => item.finding_id === id);
      if (!current || !prior || current.severity !== prior.severity || current.blocking !== true) {
        fail("ERROR_INVALID_FINDING", "still-present blocker changed bucket or severity");
      }
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
  if (args.review_status === "INCONCLUSIVE" && args.review_receipt !== null) {
    fail("ERROR_INVALID_REVIEW", "inconclusive review cannot include receipt");
  }
  const next = clone(state);
  next.blocking_findings = blockingFindings;
  next.optional_findings = optionalFindings;
  next.prior_finding_classifications = classifications;
  // Documented cast: the store validates receipts canonically before calling.
  next.review_receipt = args.review_receipt
    ? (JSON.parse(JSON.stringify(args.review_receipt)) as ChangeReceipt)
    : null;
  if (args.review_status === "APPROVED") next.phase = "STOPPED_APPROVED";
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
  if (ids.length > state.blocking_findings.length) {
    fail("ERROR_INVALID_REPAIR", "finding IDs are invalid");
  }
  const existing = new Set(state.blocking_findings.map((item) => item.finding_id));
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
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version"],
    "repair exhaustion",
  );
  ensurePhase(state, "REPAIR_REQUIRED");
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

export function recordCommit(
  state: WorkflowState,
  evidence: CommitVerification,
  input: unknown,
): WorkflowState {
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "commit_hash"],
    "commit record",
  );
  ensurePhase(state, "COMMIT_AUTHORIZED");
  if (state.legacy_v1 !== true) {
    fail("ERROR_LEGACY_WORKFLOW", "commit recording is only for migrated workflows");
  }
  const next = clone(state);
  if (!evidence.ok) {
    if (!MISMATCH_CATEGORIES.has(evidence.mismatch)) {
      fail("ERROR_STATE_CORRUPT", "mismatch category is invalid");
    }
    next.commit_result = { outcome: "mismatch", mismatch_category: evidence.mismatch };
    next.phase = "STOPPED_COMMIT_MISMATCH";
    return next;
  }
  next.commit_result = {
    outcome: "committed",
    commit_hash: evidence.commit_hash,
    failure_summary: null,
  };
  next.phase = "COMMITTED";
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

export function prepareCommit(
  state: WorkflowState,
  input: unknown,
  evidence: CommitPreparationEvidence,
): WorkflowState {
  const args = exactKeys(
    input,
    ["workflow_id", "capability", "expected_version"],
    "commit preparation",
  );
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

export function submitCommitResult(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit result input is invalid");
  }
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "capability",
      "expected_version",
      "attempt_id",
      "outcome",
      "commit_hash",
      "failure_summary",
    ],
    "commit result",
  );
  ensurePhase(state, "COMMIT_PREPARED");
  if (state.commit_preparation?.attempt_id !== args.attempt_id) {
    fail("ERROR_COMMIT_MISMATCH", "attempt ID does not match the prepared attempt");
  }
  if (args.outcome !== "committed" && args.outcome !== "not_committed") {
    fail("ERROR_INVALID_SHAPE", "commit outcome is invalid");
  }
  const next = clone(state);
  if (args.outcome === "committed") {
    if (typeof args.commit_hash !== "string" || !/^[0-9a-f]{40}$/u.test(args.commit_hash)) {
      fail("ERROR_INVALID_SHAPE", "committed result requires a commit hash");
    }
    if (args.failure_summary !== null) {
      fail("ERROR_INVALID_SHAPE", "committed result cannot include a failure summary");
    }
    next.commit_result = {
      outcome: "committed",
      commit_hash: args.commit_hash as GitCommitSha, // producer cast after the regex check
      failure_summary: null,
    };
    next.phase = "COMMITTED";
  } else {
    if (args.commit_hash !== null) {
      fail("ERROR_INVALID_SHAPE", "not-committed result cannot include a commit hash");
    }
    if (args.failure_summary === null || typeof args.failure_summary !== "string") {
      fail("ERROR_INVALID_SHAPE", "not-committed result requires a failure summary");
    }
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
      "approved_paths",
      "acceptance_criteria",
      "validation_requirements",
      "finding_ids",
      "user_authorization",
    ],
    "linked follow-up",
  );
  ensurePhase(state, "STOPPED_APPROVED", "STOPPED_REPAIR_EXHAUSTED");
  const ids = findingIdList(args.finding_ids, "finding_ids", "ERROR_INVALID_FOLLOWUP");
  const blocking = new Set(state.blocking_findings.map((finding) => finding.finding_id));
  const optional = new Set(state.optional_findings.map((finding) => finding.finding_id));
  const fromBlocking = ids.every((id) => blocking.has(id));
  const fromOptional = ids.every((id) => optional.has(id));
  if (fromBlocking === fromOptional) {
    fail("ERROR_INVALID_FOLLOWUP", "finding IDs must come from one bucket");
  }
  const linkedFindings = [...state.blocking_findings, ...state.optional_findings].filter(
    (finding) => ids.includes(finding.finding_id),
  );
  return {
    objective: boundedString(args.objective, "objective"),
    approved_paths: exactPaths(args.approved_paths, repositoryRoot),
    acceptance_criteria: args.acceptance_criteria as string[], // raw passthrough to the child
    validation_requirements: args.validation_requirements as string[],
    base_head: revision(currentHead, "base_head"),
    max_repair_cycles: state.max_repair_cycles,
    parent_workflow_id: state.workflow_id,
    source_workflow_id: state.workflow_id,
    authorized_finding_ids: ids.slice().sort(),
    linked_findings: linkedFindings,
    user_authorization: userAuthorization(args.user_authorization),
  };
}

export function linkedFollowupChildState(followup: LinkedFollowupPlan): WorkflowState {
  const state = baseState({
    objective: followup.objective,
    approvedPaths: followup.approved_paths,
    baseHead: followup.base_head,
    maxRepairCycles: followup.max_repair_cycles,
    parentWorkflowId: followup.parent_workflow_id,
    sourceWorkflowId: followup.source_workflow_id,
    linkedFindings: followup.linked_findings,
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
  const initialByPath = new Map(initialReceipt.paths.map((entry) => [entry.path, entry]));
  const finalByPath = new Map(finalReceipt.paths.map((entry) => [entry.path, entry]));
  const changed: ExactRepoPath[] = [];
  for (const entry of initialReceipt.paths) {
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

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// Raw v1 row shape for migrateV1State. Only read after the exact-key and per-field shape checks
// below; all boundary casts on the returned v2 state are documented producer casts on legacy data.
interface V1WorkflowState {
  schema_version: number;
  version: number;
  workflow_id: string;
  phase: string;
  objective: string;
  base_head: string;
  approved_paths: string[];
  repair_cycle: number;
  max_repair_cycles: number;
  parent_workflow_id: string | null;
  implementation_summary: string | null;
  implementation_status: string;
  implementation_changed_paths: string[];
  implementation_acceptance_evidence: string[];
  implementation_validation_evidence: string[];
  implementation_receipt: Record<string, unknown> | null;
  implementation_known_failures: string[];
  finding_resolution_map: Record<string, unknown>;
  prior_finding_classifications: Record<string, unknown>;
  blocking_findings: unknown;
  optional_findings: unknown;
  review_receipt: Record<string, unknown> | null;
  commit_authorization: Record<string, unknown> | null;
  commit_result: Record<string, unknown> | null;
  repair_authorized_ids: string[];
  authorized_optional_ids: string[];
  user_authorization_summary: string | null;
}

export function migrateV1State(state: unknown): WorkflowState {
  if (!isObject(state)) corrupt();
  const actual = Object.keys(state).sort();
  const expected = [...V1_STATE_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    corrupt();
  }
  const v1 = state as unknown as V1WorkflowState;
  if (v1.schema_version !== 1) corrupt();
  if (!Number.isSafeInteger(v1.version) || v1.version < 0) corrupt();
  if (typeof v1.workflow_id !== "string" || !/^[0-9a-f-]{36}$/u.test(v1.workflow_id)) corrupt();
  if (typeof v1.phase !== "string" || !V1_PHASES.includes(v1.phase)) corrupt();
  if (
    typeof v1.objective !== "string" ||
    v1.objective.length === 0 ||
    v1.objective.length > 4000
  )
    corrupt();
  if (typeof v1.base_head !== "string" || !/^[0-9a-f]{40}$/u.test(v1.base_head)) corrupt();
  if (
    !isStringArray(v1.approved_paths) ||
    v1.approved_paths.length === 0 ||
    v1.approved_paths.length > 200
  )
    corrupt();
  if (!Number.isSafeInteger(v1.repair_cycle) || v1.repair_cycle < 0 || v1.repair_cycle > 2)
    corrupt();
  if (
    !Number.isSafeInteger(v1.max_repair_cycles) ||
    v1.max_repair_cycles < 0 ||
    v1.max_repair_cycles > 2
  )
    corrupt();
  if (v1.parent_workflow_id !== null && typeof v1.parent_workflow_id !== "string") corrupt();
  if (v1.implementation_summary !== null && typeof v1.implementation_summary !== "string")
    corrupt();
  if (
    v1.implementation_status !== null &&
    !["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"].includes(v1.implementation_status)
  )
    corrupt();
  if (!isStringArray(v1.implementation_changed_paths)) corrupt();
  if (!isStringArray(v1.implementation_acceptance_evidence)) corrupt();
  if (!isStringArray(v1.implementation_validation_evidence)) corrupt();
  if (v1.implementation_receipt !== null && !isObject(v1.implementation_receipt)) corrupt();
  if (!isStringArray(v1.implementation_known_failures)) corrupt();
  if (!isObject(v1.finding_resolution_map) || !isObject(v1.prior_finding_classifications))
    corrupt();
  if (!Array.isArray(v1.blocking_findings) || !Array.isArray(v1.optional_findings)) corrupt();
  if (v1.review_receipt !== null && !isObject(v1.review_receipt)) corrupt();
  if (v1.commit_authorization !== null && !isObject(v1.commit_authorization)) corrupt();
  if (v1.commit_result !== null && !isObject(v1.commit_result)) corrupt();
  if (!isStringArray(v1.repair_authorized_ids)) corrupt();
  if (!isStringArray(v1.authorized_optional_ids)) corrupt();
  if (v1.user_authorization_summary !== null && typeof v1.user_authorization_summary !== "string")
    corrupt();

  const changedPaths = [...v1.implementation_changed_paths].sort() as ExactRepoPath[];
  const approvedPaths = [...v1.approved_paths].sort() as ExactRepoPath[];
  const phase: WorkflowPhase =
    v1.phase === "STOPPED_BLOCKED"
      ? v1.implementation_status === "BLOCKED"
        ? "STOPPED_IMPLEMENTATION_BLOCKED"
        : "STOPPED_REPAIR_EXHAUSTED"
      : (v1.phase as WorkflowPhase);
  return {
    schema_version: SCHEMA_VERSION,
    version: v1.version as WorkflowVersion,
    workflow_id: v1.workflow_id as WorkflowId,
    workflow_type: "change",
    legacy_v1: true,
    phase,
    objective: v1.objective,
    base_head: v1.base_head as GitCommitSha,
    approved_paths: approvedPaths,
    acceptance_criteria: [],
    validation_requirements: [],
    review_target: {
      review_mode: "working_tree",
      base_revision: v1.base_head as GitCommitSha,
      head_revision: null,
      approved_paths: approvedPaths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
    initial_receipt: null,
    dirty_baseline_paths: [],
    repair_cycle: v1.repair_cycle,
    max_repair_cycles: v1.max_repair_cycles,
    parent_workflow_id: v1.parent_workflow_id as WorkflowId | null,
    source_workflow_id: null,
    linked_findings: [],
    remediation_context: null,
    implementation_summary: v1.implementation_summary,
    implementation_status: v1.implementation_status as ImplementationStatus | null,
    agent_touched_paths: changedPaths,
    scope_changed_paths: changedPaths,
    acceptance_results: [],
    validation_results: [],
    implementation_receipt: v1.implementation_receipt as ChangeReceipt | null,
    implementation_known_failures: [...v1.implementation_known_failures],
    finding_resolution_map: { ...v1.finding_resolution_map } as FindingResolutionMap,
    prior_finding_classifications: { ...v1.prior_finding_classifications } as FindingResolutionMap,
    blocking_findings: v1.blocking_findings as BlockingFinding[],
    optional_findings: v1.optional_findings as OptionalFinding[],
    review_receipt: v1.review_receipt as ChangeReceipt | null,
    stop_context: null,
    recovery_context: null,
    repair_authorized_ids: [...v1.repair_authorized_ids].sort() as FindingId[],
    concern_acceptance: null,
    commit_authorization: v1.commit_authorization as CommitAuthorization | null,
    commit_preparation: null,
    commit_result: v1.commit_result as CommitResult | null,
    implementation_changed_paths: changedPaths,
    implementation_acceptance_evidence: [...v1.implementation_acceptance_evidence],
    implementation_validation_evidence: [...v1.implementation_validation_evidence],
    authorized_optional_ids: [...v1.authorized_optional_ids].sort() as FindingId[],
    user_authorization_summary: v1.user_authorization_summary,
    legacy_evidence: {
      acceptance_evidence: [...v1.implementation_acceptance_evidence],
      validation_evidence: [...v1.implementation_validation_evidence],
    },
  };
}
