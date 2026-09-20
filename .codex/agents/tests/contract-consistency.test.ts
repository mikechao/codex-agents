import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TOML } from "bun";
import { openCodePlanAgent } from "../../../install-into.js";
import { PARENT_WORKFLOW_ACTION_VALUES } from "../../workflow-mcp/workflow-action-registry.js";
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

function opencodeBashPermission(content: string, command: string): string {
  const rules = [
    ...content.matchAll(
      /^  - action: (?:"((?:\\.|[^"\\])*)"|([^\n]+))\n    resource: "((?:\\.|[^"\\])*)"\n    effect: (allow|ask|deny)$/gmu,
    ),
  ]
    .filter((match) => (match[1] ?? match[2]) === "shell")
    .map((match) => ({
      pattern: JSON.parse(`"${match[3]}"`) as string,
      action: match[4] as string,
    }));
  let action = "ask";
  for (const rule of rules) {
    let source = "^";
    for (const character of rule.pattern) {
      if (character === "*") source += "[\\s\\S]*";
      else if (character === "?") source += "[\\s\\S]";
      else source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
    if (new RegExp(`${source}$`, "u").test(command)) action = rule.action;
  }
  return action;
}

function assertOpenCodePermission(
  content: string,
  action: string,
  resource: string,
  effect: "allow" | "ask" | "deny",
): void {
  assert.match(
    content,
    new RegExp(
      `^  - action: ${action}\\n    resource: "${resource}"\\n    effect: ${effect}$`,
      "m",
    ),
  );
}

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
  assert.deepEqual(resolveModelPolicy(policy, "planner", "opencode"), {
    model: "openai/gpt-5.6-luna",
    reasoning: "high",
  });
  assert.deepEqual(resolveModelPolicy(policy, "explorer", "opencode"), {
    model: "openai/gpt-5.6-sol",
    reasoning: "low",
  });
  assert.throws(() => resolveModelPolicy(policy, "planner", "codex"), /No model policy assignment/);
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
      new RegExp(`^model: ${assignment.model}#${assignment.reasoning}$`, "m"),
      `${name} must pin its configured OpenCode model`,
    );
    assert.match(
      content,
      /^  - action: subagent\n    resource: "\*"\n    effect: deny$/m,
      `${name} must not delegate`,
    );
    assert.match(
      content,
      /^  - action: workflow_state_\*\n    resource: "\*"\n    effect: deny$/m,
      `${name} must gate MCP tools behind the role allowlist`,
    );
    const getter =
      role === "implementer"
        ? "workflow_implementer_get"
        : role === "code_reviewer"
          ? "workflow_reviewer_get"
          : "workflow_committer_get";
    assert.match(
      content,
      new RegExp(
        `^  - action: workflow_state_${getter}\\n    resource: "\\*"\\n    effect: allow$`,
        "m",
      ),
    );
  }
});

test("OpenCode permissions remain ordered native V2 rules", () => {
  const generator = readFileSync(resolve(agentsDir, "generate-host-definitions.ts"), "utf8");
  assert.match(generator, /permissions: readonly OpenCodePermissionRule\[\]/u);
  assert.doesNotMatch(generator, /permission: string\[\]/u);
  assert.doesNotMatch(generator, /function openCodePermissionRules/u);

  for (const name of [
    "implementer.md",
    "code_reviewer.md",
    "committer.md",
    "planner.md",
    "explorer.md",
  ]) {
    const content = opencode(name);
    assert.match(content, /^permissions:\n/mu);
    assert.doesNotMatch(content, /^permission:/mu);
    assert.doesNotMatch(content, /^\s+(bash|task):/mu);
  }
});

test("planning definitions are OpenCode-only and least-authority isolated", () => {
  const generated = Object.keys(generateDefinitions());
  assert.ok(generated.some((path) => path.endsWith("/.opencode/agents/planner.md")));
  assert.ok(generated.some((path) => path.endsWith("/.opencode/agents/explorer.md")));
  assert.ok(!generated.some((path) => path.endsWith("/.codex/agents/planner.toml")));
  assert.ok(!generated.some((path) => path.endsWith("/.codex/agents/explorer.toml")));

  const planner = opencode("planner.md");
  assert.match(planner, /^mode: subagent$/m);
  assert.match(planner, /^  - action: subagent\n    resource: "\*"\n    effect: deny$/m);
  assert.match(planner, /^  - action: subagent\n    resource: "explorer"\n    effect: allow$/m);
  assert.deepEqual(
    [
      ...planner.matchAll(
        /^  - action: (workflow_state_[^\n]+)\n    resource: "\*"\n    effect: allow$/gmu,
      ),
    ].map((match) => match[1]),
    ["workflow_state_plan_create", "workflow_state_plan_get", "workflow_state_plan_revise"],
  );
  for (const tool of ["plan_create", "plan_get", "plan_revise"]) {
    assert.match(
      planner,
      new RegExp(
        `^  - action: workflow_state_${tool}\\n    resource: "\\*"\\n    effect: allow$`,
        "m",
      ),
    );
  }
  for (const forbidden of [
    "workflow_state_plan_parent_get",
    "workflow_state_plan_approve",
    "workflow_state_workflow_create",
    "workflow_state_workflow_create_from_plan",
    "workflow_state_workflow_submit_implementation",
  ]) {
    assert.ok(!planner.includes(forbidden), `planner must not expose ${forbidden}`);
  }
  for (const denied of [
    "external_directory",
    "lsp",
    "skill",
    "todowrite",
    "todoread",
    "doom_loop",
    "question",
  ]) {
    assertOpenCodePermission(planner, denied, "\\*", "deny");
  }
  for (const allowed of ["webfetch", "websearch"]) {
    assertOpenCodePermission(planner, allowed, "\\*", "allow");
    assert.ok(
      !planner.includes(`- action: ${allowed}\\n    resource: "*"\\n    effect: deny`),
      `planner must allow ${allowed}`,
    );
  }

  const explorer = opencode("explorer.md");
  assert.match(explorer, /^hidden: true$/m);
  assertOpenCodePermission(explorer, "edit", "\\*", "deny");
  assertOpenCodePermission(explorer, "shell", "\\*", "deny");
  for (const allowed of [
    "git status",
    "git status --short",
    "git status --porcelain",
    "git diff",
    "git diff --cached",
    "git diff HEAD",
    "git log",
    "git log -1",
    "git log --oneline",
    "git show",
    "git show HEAD",
    "git rev-parse --show-toplevel",
    "git rev-parse --is-inside-work-tree",
    "git ls-files",
    "git grep",
  ]) {
    assertOpenCodePermission(explorer, "shell", allowed, "allow");
  }
  for (const unsafe of [
    'resource: "git status *"',
    'resource: "git diff *"',
    'resource: "git log *"',
    'resource: "git show *"',
    'resource: "git rev-parse *"',
    'resource: "git ls-files *"',
    'resource: "git grep *"',
    "git diff --output",
    "git diff --no-index",
  ]) {
    assert.ok(!explorer.includes(unsafe), `explorer must reject unsafe Git pattern ${unsafe}`);
  }
  assertOpenCodePermission(explorer, "subagent", "\\*", "deny");
  assertOpenCodePermission(explorer, "workflow_state_\\*", "\\*", "deny");
  assert.ok(!explorer.includes("workflow_state_plan_create"));
  for (const role of ["implementer", "code_reviewer", "committer", "planner"])
    assertOpenCodePermission(opencode(`${role}.md`), "runEvidence", "\\*", "deny");
  assertOpenCodePermission(explorer, "inspectGitRange", "\\*", "allow");
  for (const role of ["implementer", "code_reviewer", "committer", "planner"])
    assertOpenCodePermission(opencode(`${role}.md`), "inspectGitRange", "\\*", "deny");
});

test("planning contracts enforce bounded synthesis and disposable context", () => {
  const contractsDir = resolve(import.meta.dir, "../contracts");
  const planner = readFileSync(resolve(contractsDir, "planner.md"), "utf8");
  const explorer = readFileSync(resolve(contractsDir, "explorer.md"), "utf8");
  for (const phrase of [
    "zero through four",
    "A fifth explorer is forbidden",
    "PlannerHandoff",
    "plan_get",
    "exact argv array",
    "same length, ordering, and every value",
    "needs_input",
    "transcripts",
    "Do not implement, edit, review, stage, commit, approve",
    "Native Plan owns standalone audit, research, explain, trace, and",
    "change-oriented implementation plan",
    "freshly inspect the current repository",
    "Every explorer task payload must explicitly include",
    "authorized parent: planner",
    "authorized evidence topic",
    "scope and boundaries",
  ]) {
    assert.ok(planner.includes(phrase), `planner contract must include: ${phrase}`);
  }
  assert.match(
    planner.replace(/\s+/gu, " "),
    /report selected for action is bounded/u,
    "planner contract must keep report context bounded",
  );
  for (const phrase of [
    "at most 20 findings",
    "at most 50 relevant exact repository-relative paths",
    "at most 10 risks",
    "most 10 questions",
    "Recursive fan-out is forbidden",
    "Workflow MCP tools",
    "explicitly authorized",
    "purpose: evidence",
    "observed",
    "executable",
    "documented",
    "inference",
    "recommended_change",
    "InvestigationPlan",
    "The parent, not explorer,",
  ]) {
    assert.ok(explorer.includes(phrase), `explorer contract must include: ${phrase}`);
  }
  assert.ok(!planner.includes("gpt-5.6"));
  assert.ok(!explorer.includes("gpt-5.6"));
  const normalizedExplorer = explorer.replace(/\s+/gu, " ");
  for (const forbidden of [
    "approved paths",
    "acceptance criteria",
    "plan approval fields",
    "workflow data",
  ]) {
    assert.match(normalizedExplorer, new RegExp(`Do not return.*${forbidden}`, "u"));
  }
});

test("explorer exposes only the structured evidence capability", () => {
  const explorer = opencode("explorer.md");
  assert.match(explorer, /^  - action: runEvidence\n    resource: "\*"\n    effect: allow$/m);
  assert.ok(!explorer.includes("reviewer-validation.ts --evidence-id"));
  assert.equal(
    opencodeBashPermission(
      explorer,
      "bun .codex/agents/reviewer-validation.ts --evidence-id EVIDENCE-1 --argv-json []",
    ),
    "deny",
  );
});

test("Explorer revision inspection is structured, isolated, and shell-free", () => {
  const explorer = opencode("explorer.md");
  const source = readFileSync(
    resolve(import.meta.dir, "../../../.opencode/plugins/codex-agents-explorer-tools/index.ts"),
    "utf8",
  );
  assert.match(explorer, /^  - action: inspectGitRange\n    resource: "\*"\n    effect: allow$/m);
  assert.match(source, /Plugin\.define/u);
  assert.match(source, /ctx\.tool\.transform/u);
  assert.match(source, /name: "inspectGitRange"/u);
  assert.match(source, /base: \{ type: "string", minLength: 1, maxLength: MAX_REVISION_LENGTH \}/u);
  assert.match(source, /head: \{ type: "string", minLength: 1, maxLength: MAX_REVISION_LENGTH \}/u);
  assert.match(source, /toolContext\.agent !== "explorer"/u);
  assert.match(source, /content:/u);
  assert.match(source, /output:/u);
  assert.doesNotMatch(source, /@opencode-ai\/plugin/u);
  assert.doesNotMatch(source, /\btool\(/u);
  assert.doesNotMatch(source, /title:/u);
  const implementation = readFileSync(
    resolve(
      import.meta.dir,
      "../../../.opencode/plugins/codex-agents-explorer-tools/inspect-git-range.ts",
    ),
    "utf8",
  );
  assert.match(implementation, /shell: false/u);
  assert.match(implementation, /--end-of-options/u);
  assert.match(implementation, /--no-renames/u);
  assert.match(implementation, /, "--"\]/u);
  for (const forbidden of ["Bun.$", "runEvidence", "workflow_state", "--output", "--no-index"])
    assert.ok(!implementation.includes(forbidden), `range tool must not expose ${forbidden}`);
});

