import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hasOpenCodeWorkflowStateRegistration,
  openCodePlanAgent,
  trustedBootstrapCommand,
} from "../../../install-into.js";
import { tools } from "../../workflow-mcp/server.js";
import { PARENT_WORKFLOW_ACTION_VALUES } from "../../workflow-mcp/workflow-action-registry.js";

const repoRoot = resolve(import.meta.dir, "../../../");
const selfHostConfig = resolve(repoRoot, "opencode.json");
const relativeServerPath = ".codex/workflow-mcp/bootstrap.ts";
const orchestratorPath = ".opencode/agents/orchestrator.md";

test("the repository's own opencode.json registers the supervised self-host server", () => {
  assert.ok(existsSync(selfHostConfig), `missing self-host config: ${selfHostConfig}`);
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    $schema: string;
    default_agent: string;
    experimental: { subagent_depth: number };
    agents: { plan: Record<string, unknown> };
    mcp: { servers: { workflow_state: Record<string, unknown> } };
  };
  const expected = {
    $schema: "https://opencode.ai/config.json",
    default_agent: "orchestrator",
    agents: { plan: openCodePlanAgent() },
    mcp: {
      servers: {
        workflow_state: {
          type: "local",
          command: trustedBootstrapCommand(relativeServerPath),
          timeout: { catalog: 30000, execution: 30000 },
          codemode: false,
        },
      },
    },
  };
  assert.equal(parsed.$schema, expected.$schema);
  assert.equal(parsed.default_agent, expected.default_agent);
  assert.equal(parsed.experimental.subagent_depth, 2);
  assert.deepEqual(parsed.agents, expected.agents);
  assert.deepEqual(parsed.mcp, expected.mcp);
  assert.equal(parsed.$schema, "https://opencode.ai/config.json");
  assert.equal(parsed.default_agent, "orchestrator");
  assert.ok(hasOpenCodeWorkflowStateRegistration(selfHostConfig));
});

