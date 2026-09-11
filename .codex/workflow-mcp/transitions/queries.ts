import type {
  ApprovedPathBaseline,
  ApprovedPathBaselineView,
  BlockingFinding,
  CommitterView,
  ImplementerHandoffView,
  ImplementerView,
  LinkedContinuation,
  ParentView,
  ReviewerView,
  ReviewerViewBase,
  Role,
  RoleView,
  RoleViewCommon,
  ValidationRequirement,
  ValidationResult,
  WorkflowAction,
  WorkflowPhase,
  WorkflowState,
} from "../types.js";
import { MAX_DETAIL, MAX_TEXT, role } from "../validation.js";
import { VALIDATION_STATUS_SET } from "../values.js";
import { clone } from "./shared.js";

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

export const ROLE_VIEW_COMMON = [
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
  "permitted_next_actions",
] as const satisfies readonly (keyof RoleViewCommon)[];

export const REVIEWER_IMPLEMENTER_HANDOFF = [
  "implementation_summary",
  "implementation_status",
  "implementation_receipt",
  "implementation_known_failures",
  "agent_touched_paths",
  "scope_changed_paths",
  "acceptance_results",
  "finding_resolution_map",
] as const satisfies readonly (keyof WorkflowState)[];

export const ROLE_VIEW_EXTRA = {
  implementer: [
    "approved_plan",
    "execution_brief",
    "plan_provenance",
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
    "repair_directive",
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
    "repair_authorized_ids",
    "repair_directive",
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
} as const satisfies Record<
  "implementer" | "reviewer" | "committer",
  readonly (keyof WorkflowState)[]
>;

type InternalReceiptField =
  | "initial_receipt"
  | "review_start_receipt"
  | "implementation_receipt"
  | "review_receipt";
type VisibleRegistryKeys<Keys extends readonly PropertyKey[]> = Exclude<
  Keys[number],
  InternalReceiptField
>;
type ExactKeySet<Actual extends PropertyKey, Expected extends PropertyKey> = [
  Exclude<Actual, Expected>,
  Exclude<Expected, Actual>,
] extends [never, never]
  ? true
  : false;
type NoDuplicateKeys<
  Keys extends readonly PropertyKey[],
  Seen extends PropertyKey = never,
> = Keys extends readonly [infer Head extends PropertyKey, ...infer Tail extends PropertyKey[]]
  ? Head extends Seen
    ? false
    : NoDuplicateKeys<Tail, Seen | Head>
  : true;
type AssertTrue<Value extends true> = Value;

type ImplementerExtraKeys = Exclude<keyof ImplementerView, keyof RoleViewCommon>;
type ReviewerExtraKeys =
  | Exclude<keyof ReviewerViewBase, keyof RoleViewCommon>
  | keyof ImplementerHandoffView;
type CommitterExtraKeys = Exclude<keyof CommitterView, keyof RoleViewCommon>;

type _ImplementerRegistryIsExact = AssertTrue<
  ExactKeySet<VisibleRegistryKeys<typeof ROLE_VIEW_EXTRA.implementer>, ImplementerExtraKeys>
>;
type _ReviewerRegistryIsExact = AssertTrue<
  ExactKeySet<VisibleRegistryKeys<typeof ROLE_VIEW_EXTRA.reviewer>, ReviewerExtraKeys>
>;
type _CommitterRegistryIsExact = AssertTrue<
  ExactKeySet<VisibleRegistryKeys<typeof ROLE_VIEW_EXTRA.committer>, CommitterExtraKeys>
>;
type _HandoffRegistryIsExact = AssertTrue<
  ExactKeySet<
    VisibleRegistryKeys<typeof REVIEWER_IMPLEMENTER_HANDOFF>,
    keyof ImplementerHandoffView
  >
>;
type _ImplementerRegistryHasNoDuplicates = AssertTrue<
  NoDuplicateKeys<typeof ROLE_VIEW_EXTRA.implementer>
>;
type _ReviewerRegistryHasNoDuplicates = AssertTrue<
  NoDuplicateKeys<typeof ROLE_VIEW_EXTRA.reviewer>
>;
type _CommitterRegistryHasNoDuplicates = AssertTrue<
  NoDuplicateKeys<typeof ROLE_VIEW_EXTRA.committer>
>;
type _HandoffRegistryHasNoDuplicates = AssertTrue<
  NoDuplicateKeys<typeof REVIEWER_IMPLEMENTER_HANDOFF>
>;
const ROLE_VIEW_REGISTRIES_ARE_EXACT: [
  _ImplementerRegistryIsExact,
  _ReviewerRegistryIsExact,
  _CommitterRegistryIsExact,
  _HandoffRegistryIsExact,
  _ImplementerRegistryHasNoDuplicates,
  _ReviewerRegistryHasNoDuplicates,
  _CommitterRegistryHasNoDuplicates,
  _HandoffRegistryHasNoDuplicates,
] = [true, true, true, true, true, true, true, true];
void ROLE_VIEW_REGISTRIES_ARE_EXACT;

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
    REVIEWING: ["workflow_record_manual_validation"],
    IMPLEMENTING: ["workflow_expand_scope"],
    REPAIR_REQUIRED: [
      "workflow_authorize_repair",
      "workflow_adjudicate_findings",
      "workflow_expand_scope",
      "workflow_finalize_repair_exhausted",
    ],
    REPAIRING: ["workflow_expand_scope"],
    STOPPED_APPROVED: [
      "workflow_authorize_commit",
      "workflow_create_linked_followup",
      "workflow_create_linked_followup_from_plan",
    ],
    STOPPED_REPAIR_EXHAUSTED: [
      "workflow_create_linked_followup",
      "workflow_create_linked_followup_from_plan",
    ],
    STOPPED_CONCERNS: ["workflow_accept_concerns"],
    STOPPED_NEEDS_CONTEXT: ["workflow_expand_scope", "workflow_resume_implementation"],
    STOPPED_IMPLEMENTATION_BLOCKED: ["workflow_expand_scope", "workflow_resume_implementation"],
    STOPPED_INCONCLUSIVE: [
      "workflow_adopt_dirty_scope",
      "workflow_record_manual_validation",
      "workflow_resume_review",
    ],
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

const INTERNAL_RECEIPT_FIELDS = new Set<keyof WorkflowState>([
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
    if (reviewBlockedByPendingInspection(state)) actions = [];
    else if (state.review_target.review_mode === "commit_range") {
      actions = ["workflow_submit_review"];
    } else if (state.review_start_receipt) {
      actions = ["workflow_submit_review"];
    } else {
      actions = ["workflow_begin_review"];
    }
  }
  if (
    actorRole === "parent" &&
    state.phase === "REVIEWING" &&
    pendingInspectionValidations(state).length === 0
  )
    actions = [];
  if (
    actorRole === "parent" &&
    state.phase === "STOPPED_CONCERNS" &&
    pendingInspectionValidations(state).length > 0
  ) {
    actions.push("workflow_record_manual_validation");
  }
  if (actorRole === "parent" && state.phase === "STOPPED_INCONCLUSIVE") {
    if (pendingInspectionValidations(state).length > 0) {
      actions = actions.filter((action) => action !== "workflow_resume_review");
    } else {
      actions = actions.filter((action) => action !== "workflow_record_manual_validation");
    }
  }
  if (
    actorRole === "parent" &&
    state.phase === "STOPPED_APPROVED" &&
    !allRequiredValidationsPassed(state)
  ) {
    actions = actions.filter((action) => action !== "workflow_authorize_commit");
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
        action !== "workflow_authorize_commit" &&
        action !== "workflow_create_linked_followup" &&
        action !== "workflow_create_linked_followup_from_plan",
    );
  }
  return actions.sort();
}

