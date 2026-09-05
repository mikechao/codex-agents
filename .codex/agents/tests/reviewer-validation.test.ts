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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadReviewerValidationPolicy,
  parseReviewerValidationPolicy,
  type ReviewerValidationPolicy,
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
