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

test("the repository's own opencode.json registers workflow_state exactly like the installer", () => {
  assert.ok(existsSync(selfHostConfig), `missing self-host config: ${selfHostConfig}`);
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as Record<string, unknown>;
  const expected = JSON.parse(createOpenCodeConfig(relativeServerPath));
  assert.deepEqual(parsed, expected);
  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.ok(hasOpenCodeWorkflowStateRegistration(selfHostConfig));
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