/** Required inspections without authoritative terminal evidence. */
export function pendingInspectionValidations(state: WorkflowState): ValidationRequirement[] {
  const results = new Map<string, ValidationResult>();
  const duplicates = new Set<string>();
  for (const result of state.validation_results) {
    if (results.has(result.validation_id)) duplicates.add(result.validation_id);
    else results.set(result.validation_id, result);
  }
  return state.validation_requirements.filter(
    (requirement) =>
      requirement.kind === "inspection" &&
      (duplicates.has(requirement.validation_id) ||
        !results.has(requirement.validation_id) ||
        results.get(requirement.validation_id)?.status === "not_run"),
  );
}

/**
 * Return true only for a complete, ordered, one-to-one validation result set containing a
 * terminal failed required result. This deliberately does not trust a partial or malformed
 * result set to relax review gating.
 */
export function hasFailedRequiredValidation(state: WorkflowState): boolean {
  if (
    !Array.isArray(state.validation_requirements) ||
    !Array.isArray(state.validation_results) ||
    state.validation_results.length !== state.validation_requirements.length
  ) {
    return false;
  }
  const requirementIds = new Set<string>();
  let failed = false;
  for (let index = 0; index < state.validation_requirements.length; index += 1) {
    const requirement = state.validation_requirements[index] as unknown;
    const result = state.validation_results[index] as unknown;
    if (
      !requirement ||
      typeof requirement !== "object" ||
      Array.isArray(requirement) ||
      !result ||
      typeof result !== "object" ||
      Array.isArray(result)
    ) {
      return false;
    }
    const requirementRecord = requirement as Record<string, unknown>;
    const resultRecord = result as Record<string, unknown>;
    const requirementKeys = Object.keys(requirementRecord).sort();
    const expectedRequirementKeys =
      requirementRecord.kind === "command"
        ? ["argv", "description", "kind", "validation_id"]
        : ["description", "kind", "validation_id"];
    if (
      (requirementRecord.kind !== "command" && requirementRecord.kind !== "inspection") ||
      requirementKeys.length !== expectedRequirementKeys.length ||
      requirementKeys.some((key, keyIndex) => key !== expectedRequirementKeys[keyIndex])
    ) {
      return false;
    }
    const resultKeys = Object.keys(resultRecord).sort();
    if (
      resultKeys.length !== 3 ||
      resultKeys.some((key, keyIndex) => key !== ["evidence", "status", "validation_id"][keyIndex])
    ) {
      return false;
    }
    const validationId = requirementRecord.validation_id;
    if (
      typeof validationId !== "string" ||
      validationId.length === 0 ||
      requirementIds.has(validationId) ||
      resultRecord.validation_id !== validationId ||
      typeof requirementRecord.description !== "string" ||
      requirementRecord.description.length === 0 ||
      requirementRecord.description.length > MAX_TEXT ||
      (requirementRecord.kind === "command" &&
        (!Array.isArray(requirementRecord.argv) ||
          requirementRecord.argv.length === 0 ||
          requirementRecord.argv.length > 50 ||
          requirementRecord.argv.some(
            (argument) =>
              typeof argument !== "string" || argument.length === 0 || argument.length > MAX_TEXT,
          ))) ||
      !VALIDATION_STATUS_SET.has(resultRecord.status as ValidationResult["status"]) ||
      typeof resultRecord.evidence !== "string" ||
      resultRecord.evidence.length === 0 ||
      resultRecord.evidence.length > MAX_DETAIL
    ) {
      return false;
    }
    requirementIds.add(validationId);
    if (resultRecord.status === "failed") failed = true;
  }
  return failed;
}

