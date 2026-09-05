import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { TOML } from "bun";
import { openCodePlanAgent } from "../../../install-into.js";
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
  const rules = [...content.matchAll(/^    "((?:\\.|[^"\\])*)": (allow|ask|deny)$/gmu)].map(
    (match) => ({
      pattern: JSON.parse(`"${match[1]}"`) as string,
      action: match[2] as string,
    }),
  );
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
    const getter =
      role === "implementer"
        ? "workflow_implementer_get"
        : role === "code_reviewer"
          ? "workflow_reviewer_get"
          : "workflow_committer_get";
    assert.match(content, new RegExp(`^  workflow_state_${getter}: allow$`, "m"));
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
  assert.match(planner, /^  task:\n    "\*": deny\n    "explorer": allow$/m);
  assert.deepEqual(
    [...planner.matchAll(/^  workflow_state_([^:]+): allow$/gmu)].map((match) => match[1]),
    ["plan_create", "plan_get", "plan_revise"],
  );
  for (const tool of ["plan_create", "plan_get", "plan_revise"]) {
    assert.match(planner, new RegExp(`^  workflow_state_${tool}: allow$`, "m"));
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
    assert.match(planner, new RegExp(`^  ${denied}: deny$`, "m"));
  }
  for (const allowed of ["webfetch", "websearch"]) {
    assert.match(planner, new RegExp(`^  ${allowed}: allow$`, "m"));
    assert.ok(!planner.includes(`  ${allowed}: deny`), `planner must allow ${allowed}`);
  }

  const explorer = opencode("explorer.md");
  assert.match(explorer, /^hidden: true$/m);
  assert.match(explorer, /^  edit: deny$/m);
  assert.match(explorer, /^  bash:\n    "\*": deny$/m);
  for (const allowed of [
    '"git status": allow',
    '"git status --short": allow',
    '"git status --porcelain": allow',
    '"git diff": allow',
    '"git diff --cached": allow',
    '"git diff HEAD": allow',
    '"git log": allow',
    '"git log -1": allow',
    '"git log --oneline": allow',
    '"git show": allow',
    '"git show HEAD": allow',
    '"git rev-parse --show-toplevel": allow',
    '"git rev-parse --is-inside-work-tree": allow',
    '"git ls-files": allow',
    '"git grep": allow',
    '"bun .codex/agents/reviewer-validation.ts --evidence-id * --argv-json *": allow',
  ]) {
    assert.ok(explorer.includes(allowed), `explorer bash allowlist must include ${allowed}`);
  }
  for (const unsafe of [
    '"git status *": allow',
    '"git diff *": allow',
    '"git log *": allow',
    '"git show *": allow',
    '"git rev-parse *": allow',
    '"git ls-files *": allow',
    '"git grep *": allow',
    "git diff --output",
    "git diff --no-index",
  ]) {
    assert.ok(!explorer.includes(unsafe), `explorer must reject unsafe Git pattern ${unsafe}`);
  }
  assert.match(explorer, /^  task: deny$/m);
  assert.match(explorer, /^  workflow_state_\*: deny$/m);
  assert.ok(!explorer.includes("workflow_state_plan_create"));
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

test("explorer evidence permission rejects shell syntax appended to the runner", () => {
  const explorer = opencode("explorer.md");
  const allowedCommand =
    'bun .codex/agents/reviewer-validation.ts --evidence-id EVIDENCE-1 --argv-json ["git","status"]';
  assert.equal(opencodeBashPermission(explorer, allowedCommand), "allow");
  for (const unsafeCommand of [
    `${allowedCommand}; touch explorer-owned.txt`,
    `${allowedCommand} && touch explorer-owned.txt`,
    `${allowedCommand} | touch explorer-owned.txt`,
    `${allowedCommand} \`touch explorer-owned.txt\``,
    `${allowedCommand} $(touch explorer-owned.txt)`,
    `${allowedCommand} > explorer-owned.txt`,
    `${allowedCommand} < /etc/hosts`,
    `${allowedCommand}\ntouch explorer-owned.txt`,
    `${allowedCommand}\rtouch explorer-owned.txt`,
    `${allowedCommand}\\touch explorer-owned.txt`,
  ]) {
    assert.equal(
      opencodeBashPermission(explorer, unsafeCommand),
      "deny",
      `unsafe evidence command must be denied: ${JSON.stringify(unsafeCommand)}`,
    );
  }
});

