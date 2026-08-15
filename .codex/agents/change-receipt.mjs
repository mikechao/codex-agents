#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const SCHEMA_VERSION = 1;

function fail(category) {
  process.stderr.write(`${category}\n`);
  return 2;
}

function runGit(repositoryRoot, args) {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch {
    throw new Error("ERROR_GIT");
  }
}

function readGitBlob(repositoryRoot, objectId) {
  const sizeText = runGit(repositoryRoot, ["cat-file", "-s", objectId]).trim();
  if (!/^\d+$/u.test(sizeText)) {
    throw new Error("ERROR_GIT_SIZE");
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size >= Number.MAX_SAFE_INTEGER - 1) {
    throw new Error("ERROR_GIT_SIZE");
  }
  try {
    return execFileSync("git", ["-C", repositoryRoot, "cat-file", "blob", objectId], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: size + 1,
    });
  } catch {
    throw new Error("ERROR_GIT");
  }
}

function repositoryRoot(cwd = process.cwd()) {
  try {
    return runGit(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    throw new Error("ERROR_NOT_REPOSITORY");
  }
}

function requireHead(root) {
  try {
    const head = runGit(root, ["rev-parse", "--verify", "HEAD"]).trim();
    if (!/^[0-9a-f]{40}$/u.test(head)) {
      throw new Error("ERROR_NO_HEAD");
    }
    return head;
  } catch (error) {
    if (error instanceof Error && error.message === "ERROR_NO_HEAD") {
      throw error;
    }
    throw new Error("ERROR_NO_HEAD");
  }
}

function normalizePath(root, input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("ERROR_EMPTY_PATH");
  }
  if (input.includes("\0") || isAbsolute(input)) {
    throw new Error("ERROR_UNSAFE_PATH");
  }

  const absolute = resolve(root, input);
  const normalized = relative(root, absolute);
  if (
    normalized === "" ||
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    isAbsolute(normalized)
  ) {
    throw new Error("ERROR_UNSAFE_PATH");
  }
  return normalized.split(sep).join("/");
}

function headEntry(root, path) {
  let output;
  try {
    output = runGit(root, ["--literal-pathspecs", "ls-tree", "-z", "-r", "HEAD", "--", path]);
  } catch {
    throw new Error("ERROR_GIT");
  }

  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator < 0) continue;
    const fields = record.slice(0, separator).split(" ");
    const entryPath = record.slice(separator + 1);
    if (entryPath !== path || fields.length !== 3 || fields[1] !== "blob") continue;
    const mode = normalizeMode(fields[0]);
    return {
      mode,
      kind: mode === "120000" ? "symlink" : "file",
      digest: digest(readGitBlob(root, fields[2])),
    };
  }
  return null;
}

function normalizeMode(mode) {
  if (mode === "120000") return mode;
  if (mode === "100755") return mode;
  if (mode === "100644") return mode;
  throw new Error("ERROR_UNSUPPORTED_MODE");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function currentMetadata(root, path, head) {
  const absolute = resolve(root, path);
  try {
    const parent = realpathSync(dirname(absolute));
    const parentRelative = relative(root, parent);
    if (
      parentRelative === ".." ||
      parentRelative.startsWith(`..${sep}`) ||
      isAbsolute(parentRelative)
    ) {
      throw new Error("ERROR_UNSAFE_PATH");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "ERROR_UNSAFE_PATH") throw error;
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw new Error("ERROR_PATH_ACCESS");
    }
  }
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      if (!head) throw new Error("ERROR_UNTRACKED_PATH");
      return {
        path,
        state: "deleted",
        kind: "missing",
        mode: head.mode,
      };
    }
    throw new Error("ERROR_PATH_ACCESS");
  }

  let kind;
  let currentDigest;
  let mode;
  if (stat.isSymbolicLink()) {
    kind = "symlink";
    mode = "120000";
    currentDigest = digest(readlinkSync(absolute));
  } else if (stat.isFile()) {
    kind = "file";
    mode = (stat.mode & 0o111) === 0 ? "100644" : "100755";
    currentDigest = digest(readFileSync(absolute));
  } else if (stat.isDirectory()) {
    throw new Error("ERROR_DIRECTORY_PATH");
  } else {
    throw new Error("ERROR_UNSUPPORTED_FILE_TYPE");
  }

  if (!head) {
    return { path, state: "added", kind, mode, digest: currentDigest };
  }
  const unchanged = head.mode === mode && head.kind === kind && head.digest === currentDigest;
  return {
    path,
    state: unchanged ? "unchanged" : "modified",
    kind,
    mode,
    digest: currentDigest,
  };
}

function canonicalReceipt(receipt) {
  return JSON.stringify({
    schema_version: receipt.schema_version,
    base_head: receipt.base_head,
    approved_paths: receipt.approved_paths,
    paths: receipt.paths,
  });
}

export function createReceipt(inputs, cwd = process.cwd()) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new Error("ERROR_EMPTY_PATHS");
  }
  const root = repositoryRoot(cwd);
  return createReceiptAtRoot(inputs, root);
}

function createReceiptAtRoot(inputs, root) {
  const headRevision = requireHead(root);
  const normalized = inputs.map((input) => normalizePath(root, input));
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    throw new Error("ERROR_DUPLICATE_PATH");
  }
  const approvedPaths = [...unique].sort();
  const paths = approvedPaths.map((path) => {
    const head = headEntry(root, path);
    let current;
    try {
      current = currentMetadata(root, path, head);
    } catch (error) {
      if (error instanceof Error && error.message === "ERROR_UNTRACKED_PATH" && head) {
        throw new Error("ERROR_PATH_ACCESS");
      }
      throw error;
    }
    if (!head && current.kind === "missing") {
      throw new Error("ERROR_UNTRACKED_PATH");
    }
    if (head && current.state === "deleted") {
      return current;
    }
    if (!head) return current;
    return current;
  });

  const receipt = {
    schema_version: SCHEMA_VERSION,
    base_head: headRevision,
    approved_paths: approvedPaths,
    paths,
  };
  receipt.overall_scope_hash = digest(canonicalReceipt(receipt));
  return receipt;
}

function main() {
  const separator = process.argv.indexOf("--");
  const inputs = separator < 0 ? [] : process.argv.slice(separator + 1);
  if (separator >= 0 && process.argv.slice(2, separator).length > 0) {
    return fail("ERROR_INVALID_ARGUMENTS");
  }
  if (inputs.length === 0) return fail("ERROR_EMPTY_PATHS");

  try {
    const root = repositoryRoot();
    const receipt = createReceiptAtRoot(inputs, root);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return 0;
  } catch (error) {
    const category =
      error instanceof Error && /^ERROR_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "ERROR_INTERNAL";
    return fail(category);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
