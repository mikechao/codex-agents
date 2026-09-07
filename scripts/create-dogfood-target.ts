#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const FIXTURE = "# Disposable dogfood target\n\nThis repository is a neutral installer target.\n";
const MAX_OUTPUT = 4_096;

interface SourceProvenance {
  checkout: string;
  head: string;
  state: "clean" | "dirty";
}

function outputOf(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const candidate = value as { stderr?: string | Buffer; stdout?: string | Buffer };
  const stderr = candidate.stderr === undefined ? "" : String(candidate.stderr);
  const stdout = candidate.stdout === undefined ? "" : String(candidate.stdout);
  return `${stderr}\n${stdout}`.trim().slice(0, MAX_OUTPUT);
}

function commandError(command: string, args: readonly string[], cause: unknown): Error {
  const details = outputOf(cause);
  const rendered = [command, ...args].join(" ");
  return new Error(`${rendered} failed${details.length === 0 ? "" : `: ${details}`}`, { cause });
}

function run(command: string, args: readonly string[], cwd: string): string {
  try {
    return String(
      execFileSync(command, [...args], {
        cwd,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (cause) {
    throw commandError(command, args, cause);
  }
}

function git(target: string, args: readonly string[]): string {
  return run("git", ["-C", target, ...args], target).trim();
}

function sourceProvenance(): SourceProvenance {
  const scriptCheckout = realpathSync(resolve(import.meta.dir, ".."));
  const checkout = realpathSync(git(scriptCheckout, ["rev-parse", "--show-toplevel"]));
  const head = git(checkout, ["rev-parse", "HEAD"]);
  const status = git(checkout, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return { checkout, head, state: status.length === 0 ? "clean" : "dirty" };
}

function existingPath(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
      return false;
    }
    throw cause;
  }
}

function targetPath(argument: string | undefined): string {
  if (argument === undefined)
    return realpathSync(mkdtempSync(join(tmpdir(), "codex-agents-dogfood-")));

  const target = resolve(argument);
  if (existingPath(target)) {
    const stats = lstatSync(target);
    if (stats.isSymbolicLink()) throw new Error(`Refusing an unsafe symlink target: ${target}`);
    if (!stats.isDirectory()) throw new Error(`Target is not a directory: ${target}`);
  } else {
    mkdirSync(target, { recursive: true });
  }

  const stats = lstatSync(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Refusing an unsafe target path: ${target}`);
  }
  if (readdirSync(target).length !== 0) {
    throw new Error(`Target directory is not empty: ${target}`);
  }
  return realpathSync(target);
}

function commit(target: string, message: string): string {
  try {
    git(target, ["add", "--all"]);
    git(target, ["-c", "user.useConfigOnly=true", "commit", "-m", message]);
    return git(target, ["rev-parse", "HEAD"]);
  } catch (cause) {
    throw new Error(
      `Unable to create ${message} checkpoint: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
      },
    );
  }
}

function setup(target: string, source: SourceProvenance): { baseline: string; installed: string } {
  git(target, ["init", "-q"]);
  writeFileSync(resolve(target, "README.md"), FIXTURE);
  const baseline = commit(target, "dogfood baseline");

  try {
    run("bun", [resolve(source.checkout, "install-into.ts"), target], source.checkout);
  } catch (cause) {
    throw new Error(
      `Normal installer failed; no installed checkpoint was created: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }

  const installed = commit(target, "dogfood installed snapshot");
  const status = git(target, ["status", "--short", "--untracked-files=all"]);
  if (status.length !== 0) {
    throw new Error(`Installed target worktree is not clean: ${status.slice(0, MAX_OUTPUT)}`);
  }
  return { baseline, installed };
}

function usage(): number {
  process.stderr.write("Usage: bun scripts/create-dogfood-target.ts [target-directory]\n");
  return 2;
}

export function main(args: readonly string[]): number {
  if (args.length > 1) return usage();

  let target: string | undefined;
  try {
    const source = sourceProvenance();
    target = targetPath(args[0]);
    const checkpoints = setup(target, source);
    process.stdout.write(`Target: ${target}\n`);
    process.stdout.write(`Source checkout: ${source.checkout}\n`);
    process.stdout.write(`Source HEAD: ${source.head}\n`);
    process.stdout.write(`Source state: ${source.state}\n`);
    process.stdout.write(`Baseline target commit: ${checkpoints.baseline}\n`);
    process.stdout.write(`Installed target commit: ${checkpoints.installed}\n`);
    process.stdout.write(
      "Notice: The installed target contains a standalone local Workflow MCP executable; Bun is needed for installation, while Git, SQLite state, and normal OS facilities remain runtime dependencies.\n",
    );
    return 0;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Dogfood target setup failed: ${message}\n`);
    if (target !== undefined) process.stderr.write(`Target retained at: ${target}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
