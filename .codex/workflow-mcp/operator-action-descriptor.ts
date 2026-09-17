import { repairProposalForFindings, repairProposalSelection } from "./repair-proposal.js";
import {
  effectiveBlockingFindings,
  pendingInspectionValidations,
  type WorkflowLegality,
} from "./transitions/queries.js";
import type {
  FindingId,
  OperatorAdjudicationBinding,
  OperatorAuthorizationMetadata,
  OperatorBindingReference,
  OperatorCollectEvidenceDescriptor,
  OperatorExecutionDescriptor,
  OperatorExpectedNext,
  OperatorInputSource,
  OperatorLinkedFollowupBinding,
  OperatorMutationInvocation,
  OperatorNextActionDescriptor,
  OperatorParentActionDescriptor,
  OperatorParentMutationOperation,
  OperatorPlanBinding,
  OperatorRepairAuthorizationDescriptor,
  OperatorRequiredInput,
  OperatorScopeReconciliationBinding,
  OperatorStaleBinding,
  OperatorWorkerDispatchOperation,
  ValidationRequirementId,
  WorkflowAction,
  WorkflowId,
  WorkflowState,
  WorkflowVersion,
} from "./types.js";
import {
  ACTION_DESCRIPTOR_METADATA,
  WORKFLOW_ACTION_REGISTRY,
} from "./workflow-action-registry.js";

const noAuthorization = (): OperatorAuthorizationMetadata => ({
  required: false,
  representation: { kind: "none" },
  binding: { kind: "none" },
});

const input = (
  path: string[],
  source: OperatorInputSource,
  sourcePath?: string[],
): OperatorRequiredInput => ({
  path,
  source,
  ...(sourcePath ? { source_path: sourcePath } : {}),
  required: true,
});

function linkedFindingSummary(finding: {
  impact: string;
  remediation: string;
  violated_requirement: string;
}): string {
  const summary = (finding.impact || finding.remediation || finding.violated_requirement)
    .replace(/\s+/gu, " ")
    .trim();
  return summary.length <= 240 ? summary : `${summary.slice(0, 239)}…`;
}

export { ACTION_DESCRIPTOR_METADATA } from "./workflow-action-registry.js";

function identity(
  state: WorkflowState,
): { workflow_id: WorkflowId; version: WorkflowVersion } | null {
  if (!state.workflow_id) return null;
  return { workflow_id: state.workflow_id, version: state.version };
}

function referencesFor(
  state: WorkflowState,
  action: WorkflowAction,
  selectedFindingIds?: ReadonlyArray<FindingId>,
): OperatorBindingReference[] {
  const references: OperatorBindingReference[] = [];
  if (state.review_result_version !== null) {
    references.push({ kind: "review_result", version: state.review_result_version });
  }
  if (
    action === "workflow_expand_scope" ||
    action === "workflow_create_linked_followup" ||
    action === "workflow_create_linked_followup_from_plan" ||
    action === "workflow_reconcile_staged_scope"
  ) {
    references.push({ kind: "scope", paths: [...state.approved_paths] });
    references.push({
      kind: "finding",
      finding_ids: [
        ...state.blocking_findings.map((finding) => finding.finding_id),
        ...state.optional_findings.map((finding) => finding.finding_id),
      ],
    });
  }
  if (action === "workflow_finalize_repair_exhausted") {
    references.push({
      kind: "finding",
      finding_ids: state.blocking_findings.map((finding) => finding.finding_id),
    });
    references.push({
      kind: "repair_cycle",
      cycle: state.repair_cycle,
      maximum: state.max_repair_cycles,
    });
  }
  if (action === "workflow_authorize_repair") {
    const selection = repairProposalSelection(state, selectedFindingIds);
    const proposal = repairProposalForFindings(selection.selected_findings);
    references.push({ kind: "scope", paths: [...state.approved_paths] });
    references.push({
      kind: "repair_selection",
      eligible_finding_ids: selection.eligible_finding_ids,
      selected_finding_ids: selection.selected_finding_ids,
      proposal,
    });
    references.push({
      kind: "repair_cycle",
      cycle: state.repair_cycle,
      maximum: state.max_repair_cycles,
    });
  }
  if (action === "workflow_adjudicate_findings") {
    references.push({
      kind: "finding",
      finding_ids: effectiveBlockingFindings(state).map((finding) => finding.finding_id),
    });
  }
  if (action === "workflow_reconcile_commit_result" && state.commit_preparation) {
    references.push({
      kind: "commit_attempt",
      attempt_id: state.commit_preparation.attempt_id,
    });
  }
  if (action === "workflow_retry_commit" && state.commit_preparation) {
    references.push({
      kind: "commit_attempt",
      attempt_id: state.commit_preparation.attempt_id,
    });
  }
  return references;
}

