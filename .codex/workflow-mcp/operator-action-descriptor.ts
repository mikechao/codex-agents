import { repairProposalForFindings, repairProposalSelection } from "./repair-proposal.js";
import {
  effectiveBlockingFindings,
  pendingInspectionValidations,
  type WorkflowLegality,
} from "./transitions/queries.js";
import type {
  FindingId,
  OperatorActionDescriptorMetadata,
  OperatorAdjudicationBinding,
  OperatorAuthorizationBinding,
  OperatorAuthorizationMetadata,
  OperatorBindingReference,
  OperatorCollectEvidenceDescriptor,
  OperatorExecutionDescriptor,
  OperatorExpectedNext,
  OperatorInputAlternative,
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

const noAuthorization = (): OperatorAuthorizationMetadata => ({
  required: false,
  representation: { kind: "none" },
  binding: { kind: "none" },
});

type RequiredAuthorizationBinding = Exclude<OperatorAuthorizationBinding, { kind: "none" }>;

const allBinding = (paths: string[][]): RequiredAuthorizationBinding => ({
  kind: "all",
  paths,
});

const exclusiveBinding = (
  commonPaths: string[][],
  alternatives: string[][],
): RequiredAuthorizationBinding => ({
  kind: "exclusive_one_of",
  common_paths: commonPaths,
  alternatives,
});

const fieldAuthorization = (
  path: string[],
  boundSemanticInputPaths: string[][],
  alternatives: string[][] = [],
): OperatorAuthorizationMetadata => ({
  required: true,
  representation: { kind: "field", path },
  binding:
    alternatives.length === 0
      ? allBinding(boundSemanticInputPaths)
      : exclusiveBinding(boundSemanticInputPaths, alternatives),
});

const metadataAuthorization = (
  boundSemanticInputPaths: string[][],
  alternatives: string[][] = [],
): OperatorAuthorizationMetadata => ({
  required: true,
  representation: { kind: "metadata_only" },
  binding:
    alternatives.length === 0
      ? allBinding(boundSemanticInputPaths)
      : exclusiveBinding(boundSemanticInputPaths, alternatives),
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

const inputAlternative = (
  paths: string[][],
  source: OperatorInputSource,
): OperatorInputAlternative => ({
  paths,
  source,
  required: true,
});

type DescriptorActionMetadata = OperatorActionDescriptorMetadata;

/**
 * This is an invocation/protocol classification registry, not a legality table. Its complete
 * key set is deliberately tied to WorkflowAction so a new action cannot silently lack treatment.
 */
export const ACTION_DESCRIPTOR_METADATA = {
  workflow_create: {
    classification: "protocol_or_query_only",
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_adopt_dirty_scope: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_adopt_dirty_scope",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [["reason"]],
      [["added_paths"], ["adopted_paths"]],
    ),
    inputs: [input(["reason"], "user_authored")],
    input_alternatives: [inputAlternative([["added_paths"], ["adopted_paths"]], "user_authored")],
  },
  workflow_expand_scope: {
    classification: "descriptorized_in_142",
    mode: "parent_mutation",
    operation: "workflow_expand_scope",
    authorization: fieldAuthorization(["user_authorization"], [["added_paths"], ["reason"]]),
    inputs: [input(["added_paths"], "user_authored"), input(["reason"], "user_authored")],
  },
  workflow_parent_get: {
    classification: "protocol_or_query_only",
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_implementer_get: {
    classification: "protocol_or_query_only",
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_reviewer_get: {
    classification: "protocol_or_query_only",
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_committer_get: {
    classification: "protocol_or_query_only",
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_get_audit: {
    classification: "protocol_or_query_only",
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_submit_implementation: {
    classification: "descriptorized_in_142",
    mode: "dispatch",
    operation: "workflow_submit_implementation",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_record_manual_validation: {
    classification: "descriptorized_in_143",
    mode: "collect_evidence",
    operation: "workflow_record_manual_validation",
    authorization: noAuthorization(),
    inputs: [input(["evidence"], "observed_evidence")],
  },
  workflow_resume_implementation: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_resume_implementation",
    authorization: metadataAuthorization([["resume_context"]]),
    inputs: [input(["resume_context"], "user_authored")],
  },
  workflow_rebind_implementation_plan: {
    classification: "descriptorized_in_155",
    mode: "parent_mutation",
    operation: "workflow_rebind_implementation_plan",
    authorization: fieldAuthorization(["user_authorization"], [["plan_id"], ["revision"]]),
    inputs: [],
  },
  workflow_accept_concerns: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_accept_concerns",
    authorization: fieldAuthorization(["user_authorization"], []),
    inputs: [],
  },
  workflow_begin_review: {
    classification: "descriptorized_in_142",
    mode: "dispatch",
    operation: "workflow_begin_review",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_submit_review: {
    classification: "descriptorized_in_142",
    mode: "dispatch",
    operation: "workflow_submit_review",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_authorize_repair: {
    classification: "descriptorized_in_144",
    mode: "parent_mutation",
    operation: "workflow_authorize_repair",
    authorization: fieldAuthorization(
      ["repair_directive", "user_authorization"],
      [
        ["finding_ids"],
        ["repair_directive", "selected_finding_ids"],
        ["repair_directive", "required_outcome"],
        ["repair_directive", "strategy_constraints"],
        ["repair_directive", "fallbacks"],
        ["repair_directive", "required_paths"],
        ["repair_directive", "forbidden_paths"],
      ],
    ),
    inputs: [
      input(["finding_ids"], "server_derived", ["selected_finding_ids"]),
      input(["repair_directive", "selected_finding_ids"], "server_derived", [
        "selected_finding_ids",
      ]),
      input(["repair_directive", "required_outcome"], "server_derived", [
        "proposal",
        "required_outcome",
      ]),
      input(["repair_directive", "strategy_constraints"], "server_derived", [
        "proposal",
        "strategy_constraints",
      ]),
      input(["repair_directive", "fallbacks"], "server_derived", ["proposal", "fallbacks"]),
      input(["repair_directive", "required_paths"], "server_derived", [
        "proposal",
        "required_paths",
      ]),
      input(["repair_directive", "forbidden_paths"], "server_derived", [
        "proposal",
        "forbidden_paths",
      ]),
    ],
  },
  workflow_adjudicate_findings: {
    classification: "descriptorized_in_144",
    mode: "parent_mutation",
    operation: "workflow_adjudicate_findings",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [
        ["findings", "*", "finding_id"],
        ["findings", "*", "disposition"],
        ["findings", "*", "reason"],
      ],
    ),
    inputs: [
      input(["findings", "*", "finding_id"], "server_derived"),
      input(["findings", "*", "disposition"], "user_authored"),
      input(["findings", "*", "reason"], "user_authored"),
    ],
  },
  workflow_resume_review: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_resume_review",
    authorization: metadataAuthorization([["resume_context"]]),
    inputs: [input(["resume_context"], "user_authored")],
  },
  workflow_finalize_repair_exhausted: {
    classification: "descriptorized_in_142",
    mode: "parent_mutation",
    operation: "workflow_finalize_repair_exhausted",
    authorization: metadataAuthorization([]),
    inputs: [],
  },
  workflow_create_linked_followup: {
    classification: "descriptorized_in_142",
    mode: "parent_mutation",
    operation: "workflow_create_linked_followup",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [
        ["objective"],
        ["approved_paths"],
        ["acceptance_criteria"],
        ["validation_requirements"],
        ["finding_ids"],
      ],
    ),
    inputs: [
      input(["objective"], "user_authored"),
      input(["approved_paths"], "user_authored"),
      input(["acceptance_criteria"], "user_authored"),
      input(["validation_requirements"], "user_authored"),
      input(["finding_ids"], "server_derived"),
    ],
  },
  workflow_create_linked_followup_from_plan: {
    classification: "descriptorized_in_142",
    mode: "parent_mutation",
    operation: "workflow_create_linked_followup_from_plan",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [["plan_id"], ["revision"], ["finding_ids"]],
    ),
    inputs: [input(["finding_ids"], "server_derived")],
  },
  workflow_authorize_commit: {
    classification: "descriptorized_in_142",
    mode: "parent_mutation",
    operation: "workflow_authorize_commit",
    authorization: fieldAuthorization(["user_authorization"], []),
    inputs: [],
  },
  workflow_prepare_commit: {
    classification: "descriptorized_in_142",
    mode: "dispatch",
    operation: "workflow_prepare_commit",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_submit_commit_result: {
    classification: "descriptorized_in_142",
    mode: "dispatch",
    operation: "workflow_submit_commit_result",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_reconcile_commit_result: {
    classification: "descriptorized_in_142",
    mode: "parent_mutation",
    operation: "workflow_reconcile_commit_result",
    authorization: metadataAuthorization([]),
    inputs: [],
  },
  workflow_retry_commit_preparation: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_retry_commit_preparation",
    authorization: metadataAuthorization([["retry_context"]]),
    inputs: [input(["retry_context"], "user_authored")],
  },
  workflow_reconcile_staged_scope: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_reconcile_staged_scope",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [["added_paths"], ["review_context"]],
    ),
    inputs: [input(["added_paths"], "server_derived"), input(["review_context"], "user_authored")],
  },
  workflow_return_commit_to_review: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_return_commit_to_review",
    authorization: metadataAuthorization([["review_context"]]),
    inputs: [input(["review_context"], "user_authored")],
  },
  workflow_retry_commit: {
    classification: "descriptorized_in_143",
    mode: "parent_mutation",
    operation: "workflow_retry_commit",
    authorization: metadataAuthorization([["retry_context"]]),
    inputs: [input(["retry_context"], "user_authored")],
  },
} as const satisfies Record<WorkflowAction, DescriptorActionMetadata>;

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
  switch (action) {
    case "workflow_adopt_dirty_scope":
      return ["adopt_dirty_scope", "collect_evidence", "resume_review", "wait"];
    case "workflow_resume_implementation":
    case "workflow_rebind_implementation_plan":
      return ["implement", "wait"];
    case "workflow_accept_concerns":
      return ["collect_evidence", "review", "re_review", "wait"];
    case "workflow_resume_review":
      return ["re_review", "wait"];
    case "workflow_retry_commit_preparation":
    case "workflow_retry_commit":
      return ["commit", "wait"];
    case "workflow_return_commit_to_review":
      return ["re_review", "wait"];
    case "workflow_reconcile_staged_scope":
      return ["re_review", "wait"];
    case "workflow_expand_scope":
      return ["implement", "review", "re_review", "wait"];
    case "workflow_finalize_repair_exhausted":
      return ["bounded_continuation", "wait"];
    case "workflow_authorize_repair":
      return ["implement", "wait"];
    case "workflow_adjudicate_findings":
      return ["review", "re_review", "wait"];
    case "workflow_create_linked_followup":
    case "workflow_create_linked_followup_from_plan":
      return ["implement", "wait"];
    case "workflow_authorize_commit":
      return ["commit", "wait"];
    case "workflow_reconcile_commit_result":
      return ["terminal_committed", "terminal_commit_mismatch"];
    default:
      return ["wait"];
  }
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
  const ids: Record<OperatorParentMutationOperation, string> = {
    workflow_adopt_dirty_scope: "adopt_existing_changes",
    workflow_expand_scope: "authorize_more_paths",
    workflow_record_manual_validation: "record_observed_validation",
    workflow_resume_implementation: "continue_implementation",
    workflow_rebind_implementation_plan: "adopt_approved_plan_revision",
    workflow_accept_concerns: "accept_bounded_concerns",
    workflow_authorize_repair: "authorize_bounded_repair",
    workflow_adjudicate_findings: "resolve_inconsistent_findings",
    workflow_resume_review: "continue_review",
    workflow_finalize_repair_exhausted: "stop_at_repair_limit",
    workflow_create_linked_followup: "start_direct_followup",
    workflow_create_linked_followup_from_plan: "start_approved_plan_followup",
    workflow_authorize_commit: "authorize_commit_preparation",
    workflow_retry_commit_preparation: "retry_preparation",
    workflow_reconcile_staged_scope: "authorize_scope_reconciliation",
    workflow_return_commit_to_review: "refresh_review_authority",
    workflow_reconcile_commit_result: "resolve_commit_result",
    workflow_retry_commit: "retry_commit_attempt",
  };
  const choices: Record<OperatorParentMutationOperation, { label: string; summary: string }> = {
    workflow_adopt_dirty_scope: {
      label: "Adopt the selected dirty paths",
      summary: "Add the exact selected existing dirty paths to the current workflow authority.",
    },
    workflow_expand_scope: {
      label: "Expand the approved scope",
      summary: "Authorize additional paths for implementation and subsequent review.",
    },
    workflow_record_manual_validation: {
      label: "Record observed validation evidence",
      summary: "Record only evidence from the declared validation inspection.",
    },
    workflow_resume_implementation: {
      label: "Resume implementation with context",
      summary: "Supply bounded context and resume the currently authorized implementation.",
    },
    workflow_rebind_implementation_plan: {
      label: "Rebind to the approved plan revision",
      summary:
        "Replace stale plan authority with the exact current approved revision and resume implementation.",
    },
    workflow_accept_concerns: {
      label: "Accept the implementation concerns",
      summary: "Accept the current bounded concerns and continue to review.",
    },
    workflow_authorize_repair: {
      label: "Authorize the selected repair",
      summary:
        "Authorize the exact selected blocking findings under the displayed repair proposal.",
    },
    workflow_adjudicate_findings: {
      label: "Adjudicate the current blocking findings",
      summary:
        "Record user-authored dispositions for current blockers inconsistent with the approved contract or outside approved scope; this does not authorize repair.",
    },
    workflow_resume_review: {
      label: "Resume review with context",
      summary: "Supply bounded context and resume the current review.",
    },
    workflow_finalize_repair_exhausted: {
      label: "Stop the exhausted repair cycle",
      summary: "Finalize the current bounded repair limit without authorizing more work.",
    },
    workflow_create_linked_followup: {
      label: "Create a directly authored linked follow-up",
      summary: "Authorize a narrow follow-up using the declared user-authored work fields.",
    },
    workflow_create_linked_followup_from_plan: {
      label: "Create a linked follow-up from the approved child plan",
      summary: "Use the exact approved child PlanArtifact bound in this invocation.",
    },
    workflow_authorize_commit: {
      label: "Authorize commit preparation",
      summary: "Give fresh authorization for commit preparation of the currently reviewed change.",
    },
    workflow_retry_commit_preparation: {
      label: "Retry commit preparation",
      summary:
        "Keep the reviewed scope unchanged and retry only after any out-of-scope staged paths are removed; this does not authorize new paths.",
    },
    workflow_reconcile_staged_scope: {
      label: "Reconcile the staged change scope",
      summary:
        "Authorize exactly the newly observed staged paths, then require fresh review and fresh commit authorization.",
    },
    workflow_return_commit_to_review: {
      label: "Return the change to review",
      summary: "Discard stale review and commit authority and obtain a fresh review.",
    },
    workflow_reconcile_commit_result: {
      label: "Reconcile the commit result",
      summary: "Resolve the exact recorded commit attempt from authoritative repository state.",
    },
    workflow_retry_commit: {
      label: "Retry the commit attempt",
      summary: "Retry the exact recorded commit attempt using the supplied bounded context.",
    },
  };
  const choice = choices[action];
  return { id: ids[action], ...choice };
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
