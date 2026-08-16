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
import { commitStaged, hasWorkflowStateRegistration } from "../../../install-into.js";

const installer = resolve(import.meta.dir, "../../../install-into.ts");

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
      "code_reviewer.toml",
      "committer.toml",
      "implementer.toml",
      "WORKFLOW.md",
    ]) {
      assert.ok(existsSync(join(root, ".codex/agents", file)), `missing .codex/agents/${file}`);
    }
    for (const file of ["implementer.md", "code_reviewer.md", "committer.md", "orchestrator.md"]) {
      assert.ok(
        existsSync(join(root, ".opencode/agents", file)),
        `missing .opencode/agents/${file}`,
      );
    }
    const opencodeConfig = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      default_agent: string;
    };
    assert.equal(opencodeConfig.default_agent, "orchestrator");
    const config = readFileSync(join(root, ".codex/config.toml"), "utf8");
    assert.match(config, /\[mcp_servers\.workflow_state\]/);
    assert.ok(!existsSync(join(root, ".codex/.agents.install.")));
    assert.ok(!existsSync(join(root, ".codex/.config.install.")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves an existing OpenCode default_agent preference", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.json",
      '{\n  "$schema": "https://opencode.ai/config.json",\n  "default_agent": "plan"\n}\n',
    );
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      default_agent: string;
      mcp: Record<string, unknown>;
    };
    assert.equal(config.default_agent, "plan");
    assert.ok(config.mcp.workflow_state);
    assert.ok(existsSync(join(root, ".opencode/agents/orchestrator.md")));
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
