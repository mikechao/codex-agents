import { test } from "bun:test";
import assert from "node:assert/strict";
import { protocolInstructions, tools } from "../server.js";

test("protocol tool contract exposes the workflow actions with stable annotations", () => {
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "workflow_accept_concerns",
    "workflow_authorize_commit",
    "workflow_authorize_repair",
    "workflow_begin_review",
    "workflow_committer_get",
    "workflow_create",
    "workflow_create_linked_followup",
    "workflow_expand_scope",
    "workflow_finalize_repair_exhausted",
    "workflow_get_audit",
    "workflow_implementer_get",
    "workflow_parent_get",
    "workflow_prepare_commit",
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
  const create = tools.find((tool) => tool.name === "workflow_create");
  assert.ok(implementation && review && begin && expansion && create);
  assert.match(create.description ?? "", /one parent capability/u);
  assert.equal((create.description ?? "").includes("role capabilities"), false);
  assert.equal(protocolInstructions.includes("workflow_get"), false);
  assert.equal(protocolInstructions.includes("role capability"), false);
  const implementationSchema = implementation.inputSchema as any;
  const reviewSchema = review.inputSchema as any;
  const beginSchema = begin.inputSchema as any;
  assert.equal("implementation_receipt" in implementationSchema.properties, false);
  assert.equal("capability" in implementationSchema.properties, false);
  assert.equal("review_receipt" in reviewSchema.properties, false);
  assert.equal("capability" in reviewSchema.properties, false);
  assert.equal("review_target" in reviewSchema.properties, false);
  assert.deepEqual(Object.keys(beginSchema.properties).sort(), ["expected_version", "workflow_id"]);
  for (const name of [
    "workflow_parent_get",
    "workflow_implementer_get",
    "workflow_reviewer_get",
    "workflow_committer_get",
  ]) {
    const getter = tools.find((tool) => tool.name === name);
    assert.ok(getter);
    assert.deepEqual(Object.keys((getter.inputSchema as any).properties).sort(), ["workflow_id"]);
  }
  const expansionSchema = expansion.inputSchema as any;
  assert.deepEqual(Object.keys(expansionSchema.properties).sort(), [
    "added_paths",
    "capability",
    "expected_version",
    "reason",
    "user_authorization",
    "workflow_id",
  ]);
});
