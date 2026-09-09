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
      validation_results: [
        { validation_id: "VAL-001", status: "passed", evidence: "fresh reviewer pass" },
      ],
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

test("SDK direct review-only repair keeps null-plan provenance and exact aggregate bounds", async () => {
  const { root, git } = fixture();
  const session = await connectProtocol(root);
  const approvedPaths = ["note.txt", "original-scope.txt"];
  const blocker = {
    finding_id: "DIRECT-PROTOCOL-1",
    severity: "P1",
    blocking: true,
    file_and_line: "note.txt:1",
    failure_scenario: "the reconciliation misses a defect",
    impact: "the aggregate change is unsafe",
    violated_requirement: "complete review",
    remediation: "repair the defect",
    missing_or_inadequate_test: "direct repair regression",
  };
  const directive = {
    required_outcome: "resolve the direct blocker",
    strategy_constraints: "preserve the complete aggregate scope",
    fallbacks: [],
    required_paths: [],
    forbidden_paths: [],
    user_authorization: "explicitly authorize the exact direct repair",
  };
  try {
    const created = await session.call(
      "workflow_create",
      workflowCreateInput(git, {
        workflow_type: "review_only",
        approved_paths: approvedPaths,
        validation_requirements: [],
      }),
    );
    assert.equal(created.approved_plan, null);
    assert.equal(
      (await session.call("workflow_implementer_get", { workflow_id: created.workflow_id })).phase,
      "REVIEWING",
    );

    const beforeReview = await session.version(created.workflow_id);
    const beforeImplementation = await session.callRaw("workflow_submit_implementation", {
      ...implementationInput(created.workflow_id, beforeReview),
      validation_results: [],
    });
    assert.equal(beforeImplementation.result.isError, true);
    assert.equal(beforeImplementation.body.category, "ERROR_INVALID_TRANSITION");
    assert.equal(await session.version(created.workflow_id), beforeReview);

    await session.call("workflow_begin_review", {
      workflow_id: created.workflow_id,
      expected_version: beforeReview,
    });
    await session.call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      expected_version: await session.version(created.workflow_id),
      review_status: "CHANGES_REQUESTED",
      blocking_findings: [blocker],
      optional_findings: [],
      prior_finding_classifications: {},
    });

    const beforeRejectedAuthorization = await session.version(created.workflow_id);
    const missingDirective = await session.callRaw("workflow_authorize_repair", {
      workflow_id: created.workflow_id,
      expected_version: beforeRejectedAuthorization,
      finding_ids: [blocker.finding_id],
    });
    assert.equal(missingDirective.result.isError, true);
    assert.equal(missingDirective.body.category, "ERROR_INVALID_SHAPE");
    assert.equal(await session.version(created.workflow_id), beforeRejectedAuthorization);

    const rejectedIds = await session.callRaw("workflow_authorize_repair", {
      workflow_id: created.workflow_id,
      expected_version: beforeRejectedAuthorization,
      finding_ids: ["STALE-ID"],
      repair_directive: directive,
    });
    assert.equal(rejectedIds.result.isError, true);
    assert.equal(rejectedIds.body.category, "ERROR_INVALID_REPAIR");
    assert.equal(await session.version(created.workflow_id), beforeRejectedAuthorization);

    const rejectedPaths = await session.callRaw("workflow_authorize_repair", {
      workflow_id: created.workflow_id,
      expected_version: beforeRejectedAuthorization,
      finding_ids: [blocker.finding_id],
      repair_directive: { ...directive, required_paths: ["outside.txt"] },
    });
    assert.equal(rejectedPaths.result.isError, true);
    assert.equal(rejectedPaths.body.category, "ERROR_INVALID_REPAIR");
    assert.equal(await session.version(created.workflow_id), beforeRejectedAuthorization);

    const rejectedForbiddenPaths = await session.callRaw("workflow_authorize_repair", {
      workflow_id: created.workflow_id,
      expected_version: beforeRejectedAuthorization,
      finding_ids: [blocker.finding_id],
      repair_directive: { ...directive, forbidden_paths: ["outside.txt"] },
    });
    assert.equal(rejectedForbiddenPaths.result.isError, true);
    assert.equal(rejectedForbiddenPaths.body.category, "ERROR_INVALID_REPAIR");
    assert.equal(await session.version(created.workflow_id), beforeRejectedAuthorization);

    const rejectedContradictoryDirective = await session.callRaw("workflow_authorize_repair", {
      workflow_id: created.workflow_id,
      expected_version: beforeRejectedAuthorization,
      finding_ids: [blocker.finding_id],
      repair_directive: {
        ...directive,
        required_paths: ["note.txt"],
        forbidden_paths: ["note.txt"],
      },
    });
    assert.equal(rejectedContradictoryDirective.result.isError, true);
    assert.equal(rejectedContradictoryDirective.body.category, "ERROR_INVALID_REPAIR");
    assert.equal(await session.version(created.workflow_id), beforeRejectedAuthorization);

    const repairing = await session.call("workflow_authorize_repair", {
      workflow_id: created.workflow_id,
      expected_version: beforeRejectedAuthorization,
      finding_ids: [blocker.finding_id],
      repair_directive: directive,
    });
    assert.equal(repairing.phase, "REPAIRING");
    const implementer = await session.call("workflow_implementer_get", {
      workflow_id: created.workflow_id,
    });
    assert.equal(implementer.approved_plan, null);
    assert.equal(implementer.objective, "stdio protocol");
    assert.deepEqual(implementer.approved_paths, approvedPaths);
    assert.deepEqual(implementer.acceptance_criteria, [
      { criterion_id: "AC-001", description: "criterion" },
    ]);
    assert.deepEqual(implementer.validation_requirements, []);
    assert.deepEqual(implementer.blocking_findings, [blocker]);
    assert.deepEqual(implementer.repair_authorized_ids, [blocker.finding_id]);
    assert.deepEqual(implementer.remediation_context, null);
    assert.deepEqual(implementer.repair_directive, directive);

    const beforeOutOfScope = await session.version(created.workflow_id);
    const outOfScope = await session.callRaw("workflow_submit_implementation", {
      ...implementationInput(created.workflow_id, beforeOutOfScope, "DONE", {
        [blocker.finding_id]: "resolved",
      }),
      agent_touched_paths: ["outside.txt"],
      validation_results: [],
    });
    assert.equal(outOfScope.result.isError, true);
    assert.equal(outOfScope.body.category, "ERROR_INVALID_IMPLEMENTATION");
    assert.equal(await session.version(created.workflow_id), beforeOutOfScope);

    const implemented = await session.call("workflow_submit_implementation", {
      ...implementationInput(created.workflow_id, beforeOutOfScope, "DONE", {
        [blocker.finding_id]: "resolved",
      }),
      agent_touched_paths: ["note.txt"],
      validation_results: [],
    });
    assert.equal(implemented.phase, "REVIEWING");
    assert.equal(implemented.approved_plan, null);
    assert.deepEqual(implemented.review_target.approved_paths, approvedPaths);
    const postRepair = await session.call("workflow_implementer_get", {
      workflow_id: created.workflow_id,
    });
    assert.equal(postRepair.approved_plan, null);
    assert.deepEqual(postRepair.blocking_findings, [blocker]);
    assert.deepEqual(postRepair.approved_paths, approvedPaths);
  } finally {
    await disposeProtocolFixture(root, session);
  }
});