function staleBinding(
  state: WorkflowState,
  action: WorkflowAction,
  additionalReferences: OperatorBindingReference[] = [],
  selectedFindingIds?: ReadonlyArray<FindingId>,
): OperatorStaleBinding {
  const current = identity(state);
  if (!current) throw new Error("descriptor requires a persisted workflow identity");
  return {
    workflow_id: current.workflow_id,
    expected_version: state.version,
    references: [...referencesFor(state, action, selectedFindingIds), ...additionalReferences],
  };
}

function fixedArguments(
  state: WorkflowState,
  action: WorkflowAction,
  planIdentity?: OperatorPlanBinding,
): Record<string, string | number | null> {
  const current = identity(state);
  if (!current) throw new Error("descriptor requires a persisted workflow identity");
  const fixed: Record<string, string | number | null> = {
    workflow_id: current.workflow_id,
    expected_version: current.version,
  };
  if (action === "workflow_reconcile_commit_result" && state.commit_preparation) {
    fixed.attempt_id = state.commit_preparation.attempt_id;
  }
  if (action === "workflow_create_linked_followup_from_plan") {
    if (!planIdentity) throw new Error("plan-native follow-up requires an approved child plan");
    fixed.plan_id = planIdentity.plan_id;
    fixed.revision = planIdentity.revision;
  }
  if (action === "workflow_rebind_implementation_plan") {
    if (planIdentity?.source !== "approved_recovery_plan_context") {
      throw new Error("implementation plan rebind requires an approved recovery plan");
    }
    fixed.plan_id = planIdentity.plan_id;
    fixed.revision = planIdentity.revision;
  }
  if (action === "workflow_create_linked_followup") fixed.approved_plan = null;
  return fixed;
}

function expectedAfter(action: OperatorParentMutationOperation): OperatorExpectedNext[] {
  const definition = WORKFLOW_ACTION_REGISTRY[action];
  return "expected_after" in definition ? [...definition.expected_after] : ["wait"];
}

function workerOperation(
  legality: WorkflowLegality,
  route: "implement" | "review" | "re_review" | "commit",
): OperatorWorkerDispatchOperation | null {
  switch (route) {
    case "implement":
      return legality.actions.implementer.includes("workflow_submit_implementation")
        ? "workflow_submit_implementation"
        : null;
    case "review":
    case "re_review":
      if (legality.actions.reviewer.includes("workflow_submit_review"))
        return "workflow_submit_review";
      if (legality.actions.reviewer.includes("workflow_begin_review"))
        return "workflow_begin_review";
      return null;
    case "commit":
      if (legality.actions.committer.includes("workflow_submit_commit_result"))
        return "workflow_submit_commit_result";
      return legality.actions.committer.includes("workflow_prepare_commit")
        ? "workflow_prepare_commit"
        : null;
  }
}

