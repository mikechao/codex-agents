import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openCodePlanAgent, providerServerCommand } from "../../../../install-into.js";

const projectRoot = resolve(import.meta.dir, "../../../..");
const installer = resolve(projectRoot, "install-into.ts");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-opencode-runtime-")));
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
  return { root, write };
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

function openCodeAgentsBackups(root: string) {
  const opencode = join(root, ".opencode");
  if (!existsSync(opencode)) return [];
  return readdirSync(opencode).filter((name) => name.startsWith(".agents.backup."));
}

test("install-into.ts installs OpenCode agents and the workflow_state MCP registration", () => {
  const { root } = fixture();
  try {
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed Codex agents/);
    assert.match(result.stdout, /Installed OpenCode agents/);
    for (const file of [
      "implementer.md",
      "code_reviewer.md",
      "committer.md",
      "planner.md",
      "explorer.md",
      "orchestrator.md",
    ]) {
      assert.ok(existsSync(join(root, ".opencode/agents", file)));
    }
    const canonicalOrchestrator = readFileSync(
      resolve(import.meta.dir, "../../../../.opencode/agents/orchestrator.md"),
      "utf8",
    );
    assert.equal(
      readFileSync(join(root, ".opencode/agents/orchestrator.md"), "utf8"),
      canonicalOrchestrator,
    );
    const config = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")) as {
      $schema: string;
      default_agent: string;
      subagent_depth: number;
      mcp: {
        workflow_state: { type: string; command: string[]; enabled: boolean; timeout: number };
      };
      agent: { plan: { permission: { task: Record<string, unknown> } } };
    };
    assert.equal(config.$schema, "https://opencode.ai/config.json");
    assert.equal(config.default_agent, "orchestrator");
    assert.equal(config.subagent_depth, 2);
    assert.equal(config.agent.plan.permission.task.planner, "allow");
    assert.equal(config.agent.plan.permission.task.explorer, "allow");
    assert.equal(config.mcp.workflow_state.type, "local");
    assert.equal(config.mcp.workflow_state.enabled, true);
    assert.equal(config.mcp.workflow_state.timeout, 30000);
    assert.deepEqual(
      config.mcp.workflow_state.command,
      providerServerCommand(resolve(root, ".codex/runtime/workflow-mcp")),
    );
    assert.ok(existsSync(join(root, ".codex/runtime/workflow-mcp")));
    assert.deepEqual(openCodeAgentsBackups(root), []);
    for (const toolName of ["runEvidence.ts", "inspectGitRange.ts"]) {
      const installedTool = join(root, ".opencode/tools", toolName);
      assert.ok(existsSync(installedTool));
      assert.equal(
        readFileSync(installedTool, "utf8"),
        readFileSync(resolve(import.meta.dir, "../../../../.opencode/tools", toolName), "utf8"),
      );
    }
    for (const artifact of [
      ".opencode/package.json",
      ".opencode/package-lock.json",
      ".opencode/bun.lock",
      ".opencode/node_modules",
      ".opencode/.gitignore",
    ]) {
      assert.ok(!existsSync(join(root, artifact)), `installer must not create ${artifact}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves arbitrary OpenCode host artifacts byte-for-byte", () => {
  const { root, write } = fixture();
  const artifacts = {
    ".opencode/package.json": '{"dependencies":{"@opencode-ai/plugin":"9.9.9"},"custom":true}\n',
    ".opencode/package-lock.json": '{"lockfileVersion":99,"custom":"keep"}\n',
    ".opencode/bun.lock": "# host-generated lock\ncustom-entry\n",
    ".opencode/.gitignore": "package.json\nnode_modules/\n",
    ".opencode/node_modules/@opencode-ai/plugin/package.json":
      '{"name":"@opencode-ai/plugin","version":"9.9.9"}\n',
    ".opencode/node_modules/@opencode-ai/plugin/host-state.txt": "keep this entry\n",
    ".opencode/plugins/pre-existing.ts": "// target-owned plugin\n",
  } as const;
  try {
    for (const [path, content] of Object.entries(artifacts)) write(path, content);
    const originalEntries = readdirSync(join(root, ".opencode")).sort();
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    for (const [path, content] of Object.entries(artifacts))
      assert.equal(readFileSync(join(root, path), "utf8"), content);
    assert.deepEqual(
      readdirSync(join(root, ".opencode")).sort(),
      [...originalEntries, "agents", "tools"].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves unrelated existing OpenCode configuration", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.json",
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          model: "some-provider/some-model",
          autoupdate: false,
          mcp: {
            other_server: { type: "local", command: ["npx", "-y", "something"], enabled: false },
          },
        },
        null,
        2,
      )}\n`,
    );
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
    assert.equal(parsed.model, "some-provider/some-model");
    assert.equal(parsed.autoupdate, false);
    assert.equal(parsed.mcp.other_server.command[0], "npx");
    assert.equal(parsed.mcp.workflow_state.type, "local");
    assert.deepEqual(parsed.agent.plan, openCodePlanAgent());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves comments and trailing commas in existing OpenCode JSONC", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.jsonc",
      [
        "{",
        "  // project model override",
        '  "model": "some-provider/some-model",',
        '  "agent": {',
        '    "build": { "prompt": "keep build", },',
        "  },",
        '  "mcp": {',
        "    // existing server, keep me",
        '    "other_server": {',
        '      "type": "local",',
        '      "command": ["npx", "-y", "something"],',
        "    },",
        "  },",
        "}",
        "",
      ].join("\n"),
    );
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const content = readFileSync(join(root, "opencode.jsonc"), "utf8");
    assert.ok(content.includes("// project model override"));
    assert.ok(content.includes("// existing server, keep me"));
    const parsed = JSON.parse(content.replace(/\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
    assert.equal(parsed.mcp.other_server.type, "local");
    assert.equal(parsed.mcp.workflow_state.type, "local");
    assert.equal(parsed.agent.build.prompt, "keep build");
    assert.deepEqual(parsed.agent.plan, openCodePlanAgent());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts inserts Plan without changing other agents", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.json",
      JSON.stringify({
        agent: { build: { prompt: "keep build", permission: { edit: "allow" } } },
        default_agent: "build",
      }),
    );
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(readFileSync(join(root, "opencode.json"), "utf8"));
    assert.deepEqual(parsed.agent.build, { prompt: "keep build", permission: { edit: "allow" } });
    assert.deepEqual(parsed.agent.plan, openCodePlanAgent());
    assert.equal(parsed.default_agent, "build");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves an explicit custom Plan object", () => {
  const { root, write } = fixture();
  try {
    const custom = {
      prompt: "project-owned Plan prompt",
      permission: { edit: "allow", "workflow_state_*": "deny" },
      model: "project/model",
      nested: { keep: true },
    };
    write("opencode.json", JSON.stringify({ agent: { plan: custom } }));
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "opencode.json"), "utf8")).agent.plan,
      custom,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves unrelated existing OpenCode agents", () => {
  const { root, write } = fixture();
  try {
    write(".opencode/agents/docs-writer.md", "---\ndescription: someone elses agent\n---\n");
    write(".opencode/agents/tools/keep.txt", "unrelated nested content\n");
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(root, ".opencode/agents/docs-writer.md"), "utf8"),
      "---\ndescription: someone elses agent\n---\n",
    );
    assert.equal(
      readFileSync(join(root, ".opencode/agents/tools/keep.txt"), "utf8"),
      "unrelated nested content\n",
    );
    for (const file of [
      "implementer.md",
      "code_reviewer.md",
      "committer.md",
      "planner.md",
      "explorer.md",
      "orchestrator.md",
    ]) {
      assert.ok(existsSync(join(root, ".opencode/agents", file)));
    }
    assert.ok(existsSync(join(root, ".codex/agents")));
    assert.ok(existsSync(join(root, "opencode.json")));
    assert.deepEqual(openCodeAgentsBackups(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
