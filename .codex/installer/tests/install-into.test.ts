import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TOML } from "bun";
import {
  commitStaged,
  hasWorkflowStateRegistration,
  materializeAgentDefinitions,
} from "../../../install-into.js";
import {
  CODEX_WORKFLOW_MCP_ENABLED_TOOLS,
  enabledCodexWorkflowMcp,
  generateDefinitionManifest,
} from "../../agents/generate-host-definitions.js";

const installer = resolve(import.meta.dir, "../../../install-into.ts");

test("materialization replaces stale worker artifacts from policy and contracts", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "materialize-agents-")));
  const codex = join(root, "codex");
  const opencode = join(root, "opencode");
  mkdirSync(codex, { recursive: true });
  mkdirSync(opencode, { recursive: true });
  try {
    writeFileSync(join(codex, "implementer.toml"), "stale\n");
    writeFileSync(join(opencode, "implementer.md"), "stale\n");
    const manifest = materializeAgentDefinitions(
      resolve(import.meta.dir, "../../.."),
      codex,
      opencode,
    );
    for (const definition of manifest) {
      const destination = definition.host === "codex" ? codex : opencode;
      assert.equal(
        readFileSync(join(destination, definition.filename), "utf8"),
        definition.content,
      );
      assert.notEqual(definition.content, "stale\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-into-")));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "installer@example.invalid");
  git("config", "user.name", "Installer Tests");
  const write = (path: string, content: string) => {
    const directory = join(root, dirname(path));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, git, write };
}

