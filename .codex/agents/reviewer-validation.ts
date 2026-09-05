#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROJECT_ROOT = resolve(import.meta.dir, "../..");
const DEFAULT_POLICY_PATH = resolve(PROJECT_ROOT, ".codex/reviewer-validation.json");
const MAX_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_BYTES = 1_048_576;
const MAX_ARGUMENT_LENGTH = 4096;
const MAX_EVIDENCE_ID_LENGTH = 200;
const SHELL_SYNTAX = /[;&|`$<>\n\r\\]/u;
const SHELL_EXECUTABLES = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "ksh",
  "csh",
  "cmd",
  "powershell",
  "pwsh",
]);

export interface ReviewerValidationCommand {
  argv: string[];
  purpose: "validation" | "evidence";
  timeout_ms: number;
  max_output_bytes: number;
}

export interface ReviewerValidationPolicy {
  version: 1;
  commands: ReviewerValidationCommand[];
}

export interface ValidationEvidence {
  validation_id: string;
  requested_argv: string[];
  executed_argv: string[];
  status: "passed" | "failed" | "unavailable" | "mutated";
  exit_code: number | null;
  timed_out: boolean;
  output: string;
  working_tree_changed: boolean;
}

function objectRecord(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ARGUMENT_LENGTH)
    throw new Error(
      `${context} must be a non-empty string of at most ${MAX_ARGUMENT_LENGTH} characters`,
    );
  if (SHELL_SYNTAX.test(value)) throw new Error(`${context} contains shell syntax`);
  return value;
}

function evidenceIdValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EVIDENCE_ID_LENGTH) {
    throw new Error(
      `evidence ID must be a non-empty string of at most ${MAX_EVIDENCE_ID_LENGTH} characters`,
    );
  }
  if (SHELL_SYNTAX.test(value)) throw new Error("evidence ID contains shell syntax");
  return value;
}

function boundedInteger(value: unknown, context: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${context} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

function argvValue(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error(`${context} must be a non-empty array`);
  }
  return value.map((argument, index) => stringValue(argument, `${context}[${index}]`));
}

function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

export function parseReviewerValidationPolicy(value: unknown): ReviewerValidationPolicy {
  const policy = objectRecord(value, "policy");
  if (policy.version !== 1) throw new Error("policy.version must be 1");
  if (!Array.isArray(policy.commands) || policy.commands.length === 0) {
    throw new Error("policy.commands must be a non-empty array");
  }
  const parsedCommands: ReviewerValidationCommand[] = [];
  const commands = policy.commands.map((entry, index) => {
    const command = objectRecord(entry, `policy.commands[${index}]`);
    const keys = Object.keys(command).sort().join(",");
    if (
      keys !== "argv,max_output_bytes,purpose,timeout_ms" &&
      keys !== "argv,max_output_bytes,timeout_ms"
    ) {
      throw new Error(`policy.commands[${index}] has invalid fields`);
    }
    const purpose: ReviewerValidationCommand["purpose"] =
      command.purpose === undefined
        ? "validation"
        : (command.purpose as ReviewerValidationCommand["purpose"]);
    if (purpose !== "validation" && purpose !== "evidence") {
      throw new Error(`policy.commands[${index}].purpose must be validation or evidence`);
    }
    const argv = argvValue(command.argv, `policy.commands[${index}].argv`);
    const executable = argv[0].split(/[\\/]/u).pop() ?? argv[0];
    if (
      SHELL_EXECUTABLES.has(executable) ||
      argv.slice(1).some((argument) => /^-(?:c|command|encodedcommand)$/iu.test(argument))
    ) {
      throw new Error(`policy.commands[${index}].argv invokes a shell`);
    }
    const timeout = boundedInteger(
      command.timeout_ms,
      `policy.commands[${index}].timeout_ms`,
      MAX_TIMEOUT_MS,
    );
    const maxOutput = boundedInteger(
      command.max_output_bytes,
      `policy.commands[${index}].max_output_bytes`,
      MAX_OUTPUT_BYTES,
    );
    if (parsedCommands.some((candidate) => sameArgv(candidate.argv, argv))) {
      throw new Error(`duplicate argv: ${JSON.stringify(argv)}`);
    }
    const parsed = {
      argv,
      purpose,
      timeout_ms: timeout,
      max_output_bytes: maxOutput,
    };
    parsedCommands.push(parsed);
    return parsed;
  });
  return { version: 1, commands };
}

export function loadReviewerValidationPolicy(
  policyPath = DEFAULT_POLICY_PATH,
): ReviewerValidationPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch (cause) {
    throw new Error(`unable to read reviewer validation policy: ${policyPath}`, { cause });
  }
  return parseReviewerValidationPolicy(parsed);
}

function boundedOutput(value: string, maximumBytes: number, truncated = false): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maximumBytes && !truncated) return value;
  const marker = Buffer.from("\n[output truncated]", "utf8");
  if (maximumBytes <= marker.byteLength) {
    return marker.subarray(0, maximumBytes).toString("utf8");
  }
  const contentLimit = Math.max(0, maximumBytes - marker.byteLength);
  let low = 0;
  let high = value.length;
  while (low < high) {
    const midpoint = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, midpoint), "utf8") <= contentLimit) low = midpoint;
    else high = midpoint - 1;
  }
  return `${value.slice(0, low)}${marker.toString("utf8")}`;
}

function readOutputBytes(path: string, maximumBytes: number): Buffer {
  const descriptor = openSync(path, "r");
  try {
    const output = Buffer.alloc(maximumBytes);
    const bytesRead = readSync(descriptor, output, 0, maximumBytes, 0);
    return output.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

export function reviewTargetFingerprint(projectRoot = PROJECT_ROOT): string {
  const hash = createHash("sha256");
  const status = execFileSync(
    "git",
    ["-C", projectRoot, "status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: projectRoot, encoding: "buffer", maxBuffer: 2 * MAX_OUTPUT_BYTES },
  );
  hash.update(status);
  const tracked = execFileSync("git", ["-C", projectRoot, "diff", "--binary", "HEAD", "--"], {
    cwd: projectRoot,
    encoding: "buffer",
    maxBuffer: 2 * MAX_OUTPUT_BYTES,
  });
  hash.update(tracked);
  const untracked = execFileSync(
    "git",
    ["-C", projectRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 2 * MAX_OUTPUT_BYTES },
  );
  for (const relativePath of untracked.split("\0").filter(Boolean)) {
    hash.update(relativePath);
    hash.update(readFileSync(join(projectRoot, relativePath)));
  }
  return hash.digest("hex");
}

function runAuthorizedCommand(
  policy: ReviewerValidationPolicy,
  validationId: string,
  requestedArgv: readonly string[],
  purpose: ReviewerValidationCommand["purpose"],
  projectRoot = PROJECT_ROOT,
): ValidationEvidence {
  const requested = argvValue(requestedArgv, "requested argv");
  const command = policy.commands.find(
    (candidate) => candidate.purpose === purpose && sameArgv(candidate.argv, requested),
  );
  if (command === undefined) {
    throw new Error(`requested ${purpose} argv is not allowlisted: ${JSON.stringify(requested)}`);
  }
  const before = reviewTargetFingerprint(projectRoot);
  const outputDirectory = mkdtempSync(join(tmpdir(), "reviewer-validation-output-"));
  const stdoutPath = join(outputDirectory, "stdout");
  const stderrPath = join(outputDirectory, "stderr");
  try {
    const result = (() => {
      const stdout = openSync(stdoutPath, "w");
      const stderr = openSync(stderrPath, "w");
      try {
        return spawnSync(command.argv[0], command.argv.slice(1), {
          cwd: projectRoot,
          shell: false,
          timeout: command.timeout_ms,
          stdio: ["ignore", stdout, stderr],
        });
      } finally {
        closeSync(stdout);
        closeSync(stderr);
      }
    })();
    const stdoutSize = statSync(stdoutPath).size;
    const stderrSize = statSync(stderrPath).size;
    const outputOverflow = stdoutSize + stderrSize > command.max_output_bytes;
    const capturedOutput = Buffer.concat([
      readOutputBytes(stdoutPath, command.max_output_bytes),
      readOutputBytes(stderrPath, command.max_output_bytes),
    ]).toString("utf8");
    const output = boundedOutput(capturedOutput, command.max_output_bytes, outputOverflow);
    const error = result.error as NodeJS.ErrnoException | undefined;
    const exitCode = typeof result.status === "number" ? result.status : null;
    const timedOut = error?.code === "ETIMEDOUT";
    let status: ValidationEvidence["status"];
    if (error?.code === "ENOENT") status = "unavailable";
    else if (timedOut || outputOverflow || exitCode !== 0) status = "failed";
    else status = "passed";
    const changed = reviewTargetFingerprint(projectRoot) !== before;
    if (changed) status = "mutated";
    return {
      validation_id: validationId,
      requested_argv: requested,
      executed_argv: command.argv,
      status,
      exit_code: exitCode,
      timed_out: timedOut,
      output,
      working_tree_changed: changed,
    };
  } finally {
    rmSync(outputDirectory, { recursive: true, force: true });
  }
}

export function runReviewerValidation(
  policy: ReviewerValidationPolicy,
  validationId: string,
  requestedArgv: readonly string[],
  projectRoot = PROJECT_ROOT,
): ValidationEvidence {
  return runAuthorizedCommand(policy, validationId, requestedArgv, "validation", projectRoot);
}

export function runReviewerEvidence(
  policy: ReviewerValidationPolicy,
  evidenceId: string,
  requestedArgv: readonly string[],
  projectRoot = PROJECT_ROOT,
): ValidationEvidence {
  return runAuthorizedCommand(
    policy,
    evidenceIdValue(evidenceId),
    requestedArgv,
    "evidence",
    projectRoot,
  );
}

export interface StructuredReviewerEvidenceRequest {
  evidenceId: unknown;
  argv: unknown;
}

function boundedRequestArgv(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 50)
    .filter((argument): argument is string => typeof argument === "string")
    .map((argument) => argument.slice(0, MAX_ARGUMENT_LENGTH));
}

/**
 * Host adapters use this seam so malformed or unauthorized structured requests
 * become bounded evidence instead of an exception or a suggestion to use a
 * shell. The exact policy/argv check remains in runAuthorizedCommand and is
 * performed before fingerprinting or process launch.
 */
export function runStructuredReviewerEvidence(
  request: StructuredReviewerEvidenceRequest,
  projectRoot = PROJECT_ROOT,
): ValidationEvidence {
  const requestedArgv = boundedRequestArgv(request.argv);
  const evidenceId =
    typeof request.evidenceId === "string"
      ? request.evidenceId.slice(0, MAX_EVIDENCE_ID_LENGTH)
      : "unknown-evidence";
  try {
    const validatedEvidenceId = evidenceIdValue(request.evidenceId);
    const validatedArgv = argvValue(request.argv, "requested argv");
    const policy = loadReviewerValidationPolicy(
      resolve(projectRoot, ".codex/reviewer-validation.json"),
    );
    return runReviewerEvidence(policy, validatedEvidenceId, validatedArgv, projectRoot);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      validation_id: evidenceId,
      requested_argv: requestedArgv,
      executed_argv: [],
      status: "failed",
      exit_code: null,
      timed_out: false,
      output: boundedOutput(message, 512),
      working_tree_changed: false,
    };
  }
}

function main(args: readonly string[]): number {
  if (args.length !== 4 || args[0] !== "--validation-id" || args[2] !== "--argv-json") {
    process.stderr.write(
      "Usage: bun .codex/agents/reviewer-validation.ts --validation-id ID --argv-json JSON\n",
    );
    return 2;
  }
  try {
    let requestedArgv: unknown;
    try {
      requestedArgv = JSON.parse(args[3]);
    } catch {
      throw new Error("requested argv JSON is invalid");
    }
    const evidence = runReviewerValidation(
      loadReviewerValidationPolicy(),
      args[1],
      argvValue(requestedArgv, "requested argv"),
    );
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    return evidence.status === "passed" ? 0 : 1;
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.message : String(cause)}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
