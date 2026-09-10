import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceipt } from "../../agents/receipt.js";

type Git = (...args: string[]) => string;
type Receipt = ReturnType<typeof createReceipt>;
let template: string | undefined;
let emptyTemplatePath: string | undefined;

export interface FixtureDiagnosticContext {
  stage: string;
  operation: string;
  cleanupStarted: boolean;
  child?: {
    pid?: number;
    role: string;
    live: boolean;
    killed: boolean;
    exitCode: number | null;
    signalCode: string | null;
  };
}

export function fixtureDiagnostic(root: string, context: FixtureDiagnosticContext): string {
  const detail = JSON.stringify({
    repository_root: root,
    stage: context.stage,
    operation: context.operation,
    cleanup_started: context.cleanupStarted,
    ...(context.child ? { child: context.child } : {}),
  });
  return `fixture diagnostic: ${detail.slice(0, 1_000)}`;
}

export function annotateFixtureFailure(
  error: unknown,
  root: string,
  context: FixtureDiagnosticContext,
): unknown {
  const candidate = error as { message?: unknown; stderr?: unknown };
  const stderr =
    typeof candidate.stderr === "string"
      ? candidate.stderr
      : Buffer.isBuffer(candidate.stderr)
        ? candidate.stderr.toString("utf8")
        : "";
  const detail = `${typeof candidate.message === "string" ? candidate.message : ""} ${stderr}`;
  if (!detail.includes("ERROR_NO_HEAD")) return error;
  const diagnostic = fixtureDiagnostic(root, context);
  if (error instanceof Error) error.message = `${error.message}; ${diagnostic}`;
  if (typeof candidate.stderr === "string") candidate.stderr = `${candidate.stderr}\n${diagnostic}`;
  if (Buffer.isBuffer(candidate.stderr)) candidate.stderr = Buffer.from(`${stderr}\n${diagnostic}`);
  return error;
}

function runGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixtureTemplate(): string {
  if (template) return template;
  template = mkdtempSync(join(tmpdir(), "workflow-template-"));
  runGit(template, "init", "-q");
  runGit(template, "config", "user.email", "workflow@example.invalid");
  runGit(template, "config", "user.name", "Workflow Tests");
  writeFileSync(join(template, "note.txt"), "before\n");
  mkdirSync(join(template, ".codex", "agents"), { recursive: true });
  cpSync(
    join(process.cwd(), ".codex", "reviewer-validation.json"),
    join(template, ".codex", "reviewer-validation.json"),
  );
  cpSync(
    join(process.cwd(), ".codex", "agents", "change-receipt.ts"),
    join(template, ".codex", "agents", "change-receipt.ts"),
  );
  runGit(template, "add", ".");
  runGit(template, "commit", "-qm", "fixture");
  return template;
}

function emptyFixtureTemplate(): string {
  if (emptyTemplatePath) return emptyTemplatePath;
  emptyTemplatePath = mkdtempSync(join(tmpdir(), "workflow-empty-template-"));
  runGit(emptyTemplatePath, "init", "-q");
  runGit(emptyTemplatePath, "config", "user.email", "workflow@example.invalid");
  runGit(emptyTemplatePath, "config", "user.name", "Workflow Tests");
  runGit(emptyTemplatePath, "commit", "--allow-empty", "-qm", "fixture");
  return emptyTemplatePath;
}

export interface Fixture {
  root: string;
  git: Git;
}

export function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-state-")));
  cpSync(fixtureTemplate(), root, { recursive: true });
  let cachedHead: string | undefined;
  const git = (...args: string[]) => {
    if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" && cachedHead) {
      return cachedHead;
    }
    try {
      const result = runGit(root, ...args);
      cachedHead =
        args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" ? result : undefined;
      return result;
    } catch (error) {
      throw annotateFixtureFailure(error, root, {
        stage: "fixture git operation",
        operation: args.join(" "),
        cleanupStarted: false,
      });
    }
  };
  return { root, git };
}

export function emptyFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-empty-")));
  cpSync(emptyFixtureTemplate(), root, { recursive: true });
  let cachedHead: string | undefined;
  const git = (...args: string[]) => {
    if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" && cachedHead) {
      return cachedHead;
    }
    try {
      const result = runGit(root, ...args);
      cachedHead =
        args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" ? result : undefined;
      return result;
    } catch (error) {
      throw annotateFixtureFailure(error, root, {
        stage: "empty fixture git operation",
        operation: args.join(" "),
        cleanupStarted: false,
      });
    }
  };
  return { root, git };
}

export function disposeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function receipt(root: string, paths: string[] = ["note.txt"]): Receipt {
  return createReceipt(paths, root);
}

export function absentReceipt(root: string, paths: string[]): Receipt {
  return createReceipt(paths, root, { allowAbsent: true });
}
