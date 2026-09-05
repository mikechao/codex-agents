import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  loadReviewerValidationPolicy,
  parseReviewerValidationPolicy,
  type ReviewerValidationPolicy,
  reviewTargetFingerprint,
  runReviewerEvidence,
  runReviewerValidation,
  runStructuredReviewerEvidence,
} from "../reviewer-validation.js";

function policy(argv: string[]): ReviewerValidationPolicy {
  return parseReviewerValidationPolicy({
    version: 1,
    commands: [
      {
        argv,
        timeout_ms: 10_000,
        max_output_bytes: 4096,
      },
    ],
  });
}

function gitFixture() {
  const root = mkdtempSync(join(tmpdir(), "reviewer-validation-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q");
  git("config", "user.email", "reviewer@example.invalid");
  git("config", "user.name", "Reviewer Tests");
  writeFileSync(join(root, "tracked.txt"), "before\n");
  git("add", "tracked.txt");
  git("commit", "-qm", "fixture");
  return { root, git };
}

function workflowValidationFixture() {
  const fixture = gitFixture();
  writeFileSync(
    join(fixture.root, "package.json"),
    JSON.stringify({
      private: true,
      scripts: { "test:workflow-mcp": "bun -e \"process.stdout.write('workflow fixture')\"" },
    }),
  );
  return fixture;
}

function runFixtureCommand(root: string, argv: string[]) {
  return runReviewerValidation(policy(argv), "VAL-FIXTURE", argv, root);
}

function gitPath(root: string, name: string): string {
  return resolve(
    root,
    execFileSync("git", ["-C", root, "rev-parse", "--git-path", name], {
      encoding: "utf8",
    }).trim(),
  );
}

test("legacy CLI rejects evidence mode before parsing or execution", () => {
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dir, "../reviewer-validation.ts"),
      "--evidence-id",
      "EVIDENCE-CLI",
      "--argv-json",
      "not-json",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Usage: bun .codex/agents/reviewer-validation.ts --validation-id ID --argv-json JSON\n",
  );
});

test("policy accepts exact argv and rejects duplicates, policy IDs, shell syntax, and malformed limits", () => {
  const parsed = policy(["bun", "-e", "process.stdout.write('ok')"]);
  assert.deepEqual(parsed.commands[0]?.argv, ["bun", "-e", "process.stdout.write('ok')"]);
  assert.equal(parsed.commands[0]?.purpose, "validation");
  const evidence = parseReviewerValidationPolicy({
    version: 1,
    commands: [
      { argv: ["git", "status"], purpose: "evidence", timeout_ms: 10, max_output_bytes: 100 },
    ],
  });
  assert.equal(evidence.commands[0]?.purpose, "evidence");
  assert.throws(
    () =>
      parseReviewerValidationPolicy({
        version: 1,
        commands: [{ argv: ["bun"], purpose: "other", timeout_ms: 10, max_output_bytes: 100 }],
      }),
    /purpose must be validation or evidence/,
  );
  assert.throws(
    () =>
      parseReviewerValidationPolicy({
        version: 1,
        commands: [
          {
            argv: ["bun", "run", "check"],
            timeout_ms: 1,
            max_output_bytes: 1,
          },
          {
            argv: ["bun", "run", "check"],
            timeout_ms: 1,
            max_output_bytes: 1,
          },
        ],
      }),
    /duplicate argv/,
  );
  assert.throws(() => policy(["bun", "run", "check;touch p"]), /shell syntax/);
  assert.throws(() => policy(["sh", "-c", "true"]), /invokes a shell/);
  assert.throws(
    () => parseReviewerValidationPolicy({ version: 1, commands: [] }),
    /non-empty array/,
  );
  assert.throws(
    () =>
      parseReviewerValidationPolicy({
        version: 1,
        commands: [{ argv: ["bun"], max_output_bytes: 1 }],
      }),
    /invalid fields/,
  );
});

