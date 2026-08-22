import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createReceipt as createInProcessReceipt } from "../agents/change-receipt.js";
import { fail } from "./errors.js";
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
} from "./types.js";
import { canonicalJson, exactPaths } from "./validation.js";

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
