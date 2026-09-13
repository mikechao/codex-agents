import { pendingInspectionValidations, type WorkflowLegality } from "./transitions/queries.js";
import type {
  OperatorActionDescriptorMetadata,
  OperatorAuthorizationBinding,
  OperatorAuthorizationMetadata,
  OperatorBindingReference,
  OperatorExecutionDescriptor,
  OperatorExpectedNext,
  OperatorInputAlternative,
  OperatorInputSource,
  OperatorMutationInvocation,
  OperatorNextActionDescriptor,
  OperatorParentActionDescriptor,
  OperatorParentMutationOperation,
  OperatorRequiredInput,
  OperatorStaleBinding,
  OperatorWorkerDispatchOperation,
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

const input = (path: string[], source: OperatorInputSource): OperatorRequiredInput => ({
  path,
  source,
  required: true,
});

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
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
    operation: "workflow_adopt_dirty_scope",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [["reason"]],
      [["added_paths"], ["adopted_paths"]],
    ),
    inputs: [input(["reason"], "parent_context")],
    input_alternatives: [inputAlternative([["added_paths"], ["adopted_paths"]], "user")],
  },
  workflow_expand_scope: {
    classification: "descriptorized_in_142",
    mode: "parent_mutation",
    operation: "workflow_expand_scope",
    authorization: fieldAuthorization(["user_authorization"], [["added_paths"], ["reason"]]),
    inputs: [input(["added_paths"], "user"), input(["reason"], "parent_context")],
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
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
    operation: "workflow_record_manual_validation",
    authorization: metadataAuthorization([["validation_id"], ["status"], ["evidence"]]),
    inputs: [
      input(["validation_id"], "server_derived"),
      input(["status"], "parent_context"),
      input(["evidence"], "parent_context"),
    ],
  },
  workflow_resume_implementation: {
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
    operation: "workflow_resume_implementation",
    authorization: metadataAuthorization([["resume_context"]]),
    inputs: [input(["resume_context"], "parent_context")],
  },
  workflow_accept_concerns: {
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
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
    classification: "deferred_to_144",
    mode: "deferred",
    deferred_to: "repair",
    operation: "workflow_authorize_repair",
    authorization: fieldAuthorization(
      ["repair_directive", "user_authorization"],
      [
        ["finding_ids"],
        ["repair_directive", "required_outcome"],
        ["repair_directive", "strategy_constraints"],
        ["repair_directive", "fallbacks"],
        ["repair_directive", "required_paths"],
        ["repair_directive", "forbidden_paths"],
      ],
    ),
    inputs: [
      input(["finding_ids"], "server_derived"),
      input(["repair_directive", "required_outcome"], "parent_context"),
      input(["repair_directive", "strategy_constraints"], "parent_context"),
      input(["repair_directive", "fallbacks"], "parent_context"),
      input(["repair_directive", "required_paths"], "parent_context"),
      input(["repair_directive", "forbidden_paths"], "parent_context"),
    ],
  },
  workflow_adjudicate_findings: {
    classification: "deferred_to_144",
    mode: "deferred",
    deferred_to: "repair",
    operation: "workflow_adjudicate_findings",
    authorization: fieldAuthorization(["user_authorization"], [["findings"]]),
    inputs: [input(["findings"], "parent_context")],
  },
  workflow_resume_review: {
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
    operation: "workflow_resume_review",
    authorization: metadataAuthorization([["resume_context"]]),
    inputs: [input(["resume_context"], "parent_context")],
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
        ["approved_plan"],
        ["approved_paths"],
        ["acceptance_criteria"],
        ["validation_requirements"],
        ["finding_ids"],
      ],
    ),
    inputs: [
      input(["objective"], "user"),
      input(["approved_plan"], "parent_context"),
      input(["approved_paths"], "user"),
      input(["acceptance_criteria"], "user"),
      input(["validation_requirements"], "user"),
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
    inputs: [
      input(["plan_id"], "parent_context"),
      input(["revision"], "parent_context"),
      input(["finding_ids"], "server_derived"),
    ],
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
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
    operation: "workflow_retry_commit_preparation",
    authorization: metadataAuthorization([["retry_context"]]),
    inputs: [input(["retry_context"], "parent_context")],
  },
  workflow_return_commit_to_review: {
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
    operation: "workflow_return_commit_to_review",
    authorization: metadataAuthorization([["review_context"]]),
    inputs: [input(["review_context"], "parent_context")],
  },
  workflow_retry_commit: {
    classification: "deferred_to_143",
    mode: "deferred",
    deferred_to: "recovery_inspection",
    operation: "workflow_retry_commit",
    authorization: metadataAuthorization([["retry_context"]]),
    inputs: [input(["retry_context"], "parent_context")],
  },
} as const satisfies Record<WorkflowAction, DescriptorActionMetadata>;

