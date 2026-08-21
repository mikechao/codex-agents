import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TOML } from "bun";
import {
  CODEX_WORKFLOW_MCP_ENABLED_TOOLS,
  generateDefinitions,
  loadModelPolicy,
  OPENCODE_TERMINAL_SECTION_HEADING,
  parseModelPolicy,
  resolveModelPolicy,
  SELF_HOST_CODEX_WORKFLOW_MCP,
} from "../generate-host-definitions.js";

const agentsDir = resolve(import.meta.dir, "..");

for (const [path, content] of Object.entries(generateDefinitions())) {
  const relative = path.slice(agentsDir.length + 1);
  test(`generated ${relative} is current`, () => {
    assert.ok(existsSync(path), `missing generated file: ${path}`);
    assert.equal(readFileSync(path, "utf8"), content);
  });
}

test("Codex workers have exact fail-closed Workflow MCP allowlists", () => {
  const parentOnlyTools = [
    "workflow_create",
    "workflow_get_audit",
    "workflow_expand_scope",
    "workflow_authorize_commit",
  ];
  for (const role of ["implementer", "code_reviewer", "committer"] as const) {
    const content = readFileSync(resolve(agentsDir, `${role}.toml`), "utf8");
    const parsed = TOML.parse(content) as {
      mcp_servers?: {
        workflow_state?: {
          enabled?: unknown;
          command?: unknown;
          url?: unknown;
          args?: unknown;
          startup_timeout_sec?: unknown;
          tool_timeout_sec?: unknown;
          required?: unknown;
          default_tools_approval_mode?: unknown;
          enabled_tools?: unknown;
        };
      };
    };
    const server = parsed.mcp_servers?.workflow_state;
    assert.ok(server, `${role} must declare workflow_state`);
    assert.equal(server.enabled, false, `${role} self-host registration must stay disabled`);
    assert.equal(server.command, SELF_HOST_CODEX_WORKFLOW_MCP.command);
    assert.deepEqual(server.args, SELF_HOST_CODEX_WORKFLOW_MCP.args);
    assert.equal(server.url, undefined, `${role} must use stdio rather than URL transport`);
    assert.equal(server.startup_timeout_sec, SELF_HOST_CODEX_WORKFLOW_MCP.startupTimeoutSec);
    assert.equal(server.tool_timeout_sec, SELF_HOST_CODEX_WORKFLOW_MCP.toolTimeoutSec);
    assert.equal(server.required, SELF_HOST_CODEX_WORKFLOW_MCP.required);
    assert.equal(
      server.default_tools_approval_mode,
      SELF_HOST_CODEX_WORKFLOW_MCP.defaultToolsApprovalMode,
    );
    const enabledTools = server.enabled_tools;
    assert.deepEqual(enabledTools, CODEX_WORKFLOW_MCP_ENABLED_TOOLS[role]);
    assert.ok(Array.isArray(enabledTools) && enabledTools.length > 0);
    assert.ok(!content.includes('enabled_tools = ["*"]'));
    for (const tool of parentOnlyTools) assert.ok(!enabledTools.includes(tool));
    for (const otherRole of ["implementer", "code_reviewer", "committer"] as const) {
      for (const tool of CODEX_WORKFLOW_MCP_ENABLED_TOOLS[otherRole]) {
        if (!(CODEX_WORKFLOW_MCP_ENABLED_TOOLS[role] as readonly string[]).includes(tool)) {
          assert.ok(!enabledTools.includes(tool), `${role} must exclude ${tool}`);
        }
      }
    }
  }
});

test("Workflow MCP isolation stays in typed host metadata, not model policy", () => {
  const policy = readFileSync(resolve(agentsDir, "model-policy.yaml"), "utf8");
  assert.doesNotMatch(policy, /enabled_tools|workflow_state|workflow_submit/u);
  for (const role of ["implementer", "code_reviewer", "committer"] as const) {
    const content = readFileSync(resolve(agentsDir, `${role}.toml`), "utf8");
    assert.doesNotMatch(content, /workflow_state_workflow_/u);
    assert.match(content, /\[mcp_servers\.workflow_state\]/u);
  }
});

const opencode = (name: string) =>
  readFileSync(resolve(import.meta.dir, "../../../.opencode/agents", name), "utf8");

