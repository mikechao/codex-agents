import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { createReceipt as createInProcessReceipt } from "../agents/change-receipt.js";
import { fail, WorkflowError } from "./errors.js";
import type {
  ChangeReceipt,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitRangeReviewTarget,
  ContentDigest,
  DirtyScopeAdoptionIndexState,
  ErrorCategory,
  ExactRepoPath,
  GitBlobSha,
  GitCommitSha,
  GitFileMode,
  GitTreeEntry,
  GitTreeSha,
  RangePathKind,
  ReviewRange,
  WorkflowState,
  WorktreeEntry,
  WorktreeLookup,
  WorktreePlan,
  WorktreeValidationIssue,
  WorktreeValidationResult,
} from "./types.js";
import {
  canonicalJson,
  exactPaths,
  worktreePlan as pureWorktreePlan,
  worktreeValidationResult,
} from "./validation.js";

const MAX_GIT_DETAIL = 500;
const MAX_TEXTUAL_OUTPUT = 4 * 1024 * 1024;
const REVIEW_RANGE_CONCURRENCY = 4;

// Loading the CommonJS entry is intentional: Bun's ESM interop exposes the `debug` dependency's
// default export as undefined, while the library's CJS entry preserves its logger contract.
const require = createRequire(import.meta.url);
const simpleGitFactory = require("simple-git").simpleGit as (
  root: string,
  options?: Record<string, unknown>,
) => { raw: (args: string[]) => Promise<string> };

/**
 * Migration boundary: async raw simple-git is used for repository/worktree/ref planning queries.
 * Existing receipt, index, commit and range exports retain their synchronous contracts because
 * their SQLite callers and runtime-artifact compatibility paths are synchronous; their argv and
 * NUL parsing remain explicit and fail-closed. Binary blob reads intentionally remain Node's
 * Buffer-producing execFileSync path (see blobDigest).
 */

// simple-git is intentionally instantiated here and nowhere else in production code. The
// adapter keeps its response types private and normalizes all values before returning them.
function asyncGit(root: string) {
  return simpleGitFactory(root, {
    maxConcurrentProcesses: 4,
    trimmed: false,
  });
}

function translatedGitError(error: unknown, stderr = ""): never {
  const message = stderr || (error instanceof Error ? error.message : "git operation failed");
  const detail = message.replace(/\s+/gu, " ").trim().slice(0, MAX_GIT_DETAIL);
  fail("ERROR_GIT", detail || "git operation failed");
}

async function rawGit(root: string, args: readonly string[]): Promise<string> {
  const output = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, ...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_TEXTUAL_OUTPUT,
        shell: false,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject({ error, stderr: typeof stderr === "string" ? stderr : "" });
          return;
        }
        resolve({
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
        });
      },
    );
  }).catch(({ error, stderr }: { error: unknown; stderr: string }) => {
    if (error instanceof WorkflowError) throw error;
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      fail("ERROR_GIT_SIZE", "git output is too large");
    }
    translatedGitError(error, stderr);
  });
  if (output.stdout.length > MAX_TEXTUAL_OUTPUT) fail("ERROR_GIT_SIZE", "git output is too large");
  return output.stdout;
}

async function predicateGit(root: string, args: readonly string[]): Promise<boolean> {
  try {
    await asyncGit(root).raw([...args]);
    return true;
  } catch {
    return false;
  }
}

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      lstatSync(current);
      try {
        const resolvedCurrent = realpathSync(current);
        if (missing.length > 0 && !lstatSync(resolvedCurrent).isDirectory()) {
          fail("ERROR_PATH_ACCESS", "worktree path contains a non-directory ancestor");
        }
        return resolve(resolvedCurrent, ...missing);
      } catch (error) {
        // A dangling final symlink is occupied, but an unresolved symlink in an
        // ancestor makes the candidate path unavailable and potentially ambiguous.
        if (missing.length === 0) {
          const parent = dirname(current);
          return resolve(realpathSync(parent), current.slice(parent.length + 1));
        }
        const detail =
          error instanceof Error
            ? error.message.replace(/\s+/gu, " ").trim().slice(0, MAX_GIT_DETAIL)
            : "worktree path could not be resolved";
        fail("ERROR_PATH_ACCESS", detail || "worktree path could not be resolved");
      }
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
        const detail =
          error instanceof Error
            ? error.message.replace(/\s+/gu, " ").trim().slice(0, MAX_GIT_DETAIL)
            : "worktree path could not be inspected";
        fail("ERROR_PATH_ACCESS", detail || "worktree path could not be inspected");
      }
    }
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(current.slice(parent.length + 1));
    current = parent;
  }
}

