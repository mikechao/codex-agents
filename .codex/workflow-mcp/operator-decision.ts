import { lineageReferences, MAX_LINEAGE_RECORDS } from "./lineage.js";
import {
  allRequiredValidationsPassed,
  effectiveBlockingFindings,
  pendingInspectionValidations,
  type WorkflowLegality,
  type WorkflowLegalityReadiness,
  workflowLegality,
} from "./transitions/queries.js";
import type {
  BlockingFinding,
  OperatorDecision,
  OperatorRecovery,
  OptionalFinding,
  WorkflowAction,
  WorkflowId,
  WorkflowState,
} from "./types.js";

const MAX_SUMMARY = 240;
const MAX_OPTIONAL_FINDINGS = 200;

export interface OperatorLineageRecord {
  state: WorkflowState;
  readiness?: WorkflowLegalityReadiness;
  legality?: WorkflowLegality;
}

function bounded(value: string, limit = MAX_SUMMARY): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function legalityFor(record: OperatorLineageRecord): WorkflowLegality {
  return record.legality ?? workflowLegality(record.state, record.readiness);
}

function stateStatus(record: OperatorLineageRecord): OperatorDecision["outcome"]["status"] {
  const { state } = record;
  if (state.superseded_by_workflow_id) return "superseded";
  const next = legalityFor(record).next;
  if (next.kind === "terminal") return next.outcome === "commit_mismatch" ? "failed" : "completed";
  switch (state.phase) {
    case "IMPLEMENTING":
    case "REPAIRING":
      return "in_progress";
    case "REVIEWING":
      return "awaiting_review";
    case "REPAIR_REQUIRED":
      return state.repair_cycle >= state.max_repair_cycles ? "exhausted" : "repair_needed";
    case "STOPPED_CONCERNS":
    case "STOPPED_NEEDS_CONTEXT":
    case "STOPPED_IMPLEMENTATION_BLOCKED":
    case "STOPPED_INCONCLUSIVE":
    case "STOPPED_NOT_COMMITTED":
    case "STOPPED_COMMIT_PREPARATION":
      return "recovery_needed";
    case "STOPPED_APPROVED":
      return "approved";
    case "COMMIT_AUTHORIZED":
    case "COMMIT_PREPARED":
      return "committing";
    case "COMMITTED":
      return "completed";
    case "STOPPED_REPAIR_EXHAUSTED":
      return "exhausted";
    case "STOPPED_COMMIT_MISMATCH":
      return "failed";
  }
}

function blockerSummary(finding: BlockingFinding | OptionalFinding): string {
  return bounded(finding.impact || finding.remediation || finding.violated_requirement);
}

function repairDecision(state: WorkflowState): OperatorDecision["primary"] {
  const blockers = effectiveBlockingFindings(state);
  if (blockers.length === 0) {
    return {
      kind: "operator_intervention",
      reason: "current blocker state is unavailable or contradictory",
    };
  }
  return {
    kind: "approve_exact_repairs",
    blocker_count: blockers.length,
    blockers: blockers.map((finding) => ({
      severity: finding.severity,
      summary: blockerSummary(finding),
    })),
    proposal: {
      required_outcome:
        "Resolve all current blocking findings without changing the approved intent.",
      strategy_constraints: bounded(
        blockers.map((finding) => finding.remediation).join("; "),
        MAX_SUMMARY,
      ),
      fallbacks: [
        {
          strategy: "Stop and request bounded context",
          condition: "the requested repair strategy is infeasible without changing approved intent",
        },
      ],
      required_paths: [],
      forbidden_paths: [],
    },
    authorization_required: true,
  };
}

function recoveryDecision(action: WorkflowAction): OperatorDecision["primary"] {
  const candidates = new Map<WorkflowAction, OperatorRecovery>([
    ["workflow_accept_concerns", "accept_concerns"],
    ["workflow_adopt_dirty_scope", "adopt_dirty_scope"],
    ["workflow_resume_implementation", "resume_implementation"],
    ["workflow_resume_review", "resume_review"],
    ["workflow_retry_commit", "retry_commit"],
    ["workflow_retry_commit_preparation", "retry_commit_preparation"],
    ["workflow_return_commit_to_review", "return_commit_to_review"],
  ]);
  const recovery = candidates.get(action);
  if (!recovery) {
    return {
      kind: "operator_intervention",
      reason: "no supported recovery is available",
    };
  }
  return { kind: "approve_recovery", recovery, authorization_required: true };
}