test("evidence mode selects only explicit evidence commands", () => {
  const { root } = gitFixture();
  const argv = ["git", "status", "--porcelain"];
  try {
    const policy = parseReviewerValidationPolicy({
      version: 1,
      commands: [
        { argv, purpose: "evidence", timeout_ms: 10_000, max_output_bytes: 4096 },
        {
          argv: ["git", "log", "-1"],
          purpose: "validation",
          timeout_ms: 10_000,
          max_output_bytes: 4096,
        },
        {
          argv: ["command-that-does-not-exist"],
          purpose: "evidence",
          timeout_ms: 10_000,
          max_output_bytes: 4096,
        },
      ],
    });
    const result = runReviewerEvidence(policy, "EVIDENCE-1", argv, root);
    assert.equal(result.status, "passed");
    assert.equal(result.exit_code, 0);
    assert.deepEqual(result.requested_argv, argv);
    assert.deepEqual(result.executed_argv, argv);
    assert.throws(
      () => runReviewerEvidence(policy, "EVIDENCE-NO", ["git", "log", "-1"], root),
      /requested evidence argv is not allowlisted/,
    );
    assert.throws(
      () => runReviewerValidation(policy, "VAL-NO", argv, root),
      /requested validation argv is not allowlisted/,
    );
    const unavailable = runReviewerEvidence(
      policy,
      "EVIDENCE-UNAVAILABLE",
      ["command-that-does-not-exist"],
      root,
    );
    assert.equal(unavailable.status, "unavailable");
    assert.equal(unavailable.working_tree_changed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured evidence returns bounded outcomes without an alternate execution path", () => {
  const { root } = gitFixture();
  try {
    const argv = ["git", "status", "--porcelain"];
    mkdirSync(join(root, ".codex"));
    writeFileSync(
      join(root, ".codex/reviewer-validation.json"),
      JSON.stringify({
        version: 1,
        commands: [{ argv, purpose: "evidence", timeout_ms: 10_000, max_output_bytes: 4096 }],
      }),
    );
    const positive = runStructuredReviewerEvidence(
      { evidenceId: "EVIDENCE-STRUCTURED", argv },
      root,
    );
    assert.equal(positive.status, "passed");
    assert.deepEqual(positive.requested_argv, argv);
    assert.deepEqual(positive.executed_argv, argv);
    assert.equal(positive.validation_id, "EVIDENCE-STRUCTURED");

    const denied = runStructuredReviewerEvidence(
      { evidenceId: "EVIDENCE-DENIED", argv: ["git", "status", "--short"] },
      root,
    );
    assert.equal(denied.status, "failed");
    assert.deepEqual(denied.executed_argv, []);
    assert.equal(denied.working_tree_changed, false);

    const shellData = runStructuredReviewerEvidence(
      { evidenceId: "EVIDENCE-SHELL", argv: ["git", "status;touch escaped"] },
      root,
    );
    assert.equal(shellData.status, "failed");
    assert.deepEqual(shellData.executed_argv, []);
    assert.equal(existsSync(join(root, "escaped")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project policy maps every required validation to its authoritative command", () => {
  const policy = loadReviewerValidationPolicy();
  const commands = policy.commands.map((command) => command.argv);
  assert.ok(policy.commands.every((command) => command.purpose === "validation"));
  assert.deepEqual(commands, [
    ["bun", "run", "generate:agents"],
    ["bun", "run", "test:agents"],
    ["bun", "run", "test:installer"],
    ["bun", "run", "test:workflow-mcp"],
    ["bun", "run", "validate"],
    ["bun", "run", "test:coverage"],
  ]);
});

test("project workflow validation is authorized and runs through the reviewer runner", () => {
  const workflowArgv = ["bun", "run", "test:workflow-mcp"];
  const { root } = workflowValidationFixture();
  try {
    const result = runReviewerValidation(
      loadReviewerValidationPolicy(),
      "VAL-LOCAL-WORKFLOW",
      workflowArgv,
      root,
    );
    assert.equal(result.status, "passed");
    assert.equal(result.exit_code, 0);
    assert.equal(result.working_tree_changed, false);
    assert.deepEqual(result.requested_argv, workflowArgv);
    assert.deepEqual(result.executed_argv, workflowArgv);
    assert.match(result.output, /workflow fixture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unauthorized argv fails before execution while IDs remain local correlation", () => {
  const { root } = gitFixture();
  try {
    assert.throws(
      () =>
        runReviewerValidation(
          policy(["bun", "-e", "process.exit(1)"]),
          "VAL-NOPE",
          ["bun", "-e", "process.exit(2)"],
          root,
        ),
      /not allowlisted/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner uses repository root, records output, and returns failures", () => {
  const { root } = gitFixture();
  try {
    const result = runReviewerValidation(
      policy(["bun", "-e", "process.stdout.write(process.cwd())"]),
      "VAL-TEST",
      ["bun", "-e", "process.stdout.write(process.cwd())"],
      root,
    );
    assert.equal(result.status, "passed");
    assert.equal(result.exit_code, 0);
    assert.equal(result.working_tree_changed, false);
    assert.deepEqual(result.requested_argv, ["bun", "-e", "process.stdout.write(process.cwd())"]);
    assert.deepEqual(result.executed_argv, result.requested_argv);
    assert.equal(result.output, realpathSync(root));
    const reusedId = runReviewerValidation(
      policy(["bun", "-e", "process.stdout.write(process.cwd())"]),
      "VAL-001",
      ["bun", "-e", "process.stdout.write(process.cwd())"],
      root,
    );
    assert.equal(reusedId.validation_id, "VAL-001");
    assert.equal(reusedId.status, "passed");

    const failed = runReviewerValidation(
      policy(["bun", "-e", "process.stderr.write('bad'),process.exit(3)"]),
      "VAL-TEST",
      ["bun", "-e", "process.stderr.write('bad'),process.exit(3)"],
      root,
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.exit_code, 3);
    assert.match(failed.output, /bad/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner rejects approval evidence when validation mutates the review target", () => {
  const { root } = gitFixture();
  try {
    const script = `Bun.write(${JSON.stringify(join(root, "tracked.txt"))}, "after")`;
    const result = runReviewerValidation(
      policy(["bun", "-e", script]),
      "VAL-TEST",
      ["bun", "-e", script],
      root,
    );
    assert.equal(result.status, "mutated");
    assert.equal(result.working_tree_changed, true);
    assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "after");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner detects ignored file creation, modification, and removal", () => {
  const fixture = gitFixture();
  const ignoredPath = join(fixture.root, "ignored.txt");
  try {
    writeFileSync(join(fixture.root, ".gitignore"), "ignored.txt\n");
    fixture.git("add", ".gitignore");
    fixture.git("commit", "-qm", "ignore fixture");

    const createArgv = ["bun", "-e", `Bun.write(${JSON.stringify(ignoredPath)}, "one")`];
    assert.equal(runFixtureCommand(fixture.root, createArgv).status, "mutated");
    const modifyArgv = ["bun", "-e", `Bun.write(${JSON.stringify(ignoredPath)}, "two")`];
    assert.equal(runFixtureCommand(fixture.root, modifyArgv).status, "mutated");
    const removeArgv = ["bun", "-e", `Bun.spawnSync(["rm", ${JSON.stringify(ignoredPath)}])`];
    assert.equal(runFixtureCommand(fixture.root, removeArgv).status, "mutated");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner detects index-only flags without working-tree byte changes", () => {
  const fixture = gitFixture();
  try {
    const argv = ["git", "update-index", "--assume-unchanged", "tracked.txt"];
    const result = runFixtureCommand(fixture.root, argv);
    assert.equal(result.status, "mutated");
    assert.equal(result.exit_code, 0);
    assert.equal(readFileSync(join(fixture.root, "tracked.txt"), "utf8"), "before\n");
    fixture.git("update-index", "--no-assume-unchanged", "tracked.txt");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fingerprint detects local config, refs, and symbolic or detached HEAD state", () => {
  const fixture = gitFixture();
  try {
    const configBefore = reviewTargetFingerprint(fixture.root);
    fixture.git("config", "--local", "reviewer.flag", "one");
    assert.notEqual(reviewTargetFingerprint(fixture.root), configBefore);

    const refBefore = reviewTargetFingerprint(fixture.root);
    fixture.git("update-ref", "refs/reviewer/test", "HEAD");
    assert.notEqual(reviewTargetFingerprint(fixture.root), refBefore);

    const branch = fixture.git("symbolic-ref", "HEAD").trim();
    fixture.git("update-ref", "refs/heads/reviewer-head-test", "HEAD");
    const headBefore = reviewTargetFingerprint(fixture.root);
    fixture.git("symbolic-ref", "HEAD", "refs/heads/reviewer-head-test");
    assert.notEqual(reviewTargetFingerprint(fixture.root), headBefore);
    fixture.git("symbolic-ref", "HEAD", branch);
    const detachedBefore = reviewTargetFingerprint(fixture.root);
    fixture.git("checkout", "-q", "--detach", "HEAD");
    assert.notEqual(reviewTargetFingerprint(fixture.root), detachedBefore);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fingerprint detects every fixed Git operation marker and bounded directory state", () => {
  const fixture = gitFixture();
  try {
    for (const marker of [
      "MERGE_HEAD",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "BISECT_START",
      "BISECT_TERMS",
      "BISECT_EXPECTED_REV",
      "BISECT_LOG",
    ]) {
      const path = gitPath(fixture.root, marker);
      const before = reviewTargetFingerprint(fixture.root);
      writeFileSync(path, `${marker}-one\n`);
      const created = reviewTargetFingerprint(fixture.root);
      assert.notEqual(created, before, `${marker} creation must be fingerprinted`);
      writeFileSync(path, `${marker}-two\n`);
      assert.notEqual(
        reviewTargetFingerprint(fixture.root),
        created,
        `${marker} content must vary`,
      );
      rmSync(path);
      assert.notEqual(
        reviewTargetFingerprint(fixture.root),
        created,
        `${marker} removal must vary`,
      );
    }

    for (const directory of ["sequencer", "rebase-merge", "rebase-apply"]) {
      const path = gitPath(fixture.root, directory);
      mkdirSync(join(path, "nested"), { recursive: true });
      writeFileSync(join(path, "state"), "one\n");
      writeFileSync(join(path, "nested", "todo"), "first\n");
      const first = reviewTargetFingerprint(fixture.root);
      writeFileSync(join(path, "nested", "todo"), "second\n");
      assert.notEqual(
        reviewTargetFingerprint(fixture.root),
        first,
        `${directory} content must vary`,
      );
      rmSync(path, { recursive: true, force: true });
      assert.notEqual(
        reviewTargetFingerprint(fixture.root),
        first,
        `${directory} removal must vary`,
      );
    }

    writeFileSync(join(fixture.root, ".git", "unrelated-operation-state"), "one\n");
    const arbitrary = reviewTargetFingerprint(fixture.root);
    writeFileSync(join(fixture.root, ".git", "unrelated-operation-state"), "two\n");
    assert.equal(
      reviewTargetFingerprint(fixture.root),
      arbitrary,
      "arbitrary Git metadata must not affect operation-state fingerprinting",
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("operation-state traversal is deterministic and fails closed for unsupported bounded state", () => {
  const fixture = gitFixture();
  try {
    const sequencer = gitPath(fixture.root, "sequencer");
    mkdirSync(join(sequencer, "z"), { recursive: true });
    mkdirSync(join(sequencer, "a"), { recursive: true });
    writeFileSync(join(sequencer, "z", "state"), "z\n");
    writeFileSync(join(sequencer, "a", "state"), "a\n");
    const first = reviewTargetFingerprint(fixture.root);
    rmSync(sequencer, { recursive: true, force: true });
    mkdirSync(join(sequencer, "a"), { recursive: true });
    mkdirSync(join(sequencer, "z"), { recursive: true });
    writeFileSync(join(sequencer, "a", "state"), "a\n");
    writeFileSync(join(sequencer, "z", "state"), "z\n");
    assert.equal(reviewTargetFingerprint(fixture.root), first, "entry ordering must be stable");

    rmSync(sequencer, { recursive: true, force: true });
    mkdirSync(sequencer, { recursive: true });
    symlinkSync("outside", join(sequencer, "link"));
    assert.throws(() => reviewTargetFingerprint(fixture.root), /symlink/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("local include directives are fingerprinted without following external targets", () => {
  const fixture = gitFixture();
  const externalDirectory = mkdtempSync(join(tmpdir(), "reviewer-validation-include-"));
  const externalPath = join(externalDirectory, "external.gitconfig");
  try {
    writeFileSync(externalPath, "[reviewer]\n\tvalue = one\n");
    fixture.git("config", "--local", "include.path", externalPath);
    const includedBefore = reviewTargetFingerprint(fixture.root);
    writeFileSync(externalPath, "[reviewer]\n\tvalue = two\n");
    assert.equal(reviewTargetFingerprint(fixture.root), includedBefore);
    fixture.git("config", "--local", "include.path", `${externalPath}.changed`);
    assert.notEqual(reviewTargetFingerprint(fixture.root), includedBefore);
  } finally {
    rmSync(externalDirectory, { recursive: true, force: true });
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("fingerprint collection failures fail closed before and after launch", () => {
  const root = mkdtempSync(join(tmpdir(), "reviewer-validation-not-git-"));
  const marker = join(root, "launched");
  const argv = ["bun", "-e", `Bun.write(${JSON.stringify(marker)}, "launched")`];
  try {
    const before = runFixtureCommand(root, argv);
    assert.equal(before.status, "failed");
    assert.deepEqual(before.executed_argv, []);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const fixture = gitFixture();
  const headPath = join(fixture.root, ".git/HEAD");
  const removeHeadArgv = ["bun", "-e", `Bun.spawnSync(["rm", ${JSON.stringify(headPath)}])`];
  try {
    const after = runFixtureCommand(fixture.root, removeHeadArgv);
    assert.equal(after.status, "failed");
    assert.equal(after.exit_code, 0);
    assert.equal(after.working_tree_changed, false);
    assert.match(after.output, /fingerprint collection failed after launch/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner bounds validation output and timeout", () => {
  const { root } = gitFixture();
  try {
    const outputPolicy = parseReviewerValidationPolicy({
      version: 1,
      commands: [
        {
          argv: ["bun", "-e", 'process.stdout.write("x".repeat(100))'],
          timeout_ms: 10_000,
          max_output_bytes: 32,
        },
        {
          argv: ["bun", "-e", "setTimeout(process.exit,1000)"],
          timeout_ms: 10,
          max_output_bytes: 1024,
        },
        {
          argv: ["bun", "-e", 'process.stderr.write("warning")'],
          timeout_ms: 10_000,
          max_output_bytes: 1024,
        },
        {
          argv: ["bun", "-e", 'process.stderr.write("x".repeat(1_000_000))'],
          timeout_ms: 10_000,
          max_output_bytes: 1024,
        },
      ],
    });
    const outputArgv = ["bun", "-e", 'process.stdout.write("x".repeat(100))'];
    const output = runReviewerValidation(outputPolicy, "VAL-OUTPUT", outputArgv, root);
    assert.equal(output.status, "failed");
    assert.ok(Buffer.byteLength(output.output) <= 32);
    assert.match(output.output, /output truncated/);
    const timeoutArgv = ["bun", "-e", "setTimeout(process.exit,1000)"];
    const timeout = runReviewerValidation(outputPolicy, "VAL-TIMEOUT", timeoutArgv, root);
    assert.equal(timeout.status, "failed");
    assert.equal(timeout.timed_out, true);
    const stderrArgv = ["bun", "-e", 'process.stderr.write("warning")'];
    const stderr = runReviewerValidation(outputPolicy, "VAL-STDERR", stderrArgv, root);
    assert.equal(stderr.status, "passed");
    assert.equal(stderr.output, "warning");
    const backpressureArgv = ["bun", "-e", 'process.stderr.write("x".repeat(1_000_000))'];
    const backpressure = runReviewerValidation(
      outputPolicy,
      "VAL-BACKPRESSURE",
      backpressureArgv,
      root,
    );
    assert.equal(backpressure.status, "failed");
    assert.ok(Buffer.byteLength(backpressure.output) <= 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("truncation evidence never exceeds small policy limits", () => {
  const { root } = gitFixture();
  try {
    const markerBytes = Buffer.byteLength("\n[output truncated]", "utf8");
    for (const limit of [1, markerBytes, markerBytes + 1]) {
      const outputPolicy = parseReviewerValidationPolicy({
        version: 1,
        commands: [
          {
            argv: ["bun", "-e", 'process.stdout.write("€".repeat(100))'],
            timeout_ms: 10_000,
            max_output_bytes: limit,
          },
        ],
      });
      const result = runReviewerValidation(
        outputPolicy,
        "VAL-BOUNDARY",
        ["bun", "-e", 'process.stdout.write("€".repeat(100))'],
        root,
      );
      assert.equal(result.status, "failed");
      assert.ok(Buffer.byteLength(result.output, "utf8") <= limit);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
