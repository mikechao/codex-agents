import { test } from "bun:test";
import assert from "node:assert/strict";
import { SERVER_TOOL_NAMES, type ServerToolName, toolDefinitions } from "../server.js";
import type {
  ParentMutation as StoreParentMutation,
  WorkerMutation as StoreWorkerMutation,
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
  AcceptanceResult,
  CommitterView,
  ImplementerHandoffView,
  ImplementerView,
  ReviewerViewBase,
  ReviewRangePath,
  Role,
  RoleViewCommon,
  ValidationRequirement,
  ValidationResult,
  WorkflowAction,
  WorkflowPhase,
  WorkflowState,
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

  const parentMutation = undefined as unknown as StoreParentMutation;
  const workerMutation = undefined as unknown as StoreWorkerMutation;
  const parentCapability: string = parentMutation.capability;
  void parentCapability;
  // @ts-expect-error worker mutations intentionally carry no parent capability
  workerMutation.capability;
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
type _PlanningNamesAreNotActions = Expect<
  Equal<Exclude<ServerToolName, WorkflowAction> extends never ? true : false, false>
>;
type _WorkflowActionsAreClosed = Expect<Equal<Exclude<WorkflowAction, ServerToolName>, never>>;

test("canonical values and closed protocol registries are runtime-observable", () => {
  assert.equal(new Set(SERVER_TOOL_NAMES).size, SERVER_TOOL_NAMES.length);
  assert.equal(new Set(toolDefinitions.map((tool) => tool.name)).size, toolDefinitions.length);
  assert.deepEqual(new Set(toolDefinitions.map((tool) => tool.name)), new Set(SERVER_TOOL_NAMES));
});
