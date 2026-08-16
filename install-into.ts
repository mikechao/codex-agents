#!/usr/bin/env bun

import { spawnSync, TOML } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";

const REGISTRATION_SECTION = ["mcp_servers", "workflow_state"];
const REQUIRED_SOURCE_FILES = [
  ".codex/workflow-mcp/server.ts",
  ".codex/agents/change-receipt.ts",
  ".codex/agents/code_reviewer.toml",
  ".codex/agents/committer.toml",
  ".codex/agents/implementer.toml",
  ".codex/agents/WORKFLOW.md",
  ".opencode/agents/code_reviewer.md",
  ".opencode/agents/committer.md",
  ".opencode/agents/implementer.md",
];
const COPY_SOURCE_FILES = [
  ".codex/agents/change-receipt.ts",
  ".codex/agents/code_reviewer.toml",
  ".codex/agents/committer.toml",
  ".codex/agents/implementer.toml",
  ".codex/agents/WORKFLOW.md",
  ".codex/agents/EVALS.md",
  ".codex/agents/EVAL_RESULTS.md",
];
const OPENCODE_COPY_SOURCE_FILES = [
  ".opencode/agents/implementer.md",
  ".opencode/agents/code_reviewer.md",
  ".opencode/agents/committer.md",
];
const MINIMUM_BUN = [1, 3, 0];
const OPENCODE_SERVER_NAME = "workflow_state";
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

