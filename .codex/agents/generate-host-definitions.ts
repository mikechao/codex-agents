#!/usr/bin/env bun
// Generates the host-specific agent definitions from the canonical contract
// fragments in .codex/agents/contracts/. Structural host configuration remains
// in this typed adapter; model and reasoning choices live in model-policy.yaml.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { YAML } from "bun";

const ROOT = resolve(import.meta.dir);
const CONTRACTS_DIR = resolve(ROOT, "contracts");
const CODEX_AGENTS_DIR = resolve(ROOT);
const OPENCODE_AGENTS_DIR = resolve(ROOT, "../../.opencode/agents");
export const MODEL_POLICY_PATH = resolve(ROOT, "model-policy.yaml");

export type HostName = "codex" | "opencode";
export type RoleName = "implementer" | "code_reviewer" | "committer";
export type ReasoningEffort = "low" | "medium" | "high";

const ROLE_NAMES: readonly RoleName[] = ["implementer", "code_reviewer", "committer"];
const HOST_NAMES: readonly HostName[] = ["codex", "opencode"];
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high"];

export interface ModelPolicy {
  models: Record<string, { codex: string; opencode: string }>;
  agents: Record<RoleName, Record<HostName, { model: string; reasoning: ReasoningEffort }>>;
}

export interface GenerateOptions {
  policy?: ModelPolicy;
  policyPath?: string;
  contractsDir?: string;
  codexAgentsDir?: string;
  opencodeAgentsDir?: string;
}

export interface GeneratedAgentDefinition {
  role: RoleName;
  host: HostName;
  filename: string;
  content: string;
}

export const HOST_IDENTITY_MARKER = "__HOST_IDENTITY__";
export const OPENCODE_TERMINAL_SECTION_HEADING = "## Required terminal response (OpenCode-only)";

interface CodexMetadata {
  sandboxMode: string;
  workflowMcpEnabledTools: readonly string[];
}

interface OpenCodeMetadata {
  description: string;
  permission: string[];
  terminalTool: string;
  finalReportLabel: string;
}

interface RoleSpec {
  name: RoleName;
  description: string;
  codex: CodexMetadata;
  opencode: OpenCodeMetadata;
}

