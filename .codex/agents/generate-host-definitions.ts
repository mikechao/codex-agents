#!/usr/bin/env bun
// Generates the host-specific agent definitions from the canonical contract
// fragments in .codex/agents/contracts/. Structural host configuration remains
// in this typed adapter; model and reasoning choices live in model-policy.yaml.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { YAML } from "bun";
import { WORKFLOW_ACTION_VALUES_BY_ACTOR } from "../workflow-mcp/workflow-action-registry.js";

const ROOT = resolve(import.meta.dir);
const CONTRACTS_DIR = resolve(ROOT, "contracts");
const CODEX_AGENTS_DIR = resolve(ROOT);
const OPENCODE_AGENTS_DIR = resolve(ROOT, "../../.opencode/agents");
export const MODEL_POLICY_PATH = resolve(ROOT, "model-policy.yaml");

export type HostName = "codex" | "opencode";
export type RoleName = "implementer" | "code_reviewer" | "committer" | "planner" | "explorer";
export type ReasoningEffort = "low" | "medium" | "high";

const EXECUTION_ROLE_NAMES = ["implementer", "code_reviewer", "committer"] as const;
const ROLE_NAMES: readonly RoleName[] = [...EXECUTION_ROLE_NAMES, "planner", "explorer"];
const HOST_NAMES: readonly HostName[] = ["codex", "opencode"];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

export interface ModelPolicy {
  models: Record<string, { codex: string; opencode: string }>;
  agents: Partial<
    Record<RoleName, Partial<Record<HostName, { model: string; reasoning: ReasoningEffort }>>>
  >;
}

export interface GenerateOptions {
  policy?: ModelPolicy;
  policyPath?: string;
  contractsDir?: string;
  codexAgentsDir?: string;
  opencodeAgentsDir?: string;
  codexWorkflowMcp?: CodexWorkflowMcpTransport;
}

export interface CodexWorkflowMcpTransport {
  enabled: boolean;
  command: string;
  args: readonly string[];
  startupTimeoutSec: number;
  toolTimeoutSec: number;
  required: boolean;
  defaultToolsApprovalMode: string;
}

export interface GeneratedAgentDefinition {
  role: RoleName;
  host: HostName;
  filename: string;
  content: string;
}

export const HOST_IDENTITY_MARKER = "__HOST_IDENTITY__";
export const OPENCODE_TERMINAL_SECTION_HEADING = "## Required terminal response (OpenCode-only)";
const SHARED_WORKFLOW_TRANSPORT_PATTERN =
  /Direct host-provided `workflow_state_\*` tools are the required contract path for Workflow\s+operations\./gu;
const OPENCODE_WORKFLOW_TRANSPORT_CLARIFICATION =
  "`execute` remains available for unrelated work and must not be intentionally selected as a Workflow transport.";

interface CodexMetadata {
  sandboxMode: string;
  workflowMcpEnabledTools: readonly string[];
}

interface OpenCodeMetadata {
  description: string;
  permissions: readonly OpenCodePermissionRule[];
  terminalTool?: string;
  finalReportLabel?: string;
  hidden?: boolean;
}

interface OpenCodePermissionRule {
  action: string;
  resource: string;
  effect: "allow" | "ask" | "deny";
}

interface RoleSpec {
  name: RoleName;
  description: string;
  codex?: CodexMetadata;
  opencode: OpenCodeMetadata;
}

// Codex custom-agent layers use the MCP server's enabled_tools allowlist as a
// fail-closed boundary. Keep this mapping in typed host metadata rather than
// in model-policy.yaml, which is intentionally limited to model assignments
// and reasoning effort.
export const CODEX_WORKFLOW_MCP_ENABLED_TOOLS = {
  implementer: WORKFLOW_ACTION_VALUES_BY_ACTOR.implementer,
  code_reviewer: WORKFLOW_ACTION_VALUES_BY_ACTOR.reviewer,
  committer: WORKFLOW_ACTION_VALUES_BY_ACTOR.committer,
} as const satisfies Record<(typeof EXECUTION_ROLE_NAMES)[number], readonly string[]>;

