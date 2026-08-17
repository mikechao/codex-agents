import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceipt } from "../../agents/receipt.js";

type Git = (...args: string[]) => string;
type Receipt = ReturnType<typeof createReceipt>;
let template: string | undefined;
let emptyTemplatePath: string | undefined;

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
    const result = runGit(root, ...args);
    cachedHead =
      args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" ? result : undefined;
    return result;
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
    const result = runGit(root, ...args);
    cachedHead =
      args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" ? result : undefined;
    return result;
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
