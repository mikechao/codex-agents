import { fail } from "./errors.mjs";
import {
  boundedString,
  contractList,
  exactKeys,
  exactPaths,
  findings,
  optionalText,
  repairCycle,
  resolutionMap,
  revision,
  safeObject,
  stringList,
  userAuthorization,
} from "./validation.mjs";

export const SCHEMA_VERSION = 2;
export const PHASES = [
  "IMPLEMENTING",
  "REVIEWING",
  "REPAIR_REQUIRED",
  "REPAIRING",
  "STOPPED_APPROVED",
  "STOPPED_INCONCLUSIVE",
  "STOPPED_CONCERNS",
  "STOPPED_NEEDS_CONTEXT",
  "STOPPED_BLOCKED",
  "STOPPED_IMPLEMENTATION_BLOCKED",
  "STOPPED_REPAIR_EXHAUSTED",
  "COMMIT_AUTHORIZED",
  "COMMITTED",
];

const V1_PHASES = [
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

const V1_STATE_KEYS = [
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

function ensurePhase(state, ...allowed) {
  if (!allowed.includes(state.phase)) fail("ERROR_INVALID_TRANSITION", `phase ${state.phase}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseState({ objective, approvedPaths, baseHead, maxRepairCycles, parentWorkflowId = null }) {
  return {
    schema_version: SCHEMA_VERSION,
    version: 0,
    workflow_id: null,
    workflow_type: "change",
    legacy_v1: false,
    phase: "IMPLEMENTING",
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
    source_workflow_id: null,
    linked_findings: [],
    remediation_context: null,
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
    implementation_changed_paths: [],
    implementation_acceptance_evidence: [],
    implementation_validation_evidence: [],
    authorized_optional_ids: [],
    user_authorization_summary: null,
  };
}

function reviewTarget(value, approvedPaths, repositoryRoot, currentHead) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", "review target is invalid");
  }
  exactKeys(
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
  if (value.review_mode !== "working_tree") {
    fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "review mode is not supported");
  }
  const baseRevision = revision(value.base_revision, "base_revision");
  if (baseRevision !== currentHead) fail("ERROR_STALE_BASE", "base HEAD is not current");
  if (value.head_revision !== null) {
    fail("ERROR_INVALID_SHAPE", "working-tree head revision is invalid");
  }
  const targetPaths = exactPaths(value.approved_paths, repositoryRoot);
  if (JSON.stringify(targetPaths) !== JSON.stringify(approvedPaths)) {
    fail("ERROR_INVALID_SHAPE", "review target paths do not match approved paths");
  }
  if (value.include_staged !== true || value.include_unstaged !== true || value.include_untracked !== true) {
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

export function createState(input, repositoryRoot, currentHead, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "workflow input is invalid");
  }
  if (options.internal === true) {
    exactKeys(
      input,
      ["objective", "approved_paths", "base_head", "max_repair_cycles", "parent_workflow_id"],
      "workflow input",
      ["base_head", "max_repair_cycles", "parent_workflow_id"],
    );
    const objective = boundedString(input.objective, "objective");
    const approvedPaths = exactPaths(input.approved_paths, repositoryRoot);
    const baseHead = revision(input.base_head ?? currentHead, "base_head");
    if (baseHead !== currentHead) fail("ERROR_STALE_BASE", "base HEAD is not current");
    const maxRepairCycles = input.max_repair_cycles ?? 2;
    repairCycle(maxRepairCycles);
    return baseState({
      objective,
      approvedPaths,
      baseHead,
      maxRepairCycles,
      parentWorkflowId: optionalText(input.parent_workflow_id, "parent_workflow_id", 100),
    });
  }
  exactKeys(
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
  if (input.workflow_type !== "change") {
    fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "workflow type is not supported");
  }
  const objective = boundedString(input.objective, "objective");
  const approvedPaths = exactPaths(input.approved_paths, repositoryRoot);
  const target = reviewTarget(input.review_target, approvedPaths, repositoryRoot, currentHead);
  const maxRepairCycles = input.max_repair_cycles ?? 2;
  repairCycle(maxRepairCycles);
  const state = baseState({
    objective,
    approvedPaths,
    baseHead: target.base_revision,
    maxRepairCycles,
  });
  state.acceptance_criteria = contractList(
    input.acceptance_criteria,
    "acceptance_criteria",
    "AC",
    "criterion_id",
  );
  state.validation_requirements = contractList(
    input.validation_requirements,
    "validation_requirements",
    "VAL",
    "validation_id",
  );
  state.review_target = target;
  return state;
}

export function submitImplementation(state, input, repositoryRoot) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "implementation input is invalid");
  }
  exactKeys(
    input,
    [
      "workflow_id",
      "capability",
      "expected_version",
      "status",
      "summary",
      "changed_paths",
      "acceptance_evidence",
      "validation_evidence",
      "implementation_receipt",
      "known_failures",
      "finding_resolution_map",
    ],
    "implementation submission",
  );
  ensurePhase(state, "IMPLEMENTING", "REPAIRING");
  if (!["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"].includes(input.status)) {
    fail("ERROR_INVALID_IMPLEMENTATION", "implementation status is invalid");
  }
  const receipt = input.implementation_receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    fail("ERROR_INVALID_IMPLEMENTATION", "implementation receipt is required");
  }
  const changedPaths = exactPaths(input.changed_paths, repositoryRoot, true);
  const acceptanceEvidence = stringList(input.acceptance_evidence, "acceptance_evidence");
  const validationEvidence = stringList(input.validation_evidence, "validation_evidence");
  const knownFailures = stringList(input.known_failures, "known_failures");
  const priorIds = state.blocking_findings.map((finding) => finding.finding_id);
  const resolution = resolutionMap(
    input.finding_resolution_map,
    priorIds,
    "finding_resolution_map",
  );
  if (state.phase === "IMPLEMENTING" && Object.keys(resolution).length > 0) {
    fail("ERROR_INVALID_FINDING", "initial implementation has prior resolutions");
  }
  if (
    input.status === "DONE" &&
    (acceptanceEvidence.length === 0 || validationEvidence.length === 0)
  ) {
    fail("ERROR_INVALID_IMPLEMENTATION", "done implementation requires evidence");
  }
  const next = clone(state);
  next.implementation_summary = boundedString(input.summary, "summary", 4000);
  next.implementation_status = input.status;
  next.implementation_changed_paths = changedPaths;
  next.implementation_acceptance_evidence = acceptanceEvidence;
  next.implementation_validation_evidence = validationEvidence;
  next.implementation_receipt = JSON.parse(JSON.stringify(receipt));
  next.implementation_known_failures = knownFailures;
  next.finding_resolution_map = resolution;
  if (input.status === "DONE") next.phase = "REVIEWING";
  if (input.status === "DONE_WITH_CONCERNS") next.phase = "STOPPED_CONCERNS";
  if (input.status === "NEEDS_CONTEXT") next.phase = "STOPPED_NEEDS_CONTEXT";
  if (input.status === "BLOCKED") next.phase = "STOPPED_BLOCKED";
  if (input.status !== "DONE") next.repair_authorized_ids = [];
  return next;
}

export function submitReview(state, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REVIEW", "review input is invalid");
  }
  ensurePhase(state, "REVIEWING");
  exactKeys(
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
  if (!["APPROVED", "CHANGES_REQUESTED", "INCONCLUSIVE"].includes(input.review_status)) {
    fail("ERROR_INVALID_REVIEW", "review status is invalid");
  }
  const blockingFindings = findings(input.blocking_findings ?? [], "blocking_findings", true);
  const optionalFindings = findings(input.optional_findings ?? [], "optional_findings", false);
  const unionIds = [...blockingFindings, ...optionalFindings].map((item) => item.finding_id);
  if (new Set(unionIds).size !== unionIds.length) {
    fail("ERROR_INVALID_FINDING", "finding ID is duplicated across buckets");
  }
  const priorIds = [
    ...state.blocking_findings.map((item) => item.finding_id),
    ...state.optional_findings.map((item) => item.finding_id),
  ];
  const classifications = resolutionMap(
    input.prior_finding_classifications,
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
    blockingFindings.some((item) => item.severity === "P3") ||
    optionalFindings.some((item) => item.severity !== "P3")
  ) {
    fail("ERROR_INVALID_REVIEW", "finding severity does not match list");
  }
  if (input.review_status === "APPROVED" && blockingFindings.length > 0) {
    fail("ERROR_INVALID_REVIEW", "approved review contains blockers");
  }
  if (input.review_status === "CHANGES_REQUESTED" && blockingFindings.length === 0) {
    fail("ERROR_INVALID_REVIEW", "changes requested without blockers");
  }
  if (input.review_status === "INCONCLUSIVE" && input.review_receipt !== null) {
    fail("ERROR_INVALID_REVIEW", "inconclusive review cannot include receipt");
  }
  const next = clone(state);
  next.blocking_findings = blockingFindings;
  next.optional_findings = optionalFindings;
  next.prior_finding_classifications = classifications;
  next.review_receipt = input.review_receipt
    ? JSON.parse(JSON.stringify(input.review_receipt))
    : null;
  if (input.review_status === "APPROVED") next.phase = "STOPPED_APPROVED";
  if (input.review_status === "INCONCLUSIVE") next.phase = "STOPPED_INCONCLUSIVE";
  if (input.review_status === "CHANGES_REQUESTED") next.phase = "REPAIR_REQUIRED";
  return next;
}

export function authorizeRepair(state, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REPAIR", "repair input is invalid");
  }
  exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "finding_ids"],
    "repair authorization",
  );
  ensurePhase(state, "REPAIR_REQUIRED");
  const ids = input.finding_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > state.blocking_findings.length) {
    fail("ERROR_INVALID_REPAIR", "finding IDs are invalid");
  }
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => typeof id !== "string" || id.length > 80)
  ) {
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

export function finalizeBlocked(state, input) {
  exactKeys(input, ["workflow_id", "capability", "expected_version"], "blocked finalization");
  ensurePhase(state, "REPAIR_REQUIRED");
  if (state.repair_cycle < state.max_repair_cycles)
    fail("ERROR_REPAIR_LIMIT", "repair cycles remain");
  const next = clone(state);
  next.phase = "STOPPED_BLOCKED";
  return next;
}

export function authorizeCommit(state, authorization) {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
    fail("ERROR_INVALID_SHAPE", "commit authorization is invalid");
  }
  exactKeys(
    authorization,
    ["workflow_id", "capability", "expected_version", "user_authorization"],
    "commit authorization",
  );
  ensurePhase(state, "STOPPED_APPROVED");
  const next = clone(state);
  next.commit_authorization = {
    user_authorization: userAuthorization(authorization.user_authorization),
    authorized_at: new Date().toISOString(),
  };
  next.phase = "COMMIT_AUTHORIZED";
  return next;
}

export function recordCommit(state, result, input) {
  exactKeys(
    input,
    ["workflow_id", "capability", "expected_version", "commit_hash"],
    "commit record",
  );
  ensurePhase(state, "COMMIT_AUTHORIZED");
  const next = clone(state);
  next.commit_result = safeObject(result, "commit_result", 20);
  next.phase = "COMMITTED";
  return next;
}

export function optionalFollowupInput(state, input, repositoryRoot, currentHead) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_FOLLOWUP", "follow-up input is invalid");
  }
  exactKeys(
    input,
    [
      "workflow_id",
      "capability",
      "expected_version",
      "objective",
      "approved_paths",
      "optional_finding_ids",
      "user_authorization",
      "base_head",
    ],
    "optional follow-up",
    ["base_head"],
  );
  ensurePhase(state, "STOPPED_APPROVED");
  const ids = input.optional_finding_ids;
  if (!Array.isArray(ids) || ids.length === 0 || new Set(ids).size !== ids.length) {
    fail("ERROR_INVALID_FOLLOWUP", "optional finding IDs are invalid");
  }
  const optionalIds = new Set(state.optional_findings.map((item) => item.finding_id));
  if (ids.some((id) => !optionalIds.has(id)))
    fail("ERROR_INVALID_FOLLOWUP", "finding ID is not optional");
  const nextInput = {
    objective: boundedString(input.objective, "objective"),
    approved_paths: exactPaths(input.approved_paths, repositoryRoot),
    base_head: revision(input.base_head ?? currentHead, "base_head"),
    max_repair_cycles: state.max_repair_cycles,
    parent_workflow_id: state.workflow_id,
  };
  if (nextInput.base_head !== currentHead) fail("ERROR_STALE_BASE", "base HEAD is not current");
  userAuthorization(input.user_authorization);
  return {
    ...nextInput,
    optional_finding_ids: [...ids].sort(),
    user_authorization: input.user_authorization,
  };
}

export function changedReceiptPaths(receipt) {
  if (!receipt || !Array.isArray(receipt.paths)) return [];
  return receipt.paths
    .filter((item) => item.state !== "unchanged")
    .map((item) => item.path)
    .sort();
}

export function dirtyBaselinePaths(receipt) {
  if (!receipt || !Array.isArray(receipt.paths)) return [];
  return receipt.paths
    .filter((item) => ["added", "modified", "deleted"].includes(item.state))
    .map((item) => item.path)
    .sort();
}

function corrupt() {
  fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function migrateV1State(state) {
  if (!isObject(state)) corrupt();
  const actual = Object.keys(state).sort();
  const expected = [...V1_STATE_KEYS].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    corrupt();
  }
  if (state.schema_version !== 1) corrupt();
  if (!Number.isSafeInteger(state.version) || state.version < 0) corrupt();
  if (typeof state.workflow_id !== "string" || !/^[0-9a-f-]{36}$/u.test(state.workflow_id))
    corrupt();
  if (typeof state.phase !== "string" || !V1_PHASES.includes(state.phase)) corrupt();
  if (typeof state.objective !== "string" || state.objective.length === 0 || state.objective.length > 4000)
    corrupt();
  if (typeof state.base_head !== "string" || !/^[0-9a-f]{40}$/u.test(state.base_head)) corrupt();
  if (
    !isStringArray(state.approved_paths) ||
    state.approved_paths.length === 0 ||
    state.approved_paths.length > 200
  )
    corrupt();
  if (!Number.isSafeInteger(state.repair_cycle) || state.repair_cycle < 0 || state.repair_cycle > 2)
    corrupt();
  if (
    !Number.isSafeInteger(state.max_repair_cycles) ||
    state.max_repair_cycles < 0 ||
    state.max_repair_cycles > 2
  )
    corrupt();
  if (state.parent_workflow_id !== null && typeof state.parent_workflow_id !== "string") corrupt();
  if (state.implementation_summary !== null && typeof state.implementation_summary !== "string")
    corrupt();
  if (
    state.implementation_status !== null &&
    !["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"].includes(state.implementation_status)
  )
    corrupt();
  if (!isStringArray(state.implementation_changed_paths)) corrupt();
  if (!isStringArray(state.implementation_acceptance_evidence)) corrupt();
  if (!isStringArray(state.implementation_validation_evidence)) corrupt();
  if (state.implementation_receipt !== null && !isObject(state.implementation_receipt)) corrupt();
  if (!isStringArray(state.implementation_known_failures)) corrupt();
  if (!isObject(state.finding_resolution_map) || !isObject(state.prior_finding_classifications))
    corrupt();
  if (!Array.isArray(state.blocking_findings) || !Array.isArray(state.optional_findings)) corrupt();
  if (state.review_receipt !== null && !isObject(state.review_receipt)) corrupt();
  if (state.commit_authorization !== null && !isObject(state.commit_authorization)) corrupt();
  if (state.commit_result !== null && !isObject(state.commit_result)) corrupt();
  if (!isStringArray(state.repair_authorized_ids)) corrupt();
  if (!isStringArray(state.authorized_optional_ids)) corrupt();
  if (state.user_authorization_summary !== null && typeof state.user_authorization_summary !== "string")
    corrupt();

  const changedPaths = [...state.implementation_changed_paths].sort();
  const approvedPaths = [...state.approved_paths].sort();
  const phase =
    state.phase === "STOPPED_BLOCKED"
      ? state.implementation_status === "BLOCKED"
        ? "STOPPED_IMPLEMENTATION_BLOCKED"
        : "STOPPED_REPAIR_EXHAUSTED"
      : state.phase;
  return {
    schema_version: SCHEMA_VERSION,
    version: state.version,
    workflow_id: state.workflow_id,
    workflow_type: "change",
    legacy_v1: true,
    phase,
    objective: state.objective,
    base_head: state.base_head,
    approved_paths: approvedPaths,
    acceptance_criteria: [],
    validation_requirements: [],
    review_target: {
      review_mode: "working_tree",
      base_revision: state.base_head,
      head_revision: null,
      approved_paths: approvedPaths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
    initial_receipt: null,
    dirty_baseline_paths: [],
    repair_cycle: state.repair_cycle,
    max_repair_cycles: state.max_repair_cycles,
    parent_workflow_id: state.parent_workflow_id,
    source_workflow_id: null,
    linked_findings: [],
    remediation_context: null,
    implementation_summary: state.implementation_summary,
    implementation_status: state.implementation_status,
    agent_touched_paths: changedPaths,
    scope_changed_paths: changedPaths,
    acceptance_results: [],
    validation_results: [],
    implementation_receipt: state.implementation_receipt,
    implementation_known_failures: [...state.implementation_known_failures],
    finding_resolution_map: { ...state.finding_resolution_map },
    prior_finding_classifications: { ...state.prior_finding_classifications },
    blocking_findings: state.blocking_findings,
    optional_findings: state.optional_findings,
    review_receipt: state.review_receipt,
    stop_context: null,
    recovery_context: null,
    repair_authorized_ids: [...state.repair_authorized_ids].sort(),
    concern_acceptance: null,
    commit_authorization: state.commit_authorization,
    commit_preparation: null,
    commit_result: state.commit_result,
    implementation_changed_paths: changedPaths,
    implementation_acceptance_evidence: [...state.implementation_acceptance_evidence],
    implementation_validation_evidence: [...state.implementation_validation_evidence],
    authorized_optional_ids: [...state.authorized_optional_ids].sort(),
    user_authorization_summary: state.user_authorization_summary,
    legacy_evidence: {
      acceptance_evidence: [...state.implementation_acceptance_evidence],
      validation_evidence: [...state.implementation_validation_evidence],
    },
  };
}