// A standalone Codex custom-agent file is parsed as a complete ConfigToml
// before it is layered onto the parent configuration. Keep a complete,
// disabled registration in the checked-in self-host definitions so those
// files remain valid without enabling the repository's own server. Installer
// materialization supplies the enabled absolute provider registration instead.
export const SELF_HOST_CODEX_WORKFLOW_MCP: CodexWorkflowMcpTransport = {
  enabled: false,
  command: "sh",
  args: [
    "-c",
    'export WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT="$PWD"; bootstrap=$(mktemp) && trap \'rm -f "$bootstrap"\' EXIT && git show HEAD:.codex/workflow-mcp/bootstrap.ts >"$bootstrap" && bun --no-warnings "$bootstrap"; status=$?; exit "$status"',
  ],
  startupTimeoutSec: 10,
  toolTimeoutSec: 30,
  required: false,
  defaultToolsApprovalMode: "prompt",
};

export function enabledCodexWorkflowMcp(serverPath: string): CodexWorkflowMcpTransport {
  return {
    ...SELF_HOST_CODEX_WORKFLOW_MCP,
    enabled: true,
    command: resolve(serverPath),
    args: [],
  };
}

// These are host serialization and behavioral boundaries, not policy values.
const ROLES: readonly RoleSpec[] = [
  {
    name: "implementer",
    description:
      "Executes an approved implementation plan, validates the changes, and reports the results.",
    codex: {
      sandboxMode: "workspace-write",
      workflowMcpEnabledTools: CODEX_WORKFLOW_MCP_ENABLED_TOOLS.implementer,
    },
    opencode: {
      description:
        "Executes an approved implementation plan, validates the changes, and reports the results.",
      permissions: [
        { action: "edit", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "allow" },
        { action: "shell", resource: "git add", effect: "deny" },
        { action: "shell", resource: "git add *", effect: "deny" },
        { action: "shell", resource: "git commit", effect: "deny" },
        { action: "shell", resource: "git commit *", effect: "deny" },
        { action: "shell", resource: "git push", effect: "deny" },
        { action: "shell", resource: "git push *", effect: "deny" },
        { action: "shell", resource: "git reset", effect: "deny" },
        { action: "shell", resource: "git reset *", effect: "deny" },
        { action: "shell", resource: "git rebase", effect: "deny" },
        { action: "shell", resource: "git rebase *", effect: "deny" },
        { action: "shell", resource: "git checkout", effect: "deny" },
        { action: "shell", resource: "git checkout *", effect: "deny" },
        { action: "shell", resource: "git switch", effect: "deny" },
        { action: "shell", resource: "git switch *", effect: "deny" },
        { action: "shell", resource: "git restore", effect: "deny" },
        { action: "shell", resource: "git restore *", effect: "deny" },
        { action: "shell", resource: "git revert", effect: "deny" },
        { action: "shell", resource: "git revert *", effect: "deny" },
        { action: "shell", resource: "git cherry-pick", effect: "deny" },
        { action: "shell", resource: "git cherry-pick *", effect: "deny" },
        { action: "shell", resource: "git rm", effect: "deny" },
        { action: "shell", resource: "git rm *", effect: "deny" },
        { action: "shell", resource: "git mv", effect: "deny" },
        { action: "shell", resource: "git mv *", effect: "deny" },
        { action: "shell", resource: "git clean", effect: "deny" },
        { action: "shell", resource: "git clean *", effect: "deny" },
        { action: "shell", resource: "git stash", effect: "deny" },
        { action: "shell", resource: "git stash *", effect: "deny" },
        { action: "runEvidence", resource: "*", effect: "deny" },
        { action: "inspectGitRange", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "workflow_state_*", resource: "*", effect: "deny" },
        ...CODEX_WORKFLOW_MCP_ENABLED_TOOLS.implementer.map((tool) => ({
          action: `workflow_state_${tool}`,
          resource: "*",
          effect: "allow" as const,
        })),
      ],
      terminalTool: "workflow_submit_implementation",
      finalReportLabel: "final implementation report",
    },
  },
  {
    name: "code_reviewer",
    description: "Performs an independent, read-only review of an approved implementation diff.",
    codex: {
      sandboxMode: "read-only",
      workflowMcpEnabledTools: CODEX_WORKFLOW_MCP_ENABLED_TOOLS.code_reviewer,
    },
    opencode: {
      description: "Performs an independent, read-only review of an approved implementation diff.",
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: "git status", effect: "allow" },
        { action: "shell", resource: "git status *", effect: "allow" },
        { action: "shell", resource: "git diff", effect: "allow" },
        { action: "shell", resource: "git diff *", effect: "allow" },
        { action: "shell", resource: "git log", effect: "allow" },
        { action: "shell", resource: "git log *", effect: "allow" },
        { action: "shell", resource: "git show *", effect: "allow" },
        { action: "shell", resource: "git rev-parse *", effect: "allow" },
        { action: "shell", resource: "git grep", effect: "allow" },
        { action: "shell", resource: "git grep *", effect: "allow" },
        { action: "shell", resource: "bun .codex/agents/change-receipt.ts *", effect: "allow" },
        {
          action: "shell",
          resource: "bun .codex/agents/reviewer-validation.ts *",
          effect: "allow",
        },
        { action: "runEvidence", resource: "*", effect: "deny" },
        { action: "inspectGitRange", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "workflow_state_*", resource: "*", effect: "deny" },
        ...CODEX_WORKFLOW_MCP_ENABLED_TOOLS.code_reviewer.map((tool) => ({
          action: `workflow_state_${tool}`,
          resource: "*",
          effect: "allow" as const,
        })),
      ],
      terminalTool: "workflow_submit_review",
      finalReportLabel: "final review report",
    },
  },
  {
    name: "committer",
    description:
      "Stages relevant project changes, generates an accurate commit message, and creates a Git commit.",
    codex: {
      sandboxMode: "workspace-write",
      workflowMcpEnabledTools: CODEX_WORKFLOW_MCP_ENABLED_TOOLS.committer,
    },
    opencode: {
      description:
        "Stages relevant project changes, generates an accurate commit message, and creates a Git commit.",
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: "git status", effect: "allow" },
        { action: "shell", resource: "git status *", effect: "allow" },
        { action: "shell", resource: "git diff", effect: "allow" },
        { action: "shell", resource: "git diff *", effect: "allow" },
        { action: "shell", resource: "git log", effect: "allow" },
        { action: "shell", resource: "git log *", effect: "allow" },
        { action: "shell", resource: "git show *", effect: "allow" },
        { action: "shell", resource: "git rev-parse", effect: "allow" },
        { action: "shell", resource: "git rev-parse *", effect: "allow" },
        { action: "shell", resource: "git ls-files", effect: "allow" },
        { action: "shell", resource: "git ls-files *", effect: "allow" },
        { action: "shell", resource: "git add *", effect: "allow" },
        { action: "shell", resource: "git commit", effect: "allow" },
        { action: "shell", resource: "git commit *", effect: "allow" },
        { action: "shell", resource: "bun .codex/agents/change-receipt.ts *", effect: "allow" },
        { action: "shell", resource: "git add -p", effect: "deny" },
        { action: "shell", resource: "git add -p *", effect: "deny" },
        { action: "shell", resource: "git add -i", effect: "deny" },
        { action: "shell", resource: "git add -i *", effect: "deny" },
        { action: "shell", resource: "git commit --amend", effect: "deny" },
        { action: "shell", resource: "git commit --amend *", effect: "deny" },
        { action: "shell", resource: "git push", effect: "deny" },
        { action: "shell", resource: "git push *", effect: "deny" },
        { action: "shell", resource: "git rebase", effect: "deny" },
        { action: "shell", resource: "git rebase *", effect: "deny" },
        { action: "shell", resource: "git reset", effect: "deny" },
        { action: "shell", resource: "git reset *", effect: "deny" },
        { action: "shell", resource: "git checkout", effect: "deny" },
        { action: "shell", resource: "git checkout *", effect: "deny" },
        { action: "shell", resource: "git switch", effect: "deny" },
        { action: "shell", resource: "git switch *", effect: "deny" },
        { action: "shell", resource: "git restore", effect: "deny" },
        { action: "shell", resource: "git restore *", effect: "deny" },
        { action: "shell", resource: "git rm", effect: "deny" },
        { action: "shell", resource: "git rm *", effect: "deny" },
        { action: "shell", resource: "git mv", effect: "deny" },
        { action: "shell", resource: "git mv *", effect: "deny" },
        { action: "shell", resource: "git clean", effect: "deny" },
        { action: "shell", resource: "git clean *", effect: "deny" },
        { action: "shell", resource: "git stash", effect: "deny" },
        { action: "shell", resource: "git stash *", effect: "deny" },
        { action: "runEvidence", resource: "*", effect: "deny" },
        { action: "inspectGitRange", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "workflow_state_*", resource: "*", effect: "deny" },
        ...CODEX_WORKFLOW_MCP_ENABLED_TOOLS.committer.map((tool) => ({
          action: `workflow_state_${tool}`,
          resource: "*",
          effect: "allow" as const,
        })),
      ],
      terminalTool: "workflow_submit_commit_result",
      finalReportLabel: "final commit report",
    },
  },
  {
    name: "planner",
    description: "Creates and refines repository-generic workflow-native implementation plans.",
    opencode: {
      description: "Creates and refines repository-generic workflow-native implementation plans.",
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "list", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: "git status", effect: "allow" },
        { action: "shell", resource: "git status *", effect: "allow" },
        { action: "shell", resource: "git diff", effect: "allow" },
        { action: "shell", resource: "git diff *", effect: "allow" },
        { action: "shell", resource: "git log", effect: "allow" },
        { action: "shell", resource: "git log *", effect: "allow" },
        { action: "shell", resource: "git show", effect: "allow" },
        { action: "shell", resource: "git show *", effect: "allow" },
        { action: "shell", resource: "git rev-parse", effect: "allow" },
        { action: "shell", resource: "git rev-parse *", effect: "allow" },
        { action: "shell", resource: "git ls-files", effect: "allow" },
        { action: "shell", resource: "git ls-files *", effect: "allow" },
        { action: "shell", resource: "git grep", effect: "allow" },
        { action: "shell", resource: "git grep *", effect: "allow" },
        { action: "runEvidence", resource: "*", effect: "deny" },
        { action: "inspectGitRange", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "allow" },
        { action: "websearch", resource: "*", effect: "allow" },
        { action: "lsp", resource: "*", effect: "deny" },
        { action: "skill", resource: "*", effect: "deny" },
        { action: "todowrite", resource: "*", effect: "deny" },
        { action: "todoread", resource: "*", effect: "deny" },
        { action: "doom_loop", resource: "*", effect: "deny" },
        { action: "question", resource: "*", effect: "deny" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "subagent", resource: "explorer", effect: "allow" },
        { action: "workflow_state_*", resource: "*", effect: "deny" },
        { action: "workflow_state_plan_create", resource: "*", effect: "allow" },
        { action: "workflow_state_plan_get", resource: "*", effect: "allow" },
        { action: "workflow_state_plan_revise", resource: "*", effect: "allow" },
      ],
    },
  },
  {
    name: "explorer",
    description: "Gathers bounded, read-only repository evidence for Native Plan and planner.",
    opencode: {
      description: "Gathers bounded, read-only repository evidence for Native Plan and planner.",
      permissions: [
        { action: "edit", resource: "*", effect: "deny" },
        { action: "read", resource: "*", effect: "allow" },
        { action: "glob", resource: "*", effect: "allow" },
        { action: "grep", resource: "*", effect: "allow" },
        { action: "list", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "deny" },
        { action: "shell", resource: "git status", effect: "allow" },
        { action: "shell", resource: "git status --short", effect: "allow" },
        { action: "shell", resource: "git status --porcelain", effect: "allow" },
        { action: "shell", resource: "git diff", effect: "allow" },
        { action: "shell", resource: "git diff --cached", effect: "allow" },
        { action: "shell", resource: "git diff HEAD", effect: "allow" },
        { action: "shell", resource: "git log", effect: "allow" },
        { action: "shell", resource: "git log -1", effect: "allow" },
        { action: "shell", resource: "git log --oneline", effect: "allow" },
        { action: "shell", resource: "git show", effect: "allow" },
        { action: "shell", resource: "git show HEAD", effect: "allow" },
        { action: "shell", resource: "git rev-parse --show-toplevel", effect: "allow" },
        { action: "shell", resource: "git rev-parse --is-inside-work-tree", effect: "allow" },
        { action: "shell", resource: "git ls-files", effect: "allow" },
        { action: "shell", resource: "git grep", effect: "allow" },
        { action: "runEvidence", resource: "*", effect: "allow" },
        { action: "inspectGitRange", resource: "*", effect: "allow" },
        { action: "subagent", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "deny" },
        { action: "webfetch", resource: "*", effect: "deny" },
        { action: "websearch", resource: "*", effect: "deny" },
        { action: "lsp", resource: "*", effect: "deny" },
        { action: "skill", resource: "*", effect: "deny" },
        { action: "todowrite", resource: "*", effect: "deny" },
        { action: "todoread", resource: "*", effect: "deny" },
        { action: "doom_loop", resource: "*", effect: "deny" },
        { action: "question", resource: "*", effect: "deny" },
        { action: "workflow_state_*", resource: "*", effect: "deny" },
      ],
      hidden: true,
    },
  },
];