function optionalFindingSummaries(state: WorkflowState): OperatorDecision["optional_findings"] {
  return state.optional_findings.slice(0, MAX_OPTIONAL_FINDINGS).map((finding) => ({
    severity: finding.severity,
    summary: blockerSummary(finding),
  }));
}

function recoverySummary(
  state: WorkflowState,
  primary: OperatorDecision["primary"],
): OperatorDecision["recovery_summary"] {
  const commitResultReason =
    state.commit_result?.outcome === "not_committed"
      ? state.commit_result.failure_summary
      : state.commit_result?.outcome === "mismatch"
        ? "commit verification failed; repository state did not match the prepared commit"
        : null;
  const stopReason =
    state.stop_context?.summary ??
    commitResultReason ??
    (state.phase === "STOPPED_REPAIR_EXHAUSTED" ? "the repair cycle limit was reached" : null);
  return {
    choice: primary.kind === "approve_recovery" ? primary.recovery : null,
    stop_reason: stopReason === null ? null : bounded(stopReason),
    recovery_context:
      state.recovery_context === null ? null : bounded(state.recovery_context.context),
  };
}

function semanticFields(
  state: WorkflowState,
  primary: OperatorDecision["primary"],
): Pick<OperatorDecision, "optional_findings" | "recovery_summary"> {
  return {
    optional_findings: optionalFindingSummaries(state),
    recovery_summary: recoverySummary(state, primary),
  };
}

function primaryDecision(record: OperatorLineageRecord): OperatorDecision["primary"] {
  const { state } = record;
  const next = legalityFor(record).next;
  switch (next.kind) {
    case "worker_route":
      return { kind: "no_user_action", route: next.route };
    case "inspection_required":
      return {
        kind: "inspection_required",
        validations: pendingInspectionValidations(state).map((requirement) => ({
          validation_id: requirement.validation_id,
          description: bounded(requirement.description),
        })),
      };
    case "repair_required":
      return repairDecision(state);
    case "finalize_repair_exhausted":
      return {
        kind: "finalize_repair_exhausted",
        reason: "the repair cycle limit is reached; finalize the exhausted workflow",
      };
    case "bounded_continuation":
      return {
        kind: "approve_bounded_continuation",
        reason: "the bounded linked continuation is supported",
        authorization_required: true,
      };
    case "recovery":
      return recoveryDecision(next.action);
    case "authorize_commit":
      return { kind: "approve_commit", authorization_required: true };
    case "reconcile_commit":
      return {
        kind: "reconcile_commit",
        reason: "an existing commit requires server-owned result reconciliation",
      };
    case "terminal":
      return {
        kind: "terminal",
        outcome: next.outcome,
        reason:
          next.outcome === "committed"
            ? "the workflow commit is verified and complete"
            : next.outcome === "approved_no_commit_required"
              ? "review completed successfully and authoritative evidence shows no commit is required"
              : "commit verification failed and the mismatch is terminal",
      };
    case "unsupported":
      return { kind: "operator_intervention", reason: next.reason };
  }
}