function runInstaller(target: string) {
  try {
    const stdout = execFileSync(installer, [target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
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
    const installedManifest = generateDefinitionManifest({
      codexWorkflowMcp: enabledCodexWorkflowMcp(
        resolve(import.meta.dir, "../../../.codex/workflow-mcp/server.ts"),
      ),
    });
    for (const definition of installedManifest) {
      const destination = definition.host === "codex" ? ".codex/agents" : ".opencode/agents";
      assert.equal(
        readFileSync(join(root, destination, definition.filename), "utf8"),
        definition.content,
        `${definition.host}/${definition.role} must be materialized from current policy`,
      );
    }
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
      assert.equal(parsedDefinition.mcp_servers.workflow_state.command, "bun");
      assert.deepEqual(parsedDefinition.mcp_servers.workflow_state.args, [
        resolve(import.meta.dir, "../../../.codex/workflow-mcp/server.ts"),
      ]);
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
    assert.equal(parsed.mcp_servers.workflow_state.command, "bun");
    assert.deepEqual(parsed.mcp_servers.workflow_state.args, [
      resolve(import.meta.dir, "../../../.codex/workflow-mcp/server.ts"),
    ]);
    assert.ok(
      !Object.hasOwn(parsed.mcp_servers.workflow_state, "enabled_tools"),
      "the parent Workflow MCP registration must remain unrestricted",
    );
    const selfHostedConfig = TOML.parse(
      readFileSync(resolve(import.meta.dir, "../../config.toml"), "utf8"),
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

test("install-into.ts scaffolds reviewer policy once and preserves target customization", () => {
  const { root, write } = fixture();
  try {
    const customized = '{"version":1,"commands":[] }\n';
    write(".codex/reviewer-validation.json", customized);
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(root, ".codex/reviewer-validation.json"), "utf8"), customized);
    assert.ok(existsSync(join(root, ".codex/agents/reviewer-validation.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves an existing OpenCode default_agent preference", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.json",
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          default_agent: "plan",
          agent: { plan: { prompt: "target-owned", permission: { edit: "allow" }, custom: true } },
        },
        null,
        2,
      ),
    );
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      default_agent: string;
      subagent_depth: number;
      mcp: Record<string, unknown>;
      agent: { plan: Record<string, unknown> };
    };
    assert.equal(config.default_agent, "plan");
    assert.equal(config.subagent_depth, 2);
    assert.ok(config.mcp.workflow_state);
    assert.deepEqual(config.agent.plan, {
      prompt: "target-owned",
      permission: { edit: "allow" },
      custom: true,
    });
    assert.ok(existsSync(join(root, ".opencode/agents/orchestrator.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves an explicit OpenCode subagent_depth", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.json",
      '{\n  "$schema": "https://opencode.ai/config.json",\n  "subagent_depth": 5\n}\n',
    );
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      subagent_depth: number;
    };
    assert.equal(config.subagent_depth, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses a non-git target", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-into-"))) as string;
  try {
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a Git repository/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses an existing .codex/agents directory", () => {
  const { root, write } = fixture();
  try {
    write(".codex/agents/implementer.toml", "[agent]\n");
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace existing agent definitions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses an existing workflow_state table", () => {
  const { root, write } = fixture();
  try {
    write(".codex/config.toml", '[mcp_servers.workflow_state]\ncommand = "bun"\n');
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace existing workflow_state registration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses an existing workflow_state scalar value", () => {
  const { root, write } = fixture();
  try {
    write(".codex/config.toml", '[mcp_servers]\nworkflow_state = "something"\n');
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace existing workflow_state registration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses malformed existing TOML", () => {
  const { root, write } = fixture();
  try {
    write(".codex/config.toml", "not [valid toml\n");
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not valid TOML/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses an unparseable staged config instead of writing it", () => {
  const { root, write } = fixture();
  try {
    write(".codex/config.toml", 'mcp_servers = "occupied"\n');
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Staged config is not valid TOML/);
    assert.ok(!existsSync(join(root, ".codex/agents")));
    assert.equal(
      readFileSync(join(root, ".codex/config.toml"), "utf8"),
      'mcp_servers = "occupied"\n',
    );
    assert.ok(!existsSync(join(root, ".codex/.agents.install.")));
    assert.ok(!existsSync(join(root, ".codex/.config.install.")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses a second run after a successful install", () => {
  const { root } = fixture();
  try {
    const first = runInstaller(root);
    assert.equal(first.status, 0, first.stderr);
    const second = runInstaller(root);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Refusing to replace existing agent definitions/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hasWorkflowStateRegistration is presence-based", () => {
  const { root, write } = fixture();
  try {
    const config = join(root, ".codex/config.toml");
    assert.equal(hasWorkflowStateRegistration(config), false);
    write(".codex/config.toml", '[mcp_servers]\nworkflow_state = "something"\n');
    assert.equal(hasWorkflowStateRegistration(config), true);
    write(".codex/config.toml", 'workflow_state = "top-level"\n');
    assert.equal(hasWorkflowStateRegistration(config), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitStaged installs both paths on success", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-into-"))) as string;
  try {
    const agentsStaging = join(root, ".agents.install.");
    const agentsTarget = join(root, ".codex/agents");
    const stagedConfig = join(root, ".config.install.");
    const config = join(root, ".codex/config.toml");
    mkdirSync(agentsStaging, { recursive: true });
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(join(agentsStaging, "implementer.toml"), "[agent]\n");
    writeFileSync(stagedConfig, "[mcp_servers.workflow_state]\n");
    commitStaged(agentsStaging, agentsTarget, stagedConfig, config);
    assert.ok(existsSync(join(agentsTarget, "implementer.toml")));
    assert.equal(readFileSync(config, "utf8"), "[mcp_servers.workflow_state]\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitStaged rolls back the agents directory when the config rename fails", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-into-"))) as string;
  try {
    const agentsStaging = join(root, ".agents.install.");
    const agentsTarget = join(root, ".codex/agents");
    const stagedConfig = join(root, ".config.install.");
    const config = join(root, ".codex/config.toml");
    mkdirSync(agentsStaging, { recursive: true });
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(join(agentsStaging, "implementer.toml"), "[agent]\n");
    writeFileSync(stagedConfig, "[mcp_servers.workflow_state]\n");
    writeFileSync(config, "keep me\n");
    const rename = (from: string, to: string) => {
      if (to === config) throw new Error("injected rename failure");
      execFileSync("mv", [from, to], { stdio: "ignore" });
    };
    assert.throws(
      () => commitStaged(agentsStaging, agentsTarget, stagedConfig, config, rename),
      /injected rename failure/,
    );
    assert.ok(!existsSync(agentsTarget), "agents directory must be rolled back");
    assert.equal(
      readFileSync(config, "utf8"),
      "keep me\n",
      "pre-existing config must be untouched",
    );
    assert.ok(existsSync(stagedConfig), "staged config must remain staged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