function canonicalWorktreePath(root: string, path: string): string {
  return canonicalPath(isAbsolute(path) ? path : resolve(root, path));
}

export function worktreePathExists(path: string): boolean {
  try {
    // lstatSync deliberately does not follow the final component: a dangling symlink is
    // still an occupied candidate path and must not pass plan-time availability checks.
    lstatSync(resolve(path));
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return false;
    const detail =
      error instanceof Error
        ? error.message.replace(/\s+/gu, " ").trim().slice(0, MAX_GIT_DETAIL)
        : "worktree path could not be inspected";
    fail("ERROR_PATH_ACCESS", detail || "worktree path could not be inspected");
  }
}

function normalizedBranch(value: string): string {
  if (!value.startsWith("refs/heads/")) fail("ERROR_GIT", "worktree branch ref is unsupported");
  const branch = value.slice("refs/heads/".length);
  if (
    !branch ||
    branch === "@" ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch
      .split("/")
      .some(
        (segment) => segment.startsWith(".") || segment.endsWith(".") || segment.endsWith(".lock"),
      ) ||
    branch.includes("@{") ||
    [...branch].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        (codePoint !== undefined && codePoint <= 0x20) ||
        codePoint === 0x7f ||
        "~^:?*[\\".includes(character)
      );
    })
  )
    fail("ERROR_GIT", "worktree branch ref is malformed");
  return branch;
}