test("planner clarification and native Plan refinement remain portable and fail closed", () => {
  const canonical = readFileSync(resolve(agentsDir, "contracts/planner.md"), "utf8");
  const generated = opencode("planner.md");
  const materializedPlan = openCodePlanAgent() as {
    permission: Record<string, unknown>;
    prompt: string;
  };
  const planPrompt = materializedPlan.prompt;
  const planConfig = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../opencode.json"), "utf8"),
  ) as { agent: { plan: { prompt: string; permission: Record<string, unknown> } } };
  const planCopies = [planPrompt, planConfig.agent.plan.prompt];

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

  assert.equal(planConfig.agent.plan.permission.question, "deny");
  assert.equal(planConfig.agent.plan.permission.question, materializedPlan.permission.question);
  assert.equal(planConfig.agent.plan.permission.workflow_state_plan_get, undefined);
  assert.equal(planConfig.agent.plan.permission.workflow_state_plan_revise, undefined);
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
  assert.match(content, /^  edit: deny$/m);
  assert.match(content, /^  task:\n    "\*": deny$/m);
  for (const role of ["implementer", "code_reviewer", "committer"]) {
    assert.match(content, new RegExp(`^    "${role}": allow$`, "m"));
  }
  assert.ok(!content.includes('    "planner": allow'));
  assert.match(content, /^  workflow_state_\*: deny$/m);
  for (const parentTool of [
    "workflow_create",
    "workflow_adopt_dirty_scope",
    "workflow_expand_scope",
    "workflow_parent_get",
    "workflow_operator_decision_get",
    "workflow_reconcile_commit_result",
    "workflow_get_audit",
    "workflow_resume_implementation",
    "workflow_accept_concerns",
    "workflow_record_manual_validation",
    "workflow_authorize_repair",
    "workflow_adjudicate_findings",
    "workflow_resume_review",
    "workflow_finalize_repair_exhausted",
    "workflow_create_linked_followup",
    "workflow_create_linked_followup_from_plan",
    "workflow_authorize_commit",
    "workflow_retry_commit_preparation",
    "workflow_return_commit_to_review",
    "workflow_retry_commit",
  ]) {
    assert.match(
      content,
      new RegExp(`^  workflow_state_${parentTool}: allow$`, "m"),
      `orchestrator must expose parent tool ${parentTool}`,
    );
  }
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
  assert.match(content, /do not pass pasted plan text/);
  assert.match(content, /never pass or retranscribe its full plan/);
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
});

