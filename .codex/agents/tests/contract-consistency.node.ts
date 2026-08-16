import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "bun:test";
import { generateDefinitions } from "../generate-host-definitions.js";

const agentsDir = resolve(import.meta.dir, "..");

for (const [path, content] of Object.entries(generateDefinitions())) {
  const relative = path.slice(agentsDir.length + 1);
  test(`generated ${relative} is current`, () => {
    assert.ok(existsSync(path), `missing generated file: ${path}`);
    assert.equal(readFileSync(path, "utf8"), content);
  });
}

const opencode = (name: string) =>
  readFileSync(resolve(import.meta.dir, "../../../.opencode/agents", name), "utf8");

test("OpenCode definitions are subagents with host-native permissions", () => {
  for (const name of ["implementer.md", "code_reviewer.md", "committer.md"]) {
    const content = opencode(name);
    assert.match(content, /^---\n/, `${name} must start with YAML frontmatter`);
    assert.match(content, /^mode: subagent$/m, `${name} must be a subagent`);
    assert.match(content, /^model: deepseek-v4-flash$/m, `${name} must pin the adapter model`);
    assert.match(content, /^  task:\n    "\*": deny$/m, `${name} must not delegate`);
    assert.match(
      content,
      /^  workflow_state_\*: deny$/m,
      `${name} must gate MCP tools behind the role allowlist`,
    );
    assert.match(
      content,
      /^  workflow_state_workflow_get: allow$/m,
      `${name} must keep the authoritative workflow_get tool`,
    );
  }
});

test("reviewer is read-only with a narrow bash allowlist", () => {
  const content = opencode("code_reviewer.md");
  assert.match(content, /^  edit: deny$/m, "reviewer must not edit");
  assert.match(content, /^    "\*": deny$/m, "reviewer bash must fail closed");
  for (const allowed of [
    '"git status": allow',
    '"git status *": allow',
    '"git diff": allow',
    '"git diff *": allow',
    '"git log": allow',
    '"git log *": allow',
    '"git show *": allow',
    '"git rev-parse *": allow',
    '"bun .codex/agents/change-receipt.ts *": allow',
  ]) {
    assert.ok(content.includes(allowed), `reviewer bash allowlist must include ${allowed}`);
  }
  for (const denied of ["add", "commit", "push", "reset", "rebase", "checkout", "switch", "restore"]) {
    assert.ok(
      !new RegExp(`^\\s+"git ${denied}`).test(content),
      `reviewer bash must not allow git ${denied}`,
    );
  }
  assert.match(content, /^  workflow_state_workflow_submit_review: allow$/m);
  assert.ok(!content.includes("workflow_state_workflow_prepare_commit"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
});

test("committer cannot edit but may run bash for the external commit", () => {
  const content = opencode("committer.md");
  assert.match(content, /^  edit: deny$/m, "committer must not modify source files");
  assert.match(content, /^  bash: allow$/m, "committer needs bash for git add/commit");
  assert.match(content, /^  workflow_state_workflow_prepare_commit: allow$/m);
  assert.match(content, /^  workflow_state_workflow_submit_commit_result: allow$/m);
  assert.ok(!content.includes("workflow_state_workflow_submit_implementation"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
});

test("implementer may edit but never touches commit or review tools", () => {
  const content = opencode("implementer.md");
  assert.match(content, /^  edit: allow$/m, "implementer must be able to edit the approved scope");
  assert.match(content, /^  bash: allow$/m, "implementer runs validation commands");
  assert.match(content, /^  workflow_state_workflow_submit_implementation: allow$/m);
  assert.ok(!content.includes("workflow_state_workflow_prepare_commit"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
});

test("Codex and OpenCode contracts carry equivalent role behavior", () => {
  const bodies = new Map<string, string>();
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    const toml = readFileSync(resolve(agentsDir, `${role}.toml`), "utf8");
    const markdown = opencode(`${role}.md`);
    const tomlBody = toml.split("developer_instructions = \"\"\"\n")[1].split("\n\"\"\"\n")[0];
    const markdownBody = markdown.split("---\n").slice(2).join("---\n").replace(/\n$/, "");
    assert.equal(tomlBody, markdownBody, `${role} host bodies must be identical`);
    bodies.set(role, tomlBody);
  }
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    assert.ok(bodies.get(role)!.includes("workflow_get"), `${role} must use the authoritative view`);
  }
});