function validateLineage(
  requested: WorkflowState,
  records: OperatorLineageRecord[],
): string | null {
  const byId = new Map<string, OperatorLineageRecord>();
  for (const record of records) {
    const id = record.state.workflow_id;
    if (!id || byId.has(id)) return "lineage contains a missing or duplicate workflow identity";
    byId.set(id, record);
  }
  if (!requested.workflow_id || !byId.has(requested.workflow_id))
    return "requested workflow is absent from lineage";
  if (byId.size > MAX_LINEAGE_RECORDS)
    return "explicit lineage exceeds the bounded traversal limit";
  // The store normally supplies the transitive closure of exact persisted references. Keep the
  // pure projection equally strict when called directly: an extra record must not smuggle an
  // unrelated workflow into the semantic summary.
  const reachable = new Set<string>();
  const pending: WorkflowId[] = [requested.workflow_id];
  while (pending.length > 0) {
    const id = pending.shift() as WorkflowId;
    if (reachable.has(id)) continue;
    const record = byId.get(id);
    if (!record) return "lineage contains a missing referenced workflow";
    reachable.add(id);
    for (const reference of lineageReferences(record.state)) {
      if (!byId.has(reference)) return "lineage contains a missing referenced workflow";
      if (!reachable.has(reference)) pending.push(reference);
    }
  }
  if (reachable.size !== byId.size) return "lineage contains an unreachable or unrelated workflow";

  const roots = new Set(
    records
      .map((record) => record.state.linked_continuation?.root_workflow_id)
      .filter((root): root is WorkflowId => root !== undefined),
  );
  if (roots.size > 1) return "linked lineage has divergent roots";
  for (const record of records) {
    const state = record.state;
    const stateId = state.workflow_id;
    if (!stateId) return "lineage contains a missing workflow identity";
    const continuation = state.linked_continuation;
    const refs = lineageReferences(state);
    if (refs.some((id) => !byId.has(id))) return "lineage contains a missing referenced workflow";
    if ((state.parent_workflow_id || state.source_workflow_id) && !continuation)
      return "linked workflow continuation is missing";
    if (
      state.parent_workflow_id !== state.source_workflow_id &&
      (state.parent_workflow_id !== null || state.source_workflow_id !== null)
    )
      return "linked workflow parent and source disagree";
    if (continuation) {
      if (
        state.parent_workflow_id !== continuation.predecessor_workflow_id ||
        state.source_workflow_id !== continuation.predecessor_workflow_id
      )
        return "linked workflow parent, source, and predecessor disagree";
      if (
        new Set(continuation.lineage_workflow_ids).size !== continuation.lineage_workflow_ids.length
      )
        return "linked lineage contains duplicate predecessors";
      if (
        continuation.lineage_workflow_ids.length === 0 ||
        continuation.lineage_workflow_ids.includes(stateId) ||
        continuation.lineage_workflow_ids.at(-1) !== continuation.predecessor_workflow_id
      )
        return "linked lineage predecessor list is inconsistent";
      if (!continuation.lineage_workflow_ids.includes(continuation.root_workflow_id))
        return "linked lineage root is not represented by its predecessors";
      const root = byId.get(continuation.root_workflow_id)?.state;
      if (!root) return "lineage contains a missing root";
      if (root.parent_workflow_id !== null || root.source_workflow_id !== null)
        return "linked lineage root has a parent or source";
      if (root.linked_continuation !== null)
        return "linked lineage root has continuation provenance";

      const lineage = continuation.lineage_workflow_ids;
      for (let index = 0; index < lineage.length; index += 1) {
        const lineageId = lineage[index];
        const lineageRecord = byId.get(lineageId)?.state;
        if (!lineageRecord) return "lineage contains a missing predecessor";
        if (index === 0) {
          if (lineageId !== continuation.root_workflow_id) return "linked lineage order is invalid";
          continue;
        }
        const previousId = lineage[index - 1] as WorkflowId;
        const previous = byId.get(previousId)?.state;
        const predecessorContinuation = lineageRecord.linked_continuation;
        if (
          !previous ||
          previous.superseded_by_workflow_id !== lineageId ||
          lineageRecord.parent_workflow_id !== previousId ||
          lineageRecord.source_workflow_id !== previousId ||
          !predecessorContinuation ||
          predecessorContinuation.root_workflow_id !== continuation.root_workflow_id ||
          predecessorContinuation.predecessor_workflow_id !== previousId ||
          JSON.stringify(predecessorContinuation.lineage_workflow_ids) !==
            JSON.stringify(lineage.slice(0, index))
        )
          return "linked lineage is not the exact ordered parent chain";
      }
    }
    if (state.superseded_by_workflow_id) {
      const successor = byId.get(state.superseded_by_workflow_id)?.state;
      if (
        !successor ||
        successor.parent_workflow_id !== stateId ||
        successor.source_workflow_id !== stateId ||
        successor.linked_continuation?.predecessor_workflow_id !== stateId
      )
        return "supersession is not reciprocal";
    }
    for (const parentId of [state.parent_workflow_id, state.source_workflow_id]) {
      if (parentId) {
        const parent = byId.get(parentId)?.state;
        if (
          !parent ||
          parent.superseded_by_workflow_id !== stateId ||
          state.linked_continuation?.predecessor_workflow_id !== parentId
        )
          return "linked parent is not reciprocal";
      }
    }
  }
  // Every directed supersession chain must be acyclic, not only the chain from the requested node.
  for (const candidate of records) {
    const seen = new Set<string>();
    let current: WorkflowState | undefined = candidate.state;
    while (current?.superseded_by_workflow_id) {
      if (seen.has(current.workflow_id as string)) return "lineage contains a cycle";
      seen.add(current.workflow_id as string);
      current = byId.get(current.superseded_by_workflow_id)?.state;
    }
  }
  return null;
}

