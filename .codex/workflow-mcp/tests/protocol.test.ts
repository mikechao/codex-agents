import { test } from "bun:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  connectProtocol,
  disposeProtocolFixture,
  implementationInput,
  workflowCreateInput,
} from "./protocol-fixtures.js";
import { fixture } from "./test-fixtures.js";

test("SDK dispatch exposes exact role tools and serializes a representative lifecycle", async () => {
  const { root, git } = fixture();
  const session = await connectProtocol(root);
  try {
    const listed = await session.client.listTools();
    assert.equal(
      listed.tools.some((tool) => tool.name === "workflow_get"),
      false,
    );
    for (const name of [
      "workflow_parent_get",
      "workflow_implementer_get",
      "workflow_reviewer_get",
      "workflow_committer_get",
    ]) {
      assert.ok(listed.tools.some((tool) => tool.name === name));
    }

    const created = await session.call("workflow_create", workflowCreateInput(git));
    assert.equal("capability" in created, false);
    assert.equal("capabilities" in created, false);
    assert.equal(
      (await session.call("workflow_implementer_get", { workflow_id: created.workflow_id })).phase,
      "IMPLEMENTING",
    );

    const implementation = await session.call(
      "workflow_submit_implementation",
      implementationInput(created.workflow_id, await session.version(created.workflow_id)),
    );
    assert.equal(implementation.phase, "REVIEWING");
    assert.equal("implementation_receipt" in implementation, false);
    writeFileSync(join(root, "note.txt"), "after\n");
    assert.equal(
      (
        await session.call("workflow_begin_review", {
          workflow_id: created.workflow_id,
          expected_version: await session.version(created.workflow_id),
        })
      ).phase,
      "REVIEWING",
    );
    const review = await session.call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      expected_version: await session.version(created.workflow_id),
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    assert.equal(review.phase, "STOPPED_APPROVED");
    assert.equal("review_receipt" in review, false);
    assert.equal(
      (await session.call("workflow_reviewer_get", { workflow_id: created.workflow_id })).phase,
      "STOPPED_APPROVED",
    );
  } finally {
    await disposeProtocolFixture(root, session);
  }
});