export function reviewBlockedByPendingInspection(state: WorkflowState): boolean {
  return (
    pendingInspectionValidations(state).length > 0 &&
    !(state.workflow_type === "change" && hasFailedRequiredValidation(state))
  );
}

/** Every required validation has exactly one current result and it passed. */
export function allRequiredValidationsPassed(state: WorkflowState): boolean {
  if (state.validation_results.length !== state.validation_requirements.length) return false;
  const requirementIds = new Set<string>();
  const resultIds = new Set<string>();
  return state.validation_requirements.every((requirement, index) => {
    const expectedId = `VAL-${String(index + 1).padStart(3, "0")}`;
    const result = state.validation_results[index];
    if (
      requirement.validation_id !== expectedId ||
      requirementIds.has(requirement.validation_id) ||
      !result ||
      resultIds.has(result.validation_id)
    ) {
      return false;
    }
    requirementIds.add(requirement.validation_id);
    resultIds.add(result.validation_id);
    return result.validation_id === requirement.validation_id && result.status === "passed";
  });
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
      if ((ROLE_VIEW_COMMON as readonly string[]).includes(key)) continue;
      if (key === "approved_path_baselines") {
        view[key] = (raw[key] as ApprovedPathBaseline[]).map(approvedPathBaselineView);
        continue;
      }
      if (INTERNAL_RECEIPT_FIELDS.has(key as keyof WorkflowState)) continue;
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
        ? ROLE_VIEW_EXTRA[actorRole].filter(
            (key) => !(REVIEWER_IMPLEMENTER_HANDOFF as readonly string[]).includes(key),
          )
        : ROLE_VIEW_EXTRA[actorRole];
    for (const key of extra) {
      if (
        key === "linked_findings" &&
        actorRole === "reviewer" &&
        state.linked_continuation === null
      )
        continue;
      if (INTERNAL_RECEIPT_FIELDS.has(key as keyof WorkflowState)) continue;
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

export function effectiveBlockingFindings(state: WorkflowState): BlockingFinding[] {
  const adjudicated = new Set(
    state.finding_adjudications
      .filter((item) => item.source_review_version === state.review_result_version)
      .map((item) => item.finding_id),
  );
  return state.blocking_findings.filter((finding) => !adjudicated.has(finding.finding_id));
}
