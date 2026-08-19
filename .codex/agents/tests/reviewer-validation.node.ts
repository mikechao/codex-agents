import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadReviewerValidationPolicy,
  parseReviewerValidationPolicy,
  type ReviewerValidationPolicy,
  runReviewerValidation,
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

test("policy accepts exact argv and rejects duplicates, policy IDs, shell syntax, and malformed limits", () => {
  const parsed = policy(["bun", "-e", "process.stdout.write('ok')"]);
  assert.deepEqual(parsed.commands[0]?.argv, ["bun", "-e", "process.stdout.write('ok')"]);
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

test("project policy maps every required validation to its authoritative command", () => {
  const commands = loadReviewerValidationPolicy().commands.map((command) => command.argv);
  assert.deepEqual(commands, [
    ["bun", "run", "generate:agents"],
    ["bun", "run", "test:agents"],
    ["bun", "run", "test:installer"],
    ["bun", "run", "test:workflow-mcp"],
    ["bun", "run", "validate"],
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
