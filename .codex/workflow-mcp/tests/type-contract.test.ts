import { test } from "bun:test";
import assert from "node:assert/strict";
import { SERVER_TOOL_NAMES, type ServerToolName, toolDefinitions } from "../server.js";
import type {
  RawCommitResultMutation,
  RawImplementationSubmissionMutation,
  RawManualValidationMutation,
  RawParentMutation,
  RawReviewSubmissionMutation,
  RawWorkerMutation,
} from "../store.js";
import {
  ensurePhase,
  type REVIEWER_IMPLEMENTER_HANDOFF,
  type ROLE_VIEW_COMMON,
  type ROLE_VIEW_EXTRA,
  type V8_STATE_KEYS,
} from "../transitions.js";
import type {
  AcceptanceCriterion,
  AcceptanceCriterionId,
  AcceptanceResult,
  CommitAttemptId,
  CommitSubmissionOutcome,
  CommitterView,
  ExactRepoPath,
  ImplementationStatus,
  ImplementerHandoffView,
  ImplementerView,
  ParentView,
  PlanAuthoringContent,
  PlannerPlanRead,
  PlanRead,
  PlanRevisionReplacements,
  ReviewerViewBase,
  ReviewRangePath,
  ReviewStatus,
  Role,
  RoleViewCommon,
  ValidationRequirement,
  ValidationRequirementId,
  ValidationResult,
  WorkflowAction,
  WorkflowId,
  WorkflowPhase,
  WorkflowState,
  WorkflowVersion,
} from "../types.js";
import {
  ACCEPTANCE_STATUS_VALUES,
  GIT_FILE_MODE_VALUES,
  ROLE_VALUES,
  WORKFLOW_PHASE_VALUES,
} from "../values.js";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type InternalReceiptField =
  | "initial_receipt"
  | "review_start_receipt"
  | "implementation_receipt"
  | "review_receipt";
type VisibleKeys<Keys extends readonly PropertyKey[]> = Exclude<Keys[number], InternalReceiptField>;
type ExactKeys<Actual extends PropertyKey, Expected extends PropertyKey> = [
  Exclude<Actual, Expected>,
  Exclude<Expected, Actual>,
] extends [never, never]
  ? true
  : false;
type NoDuplicates<
  Keys extends readonly PropertyKey[],
  Seen extends PropertyKey = never,
> = Keys extends readonly [infer Head extends PropertyKey, ...infer Tail extends PropertyKey[]]
  ? Head extends Seen
    ? false
    : NoDuplicates<Tail, Seen | Head>
  : true;

type PlannerContentKeys =
  | "full_plan"
  | "execution_brief"
  | "objective"
  | "approved_paths"
  | "acceptance_criteria"
  | "validation_requirements";

const _canonicalValues = [
  ROLE_VALUES,
  WORKFLOW_PHASE_VALUES,
  ACCEPTANCE_STATUS_VALUES,
  GIT_FILE_MODE_VALUES,
] as const;
void _canonicalValues;

function _compilePhaseNarrowing(): void {
  const state = undefined as unknown as WorkflowState;
  ensurePhase(state, "IMPLEMENTING");
  const narrowedPhase: "IMPLEMENTING" = state.phase;
  void narrowedPhase;
}

const added: ReviewRangePath = {
  path: "new.txt" as never,
  kind: "added",
  base: null,
  head: { mode: "100644", object: "a".repeat(40) as never },
};
const deleted: ReviewRangePath = {
  path: "old.txt" as never,
  kind: "deleted",
  base: { mode: "100644", object: "a".repeat(40) as never },
  head: null,
};
void added;
void deleted;
// @ts-expect-error added paths must have a head entry
const impossibleAdded: ReviewRangePath = {
  path: "bad.txt" as never,
  kind: "added",
  base: null,
  head: null,
};
void impossibleAdded;
// @ts-expect-error deleted paths must have a base entry
const impossibleDeleted: ReviewRangePath = {
  path: "bad.txt" as never,
  kind: "deleted",
  base: null,
  head: null,
};
void impossibleDeleted;