function invocation(
  state: WorkflowState,
  action: OperatorParentMutationOperation,
  selectedFindingIds?: ReadonlyArray<FindingId>,
  planIdentity?: OperatorPlanBinding,
): OperatorMutationInvocation {
  const metadata = ACTION_DESCRIPTOR_METADATA[action];
  if (metadata.mode !== "parent_mutation")
    throw new Error(`action ${action} is not descriptorized as a parent mutation`);
  const selection =
    action === "workflow_authorize_repair"
      ? repairProposalSelection(state, selectedFindingIds)
      : null;
  const proposal = selection ? repairProposalForFindings(selection.selected_findings) : null;
  const adjudicationBinding: OperatorAdjudicationBinding | null =
    action === "workflow_adjudicate_findings"
      ? {
          finding_ids: effectiveBlockingFindings(state).map((finding) => finding.finding_id),
          user_input_paths: [
            ["findings", "*", "disposition"],
            ["findings", "*", "reason"],
          ],
        }
      : null;
  const reconciliationBinding: OperatorScopeReconciliationBinding | null =
    action === "workflow_reconcile_staged_scope"
      ? {
          reviewed_paths: [...state.review_target.approved_paths],
          added_paths: [
            ...(state.stop_context?.status === "COMMIT_PREPARATION_FAILED"
              ? (state.stop_context.reconciliation_paths ?? [])
              : []),
          ],
        }
      : null;
  const linkedFollowupBinding: OperatorLinkedFollowupBinding | null =
    action === "workflow_create_linked_followup" ||
    action === "workflow_create_linked_followup_from_plan"
      ? {
          selection_rule: "nonempty_subset_from_one_bucket",
          blocking_findings: effectiveBlockingFindings(state).map((finding) => ({
            finding_id: finding.finding_id,
            severity: finding.severity,
            summary: linkedFindingSummary(finding),
          })),
          optional_findings: state.optional_findings.map((finding) => ({
            finding_id: finding.finding_id,
            severity: finding.severity,
            summary: linkedFindingSummary(finding),
          })),
        }
      : null;
  const descriptor: OperatorMutationInvocation = {
    operation: action,
    semantic_choice: semanticChoice(action),
    fixed_arguments: fixedArguments(state, action, planIdentity),
    required_inputs: metadata.inputs.map((requiredInput) => ({
      path: [...requiredInput.path],
      source: requiredInput.source,
      ...(requiredInput.source_path ? { source_path: [...requiredInput.source_path] } : {}),
      required: true,
    })),
    ...("input_alternatives" in metadata && metadata.input_alternatives
      ? {
          input_alternatives: metadata.input_alternatives.map((alternative) => ({
            paths: alternative.paths.map((path) => [...path]),
            source: alternative.source,
            ...(alternative.source_path ? { source_path: [...alternative.source_path] } : {}),
            required: true,
          })),
        }
      : {}),
    authorization: metadata.authorization,
    ...(selection && proposal
      ? {
          repair_binding: {
            eligible_finding_ids: selection.eligible_finding_ids,
            selected_finding_ids: selection.selected_finding_ids,
            proposal,
          },
        }
      : {}),
    ...(adjudicationBinding ? { adjudication_binding: adjudicationBinding } : {}),
    ...(linkedFollowupBinding ? { linked_followup_binding: linkedFollowupBinding } : {}),
    ...(reconciliationBinding ? { scope_reconciliation_binding: reconciliationBinding } : {}),
    ...((action === "workflow_create_linked_followup_from_plan" ||
      action === "workflow_rebind_implementation_plan") &&
    planIdentity
      ? { plan_binding: planIdentity }
      : {}),
    stale_binding: staleBinding(
      state,
      action,
      action === "workflow_rebind_implementation_plan" && planIdentity
        ? [{ kind: "plan", plan_id: planIdentity.plan_id, revision: planIdentity.revision }]
        : [],
      selectedFindingIds,
    ),
    on_success: {
      kind: "refresh_required",
      expected: expectedAfter(action),
      dispatch_authority: false,
      ...(action === "workflow_authorize_repair" || action === "workflow_adjudicate_findings"
        ? {
            committed_result: {
              response_path: ["committed_execution"],
              dispatch_authority: false as const,
            },
          }
        : {}),
    },
  };
  return descriptor;
}

