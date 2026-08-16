#!/usr/bin/env bun

import { spawnSync, TOML } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const REGISTRATION_SECTION = ["mcp_servers", "workflow_state"];
const REQUIRED_SOURCE_FILES = [
  ".codex/workflow-mcp/server.ts",
  ".codex/agents/change-receipt.ts",
  ".codex/agents/code_reviewer.toml",
  ".codex/agents/committer.toml",
  ".codex/agents/implementer.toml",
  ".codex/agents/WORKFLOW.md",
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
const MINIMUM_BUN = [1, 3, 0];

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

function isGitRepository(target: string): boolean {
  const result = spawnSync(["git", "-C", target, "rev-parse", "--show-toplevel"], {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
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

  mkdirSync(resolve(target, ".codex"), { recursive: true });
  const agentsStaging = mkdtempSync(resolve(target, ".codex/.agents.install."));
  const configStaging = mkdtempSync(resolve(target, ".codex/.config.install."));
  try {
    for (const file of COPY_SOURCE_FILES) {
      if (existsSync(resolve(projectRoot, file))) {
        cpSync(resolve(projectRoot, file), resolve(agentsStaging, file.slice(".codex/agents/".length)));
      }
    }
    const stagedConfig = resolve(configStaging, "config.toml");
    writeFileSync(stagedConfig, stagedContent);
    commitStaged(agentsStaging, resolve(target, ".codex/agents"), stagedConfig, config);
  } catch (cause) {
    rmSync(agentsStaging, { recursive: true, force: true });
    rmSync(configStaging, { recursive: true, force: true });
    throw cause;
  }
  rmSync(configStaging, { recursive: true, force: true });

  process.stdout.write(`Installed Codex agents and workflow_state MCP registration into: ${target}\n`);
  process.stdout.write("Restart or reload Codex, then run: codex mcp get workflow_state\n");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
