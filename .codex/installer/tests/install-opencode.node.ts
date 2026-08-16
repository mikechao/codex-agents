import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "bun:test";
import {
  commitBothHosts,
  hasOpenCodeWorkflowStateRegistration,
} from "../../../install-into.js";

const installer = resolve(import.meta.dir, "../../../install-into.ts");

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-opencode-")));
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
    return { status: failure.status ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}

function installedOpenCodeConfig(root: string) {
  const json = join(root, "opencode.json");
  const jsonc = join(root, "opencode.jsonc");
  const path = existsSync(jsonc) ? jsonc : json;
  return { path, content: readFileSync(path, "utf8") };
}

test("install-into.ts installs OpenCode agents and the workflow_state MCP registration", () => {
  const { root } = fixture();
  try {
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Installed Codex agents/);
    assert.match(result.stdout, /Installed OpenCode agents/);
    for (const file of ["implementer.md", "code_reviewer.md", "committer.md"]) {
      assert.ok(existsSync(join(root, ".opencode/agents", file)), `missing .opencode/agents/${file}`);
    }
    const { path, content } = installedOpenCodeConfig(root);
    assert.equal(basenameOf(path), "opencode.json");
    const parsed = JSON.parse(content) as {
      $schema: string;
      mcp: { workflow_state: { type: string; command: string[]; enabled: boolean; timeout: number } };
    };
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    const registration = parsed.mcp.workflow_state;
    assert.equal(registration.type, "local");
    assert.equal(registration.enabled, true);
    assert.equal(registration.timeout, 30000);
    assert.equal(registration.command[0], "bun");
    assert.equal(registration.command[1], "--no-warnings");
    assert.ok(registration.command[2].endsWith(".codex/workflow-mcp/server.ts"));
    assert.ok(registration.command[2].startsWith("/"), "server path must be absolute");
    assert.ok(existsSync(join(root, ".opencode/.agents.install.")) === false);
    assert.ok(existsSync(join(root, ".opencode/.config.install.")) === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves unrelated existing opencode.json configuration", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.json",
      JSON.stringify(
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
      ) + "\n",
    );
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    const { content } = installedOpenCodeConfig(root);
    const parsed = JSON.parse(content);
    assert.equal(parsed.model, "some-provider/some-model");
    assert.equal(parsed.autoupdate, false);
    assert.equal(parsed.mcp.other_server.command[0], "npx");
    assert.equal(parsed.mcp.workflow_state.type, "local");
    assert.deepEqual(Object.keys(parsed).sort(), ["$schema", "autoupdate", "mcp", "model"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves comments and trailing commas in an existing opencode.jsonc", () => {
  const { root, write } = fixture();
  try {
    write(
      "opencode.jsonc",
      [
        "{",
        '  // project model override',
        '  "model": "some-provider/some-model",',
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
    const { path, content } = installedOpenCodeConfig(root);
    assert.equal(basenameOf(path), "opencode.jsonc");
    assert.ok(content.includes("// project model override"), "existing comments must survive");
    assert.ok(content.includes("// existing server, keep me"), "existing comments must survive");
    assert.ok(content.includes('"model": "some-provider/some-model"'), "unrelated keys must survive");
    const parsed = JSON.parse(content.replace(/\/\/.*$/gm, "").replace(/,\s*([}\]])/g, "$1"));
    assert.equal(parsed.mcp.other_server.type, "local");
    assert.equal(parsed.mcp.workflow_state.type, "local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses an existing OpenCode workflow_state registration", () => {
  for (const content of [
    JSON.stringify({ mcp: { workflow_state: { type: "local" } } }),
    '{\n  "mcp": {\n    "workflow_state": "something",\n  },\n}\n',
  ]) {
    const { root, write } = fixture();
    try {
      write("opencode.jsonc", content);
      const result = runInstaller(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Refusing to replace existing OpenCode workflow_state registration/);
      assert.ok(!existsSync(join(root, ".opencode/agents")));
      assert.ok(!existsSync(join(root, ".codex/agents")));
      assert.equal(readFileSync(join(root, "opencode.jsonc"), "utf8"), content);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("install-into.ts refuses a scalar mcp value in the existing OpenCode config", () => {
  const { root, write } = fixture();
  try {
    write("opencode.json", '{\n  "mcp": 5\n}\n');
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /mcp.*must be an object/);
    assert.ok(!existsSync(join(root, ".opencode/agents")));
    assert.ok(!existsSync(join(root, ".codex/agents")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses malformed existing OpenCode configuration", () => {
  for (const [name, content] of [
    ["opencode.json", '{ "model": '],
    ["opencode.jsonc", '{ "model": // broken\n'],
  ] as const) {
    const { root, write } = fixture();
    try {
      write(name, content);
      const result = runInstaller(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /not valid (JSON|JSONC)/);
      assert.ok(!existsSync(join(root, ".opencode/agents")));
      assert.ok(!existsSync(join(root, ".codex/agents")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("install-into.ts refuses both opencode.json and opencode.jsonc", () => {
  const { root, write } = fixture();
  try {
    write("opencode.json", "{}");
    write("opencode.jsonc", "{}");
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Both opencode\.json and opencode\.jsonc exist/);
    assert.ok(!existsSync(join(root, ".opencode/agents")));
    assert.ok(!existsSync(join(root, ".codex/agents")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts preserves unrelated existing OpenCode agents and installs the managed ones", () => {
  const { root, write } = fixture();
  try {
    write(".opencode/agents/docs-writer.md", "---\ndescription: someone elses agent\n---\n");
    write(".opencode/agents/tools/keep.txt", "unrelated nested content\n");
    const result = runInstaller(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(root, ".opencode/agents/docs-writer.md"), "utf8"),
      "---\ndescription: someone elses agent\n---\n",
      "unrelated OpenCode agents must be preserved byte-for-byte",
    );
    assert.equal(
      readFileSync(join(root, ".opencode/agents/tools/keep.txt"), "utf8"),
      "unrelated nested content\n",
      "unrelated nested content must be preserved",
    );
    for (const file of ["implementer.md", "code_reviewer.md", "committer.md"]) {
      assert.ok(existsSync(join(root, ".opencode/agents", file)), `missing .opencode/agents/${file}`);
    }
    assert.ok(existsSync(join(root, ".codex/agents")), "codex agents must still be installed");
    assert.ok(existsSync(join(root, "opencode.json")), "opencode config must still be registered");
    assert.ok(!existsSync(join(root, ".opencode/.agents.backup.")), "backup staging must be removed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses a managed OpenCode agent name collision", () => {
  const { root, write } = fixture();
  try {
    write(".opencode/agents/implementer.md", "---\ndescription: existing implementer\n---\n");
    write(".opencode/agents/docs-writer.md", "---\ndescription: unrelated agent\n---\n");
    const result = runInstaller(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace existing OpenCode agent definitions/);
    assert.ok(!existsSync(join(root, ".codex/agents")));
    assert.ok(!existsSync(join(root, "opencode.json")));
    assert.equal(
      readFileSync(join(root, ".opencode/agents/implementer.md"), "utf8"),
      "---\ndescription: existing implementer\n---\n",
    );
    assert.equal(
      readFileSync(join(root, ".opencode/agents/docs-writer.md"), "utf8"),
      "---\ndescription: unrelated agent\n---\n",
    );
    assert.ok(!existsSync(join(root, ".opencode/.agents.backup.")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("install-into.ts refuses a second run without overwriting either host adapter", () => {
  const { root } = fixture();
  try {
    const first = runInstaller(root);
    assert.equal(first.status, 0, first.stderr);
    const codexConfig = readFileSync(join(root, ".codex/config.toml"), "utf8");
    const opencodeConfig = readFileSync(join(root, "opencode.json"), "utf8");
    const second = runInstaller(root);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Refusing to replace existing agent definitions/);
    assert.equal(readFileSync(join(root, ".codex/config.toml"), "utf8"), codexConfig);
    assert.equal(readFileSync(join(root, "opencode.json"), "utf8"), opencodeConfig);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hasOpenCodeWorkflowStateRegistration is presence-based", () => {
  const { root, write } = fixture();
  try {
    const config = join(root, "opencode.json");
    assert.equal(hasOpenCodeWorkflowStateRegistration(config), false);
    write("opencode.json", '{"mcp": {"workflow_state": "something"}}');
    assert.equal(hasOpenCodeWorkflowStateRegistration(config), true);
    write("opencode.json", '{"workflow_state": "top-level"}');
    assert.equal(hasOpenCodeWorkflowStateRegistration(config), false);
    write("opencode.json", '{"mcp": 5}');
    assert.equal(hasOpenCodeWorkflowStateRegistration(config), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function commitFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "install-opencode-"))) as string;
  const staging = (name: string) => {
    const dir = join(root, `.staging.${name}.`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const agentsDir = (name: string) => {
    const dir = join(root, `.agents.${name}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  return { root, staging, agentsDir };
}

test("commitBothHosts rolls back every completed step when any rename fails", () => {
  const { root, staging, agentsDir } = commitFixture();
  try {
    const codexAgentsTarget = join(root, ".codex/agents");
    const codexConfigTarget = join(root, ".codex/config.toml");
    const opencodeAgentsTarget = join(root, ".opencode/agents");
    const opencodeConfigTarget = join(root, "opencode.json");
    mkdirSync(dirname(codexConfigTarget), { recursive: true });
    mkdirSync(dirname(opencodeConfigTarget), { recursive: true });
    mkdirSync(join(root, ".opencode"), { recursive: true });
    const originalCodexConfig = "[pre-existing codex]\n";
    const originalOpenCodeConfig = '{"model":"kept"}\n';
    writeFileSync(codexConfigTarget, originalCodexConfig);
    writeFileSync(opencodeConfigTarget, originalOpenCodeConfig);

    const failurePoints = [codexAgentsTarget, codexConfigTarget, opencodeAgentsTarget, opencodeConfigTarget];
    for (const failingTarget of failurePoints) {
      const codexAgents = agentsDir(`codex-agents-${basenameOf(failingTarget)}`);
      const codexConfig = staging(`codex-config-${basenameOf(failingTarget)}`);
      const opencodeAgents = agentsDir(`opencode-agents-${basenameOf(failingTarget)}`);
      const opencodeConfig = staging(`opencode-config-${basenameOf(failingTarget)}`);
      writeFileSync(join(codexAgents, "implementer.toml"), "[agent]\n");
      writeFileSync(join(codexConfig, "config.toml"), "[mcp_servers.workflow_state]\n");
      writeFileSync(join(opencodeAgents, "implementer.md"), "---\nmode: subagent\n---\n");
      writeFileSync(join(opencodeConfig, "opencode.json"), '{"mcp":{"workflow_state":{}}}\n');
      const rename = (from: string, to: string) => {
        if (to === failingTarget) throw new Error(`injected rename failure for ${to}`);
        execFileSync("mv", [from, to], { stdio: "ignore" });
      };
      assert.throws(
        () =>
          commitBothHosts(
            codexAgents,
            codexAgentsTarget,
            join(codexConfig, "config.toml"),
            codexConfigTarget,
            opencodeAgents,
            opencodeAgentsTarget,
            join(opencodeConfig, "opencode.json"),
            opencodeConfigTarget,
            originalCodexConfig,
            originalOpenCodeConfig,
            null,
            rename,
          ),
        /injected rename failure/,
      );
      assert.ok(!existsSync(codexAgentsTarget), "codex agents must be rolled back");
      assert.ok(!existsSync(opencodeAgentsTarget), "opencode agents must be rolled back");
      assert.equal(readFileSync(codexConfigTarget, "utf8"), originalCodexConfig, "codex config must be restored");
      assert.equal(
        readFileSync(opencodeConfigTarget, "utf8"),
        originalOpenCodeConfig,
        "opencode config must be restored",
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitBothHosts removes created config files when they did not exist before", () => {
  const { root, staging, agentsDir } = commitFixture();
  try {
    const codexAgentsTarget = join(root, ".codex/agents");
    const codexConfigTarget = join(root, ".codex/config.toml");
    const opencodeAgentsTarget = join(root, ".opencode/agents");
    const opencodeConfigTarget = join(root, "opencode.json");
    mkdirSync(join(root, ".codex"), { recursive: true });
    mkdirSync(join(root, ".opencode"), { recursive: true });
    const codexAgents = agentsDir("codex-agents-new");
    const codexConfig = staging("codex-config-new");
    const opencodeAgents = agentsDir("opencode-agents-new");
    const opencodeConfig = staging("opencode-config-new");
    writeFileSync(join(codexAgents, "implementer.toml"), "[agent]\n");
    writeFileSync(join(codexConfig, "config.toml"), "[mcp_servers.workflow_state]\n");
    writeFileSync(join(opencodeAgents, "implementer.md"), "---\nmode: subagent\n---\n");
    writeFileSync(join(opencodeConfig, "opencode.json"), '{"mcp":{"workflow_state":{}}}\n');
    const rename = (from: string, to: string) => {
      if (to === opencodeConfigTarget) throw new Error("injected opencode config failure");
      execFileSync("mv", [from, to], { stdio: "ignore" });
    };
    assert.throws(
      () =>
        commitBothHosts(
          codexAgents,
          codexAgentsTarget,
          join(codexConfig, "config.toml"),
          codexConfigTarget,
          opencodeAgents,
          opencodeAgentsTarget,
          join(opencodeConfig, "opencode.json"),
          opencodeConfigTarget,
          null,
          null,
          null,
          rename,
        ),
      /injected opencode config failure/,
    );
    assert.ok(!existsSync(codexAgentsTarget));
    assert.ok(!existsSync(codexConfigTarget));
    assert.ok(!existsSync(opencodeAgentsTarget));
    assert.ok(!existsSync(opencodeConfigTarget));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commitBothHosts restores a pre-existing OpenCode agents directory when a later rename fails", () => {
  const { root, staging, agentsDir } = commitFixture();
  try {
    const codexAgentsTarget = join(root, ".codex/agents");
    const codexConfigTarget = join(root, ".codex/config.toml");
    const opencodeAgentsTarget = join(root, ".opencode/agents");
    const opencodeConfigTarget = join(root, "opencode.json");
    mkdirSync(dirname(codexConfigTarget), { recursive: true });
    mkdirSync(dirname(opencodeConfigTarget), { recursive: true });
    mkdirSync(opencodeAgentsTarget, { recursive: true });
    const unrelated = "---\ndescription: unrelated\n---\n";
    writeFileSync(join(opencodeAgentsTarget, "docs-writer.md"), unrelated);
    const originalCodexConfig = "[pre-existing codex]\n";
    const originalOpenCodeConfig = '{"model":"kept"}\n';
    writeFileSync(codexConfigTarget, originalCodexConfig);
    writeFileSync(opencodeConfigTarget, originalOpenCodeConfig);
    const backup = join(root, ".opencode-agents-backup");
    cpSync(opencodeAgentsTarget, backup, { recursive: true });

    const codexAgents = agentsDir("codex-agents-restore");
    const codexConfig = staging("codex-config-restore");
    const opencodeAgents = agentsDir("opencode-agents-restore");
    const opencodeConfig = staging("opencode-config-restore");
    writeFileSync(join(codexAgents, "implementer.toml"), "[agent]\n");
    writeFileSync(join(codexConfig, "config.toml"), "[mcp_servers.workflow_state]\n");
    writeFileSync(join(opencodeAgents, "implementer.md"), "---\nmode: subagent\n---\n");
    writeFileSync(join(opencodeAgents, "docs-writer.md"), "---\ndescription: managed copy\n---\n");
    writeFileSync(join(opencodeConfig, "opencode.json"), '{"mcp":{"workflow_state":{}}}\n');
    const rename = (from: string, to: string) => {
      if (to === opencodeConfigTarget) throw new Error("injected opencode config failure");
      execFileSync("mv", [from, to], { stdio: "ignore" });
    };
    assert.throws(
      () =>
        commitBothHosts(
          codexAgents,
          codexAgentsTarget,
          join(codexConfig, "config.toml"),
          codexConfigTarget,
          opencodeAgents,
          opencodeAgentsTarget,
          join(opencodeConfig, "opencode.json"),
          opencodeConfigTarget,
          originalCodexConfig,
          originalOpenCodeConfig,
          backup,
          rename,
        ),
      /injected opencode config failure/,
    );
    assert.ok(!existsSync(codexAgentsTarget), "codex agents must be rolled back");
    assert.equal(readFileSync(codexConfigTarget, "utf8"), originalCodexConfig, "codex config must be restored");
    assert.equal(
      readFileSync(opencodeConfigTarget, "utf8"),
      originalOpenCodeConfig,
      "opencode config must be restored",
    );
    assert.equal(
      readFileSync(join(opencodeAgentsTarget, "docs-writer.md"), "utf8"),
      unrelated,
      "pre-existing opencode agents must be restored",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function basenameOf(path: string): string {
  return path.split("/").pop() ?? path;
}
