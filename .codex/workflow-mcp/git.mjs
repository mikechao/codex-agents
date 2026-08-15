import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fail } from "./errors.mjs";
import { canonicalJson, exactPaths } from "./validation.mjs";

function git(root, args, maxBuffer = 4 * 1024 * 1024) {
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

function gitStatus(root, args) {
  try {
    return {
      status: 0,
      output: execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    };
  } catch (error) {
    return { status: error.status ?? 1, output: error.stdout ?? "" };
  }
}

export function currentHead(root) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) fail("ERROR_NO_HEAD", "repository has no commit");
  return head;
}

export function repositoryRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

export function verifyRevision(root, revision) {
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
  return revision;
}

export function verifyRange(root, baseRevision, headRevision) {
  verifyRevision(root, baseRevision);
  verifyRevision(root, headRevision);
  if (baseRevision === headRevision) {
    fail("ERROR_INVALID_REVISION", "range must be two distinct commits");
  }
  const { status } = gitStatus(root, [
    "merge-base",
    "--is-ancestor",
    baseRevision,
    headRevision,
  ]);
  if (status !== 0) fail("ERROR_NON_ANCESTOR", "base is not an ancestor of head");
  return { base_revision: baseRevision, head_revision: headRevision };
}

function treeEntry(root, revision, path) {
  const output = git(root, ["ls-tree", "-z", revision, "--", path]);
  const record = output.split("\0")[0];
  if (!record) return null;
  const separator = record.indexOf("\t");
  if (separator < 0) fail("ERROR_INVALID_REVIEW_PATH", "review path metadata is invalid");
  const fields = record.slice(0, separator).split(" ");
  if (fields.length !== 3) fail("ERROR_INVALID_REVIEW_PATH", "review path metadata is invalid");
  return { mode: fields[0], type: fields[1], object: fields[2] };
}

export function reviewRange(root, target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    fail("ERROR_INVALID_REVIEW_PATH", "review target is invalid");
  }
  const { base_revision, head_revision } = verifyRange(
    root,
    target.base_revision,
    target.head_revision,
  );
  let paths;
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
    const kind = base && head ? (base.object === head.object ? "unchanged" : "modified") : base ? "deleted" : "added";
    return {
      path,
      kind,
      base: base ? { mode: base.mode, object: base.object } : null,
      head: head ? { mode: head.mode, object: head.object } : null,
    };
  });
  return { base_revision, head_revision, paths: results };
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function treeEntries(root, revision) {
  const output = git(root, ["ls-tree", "-r", "-z", revision]);
  const result = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const fields = record.slice(0, separator).split(" ");
    if (fields.length !== 3 || fields[1] !== "blob") continue;
    result.set(record.slice(separator + 1), { mode: normalizeMode(fields[0]), object: fields[2] });
  }
  return result;
}

function normalizeMode(mode) {
  if (!["100644", "100755", "120000"].includes(mode))
    fail("ERROR_UNSUPPORTED_MODE", "file mode is unsupported");
  return mode;
}

function blobDigest(root, object) {
  const size = Number(git(root, ["cat-file", "-s", object]).trim());
  if (!Number.isSafeInteger(size) || size < 0) fail("ERROR_GIT", "blob size is invalid");
  const content = execFileSync("git", ["-C", root, "cat-file", "blob", object], {
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: Math.max(size + 1, 1024),
  });
  return digest(content);
}

export function verifyReviewReceipt(root, receipt, expectedPaths, baseHead) {
  if (
    !receipt ||
    receipt.base_head !== baseHead ||
    canonicalJson(receipt.approved_paths) !== canonicalJson(expectedPaths)
  ) {
    fail("ERROR_STALE_RECEIPT", "receipt scope or base is stale");
  }
  const current = createReceipt(root, expectedPaths);
  if (current.base_head !== baseHead) fail("ERROR_STALE_RECEIPT", "receipt base is stale");
  if (canonicalJson(current) !== canonicalJson(receipt))
    fail("ERROR_STALE_RECEIPT", "receipt content is stale");
  return current;
}