function fail(context: string, detail: string): never {
  throw new Error(`Invalid model policy${context ? ` ${context}` : ""}: ${detail}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`at ${context}`, "expected an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`at ${context}`, `expected exactly: ${wanted.join(", ")}`);
  }
}

function safeModelIdentifier(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    fail(`at ${context}`, "model identifier must be a non-empty string");
  }
  if (
    value.includes("\n") ||
    value.includes("\r") ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)
  ) {
    fail(`at ${context}`, "model identifier must be single-line and safely renderable");
  }
  return value;
}

function reasoning(value: unknown, context: string): ReasoningEffort {
  if (typeof value !== "string" || !REASONING_EFFORTS.includes(value as ReasoningEffort)) {
    fail(`at ${context}`, `reasoning must be one of: ${REASONING_EFFORTS.join(", ")}`);
  }
  return value as ReasoningEffort;
}

function rejectDuplicateBlockKeys(text: string, source: string): void {
  const stack: Array<{ indent: number; path: string }> = [];
  const seen = new Set<string>();
  for (const [lineNumber, line] of text.split(/\r?\n/u).entries()) {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/u.exec(line);
    if (match === null || line.trimStart().startsWith("#")) continue;
    const indent = match[1].length;
    while (stack.at(-1)?.indent !== undefined && (stack.at(-1)?.indent ?? 0) >= indent) {
      stack.pop();
    }
    const path = [...stack.map((item) => item.path), match[2]].join(".");
    if (seen.has(path)) {
      throw new Error(
        `Invalid model policy ${source}: duplicate key ${path} at line ${lineNumber + 1}`,
      );
    }
    seen.add(path);
    stack.push({ indent, path });
  }
}

export function parseModelPolicy(text: string, source = "model-policy.yaml"): ModelPolicy {
  let parsed: unknown;
  try {
    rejectDuplicateBlockKeys(text, source);
    parsed = YAML.parse(text);
  } catch (cause) {
    throw new Error(
      `Invalid model policy ${source}: malformed YAML (${cause instanceof Error ? cause.message : String(cause)})`,
      { cause },
    );
  }
  const root = record(parsed, "root");
  exactKeys(root, ["models", "agents"], "root");
  const modelsRecord = record(root.models, "models");
  const models: Record<string, { codex: string; opencode: string }> = {};
  for (const [alias, raw] of Object.entries(modelsRecord)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(alias)) fail(`at models`, `invalid model alias: ${alias}`);
    const model = record(raw, `models.${alias}`);
    exactKeys(model, HOST_NAMES, `models.${alias}`);
    models[alias] = {
      codex: safeModelIdentifier(model.codex, `models.${alias}.codex`),
      opencode: safeModelIdentifier(model.opencode, `models.${alias}.opencode`),
    };
  }
  if (Object.keys(models).length === 0) fail("at models", "at least one model alias is required");

  const agentsRecord = record(root.agents, "agents");
  const actualRoles = Object.keys(agentsRecord);
  const unexpectedRoles = actualRoles.filter((role) => !ROLE_NAMES.includes(role as RoleName));
  if (
    unexpectedRoles.length > 0 ||
    EXECUTION_ROLE_NAMES.some((role) => !actualRoles.includes(role))
  ) {
    fail(
      "at agents",
      `expected execution roles and optional planning roles: ${ROLE_NAMES.join(", ")}`,
    );
  }
  const agents: ModelPolicy["agents"] = {};
  for (const role of ROLE_NAMES) {
    if (!Object.hasOwn(agentsRecord, role)) continue;
    const roleRecord = record(agentsRecord[role], `agents.${role}`);
    const allowedHosts = EXECUTION_ROLE_NAMES.some((candidate) => candidate === role)
      ? HOST_NAMES
      : (["opencode"] as const);
    exactKeys(roleRecord, allowedHosts, `agents.${role}`);
    const hostAssignments = {} as Partial<
      Record<HostName, { model: string; reasoning: ReasoningEffort }>
    >;
    for (const host of allowedHosts) {
      const assignment = record(roleRecord[host], `agents.${role}.${host}`);
      exactKeys(assignment, ["model", "reasoning"], `agents.${role}.${host}`);
      if (typeof assignment.model !== "string" || !Object.hasOwn(models, assignment.model)) {
        fail(`at agents.${role}.${host}.model`, `unknown model alias: ${String(assignment.model)}`);
      }
      hostAssignments[host] = {
        model: assignment.model,
        reasoning: reasoning(assignment.reasoning, `agents.${role}.${host}.reasoning`),
      };
    }
    agents[role] = hostAssignments;
  }
  return { models, agents };
}

export function loadModelPolicy(policyPath = MODEL_POLICY_PATH): ModelPolicy {
  return parseModelPolicy(readFileSync(policyPath, "utf8"), policyPath);
}

export function resolveModelPolicy(
  policy: ModelPolicy,
  role: RoleName,
  host: HostName,
): { model: string; reasoning: ReasoningEffort } {
  const assignment = policy.agents[role]?.[host];
  if (assignment === undefined) throw new Error(`No model policy assignment for ${role}/${host}`);
  return { model: policy.models[assignment.model][host], reasoning: assignment.reasoning };
}

function tomlEscape(value: string): string {
  if (value.includes('"""')) throw new Error(`contract body contains a TOML terminator: ${value}`);
  return value.replace(/\\/g, "\\\\");
}

function tomlBasicString(value: string): string {
  if (value.includes('"""'))
    throw new Error(`transport value contains a TOML terminator: ${value}`);
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

function injectHostIdentity(body: string, identity: string, role: RoleName): string {
  const count = body.split(HOST_IDENTITY_MARKER).length - 1;
  if (count !== 1)
    throw new Error(
      `contract for ${role} must contain exactly one ${HOST_IDENTITY_MARKER} identity marker`,
    );
  return body.replace(HOST_IDENTITY_MARKER, identity);
}

function opencodeProjectionBody(spec: RoleSpec, body: string): string {
  if (!EXECUTION_ROLE_NAMES.some((role) => role === spec.name)) return body;
  const occurrences = body.match(SHARED_WORKFLOW_TRANSPORT_PATTERN) ?? [];
  if (occurrences.length !== 1) {
    throw new Error(
      `contract for ${spec.name} must contain exactly one shared Workflow transport sentence`,
    );
  }
  return body.replace(
    SHARED_WORKFLOW_TRANSPORT_PATTERN,
    (sentence) => `${sentence} ${OPENCODE_WORKFLOW_TRANSPORT_CLARIFICATION}`,
  );
}

function codexToml(
  spec: RoleSpec,
  assignment: { model: string; reasoning: ReasoningEffort },
  body: string,
  transport: CodexWorkflowMcpTransport,
): string {
  if (spec.codex === undefined) throw new Error(`Role ${spec.name} is not available for Codex`);
  const header = [
    `name = "${spec.name}"`,
    `description = "${spec.description}"`,
    `model = "${assignment.model}"`,
    `model_reasoning_effort = "${assignment.reasoning}"`,
    `sandbox_mode = "${spec.codex.sandboxMode}"`,
  ].join("\n");
  const workflowMcp = [
    "[mcp_servers.workflow_state]",
    `enabled = ${transport.enabled}`,
    `command = "${tomlBasicString(transport.command)}"`,
    `args = [${transport.args.map((arg) => `"${tomlBasicString(arg)}"`).join(", ")}]`,
    `startup_timeout_sec = ${transport.startupTimeoutSec}`,
    `tool_timeout_sec = ${transport.toolTimeoutSec}`,
    `required = ${transport.required}`,
    `default_tools_approval_mode = "${tomlBasicString(transport.defaultToolsApprovalMode)}"`,
    `enabled_tools = [${spec.codex.workflowMcpEnabledTools.map((tool) => `"${tomlEscape(tool)}"`).join(", ")}]`,
  ].join("\n");
  const identity = `${assignment.model} | Reasoning: ${assignment.reasoning}`;
  return `${header}\n\ndeveloper_instructions = """\n${tomlEscape(injectHostIdentity(body, identity, spec.name))}\n"""\n\n${workflowMcp}\n`;
}

function opencodeMarkdown(
  spec: RoleSpec,
  assignment: { model: string; reasoning: ReasoningEffort },
  body: string,
): string {
  const frontmatter = [
    "---",
    `description: ${spec.opencode.description}`,
    "mode: subagent",
    `model: ${assignment.model}#${assignment.reasoning}`,
    ...(spec.opencode.hidden === true ? ["hidden: true"] : []),
    "permissions:",
    ...spec.opencode.permissions.flatMap((rule) => [
      `  - action: ${rule.action}`,
      `    resource: ${JSON.stringify(rule.resource)}`,
      `    effect: ${rule.effect}`,
    ]),
    "---",
  ].join("\n");
  const identity = `${assignment.model} | Reasoning: ${assignment.reasoning}`;
  return `${frontmatter}\n${injectHostIdentity(opencodeProjectionBody(spec, body), identity, spec.name)}${
    spec.opencode.terminalTool === undefined ? "" : opencodeTerminalHandoff(spec)
  }\n`;
}

