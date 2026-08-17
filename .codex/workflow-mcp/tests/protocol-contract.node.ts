import { test } from "bun:test";
import assert from "node:assert/strict";
import { tools } from "../server.js";

test("protocol tool contract exposes the workflow actions with stable annotations", () => {
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "workflow_accept_concerns",
    "workflow_authorize_commit",
    "workflow_authorize_repair",
    "workflow_create",
    "workflow_create_linked_followup",
    "workflow_finalize_repair_exhausted",
    "workflow_get",
    "workflow_get_audit",
    "workflow_prepare_commit",
    "workflow_record_commit",
    "workflow_resume_implementation",
    "workflow_resume_review",
    "workflow_retry_commit",
    "workflow_submit_commit_result",
    "workflow_submit_implementation",
    "workflow_submit_review",
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(
      tool.annotations?.readOnlyHint,
      tool.name === "workflow_get" || tool.name === "workflow_get_audit",
    );
  }
});
