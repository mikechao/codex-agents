import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  generateDefinitions,
  OPENCODE_TERMINAL_SECTION_HEADING,
} from "../generate-host-definitions.js";

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
  const expectedModels: Record<string, string> = {
    implementer: "openai/gpt-5.6-luna",
    code_reviewer: "openai/gpt-5.6-luna",
    committer: "openai/gpt-5.6-luna",
  };
  const expectedReasoning: Record<string, string> = {
    implementer: "high",
    code_reviewer: "high",
    committer: "high",
  };
  for (const name of ["implementer.md", "code_reviewer.md", "committer.md"]) {
    const role = name.replace(/\.md$/, "");
    const content = opencode(name);
    assert.match(content, /^---\n/, `${name} must start with YAML frontmatter`);
    assert.match(content, /^mode: subagent$/m, `${name} must be a subagent`);
    assert.match(
      content,
      new RegExp(`^model: ${expectedModels[role]}$`, "m"),
      `${name} must pin its configured OpenCode model`,
    );
    assert.match(
      content,
      new RegExp(`^reasoningEffort: ${expectedReasoning[role]}$`, "m"),
      `${name} must pin its configured reasoning effort`,
    );
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

test("the OpenCode orchestrator is a host-specific primary outside shared generation", () => {
  const generatedPaths = Object.keys(generateDefinitions());
  assert.ok(
    !generatedPaths.some((path) => path.endsWith(".opencode/agents/orchestrator.md")),
    "the OpenCode-only primary must not be generated as a shared role",
  );
  const content = opencode("orchestrator.md");
  assert.match(content, /^mode: primary$/m);
  assert.match(content, /^  edit: deny$/m);
  assert.match(content, /^  task:\n    "\*": deny$/m);
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    assert.match(content, new RegExp(`^    "${role}": allow$`, "m"));
  }
  assert.match(content, /^  workflow_state_\*: deny$/m);
  assert.ok(!content.includes("workflow_state_workflow_submit_implementation"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
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
  for (const denied of [
    "add",
    "commit",
    "push",
    "reset",
    "rebase",
    "checkout",
    "switch",
    "restore",
  ]) {
    assert.ok(
      !new RegExp(`^\\s+"git ${denied}`).test(content),
      `reviewer bash must not allow git ${denied}`,
    );
  }
  assert.match(content, /^  workflow_state_workflow_submit_review: allow$/m);
  assert.match(content, /^  workflow_state_workflow_begin_review: allow$/m);
  assert.ok(!content.includes("workflow_state_workflow_prepare_commit"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
});

test("committer is read-only with a fail-closed bash allowlist for the commit flow", () => {
  const content = opencode("committer.md");
  assert.match(content, /^  edit: deny$/m, "committer must not modify source files");
  assert.match(content, /^  bash:\n    "\*": deny$/m, "committer bash must fail closed");
  for (const allowed of [
    '"git status": allow',
    '"git status *": allow',
    '"git diff": allow',
    '"git diff *": allow',
    '"git log": allow',
    '"git log *": allow',
    '"git show *": allow',
    '"git rev-parse": allow',
    '"git rev-parse *": allow',
    '"git ls-files": allow',
    '"git ls-files *": allow',
    '"git add *": allow',
    '"git commit": allow',
    '"git commit *": allow',
    '"bun .codex/agents/change-receipt.ts *": allow',
  ]) {
    assert.ok(content.includes(allowed), `committer bash allowlist must include ${allowed}`);
  }
  for (const denied of [
    "git add -p",
    "git add -i",
    "git commit --amend",
    "git push",
    "git rebase",
    "git reset",
    "git checkout",
    "git switch",
    "git restore",
    "git rm",
    "git mv",
    "git clean",
    "git stash",
  ]) {
    assert.ok(
      content.includes(`"${denied}": deny`) && content.includes(`"${denied} *": deny`),
      `committer bash must deny ${denied} with and without arguments`,
    );
  }
  assert.match(content, /^  workflow_state_workflow_prepare_commit: allow$/m);
  assert.match(content, /^  workflow_state_workflow_submit_commit_result: allow$/m);
  assert.ok(!content.includes("workflow_state_workflow_submit_implementation"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
});

test("implementer may edit but never stages, commits, or rewrites history", () => {
  const content = opencode("implementer.md");
  assert.match(content, /^  edit: allow$/m, "implementer must be able to edit the approved scope");
  assert.match(
    content,
    /^  bash:\n    "\*": allow$/m,
    "implementer bash must allow validation by default",
  );
  for (const denied of [
    "git add",
    "git commit",
    "git push",
    "git reset",
    "git rebase",
    "git checkout",
    "git switch",
    "git restore",
    "git revert",
    "git cherry-pick",
    "git rm",
    "git mv",
    "git clean",
    "git stash",
  ]) {
    assert.ok(
      content.includes(`"${denied}": deny`) && content.includes(`"${denied} *": deny`),
      `implementer bash must deny ${denied} with and without arguments`,
    );
  }
  assert.match(content, /^  workflow_state_workflow_submit_implementation: allow$/m);
  assert.ok(!content.includes("workflow_state_workflow_prepare_commit"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
});

test("Codex and OpenCode contracts carry equivalent role behavior", () => {
  const normalize = (body: string) =>
    body.replace(/"Agent: [a-z_]+ \| Model: .*"/, '"Agent: <role> | Model: __HOST_IDENTITY__"');
  const bodies = new Map<string, string>();
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    const toml = readFileSync(resolve(agentsDir, `${role}.toml`), "utf8");
    const markdown = opencode(`${role}.md`);
    const tomlBody = toml.split('developer_instructions = """\n')[1].split('\n"""\n')[0];
    const markdownBody = markdown
      .split("---\n")
      .slice(2)
      .join("---\n")
      .split(OPENCODE_TERMINAL_SECTION_HEADING)[0]
      .trimEnd();
    assert.equal(
      normalize(tomlBody),
      normalize(markdownBody),
      `${role} host bodies must differ only in the injected host identity`,
    );
    bodies.set(role, tomlBody);
  }
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    assert.ok(
      bodies.get(role)!.includes("workflow_get"),
      `${role} must use the authoritative view`,
    );
  }
});

test("OpenCode definitions require a non-empty final report after terminal MCP submission", () => {
  const terminalTools: Record<string, string> = {
    implementer: "workflow_submit_implementation",
    code_reviewer: "workflow_submit_review",
    committer: "workflow_submit_commit_result",
  };
  const finalReportLabels: Record<string, string> = {
    implementer: "final implementation report",
    code_reviewer: "final review report",
    committer: "final commit report",
  };
  for (const name of Object.keys(terminalTools)) {
    const content = opencode(`${name}.md`);
    assert.ok(
      content.includes(OPENCODE_TERMINAL_SECTION_HEADING),
      `${name} must carry the OpenCode-only terminal response section`,
    );
    assert.ok(
      content.includes("non-empty normal assistant text response"),
      `${name} must require a non-empty final assistant text response`,
    );
    assert.ok(
      content.includes("A successful MCP tool call is never itself the final response"),
      `${name} must forbid ending on a bare successful tool call`,
    );
    assert.match(
      content,
      /empty final report\s+is\s+never\s+acceptable/,
      `${name} must forbid an empty final report`,
    );
    assert.ok(
      content.includes(`The MCP submission (\`${terminalTools[name]}\`)`),
      `${name} must name its authoritative terminal MCP tool`,
    );
    assert.ok(
      content.includes(
        `write the ${finalReportLabels[name]} as a non-empty normal assistant text response`,
      ),
      `${name} must require its role-specific final report`,
    );
    assert.match(
      content,
      /Do not end\s+immediately after the tool call/,
      `${name} must forbid ending immediately after the submission tool call`,
    );
  }
  const committer = opencode("committer.md");
  assert.ok(
    committer.includes("The report is required whether the commit succeeded or failed."),
    "committer terminal report must apply whether the commit succeeded or failed",
  );
});

test("Codex TOML never carries the OpenCode-only terminal response section", () => {
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    const toml = readFileSync(resolve(agentsDir, `${role}.toml`), "utf8");
    assert.ok(
      !toml.includes(OPENCODE_TERMINAL_SECTION_HEADING),
      `${role} Codex TOML must not carry the OpenCode-only section heading`,
    );
    assert.ok(
      !toml.includes("non-empty normal assistant text response"),
      `${role} Codex TOML must not carry the OpenCode-only response invariant`,
    );
    assert.ok(
      !toml.includes("Do not end immediately after the tool call"),
      `${role} Codex TOML must not carry the OpenCode-only ordering phrase`,
    );
  }
});

test("contract fragments are host-neutral and each host injects its own identity", () => {
  const contractsDir = resolve(import.meta.dir, "../contracts");
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    const contract = readFileSync(resolve(contractsDir, `${role}.md`), "utf8");
    assert.ok(
      contract.includes("__HOST_IDENTITY__"),
      `${role} contract must carry the identity marker`,
    );
    assert.ok(!contract.includes("gpt-5.6"), `${role} contract must not hard-code a Codex model`);
    assert.ok(
      !contract.includes("deepseek"),
      `${role} contract must not hard-code an OpenCode model`,
    );
    const toml = readFileSync(resolve(agentsDir, `${role}.toml`), "utf8");
    assert.match(
      toml,
      /"Agent: \w+ \| Model: [^"|]+\| Reasoning: \w+"/,
      `${role} Codex definition must announce the Codex model and reasoning effort`,
    );
    const expectedModel = "openai/gpt-5.6-luna";
    assert.match(
      opencode(`${role}.md`),
      new RegExp(`"Agent: ${role} \\| Model: ${expectedModel}"`),
      `${role} OpenCode definition must announce its OpenCode Go provider/model ID`,
    );
  }
});

test("role contracts require native workflow transport and forbid alternate access", () => {
  const contractsDir = resolve(import.meta.dir, "../contracts");
  const required = [
    "Host-provided `workflow_state_*` tools are the only authorized workflow transport.",
    "Do not import the MCP client SDK",
    "launch `server.ts`, `bootstrap.ts`, or `runtime-supervisor.ts`",
    "invoke MCP through shell/Bun/Node scripts",
    "access Workflow MCP SQLite files directly",
    "never use an alternate transport",
  ];
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    const contract = readFileSync(resolve(contractsDir, `${role}.md`), "utf8");
    const normalizedContract = contract.replace(/\s+/gu, " ");
    const generated = Object.entries(generateDefinitions()).find(([path]) =>
      path.endsWith(`/${role}.toml`),
    )?.[1];
    assert.ok(generated, `${role} Codex definition must be generated`);
    for (const phrase of required) {
      assert.ok(normalizedContract.includes(phrase), `${role} contract must include: ${phrase}`);
      assert.ok(
        generated.replace(/\s+/gu, " ").includes(phrase),
        `${role} definition must include: ${phrase}`,
      );
    }
  }
});