test("SDK planning dispatch preserves authoring views and maps invalid or stale requests", async () => {
  const { root } = fixture();
  const session = await connectProtocol(root);
  try {
    const draft = await session.call("plan_create", {
      full_plan: "full plan text",
      execution_brief: "bounded execution brief",
      objective: "stdio planning",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["plan survives"],
      validation_requirements: [{ description: "manual check", argv: null }],
    });
    assert.equal(draft.metadata.status, "draft");
    assert.deepEqual(draft.validation_requirements, [{ description: "manual check", argv: null }]);

    const revised = await session.call("plan_revise", {
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: {
        full_plan: "replacement full plan",
        execution_brief: "replacement brief",
        objective: "stdio planning revised",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["replacement survives"],
        validation_requirements: ["manual replacement"],
      },
    });
    assert.equal(revised.revision, 2);
    assert.deepEqual(revised.validation_requirements, [
      { description: "manual replacement", argv: null },
    ]);

    const invalid = await session.callRaw("plan_revise", {
      plan_id: draft.plan_id,
      base_revision: revised.revision,
      replacements: { unknown: "value" },
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.body.category, "ERROR_INVALID_SHAPE");
    const stale = await session.callRaw("plan_revise", {
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: { full_plan: "stale plan" },
    });
    assert.equal(stale.result.isError, true);
    assert.equal(stale.body.category, "ERROR_VERSION_CONFLICT");

    const approved = await session.call("plan_approve", {
      plan_id: draft.plan_id,
      revision: revised.revision,
      user_authorization: "approve current exact revision",
    });
    assert.equal(approved.metadata.status, "approved");
    const parent = await session.call("plan_parent_get", {
      plan_id: draft.plan_id,
      revision: revised.revision,
    });
    assert.deepEqual(parent.acceptance_criteria, [
      { criterion_id: "AC-001", description: "replacement survives" },
    ]);
    const created = await session.call("workflow_create_from_plan", {
      plan_id: draft.plan_id,
      revision: revised.revision,
      work_items: [],
    });
    assert.equal(created.approved_plan, "replacement full plan");
    assert.equal(created.plan_provenance.revision, revised.revision);
  } finally {
    await disposeProtocolFixture(root, session);
  }
});

test("SDK role routing rejects obsolete fields and maps boundary errors", async () => {
  const { root, git } = fixture();
  const session = await connectProtocol(root);
  try {
    const first = await session.call(
      "workflow_create",
      workflowCreateInput(git, { objective: "first" }),
    );
    const second = await session.call(
      "workflow_create",
      workflowCreateInput(git, { objective: "second" }),
    );
    assert.equal(
      (await session.call("workflow_reviewer_get", { workflow_id: first.workflow_id })).objective,
      "first",
    );
    assert.equal(
      (await session.call("workflow_committer_get", { workflow_id: second.workflow_id })).objective,
      "second",
    );

    const obsolete = await session.callRaw("workflow_submit_implementation", {
      ...implementationInput(first.workflow_id, await session.version(first.workflow_id)),
      implementation_receipt: null,
      capability: "legacy-bearer",
    });
    assert.equal(obsolete.result.isError, true);
    assert.equal(obsolete.body.category, "ERROR_INVALID_SHAPE");

    const stale = await session.callRaw(
      "workflow_submit_implementation",
      implementationInput(first.workflow_id, (await session.version(first.workflow_id)) + 1),
    );
    assert.equal(stale.result.isError, true);
    assert.equal(stale.body.category, "ERROR_VERSION_CONFLICT");

    const invalidPhase = await session.callRaw("workflow_prepare_commit", {
      workflow_id: first.workflow_id,
      expected_version: await session.version(first.workflow_id),
    });
    assert.equal(invalidPhase.result.isError, true);
    assert.equal(invalidPhase.body.category, "ERROR_INVALID_TRANSITION");

    await session.call(
      "workflow_submit_implementation",
      implementationInput(first.workflow_id, await session.version(first.workflow_id)),
    );
    writeFileSync(join(root, "note.txt"), "malformed claim\n");
    await session.call("workflow_begin_review", {
      workflow_id: first.workflow_id,
      expected_version: await session.version(first.workflow_id),
    });
    await session.call("workflow_submit_review", {
      workflow_id: first.workflow_id,
      expected_version: await session.version(first.workflow_id),
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    await session.call("workflow_authorize_commit", {
      workflow_id: first.workflow_id,
      expected_version: await session.version(first.workflow_id),
      user_authorization: "protocol boundary test",
    });
    git("add", "note.txt");
    const prepared = await session.call("workflow_prepare_commit", {
      workflow_id: first.workflow_id,
      expected_version: await session.version(first.workflow_id),
    });
    const malformedClaim = await session.callRaw("workflow_submit_commit_result", {
      workflow_id: first.workflow_id,
      expected_version: await session.version(first.workflow_id),
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "mismatch",
      failure_summary: null,
    });
    assert.equal(malformedClaim.result.isError, true);
    assert.equal(malformedClaim.body.category, "ERROR_INVALID_SHAPE");
  } finally {
    await disposeProtocolFixture(root, session);
  }
});

test("SDK responses keep receipt internals server-owned", async () => {
  const { root, git } = fixture();
  const session = await connectProtocol(root);
  try {
    const created = await session.call("workflow_create", workflowCreateInput(git));
    const result = await session.call(
      "workflow_submit_implementation",
      implementationInput(created.workflow_id, await session.version(created.workflow_id)),
    );
    assert.equal(result.phase, "REVIEWING");
    assert.equal("initial_receipt" in result, false);
    assert.equal("implementation_receipt" in result, false);
    const reviewer = await session.call("workflow_reviewer_get", {
      workflow_id: created.workflow_id,
    });
    assert.equal("initial_receipt" in reviewer, false);
    assert.equal("implementation_receipt" in reviewer, false);
  } finally {
    await disposeProtocolFixture(root, session);
  }
});
