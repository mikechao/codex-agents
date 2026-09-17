import { test } from "bun:test";
import assert from "node:assert/strict";
import { WORKFLOW_ACTION_STORE_ADAPTERS } from "../server.js";
import type { WorkflowStore } from "../store.js";
import type { WorkflowAction } from "../workflow-action-registry.js";
import {
  ACTION_DESCRIPTOR_METADATA,
  PARENT_WORKFLOW_ACTION_VALUES,
  recoveryForAction,
  WORKFLOW_ACTION_REGISTRY,
  WORKFLOW_ACTION_VALUES,
  WORKFLOW_ACTION_VALUES_BY_ACTOR,
} from "../workflow-action-registry.js";

type OneArgumentWorkflowStoreHandler = {
  [Handler in keyof WorkflowStore]: WorkflowStore[Handler] extends (
    ...arguments_: infer Arguments
  ) => unknown
    ? Arguments extends [unknown]
      ? Handler
      : never
    : never;
}[keyof WorkflowStore];

const EXPECTED_WORKFLOW_ACTION_STORE_LINKAGE = {
  workflow_create: { handler: "create", argument: "input" },
  workflow_adopt_dirty_scope: { handler: "adoptDirtyScope", argument: "input" },
  workflow_expand_scope: { handler: "expandScope", argument: "input" },
  workflow_parent_get: { handler: "parentGet", argument: "workflow_id" },
  workflow_implementer_get: { handler: "implementerGet", argument: "workflow_id" },
  workflow_reviewer_get: { handler: "reviewerGet", argument: "workflow_id" },
  workflow_committer_get: { handler: "committerGet", argument: "workflow_id" },
  workflow_get_audit: { handler: "audit", argument: "workflow_id" },
  workflow_submit_implementation: { handler: "submitImplementation", argument: "input" },
  workflow_record_manual_validation: { handler: "recordManualValidation", argument: "input" },
  workflow_resume_implementation: { handler: "resumeImplementation", argument: "input" },
  workflow_rebind_implementation_plan: {
    handler: "rebindImplementationPlan",
    argument: "input",
  },
  workflow_accept_concerns: { handler: "acceptConcerns", argument: "input" },
  workflow_begin_review: { handler: "beginReview", argument: "input" },
  workflow_submit_review: { handler: "submitReview", argument: "input" },
  workflow_authorize_repair: { handler: "authorizeRepair", argument: "input" },
  workflow_adjudicate_findings: { handler: "adjudicateFindings", argument: "input" },
  workflow_resume_review: { handler: "resumeReview", argument: "input" },
  workflow_finalize_repair_exhausted: {
    handler: "finalizeRepairExhausted",
    argument: "input",
  },
  workflow_create_linked_followup: { handler: "createLinkedFollowup", argument: "input" },
  workflow_create_linked_followup_from_plan: {
    handler: "createLinkedFollowupFromPlan",
    argument: "input",
  },
  workflow_authorize_commit: { handler: "authorizeCommit", argument: "input" },
  workflow_prepare_commit: { handler: "prepareCommit", argument: "input" },
  workflow_submit_commit_result: { handler: "submitCommitResult", argument: "input" },
  workflow_reconcile_commit_result: { handler: "reconcileCommitResult", argument: "input" },
  workflow_retry_commit_preparation: {
    handler: "retryCommitPreparation",
    argument: "input",
  },
  workflow_reconcile_staged_scope: { handler: "reconcileStagedScope", argument: "input" },
  workflow_return_commit_to_review: { handler: "returnCommitToReview", argument: "input" },
  workflow_retry_commit: { handler: "retryCommit", argument: "input" },
} as const satisfies Record<
  WorkflowAction,
  { handler: OneArgumentWorkflowStoreHandler; argument: "input" | "workflow_id" }
>;

