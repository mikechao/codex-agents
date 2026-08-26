import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasOpenCodeWorkflowStateRegistration,
  trustedBootstrapCommand,
} from "../../../install-into.js";
import { tools } from "../../workflow-mcp/server.js";

const repoRoot = resolve(import.meta.dir, "../../../");
const selfHostConfig = resolve(repoRoot, "opencode.json");
const relativeServerPath = ".codex/workflow-mcp/bootstrap.ts";
const orchestratorPath = ".opencode/agents/orchestrator.md";

test("the repository's own opencode.json registers the supervised self-host server", () => {
  assert.ok(existsSync(selfHostConfig), `missing self-host config: ${selfHostConfig}`);
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    $schema: string;
    default_agent: string;
    subagent_depth: number;
    mcp: { workflow_state: Record<string, unknown> };
  };
  const expected = {
    $schema: "https://opencode.ai/config.json",
    default_agent: "orchestrator",
    subagent_depth: 2,
    mcp: {
      workflow_state: {
        type: "local",
        command: trustedBootstrapCommand(relativeServerPath),
        enabled: true,
        timeout: 30000,
      },
    },
  };
  assert.equal(parsed.$schema, expected.$schema);
  assert.equal(parsed.default_agent, expected.default_agent);
  assert.equal(parsed.subagent_depth, expected.subagent_depth);
  assert.deepEqual(parsed.mcp, expected.mcp);
  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.equal(parsed.default_agent, "orchestrator");
  assert.ok(hasOpenCodeWorkflowStateRegistration(selfHostConfig));
});

test("the repository's own OpenCode setup uses a dedicated primary orchestrator", () => {
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    default_agent?: string;
    instructions?: string[];
  };
  assert.equal(parsed.default_agent, "orchestrator");
  assert.equal(parsed.instructions, undefined, "Build must not receive global orchestration prose");
  const orchestratorFile = resolve(repoRoot, orchestratorPath);
  assert.ok(existsSync(orchestratorFile), `missing orchestrator: ${orchestratorPath}`);
  const orchestrator = readFileSync(orchestratorFile, "utf8");
  const normalized = orchestrator.replace(/\s+/gu, " ");
  assert.match(orchestrator, /^mode: primary$/m);
  assert.match(orchestrator, /^  edit: deny$/m);
  assert.match(orchestrator, /^  task:\n    "\*": deny$/m);
  assert.match(orchestrator, /^    "planner": allow$/m);
  assert.ok(!orchestrator.match(/^    "explorer": allow$/m));
  for (const agent of ["implementer", "code_reviewer", "committer"]) {
    assert.match(orchestrator, new RegExp(`^    "${agent}": allow$`, "m"));
  }
  assert.match(orchestrator, /^  workflow_state_\*: deny$/m);
  for (const tool of [
    "plan_parent_get",
    "plan_approve",
    "workflow_create_from_plan",
    "workflow_create",
    "workflow_adopt_dirty_scope",
    "workflow_expand_scope",
    "workflow_parent_get",
    "workflow_reconcile_commit_result",
    "workflow_get_audit",
    "workflow_resume_implementation",
    "workflow_accept_concerns",
    "workflow_authorize_repair",
    "workflow_adjudicate_findings",
    "workflow_resume_review",
    "workflow_finalize_repair_exhausted",
    "workflow_create_linked_followup",
    "workflow_authorize_commit",
    "workflow_retry_commit_preparation",
    "workflow_return_commit_to_review",
    "workflow_retry_commit",
  ]) {
    assert.match(orchestrator, new RegExp(`^  workflow_state_${tool}: allow$`, "m"));
  }
  for (const forbidden of [
    "workflow_submit_implementation",
    "workflow_submit_review",
    "workflow_prepare_commit",
    "workflow_submit_commit_result",
  ]) {
    assert.ok(!orchestrator.includes(`workflow_state_${forbidden}`));
  }
  for (const phrase of [
    "You are the OpenCode workflow orchestrator.",
    "do not implement, independently review, stage, or commit",
    "bounded, read-only preflight",
    "exact returned `workflow_id`",
    "implement the plan",
    "stop at `STOPPED_APPROVED`",
    "explicit work-item metadata",
    "work_items",
    "do not discover identifiers externally",
    "retranscribe them when creating linked follow-ups",
    "delegate only to `planner`",
    "zero to four disposable, read-only explorers",
    "bounded `PlannerHandoff`",
  ]) {
    assert.ok(normalized.includes(phrase), `missing orchestrator contract: ${phrase}`);
  }
  assert.ok(!existsSync(resolve(repoRoot, ".opencode/ORCHESTRATION.md")));
});

test("the orchestrator exposes the complete parent planning tool surface", () => {
  const orchestrator = readFileSync(resolve(repoRoot, orchestratorPath), "utf8");
  const allowed = new Set(
    [...orchestrator.matchAll(/^  workflow_state_([a-z0-9_]+): allow$/gmu)].map(
      (match) => match[1],
    ),
  );
  const serverTools = new Set(tools.map((tool) => tool.name));
  for (const name of ["plan_parent_get", "plan_approve", "workflow_create_from_plan"]) {
    assert.ok(allowed.has(name), `orchestrator must allow ${name}`);
    assert.ok(serverTools.has(name), `server must expose ${name}`);
  }
  for (const name of ["plan_create", "plan_get", "plan_revise"]) {
    assert.equal(allowed.has(name), false, `orchestrator must not allow planner operation ${name}`);
  }
});

test("the orchestrator preflights the exact reviewer validation policy", () => {
  const orchestratorFile = resolve(repoRoot, orchestratorPath);
  const orchestrator = readFileSync(orchestratorFile, "utf8");
  const normalized = orchestrator.replace(/\s+/gu, " ");
  for (const phrase of [
    "Before calling `workflow_create`, read the repository's `.codex/reviewer-validation.json` policy",
    "exact array equality",
    "argument ordering, and every individual argument",
    "Validation IDs, descriptions, prefixes, and approximate or partial matches never authorize execution",
    "Treat `argv: null` as an explicit manual requirement",
    "Only reformulate it as `argv: null` when the check is genuinely manual",
    "substitute an already-authorized exact argv when that command is genuinely sufficient",
    "do not edit the policy, execute the reviewer validation runner, silently drop the requirement, or create the workflow",
    "stop before workflow creation rather than guessing",
  ]) {
    assert.ok(normalized.includes(phrase), `missing validation preflight contract: ${phrase}`);
  }
  const preflightStart = normalized.indexOf("Before calling `workflow_create`");
  const policyRead = normalized.indexOf(
    "read the repository's `.codex/reviewer-validation.json` policy",
  );
  const creationGate = normalized.indexOf("Create the workflow only after");
  assert.ok(preflightStart >= 0 && preflightStart < policyRead, "policy read must be in preflight");
  assert.ok(policyRead < creationGate, "policy preflight must precede workflow creation");
});

test("the repository's own OpenCode registration keeps the installer server semantics", () => {
  const { mcp } = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    mcp: { workflow_state: { type: string; command: string[]; enabled: boolean; timeout: number } };
  };
  const registration = mcp.workflow_state;
  assert.equal(registration.type, "local");
  assert.equal(registration.enabled, true);
  assert.equal(registration.timeout, 30000);
  assert.deepEqual(registration.command, trustedBootstrapCommand(relativeServerPath));
  assert.ok(existsSync(resolve(repoRoot, relativeServerPath)), "the bootstrap source must exist");
});