test("self-host OpenCode exposes the V2 Explorer plugin with structured capabilities", () => {
  const pluginDirectory = resolve(repoRoot, ".opencode/plugins/codex-agents-explorer-tools");
  const plugin = readFileSync(resolve(pluginDirectory, "index.ts"), "utf8");
  assert.match(plugin, /Plugin\.define/u);
  assert.match(plugin, /ctx\.tool\.transform/u);
  assert.match(plugin, /name: "runEvidence"/u);
  assert.match(plugin, /name: "inspectGitRange"/u);
  assert.doesNotMatch(plugin, /@opencode-ai\/plugin/u);
  assert.doesNotMatch(plugin, /\btool\(/u);
  assert.doesNotMatch(plugin, /title:/u);
  assert.ok(!existsSync(resolve(repoRoot, ".opencode/tools/runEvidence.ts")));
  assert.ok(!existsSync(resolve(repoRoot, ".opencode/tools/inspectGitRange.ts")));
  const worktree = readFileSync(resolve(pluginDirectory, "worktree.ts"), "utf8");
  assert.match(worktree, /session\.get/u);
  assert.match(worktree, /--show-toplevel/u);
  assert.match(worktree, /shell: false/u);
  const explorer = readFileSync(resolve(repoRoot, ".opencode/agents/explorer.md"), "utf8");
  assert.match(explorer, /^  - action: runEvidence\n    resource: "\*"\n    effect: allow$/m);
  assert.match(explorer, /^  - action: inspectGitRange\n    resource: "\*"\n    effect: allow$/m);
  for (const role of ["implementer", "code_reviewer", "committer", "planner", "orchestrator"]) {
    assert.match(
      readFileSync(resolve(repoRoot, `.opencode/agents/${role}.md`), "utf8"),
      /^  - action: runEvidence\n    resource: "\*"\n    effect: deny$/m,
    );
    assert.match(
      readFileSync(resolve(repoRoot, `.opencode/agents/${role}.md`), "utf8"),
      /^  - action: inspectGitRange\n    resource: "\*"\n    effect: deny$/m,
    );
  }
  const planPermissions = openCodePlanAgent().permissions as Array<{
    action: string;
    effect: string;
  }>;
  assert.ok(
    planPermissions.some((rule) => rule.action === "inspectGitRange" && rule.effect === "deny"),
  );
  assert.ok(
    planPermissions.some((rule) => rule.action === "runEvidence" && rule.effect === "deny"),
  );
});

test("the self-host Native Plan prompt keeps the CTA outside the exact plan rendering", () => {
  const parsed = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    agents: { plan: { system: string } };
  };
  const prompt = parsed.agents.plan.system;
  const normalized = prompt.replace(/\s+/gu, " ");
  for (const phrase of [
    "Direct `workflow_state_*` tools are the required contract path for Workflow operations.",
    "`execute` remains available for unrelated work and must not be intentionally selected as a Workflow transport.",
  ]) {
    assert.ok(normalized.includes(phrase), `missing Native Plan transport contract: ${phrase}`);
  }
  assert.doesNotMatch(
    JSON.stringify(openCodePlanAgent().permissions),
    /execute.*deny/u,
    "self-host Native Plan must preserve unrelated execute availability",
  );
  const sourceSection = normalized.indexOf("Authoritative task-source preservation:");
  const delegation = normalized.indexOf(
    "For every substantial non-trivial change-planning request, and for every material refinement,",
    sourceSection,
  );
  assert.ok(sourceSection >= 0, "self-host Plan must define the task-source boundary");
  assert.ok(delegation > sourceSection, "self-host source handling must precede delegation");
  for (const phrase of [
    "complete supplied contents of an issue, ticket, specification, design brief, or similar task source as authoritative",
    "exactly as supplied, character-for-character",
    "clearly delimited authoritative-source section",
    "Construct that task in this order: bounded host/planner wrapper, an opening <authoritative_task_source> marker, the exact source, the closing </authoritative_task_source> marker",
    "The closing marker must immediately follow the source's final character",
    "no wrapper, caller, Plan Mode, <system-reminder>, or other host text may occur between the markers",
    "Host-injected <system-reminder> or # Plan Mode - System Reminder content is never authoritative source content",
    "exclude it from the source and keep it after the closing marker",
    "Treat the markers as transport boundaries, not source bytes",
    "Keep the bounded host/planner wrapper separate from that source",
    "Make the delegated planner task self-contained",
    "genuinely separate from the source and label it as non-authoritative context",
    "Do not paraphrase, summarize, normalize, omit, truncate, reconstruct, or pre-plan",
    "repository investigation and repository-specific plan derivation belong to the isolated planner",
    "Ordinary conversational planning without an explicitly identified complete authoritative source retains bounded task formulation",
    "missing or referenced source, explicitly incomplete source, explicitly summarized source, or explicitly non-authoritative context",
    "Never copy arbitrary parent conversation history",
    "source that exists only in an inaccessible parent message",
    "hard host payload or context limit prevents safely carrying",
    "fail closed with bounded input or clarification",
    "planner uses them directly and does not redundantly re-fetch them solely for duplication or verification",
    "Compatibility limitation: this is the strongest currently supported prompt-level fallback",
    "not a host-typed or immutable payload, collision-proof parser, or semantic sandbox",
    "The delimiters are convention only; they do not make source bytes trusted or prevent model-level prompt injection",
    "Do not replace this fallback with a guessed adapter or claim mechanical preservation",
    "supported OpenCode mechanism passes fresh end-to-end dogfood",
  ]) {
    assert.ok(normalized.includes(phrase), `missing self-host source contract: ${phrase}`);
  }
  const fullPlanPresentation = normalized.indexOf(
    "Present the authoritative `full_plan` character-for-character as Markdown",
  );
  const cta = normalized.indexOf(
    "After rendering it, add a concise CTA separately, outside the authoritative `full_plan`",
  );
  const approvalWait = normalized.indexOf("Wait for an explicit user instruction approving");
  assert.ok(fullPlanPresentation >= 0, "Plan must present full_plan character-for-character");
  assert.ok(cta > fullPlanPresentation, "CTA must follow exact full_plan presentation");
  assert.ok(approvalWait > cta, "approval must wait until after the separate CTA");
  assert.match(normalized.slice(cta, approvalWait), /natural-language approval/u);
  assert.match(normalized.slice(cta, approvalWait), /that exact displayed candidate/u);
  assert.match(normalized.slice(cta, approvalWait), /natural-language revision request/u);
  assert.match(
    normalized.slice(cta, approvalWait),
    /never put CTA text inside or alter the `full_plan`/u,
  );
  for (const phrase of [
    "ordinary user-facing presentation, show `plan_ref` plus revision",
    "do not show the UUID `plan_id`",
    "Raw UUID display is permitted only for an explicit diagnostics, debugging, or protocol request",
    "internal Native Plan → Orchestrator handoff containing the exact UUID `plan_id` plus exact revision",
    "parent-read the same exact identity again",
    "Preserve the exact UUID and revision for Orchestrator's parent reads, approval, revision, workflow creation, provenance, and every other MCP call",
    "never ask the user to transcribe either identifier",
    "internal handoff must never be rendered in ordinary user-facing output",
    "After approval, present `plan_ref` plus revision",
    "do not report the UUID",
  ]) {
    assert.ok(
      normalized.includes(phrase),
      `missing plan-reference presentation contract: ${phrase}`,
    );
  }
  assert.match(
    normalized,
    /parent-read the same exact identity again.*workflow_state_plan_approve/u,
  );
  assert.match(normalized, /Never create a workflow or dispatch an implementer/u);
  assert.match(normalized, /For refinement, send the exact plan identity, exact base revision/u);
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
  assert.match(orchestrator, /^  - action: edit\n    resource: "\*"\n    effect: deny$/m);
  assert.match(orchestrator, /^  - action: subagent\n    resource: "\*"\n    effect: deny$/m);
  assert.ok(!orchestrator.match(/^    resource: "planner"$/m));
  assert.ok(!orchestrator.match(/^    resource: "explorer"$/m));
  for (const agent of ["implementer", "code_reviewer", "committer"]) {
    assert.match(
      orchestrator,
      new RegExp(`^  - action: subagent\\n    resource: "${agent}"\\n    effect: allow$`, "m"),
    );
  }
  assert.match(
    orchestrator,
    /^  - action: workflow_state_\*\n    resource: "\*"\n    effect: deny$/m,
  );
  const allowedWorkflowTools = [
    ...orchestrator.matchAll(
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
    "Direct `workflow_state_*` tools are the required contract path for Workflow operations.",
    "`execute` remains available for unrelated work and must not be intentionally selected as a Workflow transport.",
    "do not implement, independently review, stage, or commit",
    "bounded, read-only preflight",
    "exact returned `workflow_id`",
    "implement the plan",
    "`terminal` descriptor reports its authoritative outcome",
    "explicit work-item metadata",
    "work_items",
    "do not discover identifiers externally",
    "retranscribe them when creating linked follow-ups",
    "Built-in Plan is the user-facing planning mediator",
    "exact `plan_id` and revision",
    "workflow_create_from_plan",
    "Verify that it is the current",
    "do not pass pasted plan text",
    "workflow_create_linked_followup_from_plan",
    "never pass or retranscribe its full plan",
    "classify the requested work against the immutable approved intent",
    "unchanged objective, desired outcome, acceptance criteria, and logical-change",
    "ordinary repair",
    "exact eligible/selected finding binding",
    "workflow_rebind_implementation_plan",
    "approved_recovery_plan_context",
    "Never put revised-plan authority",
    "resume_context",
    "changed intent",
    "new bounded objective and exact scope",
    "Do not use repair, adjudication, `workflow_expand_scope`, or a generic linked follow-up",
    "workflow_type: review_only",
    "review_mode: working_tree",
    "current HEAD as `base_revision`",
    "`head_revision: null`",
    "`include_staged`, `include_unstaged`, and `include_untracked`",
    "exact complete repository-relative `approved_paths`",
    "fresh execution descriptor supplies the returned route for every subsequent dispatch or mutation",
    "a returned wait, terminal result, failure, or different route overrides any narrative lifecycle expectation",
    "A fresh review may expose a repair authorization descriptor",
    "Approval remains separate from explicit commit authorization",
    "Optional findings never trigger remediation",
    "supported active source states",
    "exact current finding IDs",
    "fresh combined review",
    "If a worker reports `ERROR_NOT_FOUND` for a role-owned Workflow MCP lookup or use",
    "identity/handoff failure",
    "before the worker's first successful getter or during a later terminal Workflow MCP call",
    "verify the exact authoritative `workflow_id` from the parent with `workflow_operator_decision_get`",
    "Never copy, repair, normalize, typo-correct, discover, or select a workflow ID",
    "Consume only the fresh returned descriptor",
    "a successful parent read does not authorize dispatch by itself",
    "Redispatch one fresh worker with the same exact authoritative workflow ID only when that descriptor still selects the same worker route",
    "returned `wait`, `parent_mutation`, `terminal`, or different route",
    "identity/handoff retry guard execution-local and allow at most one such redispatch",
    "A second equivalent failure stops for explicit intervention",
    "If the exact parent read fails or Workflow MCP is unavailable",
    "do not infer or reconstruct workflow state",
  ]) {
    assert.ok(normalized.includes(phrase), `missing orchestrator contract: ${phrase}`);
  }
  assert.match(
    normalized,
    /`ERROR_NOT_FOUND`[\s\S]*?`workflow_operator_decision_get`[\s\S]*?fresh returned descriptor[\s\S]*?same worker route[\s\S]*?at most one such redispatch/u,
    "worker identity recovery must verify the parent before bounded redispatch",
  );
  assert.match(
    normalized,
    /If the exact parent read fails or Workflow MCP is unavailable[\s\S]*?MCP-unavailable suspension/u,
    "failed parent verification must preserve MCP-unavailable recovery",
  );
  for (const forbidden of [
    "Session.Metadata routing",
    "session binding map",
    "Workflow MCP-side session registry",
    "implicit current workflow",
  ]) {
    assert.ok(!normalized.includes(forbidden), `recovery must not add ${forbidden}`);
  }
  assert.doesNotMatch(
    orchestrator,
    /action: execute[\s\S]*?effect: deny/u,
    "self-host Orchestrator must preserve unrelated execute availability",
  );

  const routeStart = normalized.indexOf("For final-tree reconciliation");
  const routeEnd = normalized.indexOf(
    "Before `workflow_create` or `workflow_create_from_plan`, extract",
    routeStart,
  );
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "missing isolated reconciliation route");
  const reconciliation = normalized.slice(routeStart, routeEnd);
  assert.match(
    reconciliation,
    /`workflow_type: review_only` with `review_mode: working_tree`, current HEAD as `base_revision`, `head_revision: null`, and `include_staged`, `include_unstaged`, and `include_untracked` all `true`/u,
    "reconciliation must use the complete working-tree review target",
  );
  assert.match(
    reconciliation,
    /exact complete repository-relative `approved_paths` allowlist.*including staged, unstaged, and approved-untracked content while excluding unrelated and ignored state/u,
    "reconciliation must isolate the complete logical-change scope",
  );
  assert.match(
    reconciliation,
    /fresh execution descriptor supplies the returned route for every subsequent dispatch or mutation/u,
    "reconciliation must route from the returned descriptor",
  );
  assert.match(
    reconciliation,
    /a returned wait, terminal result, failure, or different route overrides any narrative lifecycle expectation/u,
    "reconciliation must not impose a narrative lifecycle route",
  );
  const approval = reconciliation.indexOf("Approval remains separate");
  const commitAuthorization = reconciliation.indexOf("commit authorization");
  const coherentCommit = reconciliation.indexOf("one coherent commit");
  assert.ok(
    approval >= 0 && approval < commitAuthorization && commitAuthorization < coherentCommit,
    "reconciliation must separate approval from commit authorization",
  );
  assert.ok(!existsSync(resolve(repoRoot, ".opencode/ORCHESTRATION.md")));
});

