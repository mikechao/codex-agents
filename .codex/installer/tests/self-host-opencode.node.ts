import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createOpenCodeConfig,
  hasOpenCodeWorkflowStateRegistration,
} from "../../../install-into.js";

const repoRoot = resolve(import.meta.dir, "../../../");
const selfHostConfig = resolve(repoRoot, "opencode.json");
const relativeServerPath = ".codex/workflow-mcp/server.ts";
const orchestrationPath = ".opencode/ORCHESTRATION.md";

test("the repository's own opencode.json registers workflow_state exactly like the installer", () => {
  assert.ok(existsSync(selfHostConfig), `missing self-host config: ${selfHostConfig}`);
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    $schema: string;
    instructions: string[];
    mcp: { workflow_state: Record<string, unknown> };
  };
  const expected = JSON.parse(createOpenCodeConfig(relativeServerPath)) as {
    $schema: string;
    mcp: { workflow_state: Record<string, unknown> };
  };
  assert.equal(parsed.$schema, expected.$schema);
  assert.deepEqual(parsed.mcp, expected.mcp);
  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.ok(hasOpenCodeWorkflowStateRegistration(selfHostConfig));
});

test("the repository's own opencode.json loads the primary-agent orchestration instructions", () => {
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as { instructions?: string[] };
  assert.deepEqual(parsed.instructions, [orchestrationPath]);
  const orchestrationFile = resolve(repoRoot, orchestrationPath);
  assert.ok(existsSync(orchestrationFile), `missing orchestration file: ${orchestrationPath}`);
  const orchestration = readFileSync(orchestrationFile, "utf8");
  const normalizedOrchestration = orchestration.replace(/\s+/gu, " ");
  for (const guardrail of [
    "## Build orchestrator boundary",
    "Build is the orchestrator, not the implementer",
    "must delegate the implementation to `implementer`",
    "bounded, read-only preflight",
    "must not become a second implementation-planning pass",
    "For a direct Build request",
    "Plan-mode work",
    "implement the plan",
    "approved plan is handoff context for `implementer`",
    "must not edit source, configuration, or test files",
    "source-level implementation TODOs",
    "create or reuse the authoritative `workflow_state` workflow",
    "capture the exact returned `workflow_id`",
    "current `expected_version`",
    "first authoritative action remains `workflow_get`",
    "Build-side TODOs",
    "trivial-edit exemption",
  ]) {
    assert.ok(normalizedOrchestration.includes(guardrail), `missing Build guardrail: ${guardrail}`);
  }
  assert.ok(
    normalizedOrchestration.includes("every non-trivial implementation request"),
    "missing Build guardrail: every non-trivial implementation request",
  );

  const preflightIndex = normalizedOrchestration.indexOf("bounded, read-only preflight");
  const workflowIndex = normalizedOrchestration.indexOf(
    "creates or reuses the authoritative workflow",
  );
  const delegationIndex = normalizedOrchestration.indexOf("promptly delegates to `implementer`");
  assert.ok(preflightIndex >= 0 && preflightIndex < workflowIndex);
  assert.ok(workflowIndex < delegationIndex);
});

test("the repository's own OpenCode registration keeps the installer server semantics", () => {
  const { mcp } = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    mcp: { workflow_state: { type: string; command: string[]; enabled: boolean; timeout: number } };
  };
  const registration = mcp.workflow_state;
  assert.equal(registration.type, "local");
  assert.equal(registration.enabled, true);
  assert.equal(registration.timeout, 30000);
  assert.deepEqual(registration.command, ["bun", "--no-warnings", relativeServerPath]);
  assert.ok(
    existsSync(resolve(repoRoot, registration.command[2])),
    "the registered server path must exist in the repository",
  );
});
