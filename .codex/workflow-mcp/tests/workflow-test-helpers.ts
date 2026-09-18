// biome-ignore-all lint/suspicious/noExplicitAny: Preserve the original integration-test helper contracts exactly.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { createRuntimeAttestation } from "../store.js";

export function input(git: (...args: string[]) => string, options: any = {}) {
  const paths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "workflow test",
    approved_plan: options.approved_plan ?? null,
    approved_paths: paths,
    acceptance_criteria: options.acceptance_criteria ?? ["criterion"],
    validation_requirements: options.validation_requirements ?? [
      { description: "validation", kind: "command", argv: ["bun", "run", "check"] },
    ],
    review_target: options.review_target ?? {
      review_mode: "working_tree",
      base_revision: git("rev-parse", "HEAD"),
      head_revision: null,
      approved_paths: paths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
    max_repair_cycles: options.max_repair_cycles,
    ...(options.work_items === undefined ? {} : { work_items: options.work_items }),
  };
}

export function implementation(
  store: any,
  workflow: any,
  version: number | undefined = undefined,
  status = "DONE",
  resolution = {},
  touched: string[] = [],
) {
  return store.submitImplementation({
    workflow_id: workflow.workflow_id,
    expected_version: version ?? currentVersion(store, workflow.workflow_id),
    status,
    summary: "implementation evidence",
    agent_touched_paths: touched,
    acceptance_results: workflow.acceptance_criteria.map(({ criterion_id }: any) => ({
      criterion_id,
      status: "satisfied",
      evidence: "accepted",
    })),
    validation_results: workflow.validation_requirements.map(({ validation_id }: any) => ({
      validation_id,
      status: "passed",
      evidence: "validated",
    })),
    known_failures: status === "DONE" ? [] : ["test context"],
    finding_resolution_map: resolution,
  });
}

export function reviewerValidationResults(workflow: any, status = "passed") {
  return workflow.validation_requirements
    .filter(({ kind }: any) => kind === "command")
    .map(({ validation_id }: any) => ({
      validation_id,
      status,
      evidence: "reviewer validated",
    }));
}

export function review(
  store: any,
  workflow: any,
  _version: number | undefined = undefined,
  status = "APPROVED",
  blocking: any[] = [],
  optional: any[] = [],
  prior = {},
) {
  const id = workflow.workflow_id;
  if (workflow.review_target.review_mode === "working_tree") {
    store.beginReview({ workflow_id: id, expected_version: currentVersion(store, id) });
  }
  const current = rawState(store, id);
  return store.submitReview({
    workflow_id: id,
    expected_version: current.version,
    review_status: status,
    blocking_findings: blocking,
    optional_findings: optional,
    prior_finding_classifications: prior,
    validation_results: reviewerValidationResults(workflow),
    ...(current.repair_directive
      ? {
          repair_conformance: {
            status: "conforming",
            evidence: "reviewed the active repair directive and verified conformance",
          },
        }
      : {}),
  });
}

export function finding(id: string, severity = "P1", blocking = true) {
  return {
    finding_id: id,
    severity,
    blocking,
    file_and_line: "note.txt:1",
    failure_scenario: "scenario",
    impact: "impact",
    violated_requirement: "requirement",
    remediation: "remediation",
    missing_or_inadequate_test: "test",
  };
}

export function category(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    assert.ok(error instanceof WorkflowError);
    return error.category;
  }
  assert.fail("expected workflow error");
}

export function repairDirectiveFor(
  store: any,
  workflowId: string,
  findingIds: string[],
  userAuthorization = "authorize this bounded repair",
) {
  const decision = store.operatorDecisionGet(workflowId, findingIds);
  assert.equal(decision.primary.kind, "approve_exact_repairs");
  if (decision.primary.kind !== "approve_exact_repairs")
    throw new Error("expected repair proposal");
  return {
    selected_finding_ids: [...decision.execution.primary.repair_binding.selected_finding_ids],
    ...decision.primary.proposal,
    user_authorization: userAuthorization,
  };
}

export function rawState(store: any, workflowId: string): any {
  const row = store.db
    .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
    .get(workflowId);
  assert.ok(row);
  return JSON.parse(row.state_json);
}

export function currentVersion(store: any, workflowId: string): number {
  return rawState(store, workflowId).version;
}

export function deterministicParentActions(store: any, workflowId: string): string[] {
  return store.parentGet(workflowId).permitted_next_actions;
}

export function authorized(
  store: any,
  root: string,
  git: (...args: string[]) => string,
  options: any = {},
) {
  const approvedPaths = options.approved_paths ?? ["note.txt"];
  const created = store.create(
    input(git, {
      objective: options.objective ?? "authorized workflow",
      approved_paths: approvedPaths,
    }),
  );
  const id = created.workflow_id;
  implementation(store, created);
  for (const path of approvedPaths) {
    writeFileSync(
      join(root, path),
      options.contents?.[path] ??
        (path === "note.txt" ? (options.content ?? "changed\n") : `${path}\n`),
    );
  }
  review(store, created);
  store.authorizeCommit({
    workflow_id: id,
    expected_version: currentVersion(store, id),
    user_authorization: "authorized",
  });
  return { created, id };
}

export function runtimeAttestation(runtimeId: string, revision: string, key = "2".repeat(64)) {
  const nonce = "1".repeat(64);
  return {
    runtimeAttestation: createRuntimeAttestation(runtimeId, revision, nonce, key),
    runtimeAttestationNonce: nonce,
    runtimeAttestationKey: key,
  };
}