function opencodeTerminalHandoff(spec: RoleSpec): string {
  const { terminalTool, finalReportLabel } = spec.opencode;
  if (terminalTool === undefined || finalReportLabel === undefined) return "";
  const failureClause =
    spec.name === "committer"
      ? " The report is required whether the commit succeeded or failed."
      : "";
  return [
    "",
    "",
    OPENCODE_TERMINAL_SECTION_HEADING,
    "",
    "Every subagent invocation must terminate with a non-empty normal assistant text response.",
    "A successful MCP tool call is never itself the final response, and an empty final report is",
    "never acceptable.",
    "",
    `The MCP submission (\`${terminalTool}\`) is the authoritative machine-readable workflow-state`,
    "handoff; the final assistant response is the parent-agent handoff. Both are required and",
    "neither replaces the other.",
    "",
    `Ordering: complete the role work first, then call \`${terminalTool}\`, and only after it succeeds`,
    `write the ${finalReportLabel} as a non-empty normal assistant text response. Do not end`,
    `immediately after the tool call.${failureClause}`,
  ].join("\n");
}

export function generateDefinitionManifest(
  options: GenerateOptions = {},
): GeneratedAgentDefinition[] {
  const policy = options.policy ?? loadModelPolicy(options.policyPath ?? MODEL_POLICY_PATH);
  const contractsDir = options.contractsDir ?? CONTRACTS_DIR;
  const codexWorkflowMcp = options.codexWorkflowMcp ?? SELF_HOST_CODEX_WORKFLOW_MCP;
  const manifest: GeneratedAgentDefinition[] = [];
  for (const spec of ROLES) {
    const body = readFileSync(resolve(contractsDir, `${spec.name}.md`), "utf8").trimEnd();
    const availableHosts: readonly HostName[] =
      spec.codex === undefined ? ["opencode"] : HOST_NAMES;
    for (const host of availableHosts) {
      const assignment = resolveModelPolicy(policy, spec.name, host);
      manifest.push({
        role: spec.name,
        host,
        filename: host === "codex" ? `${spec.name}.toml` : `${spec.name}.md`,
        content:
          host === "codex"
            ? codexToml(spec, assignment, body, codexWorkflowMcp)
            : opencodeMarkdown(spec, assignment, body),
      });
    }
  }
  return manifest;
}

export interface GeneratedDefinitions {
  [path: string]: string;
}

export function generateDefinitions(options: GenerateOptions = {}): GeneratedDefinitions {
  const codexDir = options.codexAgentsDir ?? CODEX_AGENTS_DIR;
  const opencodeDir = options.opencodeAgentsDir ?? OPENCODE_AGENTS_DIR;
  const definitions: GeneratedDefinitions = {};
  for (const definition of generateDefinitionManifest(options)) {
    const directory = definition.host === "codex" ? codexDir : opencodeDir;
    definitions[resolve(directory, definition.filename)] = definition.content;
  }
  return definitions;
}

function main(args: readonly string[]): number {
  const definitions = generateDefinitions();
  if (!args.includes("--write")) {
    for (const [path, content] of Object.entries(definitions))
      process.stdout.write(`== ${path}\n${content}`);
    return 0;
  }
  for (const [path, content] of Object.entries(definitions)) {
    if (!existsSync(dirname(path)))
      throw new Error(`generator output directory is missing: ${dirname(path)}`);
    writeFileSync(path, content);
  }
  process.stdout.write(`Wrote ${Object.keys(definitions).length} host agent definitions.\n`);
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
