/**
 * Structural workflow action and protocol metadata.
 *
 * This registry is deliberately not a legality table or transition dispatcher. It owns only
 * stable action identity and mechanical protocol linkage. Phase legality, readiness, schemas,
 * stale-state bindings, audit meaning, and mutation-time validation remain in their domain owners.
 */

export type WorkflowActionActor = "parent" | "implementer" | "reviewer" | "committer";
export type WorkflowActionClassification = "parent" | "worker" | "query" | "non_projectable";
export type WorkflowActionServerArgument = "input" | "workflow_id";

export type OperatorInputSource =
  | "user_authored"
  | "parent_context"
  | "server_derived"
  | "observed_evidence";

export interface OperatorRequiredInput {
  path: string[];
  source: OperatorInputSource;
  /**
   * Exact source path in ParentView when source is parent_context. For a repair server_derived
   * input, this is instead relative to the current mutation invocation's descriptor binding.
   */
  source_path?: string[];
  required: true;
}

export interface OperatorInputAlternative {
  paths: string[][];
  source: OperatorInputSource;
  /** Exact source path in ParentView when source is parent_context. */
  source_path?: string[];
  required: true;
}

export type OperatorAuthorizationBinding =
  | { kind: "none" }
  | { kind: "all"; paths: string[][] }
  | { kind: "exclusive_one_of"; common_paths: string[][]; alternatives: string[][] };

export type OperatorAuthorizationMetadata =
  | {
      required: false;
      representation: { kind: "none" };
      binding: { kind: "none" };
    }
  | {
      required: true;
      representation: { kind: "field"; path: string[] };
      binding: Exclude<OperatorAuthorizationBinding, { kind: "none" }>;
    }
  | {
      required: true;
      representation: { kind: "metadata_only" };
      binding: Exclude<OperatorAuthorizationBinding, { kind: "none" }>;
    };

export type OperatorExpectedNext =
  | "implement"
  | "review"
  | "re_review"
  | "commit"
  | "collect_evidence"
  | "accept_concerns"
  | "adopt_dirty_scope"
  | "resume_review"
  | "bounded_continuation"
  | "terminal_committed"
  | "terminal_commit_mismatch"
  | "wait";

interface SemanticChoice {
  id: string;
  label: string;
  summary: string;
}

interface CommonActionDefinition {
  actor: WorkflowActionActor;
  classification: WorkflowActionClassification;
  server: {
    handler: string;
    argument: WorkflowActionServerArgument;
  };
  authorization: OperatorAuthorizationMetadata;
  inputs: OperatorRequiredInput[];
  input_alternatives?: OperatorInputAlternative[];
}

type WorkflowActionDefinition = CommonActionDefinition &
  (
    | { mode: "non_projectable" }
    | { mode: "dispatch" }
    | { mode: "collect_evidence"; semantic_choice: SemanticChoice }
    | {
        mode: "parent_mutation";
        semantic_choice: SemanticChoice;
        expected_after: OperatorExpectedNext[];
      }
  ) & { recovery?: string };

const noAuthorization = (): OperatorAuthorizationMetadata => ({
  required: false,
  representation: { kind: "none" },
  binding: { kind: "none" },
});

type RequiredAuthorizationBinding = Exclude<OperatorAuthorizationBinding, { kind: "none" }>;