function semanticChoice(action: OperatorParentMutationOperation): {
  id: string;
  label: string;
  summary: string;
} {
  return WORKFLOW_ACTION_REGISTRY[action].semantic_choice;
}

function inspectionInvocation(
  state: WorkflowState,
  validationId: ValidationRequirementId,
  status: "passed" | "failed",
): OperatorMutationInvocation {
  return {
    operation: "workflow_record_manual_validation",
    semantic_choice: semanticChoice("workflow_record_manual_validation"),
    fixed_arguments: {
      ...fixedArguments(state, "workflow_record_manual_validation"),
      validation_id: validationId,
      status,
    },
    required_inputs: [input(["evidence"], "observed_evidence")],
    authorization: noAuthorization(),
    stale_binding: staleBinding(state, "workflow_record_manual_validation", [
      { kind: "validation", validation_ids: [validationId] },
    ]),
    on_success: {
      kind: "refresh_required",
      expected:
        status === "passed"
          ? ["collect_evidence", "accept_concerns", "resume_review", "review", "re_review", "wait"]
          : ["collect_evidence", "resume_review", "review", "re_review", "wait"],
      dispatch_authority: false,
    },
  };
}

function inspectionDescriptor(state: WorkflowState): OperatorCollectEvidenceDescriptor {
  const requirement = pendingInspectionValidations(state)[0];
  if (!requirement) throw new Error("inspection descriptor requires pending evidence");
  return {
    mode: "collect_evidence",
    validation_id: requirement.validation_id,
    outcomes: {
      observed: {
        passed: {
          mode: "parent_mutation",
          selection: "single",
          invocations: [inspectionInvocation(state, requirement.validation_id, "passed")],
        },
        failed: {
          mode: "parent_mutation",
          selection: "single",
          invocations: [inspectionInvocation(state, requirement.validation_id, "failed")],
        },
      },
      unavailable: {
        mode: "wait",
        reason: `inspection evidence for ${requirement.validation_id} is unavailable or unobserved`,
      },
    },
    specialization: "recovery_inspection",
  };
}

function repairAuthorizationDescriptor(
  state: WorkflowState,
  selectedFindingIds?: ReadonlyArray<FindingId>,
): OperatorRepairAuthorizationDescriptor {
  const selection = repairProposalSelection(state, selectedFindingIds);
  return {
    mode: "parent_mutation",
    specialization: "repair_authorization",
    selection: "single",
    repair_binding: {
      eligible_finding_ids: selection.eligible_finding_ids,
      selected_finding_ids: selection.selected_finding_ids,
      proposal: repairProposalForFindings(selection.selected_findings),
    },
    invocations: [invocation(state, "workflow_authorize_repair", selectedFindingIds)],
  };
}

function parentActionDescriptor(
  state: WorkflowState,
  action: WorkflowAction,
  selectedFindingIds?: ReadonlyArray<FindingId>,
): OperatorParentActionDescriptor {
  const metadata = ACTION_DESCRIPTOR_METADATA[action];
  if (metadata.mode === "collect_evidence") {
    return {
      action: "workflow_record_manual_validation",
      status: "evidence_required",
      descriptor: inspectionDescriptor(state),
    };
  }
  if (action === "workflow_authorize_repair") {
    return {
      action,
      status: "executable",
      descriptor: repairAuthorizationDescriptor(state, selectedFindingIds),
    };
  }
  if (metadata.mode === "parent_mutation") {
    return {
      action,
      status: "executable",
      descriptor: {
        mode: "parent_mutation",
        selection: "single",
        invocations: [],
      },
    };
  }
  throw new Error(`parent action ${action} has no parent descriptor treatment`);
}

