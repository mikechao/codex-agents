import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  DISPATCH_TOOL_NAMES,
  PARENT_PLANNING_OPERATIONS,
  PLANNER_PLANNING_OPERATIONS,
  protocolInstructions,
  SERVER_TOOL_NAMES,
  tools,
} from "../server.js";

test("protocol tool contract exposes the workflow actions with stable annotations", () => {
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [...SERVER_TOOL_NAMES].sort());
  assert.deepEqual([...DISPATCH_TOOL_NAMES].sort(), names);
  assert.deepEqual(names, [
    "plan_approve",
    "plan_create",
    "plan_get",
    "plan_parent_get",
    "plan_revise",
    "workflow_accept_concerns",
    "workflow_adjudicate_findings",
    "workflow_adopt_dirty_scope",
    "workflow_authorize_commit",
    "workflow_authorize_repair",
    "workflow_begin_review",
    "workflow_committer_get",
    "workflow_create",
    "workflow_create_from_plan",
    "workflow_create_linked_followup",
    "workflow_create_linked_followup_from_plan",
    "workflow_expand_scope",
    "workflow_finalize_repair_exhausted",
    "workflow_get_audit",
    "workflow_implementer_get",
    "workflow_operator_decision_get",
    "workflow_parent_get",
    "workflow_prepare_commit",
    "workflow_reconcile_commit_result",
    "workflow_record_manual_validation",
    "workflow_resume_implementation",
    "workflow_resume_review",
    "workflow_retry_commit",
    "workflow_retry_commit_preparation",
    "workflow_return_commit_to_review",
    "workflow_reviewer_get",
    "workflow_submit_commit_result",
    "workflow_submit_implementation",
    "workflow_submit_review",
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(
      tool.annotations?.readOnlyHint,
      tool.name.endsWith("_get") || tool.name === "workflow_get_audit",
    );
  }
  const implementation = tools.find((tool) => tool.name === "workflow_submit_implementation");
  const review = tools.find((tool) => tool.name === "workflow_submit_review");
  const begin = tools.find((tool) => tool.name === "workflow_begin_review");
  const expansion = tools.find((tool) => tool.name === "workflow_expand_scope");
  const adoption = tools.find((tool) => tool.name === "workflow_adopt_dirty_scope");
  const reconciliation = tools.find((tool) => tool.name === "workflow_reconcile_commit_result");
  const adjudication = tools.find((tool) => tool.name === "workflow_adjudicate_findings");
  const manualValidation = tools.find((tool) => tool.name === "workflow_record_manual_validation");
  const create = tools.find((tool) => tool.name === "workflow_create");
  const linkedFromPlan = tools.find(
    (tool) => tool.name === "workflow_create_linked_followup_from_plan",
  );
  assert.ok(
    implementation &&
      review &&
      begin &&
      expansion &&
      adoption &&
      create &&
      adjudication &&
      manualValidation &&
      linkedFromPlan,
  );
  assert.match(create.description ?? "", /return the parent view/u);
  assert.equal((create.description ?? "").includes("role capabilities"), false);
  assert.equal(protocolInstructions.includes("workflow_get"), false);
  assert.equal(protocolInstructions.includes("role capability"), false);
  assert.match(protocolInstructions, /PlanArtifact/);
  assert.match(protocolInstructions, /exact child plan identity only/);
  const adjudicationSchema = adjudication.inputSchema as any;
  assert.deepEqual(Object.keys(adjudicationSchema.properties).sort(), [
    "expected_version",
    "findings",
    "user_authorization",
    "workflow_id",
  ]);
  assert.deepEqual(adjudicationSchema.properties.findings.items.properties.disposition.enum, [
    "CONTRACT_INCONSISTENT",
    "OUTSIDE_APPROVED_SCOPE",
  ]);
  const implementationSchema = implementation.inputSchema as any;
  const reviewSchema = review.inputSchema as any;
  const beginSchema = begin.inputSchema as any;
  const manualValidationSchema = manualValidation.inputSchema as any;
  assert.equal("implementation_receipt" in implementationSchema.properties, false);
  assert.deepEqual(implementationSchema.properties.status.enum, [
    "DONE",
    "DONE_WITH_CONCERNS",
    "INCOMPLETE",
    "NEEDS_CONTEXT",
    "BLOCKED",
  ]);
  assert.match(implementation.description ?? "", /INCOMPLETE preserves IMPLEMENTING or REPAIRING/u);
  assert.equal("capability" in implementationSchema.properties, false);
  assert.equal("review_receipt" in reviewSchema.properties, false);
  assert.equal("capability" in reviewSchema.properties, false);
  assert.equal("review_target" in reviewSchema.properties, false);
  assert.equal("validation_results" in reviewSchema.properties, true);
  assert.equal(reviewSchema.required.includes("validation_results"), false);
  assert.deepEqual(reviewSchema.properties.validation_results.items.properties, {
    validation_id: { type: "string" },
    status: { type: "string", enum: ["passed", "failed", "not_run"] },
    evidence: { type: "string", minLength: 1, maxLength: 2000 },
  });
  assert.deepEqual(reviewSchema.properties.validation_results.items.required, [
    "validation_id",
    "status",
    "evidence",
  ]);
  assert.deepEqual(Object.keys(beginSchema.properties).sort(), ["expected_version", "workflow_id"]);
  assert.deepEqual(Object.keys(manualValidationSchema.properties).sort(), [
    "evidence",
    "expected_version",
    "status",
    "validation_id",
    "workflow_id",
  ]);
  assert.deepEqual(manualValidationSchema.properties.status.enum, ["passed", "failed"]);
  for (const name of [
    "workflow_parent_get",
    "workflow_implementer_get",
    "workflow_reviewer_get",
    "workflow_committer_get",
    "workflow_operator_decision_get",
  ]) {
    const getter = tools.find((tool) => tool.name === name);
    assert.ok(getter);
    assert.deepEqual(Object.keys((getter.inputSchema as any).properties).sort(), ["workflow_id"]);
  }
  const expansionSchema = expansion.inputSchema as any;
  assert.deepEqual(Object.keys(expansionSchema.properties).sort(), [
    "added_paths",
    "expected_version",
    "reason",
    "user_authorization",
    "workflow_id",
  ]);
  const adoptionSchema = adoption.inputSchema as any;
  assert.deepEqual(Object.keys(adoptionSchema.properties).sort(), [
    "added_paths",
    "adopted_paths",
    "expected_version",
    "reason",
    "user_authorization",
    "workflow_id",
  ]);
  assert.ok(reconciliation);
  assert.deepEqual(PLANNER_PLANNING_OPERATIONS, ["plan_create", "plan_get", "plan_revise"]);
  assert.deepEqual(PARENT_PLANNING_OPERATIONS, [
    "plan_parent_get",
    "plan_approve",
    "workflow_create_from_plan",
    "workflow_create_linked_followup_from_plan",
  ]);
  assert.equal(
    new Set([...PLANNER_PLANNING_OPERATIONS, ...PARENT_PLANNING_OPERATIONS]).size,
    PLANNER_PLANNING_OPERATIONS.length + PARENT_PLANNING_OPERATIONS.length,
  );
  const revise = tools.find((tool) => tool.name === "plan_revise");
  assert.ok(revise);
  const reviseSchema = revise.inputSchema as any;
  assert.deepEqual(Object.keys(reviseSchema.properties).sort(), [
    "base_revision",
    "plan_id",
    "replacements",
  ]);
  assert.deepEqual(reviseSchema.required, ["plan_id", "base_revision", "replacements"]);
  assert.equal(reviseSchema.additionalProperties, false);
  assert.equal(reviseSchema.properties.replacements.type, "object");
  assert.equal(reviseSchema.properties.replacements.additionalProperties, false);
  assert.equal(reviseSchema.properties.replacements.minProperties, 1);
  assert.deepEqual(Object.keys(reviseSchema.properties.replacements.properties).sort(), [
    "acceptance_criteria",
    "approved_paths",
    "execution_brief",
    "full_plan",
    "objective",
    "validation_requirements",
  ]);
  for (const name of PLANNER_PLANNING_OPERATIONS) {
    const plannerTool = tools.find((tool) => tool.name === name);
    assert.ok(plannerTool);
    assert.match(plannerTool.description ?? "", /authoring-compatible planner view/u);
  }
  const parentPlanGet = tools.find((tool) => tool.name === "plan_parent_get");
  assert.ok(parentPlanGet);
  assert.match(
    parentPlanGet.description ?? "",
    /exact persisted.*generated IDs.*approval evidence/u,
  );
  const reconciliationSchema = reconciliation.inputSchema as any;
  assert.deepEqual(Object.keys(reconciliationSchema.properties).sort(), [
    "attempt_id",
    "expected_version",
    "workflow_id",
  ]);
  const linkedFromPlanSchema = linkedFromPlan.inputSchema as any;
  assert.deepEqual(Object.keys(linkedFromPlanSchema.properties).sort(), [
    "expected_version",
    "finding_ids",
    "plan_id",
    "revision",
    "user_authorization",
    "workflow_id",
  ]);
  assert.equal("full_plan" in linkedFromPlanSchema.properties, false);
  assert.equal("execution_brief" in linkedFromPlanSchema.properties, false);
  assert.equal("objective" in linkedFromPlanSchema.properties, false);
  assert.equal("approved_paths" in linkedFromPlanSchema.properties, false);
  assert.equal("acceptance_criteria" in linkedFromPlanSchema.properties, false);
  assert.equal("validation_requirements" in linkedFromPlanSchema.properties, false);
  assert.match(linkedFromPlan.description ?? "", /resolv.*approved.*PlanArtifact server-side/u);
});
