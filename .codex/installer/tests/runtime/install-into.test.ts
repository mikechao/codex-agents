import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TOML } from "bun";
import {
  CODEX_WORKFLOW_MCP_ENABLED_TOOLS,
  enabledCodexWorkflowMcp,
  generateDefinitionManifest,
} from "../../../agents/generate-host-definitions.js";

const projectRoot = resolve(import.meta.dir, "../../../..");
const installer = resolve(projectRoot, "install-into.ts");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-into-runtime-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "installer@example.invalid");
  git("config", "user.name", "Installer Tests");
  return { root, git };
}

function runInstaller(target: string) {
  try {
    return {
      status: 0,
      stdout: execFileSync(installer, [target], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (cause) {
    assert.ok(cause instanceof Error && "status" in cause);
    const failure = cause as Error & { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function gitAt(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runDogfood(target?: string, env: NodeJS.ProcessEnv = process.env) {
  const args = ["run", "dogfood:target"];
  if (target !== undefined) args.push("--", target);
  try {
    return {
      status: 0,
      stdout: execFileSync("bun", args, {
        cwd: projectRoot,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (cause) {
    assert.ok(cause instanceof Error && "status" in cause);
    const failure = cause as Error & { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function retainedTarget(stdout: string): string {
  const match = stdout.match(/^Target: (.+)$/m);
  assert.ok(match, `missing target in helper output: ${stdout}`);
  return match[1];
}

function sourceCopyFilter(path: string): boolean {
  return !path
    .split(/[\\/]/u)
    .some(
      (component) =>
        component === ".git" ||
        component === "node_modules" ||
        (component.length > ".bun-build".length && component.endsWith(".bun-build")),
    );
}

function sourceCopy(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dogfood-source-")));
  cpSync(projectRoot, root, { recursive: true, filter: sourceCopyFilter });
  symlinkSync(resolve(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  gitAt(root, "init", "-q");
  gitAt(root, "config", "user.email", "dogfood-source@example.invalid");
  gitAt(root, "config", "user.name", "Dogfood Source");
  gitAt(root, "add", "--all");
  gitAt(root, "commit", "-q", "-m", "source fixture");
  return root;
}

function runDogfoodFrom(source: string, target: string) {
  try {
    return {
      status: 0,
      stdout: execFileSync("bun", [resolve(source, "scripts/create-dogfood-target.ts"), target], {
        cwd: source,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (cause) {
    assert.ok(cause instanceof Error && "status" in cause);
    const failure = cause as Error & { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

test("dogfood:target creates and retains a clean two-checkpoint target", () => {
  const result = runDogfood();
  assert.equal(result.status, 0, result.stderr);
  const target = retainedTarget(result.stdout);
  try {
    assert.match(result.stdout, /^Source checkout: .+$/m);
    assert.match(result.stdout, /^Source HEAD: [0-9a-f]{40}$/m);
    assert.match(result.stdout, /^Source state: (clean|dirty)$/m);
    assert.match(result.stdout, /^Baseline target commit: [0-9a-f]{40}$/m);
    assert.match(result.stdout, /^Installed target commit: [0-9a-f]{40}$/m);
    assert.match(result.stdout, /standalone local Workflow MCP executable/);
    assert.match(result.stdout, /Git, SQLite state/);
    assert.equal(gitAt(target, "rev-list", "--count", "HEAD"), "2");
    assert.equal(gitAt(target, "status", "--short", "--untracked-files=all"), "");
    assert.equal(
      gitAt(target, "show", "--format=%s", "--no-patch", "HEAD"),
      "dogfood installed snapshot",
    );
    const baseline = gitAt(target, "rev-parse", "HEAD^");
    assert.equal(gitAt(target, "show", "--format=%s", "--no-patch", baseline), "dogfood baseline");
    assert.ok(existsSync(join(target, "README.md")));
    assert.equal(gitAt(target, "ls-tree", "--name-only", "HEAD^"), "README.md");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("dogfood:target accepts an explicit empty target and rejects non-empty targets", () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "dogfood-target-")));
  const empty = join(parent, "empty");
  const nonEmpty = join(parent, "non-empty");
  mkdirSync(empty);
  mkdirSync(nonEmpty);
  const sentinel = join(nonEmpty, "sentinel.txt");
  writeFileSync(sentinel, "keep me\n");
  try {
    const success = runDogfood(empty);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(gitAt(empty, "status", "--short", "--untracked-files=all"), "");
    const failure = runDogfood(nonEmpty);
    assert.notEqual(failure.status, 0);
    assert.match(failure.stderr, /not empty/);
    assert.equal(readFileSync(sentinel, "utf8"), "keep me\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("dogfood:target does not invent Git identity when committing the baseline", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dogfood-identity-")));
  const configRoot = realpathSync(mkdtempSync(join(tmpdir(), "dogfood-git-config-")));
  const env = { ...process.env };
  delete env.GIT_AUTHOR_EMAIL;
  delete env.GIT_AUTHOR_NAME;
  delete env.GIT_COMMITTER_EMAIL;
  delete env.GIT_COMMITTER_NAME;
  delete env.EMAIL;
  const emptyGitConfig = join(configRoot, "empty-git-config");
  writeFileSync(emptyGitConfig, "");
  env.GIT_CONFIG_GLOBAL = emptyGitConfig;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_SYSTEM = emptyGitConfig;
  try {
    const result = runDogfood(root, env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /identity|user\.name|user\.email/i);
    assert.match(result.stderr, /Target retained at/);
    assert.equal(readFileSync(join(root, ".git/config"), "utf8").includes("[user]"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  }
});

test("dogfood:target reports clean and dirty isolated source candidates", () => {
  const source = sourceCopy();
  const cleanTarget = realpathSync(mkdtempSync(join(tmpdir(), "dogfood-clean-")));
  const dirtyTarget = realpathSync(mkdtempSync(join(tmpdir(), "dogfood-dirty-")));
  try {
    const clean = runDogfoodFrom(source, cleanTarget);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /^Source state: clean$/m);
    writeFileSync(join(source, "untracked-source-file.txt"), "dirty candidate\n");
    const dirty = runDogfoodFrom(source, dirtyTarget);
    assert.equal(dirty.status, 0, dirty.stderr);
    assert.match(dirty.stdout, /^Source state: dirty$/m);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(cleanTarget, { recursive: true, force: true });
    rmSync(dirtyTarget, { recursive: true, force: true });
  }
});

test("dogfood:target retains the target when the normal installer fails", () => {
  const source = sourceCopy();
  const target = realpathSync(mkdtempSync(join(tmpdir(), "dogfood-failure-")));
  rmSync(join(source, ".codex/agents/contracts/explorer.md"));
  try {
    const result = runDogfoodFrom(source, target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Normal installer failed/);
    assert.match(result.stderr, /Target retained at/);
    assert.equal(gitAt(target, "rev-list", "--count", "HEAD"), "1");
    assert.equal(gitAt(target, "show", "--format=%s", "--no-patch", "HEAD"), "dogfood baseline");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("install-into.ts runs as an executable and installs agents plus workflow_state registration", () => {
  const { root } = fixture();
  try {
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed Codex agents/);
    for (const file of [
      "change-receipt.ts",
      "reviewer-validation.ts",
      "code_reviewer.toml",
      "committer.toml",
      "implementer.toml",
      "WORKFLOW.md",
    ]) {
      assert.ok(existsSync(join(root, ".codex/agents", file)), `missing .codex/agents/${file}`);
    }
    for (const file of ["runEvidence.ts", "inspectGitRange.ts"]) {
      const installed = join(root, ".opencode/tools", file);
      assert.ok(existsSync(installed), `missing .opencode/tools/${file}`);
      assert.equal(
        readFileSync(installed, "utf8"),
        readFileSync(resolve(import.meta.dir, "../../../../.opencode/tools", file), "utf8"),
      );
    }
    const installedManifest = generateDefinitionManifest({
      codexWorkflowMcp: enabledCodexWorkflowMcp(resolve(root, ".codex/runtime/workflow-mcp")),
    });
    for (const definition of installedManifest) {
      const destination = definition.host === "codex" ? ".codex/agents" : ".opencode/agents";
      assert.equal(
        readFileSync(join(root, destination, definition.filename), "utf8"),
        definition.content,
        `${definition.host}/${definition.role} must be materialized from current policy`,
      );
    }
    const installedExplorer = readFileSync(join(root, ".opencode/agents/explorer.md"), "utf8");
    assert.match(installedExplorer, /^hidden: true$/m);
    assert.match(installedExplorer, /^    "\*": deny$/m);
    assert.match(installedExplorer, /^  runEvidence: allow$/m);
    assert.ok(!installedExplorer.includes("reviewer-validation.ts --evidence-id"));
    assert.ok(!installedExplorer.includes("workflow_state_plan_create"));
    for (const definition of installedManifest.filter(
      (candidate) =>
        candidate.host === "codex" && candidate.role in CODEX_WORKFLOW_MCP_ENABLED_TOOLS,
    )) {
      const role = definition.role as keyof typeof CODEX_WORKFLOW_MCP_ENABLED_TOOLS;
      const parsedDefinition = TOML.parse(definition.content) as {
        mcp_servers: {
          workflow_state: {
            enabled: boolean;
            command: string;
            args: string[];
            startup_timeout_sec: number;
            tool_timeout_sec: number;
            required: boolean;
            default_tools_approval_mode: string;
            enabled_tools: unknown;
          };
        };
      };
      assert.equal(parsedDefinition.mcp_servers.workflow_state.enabled, true);
      assert.equal(
        parsedDefinition.mcp_servers.workflow_state.command,
        resolve(root, ".codex/runtime/workflow-mcp"),
      );
      assert.deepEqual(parsedDefinition.mcp_servers.workflow_state.args, []);
      assert.equal(parsedDefinition.mcp_servers.workflow_state.startup_timeout_sec, 10);
      assert.equal(parsedDefinition.mcp_servers.workflow_state.tool_timeout_sec, 30);
      assert.equal(parsedDefinition.mcp_servers.workflow_state.required, false);
      assert.equal(
        parsedDefinition.mcp_servers.workflow_state.default_tools_approval_mode,
        "prompt",
      );
      assert.deepEqual(
        parsedDefinition.mcp_servers.workflow_state.enabled_tools,
        CODEX_WORKFLOW_MCP_ENABLED_TOOLS[role],
        `${role} Codex allowlist must survive materialization`,
      );
    }
    assert.ok(existsSync(join(root, ".codex/reviewer-validation.json")));
    const reviewerPolicy = JSON.parse(
      readFileSync(join(root, ".codex/reviewer-validation.json"), "utf8"),
    ) as { commands: Array<Record<string, unknown>> };
    assert.ok(reviewerPolicy.commands.length > 0);
    assert.ok(reviewerPolicy.commands.every((command) => !Object.hasOwn(command, "validation_id")));
    for (const file of [
      "implementer.md",
      "code_reviewer.md",
      "committer.md",
      "planner.md",
      "explorer.md",
      "orchestrator.md",
    ]) {
      assert.ok(
        existsSync(join(root, ".opencode/agents", file)),
        `missing .opencode/agents/${file}`,
      );
    }
    for (const file of [
      ".codex/workflow-mcp/server.ts",
      ".codex/workflow-mcp/bootstrap.ts",
      ".codex/workflow-mcp/runtime-supervisor.ts",
      ".codex/workflow-mcp/runtime-artifact.ts",
    ]) {
      assert.ok(!existsSync(join(root, file)), `runtime source must not be installed: ${file}`);
    }
    assert.ok(existsSync(join(root, ".codex/runtime/workflow-mcp")));
    assert.equal(existsSync(join(root, ".codex/workflow-mcp")), false);
    if (process.platform !== "win32")
      assert.notEqual(statSync(join(root, ".codex/runtime/workflow-mcp")).mode & 0o111, 0);
    const opencodeConfig = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      default_agent: string;
      subagent_depth: number;
    };
    assert.equal(opencodeConfig.default_agent, "orchestrator");
    assert.equal(opencodeConfig.subagent_depth, 2);
    assert.ok(!existsSync(join(root, ".codex/planner-policy.json")));
    const config = readFileSync(join(root, ".codex/config.toml"), "utf8");
    assert.match(config, /\[mcp_servers\.workflow_state\]/);
    const parsed = TOML.parse(config) as {
      mcp_servers: { workflow_state: { command: string; args: string[] } };
    };
    assert.equal(
      parsed.mcp_servers.workflow_state.command,
      resolve(root, ".codex/runtime/workflow-mcp"),
    );
    assert.deepEqual(parsed.mcp_servers.workflow_state.args, []);
    assert.ok(!Object.hasOwn(parsed.mcp_servers.workflow_state, "enabled_tools"));
    const selfHostedConfig = TOML.parse(
      readFileSync(resolve(import.meta.dir, "../../../config.toml"), "utf8"),
    ) as {
      agents: { enabled: boolean };
      mcp_servers: { workflow_state: { enabled: boolean } };
    };
    assert.equal(selfHostedConfig.agents.enabled, false);
    assert.equal(selfHostedConfig.mcp_servers.workflow_state.enabled, false);
    assert.ok(!existsSync(join(root, ".codex/.agents.install.")));
    assert.ok(!existsSync(join(root, ".codex/.config.install.")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts succeeds when explanatory WORKFLOW.md is unavailable", () => {
  const source = sourceCopy();
  const target = realpathSync(mkdtempSync(join(tmpdir(), "install-without-workflow-")));
  rmSync(join(source, ".codex/agents/WORKFLOW.md"));
  try {
    const result = runDogfoodFrom(source, target);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(existsSync(join(target, ".codex/agents/implementer.toml")));
    assert.ok(existsSync(join(target, ".opencode/agents/orchestrator.md")));
    assert.ok(existsSync(join(target, ".codex/config.toml")));
    assert.ok(!existsSync(join(target, ".codex/agents/WORKFLOW.md")));
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});