function completeParentInvocation(
  state: WorkflowState,
  descriptor: OperatorParentActionDescriptor,
  planIdentity?: OperatorPlanBinding,
): OperatorParentActionDescriptor {
  if (descriptor.status !== "executable") return descriptor;
  const action = descriptor.action as OperatorParentMutationOperation;
  return {
    ...descriptor,
    descriptor: {
      ...descriptor.descriptor,
      invocations: [
        invocation(
          state,
          action,
          "repair_binding" in descriptor.descriptor
            ? descriptor.descriptor.repair_binding.selected_finding_ids
            : undefined,
          planIdentity,
        ),
      ],
    },
  };
}

function primaryDescriptor(
  state: WorkflowState,
  legality: WorkflowLegality,
  selectedFindingIds?: ReadonlyArray<FindingId>,
  planIdentity?: OperatorPlanBinding,
): OperatorNextActionDescriptor {
  const current = identity(state);
  if (!current) return { mode: "wait", reason: "workflow identity is unavailable" };
  switch (legality.next.kind) {
    case "worker_route": {
      const operation = workerOperation(legality, legality.next.route);
      if (!operation) return { mode: "wait", reason: "worker dispatch authority is unavailable" };
      return {
        mode: "dispatch",
        route: legality.next.route,
        operation,
        workflow_id: current.workflow_id,
        expected_version: current.version,
      };
    }
    case "inspection_required":
      return inspectionDescriptor(state);
    case "repair_required":
      return repairAuthorizationDescriptor(state, selectedFindingIds);
    case "finalize_repair_exhausted":
      return {
        mode: "parent_mutation",
        selection: "single",
        invocations: [invocation(state, "workflow_finalize_repair_exhausted")],
      };
    case "bounded_continuation":
      return {
        mode: "parent_mutation",
        selection: "choose_one",
        invocations: [
          invocation(state, "workflow_create_linked_followup"),
          ...(planIdentity
            ? [
                invocation(
                  state,
                  "workflow_create_linked_followup_from_plan",
                  undefined,
                  planIdentity,
                ),
              ]
            : []),
        ],
      };
    case "recovery":
      return {
        mode: "parent_mutation",
        selection: "single",
        invocations: [
          invocation(
            state,
            legality.next.action as OperatorParentMutationOperation,
            undefined,
            planIdentity,
          ),
        ],
      };
    case "recovery_choice":
      return {
        mode: "parent_mutation",
        selection: "choose_one",
        invocations: legality.next.actions.map((action) =>
          invocation(state, action as OperatorParentMutationOperation),
        ),
      };
    case "authorize_commit":
      return {
        mode: "parent_mutation",
        selection: "single",
        invocations: [invocation(state, "workflow_authorize_commit")],
      };
    case "reconcile_commit":
      return {
        mode: "parent_mutation",
        selection: "single",
        invocations: [invocation(state, "workflow_reconcile_commit_result")],
      };
    case "terminal":
      return { mode: "terminal", outcome: legality.next.outcome };
    case "unsupported":
      return { mode: "wait", reason: legality.next.reason };
  }
}

export function descriptorForLegality(
  state: WorkflowState,
  legality: WorkflowLegality,
  selectedFindingIds?: ReadonlyArray<FindingId>,
  planIdentity?: OperatorPlanBinding,
): OperatorExecutionDescriptor {
  const parentActions = legality.actions.parent
    .filter(
      (action) =>
        action !== "workflow_create_linked_followup_from_plan" || planIdentity !== undefined,
    )
    .map((action) =>
      completeParentInvocation(
        state,
        parentActionDescriptor(state, action, selectedFindingIds),
        planIdentity,
      ),
    );
  return {
    descriptor_version: 5,
    primary: primaryDescriptor(state, legality, selectedFindingIds, planIdentity),
    parent_actions: parentActions,
  };
}
