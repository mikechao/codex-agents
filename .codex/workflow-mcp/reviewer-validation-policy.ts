import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_POLICY_PATH = resolve(import.meta.dir, "../reviewer-validation.json");
export const MAX_OUTPUT_BYTES = 1_048_576;
export const MAX_ARGUMENT_LENGTH = 4096;
const MAX_TIMEOUT_MS = 300_000;
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

function boundedInteger(value: unknown, context: string, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`${context} must be an integer between 1 and ${maximum}`);
  }
  return value as number;
}

export function argvValue(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 50) {
    throw new Error(`${context} must be a non-empty array`);
  }
  return value.map((argument, index) => stringValue(argument, `${context}[${index}]`));
}

export function sameArgv(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

export function findReviewerValidationCommand(
  policy: ReviewerValidationPolicy,
  requestedArgv: readonly string[],
): ReviewerValidationCommand | undefined {
  return policy.commands.find(
    (candidate) => candidate.purpose === "validation" && sameArgv(candidate.argv, requestedArgv),
  );
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