test("planner clarification and native Plan refinement remain portable and fail closed", () => {
  const canonical = readFileSync(resolve(agentsDir, "contracts/planner.md"), "utf8");
  const generated = opencode("planner.md");
  const materializedPlan = openCodePlanAgent() as {
    permissions: unknown[];
    system: string;
  };
  const planPrompt = materializedPlan.system;
  const planConfig = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../opencode.json"), "utf8"),
  ) as { agents: { plan: { system: string; permissions: unknown[] } } };
  const planCopies = [planPrompt, planConfig.agents.plan.system];

  for (const contract of [canonical, generated]) {
    const normalized = contract.replace(/\s+/gu, " ");
    assert.match(
      normalized,
      /Inspect the repository and all applicable repository-owned policy before deciding/u,
    );
    assert.match(normalized, /complete draft.*existing planning operation.*`needs_input`/u);
    assert.match(normalized, /semantic `questions`.*bounded `risks`/u);
    assert.match(normalized, /Do not make a speculative choice.*directly question the user/u);
    assert.match(
      normalized,
      /exact `plan_id`, exact current base revision, and bounded answer or context/u,
    );
    assert.match(normalized, /Call `plan_get` first.*exact identity and revision/u);
    assert.match(
      normalized,
      /only after.*complete.*current.*answer\/context is sufficient.*`plan_revise`/iu,
    );
    assert.match(
      normalized,
      /Missing, stale, malformed, contradictory, or ambiguous.*fails closed/u,
    );
    assert.match(
      normalized,
      /no approval, validation-policy, scope, workflow, repair, reconciliation, commit, or execution authority/u,
    );
    assert.match(normalized, /clarification\/session\/task\/child state/u);
    assert.match(
      normalized,
      /same-child, same-invocation, host-lifecycle, task, session, or continuation identity/u,
    );
  }

  for (const prompt of planCopies) {
    const normalized = prompt.replace(/\s+/gu, " ");
    assert.match(
      normalized,
      /Every explorer task payload must explicitly include.*authorized parent: Native Plan.*authorized evidence topic: <exactly one bounded topic>.*scope and boundaries:/u,
      "Native Plan explorer dispatch must carry explicit authorization and bounds",
    );
    assert.match(
      normalized,
      /Do not dispatch explorer without that explicit parent, exactly one topic, and scope\/boundary context/u,
    );
    assert.match(normalized, /`needs_input`.*present.*once/u);
    assert.match(normalized, /Do not invoke a question tool.*without new user input/u);
    assert.match(
      normalized,
      /fresh refinement.*answer\/context.*exact `plan_id`.*exact base revision/u,
    );
    assert.match(
      normalized,
      /missing, stale, malformed, conflicting, or ambiguous.*stop without guessing or revising/u,
    );
    assert.match(normalized, /never create a workflow or dispatch an implementer/iu);
  }

  assert.ok(
    planConfig.agents.plan.permissions.some((rule) =>
      JSON.stringify(rule).includes('"action":"question"'),
    ),
  );
  assert.deepEqual(planConfig.agents.plan.permissions, materializedPlan.permissions);
  assert.ok(
    planConfig.agents.plan.permissions.some((rule) =>
      JSON.stringify(rule).includes('"action":"workflow_state_plan_parent_get"'),
    ),
  );
  assert.ok(
    !planConfig.agents.plan.permissions.some((rule) =>
      JSON.stringify(rule).includes('"action":"workflow_state_plan_get"'),
    ),
  );
});