test("SDK planning dispatch preserves authoring views and maps invalid or stale requests", async () => {
  const { root } = fixture();
  const session = await connectProtocol(root);
  try {
    const draft = await session.call("plan_create", {
      workflow_type: "review_only",
      full_plan: "full plan text",
      execution_brief: "bounded execution brief",
      objective: "stdio planning",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["plan survives"],
      validation_requirements: [{ description: "manual check", kind: "inspection" }],
    });
    assert.equal(draft.metadata.status, "draft");
    assert.equal(typeof draft.plan_ref, "string");
    assert.deepEqual(draft.validation_requirements, [
      { description: "manual check", kind: "inspection" },
    ]);

    const revised = await session.call("plan_revise", {
      plan_id: draft.plan_id,
      base_revision: draft.revision,
      replacements: {
        full_plan: "replacement full plan",
        execution_brief: "replacement brief",
        objective: "stdio planning revised",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["replacement survives"],
        validation_requirements: [{ description: "manual replacement", kind: "inspection" }],
      },
    });
    assert.equal(revised.revision, 2);
    assert.equal(revised.plan_ref, draft.plan_ref);
    assert.deepEqual(revised.validation_requirements, [
      { description: "manual replacement", kind: "inspection" },
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
    assert.equal(approved.plan_ref, draft.plan_ref);
    const parent = await session.call("plan_parent_get", {
      plan_id: draft.plan_id,
      revision: revised.revision,
    });
    assert.equal(parent.plan_ref, draft.plan_ref);
    assert.deepEqual(parent.acceptance_criteria, [
      { criterion_id: "AC-001", description: "replacement survives" },
    ]);
    const alias = await session.callRaw("plan_get", {
      plan_id: draft.plan_ref,
      revision: revised.revision,
    });
    assert.equal(alias.result.isError, true);
    assert.equal(alias.body.category, "ERROR_PLAN_INVALID");
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
      validation_results: [
        { validation_id: "VAL-001", status: "passed", evidence: "fresh reviewer pass" },
      ],
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
