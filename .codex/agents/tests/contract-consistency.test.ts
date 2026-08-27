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
  assert.match(explorer, /^  bash: deny$/m);
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
  ]) {
    assert.ok(planner.includes(phrase), `planner contract must include: ${phrase}`);
  }
  for (const phrase of [
    "at most 20 findings",
    "at most 50 relevant exact repository-relative paths",
    "at most 10 risks",
    "most 10 questions",
    "Recursive fan-out is forbidden",
    "Workflow MCP tools",
  ]) {
    assert.ok(explorer.includes(phrase), `explorer contract must include: ${phrase}`);
  }
  assert.ok(!planner.includes("gpt-5.6"));
  assert.ok(!explorer.includes("gpt-5.6"));
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
  assert.match(content, /exact `plan_id` and revision/);
  assert.match(content, /do not pass pasted plan text/);
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
    task: { "*": "deny", planner: "allow" },
    "workflow_state_*": "deny",
    workflow_state_plan_parent_get: "allow",
    workflow_state_plan_approve: "allow",
  });
  const generatedPaths = Object.keys(generateDefinitions());
  assert.ok(!generatedPaths.some((path) => path.endsWith("/.opencode/agents/plan.md")));
});

test("orchestrator summarizes refreshed authoritative transitions before routing", () => {
  const orchestrator = opencode("orchestrator.md").replace(/\s+/gu, " ");
  const workflow = readFileSync(resolve(agentsDir, "WORKFLOW.md"), "utf8").replace(/\s+/gu, " ");

  for (const contract of [orchestrator, workflow]) {
    assert.match(
      contract,
      /After every terminal subagent handoff[^.]*refresh[^.]*workflow_parent_get[^.]*before summarizing or routing/u,
      "terminal handoffs must refresh parent state before summary and routing",
    );
    assert.match(contract, /authoritative/u, "summaries must use authoritative parent state");
    for (const field of [
      "phase",
      "implementation_status",
      "blocking_findings",
      "optional_findings",
    ]) {
      assert.match(contract, new RegExp(field), `summaries must name ${field}`);
    }
    assert.match(
      contract,
      /must not dump receipts[^.]*audit events[^.]*capabilities[^.]*validation logs/u,
      "summaries must stay concise rather than dumping internal evidence",
    );
    assert.match(
      contract,
      /After every parent mutation[^.]*refresh[^.]*workflow_parent_get[^.]*again[^.]*fresh summary[^.]*before redispatch/u,
      "parent mutations require a second refresh and summary before redispatch",
    );
  }

  assert.match(
    orchestrator,
    /CHANGES_REQUESTED.*?every blocking finding ID.*?bounded human-readable reason.*?before asking for repair authorization.*?Do not authorize repair or redispatch/u,
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
  const route = orchestrator.indexOf("permitted_next_actions", conciseSummary);
  assert.ok(terminalRefresh >= 0 && terminalRefresh < conciseSummary);
  assert.ok(conciseSummary < route, "terminal handoff must summarize before routing");

  const mutation = orchestrator.indexOf("After every parent mutation");
  const secondRefresh = orchestrator.indexOf("refresh `workflow_parent_get` again", mutation);
  const freshSummary = orchestrator.indexOf("fresh summary", mutation);
  const redispatch = orchestrator.indexOf("before redispatching", mutation);
  assert.ok(mutation >= 0 && mutation < secondRefresh);
  assert.ok(secondRefresh < freshSummary && freshSummary < redispatch);

  assert.match(
    orchestrator,
    /refreshed `permitted_next_actions`|returned version and `permitted_next_actions`/u,
    "fresh permitted actions must remain authoritative",
  );
  assert.match(
    workflow,
    /routes from refreshed\s+`permitted_next_actions`/u,
    "workflow contract must route from refreshed permitted actions",
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
