import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sourcePath = resolve(import.meta.dir, "../../../.opencode/tools/inspectGitRange.ts");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "inspect-git-range-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  git("config", "user.email", "inspect@example.invalid");
  git("config", "user.name", "Inspect Git Range Tests");
  writeFileSync(join(root, "tracked.txt"), "one\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "initial");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "tracked.txt"), "two\n");
  writeFileSync(join(root, "new.txt"), "new\n");
  git("add", ".");
  git("commit", "-qm", "second");
  return { root, base, head: git("rev-parse", "HEAD").trim() };
}

async function loadTool() {
  const root = mkdtempSync(join(tmpdir(), "inspect-git-range-module-"));
  const toolDirectory = join(root, ".opencode/tools");
  const pluginDirectory = join(root, "node_modules/@opencode-ai/plugin");
  mkdirSync(toolDirectory, { recursive: true });
  mkdirSync(pluginDirectory, { recursive: true });
  cpSync(sourcePath, join(toolDirectory, "inspectGitRange.ts"));
  writeFileSync(join(pluginDirectory, "package.json"), '{"type":"module"}\n');
  writeFileSync(
    join(pluginDirectory, "index.js"),
    [
      "const schema = { string: () => ({ min() { return this; }, max() { return this; } }) };",
      "export const tool = (definition) => definition;",
      "tool.schema = schema;",
    ].join("\n"),
  );
  const module = await import(`${join(toolDirectory, "inspectGitRange.ts")}?test=${Date.now()}`);
  return { root, module };
}

test("inspectGitRange resolves revisions independently and returns bounded diff metadata", async () => {
  const fixtureData = fixture();
  const loaded = await loadTool();
  try {
    const result = loaded.module.inspectGitRange(
      { base: fixtureData.base, head: fixtureData.head },
      fixtureData.root,
    );
    assert.deepEqual(result.resolved, { base: fixtureData.base, head: fixtureData.head });
    assert.equal(result.incomplete, false);
    assert.deepEqual(result.changedPaths.sort(), ["new.txt", "tracked.txt"]);
    assert.match(result.stat, /2 files changed/u);
    assert.match(result.diff, /diff --git/u);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
    rmSync(loaded.root, { recursive: true, force: true });
  }
});

test("inspectGitRange rejects revision expressions before Git access and enforces Explorer", async () => {
  const loaded = await loadTool();
  const notRepository = mkdtempSync(join(tmpdir(), "inspect-git-range-not-git-"));
  try {
    for (const revision of [
      "",
      "-HEAD",
      "HEAD^",
      "HEAD~1",
      "HEAD..main",
      "HEAD:path",
      "HEAD;touch",
      "main/",
      "feature.lock/topic",
      "feature./topic",
    ]) {
      const result = loaded.module.inspectGitRange({ base: revision, head: "HEAD" }, notRepository);
      assert.equal(result.incomplete, true);
      assert.equal(result.resolved.base, null);
      assert.equal(result.resolved.head, null);
    }
    const toolDefinition = loaded.module.default;
    const denied = await toolDefinition.execute(
      { base: "HEAD", head: "HEAD" },
      { agent: "implementer", worktree: notRepository },
    );
    const deniedInspection = JSON.parse(denied.output);
    assert.equal(deniedInspection.incomplete, true);
    assert.equal(deniedInspection.exitStatus, null);
  } finally {
    rmSync(notRepository, { recursive: true, force: true });
    rmSync(loaded.root, { recursive: true, force: true });
  }
});

test("inspectGitRange disables configured external diff and textconv helpers", async () => {
  const fixtureData = fixture();
  const loaded = await loadTool();
  const marker = join(fixtureData.root, "helper-invoked");
  const helper = join(fixtureData.root, "hostile-diff-helper.mjs");
  writeFileSync(
    helper,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "invoked");\n`,
  );
  chmodSync(helper, 0o755);
  try {
    execFileSync("git", ["-C", fixtureData.root, "config", "diff.external", helper]);
    execFileSync("git", ["-C", fixtureData.root, "config", "diff.hostile.textconv", helper]);
    writeFileSync(join(fixtureData.root, ".gitattributes"), "tracked.txt diff=hostile\n");
    const result = loaded.module.inspectGitRange(
      { base: fixtureData.base, head: fixtureData.head },
      fixtureData.root,
    );
    assert.equal(result.incomplete, false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
    rmSync(loaded.root, { recursive: true, force: true });
  }
});

test("inspectGitRange reports incomplete output rather than claiming a complete large patch", async () => {
  const fixtureData = fixture();
  const loaded = await loadTool();
  try {
    writeFileSync(join(fixtureData.root, "large.txt"), `${"large line\n".repeat(100_000)}`);
    execFileSync("git", ["-C", fixtureData.root, "add", "large.txt"]);
    execFileSync("git", ["-C", fixtureData.root, "commit", "-qm", "large"]);
    const result = loaded.module.inspectGitRange(
      { base: fixtureData.base, head: "HEAD" },
      fixtureData.root,
    );
    assert.equal(result.incomplete, true);
    assert.match(result.diff, /output truncated/u);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
    rmSync(loaded.root, { recursive: true, force: true });
  }
});

test("inspectGitRange source has no evidence, MCP, mutation, or caller-selected Git surface", () => {
  const source = readFileSync(sourcePath, "utf8");
  for (const forbidden of [
    "runEvidence",
    "workflow_state",
    "Bun.$",
    "--output",
    "--no-index",
    "git add",
    "git commit",
  ]) {
    assert.ok(!source.includes(forbidden), `unexpected capability in range tool: ${forbidden}`);
  }
  assert.match(source, /shell: false/u);
  assert.match(source, /--end-of-options/u);
  assert.match(source, /\["diff"/u);
});
