import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createOpenCodeConfig,
  hasOpenCodeWorkflowStateRegistration,
  trustedBootstrapCommand,
} from "../../../install-into.js";

const repoRoot = resolve(import.meta.dir, "../../../");
const selfHostConfig = resolve(repoRoot, "opencode.json");
const relativeServerPath = ".codex/workflow-mcp/bootstrap.ts";
const orchestratorPath = ".opencode/agents/orchestrator.md";

test("the repository's own opencode.json registers workflow_state exactly like the installer", () => {
  assert.ok(existsSync(selfHostConfig), `missing self-host config: ${selfHostConfig}`);
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    $schema: string;
    default_agent: string;
    mcp: { workflow_state: Record<string, unknown> };
  };
  const expected = JSON.parse(createOpenCodeConfig(relativeServerPath)) as {
    $schema: string;
    default_agent: string;
    mcp: { workflow_state: Record<string, unknown> };
  };
  assert.equal(parsed.$schema, expected.$schema);
  assert.equal(parsed.default_agent, expected.default_agent);
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
  for (const agent of ["implementer", "code_reviewer", "committer"]) {
    assert.match(orchestrator, new RegExp(`^    "${agent}": allow$`, "m"));
  }
  assert.match(orchestrator, /^  workflow_state_\*: deny$/m);
  for (const tool of [
    "workflow_create",
    "workflow_get",
    "workflow_get_audit",
    "workflow_authorize_repair",
    "workflow_authorize_commit",
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
  ]) {
    assert.ok(normalized.includes(phrase), `missing orchestrator contract: ${phrase}`);
  }
  assert.ok(!existsSync(resolve(repoRoot, ".opencode/ORCHESTRATION.md")));
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