function identity(
  state: WorkflowState,
): { workflow_id: WorkflowId; version: WorkflowVersion } | null {
  if (!state.workflow_id) return null;
  return { workflow_id: state.workflow_id, version: state.version };
}

function referencesFor(state: WorkflowState, action: WorkflowAction): OperatorBindingReference[] {
  const references: OperatorBindingReference[] = [];
  if (state.review_result_version !== null) {
    references.push({ kind: "review_result", version: state.review_result_version });
  }
  if (
    action === "workflow_expand_scope" ||
    action === "workflow_create_linked_followup" ||
    action === "workflow_create_linked_followup_from_plan"
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
  if (action === "workflow_reconcile_commit_result" && state.commit_preparation) {
    references.push({
      kind: "commit_attempt",
      attempt_id: state.commit_preparation.attempt_id,
    });
  }
  return references;
}

function staleBinding(state: WorkflowState, action: WorkflowAction): OperatorStaleBinding {
  const current = identity(state);
  if (!current) throw new Error("descriptor requires a persisted workflow identity");
  return {
    workflow_id: current.workflow_id,
    expected_version: state.version,
    references: referencesFor(state, action),
  };
}

function fixedArguments(
  state: WorkflowState,
  action: WorkflowAction,
): Record<string, string | number> {
  const current = identity(state);
  if (!current) throw new Error("descriptor requires a persisted workflow identity");
  const fixed: Record<string, string | number> = {
    workflow_id: current.workflow_id,
    expected_version: current.version,
  };
  if (action === "workflow_reconcile_commit_result" && state.commit_preparation) {
    fixed.attempt_id = state.commit_preparation.attempt_id;
  }
  return fixed;
}

function expectedAfter(action: OperatorParentMutationOperation): OperatorExpectedNext[] {
  switch (action) {
    case "workflow_expand_scope":
      return ["implement", "review", "re_review", "wait"];
    case "workflow_finalize_repair_exhausted":
      return ["bounded_continuation", "wait"];
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
): OperatorMutationInvocation {
  const metadata = ACTION_DESCRIPTOR_METADATA[action];
  if (metadata.mode !== "parent_mutation")
    throw new Error(`action ${action} is not descriptorized as a parent mutation`);
  return {
    operation: action,
    fixed_arguments: fixedArguments(state, action),
    required_inputs: metadata.inputs.map((requiredInput) => ({
      path: [...requiredInput.path],
      source: requiredInput.source,
      required: true,
    })),
    authorization: metadata.authorization,
    stale_binding: staleBinding(state, action),
    on_success: {
      kind: "refresh_required",
      expected: expectedAfter(action),
      dispatch_authority: false,
    },
  };
}

function deferredDescriptor(
  action: WorkflowAction,
): Extract<OperatorNextActionDescriptor, { mode: "wait" }> {
  const metadata = ACTION_DESCRIPTOR_METADATA[action];
  if (metadata.mode !== "deferred") throw new Error(`action ${action} is not deferred`);
  return {
    mode: "wait",
    reason: `${action} is deferred to the ${metadata.deferred_to} descriptor specialization`,
    deferred_to: metadata.deferred_to,
  };
}

function parentActionDescriptor(action: WorkflowAction): OperatorParentActionDescriptor {
  const metadata = ACTION_DESCRIPTOR_METADATA[action];
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
  if (metadata.mode === "deferred") {
    return { action, status: "deferred", descriptor: deferredDescriptor(action) };
  }
  throw new Error(`parent action ${action} has no parent descriptor treatment`);
}

function completeParentInvocation(
  state: WorkflowState,
  descriptor: OperatorParentActionDescriptor,
): OperatorParentActionDescriptor {
  if (descriptor.status !== "executable") return descriptor;
  const action = descriptor.action as OperatorParentMutationOperation;
  return {
    ...descriptor,
    descriptor: {
      ...descriptor.descriptor,
      invocations: [invocation(state, action)],
    },
  };
}

function primaryDescriptor(
  state: WorkflowState,
  legality: WorkflowLegality,
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
      return {
        mode: "collect_evidence",
        validation_ids: pendingInspectionValidations(state).map(
          (requirement) => requirement.validation_id,
        ),
        specialization: "recovery_inspection",
      };
    case "repair_required":
      return deferredDescriptor("workflow_authorize_repair");
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
          invocation(state, "workflow_create_linked_followup_from_plan"),
        ],
      };
    case "recovery":
      return deferredDescriptor(legality.next.action);
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
): OperatorExecutionDescriptor {
  const parentActions = legality.actions.parent.map((action) =>
    completeParentInvocation(state, parentActionDescriptor(action)),
  );
  return {
    descriptor_version: 1,
    primary: primaryDescriptor(state, legality),
    parent_actions: parentActions,
  };
}
