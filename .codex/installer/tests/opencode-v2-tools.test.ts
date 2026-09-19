import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import explorerTools from "../../../.opencode/plugins/codex-agents-explorer-tools/index.js";
import { resolveGitWorktree } from "../../../.opencode/plugins/codex-agents-explorer-tools/worktree.js";

const pluginDirectory = resolve(
  import.meta.dir,
  "../../../.opencode/plugins/codex-agents-explorer-tools",
);

function repositoryFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "opencode-v2-tools-")));
  const git = (directory: string, ...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(root, "init", "-q");
  git(root, "config", "user.email", "opencode-v2-tools@example.invalid");
  git(root, "config", "user.name", "OpenCode V2 Tool Tests");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "initial");
  const linked = join(root, "linked");
  git(root, "worktree", "add", "-qb", "linked", linked);
  mkdirSync(join(linked, ".codex"), { recursive: true });
  writeFileSync(
    join(linked, ".codex/reviewer-validation.json"),
    `${JSON.stringify(
      {
        version: 1,
        commands: [
          {
            argv: ["git", "status", "--short"],
            purpose: "evidence",
            timeout_ms: 10_000,
            max_output_bytes: 4096,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(linked, "changed.txt"), "linked\n");
  git(linked, "add", ".");
  git(linked, "commit", "-qm", "linked evidence policy");
  mkdirSync(join(linked, "nested/session"), { recursive: true });
  return { root, linked, sessionDirectory: join(linked, "nested/session") };
}

async function loadDefinitions(sessionDirectories: Record<string, string>) {
  const definitions = new Map<string, any>();
  let sessionLookups = 0;
  const context = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        sessionLookups += 1;
        return { location: { directory: sessionDirectories[sessionID] } };
      },
    },
    tool: {
      transform: async (callback: (editor: { add(definition: any): void }) => void) => {
        callback({ add: (definition) => definitions.set(definition.name, definition) });
        return { dispose: async () => {} };
      },
    },
  };
  await explorerTools.setup(context as never);
  return { definitions, getSessionLookups: () => sessionLookups };
}

test("the V2 plugin registers both bounded Explorer capabilities", async () => {
  const fixture = repositoryFixture();
  try {
    const loaded = await loadDefinitions({
      "ses-inspect": fixture.sessionDirectory,
      "ses-evidence": fixture.sessionDirectory,
    });
    assert.deepEqual([...loaded.definitions.keys()].sort(), ["inspectGitRange", "runEvidence"]);
    const inspect = loaded.definitions.get("inspectGitRange");
    const evidence = loaded.definitions.get("runEvidence");
    assert.deepEqual(inspect.options, { codemode: false });
    assert.deepEqual(evidence.options, { codemode: false });
    assert.equal(inspect.input.properties.base.maxLength, 200);
    assert.equal(inspect.input.properties.head.maxLength, 200);
    assert.equal(evidence.input.properties.evidenceId.maxLength, 200);
    assert.equal(evidence.input.properties.argv.maxItems, 50);

    const inspection = await inspect.execute(
      { base: "HEAD~1", head: "HEAD" },
      { agent: "explorer", sessionID: "ses-inspect" },
    );
    assert.equal(inspection.output.incomplete, false);
    assert.deepEqual(inspection.output.changedPaths, [
      ".codex/reviewer-validation.json",
      "changed.txt",
    ]);

    const evidenceResult = await evidence.execute(
      { evidenceId: "EVIDENCE-V2", argv: ["git", "status", "--short"] },
      { agent: "explorer", sessionID: "ses-evidence" },
    );
    assert.equal(evidenceResult.output.status, "passed");
    assert.deepEqual(evidenceResult.output.executed_argv, ["git", "status", "--short"]);
    assert.equal(loaded.getSessionLookups(), 2);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("V2 worktree resolution uses the owning linked checkout, not the nested session path", () => {
  const fixture = repositoryFixture();
  try {
    assert.equal(resolveGitWorktree(fixture.sessionDirectory), fixture.linked);
    assert.notEqual(resolveGitWorktree(fixture.sessionDirectory), fixture.root);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("non-Explorer calls fail closed before session or repository access", async () => {
  const loaded = await loadDefinitions({});
  const inspect = loaded.definitions.get("inspectGitRange");
  const evidence = loaded.definitions.get("runEvidence");
  const deniedInspection = await inspect.execute(
    { base: "HEAD", head: "HEAD" },
    { agent: "implementer", sessionID: "ses-denied" },
  );
  const deniedEvidence = await evidence.execute(
    { evidenceId: "EVIDENCE-DENIED", argv: ["git", "status", "--short"] },
    { agent: "implementer", sessionID: "ses-denied" },
  );
  assert.equal(deniedInspection.output.incomplete, true);
  assert.equal(deniedEvidence.output.status, "failed");
  assert.equal(loaded.getSessionLookups(), 0);
});

test("the plugin contains no V1 registration surface", () => {
  const source = readFileSync(join(pluginDirectory, "index.ts"), "utf8");
  assert.match(source, /Plugin\.define/u);
  assert.match(source, /ctx\.tool\.transform/u);
  assert.doesNotMatch(source, /@opencode-ai\/plugin/u);
  assert.doesNotMatch(source, /\btool\(/u);
  assert.doesNotMatch(source, /context\.worktree/u);
  assert.doesNotMatch(source, /title:/u);
});
