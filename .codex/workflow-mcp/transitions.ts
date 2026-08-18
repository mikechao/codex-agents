import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import type {
  BlockingFinding,
  ChangeReceipt,
  CommitAttemptId,
  CommitAuthorization,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitResult,
  CommitterView,
  CommitVerification,
  ExactRepoPath,
  FindingId,
  FindingResolution,
  FindingResolutionMap,
  FindingSeverity,
  GitCommitSha,
  ImplementationStatus,
  ImplementerView,
  OptionalFinding,
  ParentView,
  RemediationContext,
  ReviewerView,
  ReviewFinding,
  ReviewRange,
  ReviewTarget,
  Role,
  RoleView,
  WorkflowAction,
  WorkflowId,
  WorkflowPhase,
  WorkflowState,
  WorkflowType,
  WorkflowVersion,
} from "./types.js";
import {
  ACCEPTANCE_STATUSES,
  boundedString,
  canonicalJson,
  contractList,
  evidenceResults,
  exactKeys,
  exactPaths,
  findingIdList,
  findings,
  isoNow,
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
} from "./validation.js";

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

const V2_STATE_KEYS: readonly string[] = [
  "schema_version",
  "version",
  "workflow_id",
  "workflow_type",
  "legacy_v1",
  "runtime_id",
  "runtime_revision",
  "phase",
  "objective",
  "base_head",
  "approved_paths",
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
  "review_receipt",
  "stop_context",
  "recovery_context",
  "repair_authorized_ids",
  "concern_acceptance",
  "commit_authorization",
  "commit_preparation",
  "commit_result",
];