function error(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage(): never {
  process.stderr.write("Usage: install-into.ts /absolute/path/to/target-repository\n");
  process.exit(2);
}

function bunVersionAtLeast(minimum: readonly number[]): boolean {
  const parts = Bun.version.split(".").map((part) => Number(part));
  if (parts.length < minimum.length || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}

function tomlString(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") {
      throw new Error("path cannot be represented in TOML");
    }
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function registrationBlock(projectRoot: string): string {
  return [
    "# Local durable state for the reusable custom-agent workflow.",
    "[mcp_servers.workflow_state]",
    'command = "bun"',
    `args = ["--no-warnings", ${tomlString(resolve(projectRoot, ".codex/workflow-mcp/server.ts"))}]`,
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 30",
    "required = false",
    'default_tools_approval_mode = "prompt"',
    "",
  ].join("\n");
}

export function hasWorkflowStateRegistration(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  let parsed: unknown;
  try {
    parsed = TOML.parse(readFileSync(configPath, "utf8"));
  } catch {
    error(`Existing config is not valid TOML; refusing to modify: ${configPath}`);
  }
  let section: unknown = parsed;
  for (const key of REGISTRATION_SECTION) {
    section = (section as Record<string, unknown> | null)?.[key];
    if (section === undefined || section === null) return false;
  }
  return section !== undefined && section !== null;
}

export function commitStaged(
  agentsStaging: string,
  agentsTarget: string,
  stagedConfig: string,
  config: string,
  rename: (from: string, to: string) => void = renameSync,
): void {
  rename(agentsStaging, agentsTarget);
  try {
    rename(stagedConfig, config);
  } catch (cause) {
    rmSync(agentsTarget, { recursive: true, force: true });
    throw cause;
  }
}

interface CommitStep {
  staging: string;
  target: string;
  original: string | null;
}

function rollback(committed: readonly CommitStep[]): void {
  for (const step of committed.slice().reverse()) {
    if (step.original === null) {
      rmSync(step.target, { recursive: true, force: true });
    } else {
      try {
        writeFileSync(step.target, step.original);
      } catch {
        // Best-effort restore; the pre-mutation collision checks prevent data loss.
      }
    }
  }
}

export function commitBothHosts(
  codexAgentsStaging: string,
  codexAgentsTarget: string,
  codexConfigStaging: string,
  codexConfigTarget: string,
  opencodeAgentsStaging: string,
  opencodeAgentsTarget: string,
  opencodeConfigStaging: string,
  opencodeConfigTarget: string,
  originalCodexConfig: string | null,
  originalOpenCodeConfig: string | null,
  rename: (from: string, to: string) => void = renameSync,
): void {
  const steps: readonly CommitStep[] = [
    { staging: codexAgentsStaging, target: codexAgentsTarget, original: null },
    { staging: codexConfigStaging, target: codexConfigTarget, original: originalCodexConfig },
    { staging: opencodeAgentsStaging, target: opencodeAgentsTarget, original: null },
    { staging: opencodeConfigStaging, target: opencodeConfigTarget, original: originalOpenCodeConfig },
  ];
  const committed: CommitStep[] = [];
  try {
    for (const step of steps) {
      rename(step.staging, step.target);
      committed.push(step);
    }
  } catch (cause) {
    rollback(committed);
    throw cause;
  }
}

function isGitRepository(target: string): boolean {
  const result = spawnSync(["git", "-C", target, "rev-parse", "--show-toplevel"], {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
}

function parseJsoncConfig(configPath: string, text: string): unknown {
  const errors: ParseError[] = [];
  const strict = configPath.endsWith(".json");
  const parsed = parseJsonc(text, errors, {
    disallowComments: strict,
    allowTrailingComma: !strict,
  });
  if (errors.length > 0) {
    error(`Existing config is not valid ${strict ? "JSON" : "JSONC"}; refusing to modify: ${configPath}`);
  }
  return parsed;
}

function objectValue(value: unknown, context: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    error(`${context} must be an object; refusing to modify the existing OpenCode config`);
  }
  return value as Record<string, unknown>;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => deepEqual(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
      )
    );
  }
  return false;
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

export function openCodeMcpRegistration(serverPath: string): Record<string, unknown> {
  return {
    type: "local",
    command: ["bun", "--no-warnings", serverPath],
    enabled: true,
    timeout: 30000,
  };
}

export function createOpenCodeConfig(serverPath: string): string {
  return JSON.stringify(
    {
      $schema: OPENCODE_CONFIG_SCHEMA,
      mcp: { [OPENCODE_SERVER_NAME]: openCodeMcpRegistration(serverPath) },
    },
    null,
    2,
  ) + "\n";
}

export function stageOpenCodeConfig(
  configPath: string,
  existing: string | null,
  serverPath: string,
): string {
  if (existing === null) return createOpenCodeConfig(serverPath);
  const parsedExisting = objectValue(parseJsoncConfig(configPath, existing), "mcp") ?? {};
  if (Object.prototype.hasOwnProperty.call(parsedExisting, "mcp")) {
    const mcp = objectValue(parsedExisting.mcp, "mcp");
    if (mcp !== null && Object.prototype.hasOwnProperty.call(mcp, OPENCODE_SERVER_NAME)) {
      error(`Refusing to replace existing OpenCode workflow_state registration: ${configPath}`);
    }
  }
  const edits = modify(existing, ["mcp", OPENCODE_SERVER_NAME], openCodeMcpRegistration(serverPath), {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const staged = applyEdits(existing, edits);
  const parsedStaged = objectValue(parseJsoncConfig(configPath, staged), "staged config");
  const stagedRecord = parsedStaged ?? {};
  if (!deepEqual(withoutKey(parsedExisting, "mcp"), withoutKey(stagedRecord, "mcp"))) {
    error(`Staged OpenCode config would alter unrelated settings; refusing to install: ${configPath}`);
  }
  const existingMcp = objectValue(parsedExisting.mcp, "mcp") ?? {};
  const stagedMcp = objectValue(stagedRecord.mcp, "mcp") ?? {};
  if (!deepEqual(withoutKey(existingMcp, OPENCODE_SERVER_NAME), withoutKey(stagedMcp, OPENCODE_SERVER_NAME))) {
    error(`Staged OpenCode config would alter unrelated MCP settings; refusing to install: ${configPath}`);
  }
  if (!deepEqual(stagedMcp[OPENCODE_SERVER_NAME], openCodeMcpRegistration(serverPath))) {
    error(`Staged OpenCode workflow_state registration is invalid; refusing to install: ${configPath}`);
  }
  if (configPath.endsWith(".json")) {
    try {
      JSON.parse(staged);
    } catch (cause) {
      error(`Staged OpenCode config is not valid JSON; refusing to install: ${configPath} (${cause instanceof Error ? cause.message : String(cause)})`);
    }
  }
  return staged;
}

export function hasOpenCodeWorkflowStateRegistration(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  const parsed = objectValue(parseJsoncConfig(configPath, readFileSync(configPath, "utf8")), "config");
  const mcp = parsed === null ? undefined : parsed.mcp;
  if (mcp === undefined || mcp === null) return false;
  if (typeof mcp !== "object" || Array.isArray(mcp)) return false;
  return Object.prototype.hasOwnProperty.call(mcp, OPENCODE_SERVER_NAME);
}

export function findOpenCodeConfig(target: string): string | null {
  const json = resolve(target, "opencode.json");
  const jsonc = resolve(target, "opencode.jsonc");
  const hasJson = existsSync(json);
  const hasJsonc = existsSync(jsonc);
  if (hasJson && hasJsonc) {
    error(`Both opencode.json and opencode.jsonc exist; refusing to modify either: ${target}`);
  }
  return hasJsonc ? jsonc : hasJson ? json : null;
}

export function main(args: readonly string[]): number {
  if (args.length !== 1) {
    usage();
  }
  const projectRoot = realpathSync(import.meta.dir);
  const target = resolve(args[0]);

  if (!isGitRepository(target)) {
    error(`Target is not a Git repository: ${target}`);
  }
  if (existsSync(resolve(target, ".codex/agents"))) {
    error(`Refusing to replace existing agent definitions: ${target}/.codex/agents`);
  }
  const config = resolve(target, ".codex/config.toml");
  if (hasWorkflowStateRegistration(config)) {
    error(`Refusing to replace existing workflow_state registration: ${config}`);
  }
  if (existsSync(resolve(target, ".opencode/agents"))) {
    error(`Refusing to replace existing OpenCode agent definitions: ${target}/.opencode/agents`);
  }
  const opencodeConfig = findOpenCodeConfig(target);
  if (opencodeConfig !== null && hasOpenCodeWorkflowStateRegistration(opencodeConfig)) {
    error(`Refusing to replace existing OpenCode workflow_state registration: ${opencodeConfig}`);
  }
  if (!bunVersionAtLeast(MINIMUM_BUN)) {
    error(`Bun ${MINIMUM_BUN.join(".")} or newer is required to run the workflow_state server; found ${Bun.version}.`);
  }
  for (const file of REQUIRED_SOURCE_FILES) {
    if (!existsSync(resolve(projectRoot, file))) {
      error(`Required agent definition missing: ${projectRoot}/${file}`);
    }
  }
  try {
    tomlString(resolve(projectRoot, ".codex/workflow-mcp/server.ts"));
  } catch {
    error(`Project path cannot be represented safely in TOML: ${projectRoot}`);
  }
  const existing = existsSync(config) ? readFileSync(config, "utf8") + "\n" : "";
  const stagedContent = existing + registrationBlock(projectRoot);
  try {
    TOML.parse(stagedContent);
  } catch (cause) {
    error(`Staged config is not valid TOML; refusing to install: ${config} (${cause instanceof Error ? cause.message : String(cause)})`);
  }
  const serverPath = resolve(projectRoot, ".codex/workflow-mcp/server.ts");
  const opencodeConfigTarget = opencodeConfig ?? resolve(target, "opencode.json");
  const opencodeConfigOriginal = opencodeConfig === null ? null : readFileSync(opencodeConfig, "utf8");
  const stagedOpenCode = stageOpenCodeConfig(opencodeConfigTarget, opencodeConfigOriginal, serverPath);

  mkdirSync(resolve(target, ".codex"), { recursive: true });
  mkdirSync(resolve(target, ".opencode"), { recursive: true });
  const agentsStaging = mkdtempSync(resolve(target, ".codex/.agents.install."));
  const configStaging = mkdtempSync(resolve(target, ".codex/.config.install."));
  const opencodeAgentsStaging = mkdtempSync(resolve(target, ".opencode/.agents.install."));
  const opencodeConfigStaging = mkdtempSync(resolve(target, ".opencode/.config.install."));
  try {
    for (const file of COPY_SOURCE_FILES) {
      if (existsSync(resolve(projectRoot, file))) {
        cpSync(resolve(projectRoot, file), resolve(agentsStaging, file.slice(".codex/agents/".length)));
      }
    }
    for (const file of OPENCODE_COPY_SOURCE_FILES) {
      if (existsSync(resolve(projectRoot, file))) {
        cpSync(resolve(projectRoot, file), resolve(opencodeAgentsStaging, file.slice(".opencode/agents/".length)));
      }
    }
    const stagedConfig = resolve(configStaging, "config.toml");
    writeFileSync(stagedConfig, stagedContent);
    const stagedOpenCodePath = resolve(opencodeConfigStaging, basename(opencodeConfigTarget));
    writeFileSync(stagedOpenCodePath, stagedOpenCode);
    commitBothHosts(
      agentsStaging,
      resolve(target, ".codex/agents"),
      stagedConfig,
      config,
      opencodeAgentsStaging,
      resolve(target, ".opencode/agents"),
      stagedOpenCodePath,
      opencodeConfigTarget,
      existing === "" ? null : existing.replace(/\n$/, ""),
      opencodeConfigOriginal,
    );
  } catch (cause) {
    rmSync(agentsStaging, { recursive: true, force: true });
    rmSync(configStaging, { recursive: true, force: true });
    rmSync(opencodeAgentsStaging, { recursive: true, force: true });
    rmSync(opencodeConfigStaging, { recursive: true, force: true });
    throw cause;
  }
  rmSync(configStaging, { recursive: true, force: true });
  rmSync(opencodeConfigStaging, { recursive: true, force: true });

  process.stdout.write(`Installed Codex agents and workflow_state MCP registration into: ${target}\n`);
  process.stdout.write(`Installed OpenCode agents and workflow_state MCP registration into: ${target}\n`);
  process.stdout.write("Restart or reload Codex, then run: codex mcp get workflow_state\n");
  process.stdout.write("Restart or reload OpenCode, then verify the workflow_state tools are visible in a session.\n");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