test("workflow actions have one ordered structural source of truth", () => {
  assert.deepEqual(Object.keys(WORKFLOW_ACTION_REGISTRY), [...WORKFLOW_ACTION_VALUES]);
  assert.equal(new Set(WORKFLOW_ACTION_VALUES).size, WORKFLOW_ACTION_VALUES.length);
  assert.deepEqual(Object.keys(ACTION_DESCRIPTOR_METADATA), [...WORKFLOW_ACTION_VALUES]);

  const byActor = Object.values(WORKFLOW_ACTION_VALUES_BY_ACTOR).flat();
  assert.deepEqual([...byActor].sort(), [...WORKFLOW_ACTION_VALUES].sort());
  assert.equal(new Set(byActor).size, WORKFLOW_ACTION_VALUES.length);
  assert.deepEqual(WORKFLOW_ACTION_VALUES_BY_ACTOR.parent, PARENT_WORKFLOW_ACTION_VALUES);
});

test("every action has the exact store handler and argument-mode adapter", () => {
  assert.deepEqual(
    Object.fromEntries(
      WORKFLOW_ACTION_VALUES.map((action) => [action, WORKFLOW_ACTION_REGISTRY[action].server]),
    ),
    EXPECTED_WORKFLOW_ACTION_STORE_LINKAGE,
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(WORKFLOW_ACTION_STORE_ADAPTERS).map(([action, adapter]) => [
        action,
        adapter.action,
      ]),
    ),
    Object.fromEntries(WORKFLOW_ACTION_VALUES.map((action) => [action, action])),
  );
});

test("durable classification, descriptor mode, and actor ownership remain coherent", () => {
  for (const [action, definition] of Object.entries(WORKFLOW_ACTION_REGISTRY)) {
    if (definition.classification === "parent") {
      assert.equal(definition.actor, "parent", action);
      assert.ok(
        definition.mode === "parent_mutation" || definition.mode === "collect_evidence",
        action,
      );
    } else if (definition.classification === "worker") {
      assert.notEqual(definition.actor, "parent", action);
      assert.equal(definition.mode, "dispatch", action);
    } else if (definition.classification === "query") {
      assert.equal(definition.mode, "non_projectable", action);
      assert.equal(definition.server.argument, "workflow_id", action);
    } else {
      assert.equal(action, "workflow_create");
      assert.equal(definition.actor, "parent");
      assert.equal(definition.mode, "non_projectable");
    }

    for (const forbidden of ["phase", "legality", "readiness", "audit_event", "schema"]) {
      assert.equal(Object.hasOwn(definition, forbidden), false, `${action} owns ${forbidden}`);
    }
  }
});

test("representative ordinary and plan-rebind actions separate structure from policy", () => {
  const expansion = WORKFLOW_ACTION_REGISTRY.workflow_expand_scope;
  assert.deepEqual(
    {
      actor: expansion.actor,
      classification: expansion.classification,
      mode: expansion.mode,
      server: expansion.server,
      recovery: recoveryForAction("workflow_expand_scope"),
      expected_after: expansion.expected_after,
    },
    {
      actor: "parent",
      classification: "parent",
      mode: "parent_mutation",
      server: { handler: "expandScope", argument: "input" },
      recovery: null,
      expected_after: ["implement", "review", "re_review", "wait"],
    },
  );

  const rebind = WORKFLOW_ACTION_REGISTRY.workflow_rebind_implementation_plan;
  assert.deepEqual(
    {
      actor: rebind.actor,
      classification: rebind.classification,
      mode: rebind.mode,
      server: rebind.server,
      recovery: recoveryForAction("workflow_rebind_implementation_plan"),
      expected_after: rebind.expected_after,
    },
    {
      actor: "parent",
      classification: "parent",
      mode: "parent_mutation",
      server: { handler: "rebindImplementationPlan", argument: "input" },
      recovery: "rebind_implementation_plan",
      expected_after: ["implement", "wait"],
    },
  );
});
