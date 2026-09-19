import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inspectGitRange } from "../../../.opencode/plugins/codex-agents-explorer-tools/inspect-git-range.js";

const sourcePath = resolve(
  import.meta.dir,
  "../../../.opencode/plugins/codex-agents-explorer-tools/inspect-git-range.ts",
);

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

test("inspectGitRange resolves revisions independently and supports bounded ancestry", () => {
  const fixtureData = fixture();
  try {
    const result = inspectGitRange({ base: "HEAD~1", head: "HEAD" }, fixtureData.root);
    assert.deepEqual(result.resolved, { base: fixtureData.base, head: fixtureData.head });
    assert.equal(result.incomplete, false);
    assert.deepEqual(result.changedPaths.sort(), ["new.txt", "tracked.txt"]);
    assert.match(result.stat, /2 files changed/u);
    assert.match(result.diff, /diff --git/u);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
  }
});

test("inspectGitRange rejects unsafe revision expressions before Git access", () => {
  const notRepository = mkdtempSync(join(tmpdir(), "inspect-git-range-not-git-"));
  try {
    for (const revision of [
      "",
      "-HEAD",
      "HEAD^",
      "HEAD~",
      "HEAD~1~1",
      "main~1",
      `${"a".repeat(40)}~2`,
      "HEAD..main",
      "HEAD:path",
      "HEAD;touch",
      "main/",
      "feature.lock/topic",
      "feature./topic",
    ]) {
      const result = inspectGitRange({ base: revision, head: "HEAD" }, notRepository);
      assert.equal(result.incomplete, true);
      assert.equal(result.resolved.base, null);
      assert.equal(result.resolved.head, null);
    }
  } finally {
    rmSync(notRepository, { recursive: true, force: true });
  }
});

test("inspectGitRange disables configured external diff and textconv helpers", () => {
  const fixtureData = fixture();
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
    const result = inspectGitRange(
      { base: fixtureData.base, head: fixtureData.head },
      fixtureData.root,
    );
    assert.equal(result.incomplete, false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
  }
});

test("inspectGitRange reports incomplete output rather than claiming a complete large patch", () => {
  const fixtureData = fixture();
  try {
    writeFileSync(join(fixtureData.root, "large.txt"), `${"large line\n".repeat(100_000)}`);
    execFileSync("git", ["-C", fixtureData.root, "add", "large.txt"]);
    execFileSync("git", ["-C", fixtureData.root, "commit", "-qm", "large"]);
    const result = inspectGitRange({ base: fixtureData.base, head: "HEAD" }, fixtureData.root);
    assert.equal(result.incomplete, true);
    assert.match(result.diff, /output truncated/u);
  } finally {
    rmSync(fixtureData.root, { recursive: true, force: true });
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
