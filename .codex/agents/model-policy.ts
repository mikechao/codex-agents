import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { YAML } from "bun";

const ROOT = resolve(import.meta.dir);
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

export type OpenCodeModelDefaultRole = "orchestrator" | RoleName;

export interface OpenCodeModelDefaultRow {
  role: OpenCodeModelDefaultRole;
  source: "opencode-session-default" | "model-policy";
  model: string;
  reasoning: ReasoningEffort | null;
}

const OPEN_CODE_MODEL_DEFAULT_ROLES: readonly OpenCodeModelDefaultRole[] = [
  "orchestrator",
  "implementer",
  "code_reviewer",
  "committer",
  "planner",
  "explorer",
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

export function projectOpenCodeModelDefaults(policy: ModelPolicy): OpenCodeModelDefaultRow[] {
  return OPEN_CODE_MODEL_DEFAULT_ROLES.map((role) =>
    role === "orchestrator"
      ? {
          role,
          source: "opencode-session-default",
          model: "inherits OpenCode/session default",
          reasoning: null,
        }
      : { role, source: "model-policy", ...resolveModelPolicy(policy, role, "opencode") },
  );
}