test("orchestrator presents semantic proposals before natural-language authorization", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const workflow = readFileSync(resolve(agentsDir, "WORKFLOW.md"), "utf8").replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");
  const contracts = [orchestrator, workflow, guide];

  for (const contract of contracts) {
    assert.match(contract, /semantic (?:decisions|choice|user choice)/u);
    assert.match(contract, /concrete safe proposal/u);
    assert.match(contract, /exact `workflow_parent_get`/u);
    assert.match(contract, /consequence/u);
    assert.match(contract, /exact repository-relative/u);
    assert.match(contract, /not authorization/u);
    assert.match(contract, /internal (?:action\/phase|action\/tool) names/u);
    assert.match(contract, /contextual `yes`|`yes`, `continue`, `go ahead`, and `commit it`/u);
    assert.match(contract, /`Reply \.\.\.` incantation|magic phrase/u);
    assert.match(contract, /ambiguous.*fail(?:s)? closed/u);
    assert.match(contract, /After affirmative input.*re-read/u);
    assert.match(contract, /[Vv]erif(?:y|ies).*proposal.*scope.*findings.*lineage.*plan binding/u);
    assert.match(contract, /No durable proposal state/u);
  }

  const proposal = orchestrator.indexOf("resolve one concrete safe proposal");
  const question = orchestrator.indexOf("Ask only for the genuine user-owned choice", proposal);
  const affirmative = orchestrator.indexOf("After affirmative input", question);
  assert.ok(proposal >= 0 && proposal < question && question < affirmative);
  assert.match(orchestrator, /negative, ambiguous, unrelated, changed, or stale response/u);
  assert.match(orchestrator, /without asking the user to repeat its identity or revision/u);
  assert.match(orchestrator, /generic.*pasted prose.*not authority/u);
  assert.match(orchestrator, /never choose a historical or unrelated plan/u);
  assert.match(orchestrator, /workflow_create_from_plan` by identity and supported options only/u);
});

test("the checked-in native Plan override is canonical and isolated from generated agents", () => {
  const config = JSON.parse(
    readFileSync(resolve(import.meta.dir, "../../../opencode.json"), "utf8"),
  ) as {
    agent?: { plan?: unknown };
    instructions?: unknown;
  };
  assert.deepEqual(config.agent, { plan: openCodePlanAgent() });
  assert.equal(config.instructions, undefined);
  const plan = config.agent?.plan as { permission?: Record<string, unknown> };
  assert.deepEqual(plan.permission, {
    edit: "deny",
    bash: "deny",
    question: "deny",
    task: { "*": "deny", planner: "allow", explorer: "allow" },
    "workflow_state_*": "deny",
    workflow_state_plan_parent_get: "allow",
    workflow_state_plan_approve: "allow",
  });
  const generatedPaths = Object.keys(generateDefinitions());
  assert.ok(!generatedPaths.some((path) => path.endsWith("/.opencode/agents/plan.md")));
});

test("orchestrator summarizes refreshed semantic transitions before routing", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const workflow = readFileSync(resolve(agentsDir, "WORKFLOW.md"), "utf8").replace(/\s+/gu, " ");

  for (const contract of [orchestrator, workflow]) {
    assert.match(
      contract,
      /After every terminal (?:subagent|worker) handoff[^.]*refresh[^.]*workflow_operator_decision_get[^.]*before summarizing or routing/u,
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
      /After every parent mutation[^.]*refresh[^.]*workflow_operator_decision_get[^.]*again[^.]*fresh semantic summary[^.]*before redispatch/u,
      "parent mutations require a second projection refresh and summary before redispatch",
    );
  }

  assert.match(
    orchestrator,
    /CHANGES_REQUESTED.*?every bounded blocker summary.*?before asking for repair authorization.*?exact current.*?finding IDs.*?do not authorize repair or redispatch/u,
    "blocking findings must be visible before repair routing",
  );
  assert.match(
    orchestrator,
    /current repair cycle[^.]*next role is the implementer/u,
    "repair authorization must identify the cycle and next role",
  );
  assert.match(
    orchestrator,
    /APPROVED[^.]*optional_findings[^.]*request explicit commit authorization/u,
    "approval must precede commit authorization",
  );
  assert.match(
    orchestrator,
    /recovery_summary\.stop_reason[^.]*recovery_summary\.recovery_context[^.]*single available recovery decision/u,
    "stop summaries must use projection-only recovery context",
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

test("repair-terminal routing is projection-first and fail-closed", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const workflow = readFileSync(resolve(agentsDir, "WORKFLOW.md"), "utf8").replace(/\s+/gu, " ");
  const guide = readFileSync(
    resolve(import.meta.dir, "../../../docs/opencode-orchestration-flow.md"),
    "utf8",
  ).replace(/\s+/gu, " ");

  const terminal = orchestrator.indexOf("After every terminal implementation handoff");
  const refresh = orchestrator.indexOf("call `workflow_operator_decision_get` first", terminal);
  const decision = orchestrator.indexOf("semantic decision", terminal);
  const reviewing = orchestrator.indexOf(
    "`no_user_action/review` or `no_user_action/re_review`",
    terminal,
  );
  const reviewer = orchestrator.indexOf("dispatch `code_reviewer` for a", reviewing);
  assert.ok(terminal >= 0 && terminal < refresh);
  assert.ok(refresh < decision && decision < reviewing && reviewing < reviewer);

  for (const contract of [orchestrator, workflow, guide]) {
    assert.match(contract, /retained (?:findings|blockers)[^.]*history\/remediation context/iu);
    assert.ok(
      /non-empty list alone never constitutes a fresh review result/u.test(contract) ||
        /non-empty retained list is not a fresh review result/u.test(contract) ||
        /retained non-empty blocker list alone never prompts for repair/u.test(contract),
      "retained findings must never be treated as a fresh repair result",
    );
    assert.match(
      contract,
      /fresh[^.]*?(?:projection reports `approve_exact_repairs`|`REPAIR_REQUIRED`)[^.]*?(?:(?:its )?authority boundary (?:is )?available|`workflow_authorize_repair`.*?permitted_next_actions|permitted_next_actions.*?`workflow_authorize_repair`)/u,
    );
    assert.match(contract, /current exact (?:(?:blocking )?(?:finding )?IDs|blocker IDs)/u);
    assert.ok(
      contract.includes("fail closed") || contract.includes("fails closed"),
      "an unavailable repair action must fail closed",
    );
  }

  for (const contract of [orchestrator, guide]) {
    assert.match(contract, /same[- ]ID[^.]*again/u);
    assert.match(contract, /old ID[^.]*resolved[^.]*different (?:current )?blocker/u);
  }
  assert.match(
    readFileSync(resolve(agentsDir, "EVALS.md"), "utf8").replace(/\s+/gu, " "),
    /same-ID[^.]*exact ID[^.]*resolv(?:ing|ed)[^.]*old ID[^.]*different current blocker/u,
  );

  const repairBranch = orchestrator.indexOf("Only a fresh reviewer handoff");
  const repairAction = orchestrator.indexOf("`approve_exact_repairs`", repairBranch);
  const currentIds = orchestrator.indexOf("current exact blocking finding IDs", repairBranch);
  assert.ok(repairBranch >= 0 && repairBranch < repairAction && repairAction < currentIds);
});

test("orchestration contracts classify intent and reconcile the final tree explicitly", () => {
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
  const evals = readFileSync(resolve(agentsDir, "EVALS.md"), "utf8").replace(/\s+/gu, " ");

  for (const contract of [orchestrator, workflow, guide]) {
    assert.match(contract, /unchanged (?:objective|approved intent)/iu);
    assert.match(contract, /ordinary repair/u);
    assert.match(contract, /exact (?:blocking finding IDs|blocking IDs)/u);
    assert.match(contract, /fresh independent (?:review|re-review)/u);
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
    assert.match(contract, /code_reviewer` directly/u);
    assert.match(contract, /never (?:dispatch )?`?implementer`? first/u);
    assert.match(contract, /fresh (?:reconciliation )?review reports blocking findings/u);
    assert.match(contract, /ordinary exact-ID repair authorization/u);
    assert.match(contract, /optional findings never (?:trigger )?remediation/iu);
    assert.match(contract, /separate[^.]*commit authorization/u);
    assert.match(contract, /one coherent commit/u);
    assert.match(contract, /supported (?:active )?source/u);
    assert.match(contract, /exact current finding IDs/u);
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
    /generic work-item provenance\. Records preserve provider-neutral metadata[^.]*immutably in schema v8/u,
    "README must describe current schema v8 work-item provenance",
  );
  assert.match(
    evals,
    /before `workflow_create` or `workflow_create_from_plan`, Orchestrator reads the target `\.codex\/reviewer-validation\.json` policy and checks every proposed executable validation/u,
    "manual evaluations must preflight both workflow creation routes",
  );
  assert.match(
    evals,
    /does not create either workflow route/u,
    "manual evaluations must require a stop for either creation route",
  );
  assert.match(
    evals,
    /direct non-plan fallback still uses `workflow_create` with `approved_plan: null`/u,
    "manual evaluations must preserve the direct fallback distinction",
  );

  const terminalRefresh = orchestrator.indexOf("After every terminal subagent handoff");
  const conciseSummary = orchestrator.indexOf("before summarizing or routing", terminalRefresh);
  const route = orchestrator.indexOf("available authority boundary", conciseSummary);
  assert.ok(terminalRefresh >= 0 && terminalRefresh < conciseSummary);
  assert.ok(conciseSummary < route, "terminal handoff must summarize before routing");

  const mutation = orchestrator.indexOf("After every parent mutation");
  const secondRefresh = orchestrator.indexOf(
    "refresh `workflow_operator_decision_get` again",
    mutation,
  );
  const freshSummary = orchestrator.indexOf("fresh semantic summary", mutation);
  const redispatch = orchestrator.indexOf("before redispatching", mutation);
  assert.ok(mutation >= 0 && mutation < secondRefresh);
  assert.ok(secondRefresh < freshSummary && freshSummary < redispatch);

  assert.match(
    orchestrator,
    /semantic decision|operator projection/u,
    "fresh semantic decisions must remain authoritative",
  );
  assert.match(
    workflow,
    /routes?\s+from its state-provable decision/u,
    "workflow contract must route from refreshed semantic decisions",
  );

  const routeSections = [
    [
      orchestrator,
      "For final-tree reconciliation",
      "Before `workflow_create` or `workflow_create_from_plan`, extract",
      "orchestrator",
    ],
    [
      workflow,
      "Final-tree reconciliation is a separate explicit-authorization path",
      "After every terminal worker handoff",
      "workflow",
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

    const reviewerDispatch = route.indexOf("Dispatch `code_reviewer` directly");
    const blockingReview = Math.max(
      route.indexOf("fresh reconciliation review reports blocking findings"),
      route.indexOf("fresh review reports blocking findings"),
    );
    const repairAuthorization = route.indexOf("ordinary exact-ID repair authorization");
    const implementerGate = Math.max(
      route.indexOf("before permitting implementer"),
      route.indexOf("before dispatching an implementer"),
    );
    assert.match(
      route,
      /Dispatch `code_reviewer` directly(?:,| and) (?:never )?(?:dispatch )?(?:an )?`?implementer`? first/u,
      `${label} must not start reconciliation with implementer`,
    );
    if (route.includes("Implementer is allowed in this route only after")) {
      assert.match(
        route,
        /Implementer is allowed in this route only after a fresh review reports blocking findings and ordinary exact-ID repair authorization is obtained/u,
        `${label} must co-locate the implementer gate with its blocking-finding authorization`,
      );
    } else {
      assert.ok(
        implementerGate > repairAuthorization,
        `${label} must place implementer dispatch after ordinary repair authorization`,
      );
    }
    assert.ok(
      reviewerDispatch >= 0 &&
        reviewerDispatch < blockingReview &&
        blockingReview < repairAuthorization,
      `${label} must order reviewer dispatch, blocking findings, and repair authorization`,
    );

    const approval = route.indexOf("Approval");
    const commitAuthorization = route.indexOf("commit authorization");
    const coherentCommit = route.indexOf("one coherent commit");
    assert.ok(
      approval >= 0 && approval < commitAuthorization && commitAuthorization < coherentCommit,
      `${label} must keep approval, commit authorization, and coherent commit in order`,
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
  assert.ok(!content.includes("workflow_state_workflow_adjudicate_findings"));
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
  assert.ok(!content.includes("workflow_state_workflow_adjudicate_findings"));
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
  assert.ok(!content.includes("workflow_state_workflow_adjudicate_findings"));
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