const allBinding = (paths: string[][]): RequiredAuthorizationBinding => ({ kind: "all", paths });

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
): OperatorAuthorizationMetadata => ({
  required: true,
  representation: { kind: "metadata_only" },
  binding: allBinding(boundSemanticInputPaths),
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

const inputAlternative = (
  paths: string[][],
  source: OperatorInputSource,
): OperatorInputAlternative => ({ paths, source, required: true });

const defineWorkflowActions = <const Definitions extends Record<string, WorkflowActionDefinition>>(
  definitions: Definitions,
) => definitions;

export const WORKFLOW_ACTION_REGISTRY = defineWorkflowActions({
  workflow_create: {
    actor: "parent",
    classification: "non_projectable",
    server: { handler: "create", argument: "input" },
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_adopt_dirty_scope: {
    actor: "parent",
    classification: "parent",
    server: { handler: "adoptDirtyScope", argument: "input" },
    mode: "parent_mutation",
    recovery: "adopt_dirty_scope",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [["reason"]],
      [["added_paths"], ["adopted_paths"]],
    ),
    inputs: [input(["reason"], "user_authored")],
    input_alternatives: [inputAlternative([["added_paths"], ["adopted_paths"]], "user_authored")],
    semantic_choice: {
      id: "adopt_existing_changes",
      label: "Adopt the selected dirty paths",
      summary: "Add the exact selected existing dirty paths to the current workflow authority.",
    },
    expected_after: ["adopt_dirty_scope", "collect_evidence", "resume_review", "wait"],
  },
  workflow_expand_scope: {
    actor: "parent",
    classification: "parent",
    server: { handler: "expandScope", argument: "input" },
    mode: "parent_mutation",
    authorization: fieldAuthorization(["user_authorization"], [["added_paths"], ["reason"]]),
    inputs: [input(["added_paths"], "user_authored"), input(["reason"], "user_authored")],
    semantic_choice: {
      id: "authorize_more_paths",
      label: "Expand the approved scope",
      summary: "Authorize additional paths for implementation and subsequent review.",
    },
    expected_after: ["implement", "review", "re_review", "wait"],
  },
  workflow_parent_get: {
    actor: "parent",
    classification: "query",
    server: { handler: "parentGet", argument: "workflow_id" },
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_implementer_get: {
    actor: "implementer",
    classification: "query",
    server: { handler: "implementerGet", argument: "workflow_id" },
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_reviewer_get: {
    actor: "reviewer",
    classification: "query",
    server: { handler: "reviewerGet", argument: "workflow_id" },
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_committer_get: {
    actor: "committer",
    classification: "query",
    server: { handler: "committerGet", argument: "workflow_id" },
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_get_audit: {
    actor: "parent",
    classification: "query",
    server: { handler: "audit", argument: "workflow_id" },
    mode: "non_projectable",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_submit_implementation: {
    actor: "implementer",
    classification: "worker",
    server: { handler: "submitImplementation", argument: "input" },
    mode: "dispatch",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_record_manual_validation: {
    actor: "parent",
    classification: "parent",
    server: { handler: "recordManualValidation", argument: "input" },
    mode: "collect_evidence",
    authorization: noAuthorization(),
    inputs: [input(["evidence"], "observed_evidence")],
    semantic_choice: {
      id: "record_observed_validation",
      label: "Record observed validation evidence",
      summary: "Record only evidence from the declared validation inspection.",
    },
  },
  workflow_resume_implementation: {
    actor: "parent",
    classification: "parent",
    server: { handler: "resumeImplementation", argument: "input" },
    mode: "parent_mutation",
    recovery: "resume_implementation",
    authorization: metadataAuthorization([["resume_context"]]),
    inputs: [input(["resume_context"], "user_authored")],
    semantic_choice: {
      id: "continue_implementation",
      label: "Resume implementation with context",
      summary: "Supply bounded context and resume the currently authorized implementation.",
    },
    expected_after: ["implement", "wait"],
  },
  workflow_rebind_implementation_plan: {
    actor: "parent",
    classification: "parent",
    server: { handler: "rebindImplementationPlan", argument: "input" },
    mode: "parent_mutation",
    recovery: "rebind_implementation_plan",
    authorization: fieldAuthorization(["user_authorization"], [["plan_id"], ["revision"]]),
    inputs: [],
    semantic_choice: {
      id: "adopt_approved_plan_revision",
      label: "Rebind to the approved plan revision",
      summary:
        "Replace stale plan authority with the exact current approved revision and resume implementation.",
    },
    expected_after: ["implement", "wait"],
  },
  workflow_accept_concerns: {
    actor: "parent",
    classification: "parent",
    server: { handler: "acceptConcerns", argument: "input" },
    mode: "parent_mutation",
    recovery: "accept_concerns",
    authorization: fieldAuthorization(["user_authorization"], []),
    inputs: [],
    semantic_choice: {
      id: "accept_bounded_concerns",
      label: "Accept the implementation concerns",
      summary: "Accept the current bounded concerns and continue to review.",
    },
    expected_after: ["collect_evidence", "review", "re_review", "wait"],
  },
  workflow_begin_review: {
    actor: "reviewer",
    classification: "worker",
    server: { handler: "beginReview", argument: "input" },
    mode: "dispatch",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_submit_review: {
    actor: "reviewer",
    classification: "worker",
    server: { handler: "submitReview", argument: "input" },
    mode: "dispatch",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_authorize_repair: {
    actor: "parent",
    classification: "parent",
    server: { handler: "authorizeRepair", argument: "input" },
    mode: "parent_mutation",
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
    semantic_choice: {
      id: "authorize_bounded_repair",
      label: "Authorize the selected repair",
      summary:
        "Authorize the exact selected blocking findings under the displayed repair proposal.",
    },
    expected_after: ["implement", "wait"],
  },
  workflow_adjudicate_findings: {
    actor: "parent",
    classification: "parent",
    server: { handler: "adjudicateFindings", argument: "input" },
    mode: "parent_mutation",
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
    semantic_choice: {
      id: "resolve_inconsistent_findings",
      label: "Adjudicate the current blocking findings",
      summary:
        "Record user-authored dispositions for current blockers inconsistent with the approved contract or outside approved scope; this does not authorize repair.",
    },
    expected_after: ["review", "re_review", "wait"],
  },
  workflow_resume_review: {
    actor: "parent",
    classification: "parent",
    server: { handler: "resumeReview", argument: "input" },
    mode: "parent_mutation",
    recovery: "resume_review",
    authorization: metadataAuthorization([["resume_context"]]),
    inputs: [input(["resume_context"], "user_authored")],
    semantic_choice: {
      id: "continue_review",
      label: "Resume review with context",
      summary: "Supply bounded context and resume the current review.",
    },
    expected_after: ["re_review", "wait"],
  },
  workflow_finalize_repair_exhausted: {
    actor: "parent",
    classification: "parent",
    server: { handler: "finalizeRepairExhausted", argument: "input" },
    mode: "parent_mutation",
    authorization: metadataAuthorization([]),
    inputs: [],
    semantic_choice: {
      id: "stop_at_repair_limit",
      label: "Stop the exhausted repair cycle",
      summary: "Finalize the current bounded repair limit without authorizing more work.",
    },
    expected_after: ["bounded_continuation", "wait"],
  },
  workflow_create_linked_followup: {
    actor: "parent",
    classification: "parent",
    server: { handler: "createLinkedFollowup", argument: "input" },
    mode: "parent_mutation",
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
    semantic_choice: {
      id: "start_direct_followup",
      label: "Create a directly authored linked follow-up",
      summary: "Authorize a narrow follow-up using the declared user-authored work fields.",
    },
    expected_after: ["implement", "wait"],
  },
  workflow_create_linked_followup_from_plan: {
    actor: "parent",
    classification: "parent",
    server: { handler: "createLinkedFollowupFromPlan", argument: "input" },
    mode: "parent_mutation",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [["plan_id"], ["revision"], ["finding_ids"]],
    ),
    inputs: [input(["finding_ids"], "server_derived")],
    semantic_choice: {
      id: "start_approved_plan_followup",
      label: "Create a linked follow-up from the approved child plan",
      summary: "Use the exact approved child PlanArtifact bound in this invocation.",
    },
    expected_after: ["implement", "wait"],
  },
  workflow_authorize_commit: {
    actor: "parent",
    classification: "parent",
    server: { handler: "authorizeCommit", argument: "input" },
    mode: "parent_mutation",
    authorization: fieldAuthorization(["user_authorization"], []),
    inputs: [],
    semantic_choice: {
      id: "authorize_commit_preparation",
      label: "Authorize commit preparation",
      summary: "Give fresh authorization for commit preparation of the currently reviewed change.",
    },
    expected_after: ["commit", "wait"],
  },
  workflow_prepare_commit: {
    actor: "committer",
    classification: "worker",
    server: { handler: "prepareCommit", argument: "input" },
    mode: "dispatch",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_submit_commit_result: {
    actor: "committer",
    classification: "worker",
    server: { handler: "submitCommitResult", argument: "input" },
    mode: "dispatch",
    authorization: noAuthorization(),
    inputs: [],
  },
  workflow_reconcile_commit_result: {
    actor: "parent",
    classification: "parent",
    server: { handler: "reconcileCommitResult", argument: "input" },
    mode: "parent_mutation",
    authorization: metadataAuthorization([]),
    inputs: [],
    semantic_choice: {
      id: "resolve_commit_result",
      label: "Reconcile the commit result",
      summary: "Resolve the exact recorded commit attempt from authoritative repository state.",
    },
    expected_after: ["terminal_committed", "terminal_commit_mismatch"],
  },
  workflow_retry_commit_preparation: {
    actor: "parent",
    classification: "parent",
    server: { handler: "retryCommitPreparation", argument: "input" },
    mode: "parent_mutation",
    recovery: "retry_commit_preparation",
    authorization: metadataAuthorization([["retry_context"]]),
    inputs: [input(["retry_context"], "user_authored")],
    semantic_choice: {
      id: "retry_preparation",
      label: "Retry commit preparation",
      summary:
        "Keep the reviewed scope unchanged and retry only after any out-of-scope staged paths are removed; this does not authorize new paths.",
    },
    expected_after: ["commit", "wait"],
  },
  workflow_reconcile_staged_scope: {
    actor: "parent",
    classification: "parent",
    server: { handler: "reconcileStagedScope", argument: "input" },
    mode: "parent_mutation",
    recovery: "reconcile_staged_scope",
    authorization: fieldAuthorization(
      ["user_authorization"],
      [["added_paths"], ["review_context"]],
    ),
    inputs: [input(["added_paths"], "server_derived"), input(["review_context"], "user_authored")],
    semantic_choice: {
      id: "authorize_scope_reconciliation",
      label: "Reconcile the staged change scope",
      summary:
        "Authorize exactly the newly observed staged paths, then require fresh review and fresh commit authorization.",
    },
    expected_after: ["re_review", "wait"],
  },
  workflow_return_commit_to_review: {
    actor: "parent",
    classification: "parent",
    server: { handler: "returnCommitToReview", argument: "input" },
    mode: "parent_mutation",
    recovery: "return_commit_to_review",
    authorization: metadataAuthorization([["review_context"]]),
    inputs: [input(["review_context"], "user_authored")],
    semantic_choice: {
      id: "refresh_review_authority",
      label: "Return the change to review",
      summary: "Discard stale review and commit authority and obtain a fresh review.",
    },
    expected_after: ["re_review", "wait"],
  },
  workflow_retry_commit: {
    actor: "parent",
    classification: "parent",
    server: { handler: "retryCommit", argument: "input" },
    mode: "parent_mutation",
    recovery: "retry_commit",
    authorization: metadataAuthorization([["retry_context"]]),
    inputs: [input(["retry_context"], "user_authored")],
    semantic_choice: {
      id: "retry_commit_attempt",
      label: "Retry the commit attempt",
      summary: "Retry the exact recorded commit attempt using the supplied bounded context.",
    },
    expected_after: ["commit", "wait"],
  },
});

export type WorkflowAction = keyof typeof WORKFLOW_ACTION_REGISTRY;

type KeysWithClassification<Classification extends WorkflowActionClassification> = {
  [Action in WorkflowAction]: (typeof WORKFLOW_ACTION_REGISTRY)[Action]["classification"] extends Classification
    ? Action
    : never;
}[WorkflowAction];

type KeysWithActor<Actor extends WorkflowActionActor> = {
  [Action in WorkflowAction]: (typeof WORKFLOW_ACTION_REGISTRY)[Action]["actor"] extends Actor
    ? Action
    : never;
}[WorkflowAction];

export type OperatorParentMutationOperation = KeysWithClassification<"parent">;
export type OperatorWorkerDispatchOperation = KeysWithClassification<"worker">;
export type WorkflowQueryOperation = KeysWithClassification<"query">;
export type WorkflowNonProjectableOperation = KeysWithClassification<"non_projectable">;
export type ParentWorkflowAction = KeysWithActor<"parent">;

export type OperatorRecovery = {
  [Action in WorkflowAction]: (typeof WORKFLOW_ACTION_REGISTRY)[Action] extends {
    recovery: infer Recovery extends string;
  }
    ? Recovery
    : never;
}[WorkflowAction];

export type RecoveryWorkflowAction = {
  [Action in WorkflowAction]: (typeof WORKFLOW_ACTION_REGISTRY)[Action] extends {
    recovery: string;
  }
    ? Action
    : never;
}[WorkflowAction];

export type OperatorActionDescriptorMetadata =
  | {
      classification: "query" | "non_projectable";
      mode: "non_projectable";
      authorization: OperatorAuthorizationMetadata;
      inputs: OperatorRequiredInput[];
      input_alternatives?: OperatorInputAlternative[];
    }
  | {
      classification: "worker";
      mode: "dispatch";
      operation: OperatorWorkerDispatchOperation;
      authorization: OperatorAuthorizationMetadata;
      inputs: OperatorRequiredInput[];
      input_alternatives?: OperatorInputAlternative[];
    }
  | {
      classification: "parent";
      mode: "parent_mutation" | "collect_evidence";
      operation: OperatorParentMutationOperation;
      authorization: OperatorAuthorizationMetadata;
      inputs: OperatorRequiredInput[];
      input_alternatives?: OperatorInputAlternative[];
    };

export const WORKFLOW_ACTION_VALUES = Object.freeze(
  Object.keys(WORKFLOW_ACTION_REGISTRY) as WorkflowAction[],
);

export const PARENT_WORKFLOW_ACTION_VALUES = Object.freeze(
  WORKFLOW_ACTION_VALUES.filter(
    (action): action is ParentWorkflowAction => WORKFLOW_ACTION_REGISTRY[action].actor === "parent",
  ),
);

export const WORKFLOW_ACTION_VALUES_BY_ACTOR = Object.freeze({
  parent: PARENT_WORKFLOW_ACTION_VALUES,
  implementer: Object.freeze(
    WORKFLOW_ACTION_VALUES.filter(
      (action): action is KeysWithActor<"implementer"> =>
        WORKFLOW_ACTION_REGISTRY[action].actor === "implementer",
    ),
  ),
  reviewer: Object.freeze(
    WORKFLOW_ACTION_VALUES.filter(
      (action): action is KeysWithActor<"reviewer"> =>
        WORKFLOW_ACTION_REGISTRY[action].actor === "reviewer",
    ),
  ),
  committer: Object.freeze(
    WORKFLOW_ACTION_VALUES.filter(
      (action): action is KeysWithActor<"committer"> =>
        WORKFLOW_ACTION_REGISTRY[action].actor === "committer",
    ),
  ),
});

export const RECOVERY_WORKFLOW_ACTION_VALUES = Object.freeze(
  WORKFLOW_ACTION_VALUES.filter(
    (action): action is RecoveryWorkflowAction => "recovery" in WORKFLOW_ACTION_REGISTRY[action],
  ),
);

export const ACTION_DESCRIPTOR_METADATA = Object.fromEntries(
  WORKFLOW_ACTION_VALUES.map((action) => {
    const definition = WORKFLOW_ACTION_REGISTRY[action];
    return [
      action,
      {
        classification: definition.classification,
        mode: definition.mode,
        ...(definition.mode === "non_projectable" ? {} : { operation: action }),
        authorization: definition.authorization,
        inputs: definition.inputs,
        ...("input_alternatives" in definition && definition.input_alternatives
          ? { input_alternatives: definition.input_alternatives }
          : {}),
      },
    ];
  }),
) as unknown as Record<WorkflowAction, OperatorActionDescriptorMetadata>;

export function recoveryForAction(action: WorkflowAction): OperatorRecovery | null {
  const definition = WORKFLOW_ACTION_REGISTRY[action];
  return "recovery" in definition ? (definition.recovery as OperatorRecovery) : null;
}

export function isRecoveryWorkflowAction(action: WorkflowAction): action is RecoveryWorkflowAction {
  return recoveryForAction(action) !== null;
}