export function createReceipt(root, expectedPaths, allowAbsent = false) {
  const script = join(root, ".codex", "agents", "change-receipt.mjs");
  const args = allowAbsent ? ["--allow-absent", "--", ...expectedPaths] : ["--", ...expectedPaths];
  let current;
  try {
    current = JSON.parse(
      execFileSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
  } catch (error) {
    const category = String(error?.stderr ?? "").trim();
    if (/^ERROR_[A-Z_]+$/u.test(category)) fail(category, "receipt rejected");
    fail("ERROR_RECEIPT_UNAVAILABLE", "receipt could not be recomputed");
  }
  return current;
}

export function verifyCommit(root, state, commitHash) {
  if (typeof commitHash !== "string" || !/^[0-9a-f]{40}$/u.test(commitHash)) {
    return { mismatch: "HEAD_CHANGED" };
  }
  const head = currentHead(root);
  if (head !== commitHash) return { mismatch: "HEAD_CHANGED" };
  const parent = git(root, ["rev-list", "--parents", "-n", "1", commitHash]).trim().split(" ");
  if (parent.length !== 2) return { mismatch: "PARENT_MISMATCH" };
  if (parent[1] !== state.base_head) return { mismatch: "PARENT_MISMATCH" };
  const entries = treeEntries(root, commitHash);
  for (const entry of state.review_receipt?.paths ?? []) {
    const tree = entries.get(entry.path);
    if (entry.state === "deleted") {
      if (tree) return { mismatch: "TREE_MISMATCH" };
      continue;
    }
    if (!tree || tree.mode !== entry.mode || blobDigest(root, tree.object) !== entry.digest) {
      return { mismatch: "TREE_MISMATCH" };
    }
  }
  const expectedChanged = (state.review_receipt?.paths ?? [])
    .filter((entry) => entry.state !== "unchanged")
    .map((entry) => entry.path)
    .sort();
  const actualChanged = commitChangedPaths(root, state.base_head, commitHash);
  if (
    actualChanged.length !== expectedChanged.length ||
    actualChanged.some((path, index) => path !== expectedChanged[index])
  ) {
    return { mismatch: "PATH_MISMATCH" };
  }
  return { commit_hash: commitHash, changed_paths: actualChanged };
}

export function stagedPaths(root) {
  const output = git(root, ["diff", "--cached", "--name-only", "-z"]);
  return output.split("\0").filter((path) => path.length > 0).sort();
}

export function stagedEntries(root) {
  const output = git(root, ["ls-files", "--stage", "-z"]);
  const entries = new Map();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const fields = record.slice(0, separator).split(" ");
    if (fields.length !== 3 || fields[2] !== "0") continue;
    entries.set(record.slice(separator + 1), { mode: normalizeMode(fields[0]), object: fields[1] });
  }
  return entries;
}

export function approvedResidue(root, approvedPaths, staged) {
  const approved = new Set(approvedPaths);
  const stagedSet = new Set(staged);
  const output = git(root, ["status", "--porcelain", "-z"]);
  const residue = new Set();
  for (const record of output.split("\0")) {
    if (record.length < 3) continue;
    const path = record.slice(3);
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

export function writeTree(root) {
  const tree = git(root, ["write-tree"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(tree)) fail("ERROR_GIT", "tree write failed");
  return tree;
}

export function prepareCommitReceipt(root, state) {
  if (state.review_target?.review_mode !== "working_tree") {
    fail("ERROR_COMMIT_NOT_ALLOWED", "commit preparation requires a working-tree review");
  }
  if (!state.commit_authorization) {
    fail("ERROR_STALE_RECEIPT", "commit is not authorized");
  }
  const fresh = verifyReviewReceipt(root, state.review_receipt, state.approved_paths, state.base_head);
  const expectedPaths = state.review_receipt.paths
    .filter((entry) => ["added", "modified", "deleted"].includes(entry.state))
    .map((entry) => entry.path)
    .sort();
  const staged = stagedPaths(root);
  if (staged.length === 0) fail("ERROR_STAGED_SCOPE", "no paths are staged");
  if (staged.length !== expectedPaths.length || staged.some((path, index) => path !== expectedPaths[index])) {
    fail("ERROR_STAGED_SCOPE", "staged scope does not match the review receipt");
  }
  if (approvedResidue(root, state.approved_paths, staged).length > 0) {
    fail("ERROR_STAGED_SCOPE", "approved paths have unstaged or untracked residue");
  }
  const entries = stagedEntries(root);
  for (const entry of state.review_receipt.paths) {
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

function commitChangedPaths(root, fromRevision, toRevision) {
  const changed = new Set();
  const diff = git(root, ["diff", "--name-status", "-z", fromRevision, toRevision]);
  const parts = diff.split("\0");
  for (let index = 0; index < parts.length; index += 1) {
    const status = parts[index];
    if (!status) continue;
    const path = parts[index + 1];
    if (!path) fail("ERROR_COMMIT_MISMATCH", "commit path is invalid");
    changed.add(path);
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = parts[index + 2];
      if (!destination) fail("ERROR_COMMIT_MISMATCH", "rename path is invalid");
      changed.add(destination);
      index += 1;
    }
    index += 1;
  }
  return [...changed].sort();
}

export function verifyPreparedCommit(root, state, commitHash) {
  if (typeof commitHash !== "string" || !/^[0-9a-f]{40}$/u.test(commitHash)) {
    return "HEAD_CHANGED";
  }
  const preparation = state.commit_preparation;
  if (!preparation || typeof preparation !== "object") {
    return "PARENT_MISMATCH";
  }
  const head = currentHead(root);
  if (head !== commitHash) return "HEAD_CHANGED";
  const parent = git(root, ["rev-list", "--parents", "-n", "1", commitHash]).trim().split(" ");
  if (parent.length !== 2) return "PARENT_MISMATCH";
  if (parent[1] !== preparation.prepared_head) return "PARENT_MISMATCH";
  const tree = git(root, ["rev-parse", `${commitHash}^{tree}`]).trim();
  if (tree !== preparation.prepared_tree) return "TREE_MISMATCH";
  const expected = [...preparation.expected_paths].sort();
  const actual = commitChangedPaths(root, preparation.prepared_head, commitHash);
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    return "PATH_MISMATCH";
  }
  return null;
}

export function verifyCommitResult(root, state, input) {
  if (input.outcome === "committed") {
    return verifyPreparedCommit(root, state, input.commit_hash);
  }
  if (input.outcome === "not_committed") {
    const preparation = state.commit_preparation;
    if (!preparation || typeof preparation !== "object") return "HEAD_CHANGED";
    if (currentHead(root) !== preparation.prepared_head) return "HEAD_CHANGED";
    return null;
  }
  fail("ERROR_INVALID_SHAPE", "commit outcome is invalid");
}
