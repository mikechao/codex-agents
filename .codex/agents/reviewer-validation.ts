#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
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
const MAX_IGNORED_FINGERPRINT_BYTES = 512 * 1024 * 1024;
const MAX_OPERATION_STATE_BYTES = 4 * 1024 * 1024;
const MAX_OPERATION_STATE_ENTRIES = 512;
const MAX_OPERATION_STATE_DEPTH = 8;
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

class FingerprintCollectionError extends Error {}

function fingerprintError(message: string, cause?: unknown): FingerprintCollectionError {
  return new FingerprintCollectionError(message, { cause });
}

function frame(hash: ReturnType<typeof createHash>, label: string, value: Uint8Array): void {
  const labelBytes = Buffer.from(label, "utf8");
  const lengths = Buffer.allocUnsafe(16);
  lengths.writeBigUInt64BE(BigInt(labelBytes.byteLength), 0);
  lengths.writeBigUInt64BE(BigInt(value.byteLength), 8);
  hash.update(lengths);
  hash.update(labelBytes);
  hash.update(value);
}

function text(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitOutput(projectRoot: string, args: string[], maxBuffer = 2 * MAX_OUTPUT_BYTES): Buffer {
  try {
    return execFileSync("git", ["-C", projectRoot, ...args], {
      cwd: projectRoot,
      encoding: "buffer",
      maxBuffer,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (cause) {
    throw fingerprintError(`git fingerprint query failed: git ${args.join(" ")}`, cause);
  }
}

function decodeUtf8(value: Buffer, context: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (cause) {
    throw fingerprintError(`${context} is not valid UTF-8`, cause);
  }
}

function singleLine(value: Buffer, context: string): string {
  const decoded = decodeUtf8(value, context);
  if (!decoded.endsWith("\n") || decoded.slice(0, -1).includes("\n")) {
    throw fingerprintError(`${context} is malformed`);
  }
  return decoded.slice(0, -1);
}

function nulRecords(value: Buffer, context: string): Buffer[] {
  if (value.byteLength === 0) return [];
  if (value[value.byteLength - 1] !== 0) throw fingerprintError(`${context} is not NUL terminated`);
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.byteLength; index += 1) {
    if (value[index] === 0) {
      records.push(value.subarray(start, index));
      start = index + 1;
    }
  }
  return records;
}

function repositoryRelativePath(projectRoot: string, value: Buffer, context: string): string {
  const relativePath = decodeUtf8(value, context);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("/") ||
    relativePath === "." ||
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.includes("/../") ||
    relativePath.includes("\\")
  ) {
    throw fingerprintError(`${context} contains an unsafe repository-relative path`);
  }
  const root = resolve(projectRoot);
  const absolutePath = resolve(root, relativePath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}/`)) {
    throw fingerprintError(`${context} escapes the repository root`);
  }
  return relativePath;
}

function pathInsideRoot(projectRoot: string, path: string): boolean {
  const root = realpathSync(resolve(projectRoot));
  const candidate = realpathSync(resolve(path));
  return candidate === root || candidate.startsWith(`${root}/`);
}

interface FingerprintBudget {
  remaining: number;
}

function consumeBudget(budget: FingerprintBudget, amount: number, context: string): void {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > budget.remaining) {
    throw fingerprintError(`fingerprint budget exceeded while reading ${context}`);
  }
  budget.remaining -= amount;
}

function stableStat(value: {
  mode: number;
  size: number;
  mtimeMs: number;
  ino: number;
  dev: number;
}): string {
  return [value.mode, value.size, value.mtimeMs, value.ino, value.dev].join(":");
}

function readBoundedFile(
  path: string,
  budget: FingerprintBudget,
  context: string,
  expectedIdentity?: string,
): Buffer {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    throw fingerprintError(`unable to open ${context}`, cause);
  }
  try {
    let initial: ReturnType<typeof fstatSync>;
    try {
      initial = fstatSync(descriptor);
    } catch (cause) {
      throw fingerprintError(`unable to stat ${context}`, cause);
    }
    if (!initial.isFile()) throw fingerprintError(`${context} is not a regular file`);
    if (expectedIdentity !== undefined && stableStat(initial) !== expectedIdentity) {
      throw fingerprintError(`${context} changed before opening`);
    }
    consumeBudget(budget, initial.size, context);
    const output = Buffer.alloc(initial.size);
    let offset = 0;
    while (offset < output.byteLength) {
      let bytesRead: number;
      try {
        bytesRead = readSync(descriptor, output, offset, output.byteLength - offset, offset);
      } catch (cause) {
        throw fingerprintError(`unable to read ${context}`, cause);
      }
      if (bytesRead === 0) throw fingerprintError(`${context} disappeared while reading`);
      offset += bytesRead;
    }
    let final: ReturnType<typeof fstatSync>;
    try {
      final = fstatSync(descriptor);
    } catch (cause) {
      throw fingerprintError(`unable to restat ${context}`, cause);
    }
    if (stableStat(initial) !== stableStat(final))
      throw fingerprintError(`${context} changed while reading`);
    let pathValue: ReturnType<typeof lstatSync>;
    try {
      pathValue = lstatSync(path);
    } catch (cause) {
      throw fingerprintError(`${context} disappeared after reading`, cause);
    }
    if (!pathValue.isFile() || stableStat(pathValue) !== stableStat(initial)) {
      throw fingerprintError(`${context} changed while reading`);
    }
    return output;
  } finally {
    closeSync(descriptor);
  }
}

function addRepositoryFile(
  hash: ReturnType<typeof createHash>,
  projectRoot: string,
  relativePath: string,
  budget: FingerprintBudget,
  context: string,
): void {
  const absolutePath = join(projectRoot, relativePath);
  let initial: ReturnType<typeof lstatSync>;
  try {
    initial = lstatSync(absolutePath);
  } catch (cause) {
    throw fingerprintError(`${context} disappeared`, cause);
  }
  try {
    if (!pathInsideRoot(projectRoot, realpathSync(resolve(absolutePath, "..")))) {
      throw fingerprintError(`${context} has an external parent`);
    }
  } catch (cause) {
    if (cause instanceof FingerprintCollectionError) throw cause;
    throw fingerprintError(`unable to resolve parent of ${context}`, cause);
  }
  const kind = initial.isSymbolicLink()
    ? "symlink"
    : initial.isFile()
      ? "file"
      : initial.isDirectory()
        ? "directory"
        : "other";
  frame(hash, `${context}:kind`, text(kind));
  frame(hash, `${context}:mode`, text(String(initial.mode & 0o111)));
  if (initial.isSymbolicLink()) {
    let target: string;
    try {
      target = readlinkSync(absolutePath, "utf8");
    } catch (cause) {
      throw fingerprintError(`unable to read ${context} symlink`, cause);
    }
    consumeBudget(budget, Buffer.byteLength(target, "utf8"), context);
    frame(hash, `${context}:target`, text(target));
  } else if (initial.isFile()) {
    const bytes = readBoundedFile(absolutePath, budget, context, stableStat(initial));
    frame(hash, `${context}:bytes`, bytes);
  } else {
    throw fingerprintError(`${context} has unsupported file type`);
  }
  let final: ReturnType<typeof lstatSync>;
  try {
    final = lstatSync(absolutePath);
  } catch (cause) {
    throw fingerprintError(`${context} disappeared after reading`, cause);
  }
  if (stableStat(initial) !== stableStat(final)) {
    throw fingerprintError(`${context} changed while fingerprinting`);
  }
}

function addOptionalGitFile(
  hash: ReturnType<typeof createHash>,
  path: string,
  label: string,
  budget: FingerprintBudget,
  allowAbsent = true,
): void {
  let value: ReturnType<typeof lstatSync>;
  try {
    value = lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      if (!allowAbsent) throw fingerprintError(`${label} is missing`, cause);
      frame(hash, `${label}:absent`, Buffer.alloc(0));
      return;
    }
    throw fingerprintError(`unable to inspect ${label}`, cause);
  }
  if (!value.isFile()) throw fingerprintError(`${label} is not a regular file`);
  const bytes = readBoundedFile(path, budget, label, stableStat(value));
  frame(hash, `${label}:present`, bytes);
  let final: ReturnType<typeof lstatSync>;
  try {
    final = lstatSync(path);
  } catch (cause) {
    throw fingerprintError(`${label} disappeared after reading`, cause);
  }
  if (stableStat(value) !== stableStat(final))
    throw fingerprintError(`${label} changed while reading`);
}

interface OperationStateEntry {
  relativePath: string;
  kind: "directory" | "file";
  mode: number;
  path: string;
  identity: string;
}

function collectOperationStateEntries(
  root: string,
  relativePath: string,
  depth: number,
  entries: OperationStateEntry[],
): void {
  if (depth > MAX_OPERATION_STATE_DEPTH) {
    throw fingerprintError(`operation state exceeds bounded depth: ${relativePath}`);
  }
  let names: string[];
  try {
    names = readdirSync(join(root, relativePath)).sort(compareStrings);
  } catch (cause) {
    throw fingerprintError(`unable to enumerate operation state directory ${relativePath}`, cause);
  }
  for (const name of names) {
    if (name.length === 0 || name === "." || name === ".." || name.includes("/")) {
      throw fingerprintError(
        `operation state contains an unsafe entry name: ${relativePath}/${name}`,
      );
    }
    if (entries.length >= MAX_OPERATION_STATE_ENTRIES) {
      throw fingerprintError("operation state entry limit exceeded");
    }
    const childRelativePath = relativePath === "." ? name : `${relativePath}/${name}`;
    const childPath = join(root, childRelativePath);
    let value: ReturnType<typeof lstatSync>;
    try {
      value = lstatSync(childPath);
    } catch (cause) {
      throw fingerprintError(`unable to inspect operation state entry ${childRelativePath}`, cause);
    }
    if (value.isSymbolicLink()) {
      throw fingerprintError(`operation state entry ${childRelativePath} is a symlink`);
    }
    const kind = value.isDirectory() ? "directory" : value.isFile() ? "file" : "other";
    if (kind === "other") {
      throw fingerprintError(`operation state entry ${childRelativePath} has unsupported type`);
    }
    entries.push({
      relativePath: childRelativePath,
      kind,
      mode: value.mode & 0o111,
      path: childPath,
      identity: stableStat(value),
    });
    if (kind === "directory") {
      collectOperationStateEntries(root, childRelativePath, depth + 1, entries);
      let final: ReturnType<typeof lstatSync>;
      try {
        final = lstatSync(childPath);
      } catch (cause) {
        throw fingerprintError(
          `operation state directory ${childRelativePath} disappeared while traversing`,
          cause,
        );
      }
      if (!final.isDirectory() || stableStat(value) !== stableStat(final)) {
        throw fingerprintError(
          `operation state directory ${childRelativePath} changed while traversing`,
        );
      }
    }
  }
}

function addOptionalGitDirectory(
  hash: ReturnType<typeof createHash>,
  path: string,
  label: string,
  budget: FingerprintBudget,
): void {
  let value: ReturnType<typeof lstatSync>;
  try {
    value = lstatSync(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      frame(hash, `${label}:absent`, Buffer.alloc(0));
      return;
    }
    throw fingerprintError(`unable to inspect ${label}`, cause);
  }
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw fingerprintError(`${label} is not a regular directory`);
  }
  frame(hash, `${label}:present`, text("directory"));
  const entries: OperationStateEntry[] = [];
  collectOperationStateEntries(path, ".", 0, entries);
  entries.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  frame(hash, `${label}:count`, text(String(entries.length)));
  for (const entry of entries) {
    consumeBudget(
      budget,
      Buffer.byteLength(entry.relativePath, "utf8"),
      `${label}/${entry.relativePath}`,
    );
    frame(hash, `${label}:entry`, text(`${entry.relativePath}\0${entry.kind}\0${entry.mode}`));
    if (entry.kind === "file") {
      frame(
        hash,
        `${label}:content:${entry.relativePath}`,
        readBoundedFile(entry.path, budget, `${label}/${entry.relativePath}`, entry.identity),
      );
    }
  }
  let final: ReturnType<typeof lstatSync>;
  try {
    final = lstatSync(path);
  } catch (cause) {
    throw fingerprintError(`${label} disappeared after reading`, cause);
  }
  if (stableStat(value) !== stableStat(final)) {
    throw fingerprintError(`${label} changed while fingerprinting`);
  }
}

function addOperationState(hash: ReturnType<typeof createHash>, projectRoot: string): void {
  const budget = { remaining: MAX_OPERATION_STATE_BYTES };
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "BISECT_START",
    "BISECT_TERMS",
    "BISECT_EXPECTED_REV",
    "BISECT_LOG",
  ]) {
    const path = decodeGitPath(
      projectRoot,
      gitOutput(projectRoot, ["rev-parse", "--git-path", marker]),
      `operation-state path ${marker}`,
    );
    addOptionalGitFile(hash, path, `operation-state:${marker}`, budget);
  }
  for (const directory of ["sequencer", "rebase-merge", "rebase-apply"]) {
    const path = decodeGitPath(
      projectRoot,
      gitOutput(projectRoot, ["rev-parse", "--git-path", directory]),
      `operation-state path ${directory}`,
    );
    addOptionalGitDirectory(hash, path, `operation-state:${directory}`, budget);
  }
}

function addIgnoredFiles(hash: ReturnType<typeof createHash>, projectRoot: string): void {
  const records = nulRecords(
    gitOutput(projectRoot, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"]),
    "ignored-file listing",
  );
  const paths = records
    .map((record, index) =>
      repositoryRelativePath(projectRoot, record, `ignored-file listing entry ${index}`),
    )
    .sort();
  const budget = { remaining: MAX_IGNORED_FINGERPRINT_BYTES };
  frame(hash, "ignored:count", text(String(paths.length)));
  for (const relativePath of paths) {
    consumeBudget(budget, Buffer.byteLength(relativePath, "utf8"), `ignored file ${relativePath}`);
    addRepositoryFile(hash, projectRoot, relativePath, budget, `ignored file ${relativePath}`);
  }
}

function addIndex(hash: ReturnType<typeof createHash>, projectRoot: string): void {
  const records = nulRecords(
    gitOutput(projectRoot, ["ls-files", "--stage", "-v", "-z"]),
    "index listing",
  );
  const normalized = records.map((record, index) => {
    const separator = record.indexOf(9);
    if (separator <= 0 || separator === record.byteLength - 1) {
      throw fingerprintError(`index listing entry ${index} is malformed`);
    }
    const header = decodeUtf8(record.subarray(0, separator), `index listing entry ${index}`);
    if (!/^[HhSMRCK?U] [0-7]{6} [0-9a-f]{40,64} [0-3]$/u.test(header)) {
      throw fingerprintError(`index listing entry ${index} has an invalid header`);
    }
    const relativePath = repositoryRelativePath(
      projectRoot,
      record.subarray(separator + 1),
      `index listing entry ${index}`,
    );
    return { header, relativePath };
  });
  normalized.sort((left, right) =>
    compareStrings(
      `${left.relativePath}\0${left.header}`,
      `${right.relativePath}\0${right.header}`,
    ),
  );
  frame(hash, "index:count", text(String(normalized.length)));
  for (const entry of normalized)
    frame(hash, "index:entry", text(`${entry.header}\0${entry.relativePath}`));
}

function addHead(hash: ReturnType<typeof createHash>, projectRoot: string): void {
  let symbolic = "";
  try {
    symbolic = singleLine(
      gitOutput(projectRoot, ["symbolic-ref", "-q", "HEAD"]),
      "HEAD symbolic state",
    );
  } catch (cause) {
    const error = cause as FingerprintCollectionError & {
      cause?: { status?: number; stdout?: Buffer };
    };
    const details = error.cause;
    if (details?.status !== 1 || details.stdout?.byteLength !== 0) throw cause;
  }
  if (symbolic !== "" && !/^refs\/[A-Za-z0-9._/-]+$/u.test(symbolic)) {
    throw fingerprintError("HEAD symbolic state is malformed");
  }
  const identity = singleLine(
    gitOutput(projectRoot, ["rev-parse", "--verify", "HEAD"]),
    "HEAD identity",
  );
  if (!/^[0-9a-f]{40,64}$/u.test(identity)) {
    throw fingerprintError("verified HEAD identity is malformed");
  }
  frame(hash, "HEAD:state", text(symbolic === "" ? "detached" : `symbolic:${symbolic}`));
  frame(hash, "HEAD:identity", text(identity));
}

function addRefs(hash: ReturnType<typeof createHash>, projectRoot: string): void {
  const output = gitOutput(projectRoot, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)%00",
  ]);
  if (output.byteLength === 0) {
    frame(hash, "refs:count", text("0"));
    return;
  }
  const parts = decodeUtf8(output, "ref listing").split("\0");
  if (parts.length < 4 || parts[parts.length - 1] !== "\n") {
    throw fingerprintError("ref listing is malformed");
  }
  const refs: Array<{ name: string; object: string; symref: string }> = [];
  for (let index = 0; index < parts.length - 1; index += 3) {
    const name = index === 0 ? parts[index] : parts[index].replace(/^\n/u, "");
    const object = parts[index + 1];
    const symref = parts[index + 2];
    if (
      name === undefined ||
      object === undefined ||
      symref === undefined ||
      index + 3 >= parts.length
    ) {
      throw fingerprintError("ref listing is malformed");
    }
    if (!/^refs\/[A-Za-z0-9._/-]+$/u.test(name) || !/^[0-9a-f]{40,64}$/u.test(object)) {
      throw fingerprintError("ref listing contains malformed state");
    }
    if (symref !== "" && !/^refs\/[A-Za-z0-9._/-]+$/u.test(symref)) {
      throw fingerprintError("ref listing contains malformed symbolic state");
    }
    refs.push({ name, object, symref });
  }
  refs.sort((left, right) =>
    compareStrings(
      `${left.name}\0${left.object}\0${left.symref}`,
      `${right.name}\0${right.object}\0${right.symref}`,
    ),
  );
  frame(hash, "refs:count", text(String(refs.length)));
  for (const ref of refs)
    frame(hash, "refs:entry", text(`${ref.name}\0${ref.object}\0${ref.symref}`));
}

function addLocalConfig(
  hash: ReturnType<typeof createHash>,
  projectRoot: string,
  budget: FingerprintBudget,
): void {
  const records = nulRecords(
    gitOutput(projectRoot, ["config", "--local", "--no-includes", "--null", "--list"]),
    "local config listing",
  );
  const entries = records.map((record, index) => {
    const separator = record.indexOf(10);
    if (separator <= 0) throw fingerprintError(`local config entry ${index} is malformed`);
    return decodeUtf8(record, `local config entry ${index}`);
  });
  entries.sort(compareStrings);
  frame(hash, "local-config:count", text(String(entries.length)));
  for (const entry of entries) frame(hash, "local-config:entry", text(entry));

  const configPath = decodeGitPath(
    projectRoot,
    gitOutput(projectRoot, ["rev-parse", "--git-path", "config"]),
    "local config path",
  );
  const worktreeConfigPath = decodeGitPath(
    projectRoot,
    gitOutput(projectRoot, ["rev-parse", "--git-path", "config.worktree"]),
    "worktree config path",
  );
  addOptionalGitFile(hash, configPath, "local-config:file", budget, false);
  if (worktreeConfigPath !== configPath) {
    addOptionalGitFile(hash, worktreeConfigPath, "local-config:worktree-file", budget);
  }
}

function decodeGitPath(projectRoot: string, value: Buffer, context: string): string {
  const path = singleLine(value, context);
  if (path.length === 0 || path.includes("\0")) throw fingerprintError(`${context} is malformed`);
  return resolve(projectRoot, path);
}

function addIgnoreControl(
  hash: ReturnType<typeof createHash>,
  projectRoot: string,
  budget: FingerprintBudget,
): void {
  const excludePath = decodeGitPath(
    projectRoot,
    gitOutput(projectRoot, ["rev-parse", "--git-path", "info/exclude"]),
    "repository ignore path",
  );
  addOptionalGitFile(hash, excludePath, "repository-ignore", budget);
}

export function reviewTargetFingerprint(projectRoot = PROJECT_ROOT): string {
  const hash = createHash("sha256");
  frame(
    hash,
    "status",
    gitOutput(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  );
  frame(hash, "tracked-diff", gitOutput(projectRoot, ["diff", "--binary", "HEAD", "--"]));
  const untracked = nulRecords(
    gitOutput(projectRoot, ["ls-files", "--others", "--exclude-standard", "-z"]),
    "untracked-file listing",
  );
  const untrackedPaths = untracked
    .map((record, index) =>
      repositoryRelativePath(projectRoot, record, `untracked-file listing entry ${index}`),
    )
    .sort();
  frame(hash, "untracked:count", text(String(untrackedPaths.length)));
  const untrackedBudget = { remaining: MAX_IGNORED_FINGERPRINT_BYTES };
  for (const relativePath of untrackedPaths) {
    consumeBudget(
      untrackedBudget,
      Buffer.byteLength(relativePath, "utf8"),
      `untracked file ${relativePath}`,
    );
    addRepositoryFile(
      hash,
      projectRoot,
      relativePath,
      untrackedBudget,
      `untracked file ${relativePath}`,
    );
  }
  addIgnoredFiles(hash, projectRoot);
  addIndex(hash, projectRoot);
  addHead(hash, projectRoot);
  addRefs(hash, projectRoot);
  addOperationState(hash, projectRoot);
  const controlBudget = { remaining: MAX_IGNORED_FINGERPRINT_BYTES };
  addLocalConfig(hash, projectRoot, controlBudget);
  addIgnoreControl(hash, projectRoot, controlBudget);
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
  let before: string;
  try {
    before = reviewTargetFingerprint(projectRoot);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return {
      validation_id: validationId,
      requested_argv: requested,
      executed_argv: [],
      status: "failed",
      exit_code: null,
      timed_out: false,
      output: boundedOutput(`fingerprint collection failed before launch: ${message}`, 512),
      working_tree_changed: false,
    };
  }
  const outputDirectory = mkdtempSync(join(tmpdir(), "reviewer-validation-output-"));
  const stdoutPath = join(outputDirectory, "stdout");
  const stderrPath = join(outputDirectory, "stderr");
  try {
    let exitCode: number | null = null;
    let timedOut = false;
    let unavailable = false;
    let output = "";
    let executionFailure: string | undefined;
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
      output = boundedOutput(capturedOutput, command.max_output_bytes, outputOverflow);
      const error = result.error as NodeJS.ErrnoException | undefined;
      exitCode = typeof result.status === "number" ? result.status : null;
      timedOut = error?.code === "ETIMEDOUT";
      unavailable = error?.code === "ENOENT";
      if (timedOut || outputOverflow || exitCode !== 0) executionFailure = "command failed";
    } catch (cause) {
      executionFailure = cause instanceof Error ? cause.message : String(cause);
      output = boundedOutput(executionFailure, command.max_output_bytes);
    }

    let after: string;
    try {
      after = reviewTargetFingerprint(projectRoot);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return {
        validation_id: validationId,
        requested_argv: requested,
        executed_argv: command.argv,
        status: "failed",
        exit_code: exitCode,
        timed_out: timedOut,
        output: boundedOutput(
          `${output}\nfingerprint collection failed after launch: ${message}`,
          command.max_output_bytes,
        ),
        working_tree_changed: false,
      };
    }
    const changed = after !== before;
    let status: ValidationEvidence["status"];
    if (changed) status = "mutated";
    else if (unavailable) status = "unavailable";
    else if (executionFailure !== undefined) status = "failed";
    else status = "passed";
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
