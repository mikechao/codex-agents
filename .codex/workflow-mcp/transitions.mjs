import { fail } from "./errors.mjs";
import {
  boundedString,
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
  "COMMIT_AUTHORIZED",
  "COMMITTED",
];

function ensurePhase(state, ...allowed) {
  if (!allowed.includes(state.phase)) fail("ERROR_INVALID_TRANSITION", `phase ${state.phase}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createState(input, repositoryRoot, currentHead) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "workflow input is invalid");
  }
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
    parent_workflow_id: optionalText(input.parent_workflow_id, "parent_workflow_id", 100),
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