function _compileBrandedCorrelation(): void {
  const criterion = undefined as unknown as AcceptanceCriterion;
  const criterionResult = undefined as unknown as AcceptanceResult;
  const validation = undefined as unknown as ValidationRequirement;
  const validationResult = undefined as unknown as ValidationResult;
  const criterionId: typeof criterion.criterion_id = criterionResult.criterion_id;
  const validationId: typeof validation.validation_id = validationResult.validation_id;
  void criterionId;
  void validationId;
  // @ts-expect-error acceptance criterion IDs cannot be consumed as validation requirement IDs
  const invalidValidationId: ValidationRequirementId = criterionId;
  // @ts-expect-error validation requirement IDs cannot be consumed as acceptance criterion IDs
  const invalidCriterionId: AcceptanceCriterionId = validationId;
  void invalidValidationId;
  void invalidCriterionId;

  const parentMutation = undefined as unknown as RawParentMutation;
  const workerMutation = undefined as unknown as RawWorkerMutation;
  // @ts-expect-error raw workflow IDs require authoritative validation and branding
  const unvalidatedWorkflowId: WorkflowId = parentMutation.workflow_id;
  // @ts-expect-error raw workflow versions require authoritative validation and branding
  const unvalidatedWorkflowVersion: WorkflowVersion = parentMutation.expected_version;
  void unvalidatedWorkflowId;
  void unvalidatedWorkflowVersion;
  // @ts-expect-error worker mutations intentionally carry no parent capability
  workerMutation.capability;

  const implementation = undefined as unknown as RawImplementationSubmissionMutation;
  const manualValidation = undefined as unknown as RawManualValidationMutation;
  const review = undefined as unknown as RawReviewSubmissionMutation;
  const commit = undefined as unknown as RawCommitResultMutation;
  // @ts-expect-error raw implementation status is not a validated finite-domain value
  const implementationStatus: ImplementationStatus = implementation.status;
  // @ts-expect-error raw review status is not a validated finite-domain value
  const reviewStatus: ReviewStatus = review.review_status;
  // @ts-expect-error raw commit outcome is not a validated finite-domain value
  const commitOutcome: CommitSubmissionOutcome = commit.outcome;
  // @ts-expect-error raw commit attempt IDs are not branded
  const commitAttemptId: CommitAttemptId = commit.attempt_id;
  // @ts-expect-error raw paths are not validated repository paths
  const touchedPaths: ExactRepoPath[] = implementation.agent_touched_paths;
  // @ts-expect-error raw acceptance evidence is not a typed result array
  const acceptanceResults: AcceptanceResult[] = implementation.acceptance_results;
  // @ts-expect-error raw validation evidence is not a typed result array
  const validationResults: ValidationResult[] = implementation.validation_results;
  // @ts-expect-error raw reviewer validation evidence is not a typed result array
  const reviewValidationResults: ValidationResult[] = review.validation_results;
  // @ts-expect-error raw manual validation status requires transition validation
  const manualStatus: "passed" | "failed" = manualValidation.status;
  // @ts-expect-error raw manual validation IDs require transition validation and branding
  const manualId: ValidationRequirementId = manualValidation.validation_id;
  void implementationStatus;
  void reviewStatus;
  void commitOutcome;
  void commitAttemptId;
  void touchedPaths;
  void acceptanceResults;
  void validationResults;
  void reviewValidationResults;
  void manualStatus;
  void manualId;
}

function _compileDirectParentView(): void {
  const parent = undefined as unknown as ParentView;
  const workflowId: WorkflowId | null = parent.workflow_id;
  void workflowId;
  // @ts-expect-error Parent views no longer expose the obsolete compatibility wrapper
  parent.workflow;
}

function _compilePlannerAuthoringView(): void {
  const planner = undefined as unknown as PlannerPlanRead;
  const replacements: PlanRevisionReplacements = {
    full_plan: planner.full_plan,
    execution_brief: planner.execution_brief,
    objective: planner.objective,
    approved_paths: planner.approved_paths,
    acceptance_criteria: planner.acceptance_criteria,
    validation_requirements: planner.validation_requirements,
  };
  void replacements;
  // Planner content intentionally has no persisted contract IDs.
  // @ts-expect-error planner acceptance criteria are authoring strings, not persisted records
  const persistedAcceptance = planner.acceptance_criteria[0].criterion_id;
  // @ts-expect-error planner validation requirements are authoring entries, not persisted records
  const persistedValidation = planner.validation_requirements[0].validation_id;
  void persistedAcceptance;
  void persistedValidation;
}