test("planner preserves authoritative task-source provenance boundaries", () => {
  const canonical = readFileSync(resolve(import.meta.dir, "../contracts/planner.md"), "utf8");
  const generated = opencode("planner.md");
  for (const definition of [canonical, generated]) {
    const normalized = definition.replace(/\s+/gu, " ");
    assert.match(
      normalized,
      /invocation supplies the authoritative contents[^.]*use those contents directly as the planning requirements/u,
      "supplied authoritative source content must be used directly",
    );
    assert.match(
      normalized,
      /Do not independently retrieve the referenced source merely to duplicate, verify, or refresh supplied authoritative content/u,
      "complete supplied content must not trigger redundant retrieval",
    );
    assert.match(
      normalized,
      /required information is missing[^.]*explicitly incomplete[^.]*caller requests verification or a freshness check[^.]*external\/background research materially helps resolve the task/u,
      "retrieval eligibility exceptions must remain explicit",
    );
    assert.match(
      normalized,
      /Repository inspection remains mandatory regardless of supplied source contents[^.]*current code, tests, generated artifacts, documentation, and repository-owned policies/u,
      "repository investigation must remain mandatory",
    );
    assert.match(
      normalized,
      /redundant retrieval failure does not create a `needs_input` condition when the supplied authoritative contents are complete/u,
      "redundant retrieval failure must not require input",
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
  assert.match(content, /^  - action: edit\n    resource: "\*"\n    effect: deny$/m);
  assert.match(content, /^  - action: subagent\n    resource: "\*"\n    effect: deny$/m);
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    assert.match(
      content,
      new RegExp(`^  - action: subagent\\n    resource: "${role}"\\n    effect: allow$`, "m"),
    );
  }
  assert.ok(!content.includes('resource: "planner"'));
  assert.match(content, /^  - action: workflow_state_\*\n    resource: "\*"\n    effect: deny$/m);
  const allowedWorkflowTools = [
    ...content.matchAll(
      /^  - action: (workflow_state_[^\n]+)\n    resource: "\*"\n    effect: allow$/gmu,
    ),
  ]
    .map((match) => match[1].replace(/^workflow_state_/u, ""))
    .sort();
  assert.deepEqual(
    allowedWorkflowTools,
    [
      "plan_parent_get",
      "workflow_create_from_plan",
      "workflow_operator_decision_get",
      ...PARENT_WORKFLOW_ACTION_VALUES,
    ].sort(),
  );
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    assert.ok(
      !opencode(`${role}.md`).includes("workflow_state_workflow_reconcile_commit_result"),
      `${role} must not expose the parent-only reconciliation tool`,
    );
  }
  assert.ok(!content.includes("workflow_state_workflow_submit_implementation"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
  assert.ok(!content.includes("workflow_state_plan_approve"));
  assert.match(content, /workflow_create_from_plan/);
  assert.match(content, /workflow_create_linked_followup_from_plan/);
  assert.match(content, /immediately preceding Native Plan handoff/);
  assert.match(content, /without asking the user to repeat/);
  assert.match(content, /generic.*pasted prose.*not authority/u);
  const normalizedContent = content.replace(/\s+/gu, " ");
  assert.match(normalizedContent, /do not pass pasted plan text/);
  assert.match(normalizedContent, /never pass or retranscribe its full plan/);
  for (const phrase of [
    "Standalone audit, research, explain, trace, and report requests",
    "Fail closed with bounded direction to use Native Plan",
    "Do not improvise repository",
    "dispatch `explorer`",
    "create a change Workflow for a report",
    "become a second planner",
  ]) {
    assert.ok(content.includes(phrase), `missing standalone research boundary: ${phrase}`);
  }

  const runtimeBoundary = content.replace(/\s+/gu, " ");
  for (const phrase of [
    "established both self-hosting context",
    "actual dependency on newer behavior present in the current repository or checkout but unavailable to the loaded runtime",
    "known self-hosting runtime/bootstrap boundary",
    "preserve authoritative Workflow MCP state",
    "existing documented reload/bootstrap boundary",
    "bounded MCP recovery model above",
    "future repository or checkout semantics as live",
    "manufacture a replacement authority path",
    "broaden scope",
    "create a replacement workflow solely",
    "recognition and routing optimization",
  ]) {
    assert.ok(runtimeBoundary.includes(phrase), `missing live-runtime boundary: ${phrase}`);
  }
  assert.match(
    runtimeBoundary,
    /Ordinary repository or checkout changes that do not create this actual dependency must not trigger reload handling/u,
  );
  const classify = runtimeBoundary.indexOf(
    "immediately classify the condition as the known self-hosting runtime/bootstrap boundary",
  );
  const substitute = runtimeBoundary.indexOf("Do not explore in-place substitutes");
  assert.ok(
    classify >= 0 && classify < substitute,
    "classification must precede substitute handling",
  );
});

test("normal execution is self-contained and MCP outage handling is recovery-only", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  assert.doesNotMatch(orchestrator, /Read `\.codex\/agents\/WORKFLOW\.md` before coordinating/u);
  assert.match(orchestrator, /explanatory architecture documentation, not a runtime precondition/u);
  assert.match(orchestrator, /suspend authoritative workflow execution/u);
  assert.match(orchestrator, /never implement, review, repair, authorize validation/iu);
  assert.match(orchestrator, /never use an alternate transport/u);

  for (const role of ["implementer", "code_reviewer", "committer"] as const) {
    const canonical = readFileSync(resolve(agentsDir, `contracts/${role}.md`), "utf8").replace(
      /\s+/gu,
      " ",
    );
    const generated = (
      role === "code_reviewer" ? opencode("code_reviewer.md") : opencode(`${role}.md`)
    ).replace(/\s+/gu, " ");
    for (const definition of [canonical, generated]) {
      assert.doesNotMatch(definition, /WORKFLOW\.md/u);
      assert.match(
        definition,
        /authoritative .*work|authoritative .*review|authoritative .*commit/u,
      );
      assert.match(definition, /bounded.*non-authoritative/u);
      assert.match(definition, /native .*getter again/u);
      assert.match(definition, /never use an alternate MCP transport/u);
    }
  }

  const workflow = readFileSync(resolve(agentsDir, "WORKFLOW.md"), "utf8").replace(/\s+/gu, " ");
  assert.match(workflow, /explanatory architecture documentation/u);
  assert.match(workflow, /does not define a degraded handoff schema/u);
});

test("orchestrator presents semantic proposals and consumes descriptor inputs", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  const contracts = [orchestrator, guide];

  for (const contract of contracts) {
    assert.match(contract, /semantic (?:decisions|choice|user choice)/u);
    assert.match(contract, /concrete safe proposal/u);
    assert.match(contract, /descriptor/u);
    assert.match(contract, /consequence|outcome/u);
    assert.match(contract, /exact (?:visible )?repository-relative/u);
    assert.match(contract, /not (?:authorization|a proposal store|a bearer capability)/u);
    assert.match(contract, /internal.*(?:action\/phase|action\/tool).*names/u);
    assert.match(contract, /contextual `yes`|`yes`, `continue`, `go ahead`, and `commit it`/iu);
    assert.match(contract, /ordinary equivalent wording|contextual `yes`/iu);
    assert.match(contract, /ambiguous.*fail(?:s)? closed/u);
    assert.match(contract, /After (?:(?:any )?required )?affirmative input.*(?:refetch|re-read)/u);
    assert.match(contract, /durable proposal state/u);
    assert.match(contract, /parent_context/u);
    assert.match(
      contract,
      /(?:undeclared.*fail(?:s)? closed|does not declare.*fail(?:s)? closed)/u,
    );
  }

  const proposal = orchestrator.indexOf("Present one concrete safe proposal");
  const question = orchestrator.indexOf("genuine user-owned choice", proposal);
  const affirmative = orchestrator.indexOf("For `parent_mutation`, follow", question);
  assert.ok(proposal >= 0 && proposal < question && question < affirmative);
  assert.match(orchestrator, /negative, ambiguous, unrelated, changed, or stale response/u);
  assert.match(orchestrator, /authorization\.required.*(?:true|false)/u);
  assert.match(orchestrator, /without asking the user to repeat its identity or revision/u);
  assert.match(orchestrator, /generic.*pasted prose.*not authority/u);
  assert.match(orchestrator, /never choose a historical or unrelated plan/u);
  assert.match(orchestrator, /workflow_create_from_plan` by identity and supported options only/u);
});

test("direct orchestration preserves explicit null-plan and empty-validation authority", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  assert.match(
    orchestrator,
    /For a direct request use `workflow_create` with `approved_plan: null` and `validation_requirements: \[\]` when the user supplied no additional validation requirements/u,
  );
  assert.match(orchestrator, /Omission or invented inspection requirements are invalid/u);
  assert.match(orchestrator, /do not probe alternate payload shapes after rejection/u);
});

test("descriptor version 5 is the only executable descriptor", () => {
  const orchestratorSource = opencode("orchestrator.md");
  const orchestrator = orchestratorSource.replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  const workflow = readFileSync(resolve(agentsDir, "WORKFLOW.md"), "utf8").replace(/\s+/gu, " ");

  for (const contract of [orchestrator, guide, workflow]) {
    assert.match(contract, /descriptor_version/u);
    assert.match(contract, /descriptor version.{0,20}(?:5|`5`)|v5/u);
    assert.match(contract, /fail(?:s)? closed/u);
    assert.match(contract, /(?:no|without fallback) (?:fallback )?mutation or dispatch/u);
    assert.match(contract, /unknown/iu);
    assert.match(contract, /malformed/iu);
    assert.match(contract, /contradictory/iu);
    assert.doesNotMatch(
      contract,
      /descriptor(?:s)? v[12]|v[12] descriptor|historical descriptor/iu,
    );
  }

  const descriptor = (
    descriptor_version: unknown,
    primary: Record<string, unknown>,
    parent_actions: unknown[] = [],
  ) => ({
    descriptor_version,
    primary,
    parent_actions,
  });
  // These are host worker-route capabilities, not route-to-operation protocol knowledge.
  const hostDispatchRoutes = new Set(["implement", "review", "re_review", "commit"]);
  const hostParentTools = new Set(
    [
      ...orchestratorSource.matchAll(
        /^\s+- action: (workflow_state_workflow_[a-z_]+)\n\s+resource: "\*"\n\s+effect: allow$/gmu,
      ),
    ].map((match) => match[1].replace(/^workflow_state_/u, "")),
  );
  const hostWorkerTools = new Set<string>();
  for (const role of ["implementer", "code_reviewer", "committer"] as const) {
    const parsed = TOML.parse(readFileSync(resolve(agentsDir, `${role}.toml`), "utf8")) as {
      mcp_servers?: { workflow_state?: { enabled_tools?: unknown } };
    };
    const enabledTools = parsed.mcp_servers?.workflow_state?.enabled_tools;
    if (Array.isArray(enabledTools)) {
      for (const tool of enabledTools) if (typeof tool === "string") hostWorkerTools.add(tool);
    }
  }
  assert.ok(hostParentTools.has("workflow_authorize_commit"));
  assert.ok(hostWorkerTools.has("workflow_submit_implementation"));

  const noAuthorization = {
    required: false,
    representation: { kind: "none" },
    binding: { kind: "none" },
  };
  const parentInvocation = {
    operation: "workflow_authorize_commit",
    semantic_choice: {
      id: "authorize_commit_preparation",
      label: "Authorize commit preparation",
      summary: "Give fresh authorization for commit preparation of the currently reviewed change.",
    },
    fixed_arguments: { workflow_id: "wf-current", expected_version: 7 },
    required_inputs: [],
    authorization: {
      required: true,
      representation: { kind: "field", path: ["user_authorization"] },
      binding: { kind: "all", paths: [] },
    },
    stale_binding: {
      workflow_id: "wf-current",
      expected_version: 7,
      references: [],
    },
    on_success: {
      kind: "refresh_required",
      expected: ["commit", "wait"],
      dispatch_authority: false,
    },
  };
  const inspectionInvocation = (status: "passed" | "failed") => ({
    operation: "workflow_record_manual_validation",
    semantic_choice: {
      id: "record_observed_validation",
      label: "Record observed validation evidence",
      summary: "Record only evidence from the declared validation inspection.",
    },
    fixed_arguments: {
      workflow_id: "wf-current",
      expected_version: 7,
      validation_id: "VAL-001",
      status,
    },
    required_inputs: [{ path: ["evidence"], source: "observed_evidence", required: true }],
    authorization: noAuthorization,
    stale_binding: {
      workflow_id: "wf-current",
      expected_version: 7,
      references: [{ kind: "validation", validation_ids: ["VAL-001"] }],
    },
    on_success: {
      kind: "refresh_required",
      expected: ["collect_evidence", "review", "wait"],
      dispatch_authority: false,
    },
  });
  const completeParentAction = {
    action: "workflow_authorize_commit",
    status: "executable",
    descriptor: {
      mode: "parent_mutation",
      selection: "single",
      invocations: [parentInvocation],
    },
  };
  const linkedPlanInvocation = {
    ...parentInvocation,
    operation: "workflow_create_linked_followup_from_plan",
    semantic_choice: {
      id: "start_approved_plan_followup",
      label: "Create a linked follow-up from the approved child plan",
      summary: "Use the exact approved child plan and select bound current findings.",
    },
    fixed_arguments: {
      workflow_id: "wf-current",
      expected_version: 7,
      plan_id: "plan-current",
      revision: 2,
    },
    required_inputs: [{ path: ["finding_ids"], source: "server_derived", required: true }],
    authorization: {
      required: true,
      representation: { kind: "field", path: ["user_authorization"] },
      binding: {
        kind: "all",
        paths: [["plan_id"], ["revision"], ["finding_ids"]],
      },
    },
    linked_followup_binding: {
      selection_rule: "nonempty_subset_from_one_bucket",
      blocking_findings: [],
      optional_findings: [
        { finding_id: "F-1", severity: "P2", summary: "A current optional concern." },
      ],
    },
    plan_binding: {
      plan_id: "plan-current",
      revision: 2,
      source: "approved_child_plan_context",
    },
    on_success: {
      kind: "refresh_required",
      expected: ["implement", "wait"],
      dispatch_authority: false,
    },
  };
  const completeLinkedPlanAction = {
    action: "workflow_create_linked_followup_from_plan",
    status: "executable",
    descriptor: {
      mode: "parent_mutation",
      selection: "single",
      invocations: [linkedPlanInvocation],
    },
  };
  const linkedDirectInvocation = {
    ...parentInvocation,
    operation: "workflow_create_linked_followup",
    semantic_choice: {
      id: "start_direct_followup",
      label: "Create a directly authored linked follow-up",
      summary: "Use user-authored work fields with null-plan authority.",
    },
    fixed_arguments: {
      workflow_id: "wf-current",
      expected_version: 7,
      approved_plan: null,
    },
    required_inputs: [
      { path: ["objective"], source: "user_authored", required: true },
      { path: ["approved_paths"], source: "user_authored", required: true },
      { path: ["acceptance_criteria"], source: "user_authored", required: true },
      { path: ["validation_requirements"], source: "user_authored", required: true },
      { path: ["finding_ids"], source: "server_derived", required: true },
    ],
    authorization: {
      required: true,
      representation: { kind: "field", path: ["user_authorization"] },
      binding: {
        kind: "all",
        paths: [
          ["objective"],
          ["approved_paths"],
          ["acceptance_criteria"],
          ["validation_requirements"],
          ["finding_ids"],
        ],
      },
    },
    linked_followup_binding: linkedPlanInvocation.linked_followup_binding,
  };
  const completeLinkedDirectAction = {
    action: "workflow_create_linked_followup",
    status: "executable",
    descriptor: {
      mode: "parent_mutation",
      selection: "single",
      invocations: [linkedDirectInvocation],
    },
  };

  const v5Fixtures = [
    {
      name: "dispatch",
      descriptor: descriptor(5, {
        mode: "dispatch",
        route: "implement",
        operation: "workflow_submit_implementation",
        workflow_id: "wf-current",
        expected_version: 7,
      }),
      expected: "dispatch",
    },
    {
      name: "parent mutation with required authorization",
      descriptor: descriptor(
        5,
        {
          mode: "parent_mutation",
          selection: "single",
          invocations: [parentInvocation],
        },
        [completeParentAction],
      ),
      expected: "parent_mutation",
    },
    {
      name: "direct linked follow-up with server-fixed null plan authority",
      descriptor: descriptor(5, { mode: "wait", reason: "awaiting direct follow-up selection" }, [
        completeLinkedDirectAction,
      ]),
      expected: "wait",
    },
    {
      name: "collect evidence observed",
      descriptor: descriptor(5, {
        mode: "collect_evidence",
        validation_id: "VAL-001",
        outcomes: {
          observed: {
            passed: {
              mode: "parent_mutation",
              selection: "single",
              invocations: [inspectionInvocation("passed")],
            },
            failed: {
              mode: "parent_mutation",
              selection: "single",
              invocations: [inspectionInvocation("failed")],
            },
          },
          unavailable: { mode: "wait", reason: "inspection evidence is unavailable" },
        },
        specialization: "recovery_inspection",
      }),
      observed: "passed",
      expected: "parent_mutation",
    },
    {
      name: "collect evidence unavailable",
      descriptor: descriptor(5, {
        mode: "collect_evidence",
        validation_id: "VAL-001",
        outcomes: {
          observed: {
            passed: {
              mode: "parent_mutation",
              selection: "single",
              invocations: [inspectionInvocation("passed")],
            },
            failed: {
              mode: "parent_mutation",
              selection: "single",
              invocations: [inspectionInvocation("failed")],
            },
          },
          unavailable: { mode: "wait", reason: "inspection evidence is unavailable" },
        },
        specialization: "recovery_inspection",
      }),
      observed: "unavailable",
      expected: "wait",
    },
    {
      name: "wait",
      descriptor: descriptor(5, { mode: "wait", reason: "authoritative action is unavailable" }),
      expected: "wait",
    },
    {
      name: "terminal",
      descriptor: descriptor(5, { mode: "terminal", outcome: "committed" }),
      expected: "terminal",
    },
  ] as const;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const inputSources = new Set([
    "user_authored",
    "parent_context",
    "server_derived",
    "observed_evidence",
  ]);
  const isStringArray = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0);
  const isAuthorization = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.required !== "boolean") return false;
    if (!isRecord(value.representation) || !isRecord(value.binding)) return false;
    if (!value.required) {
      return value.representation.kind === "none" && value.binding.kind === "none";
    }
    const representationValid =
      value.representation.kind === "metadata_only" ||
      (value.representation.kind === "field" &&
        isStringArray(value.representation.path) &&
        value.representation.path.length > 0);
    if (!representationValid) return false;
    if (value.binding.kind === "all") {
      return Array.isArray(value.binding.paths) && value.binding.paths.every(isStringArray);
    }
    return (
      value.binding.kind === "exclusive_one_of" &&
      Array.isArray(value.binding.common_paths) &&
      value.binding.common_paths.every(isStringArray) &&
      Array.isArray(value.binding.alternatives) &&
      value.binding.alternatives.every(isStringArray)
    );
  };
  const isInput = (value: unknown): boolean =>
    isRecord(value) &&
    value.required === true &&
    isStringArray(value.path) &&
    typeof value.source === "string" &&
    inputSources.has(value.source) &&
    (value.source === "parent_context"
      ? isStringArray(value.source_path)
      : value.source === "server_derived"
        ? value.source_path === undefined || isStringArray(value.source_path)
        : value.source_path === undefined);
  const isAlternative = (value: unknown): boolean =>
    isRecord(value) &&
    value.required === true &&
    Array.isArray(value.paths) &&
    value.paths.length > 0 &&
    value.paths.every(isStringArray) &&
    typeof value.source === "string" &&
    inputSources.has(value.source) &&
    (value.source === "parent_context"
      ? isStringArray(value.source_path)
      : value.source_path === undefined);
  const isLinkedFollowupBinding = (value: unknown): boolean => {
    const isFindingList = (findings: unknown): boolean =>
      Array.isArray(findings) &&
      findings.every(
        (finding) =>
          isRecord(finding) &&
          typeof finding.finding_id === "string" &&
          finding.finding_id.length > 0 &&
          typeof finding.severity === "string" &&
          typeof finding.summary === "string" &&
          finding.summary.length > 0,
      );
    if (
      !isRecord(value) ||
      value.selection_rule !== "nonempty_subset_from_one_bucket" ||
      !isFindingList(value.blocking_findings) ||
      !isFindingList(value.optional_findings)
    ) {
      return false;
    }
    return (
      (value.blocking_findings as unknown[]).length > 0 ||
      (value.optional_findings as unknown[]).length > 0
    );
  };
  const pathIs = (path: unknown, expected: string[]): boolean =>
    Array.isArray(path) &&
    path.length === expected.length &&
    path.every((part: unknown, index: number) => part === expected[index]);
  const valueAt = (source: unknown, path: string[]): unknown =>
    path.reduce(
      (value: unknown, part) =>
        isRecord(value) || Array.isArray(value)
          ? (value as Record<string, unknown>)[part]
          : undefined,
      source,
    );
  const isInputResolvable = (invocation: Record<string, unknown>, input: unknown): boolean => {
    if (!isRecord(input) || !Array.isArray(input.path)) return false;
    if (input.source === "user_authored") return input.source_path === undefined;
    if (input.source === "parent_context") {
      return (
        invocation.operation === "workflow_create_linked_followup" &&
        pathIs(input.path, ["approved_plan"]) &&
        pathIs(input.source_path, ["approved_plan"])
      );
    }
    if (input.source === "observed_evidence") {
      return (
        invocation.operation === "workflow_record_manual_validation" &&
        pathIs(input.path, ["evidence"]) &&
        isRecord(invocation.fixed_arguments) &&
        typeof invocation.fixed_arguments.validation_id === "string" &&
        (invocation.fixed_arguments.status === "passed" ||
          invocation.fixed_arguments.status === "failed")
      );
    }
    if (input.source !== "server_derived") return false;
    if (pathIs(input.path, ["finding_ids"])) {
      return (
        (isRecord(invocation.repair_binding) &&
          invocation.operation === "workflow_authorize_repair" &&
          isStringArray(invocation.repair_binding.selected_finding_ids) &&
          pathIs(input.source_path, ["selected_finding_ids"])) ||
        (isLinkedFollowupBinding(invocation.linked_followup_binding) &&
          input.source_path === undefined)
      );
    }
    if (pathIs(input.path, ["findings", "*", "finding_id"])) {
      return (
        isRecord(invocation.adjudication_binding) &&
        isStringArray(invocation.adjudication_binding.finding_ids) &&
        Array.isArray(invocation.adjudication_binding.user_input_paths) &&
        invocation.adjudication_binding.user_input_paths.some((path) =>
          pathIs(path, ["findings", "*", "disposition"]),
        ) &&
        invocation.adjudication_binding.user_input_paths.some((path) =>
          pathIs(path, ["findings", "*", "reason"]),
        )
      );
    }
    if (pathIs(input.path, ["added_paths"])) {
      return (
        isRecord(invocation.scope_reconciliation_binding) &&
        isStringArray(invocation.scope_reconciliation_binding.added_paths) &&
        isStringArray(invocation.scope_reconciliation_binding.reviewed_paths)
      );
    }
    if (
      invocation.operation === "workflow_authorize_repair" &&
      isRecord(invocation.repair_binding)
    ) {
      const proposal = invocation.repair_binding.proposal;
      if (!isRecord(proposal)) return false;
      const repairPaths: Record<string, unknown> = {
        finding_ids: invocation.repair_binding.selected_finding_ids,
        selected_finding_ids: invocation.repair_binding.selected_finding_ids,
        required_outcome: proposal.required_outcome,
        strategy_constraints: proposal.strategy_constraints,
        fallbacks: proposal.fallbacks,
        required_paths: proposal.required_paths,
        forbidden_paths: proposal.forbidden_paths,
      };
      const repairSourcePaths: Record<string, string[]> = {
        finding_ids: ["selected_finding_ids"],
        selected_finding_ids: ["selected_finding_ids"],
        required_outcome: ["proposal", "required_outcome"],
        strategy_constraints: ["proposal", "strategy_constraints"],
        fallbacks: ["proposal", "fallbacks"],
        required_paths: ["proposal", "required_paths"],
        forbidden_paths: ["proposal", "forbidden_paths"],
      };
      if (input.path[0] === "repair_directive" && input.path.length === 2) {
        const key = input.path[1];
        return (
          typeof key === "string" &&
          repairPaths[key] !== undefined &&
          pathIs(input.source_path, repairSourcePaths[key] ?? []) &&
          valueAt(invocation.repair_binding, repairSourcePaths[key] ?? []) !== undefined
        );
      }
    }
    return false;
  };
  const authorizationPaths = (authorization: Record<string, unknown>): unknown[] => {
    const binding = authorization.binding;
    if (!isRecord(binding)) return [];
    if (binding.kind === "all") return Array.isArray(binding.paths) ? binding.paths : [];
    if (binding.kind === "exclusive_one_of") {
      return [
        ...(Array.isArray(binding.common_paths) ? binding.common_paths : []),
        ...(Array.isArray(binding.alternatives) ? binding.alternatives.flat() : []),
      ];
    }
    return [];
  };
  const isInvocation = (value: unknown): boolean => {
    if (!isRecord(value)) return false;
    const success = value.on_success;
    const inputs = Array.isArray(value.required_inputs) ? value.required_inputs : [];
    const alternatives = Array.isArray(value.input_alternatives) ? value.input_alternatives : [];
    const declaredInputPaths = [
      ...inputs.filter(isInput).map((input) => input.path),
      ...alternatives.filter(isAlternative).flatMap((alternative) => alternative.paths),
    ];
    const authorization = isRecord(value.authorization) ? value.authorization : null;
    const boundPaths = authorization ? authorizationPaths(authorization) : [];
    const isPlanBinding =
      isRecord(value.plan_binding) &&
      typeof value.plan_binding.plan_id === "string" &&
      value.plan_binding.plan_id.length > 0 &&
      typeof value.plan_binding.revision === "number" &&
      Number.isInteger(value.plan_binding.revision) &&
      value.plan_binding.revision > 0 &&
      value.plan_binding.source === "approved_child_plan_context" &&
      isRecord(value.fixed_arguments) &&
      value.fixed_arguments.plan_id === value.plan_binding.plan_id &&
      value.fixed_arguments.revision === value.plan_binding.revision;
    const isLinkedFollowupOperation =
      value.operation === "workflow_create_linked_followup" ||
      value.operation === "workflow_create_linked_followup_from_plan";
    const everyAuthorizationInputIsDeclared = boundPaths.every(
      (path) =>
        (Array.isArray(path) &&
          declaredInputPaths.some(
            (declared) =>
              declared.length === path.length &&
              declared.every((part: unknown, index: number) => part === path[index]),
          )) ||
        (Array.isArray(path) &&
          path.length === 1 &&
          isRecord(value.fixed_arguments) &&
          Object.hasOwn(value.fixed_arguments, path[0] as string)),
    );
    return (
      typeof value.operation === "string" &&
      hostParentTools.has(value.operation) &&
      isRecord(value.semantic_choice) &&
      typeof value.semantic_choice.id === "string" &&
      value.semantic_choice.id.length > 0 &&
      typeof value.semantic_choice.label === "string" &&
      value.semantic_choice.label.length > 0 &&
      typeof value.semantic_choice.summary === "string" &&
      value.semantic_choice.summary.length > 0 &&
      isRecord(value.fixed_arguments) &&
      Object.values(value.fixed_arguments).every(
        (argument) =>
          argument === null ||
          (typeof argument === "string" && argument.length > 0) ||
          (typeof argument === "number" && Number.isFinite(argument)),
      ) &&
      Array.isArray(value.required_inputs) &&
      value.required_inputs.every((input) => isInput(input) && isInputResolvable(value, input)) &&
      (value.input_alternatives === undefined ||
        (Array.isArray(value.input_alternatives) &&
          value.input_alternatives.every(
            (alternative) =>
              isAlternative(alternative) &&
              alternative.paths.every((path: unknown) =>
                alternative.source === "parent_context"
                  ? value.operation === "workflow_create_linked_followup" &&
                    pathIs(path, ["approved_plan"]) &&
                    pathIs(alternative.source_path, ["approved_plan"])
                  : alternative.source === "user_authored" && alternative.source_path === undefined,
              ),
          ))) &&
      (isLinkedFollowupOperation
        ? isLinkedFollowupBinding(value.linked_followup_binding)
        : value.linked_followup_binding === undefined) &&
      (value.operation === "workflow_create_linked_followup_from_plan"
        ? isPlanBinding
        : value.plan_binding === undefined) &&
      isAuthorization(value.authorization) &&
      everyAuthorizationInputIsDeclared &&
      isRecord(value.stale_binding) &&
      typeof value.stale_binding.workflow_id === "string" &&
      value.stale_binding.workflow_id.length > 0 &&
      typeof value.stale_binding.expected_version === "number" &&
      Number.isInteger(value.stale_binding.expected_version) &&
      value.stale_binding.expected_version >= 0 &&
      Array.isArray(value.stale_binding.references) &&
      value.stale_binding.references.every(isRecord) &&
      isRecord(success) &&
      success.kind === "refresh_required" &&
      Array.isArray(success.expected) &&
      success.expected.every((next) => typeof next === "string" && next.length > 0) &&
      success.dispatch_authority === false
    );
  };
  const isMutation = (value: unknown): boolean =>
    isRecord(value) &&
    value.mode === "parent_mutation" &&
    (value.selection === "single" || value.selection === "choose_one") &&
    Array.isArray(value.invocations) &&
    value.invocations.length > 0 &&
    (value.selection !== "single" || value.invocations.length === 1) &&
    value.invocations.every(isInvocation) &&
    (value.specialization === undefined ||
      (value.specialization === "repair_authorization" &&
        isRecord(value.repair_binding) &&
        isStringArray(value.repair_binding.eligible_finding_ids) &&
        isStringArray(value.repair_binding.selected_finding_ids) &&
        isRecord(value.repair_binding.proposal) &&
        Array.isArray(value.invocations) &&
        value.invocations.length === 1 &&
        isRecord(value.invocations[0]) &&
        isRecord(value.invocations[0].repair_binding) &&
        JSON.stringify(value.invocations[0].repair_binding) ===
          JSON.stringify(value.repair_binding)));
  const isWait = (value: unknown): boolean =>
    isRecord(value) &&
    value.mode === "wait" &&
    typeof value.reason === "string" &&
    value.reason.length > 0;
  const isCollectEvidence = (value: unknown): boolean => {
    if (!isRecord(value) || !isRecord(value.outcomes)) return false;
    const outcomes = value.outcomes;
    if (
      value.mode !== "collect_evidence" ||
      typeof value.validation_id !== "string" ||
      value.validation_id.length === 0 ||
      value.specialization !== "recovery_inspection" ||
      !isRecord(outcomes.observed) ||
      !isRecord(outcomes.unavailable) ||
      !isWait(outcomes.unavailable)
    ) {
      return false;
    }
    const observed = outcomes.observed;
    return (["passed", "failed"] as const).every((outcome) => {
      const mutation = observed[outcome];
      if (!isMutation(mutation) || !isRecord(mutation) || !Array.isArray(mutation.invocations)) {
        return false;
      }
      const invocation = mutation.invocations[0];
      return (
        mutation.selection === "single" &&
        mutation.invocations.length === 1 &&
        isRecord(invocation) &&
        invocation.operation === "workflow_record_manual_validation" &&
        isRecord(invocation.fixed_arguments) &&
        invocation.fixed_arguments.validation_id === value.validation_id &&
        invocation.fixed_arguments.status === outcome
      );
    });
  };
  const isParentAction = (value: unknown): boolean => {
    if (!isRecord(value) || typeof value.action !== "string") return false;
    if (value.status === "executable") {
      const descriptor = value.descriptor;
      return (
        hostParentTools.has(value.action) &&
        isMutation(descriptor) &&
        isRecord(descriptor) &&
        Array.isArray(descriptor.invocations) &&
        descriptor.selection === "single" &&
        descriptor.invocations.length === 1 &&
        descriptor.invocations[0]?.operation === value.action
      );
    }
    return (
      value.status === "evidence_required" &&
      value.action === "workflow_record_manual_validation" &&
      hostParentTools.has(value.action) &&
      isCollectEvidence(value.descriptor)
    );
  };
  const classify = (
    value: unknown,
    observed?: "passed" | "failed" | "unavailable",
  ): "dispatch" | "parent_mutation" | "wait" | "terminal" | "fail_closed" => {
    if (
      !isRecord(value) ||
      value.descriptor_version !== 5 ||
      !isRecord(value.primary) ||
      !Array.isArray(value.parent_actions) ||
      !value.parent_actions.every(isParentAction)
    ) {
      return "fail_closed";
    }
    const primary = value.primary;
    if (primary.mode === "dispatch") {
      return typeof primary.route === "string" &&
        hostDispatchRoutes.has(primary.route) &&
        typeof primary.operation === "string" &&
        hostWorkerTools.has(primary.operation) &&
        typeof primary.workflow_id === "string" &&
        primary.workflow_id.length > 0 &&
        typeof primary.expected_version === "number" &&
        Number.isInteger(primary.expected_version) &&
        primary.expected_version >= 0
        ? "dispatch"
        : "fail_closed";
    }
    if (primary.mode === "parent_mutation") {
      return isMutation(primary) ? "parent_mutation" : "fail_closed";
    }
    if (primary.mode === "wait") return isWait(primary) ? "wait" : "fail_closed";
    if (primary.mode === "terminal") {
      return typeof primary.outcome === "string" && primary.outcome.length > 0
        ? "terminal"
        : "fail_closed";
    }
    if (!isCollectEvidence(primary)) return "fail_closed";
    if (observed === "unavailable") return "wait";
    return observed === "passed" || observed === "failed" ? "parent_mutation" : "fail_closed";
  };

  for (const fixture of v5Fixtures) {
    const observed = "observed" in fixture ? fixture.observed : undefined;
    assert.equal(classify(fixture.descriptor, observed), fixture.expected, fixture.name);
  }
  for (const version of [undefined, null, 0, 1, 2, 3, 4, "5"]) {
    assert.equal(
      classify(
        descriptor(version, {
          mode: "dispatch",
          route: "implement",
          operation: "workflow_submit_implementation",
          workflow_id: "wf-current",
          expected_version: 7,
        }),
      ),
      "fail_closed",
      `unsupported descriptor version ${String(version)}`,
    );
  }
  assert.equal(
    classify(
      descriptor(5, {
        mode: "dispatch",
        route: "bogus",
        operation: "workflow_submit_implementation",
        workflow_id: "wf-current",
        expected_version: 7,
      }),
    ),
    "fail_closed",
    "malformed v5 dispatch",
  );
  assert.equal(
    classify(
      descriptor(5, {
        mode: "dispatch",
        route: "implement",
        operation: "bogus",
        workflow_id: "wf-current",
        expected_version: 7,
      }),
    ),
    "fail_closed",
    "unusable v5 dispatch operation",
  );
  assert.equal(
    classify(
      descriptor(5, {
        mode: "parent_mutation",
        selection: "single",
        invocations: [{ ...parentInvocation, authorization: { required: true } }],
      }),
    ),
    "fail_closed",
    "malformed v5 authorization",
  );
  assert.equal(
    classify(
      descriptor(5, {
        mode: "parent_mutation",
        selection: "single",
        invocations: [
          {
            ...inspectionInvocation("passed"),
            required_inputs: [{ path: ["evidence"], source: "bogus", required: true }],
          },
        ],
      }),
    ),
    "fail_closed",
    "unusable v5 input source",
  );
  assert.equal(classify(descriptor(5, { mode: "unknown" })), "fail_closed", "unsupported v5 mode");
  assert.equal(
    classify(descriptor(5, { mode: "wait" })),
    "fail_closed",
    "incomplete v5 wait descriptor",
  );
  assert.equal(
    classify({
      descriptor_version: 5,
      primary: {
        mode: "dispatch",
        route: "implement",
        operation: "workflow_submit_implementation",
        workflow_id: "wf-current",
        expected_version: 7,
      },
      parent_actions: [{}],
    }),
    "fail_closed",
    "incomplete parent action is not executable beside a valid primary",
  );
  assert.equal(
    classify(
      descriptor(5, { mode: "wait", reason: "stop" }, [
        { ...completeParentAction, action: "workflow_reconcile_staged_scope" },
      ]),
    ),
    "fail_closed",
    "parent-action identity must match its host-allowlisted invocation",
  );
  assert.equal(
    classify(
      descriptor(5, { mode: "wait", reason: "stop" }, [
        {
          action: "workflow_submit_review",
          status: "executable",
          descriptor: {
            mode: "parent_mutation",
            selection: "single",
            invocations: [
              {
                ...parentInvocation,
                operation: "workflow_submit_review",
              },
            ],
          },
        },
      ]),
    ),
    "fail_closed",
    "parent action operations outside the Orchestrator host allowlist fail closed",
  );
  assert.equal(
    classify(descriptor(5, { mode: "wait", reason: "stop" }, [completeLinkedPlanAction])),
    "wait",
    "complete plan-native alternative binds its exact child identity and finding candidates",
  );
  assert.equal(
    classify(
      descriptor(5, { mode: "wait", reason: "stop" }, [
        {
          ...completeLinkedPlanAction,
          descriptor: {
            ...completeLinkedPlanAction.descriptor,
            invocations: [
              {
                ...linkedPlanInvocation,
                linked_followup_binding: undefined,
              },
            ],
          },
        },
      ]),
    ),
    "fail_closed",
    "linked-follow-up finding_ids require their named exact-source binding",
  );
  const unresolvedReconciliationInput = {
    ...parentInvocation,
    operation: "workflow_reconcile_staged_scope",
    semantic_choice: {
      id: "authorize_scope_reconciliation",
      label: "Reconcile staged scope",
      summary: "Authorize exact staged paths and require fresh review.",
    },
    required_inputs: [
      { path: ["added_paths"], source: "server_derived", required: true },
      { path: ["review_context"], source: "user_authored", required: true },
    ],
    authorization: {
      required: true,
      representation: { kind: "field", path: ["user_authorization"] },
      binding: { kind: "all", paths: [["added_paths"], ["review_context"]] },
    },
    on_success: {
      kind: "refresh_required",
      expected: ["re_review", "wait"],
      dispatch_authority: false,
    },
  };
  assert.equal(
    classify(
      descriptor(5, { mode: "wait", reason: "stop" }, [
        {
          action: "workflow_reconcile_staged_scope",
          status: "executable",
          descriptor: {
            mode: "parent_mutation",
            selection: "single",
            invocations: [unresolvedReconciliationInput],
          },
        },
      ]),
    ),
    "fail_closed",
    "server-derived alternative input requires its exact binding",
  );
  assert.equal(
    classify(
      descriptor(5, {
        mode: "collect_evidence",
        validation_id: "VAL-001",
        specialization: "deferred",
        outcomes: {
          observed: {
            passed: { mode: "wait", reason: "not a mutation" },
            failed: { mode: "wait", reason: "not a mutation" },
          },
          unavailable: { mode: "wait", reason: "inspection evidence is unavailable" },
        },
      }),
    ),
    "fail_closed",
    "unsupported v5 specialization",
  );
  assert.equal(classify(descriptor(4, { mode: "wait", reason: "old descriptor" })), "fail_closed");
  assert.match(orchestrator, /descriptor_version.*exactly `5`/u);
  assert.match(orchestrator, /input_alternatives/u);
  assert.match(orchestrator, /authorization\.required.*false.*(?:do not invent|block)/u);
  assert.match(orchestrator, /contradictory.*descriptor.*fail(?:s)? closed/iu);
});

test("descriptor routing preserves worker and mutation fail-closed boundaries", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");

  for (const contract of [orchestrator, guide]) {
    assert.match(contract, /dispatch.*returned route/u);
    assert.match(contract, /parent_mutation/u);
    assert.match(contract, /fixed arguments/u);
    assert.match(contract, /declared inputs/u);
    assert.match(contract, /authorization.*(?:representation|boundary)/u);
    assert.match(contract, /committed_execution/u);
    assert.match(contract, /fresh descriptor/u);
    assert.match(contract, /failed/u);
    assert.match(contract, /stale/u);
    assert.match(contract, /rejected/u);
    assert.match(contract, /unavailable/u);
    assert.match(contract, /no (?:speculative )?mutation or dispatch/u);
  }

  const implementer = readFileSync(resolve(agentsDir, "contracts/implementer.md"), "utf8").replace(
    /\s+/gu,
    " ",
  );
  assert.match(
    implementer,
    /missing or stale directive[^.]*existing `BLOCKED` or `NEEDS_CONTEXT` stop/u,
    "implementer must retain the missing-authority fail-closed defense",
  );
});

test("ambiguous parent mutations reconcile semantic postconditions before bounded retry", () => {
  const orchestratorSource = opencode("orchestrator.md");
  const orchestrator = orchestratorSource.replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");

  const boundedBlock = (contract: string, start: string, ends: string[]): string => {
    const startIndex = contract.indexOf(start);
    assert.ok(startIndex >= 0, `missing bounded contract block: ${start}`);
    const endIndex = Math.min(
      ...ends
        .map((end) => contract.indexOf(end, startIndex + start.length))
        .filter((index) => index >= 0),
    );
    assert.ok(Number.isFinite(endIndex) && endIndex > startIndex, `unterminated block: ${start}`);
    return contract.slice(startIndex, endIndex);
  };

  const assertManualValidationRetryRule = (block: string): void => {
    assert.match(block, /`workflow_record_manual_validation`/u);
    assert.match(block, /fresh `collect_evidence` descriptor/u);
    assert.match(block, /same attempted `validation_id`/u);
    assert.match(
      block,
      /newly observed terminal status and evidence equal(?: to)? the attempted status and evidence exactly/u,
    );
    assert.match(
      block,
      /validation ID alone.*?(?:status-only match|status-only).*?missing or differently represented evidence.*?fails closed/u,
    );
    assert.match(block, /second inspection.*?different semantic write/u);
    assert.doesNotMatch(
      block,
      /(?:descriptor (?:is )?available|operation availability|workflow version advanced|version advancement)[^.?!]*(?:retry|replay)/iu,
      "manual-validation retry must not be authorized by descriptor availability or version advancement",
    );
  };

  const assertScopeExpansionRetryRule = (block: string): void => {
    assert.match(block, /`workflow_expand_scope`/u);
    assert.match(
      block,
      /exact proposal and authorization binding.*?originally requested path set.*?(?:compare equal|equal to).*?attempted set/u,
    );
    assert.match(block, /v5 generic `user_authored` `added_paths` input is not that binding/u);
    assert.match(
      block,
      /exact fresh proposal\/authorization comparison is unavailable.*?stop without retry/u,
    );
    assert.match(block, /The original path proposal is never reconstructed from parent state/u);
    assert.doesNotMatch(
      block,
      /(?:descriptor (?:is )?available|operation availability|workflow version advanced|version advancement)[^.?!]*(?:retry|replay)/iu,
      "scope retry must not be authorized by descriptor availability or version advancement",
    );
  };
  const manualEvidencePredicate =
    /newly observed terminal status and evidence equal(?: to)? the attempted status and evidence exactly/u;
  const scopeProposalPredicate =
    /exact proposal and authorization binding for the originally requested path set and both compare equal to the attempted set/u;
  const genericAvailabilityRetry =
    "A fresh descriptor is available and the workflow version advanced, so retry.";

  for (const contract of [orchestrator, guide]) {
    assert.match(contract, /ambiguous parent-? ?mutation completion.*?`ERROR_VERSION_CONFLICT`/u);
    assert.match(
      contract,
      /`workflow_parent_get`.*?reconcile the attempted semantic postcondition.*?never the workflow version alone/u,
      "ambiguous completion must reconcile semantic state before retry",
    );
    assert.match(
      contract,
      /scope[- ]expansion record.*?exact requested (?:path set|paths).*?(?:superset|version advancement).*?not (?:sufficient|qualif)/u,
      "scope expansion must match the exact requested paths",
    );
    assert.match(contract, /fresh operator descriptor.*?route only from (?:that descriptor|it)/u);
    assert.match(contract, /(?:at most one retry|retry at most once)/u);
    assert.match(contract, /fresh descriptor.*?same semantic mutation/u);
    assert.match(contract, /authorization and legality remain valid/u);
    assert.match(contract, /fresh authorization/iu);
    assert.match(contract, /never (?:reuse authorization|reused)/iu);
    assert.match(contract, /Version advancement alone never authorizes replay or retry/iu);
    const manualValidationBlock = boundedBlock(
      contract,
      "For `workflow_record_manual_validation`",
      ["For `workflow_expand_scope`"],
    );
    const scopeExpansionBlock = boundedBlock(contract, "For `workflow_expand_scope`", [
      "The operator experience",
      "The operator question",
    ]);
    assertManualValidationRetryRule(manualValidationBlock);
    assertScopeExpansionRetryRule(scopeExpansionBlock);

    assert.throws(
      () =>
        assertManualValidationRetryRule(
          manualValidationBlock.replace(manualEvidencePredicate, genericAvailabilityRetry),
        ),
      "manual-validation retry must reject availability/version-only replacement",
    );
    assert.throws(
      () =>
        assertScopeExpansionRetryRule(
          scopeExpansionBlock.replace(scopeProposalPredicate, genericAvailabilityRetry),
        ),
      "scope retry must reject availability/version-only replacement",
    );
    assert.throws(
      () => assertManualValidationRetryRule(`${manualValidationBlock} ${genericAvailabilityRetry}`),
      "manual-validation retry must reject an availability/version-only exception",
    );
    assert.throws(
      () => assertScopeExpansionRetryRule(`${scopeExpansionBlock} ${genericAvailabilityRetry}`),
      "scope retry must reject an availability/version-only exception",
    );
    assert.match(
      contract,
      /material(?:ly)? (?:changed )?(?:state|proposal|authorization|legality)/iu,
    );
    assert.match(contract, /malformed descriptors/u);
    assert.match(contract, /insufficient authoritative information fail(?:s)? closed/u);
    assert.match(
      contract,
      /retry (?:count|bookkeeping).*?execution-local.*?(?:not|never) persist/iu,
    );
    assert.match(
      contract,
      /Do not reconstruct the operation, payload, bindings, routing, or authorization from `workflow_parent_get`|does not reconstruct the original path proposal, operation, payload, binding, routing, or authorization from parent state/u,
      "parent state must not become a protocol reconstruction source",
    );
  }

  const confirmedSuccess =
    "After a successful parent mutation, use `committed_execution` when the invocation advertises that response path; otherwise read a fresh operator projection. A mutation response is not itself a capability: dispatch is allowed only when the committed or freshly read descriptor contains the dispatch route. Never route from `on_success.expected`, mutation success alone, raw phases, or prompt-local sequencing.";
  const normalizedConfirmedSuccess = confirmedSuccess.replace(/\s+/gu, " ");
  assert.ok(orchestrator.includes(normalizedConfirmedSuccess));
  assert.ok(
    orchestrator.indexOf(normalizedConfirmedSuccess) <
      orchestrator.indexOf("Mutation-specific ambiguity is a separate path"),
    "confirmed-success handling must remain before the separate ambiguity rule",
  );
});

test("orchestrator selects separately authorized parent actions from descriptors", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  assert.match(orchestrator, /execution\.parent_actions.*execution\.primary/u);
  assert.match(orchestrator, /semantic_choice\.label.*semantic_choice\.summary/u);
  assert.match(orchestrator, /user selects one.*exact descriptor entry/u);
  assert.match(orchestrator, /Do not refetch expecting the rejected primary to change/u);
  assert.match(
    orchestrator,
    /never identify an alternative by interpreting operation\/tool names/u,
  );
});

test("repair authorization is an exact descriptor-driven single-call binding", () => {
  const orchestrator = readFileSync(
    resolve(import.meta.dir, "../../../.opencode/agents/orchestrator.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  for (const phrase of [
    "fresh post-approval descriptor",
    "exact invocation-relative `source_path`",
    "resolve that path against the fresh invocation's `repair_binding`",
    "Copy each resolved value verbatim",
    "Merge only the invocation's `fixed_arguments`",
    "only the fresh affirmative user authorization",
    "exactly once",
    "no mutation or dispatch",
    "`workflow_parent_get` for payload archaeology",
    "regenerate or truncate any value",
    "speculative second call",
    "returned `committed_execution` descriptor",
    "advertised worker operation",
  ]) {
    assert.ok(orchestrator.includes(phrase), `repair contract must include: ${phrase}`);
  }
  assert.match(
    orchestrator,
    /missing, malformed, altered, stale, contradictory, or unresolvable bindings fail closed/iu,
  );
  assert.match(orchestrator, /Mutation success.*`on_success\.expected`.*never authorize/u);
});

test("orchestrator and flow guide do not duplicate descriptor protocol maps", () => {
  const orchestratorSource = opencode("orchestrator.md");
  const orchestrator = orchestratorSource.slice(orchestratorSource.indexOf("\n---\n") + 5);
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  );
  const compactOrchestrator = orchestrator.replace(/\s+/gu, " ");
  const compactGuide = guide.replace(/\s+/gu, " ");

  for (const contract of [orchestrator, guide]) {
    assert.match(contract, /descriptor/u);
    assert.doesNotMatch(contract, /\b(?:retry_context|review_context)\b/u);
    assert.doesNotMatch(
      contract,
      /workflow_(?:authorize_repair|authorize_commit|retry_commit|return_commit_to_review)[^\n]*(?:->|then).*?(?:implementer|committer|reviewer)/u,
    );
    assert.doesNotMatch(
      contract,
      /(?:workflow_authorize_repair|workflow_authorize_commit)[^\n]*payload/u,
    );
    assert.doesNotMatch(
      contract,
      /phase[^\n]*(?:selects|routes|dispatches).*?(?:implementer|reviewer|committer)/iu,
    );
  }
  assert.match(orchestrator, /Never put revised-plan authority.*`resume_context`/su);

  assert.match(orchestrator, /execution\.primary/u);
  assert.match(compactOrchestrator, /server-fixed arguments/u);
  assert.match(compactOrchestrator, /declared inputs/u);
  assert.match(compactOrchestrator, /committed_execution/u);
  assert.match(compactOrchestrator, /workflow_parent_get.*parent_context/u);
  assert.match(compactOrchestrator, /If an advertised input.*source `parent_context`/u);
  assert.match(
    compactOrchestrator,
    /If a mutation would require an input that the descriptor does not declare/u,
  );
  assert.match(compactGuide, /workflow_parent_get.*parent_context/u);
  assert.match(compactGuide, /other descriptor-declared protocol knowledge/u);
});

test("the checked-in native Plan override is canonical and isolated from generated agents", () => {
  const config = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../opencode.json"), "utf8"),
  ) as {
    agents?: { plan?: unknown };
    instructions?: unknown;
  };
  assert.deepEqual(config.agents, { plan: openCodePlanAgent() });
  assert.equal(config.instructions, undefined);
  const plan = config.agents?.plan as { permissions?: unknown[] };
  assert.deepEqual(plan.permissions, openCodePlanAgent().permissions);
  const generatedPaths = Object.keys(generateDefinitions());
  assert.ok(!generatedPaths.some((path) => path.endsWith("/.opencode/agents/plan.md")));
});

test("orchestrator summarizes refreshed descriptors before routing", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");

  for (const contract of [orchestrator]) {
    assert.match(
      contract,
      /After every terminal subagent handoff[^.]*refresh `workflow_operator_decision_get`[^.]*before summarizing or routing/u,
      "terminal handoffs must refresh the operator projection before summary and routing",
    );
    assert.match(contract, /authoritative/u, "summaries must use authoritative parent state");
    for (const field of ["decision", "semantic outcome", "blocker", "authority"]) {
      assert.match(contract, new RegExp(field), `summaries must name ${field}`);
    }
    assert.match(
      contract,
      /must not dump[^.]*receipts[^.]*audit events[^.]*capabilities[^.]*validation logs/u,
      "summaries must stay concise rather than dumping internal evidence",
    );
    assert.match(
      contract,
      /After every parent mutation[^.]*process the committed or freshly read descriptor[^.]*before redispatching/u,
      "parent mutations require committed or freshly read descriptor routing",
    );
  }

  assert.match(
    orchestrator,
    /descriptor supplies the exact repair operation.*?directive envelope.*?authorization placement.*?post-success route/u,
    "repair protocol details must be descriptor-owned",
  );
  assert.match(
    orchestrator,
    /fresh descriptor.*?selects the next worker/u,
    "worker routing must use a fresh descriptor",
  );
  assert.match(
    orchestrator,
    /optional findings never trigger remediation/iu,
    "optional findings must not trigger remediation",
  );
  assert.match(
    orchestrator,
    /terminal.*descriptor reports its authoritative outcome/iu,
    "terminal outcomes must come from the descriptor",
  );
  assert.match(
    orchestrator,
    /INCOMPLETE.*?execution-local.*?up to two times.*?do not accept concerns or dispatch a reviewer/u,
    "incomplete work must use bounded direct implementer continuation",
  );
  assert.match(
    orchestrator,
    /operational guard[^.]*not a workflow correctness or authorization invariant/u,
    "continuation bound must remain operational rather than durable workflow semantics",
  );
  assert.match(
    orchestrator,
    /must not be persisted in Workflow MCP/u,
    "orchestrator must not persist the continuation counter",
  );
});

test("descriptor routing is projection-first and fail-closed", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");

  for (const contract of [orchestrator, guide]) {
    assert.match(contract, /retained (?:findings|blockers)/iu);
    assert.match(contract, /history(?:\/| and )remediation context/iu);
    assert.ok(
      /non-empty list alone never constitutes a fresh review result/u.test(contract) ||
        /non-empty retained list is not a fresh review result/u.test(contract) ||
        /retained non-empty blocker list alone never prompts for repair/u.test(contract) ||
        /retained (?:finding|blocker)s?[^.]*never (?:create a repair route|prompts for repair)/iu.test(
          contract,
        ),
      "retained findings must never be treated as a fresh repair result",
    );
    assert.match(
      contract,
      /fresh[^.]*descriptor[^.]*repair|repair[^.]*descriptor/u,
      "repair must be exposed by a fresh descriptor",
    );
    assert.match(
      contract,
      /exact (?:eligible\/selected finding binding|(?:current )?finding IDs)/u,
    );
    assert.ok(
      contract.includes("fail closed") || contract.includes("fails closed"),
      "an unavailable repair action must fail closed",
    );
  }
});

test("orchestration contracts classify intent and reconcile the final tree explicitly", () => {
  const repositoryPolicy = readFileSync(
    resolve(import.meta.dir, "../../../AGENTS.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const workflow = readFileSync(resolve(agentsDir, "WORKFLOW.md"), "utf8").replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  const readme = readFileSync(resolve(import.meta.dir, "../../../README.md"), "utf8").replace(
    /\s+/gu,
    " ",
  );
  const workflowMcpReadme = readFileSync(
    resolve(import.meta.dir, "../../workflow-mcp/README.md"),
    "utf8",
  ).replace(/\s+/gu, " ");

  for (const contract of [orchestrator, guide]) {
    assert.match(contract, /unchanged (?:objective|approved intent)/iu);
    assert.match(contract, /ordinary repair/u);
    assert.match(
      contract,
      /exact (?:blocking finding IDs|blocking IDs|finding IDs|eligible\/selected finding binding)/u,
    );
    assert.match(
      contract,
      /fresh (?:independent )?(?:reconciliation )?review|fresh combined review/u,
    );
    assert.match(contract, /changed intent/u);
    assert.match(contract, /new bounded `change` workflow/u);
    assert.match(contract, /repair, (?:finding )?adjudication, `workflow_expand_scope`/iu);
    assert.match(contract, /generic linked follow-up/u);
    assert.match(contract, /`workflow_type: review_only`|`review_only` workflow/u);
    assert.match(contract, /`review_mode: working_tree`/u);
    assert.match(contract, /current HEAD as `base_revision`/u);
    assert.match(contract, /`head_revision: null`/u);
    assert.match(contract, /include_(?:staged|unstaged|untracked)/u);
    assert.match(contract, /exact complete/u);
    assert.match(contract, /unrelated and ignored/u);
    assert.match(contract, /descriptor[^.]*returned route|returned descriptor[^.]*authoritative/u);
    assert.doesNotMatch(
      contract,
      /commit authorization[^.]*dispatch(?:es)?[^.]*committer|blocking review[^.]*dispatch(?:es)?[^.]*implementer/u,
    );
    assert.match(
      contract,
      /fresh (?:reconciliation )?review(?: reports blocking findings| can expose a repair authorization descriptor| may expose a repair authorization descriptor)|fresh combined review/u,
    );
    assert.match(contract, /descriptor[^.]*repair|repair[^.]*descriptor/u);
    assert.match(contract, /optional findings never (?:trigger )?remediation/iu);
    assert.match(contract, /separate[^.]*commit authorization/u);
    assert.match(contract, /supported (?:active )?source/u);
    assert.match(
      contract,
      /exact (?:current )?finding IDs|exact eligible\/selected finding binding/u,
    );
    assert.match(contract, /narrow remediation (?:context and )?scope/u);
    assert.match(contract, /fresh combined review/u);
  }

  assert.match(
    guide,
    /explicit user-approved work-item metadata to `workflow_create` or `workflow_create_from_plan`/u,
    "the guide must document work-item propagation for both creation routes",
  );
  assert.match(
    guide,
    /policy mismatch and stops before `workflow_create` or `workflow_create_from_plan`/u,
    "the guide must document policy preflight stops for both creation routes",
  );
  assert.match(
    readme,
    /generic work-item provenance\. Records preserve provider-neutral metadata[^.]*immutably in schema v10/u,
    "README must describe current schema v10 work-item provenance",
  );
  assert.match(
    workflowMcpReadme,
    /Workflow state schema v10/u,
    "Workflow MCP README must describe current schema v10",
  );
  assert.match(
    workflowMcpReadme,
    /Schema v9 and earlier state requires a clean reset/u,
    "Workflow MCP README must describe the schema v10 clean break",
  );
  assert.doesNotMatch(
    workflow,
    /\bmanual (?:evidence|result|requirement)s?\b/iu,
    "Workflow contract must not use obsolete narrative manual-validation terminology",
  );
  assert.match(
    workflow,
    /Schema v10 is a clean break from schema v9 and earlier/u,
    "Workflow contract must document the schema v10 clean break",
  );
  assert.match(
    repositoryPolicy,
    /Resettable internal state and protocol contracts are latest-version-only by default/u,
    "repository policy must default resettable internal contracts to latest-version-only support",
  );
  assert.match(
    repositoryPolicy,
    /Older or unknown versions fail closed and require reset or recreation; do not infer migrations, backward interpreters, historical execution compatibility, or compatibility fixtures/u,
    "repository policy must reject inferred historical compatibility",
  );
  assert.match(
    repositoryPolicy,
    /An exception requires an explicit issue and architecture approval/u,
    "repository policy must require approval for compatibility exceptions",
  );
  assert.match(
    repositoryPolicy,
    /excludes public APIs, user-owned or other non-resettable data, installer\/configuration compatibility, and other external interfaces/u,
    "repository policy must exclude external and non-resettable contracts",
  );
  assert.match(
    repositoryPolicy,
    /historical immutable runtime may still own and recover an unfinished workflow.*?does not make its older protocol executable by the current consumer/u,
    "repository policy must separate historical runtime ownership from current protocol support",
  );
  assert.match(
    workflowMcpReadme,
    /Current consumers execute only descriptor version 5.*?Missing, older, unknown, malformed, or contradictory descriptors fail closed/u,
    "Workflow MCP README must define current descriptor-v5-only fail-closed consumption",
  );
  assert.doesNotMatch(
    workflowMcpReadme,
    /Consumers must branch on `descriptor_version`|versions 1, 2, and 3 are not wire-compatible/u,
    "Workflow MCP README must not require historical descriptor branching",
  );
  assert.match(
    workflow,
    /current-consumer protocol boundary is separate from self-hosting runtime affinity.*?historical immutable runtime.*?older descriptor protocol executable by the current consumer/u,
    "Workflow contract must separate current descriptor support from historical runtime ownership",
  );
  assert.match(
    guide,
    /Plan schema v3 is a deliberate development clean break/u,
    "OpenCode flow guide must describe the current PlanArtifact schema",
  );
  assert.match(
    guide,
    /immutable references are schema v10 state/u,
    "OpenCode flow guide must describe current work-item state",
  );
  const terminalRefresh = orchestrator.indexOf("After every terminal subagent handoff");
  const conciseSummary = orchestrator.indexOf("before summarizing or routing", terminalRefresh);
  const route = orchestrator.indexOf("available authority boundary", conciseSummary);
  assert.ok(terminalRefresh >= 0 && terminalRefresh < conciseSummary);
  assert.ok(conciseSummary < route, "terminal handoff must summarize before routing");

  const mutation = orchestrator.indexOf("After every parent mutation");
  const secondRefresh = orchestrator.indexOf(
    "process the committed or freshly read descriptor",
    mutation,
  );
  const redispatch = orchestrator.indexOf("before redispatching", mutation);
  assert.ok(mutation >= 0 && mutation < secondRefresh);
  assert.ok(secondRefresh < redispatch);

  assert.match(
    orchestrator,
    /semantic decision|operator projection/u,
    "fresh semantic decisions must remain authoritative",
  );
  assert.match(workflow, /Final-tree reconciliation is a separate explicit-authorization path/u);

  const routeSections = [
    [
      orchestrator,
      "For final-tree reconciliation",
      "Before `workflow_create` or `workflow_create_from_plan`, extract",
      "orchestrator",
    ],
    [guide, "3. **Final-tree reconciliation:**", "```mermaid", "guide"],
  ] as const;

  for (const [contract, startMarker, endMarker, label] of routeSections) {
    const start = contract.indexOf(startMarker);
    const end = contract.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `${label} must isolate its reconciliation route`);
    const route = contract.slice(start, end);

    const targetFields = [
      ["workflow_type: review_only", "`review_only` workflow"],
      ["review_mode: working_tree"],
      ["current HEAD as `base_revision`"],
      ["`head_revision: null"],
      ["include_staged"],
      ["include_unstaged"],
      ["include_untracked"],
    ];
    let previousField = -1;
    for (const alternatives of targetFields) {
      const fieldIndices = alternatives
        .map((field) => route.indexOf(field))
        .filter((index) => index >= 0);
      assert.ok(fieldIndices.length > 0, `${label} must declare every review target field`);
      const fieldIndex = Math.min(...fieldIndices);
      assert.ok(fieldIndex > previousField, `${label} must preserve the review target tuple`);
      previousField = fieldIndex;
    }
    assert.ok(
      (route.includes("include_staged: true") &&
        route.includes("include_unstaged: true") &&
        route.includes("include_untracked: true")) ||
        route.includes("include_staged`, `include_unstaged`, and `include_untracked` all `true`"),
      `${label} must enable all staged, unstaged, and untracked inclusion flags`,
    );
    assert.match(
      route,
      /exact complete.*approved-untracked.*exclud(?:e|ing) unrelated and ignored/u,
      `${label} must scope the complete logical change and exclude unrelated or ignored state`,
    );

    const reviewerDispatch = Math.max(
      route.indexOf("Dispatch `code_reviewer` directly"),
      route.indexOf("descriptor dispatches `code_reviewer` directly"),
    );
    assert.equal(reviewerDispatch, -1, `${label} must not hard-code a reconciliation worker`);
    assert.match(
      route,
      /returned descriptor|descriptor[^.]*authoritative|descriptor[^.]*returned route|execution descriptor[^.]*determines/u,
    );
  }
});