function boundaryDecision(
  record: OperatorLineageRecord,
  records: OperatorLineageRecord[],
): OperatorDecision["authority_boundaries"] {
  const explicit = records.some((record) => record.state.linked_continuation !== null);
  const scopeAction = legalityFor(record).actions.parent.includes("workflow_expand_scope");
  const combined = records.some(
    (record) => record.state.linked_continuation?.review_stage === "combined",
  );
  return {
    approve_scope_change: {
      availability: scopeAction ? "requires_new_user_intent" : "unavailable",
      basis: scopeAction
        ? "the current workflow permits a newly authorized exact scope request"
        : "the current workflow exposes no scope expansion authority",
    },
    approve_final_reconciliation: {
      availability: explicit
        ? combined
          ? "already_satisfied"
          : "available"
        : "requires_logical_change_topology",
      basis: explicit
        ? combined
          ? "explicit linked lineage already represents the combined review boundary"
          : "explicit linked lineage supplies the supported continuation boundary"
        : "unlinked workflows cannot be joined without authoritative logical-change topology",
    },
  };
}

export function deriveOperatorDecision(
  requested: WorkflowState,
  records: OperatorLineageRecord[] = [{ state: requested }],
): OperatorDecision {
  const requestedRecord = records.find(
    (candidate) => candidate.state.workflow_id === requested.workflow_id,
  ) ?? { state: requested };
  const lineageError = validateLineage(requested, records);
  if (lineageError) {
    return {
      primary: { kind: "operator_intervention", reason: lineageError },
      ...semanticFields(requested, { kind: "operator_intervention", reason: lineageError }),
      authority_boundaries: {
        approve_scope_change: { availability: "unavailable", basis: "lineage is inconsistent" },
        approve_final_reconciliation: {
          availability: "requires_logical_change_topology",
          basis: "lineage is inconsistent",
        },
      },
      intent: {
        objective: bounded(requested.objective, 4000),
        scope_kind: requested.approved_plan ? "approved_plan" : "direct",
        path_count: requested.approved_paths.length,
        display_references: [],
      },
      outcome: {
        status: stateStatus(requestedRecord),
        blocker_count: effectiveBlockingFindings(requested).length,
      },
      related_workflows: [],
      reconciliation: { status: "not_applicable", basis: "lineage is inconsistent" },
      commit: { eligible: false, authorization: "unavailable" },
    };
  }
  const record = requestedRecord;
  const primary = primaryDecision(record);
  const boundaries = boundaryDecision(record, records);
  const explicit = records.some((candidate) => candidate.state.linked_continuation !== null);
  const combined = records.some(
    (candidate) => candidate.state.linked_continuation?.review_stage === "combined",
  );
  const status =
    primary.kind === "terminal"
      ? primary.outcome === "commit_mismatch"
        ? "failed"
        : "completed"
      : stateStatus(record);
  const related = records
    .filter((candidate) => candidate.state.workflow_id !== requested.workflow_id)
    .sort((left, right) =>
      String(left.state.workflow_id).localeCompare(String(right.state.workflow_id)),
    )
    .map((candidate) => ({
      status: stateStatus(candidate),
      relation:
        candidate.state.superseded_by_workflow_id === requested.workflow_id
          ? ("ancestor" as const)
          : candidate.state.parent_workflow_id === requested.workflow_id ||
              candidate.state.source_workflow_id === requested.workflow_id
            ? ("successor" as const)
            : ("lineage" as const),
    }));
  const blockers = effectiveBlockingFindings(requested);
  const commitEligible =
    requested.phase === "STOPPED_APPROVED" &&
    requested.review_target.review_mode === "working_tree" &&
    allRequiredValidationsPassed(requested) &&
    legalityFor(record).actions.parent.includes("workflow_authorize_commit");
  return {
    primary,
    ...semanticFields(requested, primary),
    authority_boundaries: boundaries,
    intent: {
      objective: bounded(requested.objective, 4000),
      scope_kind: requested.approved_plan ? "approved_plan" : "direct",
      path_count: requested.approved_paths.length,
      display_references: [...new Set(requested.work_items.map((item) => item.display_ref))],
    },
    outcome: { status, blocker_count: blockers.length },
    related_workflows: related,
    reconciliation: {
      status: explicit
        ? combined
          ? "combined_review_required"
          : "remediation_then_combined_review"
        : "not_applicable",
      basis: explicit
        ? "explicit linked lineage only"
        : "one unlinked workflow is not a cross-workflow topology",
    },
    commit: {
      eligible: commitEligible,
      authorization: commitEligible
        ? "required"
        : requested.commit_authorization
          ? "satisfied"
          : "unavailable",
    },
  };
}

export const operatorDecision = deriveOperatorDecision;
