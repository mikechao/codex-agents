import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fail } from "./errors.mjs";
import { canonicalJson } from "./validation.mjs";

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

export function currentHead(root) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/u.test(head)) fail("ERROR_NO_HEAD", "repository has no commit");
  return head;
}

export function repositoryRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
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

export function createReceipt(root, expectedPaths) {
  const script = join(root, ".codex", "agents", "change-receipt.mjs");
  let current;
  try {
    current = JSON.parse(
      execFileSync(process.execPath, [script, "--", ...expectedPaths], {
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
    fail("ERROR_COMMIT_MISMATCH", "commit hash is invalid");
  }
  const head = currentHead(root);
  if (head !== commitHash) fail("ERROR_COMMIT_MISMATCH", "commit is not current HEAD");
  const parent = git(root, ["rev-list", "--parents", "-n", "1", commitHash]).trim().split(" ");
  if (parent.length !== 2) fail("ERROR_COMMIT_MISMATCH", "commit must have one parent");
  if (parent[1] !== state.base_head)
    fail("ERROR_COMMIT_MISMATCH", "commit parent is not the workflow base");
  const entries = treeEntries(root, commitHash);
  const changed = new Set();
  const diff = git(root, ["diff", "--name-status", "-z", state.base_head, commitHash]);
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
  const expectedChanged = new Set(
    state.review_receipt.paths
      .filter((entry) => entry.state !== "unchanged")
      .map((entry) => entry.path),
  );
  if (
    changed.size !== expectedChanged.size ||
    [...changed].some((path) => !expectedChanged.has(path))
  ) {
    fail("ERROR_COMMIT_MISMATCH", "changed paths do not match receipt");
  }
  for (const entry of state.review_receipt.paths) {
    const tree = entries.get(entry.path);
    if (entry.state === "deleted") {
      if (tree) fail("ERROR_COMMIT_MISMATCH", "deleted path exists in commit");
      continue;
    }
    if (!tree || tree.mode !== entry.mode || blobDigest(root, tree.object) !== entry.digest) {
      fail("ERROR_COMMIT_MISMATCH", "committed content does not match receipt");
    }
  }
  return { commit_hash: commitHash, parent: state.base_head, changed_paths: [...changed].sort() };
}