/** Parse Git's porcelain worktree format without retaining a library result object. */
export function parseWorktreePorcelain(output: string): WorktreeEntry[] {
  if (typeof output !== "string") fail("ERROR_GIT", "worktree output is invalid");
  const result: WorktreeEntry[] = [];
  for (const rawRecord of output.split(/\r?\n\r?\n/gu)) {
    if (!rawRecord.trim()) continue;
    let path: string | undefined;
    let head: string | null | undefined;
    let branch: string | null | undefined;
    let bare = false;
    let detached = false;
    let locked = false;
    let prunable = false;
    const seen = new Set<string>();
    for (const line of rawRecord.split(/\r?\n/gu)) {
      if (!line) continue;
      const match = /^(worktree|HEAD|branch|bare|detached|locked|prunable)(?: (.*))?$/u.exec(line);
      if (!match) fail("ERROR_GIT", "worktree porcelain contains unknown metadata");
      const key = match[1];
      const value = match[2] ?? "";
      if (seen.has(key)) fail("ERROR_GIT", "worktree porcelain contains duplicate metadata");
      seen.add(key);
      switch (key) {
        case "worktree":
          if (!value || !isAbsolute(value) || value.includes("\0"))
            fail("ERROR_GIT", "worktree path is missing or malformed");
          path = canonicalPath(value);
          break;
        case "HEAD":
          if (!/^(?:[0-9a-f]{40}|0{40})$/u.test(value))
            fail("ERROR_GIT", "worktree HEAD is malformed");
          head = value === "0".repeat(40) ? null : (value as GitCommitSha);
          break;
        case "branch":
          branch = normalizedBranch(value);
          break;
        case "bare":
          if (value) fail("ERROR_GIT", "bare metadata is malformed");
          bare = true;
          break;
        case "detached":
          if (value) fail("ERROR_GIT", "detached metadata is malformed");
          detached = true;
          break;
        case "locked":
          locked = true;
          break;
        case "prunable":
          prunable = true;
          break;
      }
    }
    if (!path || (head === undefined && !bare)) fail("ERROR_GIT", "worktree record is incomplete");
    const hasBranchState = branch !== null && branch !== undefined;
    if (!bare && hasBranchState === detached)
      fail("ERROR_GIT", "worktree record ref state is incomplete");
    if (branch !== null && branch !== undefined && (detached || bare))
      fail("ERROR_GIT", "worktree metadata is contradictory");
    if (bare && detached) fail("ERROR_GIT", "worktree metadata is contradictory");
    const normalizedHead = (head ?? null) as GitCommitSha | null;
    result.push({
      path,
      head: normalizedHead,
      branch: branch ?? null,
      bare,
      detached,
      locked,
      prunable,
    });
  }
  const paths = new Set(result.map((entry) => entry.path));
  if (paths.size !== result.length) fail("ERROR_GIT", "worktree paths are ambiguous");
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export async function listWorktrees(root: string): Promise<WorktreeEntry[]> {
  return parseWorktreePorcelain(await rawGit(root, ["worktree", "list", "--porcelain"]));
}

export async function findWorktreeByPath(root: string, path: string): Promise<WorktreeLookup> {
  const wanted = canonicalWorktreePath(root, path);
  const worktree = (await listWorktrees(root)).find((entry) => entry.path === wanted) ?? null;
  return { found: worktree !== null, worktree };
}

export async function findWorktreeByBranch(root: string, branch: string): Promise<WorktreeLookup> {
  const normalized = branch.startsWith("refs/heads/") ? normalizedBranch(branch) : branch;
  const worktree = (await listWorktrees(root)).find((entry) => entry.branch === normalized) ?? null;
  return { found: worktree !== null, worktree };
}

export async function getMainWorktree(root: string): Promise<WorktreeEntry> {
  const entries = await listWorktrees(root);
  const common = canonicalPath(
    resolve(root, (await rawGit(root, ["rev-parse", "--git-common-dir"])).trim()),
  );
  const expected = common.endsWith(`${sep}.git`) ? dirname(common) : common;
  const result = entries.find((entry) => entry.path === expected);
  if (!result) fail("ERROR_GIT", "main worktree could not be identified");
  return result;
}

export async function findCurrentWorktree(root: string): Promise<WorktreeEntry | null> {
  const current = canonicalPath(root);
  const entries = await listWorktrees(root);
  return (
    entries
      .filter((entry) => current === entry.path || current.startsWith(`${entry.path}${sep}`))
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  );
}

export async function isMainWorktree(root: string, path = root): Promise<boolean> {
  return (await getMainWorktree(root)).path === canonicalWorktreePath(root, path);
}

export async function isCurrentWorktree(root: string, path = root): Promise<boolean> {
  const current = await findCurrentWorktree(root);
  return current !== null && current.path === canonicalWorktreePath(root, path);
}

export async function verifyBranchName(
  root: string,
  branch: string,
): Promise<WorktreeValidationResult> {
  const issues: WorktreeValidationIssue[] = [];
  if (!branch || branch.includes("\0") || branch.startsWith("-")) {
    issues.push({ category: "invalid_branch", field: "branch", detail: "branch name is invalid" });
  } else if (!(await predicateGit(root, ["check-ref-format", "--branch", branch]))) {
    issues.push({ category: "invalid_branch", field: "branch", detail: "branch name is invalid" });
  }
  return worktreeValidationResult(issues);
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  if (!(await verifyBranchName(root, branch)).valid) return false;
  const expectedRef = `refs/heads/${branch}`;
  try {
    const output = await rawGit(root, ["show-ref", "--verify", "--", expectedRef]);
    const separator = output.indexOf(" ");
    if (separator < 0) return false;
    const object = output.slice(0, separator);
    const refWithTerminator = output.slice(separator + 1);
    const ref = refWithTerminator.endsWith("\n")
      ? refWithTerminator.slice(0, -1)
      : refWithTerminator;
    return (
      /^[0-9a-f]{40}$/u.test(object) &&
      ref === expectedRef &&
      (refWithTerminator === expectedRef || refWithTerminator === `${expectedRef}\n`)
    );
  } catch {
    return false;
  }
}

/** True when a new local branch with this name may be created. */
export async function branchAvailable(root: string, branch: string): Promise<boolean> {
  if (!(await verifyBranchName(root, branch)).valid) return false;
  return !(await branchExists(root, branch));
}

export async function refExists(root: string, ref: string): Promise<boolean> {
  if (!ref || ref.includes("\0") || ref.startsWith("-")) return false;
  return predicateGit(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

export async function planWorktree(
  root: string,
  input: {
    path: string;
    workspaceName: string;
    branch?: string;
    startRef: string;
    createBranch?: boolean;
  },
  externalRoot: string,
): Promise<{ plan: WorktreePlan | null; validation: WorktreeValidationResult }> {
  const issues: WorktreeValidationIssue[] = [];
  let plan: WorktreePlan | null = null;
  try {
    const candidate = pureWorktreePlan(input, externalRoot);
    const path = canonicalPath(candidate.path);
    const canonicalExternalRoot = canonicalPath(externalRoot);
    const canonicalRelative = relative(canonicalExternalRoot, path);
    if (
      !canonicalRelative ||
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      fail("ERROR_UNSAFE_PATH", "worktree path escapes external root");
    }
    plan = { ...candidate, path };
  } catch (error) {
    if (error instanceof Error && "category" in error) {
      const category = (error as WorkflowError).category;
      issues.push({
        category: category === "ERROR_PATH_ACCESS" ? "path_unavailable" : "invalid_path",
        field: "path",
        detail: category === "ERROR_PATH_ACCESS" ? "worktree path is unavailable" : error.message,
      });
    } else throw error;
  }
  if (!plan) return { plan, validation: worktreeValidationResult(issues) };
  const branchCheck = await verifyBranchName(root, plan.branch);
  issues.push(...branchCheck.issues);
  const branchIsAvailable = await branchAvailable(root, plan.branch);
  if ((plan.create_branch && !branchIsAvailable) || (!plan.create_branch && branchIsAvailable)) {
    issues.push({
      category: "branch_unavailable",
      field: "branch",
      detail: plan.create_branch ? "branch already exists" : "branch does not exist",
    });
  }
  if (!(await refExists(root, plan.start_ref))) {
    issues.push({
      category: "invalid_ref",
      field: "start_ref",
      detail: "start ref is not a commit",
    });
  }
  const pathCheck = await findWorktreeByPath(root, plan.path);
  let pathExists = false;
  try {
    pathExists = worktreePathExists(plan.path);
  } catch (error) {
    if (error instanceof WorkflowError && error.category === "ERROR_PATH_ACCESS") {
      issues.push({
        category: "path_unavailable",
        field: "path",
        detail: "worktree path is unavailable",
      });
    } else {
      throw error;
    }
  }
  if (pathCheck.found || pathExists) {
    issues.push({
      category: "path_unavailable",
      field: "path",
      detail: "worktree path is unavailable",
    });
  }
  if (await isMainWorktree(root, plan.path)) {
    issues.push({ category: "main_worktree", field: "path", detail: "main worktree is protected" });
  }
  if (await isCurrentWorktree(root, plan.path)) {
    issues.push({
      category: "current_worktree",
      field: "path",
      detail: "current worktree is protected",
    });
  }
  return { plan, validation: worktreeValidationResult(issues) };
}

export async function currentHeadAsync(root: string): Promise<GitCommitSha> {
  const head = (await rawGit(root, ["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) fail("ERROR_NO_HEAD", "repository has no commit");
  return head as GitCommitSha;
}

export async function repositoryRootAsync(cwd: string): Promise<string> {
  const root = (await rawGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  if (!root || !isAbsolute(root)) fail("ERROR_NOT_REPOSITORY", "repository root is invalid");
  return canonicalPath(root);
}

export async function verifyRevisionAsync(root: string, revision: string): Promise<GitCommitSha> {
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
    fail("ERROR_INVALID_REVISION", "revision is invalid");
  }
  try {
    const output = (await rawGit(root, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
    if (output !== revision) fail("ERROR_INVALID_REVISION", "revision is not a commit");
  } catch (error) {
    if (error instanceof Error && "category" in error)
      fail("ERROR_INVALID_REVISION", "revision is not a commit");
    throw error;
  }
  return revision as GitCommitSha;
}

export async function verifyRangeAsync(
  root: string,
  baseRevision: GitCommitSha,
  headRevision: GitCommitSha,
): Promise<{ base_revision: GitCommitSha; head_revision: GitCommitSha }> {
  await verifyRevisionAsync(root, baseRevision);
  await verifyRevisionAsync(root, headRevision);
  if (baseRevision === headRevision)
    fail("ERROR_INVALID_REVISION", "range must be two distinct commits");
  if (!(await predicateGit(root, ["merge-base", "--is-ancestor", baseRevision, headRevision])))
    fail("ERROR_NON_ANCESTOR", "base is not an ancestor of head");
  return { base_revision: baseRevision, head_revision: headRevision };
}

function parseTreeRecord(output: string): GitLsTreeRecord | null {
  const record = output.split("\0")[0];
  if (!record) return null;
  const separator = record.indexOf("\t");
  if (separator < 0) fail("ERROR_INVALID_REVIEW_PATH", "review path metadata is invalid");
  const fields = record.slice(0, separator).split(" ");
  if (fields.length !== 3) fail("ERROR_INVALID_REVIEW_PATH", "review path metadata is invalid");
  return { mode: fields[0], type: fields[1], object: fields[2] };
}

async function treeEntryAsync(
  root: string,
  revision: GitCommitSha,
  path: ExactRepoPath,
): Promise<GitLsTreeRecord | null> {
  return parseTreeRecord(await rawGit(root, ["ls-tree", "-z", revision, "--", path]));
}

export async function reviewRangeAsync(
  root: string,
  target: CommitRangeReviewTarget,
): Promise<ReviewRange> {
  if (!target || typeof target !== "object" || Array.isArray(target))
    fail("ERROR_INVALID_REVIEW_PATH", "review target is invalid");
  const { base_revision, head_revision } = await verifyRangeAsync(
    root,
    target.base_revision,
    target.head_revision,
  );
  let paths: ExactRepoPath[];
  try {
    paths = exactPaths(target.approved_paths, root);
  } catch {
    fail("ERROR_INVALID_REVIEW_PATH", "review path is invalid");
  }
  const results: ReviewRange["paths"] = new Array(paths.length);
  let nextPath = 0;
  const reviewPath = async (path: ExactRepoPath) => {
    const base = await treeEntryAsync(root, base_revision, path);
    const head = await treeEntryAsync(root, head_revision, path);
    if ((base && base.type !== "blob") || (head && head.type !== "blob"))
      fail("ERROR_INVALID_REVIEW_PATH", "review path is not a file");
    if (!base && !head)
      fail("ERROR_INVALID_REVIEW_PATH", "review path is absent at both endpoints");
    const kind: RangePathKind =
      base && head
        ? base.object === head.object
          ? "unchanged"
          : "modified"
        : base
          ? "deleted"
          : "added";
    return {
      path,
      kind,
      base: base ? { mode: normalizeMode(base.mode), object: base.object as GitBlobSha } : null,
      head: head ? { mode: normalizeMode(head.mode), object: head.object as GitBlobSha } : null,
    };
  };
  const worker = async () => {
    while (true) {
      const index = nextPath;
      nextPath += 1;
      if (index >= paths.length) return;
      results[index] = await reviewPath(paths[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(REVIEW_RANGE_CONCURRENCY, paths.length) }, () => worker()),
  );
  return { base_revision, head_revision, paths: results };
}

async function exactChangedPathsAsync(
  root: string,
  prefix: readonly string[],
): Promise<ExactRepoPath[]> {
  const output = await rawGit(root, [...prefix, "--no-renames", "--name-only", "-z"]);
  return output.split("\0").filter(Boolean).sort() as ExactRepoPath[];
}

export async function stagedPathsAsync(root: string): Promise<ExactRepoPath[]> {
  return exactChangedPathsAsync(root, ["diff", "--cached"]);
}

export async function stagedEntriesAsync(root: string): Promise<Map<ExactRepoPath, GitTreeEntry>> {
  const output = await rawGit(root, ["ls-files", "--stage", "-z"]);
  const entries = new Map<ExactRepoPath, GitTreeEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const fields = record.slice(0, separator).split(" ");
    if (fields.length !== 3 || fields[2] !== "0") continue;
    entries.set(record.slice(separator + 1) as ExactRepoPath, {
      mode: normalizeMode(fields[0]),
      object: fields[1] as GitBlobSha,
    });
  }
  return entries;
}

export async function writeTreeAsync(root: string): Promise<GitTreeSha> {
  const tree = (await rawGit(root, ["write-tree"])).trim();
  if (!/^[0-9a-f]{40}$/u.test(tree)) fail("ERROR_GIT", "tree write failed");
  return tree as GitTreeSha;
}

function git(root: string, args: readonly string[], maxBuffer = 4 * 1024 * 1024): string {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer,
    });
  } catch {
    fail("ERROR_GIT", "git operation failed");
  }
}

function gitStatus(root: string, args: readonly string[]): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch (error) {
    const cause = error as { status?: number; stdout?: string };
    return { status: cause.status ?? 1, output: cause.stdout ?? "" };
  }
}

// Raw, unvalidated `git ls-tree` record (Phase B note: private to git.ts, not in types.ts).
interface GitLsTreeRecord {
  mode: string;
  type: string;
  object: string;
}

export function currentHead(root: string): GitCommitSha {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) fail("ERROR_NO_HEAD", "repository has no commit");
  return head as GitCommitSha;
}

export function repositoryRoot(cwd: string): string {
  return realpathSync(git(cwd, ["rev-parse", "--show-toplevel"]).trim());
}

export function verifyRevision(root: string, revision: string): GitCommitSha {
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
    fail("ERROR_INVALID_REVISION", "revision is invalid");
  }
  const { status, output } = gitStatus(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${revision}^{commit}`,
  ]);
  if (status !== 0 || output.trim() !== revision) {
    fail("ERROR_INVALID_REVISION", "revision is not a commit");
  }
  return revision as GitCommitSha;
}

export function verifyRange(
  root: string,
  baseRevision: GitCommitSha,
  headRevision: GitCommitSha,
): { base_revision: GitCommitSha; head_revision: GitCommitSha } {
  verifyRevision(root, baseRevision);
  verifyRevision(root, headRevision);
  if (baseRevision === headRevision) {
    fail("ERROR_INVALID_REVISION", "range must be two distinct commits");
  }
  const { status } = gitStatus(root, ["merge-base", "--is-ancestor", baseRevision, headRevision]);
  if (status !== 0) fail("ERROR_NON_ANCESTOR", "base is not an ancestor of head");
  return { base_revision: baseRevision, head_revision: headRevision };
}

function treeEntry(
  root: string,
  revision: GitCommitSha,
  path: ExactRepoPath,
): GitLsTreeRecord | null {
  const output = git(root, ["ls-tree", "-z", revision, "--", path]);
  const record = output.split("\0")[0];
  if (!record) return null;
  const separator = record.indexOf("\t");
  if (separator < 0) fail("ERROR_INVALID_REVIEW_PATH", "review path metadata is invalid");
  const fields = record.slice(0, separator).split(" ");
  if (fields.length !== 3) fail("ERROR_INVALID_REVIEW_PATH", "review path metadata is invalid");
  return { mode: fields[0], type: fields[1], object: fields[2] };
}

export function reviewRange(root: string, target: CommitRangeReviewTarget): ReviewRange {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    fail("ERROR_INVALID_REVIEW_PATH", "review target is invalid");
  }
  const { base_revision, head_revision } = verifyRange(
    root,
    target.base_revision,
    target.head_revision,
  );
  let paths: ExactRepoPath[];
  try {
    paths = exactPaths(target.approved_paths, root);
  } catch {
    fail("ERROR_INVALID_REVIEW_PATH", "review path is invalid");
  }
  const results = paths.map((path) => {
    const base = treeEntry(root, base_revision, path);
    const head = treeEntry(root, head_revision, path);
    if ((base && base.type !== "blob") || (head && head.type !== "blob")) {
      fail("ERROR_INVALID_REVIEW_PATH", "review path is not a file");
    }
    if (!base && !head) {
      fail("ERROR_INVALID_REVIEW_PATH", "review path is absent at both endpoints");
    }
    const kind: RangePathKind =
      base && head
        ? base.object === head.object
          ? "unchanged"
          : "modified"
        : base
          ? "deleted"
          : "added";
    return {
      path,
      kind,
      base: base ? { mode: base.mode as GitFileMode, object: base.object as GitBlobSha } : null,
      head: head ? { mode: head.mode as GitFileMode, object: head.object as GitBlobSha } : null,
    };
  });
  return { base_revision, head_revision, paths: results };
}

function digest(value: Buffer): ContentDigest {
  return createHash("sha256").update(value).digest("hex") as ContentDigest;
}

function normalizeMode(mode: string): GitFileMode {
  if (!["100644", "100755", "120000"].includes(mode))
    fail("ERROR_UNSUPPORTED_MODE", "file mode is unsupported");
  return mode as GitFileMode;
}

function blobDigest(root: string, object: GitBlobSha): ContentDigest {
  const size = Number(git(root, ["cat-file", "-s", object]).trim());
  if (!Number.isSafeInteger(size) || size < 0) fail("ERROR_GIT", "blob size is invalid");
  const content = execFileSync("git", ["-C", root, "cat-file", "blob", object], {
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: Math.max(size + 1, 1024),
  });
  return digest(content);
}

export function verifyReviewReceipt(
  root: string,
  receipt: ChangeReceipt,
  expectedPaths: ReadonlyArray<ExactRepoPath>,
  baseHead: GitCommitSha,
): ChangeReceipt {
  if (
    !receipt ||
    receipt.base_head !== baseHead ||
    canonicalJson(receipt.approved_paths) !== canonicalJson(expectedPaths)
  ) {
    fail("ERROR_STALE_RECEIPT", "receipt scope or base is stale");
  }
  const current = createReceipt(root, expectedPaths, true);
  if (current.base_head !== baseHead) fail("ERROR_STALE_RECEIPT", "receipt base is stale");
  if (canonicalJson(current) !== canonicalJson(receipt))
    fail("ERROR_STALE_RECEIPT", "receipt content is stale");
  return current;
}

export function createReceipt(
  root: string,
  expectedPaths: ReadonlyArray<ExactRepoPath>,
  allowAbsent = false,
): ChangeReceipt {
  try {
    return createInProcessReceipt([...expectedPaths], root, { allowAbsent }) as ChangeReceipt;
  } catch (error) {
    const category = error instanceof Error ? error.message : "";
    if (/^ERROR_[A-Z_]+$/u.test(category)) fail(category as ErrorCategory, "receipt rejected");
    fail("ERROR_RECEIPT_UNAVAILABLE", "receipt could not be recomputed");
  }
}

export function stagedPaths(root: string): ExactRepoPath[] {
  return exactChangedPaths(root, ["diff", "--cached"]);
}

/** Return approved paths whose index entry differs from HEAD, including staged-only changes. */
export function stagedScopeChanges(
  root: string,
  expectedPaths: ReadonlyArray<ExactRepoPath>,
): ExactRepoPath[] {
  const expected = new Set(expectedPaths);
  const output = git(root, [
    "--literal-pathspecs",
    "diff",
    "--cached",
    "--no-renames",
    "--name-only",
    "-z",
    "--",
    ...expectedPaths,
  ]);
  return [
    ...new Set(output.split("\0").filter((path) => expected.has(path as ExactRepoPath))),
  ].sort() as ExactRepoPath[];
}

/**
 * Resolve the index-side state for dirty-scope adoption. Ordinary review receipts intentionally
 * describe the worktree; adoption must additionally bind the staged index so staged-only changes
 * cannot be silently treated as clean.
 */
export function stagedAdoptionStates(
  root: string,
  expectedPaths: ReadonlyArray<ExactRepoPath>,
  baseHead: GitCommitSha,
): DirtyScopeAdoptionIndexState[] {
  const staged = new Set(stagedScopeChanges(root, expectedPaths));
  const index = stagedEntries(root);
  return expectedPaths.map((path) => {
    const head = treeEntry(root, baseHead, path);
    const indexed = index.get(path);
    if (!staged.has(path)) {
      if (!head) return { path, state: "absent", kind: "missing" };
      return {
        path,
        state: "unchanged",
        kind: head.mode === "120000" ? "symlink" : "file",
        mode: head.mode as GitFileMode,
        digest: blobDigest(root, head.object as GitBlobSha),
      };
    }
    if (!indexed) {
      if (!head) fail("ERROR_GIT", "staged index state is inconsistent");
      return { path, state: "deleted", kind: "missing", mode: head.mode as GitFileMode };
    }
    const state = !head
      ? "added"
      : head.mode !== indexed.mode || head.object !== indexed.object
        ? "modified"
        : "unchanged";
    return {
      path,
      state,
      kind: indexed.mode === "120000" ? "symlink" : "file",
      mode: indexed.mode,
      digest: blobDigest(root, indexed.object),
    };
  });
}

function exactChangedPaths(root: string, prefix: readonly string[]): ExactRepoPath[] {
  const output = git(root, [...prefix, "--no-renames", "--name-only", "-z"]);
  return output
    .split("\0")
    .filter((path) => path.length > 0)
    .sort() as ExactRepoPath[];
}

export function stagedEntries(root: string): Map<ExactRepoPath, GitTreeEntry> {
  const output = git(root, ["ls-files", "--stage", "-z"]);
  const entries = new Map<ExactRepoPath, GitTreeEntry>();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const fields = record.slice(0, separator).split(" ");
    if (fields.length !== 3 || fields[2] !== "0") continue;
    entries.set(record.slice(separator + 1) as ExactRepoPath, {
      mode: normalizeMode(fields[0]),
      object: fields[1] as GitBlobSha,
    });
  }
  return entries;
}

export function approvedResidue(
  root: string,
  approvedPaths: ReadonlyArray<ExactRepoPath>,
  staged: ReadonlyArray<ExactRepoPath>,
): ExactRepoPath[] {
  const approved = new Set<ExactRepoPath>(approvedPaths);
  const stagedSet = new Set<ExactRepoPath>(staged);
  const output = git(root, ["status", "--porcelain", "-z"]);
  const residue = new Set<ExactRepoPath>();
  for (const record of output.split("\0")) {
    if (record.length < 3) continue;
    const path = record.slice(3) as ExactRepoPath;
    if (!approved.has(path)) continue;
    const indexStatus = record[0];
    const worktreeStatus = record[1];
    if (indexStatus === "?" && worktreeStatus === "?") {
      residue.add(path);
    } else if (!stagedSet.has(path)) {
      residue.add(path);
    }
  }
  return [...residue].sort();
}

export function writeTree(root: string): GitTreeSha {
  const tree = git(root, ["write-tree"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(tree)) fail("ERROR_GIT", "tree write failed");
  return tree as GitTreeSha;
}

export function prepareCommitReceipt(
  root: string,
  state: WorkflowState,
): CommitPreparationEvidence {
  if (state.review_target?.review_mode !== "working_tree") {
    fail("ERROR_COMMIT_NOT_ALLOWED", "commit preparation requires a working-tree review");
  }
  if (!state.commit_authorization) {
    fail("ERROR_STALE_RECEIPT", "commit is not authorized");
  }
  const receipt = state.review_receipt;
  if (!receipt) fail("ERROR_STALE_RECEIPT", "receipt scope or base is stale");
  const reviewPaths = state.review_target.approved_paths ?? state.approved_paths;
  const fresh = verifyReviewReceipt(root, receipt, reviewPaths, state.base_head);
  const expectedPaths = receipt.paths
    .filter((entry) => ["added", "modified", "deleted"].includes(entry.state))
    .map((entry) => entry.path)
    .sort();
  const staged = stagedPaths(root);
  if (staged.length === 0) fail("ERROR_STAGED_SCOPE", "no paths are staged");
  if (
    staged.length !== expectedPaths.length ||
    staged.some((path, index) => path !== expectedPaths[index])
  ) {
    fail("ERROR_STAGED_SCOPE", "staged scope does not match the review receipt");
  }
  if (approvedResidue(root, reviewPaths, staged).length > 0) {
    fail("ERROR_STAGED_SCOPE", "approved paths have unstaged or untracked residue");
  }
  const entries = stagedEntries(root);
  for (const entry of receipt.paths) {
    if (entry.state === "deleted") {
      if (entries.has(entry.path)) fail("ERROR_STAGED_CONTENT", "deleted path is still staged");
      continue;
    }
    if (entry.state !== "added" && entry.state !== "modified") continue;
    const stagedEntry = entries.get(entry.path);
    if (!stagedEntry) fail("ERROR_STAGED_CONTENT", "changed path is not staged");
    if (stagedEntry.mode !== entry.mode || blobDigest(root, stagedEntry.object) !== entry.digest) {
      fail("ERROR_STAGED_CONTENT", "staged content does not match the review receipt");
    }
  }
  return {
    prepared_head: fresh.base_head,
    prepared_tree: writeTree(root),
    expected_paths: expectedPaths,
  };
}

function commitChangedPaths(
  root: string,
  fromRevision: GitCommitSha,
  toRevision: GitCommitSha,
): ExactRepoPath[] {
  return exactChangedPaths(root, ["diff", fromRevision, toRevision]);
}

export function verifyPreparedCommit(
  root: string,
  state: WorkflowState,
): { category: CommitMismatchCategory | null; commit_hash: GitCommitSha } {
  const preparation = state.commit_preparation;
  const head = currentHead(root);
  if (!preparation || typeof preparation !== "object") {
    return { category: "PARENT_MISMATCH", commit_hash: head };
  }
  if (head === preparation.prepared_head) {
    return { category: "HEAD_CHANGED", commit_hash: head };
  }
  const parent = git(root, ["rev-list", "--parents", "-n", "1", head]).trim().split(" ");
  if (parent.length !== 2) return { category: "PARENT_MISMATCH", commit_hash: head };
  if (parent[1] !== preparation.prepared_head)
    return { category: "PARENT_MISMATCH", commit_hash: head };
  const tree = git(root, ["rev-parse", `${head}^{tree}`]).trim() as GitTreeSha;
  if (tree !== preparation.prepared_tree) return { category: "TREE_MISMATCH", commit_hash: head };
  const expected = [...preparation.expected_paths].sort();
  const actual = commitChangedPaths(root, preparation.prepared_head, head);
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    return { category: "PATH_MISMATCH", commit_hash: head };
  }
  return { category: null, commit_hash: head };
}

export function verifyCommitResult(
  root: string,
  state: WorkflowState,
  input: Record<string, unknown>,
): { category: CommitMismatchCategory | null; commit_hash: GitCommitSha | null } {
  if (input.outcome === "committed") {
    return verifyPreparedCommit(root, state);
  }
  if (input.outcome === "not_committed") {
    const preparation = state.commit_preparation;
    if (!preparation || typeof preparation !== "object") {
      return { category: "HEAD_CHANGED", commit_hash: null };
    }
    if (currentHead(root) !== preparation.prepared_head) {
      return { category: "HEAD_CHANGED", commit_hash: null };
    }
    return { category: null, commit_hash: null };
  }
  fail("ERROR_INVALID_SHAPE", "commit outcome is invalid");
}