test("the orchestrator exposes the complete parent planning tool surface", () => {
  const orchestrator = readFileSync(resolve(repoRoot, orchestratorPath), "utf8");
  const allowed = new Set(
    [
      ...orchestrator.matchAll(
        /^  - action: workflow_state_([a-z0-9_]+)\n    resource: "\*"\n    effect: allow$/gmu,
      ),
    ].map((match) => match[1]),
  );
  const serverTools = new Set(tools.map((tool) => tool.name));
  for (const name of [
    "plan_parent_get",
    "workflow_create_from_plan",
    "workflow_record_manual_validation",
  ]) {
    assert.ok(allowed.has(name), `orchestrator must allow ${name}`);
    assert.ok(serverTools.has(name), `server must expose ${name}`);
  }
  for (const name of ["plan_create", "plan_get", "plan_revise", "plan_approve"]) {
    assert.equal(allowed.has(name), false, `orchestrator must not allow planner operation ${name}`);
  }
});

test("the orchestrator preflights the exact reviewer validation policy", () => {
  const orchestratorFile = resolve(repoRoot, orchestratorPath);
  const orchestrator = readFileSync(orchestratorFile, "utf8");
  const normalized = orchestrator.replace(/\s+/gu, " ");
  for (const phrase of [
    "Before calling `workflow_create` or `workflow_create_from_plan`, read the repository's `.codex/reviewer-validation.json` policy",
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
  const { experimental, mcp } = JSON.parse(readFileSync(selfHostConfig, "utf8")) as {
    experimental: { subagent_depth: number };
    mcp: {
      servers: {
        workflow_state: {
          type: string;
          command: string[];
          timeout: { catalog: number; execution: number };
          codemode: boolean;
        };
      };
    };
  };
  const registration = mcp.servers.workflow_state;
  assert.equal(registration.type, "local");
  assert.deepEqual(registration.timeout, { catalog: 30000, execution: 30000 });
  assert.equal(registration.codemode, false);
  assert.equal(experimental.subagent_depth, 2);
  assert.deepEqual(registration.command, trustedBootstrapCommand(relativeServerPath));
  assert.ok(existsSync(resolve(repoRoot, relativeServerPath)), "the bootstrap source must exist");
});
