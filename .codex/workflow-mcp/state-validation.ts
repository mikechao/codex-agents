import { fail } from "./errors.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./migration.js";
import type {
  CommitMismatchCategory,
  FindingResolution,
  WorkflowPhase,
  WorkflowState,
} from "./types.js";
import {
  canonicalJson,
  MAX_APPROVED_PLAN,
  MAX_CONTRACTS,
  MAX_DETAIL,
  MAX_FINDINGS,
  MAX_PATHS,
  MAX_TEXT,
  workItems,
} from "./validation.js";
import {
  ACCEPTANCE_STATUS_SET,
  COMMIT_MISMATCH_CATEGORY_SET,
  COMMIT_OUTCOME_VALUES,
  FINDING_ADJUDICATION_VALUES,
  FINDING_SEVERITIES,
  GIT_FILE_MODE_SET,
  IMPLEMENTATION_STATUS_VALUES,
  isValue,
  RECEIPT_PATH_STATE_VALUES,
  RESOLUTION_STATUS_SET,
  REVIEW_MODE_VALUES,
  VALIDATION_STATUS_SET,
  WORKFLOW_PHASE_VALUES,
  WORKFLOW_TYPE_VALUES,
} from "./values.js";

export const V10_STATE_KEYS = [
  "schema_version",
  "version",
  "workflow_id",
  "workflow_type",
  "runtime_id",
  "runtime_revision",
  "phase",
  "objective",
  "approved_plan",
  "execution_brief",
  "plan_provenance",
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
  "repair_directive",
  "concern_acceptance",
  "commit_authorization",
  "commit_preparation",
  "commit_result",
] as const satisfies readonly (keyof WorkflowState)[];
type MissingV10StateKey = Exclude<keyof WorkflowState, (typeof V10_STATE_KEYS)[number]>;
const V10_STATE_KEYS_ARE_EXHAUSTIVE: MissingV10StateKey extends never ? true : never = true;
void V10_STATE_KEYS_ARE_EXHAUSTIVE;

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