test("implementer authority distinguishes plan-backed and direct null-plan repairs", () => {
  const canonical = readFileSync(resolve(agentsDir, "contracts/implementer.md"), "utf8");
  const definitions = [
    canonical,
    readFileSync(resolve(agentsDir, "implementer.toml"), "utf8"),
    opencode("implementer.md"),
  ];
  for (const definition of definitions) {
    const normalized = definition.replace(/\s+/gu, " ");
    assert.match(normalized, /two valid execution-provenance modes/u);
    assert.match(
      normalized,
      /plan-backed `change` or repair.*`approved_plan` is non-null immutable intent/u,
    );
    assert.match(normalized, /direct `review_only` repair.*`approved_plan: null` is intentional/u);
    assert.match(
      normalized,
      /complete authority comes from the authoritative direct objective, approved paths/u,
    );
    assert.match(normalized, /Do not synthesize, reconstruct, or request a PlanArtifact/u);
    assert.match(normalized, /review_only` is reviewer-first, not never-implement/u);
    assert.match(
      normalized,
      /fresh blocking review and explicit exact-ID `workflow_authorize_repair`/u,
    );
    assert.match(normalized, /common rule is fail-closed/u);
    assert.match(normalized, /exact finding\/directive bounds/u);
    assert.match(normalized, /[Oo]ptional\/P3 findings never trigger repair/u);
    assert.match(normalized, /materially changing the strategy, outcome, scope, or architecture/u);
    assert.match(normalized, /fresh bounded workflow/u);
    assert.doesNotMatch(
      normalized,
      /Execute the exact immutable `approved_plan` from the authoritative implementer view/u,
      "the contract must not universally require a non-null plan",
    );
  }
});

test("implementer reserves concerns for otherwise complete work", () => {
  for (const host of [
    readFileSync(resolve(agentsDir, "implementer.toml"), "utf8"),
    opencode("implementer.md"),
  ]) {
    const content = host.replace(/\s+/gu, " ");
    assert.match(content, /INCOMPLETE[^.]*approved-plan work remains/u);
    assert.match(content, /Do not use `DONE_WITH_CONCERNS` merely because tests are red/u);
    assert.match(
      content,
      /DONE_WITH_CONCERNS[^.]*approved implementation work is otherwise complete/u,
    );
  }
});

test("reviewer is read-only with a narrow bash allowlist", () => {
  const content = opencode("code_reviewer.md");
  const frontmatter = content.split("---\n")[1] ?? "";
  assert.notEqual(frontmatter, "", "reviewer must have frontmatter");
  assertOpenCodePermission(content, "edit", "\\*", "deny");
  assertOpenCodePermission(content, "shell", "\\*", "deny");
  for (const allowed of [
    "git status",
    "git status *",
    "git diff",
    "git diff *",
    "git log",
    "git log *",
    "git show *",
    "git rev-parse *",
    "git grep",
    "git grep *",
    "bun .codex/agents/change-receipt.ts *",
    "bun .codex/agents/reviewer-validation.ts *",
  ]) {
    assert.equal(
      opencodeBashPermission(content, allowed),
      "allow",
      `reviewer shell allowlist must include ${allowed}`,
    );
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
      opencodeBashPermission(content, `git ${denied}`) !== "allow",
      `reviewer bash must not allow git ${denied}`,
    );
  }
  assertOpenCodePermission(content, "workflow_state_workflow_submit_review", "\\*", "allow");
  assertOpenCodePermission(content, "workflow_state_workflow_begin_review", "\\*", "allow");
  assert.ok(!content.includes("workflow_state_workflow_adjudicate_findings"));
  assert.ok(!content.includes("workflow_state_workflow_prepare_commit"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
});

test("reviewer validation is the only executable validation path", () => {
  const content = opencode("code_reviewer.md");
  assert.equal(
    opencodeBashPermission(
      content,
      "bun .codex/agents/reviewer-validation.ts --evidence-id x --argv-json []",
    ),
    "allow",
  );
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
    "Tracked paths outside `approved_paths` remain context-only even when their working-tree or index contents are dirty or staged",
    "do not report them as semantic findings merely because they differ",
    "demonstrably affects the approved review target/contract or causes an authorized validation to fail",
    "tracked content at `head_revision` only",
    "do not mask an observable validation failure",
  ]) {
    assert.ok(contract.includes(phrase), `reviewer contract must include: ${phrase}`);
  }
});

test("reviewer contract owns fresh command evidence without owning inspections", () => {
  const contract = readFileSync(
    resolve(import.meta.dir, "../contracts/code_reviewer.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  for (const phrase of [
    "every command-kind requirement",
    "exact-policy, shell-free reviewer runner",
    "complete ordered command results",
    "replaces matching command slots by exact `validation_id`",
    "preserving parent-owned inspection slots",
    "Inspection requirements are never executed or submitted",
    "real failed command cannot be masked",
    "`APPROVED` is invalid while any required reviewer command result is non-passing",
    "`INCONCLUSIVE` without fabricated `validation_results`",
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
  assertOpenCodePermission(content, "edit", "\\*", "deny");
  assertOpenCodePermission(content, "shell", "\\*", "deny");
  for (const allowed of [
    "git status",
    "git status *",
    "git diff",
    "git diff *",
    "git log",
    "git log *",
    "git show *",
    "git rev-parse",
    "git rev-parse *",
    "git ls-files",
    "git ls-files *",
    "git add *",
    "git commit",
    "git commit *",
    "bun .codex/agents/change-receipt.ts *",
  ]) {
    assert.equal(
      opencodeBashPermission(content, allowed),
      "allow",
      `committer shell allowlist must include ${allowed}`,
    );
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
      opencodeBashPermission(content, denied) === "deny" &&
        opencodeBashPermission(content, `${denied} x`) === "deny",
      `committer bash must deny ${denied} with and without arguments`,
    );
  }
  assertOpenCodePermission(content, "workflow_state_workflow_prepare_commit", "\\*", "allow");
  assertOpenCodePermission(content, "workflow_state_workflow_submit_commit_result", "\\*", "allow");
  assert.ok(!content.includes("workflow_state_workflow_submit_implementation"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
  assert.ok(!content.includes("workflow_state_workflow_adjudicate_findings"));
  const contract = readFileSync(resolve(agentsDir, "contracts/committer.md"), "utf8");
  assert.match(
    contract.replace(/\s+/gu, " "),
    /If any local staged-scope, approved-path residue, or freshness check fails, do not commit, restage, unstage, or repair the index\. If the current committer view permits `workflow_prepare_commit`, call it exactly once so Workflow MCP can persist/u,
  );
  assert.match(
    contract.replace(/\s+/gu, " "),
    /staged changes outside the approved scope, do not unstage or commit them\. When `workflow_prepare_commit` is permitted, call it once to persist the staged-scope failure/u,
  );
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
  assertOpenCodePermission(content, "edit", "\\*", "allow");
  assertOpenCodePermission(content, "shell", "\\*", "allow");
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
      opencodeBashPermission(content, denied) === "deny" &&
        opencodeBashPermission(content, `${denied} x`) === "deny",
      `implementer bash must deny ${denied} with and without arguments`,
    );
  }
  assertOpenCodePermission(
    content,
    "workflow_state_workflow_submit_implementation",
    "\\*",
    "allow",
  );
  assert.ok(!content.includes("workflow_state_workflow_prepare_commit"));
  assert.ok(!content.includes("workflow_state_workflow_submit_commit_result"));
  assert.ok(!content.includes("workflow_state_workflow_submit_review"));
  assert.ok(!content.includes("workflow_state_workflow_adjudicate_findings"));
});

test("Codex and OpenCode contracts carry equivalent role behavior", () => {
  const openCodeWorkflowClarification =
    "`execute` remains available for unrelated work and must not be intentionally selected as a Workflow transport.";
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
      .replace(`${openCodeWorkflowClarification} `, "")
      .trimEnd();
    assert.equal(
      normalize(tomlBody),
      normalize(markdownBody),
      `${role} host bodies must differ only in the injected host identity`,
    );
    bodies.set(role, tomlBody);
  }
  for (const role of ["implementer", "code_reviewer", "committer"] as const) {
    assert.ok(
      bodies
        .get(role)!
        .includes(
          role === "implementer"
            ? "workflow_implementer_get"
            : role === "code_reviewer"
              ? "workflow_reviewer_get"
              : "workflow_committer_get",
        ),
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

test("role contracts state the direct Workflow contract and forbid alternate access", () => {
  const contractsDir = resolve(import.meta.dir, "../contracts");
  const sharedRequired = [
    "Direct host-provided `workflow_state_*` tools are the required contract path for Workflow operations.",
    "Do not import the MCP client SDK",
    "launch `server.ts`, `bootstrap.ts`, or `runtime-supervisor.ts`",
    "invoke MCP through shell/Bun/Node scripts",
    "access Workflow MCP SQLite files directly",
    "Do not use an alternate Workflow transport",
  ];
  const openCodeOnly =
    "`execute` remains available for unrelated work and must not be intentionally selected as a Workflow transport.";
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    const contract = readFileSync(resolve(contractsDir, `${role}.md`), "utf8");
    const normalizedContract = contract.replace(/\s+/gu, " ");
    const generatedCodex = Object.entries(generateDefinitions()).find(([path]) =>
      path.endsWith(`/${role}.toml`),
    )?.[1];
    const generatedOpenCode = Object.entries(generateDefinitions()).find(([path]) =>
      path.endsWith(`/${role}.md`),
    )?.[1];
    assert.ok(generatedCodex, `${role} Codex definition must be generated`);
    assert.ok(generatedOpenCode, `${role} OpenCode definition must be generated`);
    for (const phrase of sharedRequired) {
      assert.ok(normalizedContract.includes(phrase), `${role} contract must include: ${phrase}`);
      assert.ok(
        generatedCodex.replace(/\s+/gu, " ").includes(phrase),
        `${role} definition must include: ${phrase}`,
      );
      assert.ok(
        generatedOpenCode.replace(/\s+/gu, " ").includes(phrase),
        `${role} OpenCode definition must include: ${phrase}`,
      );
    }
    assert.doesNotMatch(normalizedContract, /`execute` remains available for unrelated work/u);
    assert.doesNotMatch(generatedCodex, /`execute` remains available for unrelated work/u);
    assert.match(
      generatedOpenCode,
      new RegExp(openCodeOnly.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"),
    );
    assert.doesNotMatch(
      generatedOpenCode,
      /^  - action: execute\n    resource: "\*"\n    effect: deny$/mu,
      `${role} must preserve unrelated execute availability`,
    );
  }
});

test("OpenCode roles preserve unrelated execute availability", () => {
  const broadExecuteDeny = /^  - action: execute\n    resource: "\*"\n    effect: deny$/mu;
  const definitions = generateDefinitions();
  for (const role of ["implementer", "code_reviewer", "committer", "planner", "explorer"]) {
    const definition = Object.entries(definitions).find(([path]) =>
      path.endsWith(`/${role}.md`),
    )?.[1];
    assert.ok(definition, `${role} OpenCode definition must be generated`);
    assert.doesNotMatch(
      definition,
      broadExecuteDeny,
      `${role} must preserve unrelated execute availability`,
    );
  }

  const directContract =
    "Direct `workflow_state_*` tools are the required contract path for Workflow operations. `execute` remains available for unrelated work and must not be intentionally selected as a Workflow transport.";
  const plan = openCodePlanAgent();
  const planPrompt = String(plan.system).replace(/\s+/gu, " ");
  assert.ok(planPrompt.includes(directContract));
  assert.doesNotMatch(
    JSON.stringify(plan.permissions),
    /execute.*deny/u,
    "Native Plan must not use a broad execute denial fallback",
  );
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  assert.ok(orchestrator.includes(directContract));
  assert.doesNotMatch(
    orchestrator,
    broadExecuteDeny,
    "Orchestrator must not use a broad execute denial fallback",
  );
});

test("README documents the current runtime authority boundary", () => {
  const readme = readFileSync(resolve(import.meta.dir, "../../../README.md"), "utf8").replace(
    /\s+/gu,
    " ",
  );
  const directAuthority = readme.slice(
    readme.indexOf("Opening `codex-agents` itself"),
    readme.indexOf("Planning is a separate pre-workflow path"),
  );
  const installedAuthority = readme.slice(readme.indexOf("OpenCode permissions are host-level"));
  const activeAuthority = `${directAuthority} ${installedAuthority}`;

  for (const anchor of [
    /persisted runtime ownership/u,
    /launch attestation/u,
    /optimistic version(?: checks|ing)/u,
    /role-specific tool exposure/u,
    /Workflow MCP[^.]*invariant checks/u,
  ]) {
    assert.match(activeAuthority, anchor);
  }
  assert.doesNotMatch(
    activeAuthority,
    /(?:single|parent) capability remains? parent-only|server-side capability and version checks/u,
  );
  assert.doesNotMatch(
    activeAuthority,
    /(?:returned|retained|carried by the model|model-carried)[^.]*parent bearer|parent bearer[^.]*returned/u,
  );
  assert.doesNotMatch(activeAuthority, /\bbearer\b/u);
});