// Codex custom-agent layers use the MCP server's enabled_tools allowlist as a
// fail-closed boundary. Keep this mapping in typed host metadata rather than
// in model-policy.yaml, which is intentionally limited to model assignments
// and reasoning effort.
export const CODEX_WORKFLOW_MCP_ENABLED_TOOLS = {
  implementer: ["workflow_get", "workflow_submit_implementation"],
  code_reviewer: ["workflow_get", "workflow_begin_review", "workflow_submit_review"],
  committer: ["workflow_get", "workflow_prepare_commit", "workflow_submit_commit_result"],
} as const satisfies Record<RoleName, readonly string[]>;

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
      permission: [
        "  edit: allow",
        "  bash:",
        '    "*": allow',
        '    "git add": deny',
        '    "git add *": deny',
        '    "git commit": deny',
        '    "git commit *": deny',
        '    "git push": deny',
        '    "git push *": deny',
        '    "git reset": deny',
        '    "git reset *": deny',
        '    "git rebase": deny',
        '    "git rebase *": deny',
        '    "git checkout": deny',
        '    "git checkout *": deny',
        '    "git switch": deny',
        '    "git switch *": deny',
        '    "git restore": deny',
        '    "git restore *": deny',
        '    "git revert": deny',
        '    "git revert *": deny',
        '    "git cherry-pick": deny',
        '    "git cherry-pick *": deny',
        '    "git rm": deny',
        '    "git rm *": deny',
        '    "git mv": deny',
        '    "git mv *": deny',
        '    "git clean": deny',
        '    "git clean *": deny',
        '    "git stash": deny',
        '    "git stash *": deny',
        "  task:",
        '    "*": deny',
        "  workflow_state_*: deny",
        "  workflow_state_workflow_get: allow",
        "  workflow_state_workflow_submit_implementation: allow",
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
      permission: [
        "  edit: deny",
        "  bash:",
        '    "*": deny',
        '    "git status": allow',
        '    "git status *": allow',
        '    "git diff": allow',
        '    "git diff *": allow',
        '    "git log": allow',
        '    "git log *": allow',
        '    "git show *": allow',
        '    "git rev-parse *": allow',
        '    "git grep": allow',
        '    "git grep *": allow',
        '    "bun .codex/agents/change-receipt.ts *": allow',
        '    "bun .codex/agents/reviewer-validation.ts *": allow',
        "  task:",
        '    "*": deny',
        "  workflow_state_*: deny",
        "  workflow_state_workflow_get: allow",
        "  workflow_state_workflow_begin_review: allow",
        "  workflow_state_workflow_submit_review: allow",
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
      permission: [
        "  edit: deny",
        "  bash:",
        '    "*": deny',
        '    "git status": allow',
        '    "git status *": allow',
        '    "git diff": allow',
        '    "git diff *": allow',
        '    "git log": allow',
        '    "git log *": allow',
        '    "git show *": allow',
        '    "git rev-parse": allow',
        '    "git rev-parse *": allow',
        '    "git ls-files": allow',
        '    "git ls-files *": allow',
        '    "git add *": allow',
        '    "git commit": allow',
        '    "git commit *": allow',
        '    "bun .codex/agents/change-receipt.ts *": allow',
        '    "git add -p": deny',
        '    "git add -p *": deny',
        '    "git add -i": deny',
        '    "git add -i *": deny',
        '    "git commit --amend": deny',
        '    "git commit --amend *": deny',
        '    "git push": deny',
        '    "git push *": deny',
        '    "git rebase": deny',
        '    "git rebase *": deny',
        '    "git reset": deny',
        '    "git reset *": deny',
        '    "git checkout": deny',
        '    "git checkout *": deny',
        '    "git switch": deny',
        '    "git switch *": deny',
        '    "git restore": deny',
        '    "git restore *": deny',
        '    "git rm": deny',
        '    "git rm *": deny',
        '    "git mv": deny',
        '    "git mv *": deny',
        '    "git clean": deny',
        '    "git clean *": deny',
        '    "git stash": deny',
        '    "git stash *": deny',
        "  task:",
        '    "*": deny',
        "  workflow_state_*: deny",
        "  workflow_state_workflow_get: allow",
        "  workflow_state_workflow_prepare_commit: allow",
        "  workflow_state_workflow_submit_commit_result: allow",
      ],
      terminalTool: "workflow_submit_commit_result",
      finalReportLabel: "final commit report",
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
  exactKeys(agentsRecord, ROLE_NAMES, "agents");
  const agents = {} as ModelPolicy["agents"];
  for (const role of ROLE_NAMES) {
    const roleRecord = record(agentsRecord[role], `agents.${role}`);
    exactKeys(roleRecord, HOST_NAMES, `agents.${role}`);
    const hostAssignments = {} as Record<HostName, { model: string; reasoning: ReasoningEffort }>;
    for (const host of HOST_NAMES) {
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

function injectHostIdentity(body: string, identity: string, role: RoleName): string {
  const count = body.split(HOST_IDENTITY_MARKER).length - 1;
  if (count !== 1)
    throw new Error(
      `contract for ${role} must contain exactly one ${HOST_IDENTITY_MARKER} identity marker`,
    );
  return body.replace(HOST_IDENTITY_MARKER, identity);
}

function codexToml(
  spec: RoleSpec,
  assignment: { model: string; reasoning: ReasoningEffort },
  body: string,
): string {
  const header = [
    `name = "${spec.name}"`,
    `description = "${spec.description}"`,
    `model = "${assignment.model}"`,
    `model_reasoning_effort = "${assignment.reasoning}"`,
    `sandbox_mode = "${spec.codex.sandboxMode}"`,
  ].join("\n");
  const workflowMcp = [
    "[mcp_servers.workflow_state]",
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
    `model: ${assignment.model}`,
    `reasoningEffort: ${assignment.reasoning}`,
    "permission:",
    ...spec.opencode.permission,
    "---",
  ].join("\n");
  const identity = `${assignment.model} | Reasoning: ${assignment.reasoning}`;
  return `${frontmatter}\n${injectHostIdentity(body, identity, spec.name)}${opencodeTerminalHandoff(spec)}\n`;
}

function opencodeTerminalHandoff(spec: RoleSpec): string {
  const { terminalTool, finalReportLabel } = spec.opencode;
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
  const manifest: GeneratedAgentDefinition[] = [];
  for (const spec of ROLES) {
    const body = readFileSync(resolve(contractsDir, `${spec.name}.md`), "utf8").trimEnd();
    for (const host of HOST_NAMES) {
      const assignment = resolveModelPolicy(policy, spec.name, host);
      manifest.push({
        role: spec.name,
        host,
        filename: host === "codex" ? `${spec.name}.toml` : `${spec.name}.md`,
        content:
          host === "codex"
            ? codexToml(spec, assignment, body)
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