const STATE_FINDING_SEVERITIES: ReadonlySet<unknown> = FINDING_SEVERITIES;
const GIT_MODES: ReadonlySet<unknown> = GIT_FILE_MODE_SET;
const IMPLEMENTATION_STATUSES: ReadonlySet<unknown> = new Set(IMPLEMENTATION_STATUS_VALUES);
const STOPPING_IMPLEMENTATION_STATUSES: ReadonlySet<unknown> = new Set(
  IMPLEMENTATION_STATUS_VALUES.filter((status) => status !== "DONE" && status !== "INCOMPLETE"),
);

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
  for (const [index, item] of value.entries()) {
    if (!isObject(item)) corrupt();
    if (prefix === "VAL") {
      if (item.kind === "command") checkKeys(item, [idField, "description", "kind", "argv"]);
      else if (item.kind === "inspection") checkKeys(item, [idField, "description", "kind"]);
      else corrupt();
    } else checkKeys(item, [idField, "description"]);
    const id = item[idField];
    const expectedId = `${prefix}-${String(index + 1).padStart(3, "0")}`;
    if (id !== expectedId) corrupt();
    bounded(item.description, MAX_TEXT);
    if (prefix === "VAL") {
      if (item.kind === "command") {
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

function orderedValidationResultsShape(value: unknown, requirements: unknown): void {
  resultsShape(value, "validation_id", "VAL", VALIDATION_STATUS_SET as ReadonlySet<string>);
  if (!Array.isArray(requirements) || !Array.isArray(value) || value.length > requirements.length) {
    corrupt();
  }
  let previousRequirementIndex = -1;
  for (const result of value) {
    if (!isObject(result)) corrupt();
    const requirementIndex = requirements.findIndex(
      (requirement) => isObject(requirement) && requirement.validation_id === result.validation_id,
    );
    if (requirementIndex <= previousRequirementIndex) corrupt();
    previousRequirementIndex = requirementIndex;
  }
}

function resolutionMapShape(value: unknown): void {
  if (!isObject(value)) corrupt();
  for (const [id, status] of Object.entries(value)) {
    if (id.length === 0 || id.length > 80) corrupt();
    if (!RESOLUTION_STATUS_SET.has(status as FindingResolution)) corrupt();
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
    if (!isValue(FINDING_ADJUDICATION_VALUES, item.disposition)) corrupt();
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
  if (!isValue(RECEIPT_PATH_STATE_VALUES, state)) corrupt();
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
  if (value.review_mode === REVIEW_MODE_VALUES[0]) {
    if (value.head_revision !== null) corrupt();
    if (
      value.include_staged !== true ||
      value.include_unstaged !== true ||
      value.include_untracked !== true
    ) {
      corrupt();
    }
  } else if (value.review_mode === REVIEW_MODE_VALUES[1]) {
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

function repairDirectiveShape(value: unknown, approvedPaths: ReadonlyArray<string>): void {
  if (value === null || value === undefined) return;
  if (!isObject(value)) corrupt();
  checkKeys(value, [
    "required_outcome",
    "strategy_constraints",
    "fallbacks",
    "required_paths",
    "forbidden_paths",
    "user_authorization",
  ]);
  bounded(value.required_outcome, MAX_DETAIL);
  bounded(value.strategy_constraints, MAX_DETAIL);
  bounded(value.user_authorization, MAX_DETAIL);
  pathList(value.required_paths, true);
  pathList(value.forbidden_paths, true);
  const required = value.required_paths as string[];
  const forbidden = value.forbidden_paths as string[];
  const all = [...required, ...forbidden];
  if (new Set(all).size !== all.length || all.some((path) => !approvedPaths.includes(path)))
    corrupt();
  const sorted = [...all].sort();
  if (sorted.some((path, index) => index > 0 && path.startsWith(`${sorted[index - 1]}/`)))
    corrupt();
  if (!Array.isArray(value.fallbacks) || value.fallbacks.length > 10) corrupt();
  for (const fallback of value.fallbacks) {
    if (!isObject(fallback)) corrupt();
    checkKeys(fallback, ["strategy", "condition"]);
    bounded(fallback.strategy, MAX_DETAIL);
    bounded(fallback.condition, MAX_DETAIL);
  }
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
  if (!isValue(COMMIT_OUTCOME_VALUES, value.outcome)) corrupt();
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
    if (!COMMIT_MISMATCH_CATEGORY_SET.has(value.mismatch_category as CommitMismatchCategory))
      corrupt();
  } else {
    corrupt();
  }
}

// Runtime validation of a parsed, digest-verified schema-v10 state before it enters the domain as
// WorkflowState. See store.#parseValidated; every failure is ERROR_STATE_CORRUPT.
export function validateWorkflowStateV10(value: unknown): WorkflowState {
  if (!isObject(value)) corrupt();
  const actual = Object.keys(value).sort();
  const required = [...V10_STATE_KEYS].sort() as string[];
  if (actual.some((key) => !required.includes(key)) || required.some((key) => !(key in value))) {
    corrupt();
  }
  if (value.schema_version !== CURRENT_STATE_SCHEMA_VERSION) corrupt();
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 0) corrupt();
  if (typeof value.workflow_id !== "string" || !/^[0-9a-f-]{36}$/u.test(value.workflow_id))
    corrupt();
  if (!isValue(WORKFLOW_TYPE_VALUES, value.workflow_type)) corrupt();
  if (value.runtime_id !== null && !/^[0-9a-f]{64}$/u.test(String(value.runtime_id))) corrupt();
  if (value.runtime_revision !== null) sha40(value.runtime_revision);
  if ((value.runtime_id === null) !== (value.runtime_revision === null)) corrupt();
  if (
    typeof value.phase !== "string" ||
    !WORKFLOW_PHASE_VALUES.includes(value.phase as WorkflowPhase)
  )
    corrupt();
  bounded(value.objective, MAX_TEXT);
  if (value.approved_plan !== null) bounded(value.approved_plan, MAX_APPROVED_PLAN);
  if (value.execution_brief !== null) bounded(value.execution_brief, 32 * 1024);
  if (value.plan_provenance !== null) {
    if (!isObject(value.plan_provenance)) corrupt();
    const provenance = value.plan_provenance as Record<string, unknown>;
    checkKeys(provenance, ["plan_id", "revision", "artifact_digest", "approved_at"]);
    if (
      typeof provenance.plan_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        provenance.plan_id,
      )
    )
      corrupt();
    if (!Number.isSafeInteger(provenance.revision) || (provenance.revision as number) < 1)
      corrupt();
    if (
      typeof provenance.artifact_digest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(provenance.artifact_digest)
    )
      corrupt();
    if (
      typeof provenance.approved_at !== "string" ||
      Number.isNaN(Date.parse(provenance.approved_at))
    )
      corrupt();
    if (value.approved_plan === null || value.execution_brief === null) corrupt();
  } else if (value.execution_brief !== null) {
    corrupt();
  }
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
    ACCEPTANCE_STATUS_SET as ReadonlySet<string>,
  );
  orderedValidationResultsShape(value.validation_results, value.validation_requirements);
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
  repairDirectiveShape(value.repair_directive, value.approved_paths as string[]);
  if (
    ((value.repair_authorized_ids as unknown[]).length === 0) !==
    (value.repair_directive === null || value.repair_directive === undefined)
  )
    corrupt();
  concernAcceptanceShape(value.concern_acceptance);
  commitAuthorizationShape(value.commit_authorization);
  commitPreparationShape(value.commit_preparation);
  commitResultShape(value.commit_result);
  return value as unknown as WorkflowState; // validated producer cast at the persistence boundary
}
