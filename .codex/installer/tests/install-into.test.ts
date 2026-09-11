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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  hasWorkflowStateRegistration,
  materializeAgentDefinitions,
} from "../../../install-into.js";

const projectRoot = resolve(import.meta.dir, "../../..");
const installer = resolve(projectRoot, "install-into.ts");

test("active documentation describes the standalone installed runtime boundary", () => {
  const documentation = [
    readFileSync(join(projectRoot, "README.md"), "utf8"),
    readFileSync(join(projectRoot, "docs/opencode-orchestration-flow.md"), "utf8"),
    readFileSync(join(projectRoot, ".codex/workflow-mcp/README.md"), "utf8"),
  ];
  for (const content of documentation) {
    assert.match(content, /\.codex\/runtime\/workflow-mcp/u);
    assert.match(content, /without requiring Bun|Bun, target `node_modules`/u);
    assert.doesNotMatch(content, /provider-server registration|absolute provider server/u);
    assert.doesNotMatch(
      content,
      /execute the provider server directly|invoke the provider server directly/u,
    );
  }
});

test("materialization replaces stale worker artifacts from policy and contracts", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "materialize-agents-")));
  const codex = join(root, "codex");
  const opencode = join(root, "opencode");
  mkdirSync(codex, { recursive: true });
  mkdirSync(opencode, { recursive: true });
  try {
    writeFileSync(join(codex, "implementer.toml"), "stale\n");
    writeFileSync(join(opencode, "implementer.md"), "stale\n");
    const manifest = materializeAgentDefinitions(projectRoot, codex, opencode);
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
    mkdirSync(join(root, dirname(path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, git, write };
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

test("source fixture copy excludes transient Bun artifacts before recursion", () => {
  const source = realpathSync(mkdtempSync(join(tmpdir(), "source-copy-filter-")));
  const destination = realpathSync(mkdtempSync(join(tmpdir(), "source-copy-destination-")));
  mkdirSync(join(source, "transient.bun-build", "nested"), { recursive: true });
  mkdirSync(join(source, ".git"), { recursive: true });
  mkdirSync(join(source, "node_modules", "dependency"), { recursive: true });
  writeFileSync(join(source, "ordinary-source.txt"), "ordinary\n");
  writeFileSync(join(source, "intentional-untracked-fixture.txt"), "untracked\n");
  writeFileSync(
    join(source, "transient.bun-build", "nested", "should-not-copy.txt"),
    "transient\n",
  );
  writeFileSync(join(source, ".git", "should-not-copy.txt"), "git\n");
  writeFileSync(join(source, "node_modules", "dependency", "should-not-copy.txt"), "dependency\n");
  try {
    cpSync(source, destination, { recursive: true, filter: sourceCopyFilter });
    assert.equal(readFileSync(join(destination, "ordinary-source.txt"), "utf8"), "ordinary\n");
    assert.equal(
      readFileSync(join(destination, "intentional-untracked-fixture.txt"), "utf8"),
      "untracked\n",
    );
    assert.equal(existsSync(join(destination, "transient.bun-build")), false);
    assert.equal(existsSync(join(destination, ".git")), false);
    assert.equal(existsSync(join(destination, "node_modules")), false);
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(destination, { recursive: true, force: true });
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
      JSON.stringify({
        default_agent: "plan",
        agent: { plan: { prompt: "target-owned", permission: { edit: "allow" }, custom: true } },
      }),
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
    assert.equal(JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")).subagent_depth, 5);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses a non-git target", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-into-")));
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

test("install-into.ts refuses an existing workflow_state registration", () => {
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