type _StateKeysAreExhaustive = Expect<Equal<(typeof V8_STATE_KEYS)[number], keyof WorkflowState>>;
type _RoleValuesAreCanonical = Expect<Equal<Role, (typeof ROLE_VALUES)[number]>>;
type _PhaseValuesAreCanonical = Expect<
  Equal<WorkflowPhase, (typeof WORKFLOW_PHASE_VALUES)[number]>
>;
type _CommonKeysAreExhaustive = Expect<
  Equal<(typeof ROLE_VIEW_COMMON)[number], keyof RoleViewCommon>
>;
type _ImplementerExtraKeysAreExhaustive = Expect<
  ExactKeys<
    VisibleKeys<(typeof ROLE_VIEW_EXTRA)["implementer"]>,
    Exclude<keyof ImplementerView, keyof RoleViewCommon>
  >
>;
type _ReviewerExtraKeysAreExhaustive = Expect<
  ExactKeys<
    VisibleKeys<(typeof ROLE_VIEW_EXTRA)["reviewer"]>,
    Exclude<keyof ReviewerViewBase, keyof RoleViewCommon> | keyof ImplementerHandoffView
  >
>;
type _CommitterExtraKeysAreExhaustive = Expect<
  ExactKeys<
    VisibleKeys<(typeof ROLE_VIEW_EXTRA)["committer"]>,
    Exclude<keyof CommitterView, keyof RoleViewCommon>
  >
>;
type _ReviewerHandoffKeysAreExhaustive = Expect<
  ExactKeys<VisibleKeys<typeof REVIEWER_IMPLEMENTER_HANDOFF>, keyof ImplementerHandoffView>
>;
type _RoleRegistriesHaveNoDuplicates = Expect<
  NoDuplicates<(typeof ROLE_VIEW_EXTRA)["implementer"]>
>;
type _ReviewerRegistryHasNoDuplicates = Expect<NoDuplicates<(typeof ROLE_VIEW_EXTRA)["reviewer"]>>;
type _CommitterRegistryHasNoDuplicates = Expect<
  NoDuplicates<(typeof ROLE_VIEW_EXTRA)["committer"]>
>;
type _HandoffRegistryHasNoDuplicates = Expect<NoDuplicates<typeof REVIEWER_IMPLEMENTER_HANDOFF>>;
type _PlannerContentIsCanonicalWriteShape = Expect<
  Equal<PlanAuthoringContent, Required<PlanRevisionReplacements>>
>;
type _PlannerContentKeysAreComplete = Expect<Equal<keyof PlanAuthoringContent, PlannerContentKeys>>;
type _PlannerEnvelopeKeysAreBounded = Expect<
  Equal<
    keyof PlannerPlanRead,
    PlannerContentKeys | "plan_id" | "revision" | "artifact_digest" | "created_at" | "metadata"
  >
>;
type _ParentPlanReadRetainsPersistedShape = Expect<
  Equal<PlanRead["acceptance_criteria"][number], AcceptanceCriterion>
>;
type _PlanningNamesAreNotActions = Expect<
  Equal<Exclude<ServerToolName, WorkflowAction> extends never ? true : false, false>
>;
type _WorkflowActionsAreClosed = Expect<Equal<Exclude<WorkflowAction, ServerToolName>, never>>;

test("canonical values and closed protocol registries are runtime-observable", () => {
  assert.equal(new Set(SERVER_TOOL_NAMES).size, SERVER_TOOL_NAMES.length);
  assert.equal(new Set(toolDefinitions.map((tool) => tool.name)).size, toolDefinitions.length);
  assert.deepEqual(new Set(toolDefinitions.map((tool) => tool.name)), new Set(SERVER_TOOL_NAMES));
});