const V2_LEGACY_STATE_KEYS: readonly string[] = [
  "legacy_evidence",
  "implementation_changed_paths",
  "implementation_acceptance_evidence",
  "implementation_validation_evidence",
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
    REVIEWING: ["workflow_begin_review", "workflow_submit_review"],
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

const INTERNAL_RECEIPT_FIELDS = new Set([
  "initial_receipt",
  "review_start_receipt",
  "implementation_receipt",
  "review_receipt",
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
    runtime_id: null,
    runtime_revision: null,
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
    review_start_receipt: null,
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
  next.implementation_receipt = JSON.parse(JSON.stringify(freshReceipt)) as ChangeReceipt;
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

export function beginReview(
  state: WorkflowState,
  input: unknown,
  startReceipt: ChangeReceipt,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REVIEW", "review begin input is invalid");
  }
  exactKeys(input, ["workflow_id", "capability", "expected_version"], "review begin");
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
      "capability",
      "expected_version",
      "review_status",
      "blocking_findings",
      "optional_findings",
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
      if (prior) {
        const current = blockingFindings.find((item) => item.finding_id === id);
        if (!current || current.severity !== prior.severity || current.blocking !== true) {
          fail("ERROR_INVALID_FINDING", "still-present blocker changed bucket or severity");
        }
        continue;
      }
      if (!optionalFindings.some((item) => item.finding_id === id)) {
        fail("ERROR_INVALID_FINDING", "still-present optional finding changed bucket or severity");
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
  const next = clone(state);
  next.blocking_findings = blockingFindings;
  next.optional_findings = optionalFindings;
  next.prior_finding_classifications = classifications;
  next.review_receipt = finalReceipt ? clone(finalReceipt) : null;
  next.review_start_receipt = null;
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
  exactKeys(input, ["workflow_id", "capability", "expected_version"], "repair exhaustion");
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
  exactKeys(
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
  exactKeys(input, ["workflow_id", "capability", "expected_version"], "commit preparation");
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
  if (typeof v1.objective !== "string" || v1.objective.length === 0 || v1.objective.length > 4000)
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
    runtime_id: null,
    runtime_revision: null,
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
    review_start_receipt: null,
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
  "NEEDS_CONTEXT",
  "BLOCKED",
]);

// Hand-written runtime validation for persisted schema-v2 states. Mirrors the migrateV1State
// shape-check style: every failure is ERROR_STATE_CORRUPT. Legacy tolerance matches the fields
// migrateV1State passes through from v1 rows (commit_authorization without authorized_at, commit
// results without the v2 null counterparts, unvalidated parent_workflow_id strings).
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

function pathList(value: unknown, allowEmpty: boolean): void {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_PATHS) {
    corrupt();
  }
  for (const path of value) {
    if (typeof path !== "string" || path.length === 0 || path.length > 300 || path.includes("\0")) {
      corrupt();
    }
  }
}

function contractsShape(value: unknown, prefix: "AC" | "VAL"): void {
  if (!Array.isArray(value) || value.length > MAX_CONTRACTS) corrupt();
  const idField = prefix === "AC" ? "criterion_id" : "validation_id";
  for (const item of value) {
    if (!isObject(item)) corrupt();
    checkKeys(item, [idField, "description"]);
    const id = item[idField];
    if (typeof id !== "string" || !new RegExp(`^${prefix}-\\d{3}$`, "u").test(id)) corrupt();
    bounded(item.description, MAX_TEXT);
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
  for (const entry of value.paths) receiptPathShape(entry);
  sha64(value.overall_scope_hash);
}

function nullableReceipt(value: unknown, legacyTolerant: boolean): void {
  if (value === null || value === undefined) return;
  if (legacyTolerant) {
    // v1 guaranteed only "object or null" for receipts; migrated rows pass them through.
    if (!isObject(value)) corrupt();
    return;
  }
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

function stopContextShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, ["status", "summary", "stopped_from"]);
  if (value.status === "INCONCLUSIVE") {
    if (value.stopped_from !== "REVIEWING") corrupt();
  } else {
    if (!IMPLEMENTATION_STATUSES.has(value.status)) corrupt();
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

// Legacy tolerance: migrated v1 commit authorizations carried only user_authorization.
function commitAuthorizationShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, ["user_authorization"], ["authorized_at"]);
  bounded(value.user_authorization, MAX_DETAIL);
  nullableBounded(value.authorized_at, 64);
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

// Legacy tolerance: migrated v1 commit results may omit the v2 null counterpart fields.
function commitResultShape(value: unknown): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  if (value.outcome === "committed") {
    checkKeys(value, ["outcome", "commit_hash"], ["failure_summary"]);
    sha40(value.commit_hash);
    if (value.failure_summary !== undefined && value.failure_summary !== null) corrupt();
  } else if (value.outcome === "not_committed") {
    checkKeys(value, ["outcome", "failure_summary"], ["commit_hash"]);
    bounded(value.failure_summary, MAX_DETAIL);
    if (value.commit_hash !== undefined && value.commit_hash !== null) corrupt();
  } else if (value.outcome === "mismatch") {
    checkKeys(value, ["outcome", "mismatch_category"]);
    if (!MISMATCH_CATEGORIES.has(value.mismatch_category as CommitMismatchCategory)) corrupt();
  } else {
    corrupt();
  }
}

function legacyEvidenceShape(value: unknown): void {
  if (!isObject(value)) corrupt();
  checkKeys(value, ["acceptance_evidence", "validation_evidence"]);
  if (!isStringArray(value.acceptance_evidence) || !isStringArray(value.validation_evidence)) {
    corrupt();
  }
}

// Runtime validation of a parsed, digest-verified schema-v2 state before it enters the domain as
// WorkflowState. See store.#parseValidated; every failure is ERROR_STATE_CORRUPT.
export function validateWorkflowStateV2(value: unknown): WorkflowState {
  if (!isObject(value)) corrupt();
  const actual = Object.keys(value).sort();
  const required = [...V2_STATE_KEYS].sort();
  const legacy = new Set(V2_LEGACY_STATE_KEYS);
  if (
    actual.some((key) => !required.includes(key) && !legacy.has(key)) ||
    required.some((key) => !(key in value))
  ) {
    corrupt();
  }
  if (value.schema_version !== SCHEMA_VERSION) corrupt();
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 0) corrupt();
  if (typeof value.workflow_id !== "string" || !/^[0-9a-f-]{36}$/u.test(value.workflow_id))
    corrupt();
  if (value.workflow_type !== "change" && value.workflow_type !== "review_only") corrupt();
  if (typeof value.legacy_v1 !== "boolean") corrupt();
  if (value.runtime_id !== null && !/^[0-9a-f]{64}$/u.test(String(value.runtime_id))) corrupt();
  if (value.runtime_revision !== null) sha40(value.runtime_revision);
  if ((value.runtime_id === null) !== (value.runtime_revision === null)) corrupt();
  const legacyTolerant = value.legacy_v1 === true;
  if (typeof value.phase !== "string" || !PHASES.includes(value.phase as WorkflowPhase)) corrupt();
  bounded(value.objective, MAX_TEXT);
  sha40(value.base_head);
  pathList(value.approved_paths, false);
  contractsShape(value.acceptance_criteria, "AC");
  contractsShape(value.validation_requirements, "VAL");
  reviewTargetShape(value.review_target);
  nullableReceipt(value.initial_receipt, legacyTolerant);
  nullableReceipt(value.review_start_receipt, legacyTolerant);
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
  nullableReceipt(value.implementation_receipt, legacyTolerant);
  stringArrayShape(value.implementation_known_failures, 50, MAX_DETAIL);
  resolutionMapShape(value.finding_resolution_map);
  resolutionMapShape(value.prior_finding_classifications);
  findingsShape(value.blocking_findings, true);
  findingsShape(value.optional_findings, false);
  nullableReceipt(value.review_receipt, legacyTolerant);
  stopContextShape(value.stop_context);
  recoveryContextShape(value.recovery_context);
  stringArrayShape(value.repair_authorized_ids, MAX_FINDINGS, 80);
  concernAcceptanceShape(value.concern_acceptance);
  commitAuthorizationShape(value.commit_authorization);
  commitPreparationShape(value.commit_preparation);
  commitResultShape(value.commit_result);
  if (value.legacy_evidence !== undefined) legacyEvidenceShape(value.legacy_evidence);
  if (value.implementation_changed_paths !== undefined) {
    pathList(value.implementation_changed_paths, true);
  }
  if (value.implementation_acceptance_evidence !== undefined) {
    stringArrayShape(value.implementation_acceptance_evidence, 1000, 8000);
  }
  if (value.implementation_validation_evidence !== undefined) {
    stringArrayShape(value.implementation_validation_evidence, 1000, 8000);
  }
  if (value.authorized_optional_ids !== undefined) {
    stringArrayShape(value.authorized_optional_ids, MAX_FINDINGS, 80);
  }
  if (value.user_authorization_summary !== undefined && value.user_authorization_summary !== null) {
    bounded(value.user_authorization_summary, MAX_TEXT);
  }
  return value as unknown as WorkflowState; // validated producer cast at the persistence boundary
}