test("reusable agent definitions contain no concrete work-item instances", () => {
  const orchestratorPath = resolve(import.meta.dir, "../../../.opencode/agents/orchestrator.md");
  const definitions = [
    ...Object.entries(generateDefinitions()),
    [orchestratorPath, readFileSync(orchestratorPath, "utf8")],
  ] as const;
  for (const [path, content] of definitions) {
    assert.doesNotMatch(content, /^\s*Refs\s+#\d+\s*$/mu, `${path} contains a numeric Refs line`);
    assert.doesNotMatch(
      content,
      /display_ref[^\n]*#\d+/u,
      `${path} contains a concrete display_ref value`,
    );
    assert.doesNotMatch(
      content,
      /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+/u,
      `${path} contains a concrete GitHub issue URL`,
    );
  }
});

test("commit references use real Git message paragraphs", () => {
  const repository = mkdtempSync(resolve(tmpdir(), "agent-contract-git-"));
  const git = (args: string[]) =>
    execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });

  try {
    git(["init", "--quiet"]);
    git(["config", "user.name", "Contract Test"]);
    git(["config", "user.email", "contract-test@example.com"]);
    writeFileSync(resolve(repository, "tracked.txt"), "contract test\n");
    git(["add", "tracked.txt"]);
    git(["commit", "--quiet", "-m", "Add contract test"]);

    const subject = "Verify neutral work-item references";
    const body = "Keep commit paragraphs separate.";
    git(["commit", "--quiet", "--allow-empty", "-m", subject, "-m", body, "-m", "Refs #30"]);
    const message = git(["show", "-s", "--format=%B", "HEAD"]);

    assert.equal(message, `${subject}\n\n${body}\n\nRefs #30\n\n`);
    assert.ok(!message.includes("\\n"), "commit message must not contain literal backslash-n text");
    assert.ok(!message.includes("Refs #47"), "regression commit must use the alternate work item");
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test("the default model policy preserves the effective host assignments", () => {
  const policy = loadModelPolicy();
  assert.deepEqual(resolveModelPolicy(policy, "implementer", "codex"), {
    model: "gpt-5.6-luna",
    reasoning: "high",
  });
  assert.deepEqual(resolveModelPolicy(policy, "code_reviewer", "codex"), {
    model: "gpt-5.6-sol",
    reasoning: "medium",
  });
  assert.deepEqual(resolveModelPolicy(policy, "code_reviewer", "opencode"), {
    model: "openai/gpt-5.6-luna",
    reasoning: "high",
  });
});

test("model aliases and host-specific reasoning resolve independently", () => {
  const policy = parseModelPolicy(`models:
  luna:
    codex: codex-new
    opencode: provider/new
agents:
  implementer:
    codex:
      model: luna
      reasoning: low
    opencode:
      model: luna
      reasoning: medium
  code_reviewer:
    codex:
      model: luna
      reasoning: low
    opencode:
      model: luna
      reasoning: low
  committer:
    codex:
      model: luna
      reasoning: low
    opencode:
      model: luna
      reasoning: low
`);
  assert.deepEqual(resolveModelPolicy(policy, "implementer", "codex"), {
    model: "codex-new",
    reasoning: "low",
  });
  assert.deepEqual(resolveModelPolicy(policy, "implementer", "opencode"), {
    model: "provider/new",
    reasoning: "medium",
  });
});

test("model policy validation rejects malformed structures and unsafe values", () => {
  const base = `models:
  luna:
    codex: gpt-5.6-luna
    opencode: openai/gpt-5.6-luna
agents:
  implementer:
    codex: { model: luna, reasoning: high }
    opencode: { model: luna, reasoning: high }
  code_reviewer:
    codex: { model: luna, reasoning: high }
    opencode: { model: luna, reasoning: high }
  committer:
    codex: { model: luna, reasoning: high }
    opencode: { model: luna, reasoning: high }
`;
  assert.throws(() => parseModelPolicy("not: [valid"), /malformed YAML/);
  assert.throws(
    () => parseModelPolicy(base.replace("  luna:\n", "  luna:\n  luna:\n")),
    /duplicate key models\.luna/,
  );
  assert.throws(
    () => parseModelPolicy(base.replace("  committer:\n", "")),
    /expected exactly|malformed YAML|duplicate key/,
  );
  assert.throws(() => parseModelPolicy(`${base}extra: true\n`), /expected exactly/);
  assert.throws(
    () => parseModelPolicy(base.replace("model: luna", "model: missing")),
    /unknown model alias/,
  );
  assert.throws(
    () => parseModelPolicy(base.replace("reasoning: high", "reasoning: xhigh")),
    /reasoning must be one of/,
  );
  assert.throws(
    () => parseModelPolicy(base.replace("codex: gpt-5.6-luna", "codex: bad model")),
    /safely renderable/,
  );
});

test("OpenCode definitions are subagents with host-native permissions", () => {
  const policy = loadModelPolicy();
  for (const name of ["implementer.md", "code_reviewer.md", "committer.md"]) {
    const role = name.replace(/\.md$/, "") as "implementer" | "code_reviewer" | "committer";
    const assignment = resolveModelPolicy(policy, role, "opencode");
    const content = opencode(name);
    assert.match(content, /^---\n/, `${name} must start with YAML frontmatter`);
    assert.match(content, /^mode: subagent$/m, `${name} must be a subagent`);
    assert.match(
      content,
      new RegExp(`^model: ${assignment.model}$`, "m"),
      `${name} must pin its configured OpenCode model`,
    );
    assert.match(
      content,
      new RegExp(`^reasoningEffort: ${assignment.reasoning}$`, "m"),
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
  const frontmatter = content.split("---\n")[1] ?? "";
  assert.notEqual(frontmatter, "", "reviewer must have frontmatter");
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
    '"git grep": allow',
    '"git grep *": allow',
    '"bun .codex/agents/change-receipt.ts *": allow',
    '"bun .codex/agents/reviewer-validation.ts *": allow',
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
    "revert",
    "cherry-pick",
    "rm",
    "mv",
    "clean",
    "stash",
  ]) {
    assert.ok(
      !new RegExp(`^\\s+"git ${denied}[^"]*": allow$`, "m").test(frontmatter),
      `reviewer bash must not allow git ${denied}`,
    );
  }
  assert.match(content, /^  workflow_state_workflow_submit_review: allow$/m);
  assert.match(content, /^  workflow_state_workflow_begin_review: allow$/m);
  assert.ok(!content.includes("workflow_state_workflow_prepare_commit"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
});

test("reviewer validation is the only executable validation path", () => {
  const content = opencode("code_reviewer.md");
  assert.ok(content.includes('"bun .codex/agents/reviewer-validation.ts *": allow'));
  assert.ok(!content.includes('"bun run *": allow'));
  assert.ok(!content.includes('"npm *": allow'));
  assert.ok(!content.includes('"npx *": allow'));
});

test("reviewer contract distinguishes absent, required, and unknown path states", () => {
  const contract = readFileSync(
    resolve(import.meta.dir, "../contracts/code_reviewer.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  for (const phrase of [
    "exact path allowlist and scope-accounting obligation",
    "not as an assertion that every working-tree path must exist",
    "provably absent path",
    "required-but-absent artifact",
    "actionable blocking finding describing the required artifact",
    "unknown, contradictory, or uninspectable",
    "path absent at both endpoints is rejected",
    "semantic review corpus",
    "all tracked repository content in the working tree plus present untracked files",
    "Unrelated untracked files and ignored files are outside the semantic corpus",
    "does not authorize a checkout-wide untracked search",
    "git grep",
    "Git grep exit code `1` means no matches",
    "contextual searches do not expand workflow scope",
    "tracked content at `head_revision` only",
    "do not mask an observable validation failure",
  ]) {
    assert.ok(contract.includes(phrase), `reviewer contract must include: ${phrase}`);
  }
});

test("reviewer contract keeps semantic context separate from ownership and validation", () => {
  const contract = readFileSync(
    resolve(import.meta.dir, "../contracts/code_reviewer.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  assert.match(contract, /approved untracked path separately with an exact literal path read/);
  assert.match(contract, /Do not use `git grep --untracked`, `--no-index`/);
  assert.match(contract, /`--recurse-submodules`/);
  assert.match(contract, /Semantic corpus filtering does not change validation execution/);
  assert.match(contract, /ambient checkout state/);
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

test("committer references are authoritative, neutral, and non-closing", () => {
  const contract = readFileSync(resolve(import.meta.dir, "../contracts/committer.md"), "utf8");
  for (const phrase of [
    "sole authoritative source of work-item references",
    "Refs <display_ref>",
    "preserving its exact spelling",
    "Emit no reference",
    "infer references from prompts",
    "Fixes`, `Closes`, `Resolves",
    "Do not add a runtime commit-message formatter",
    "tracker API",
  ]) {
    assert.ok(contract.includes(phrase), `committer contract must include: ${phrase}`);
  }
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
    const expectedModel = resolveModelPolicy(
      loadModelPolicy(),
      role as "implementer" | "code_reviewer" | "committer",
      "opencode",
    ).model;
    assert.match(
      opencode(`${role}.md`),
      new RegExp(`"Agent: ${role} \\| Model: ${expectedModel}(?: \\| Reasoning: \\w+)?"`),
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
