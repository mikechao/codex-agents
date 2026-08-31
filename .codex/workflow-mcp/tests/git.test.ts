import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { WorkflowError } from "../errors.js";
import {
  approvedResidue,
  branchAvailable,
  branchExists,
  findCurrentWorktree,
  findWorktreeByBranch,
  findWorktreeByPath,
  getMainWorktree,
  listWorktrees,
  parseWorktreePorcelain,
  planWorktree,
  prepareCommitReceipt,
  refExists,
  repositoryRoot,
  reviewRange,
  reviewRangeAsync,
  stagedEntries,
  stagedEntriesAsync,
  stagedPaths,
  stagedPathsAsync,
  verifyBranchName,
  verifyPreparedCommit,
  verifyRange,
  verifyRangeAsync,
  verifyRevision,
  worktreePathExists,
  writeTree,
  writeTreeAsync,
} from "../git.js";
import type {
  CommitRangeReviewTarget,
  ExactRepoPath,
  GitCommitSha,
  WorkflowState,
} from "../types.js";
import { emptyFixture } from "./test-fixtures.js";

function fixture() {
  const { root, git } = emptyFixture();
  const write = (path: string, content: string) => {
    const directory = join(root, path.split("/").slice(0, -1).join("/"));
    if (directory !== root) mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, git, write };
}

function errorCategory(callback: () => void): string {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof WorkflowError);
    return error.category;
  }
  assert.fail("expected workflow error");
}

function target(base: string, head: string, paths: string[]): CommitRangeReviewTarget {
  return {
    base_revision: base,
    head_revision: head,
    approved_paths: paths,
  } as CommitRangeReviewTarget;
}

interface GitShim {
  directory: string;
  state: string;
  realGit: string;
  cleanup: () => void;
}

function gitShim(): GitShim {
  const directory = mkdtempSync(join(tmpdir(), "workflow-git-shim-"));
  const state = join(directory, "state");
  mkdirSync(state);
  writeFileSync(join(state, "active"), "0\n");
  writeFileSync(join(state, "max"), "0\n");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const shim = join(directory, "git");
  writeFileSync(
    shim,
    `#!/bin/sh
set -u
state=$WORKFLOW_GIT_SHIM_STATE
real_git=$WORKFLOW_GIT_REAL
is_ls_tree=0
is_ls_files=0
for argument in "$@"; do
  if [ "$argument" = "ls-tree" ]; then is_ls_tree=1; fi
  if [ "$argument" = "ls-files" ]; then is_ls_files=1; fi
done
if [ "$is_ls_tree" -eq 0 ] && [ "$is_ls_files" -eq 0 ]; then exec "$real_git" "$@"; fi
if [ "\${WORKFLOW_GIT_SHIM_LARGE:-0}" = "1" ]; then
  exec dd if=/dev/zero bs=4194305 count=1 2>/dev/null
fi
if [ "\${WORKFLOW_GIT_SHIM_FAIL:-0}" = "1" ]; then
  printf '%s\n' "controlled git failure" >&2
  exit 1
fi
if [ "\${WORKFLOW_GIT_SHIM_TREE_OUTPUT+x}" = "x" ]; then
  printf '%b' "$WORKFLOW_GIT_SHIM_TREE_OUTPUT"
  exit 0
fi
if [ "\${WORKFLOW_GIT_SHIM_INDEX_OUTPUT+x}" = "x" ] && [ "$is_ls_files" -eq 1 ]; then
  printf '%b' "$WORKFLOW_GIT_SHIM_INDEX_OUTPUT"
  exit 0
fi
lock=$state/lock
while ! mkdir "$lock" 2>/dev/null; do sleep 0.001; done
active=$(cat "$state/active")
active=$((active + 1))
printf '%s\n' "$active" >"$state/active"
maximum=$(cat "$state/max")
if [ "$active" -gt "$maximum" ]; then printf '%s\n' "$active" >"$state/max"; fi
rmdir "$lock"
decrement() {
  while ! mkdir "$lock" 2>/dev/null; do sleep 0.001; done
  active=$(cat "$state/active")
  active=$((active - 1))
  printf '%s\n' "$active" >"$state/active"
  rmdir "$lock"
}
trap 'decrement' EXIT
sleep 0.02
  "$real_git" "$@"
status=$?
trap - EXIT
while ! mkdir "$lock" 2>/dev/null; do sleep 0.001; done
active=$(cat "$state/active")
active=$((active - 1))
printf '%s\n' "$active" >"$state/active"
rmdir "$lock"
exit "$status"
`,
  );
  chmodSync(shim, 0o755);
  return {
    directory,
    state,
    realGit,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function runGitChild(
  root: string,
  shim: GitShim,
  source: string,
  options: {
    largeOutput?: boolean;
    fail?: boolean;
    treeOutput?: string;
    indexOutput?: string;
  } = {},
): any {
  const childSource = `(async () => {
  ${source}
})().catch((error) => {
  process.stderr.write(JSON.stringify({ category: error?.category ?? null, code: error?.code ?? null }));
  process.exitCode = 1;
});`;
  return JSON.parse(
    execFileSync(process.execPath, ["--no-warnings", "--eval", childSource], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shim.directory}${delimiter}${process.env.PATH ?? ""}`,
        WORKFLOW_GIT_REAL: shim.realGit,
        WORKFLOW_GIT_SHIM_STATE: shim.state,
        WORKFLOW_GIT_SHIM_LARGE: options.largeOutput ? "1" : "0",
        WORKFLOW_GIT_SHIM_FAIL: options.fail ? "1" : "0",
        ...(options.treeOutput === undefined
          ? {}
          : { WORKFLOW_GIT_SHIM_TREE_OUTPUT: options.treeOutput }),
        ...(options.indexOutput === undefined
          ? {}
          : { WORKFLOW_GIT_SHIM_INDEX_OUTPUT: options.indexOutput }),
      },
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
}

function runAsyncReviewChild(
  root: string,
  reviewTarget: CommitRangeReviewTarget,
  shim: GitShim,
  options: Parameters<typeof runGitChild>[3] = {},
): any {
  return runGitChild(
    root,
    shim,
    `const { reviewRangeAsync } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), ".codex/workflow-mcp/git.ts")).href)});
  const result = await reviewRangeAsync(${JSON.stringify(root)}, ${JSON.stringify(reviewTarget)});
  process.stdout.write(JSON.stringify(result));`,
    options,
  );
}

function runSyncReviewChild(
  root: string,
  reviewTarget: CommitRangeReviewTarget,
  shim: GitShim,
  options: Parameters<typeof runGitChild>[3] = {},
): any {
  return runGitChild(
    root,
    shim,
    `const { reviewRange } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), ".codex/workflow-mcp/git.ts")).href)});
  const result = reviewRange(${JSON.stringify(root)}, ${JSON.stringify(reviewTarget)});
  process.stdout.write(JSON.stringify(result));`,
    options,
  );
}

function runStagedEntriesChild(
  root: string,
  shim: GitShim,
  asyncAdapter: boolean,
  options: Parameters<typeof runGitChild>[3] = {},
): any {
  const functionName = asyncAdapter ? "stagedEntriesAsync" : "stagedEntries";
  return runGitChild(
    root,
    shim,
    `const { ${functionName} } = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), ".codex/workflow-mcp/git.ts")).href)});
  const result = ${asyncAdapter ? "await stagedEntriesAsync" : "stagedEntries"}(${JSON.stringify(root)});
  process.stdout.write(JSON.stringify([...result.entries()]));`,
    options,
  );
}

function shimCounter(shim: GitShim, name: "active" | "max"): number {
  return Number(readFileSync(join(shim.state, name), "utf8").trim());
}

function childFailureCategory(callback: () => unknown): string {
  try {
    callback();
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    const category = /ERROR_[A-Z_]+/u.exec(stderr)?.[0];
    assert.ok(category, `expected workflow category in child stderr: ${stderr}`);
    return category;
  }
  assert.fail("expected child workflow error");
}

test("verifyRevision accepts commits and rejects invalid, unknown, and non-commit revisions", () => {
  const { root, git, write } = fixture();
  try {
    write("a.txt", "a\n");
    write("b.txt", "b\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const commit = git("rev-parse", "HEAD");
    const blob = git("rev-parse", "HEAD:a.txt");
    assert.equal(verifyRevision(root, commit as GitCommitSha), commit);
    assert.equal(
      errorCategory(() => verifyRevision(root, "abc" as GitCommitSha)),
      "ERROR_INVALID_REVISION",
    );
    assert.equal(
      errorCategory(() => verifyRevision(root, blob as GitCommitSha)),
      "ERROR_INVALID_REVISION",
    );
    assert.equal(
      errorCategory(() => verifyRevision(root, `${"0".repeat(39)}f` as GitCommitSha)),
      "ERROR_INVALID_REVISION",
    );
    assert.equal(
      errorCategory(() => verifyRevision(root, "1234567890ABCDEF" as GitCommitSha)),
      "ERROR_INVALID_REVISION",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repositoryRoot canonicalizes nested paths and symlink aliases", () => {
  const { root } = fixture();
  const alias = mkdtempSync(join(tmpdir(), "workflow-git-alias-"));
  try {
    const nested = join(root, "nested", "path");
    mkdirSync(nested, { recursive: true });
    symlinkSync(root, join(alias, "repository"), "dir");
    assert.equal(repositoryRoot(nested), realpathSync(root));
    assert.equal(repositoryRoot(join(alias, "repository", "nested")), realpathSync(root));
  } finally {
    rmSync(alias, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("verifyRange accepts ancestor ranges and rejects reversed and equal ranges", () => {
  const { root, git, write } = fixture();
  try {
    write("a.txt", "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    write("a.txt", "b\n");
    git("add", "-A");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    assert.deepEqual(verifyRange(root, base as GitCommitSha, head as GitCommitSha), {
      base_revision: base,
      head_revision: head,
    });
    assert.equal(
      errorCategory(() => verifyRange(root, head as GitCommitSha, base as GitCommitSha)),
      "ERROR_NON_ANCESTOR",
    );
    assert.equal(
      errorCategory(() => verifyRange(root, base as GitCommitSha, base as GitCommitSha)),
      "ERROR_INVALID_REVISION",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewRange rejects unknown and non-commit range revisions", () => {
  const { root, git, write } = fixture();
  try {
    write("a.txt", "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    write("a.txt", "b\n");
    git("add", "-A");
    git("commit", "-qm", "head");
    const blob = git("rev-parse", "HEAD:a.txt");
    assert.equal(
      errorCategory(() => reviewRange(root, target(base, `${"0".repeat(40)}`, ["a.txt"]))),
      "ERROR_INVALID_REVISION",
    );
    assert.equal(
      errorCategory(() => reviewRange(root, target(base, blob, ["a.txt"]))),
      "ERROR_INVALID_REVISION",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewRange sync and async APIs preserve classification parity", async () => {
  const { root, git, write } = fixture();
  try {
    write("unchanged.txt", "same\n");
    write("modified.txt", "v1\n");
    write("deleted.txt", "gone\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    write("modified.txt", "v2\n");
    write("added.txt", "new\n");
    git("rm", "-q", "deleted.txt");
    git("add", "-A");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    const reviewTarget = target(base, head, [
      "unchanged.txt",
      "modified.txt",
      "deleted.txt",
      "added.txt",
    ]);
    const result = reviewRange(root, reviewTarget);
    assert.deepEqual(await reviewRangeAsync(root, reviewTarget), result);
    assert.equal(result.base_revision, base);
    assert.equal(result.head_revision, head);
    const byPath: Map<string, any> = new Map(result.paths.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("unchanged.txt").kind, "unchanged");
    assert.equal(byPath.get("modified.txt").kind, "modified");
    assert.equal(byPath.get("deleted.txt").kind, "deleted");
    assert.equal(byPath.get("added.txt").kind, "added");
    assert.equal(byPath.get("unchanged.txt").base.object, byPath.get("unchanged.txt").head.object);
    assert.notEqual(byPath.get("modified.txt").base.object, byPath.get("modified.txt").head.object);
    assert.equal(byPath.get("deleted.txt").head, null);
    assert.equal(byPath.get("added.txt").base, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewRange accepts both rename paths when both are authorized", () => {
  const { root, git, write } = fixture();
  try {
    write("old.txt", "rename\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("mv", "old.txt", "new.txt");
    git("add", "-A");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    const result = reviewRange(root, target(base, head, ["old.txt", "new.txt"]));
    const byPath: Map<string, any> = new Map(result.paths.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get("old.txt").kind, "deleted");
    assert.equal(byPath.get("new.txt").kind, "added");
    assert.equal(byPath.get("old.txt").base.object, byPath.get("new.txt").head.object);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewRange rejects paths absent at both endpoints and unsafe paths", () => {
  const { root, git, write } = fixture();
  try {
    write("a.txt", "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("commit", "-q", "--allow-empty", "-m", "head");
    const head = git("rev-parse", "HEAD");
    assert.equal(
      errorCategory(() => reviewRange(root, target(base, head, ["nope.txt"]))),
      "ERROR_INVALID_REVIEW_PATH",
    );
    assert.equal(
      errorCategory(() => reviewRange(root, target(base, head, ["../escape.txt"]))),
      "ERROR_INVALID_REVIEW_PATH",
    );
    assert.equal(
      errorCategory(() => reviewRange(root, target(base, head, ["/absolute/path.txt"]))),
      "ERROR_INVALID_REVIEW_PATH",
    );
    assert.equal(
      errorCategory(() => reviewRange(root, target(base, head, ["*"]))),
      "ERROR_INVALID_REVIEW_PATH",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewRange rejects directory and submodule paths", () => {
  const { root, git, write } = fixture();
  try {
    write("dir/file.txt", "nested\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const subrepo = mkdtempSync(join(tmpdir(), "workflow-git-sub-"));
    try {
      execFileSync("git", ["-C", subrepo, "init", "-q"], { stdio: "ignore" });
      execFileSync("git", ["-C", subrepo, "config", "user.email", "workflow@example.invalid"], {
        stdio: "ignore",
      });
      execFileSync("git", ["-C", subrepo, "config", "user.name", "Workflow Tests"], {
        stdio: "ignore",
      });
      writeFileSync(join(subrepo, "x.txt"), "x\n");
      execFileSync("git", ["-C", subrepo, "add", "-A"], { stdio: "ignore" });
      execFileSync("git", ["-C", subrepo, "commit", "-qm", "sub"], { stdio: "ignore" });
      const subCommit = execFileSync("git", ["-C", subrepo, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      execFileSync(
        "git",
        ["-C", root, "update-index", "--add", "--cacheinfo", `160000,${subCommit},submod`],
        {
          stdio: "ignore",
        },
      );
      execFileSync("git", ["-C", root, "commit", "-qm", "add submodule"], { stdio: "ignore" });
      const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim();
      assert.equal(
        errorCategory(() => reviewRange(root, target(base, head, ["dir"]))),
        "ERROR_INVALID_REVIEW_PATH",
      );
      assert.equal(reviewRange(root, target(base, head, ["dir/file.txt"])).paths.length, 1);
      assert.equal(
        errorCategory(() => reviewRange(root, target(base, head, ["submod"]))),
        "ERROR_INVALID_REVIEW_PATH",
      );
    } finally {
      rmSync(subrepo, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagedPaths and stagedEntries reflect the full index and staged content", () => {
  const { root, git, write } = fixture();
  try {
    write("mod.txt", "v1\n");
    write("del.txt", "gone\n");
    write("mode.txt", "run\n");
    git("add", ".");
    git("commit", "-qm", "base");
    write("mod.txt", "v2\n");
    write("add.txt", "new\n");
    git("rm", "-q", "del.txt");
    git("add", "mod.txt");
    git("add", "add.txt");
    assert.deepEqual(stagedPaths(root), ["add.txt", "del.txt", "mod.txt"]);
    const entries: Map<string, any> = stagedEntries(root);
    assert.equal(entries.has("add.txt"), true);
    assert.equal(entries.has("mod.txt"), true);
    assert.equal(entries.has("del.txt"), false);
    assert.equal(entries.get("mod.txt").mode, "100644");
    assert.match(entries.get("mod.txt").object, /^[0-9a-f]{40}$/u);
    git("update-index", "--chmod=+x", "mod.txt");
    assert.equal(stagedEntries(root).get("mod.txt" as ExactRepoPath)!.mode, "100755");
    git("commit", "-qm", "second");
    assert.deepEqual(stagedPaths(root), []);
    assert.deepEqual([...stagedEntries(root).keys()].sort(), ["add.txt", "mod.txt", "mode.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stagedPaths preserves both sides of byte-identical renames", () => {
  const { root, git, write } = fixture();
  try {
    write("old.ts", "same\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("mv", "old.ts", "new.ts");

    assert.deepEqual(stagedPaths(root), ["new.ts", "old.ts"]);

    git("config", "diff.renames", "false");
    assert.deepEqual(stagedPaths(root), ["new.ts", "old.ts"]);
    git("config", "diff.renames", "true");
    git("config", "diff.renamelimit", "1");
    assert.deepEqual(stagedPaths(root), ["new.ts", "old.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepare and post-commit verification preserve exact paths for the #42 rename shape", () => {
  const { root, git, write } = fixture();
  try {
    mkdirSync(join(root, ".codex", "agents"), { recursive: true });
    cpSync(
      join(process.cwd(), ".codex", "agents", "change-receipt.ts"),
      join(root, ".codex", "agents", "change-receipt.ts"),
    );
    const oldPaths = Array.from({ length: 15 }, (_, index) => `file-${index}.node.ts`);
    const newPaths = oldPaths.map((path) => path.replace(".node.ts", ".test.ts"));
    for (const path of oldPaths) write(path, "byte-identical\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    for (let index = 0; index < oldPaths.length; index += 1) {
      git("mv", oldPaths[index], newPaths[index]);
    }
    const approvedPaths = [...oldPaths, ...newPaths].sort();
    const receipt = JSON.parse(
      execFileSync(
        process.execPath,
        [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", ...approvedPaths],
        { cwd: root, encoding: "utf8" },
      ),
    );
    const state = {
      review_target: { review_mode: "working_tree" },
      commit_authorization: { user_authorization: "authorized" },
      base_head: base,
      approved_paths: approvedPaths,
      review_receipt: receipt,
    } as unknown as WorkflowState;
    const prepared = prepareCommitReceipt(root, state);
    assert.deepEqual(prepared.expected_paths, approvedPaths);

    git("commit", "-qm", "rename commit");
    const verification = verifyPreparedCommit(root, {
      ...state,
      commit_preparation: {
        ...prepared,
        attempt_id: "00000000-0000-0000-0000-000000000000",
        review_receipt_digest: "0".repeat(64),
        prepared_at: "2026-01-01T00:00:00.000Z",
      },
    } as unknown as WorkflowState);
    assert.equal(verification.category, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("approvedResidue flags untracked and unstaged approved paths only", () => {
  const { root, git, write } = fixture();
  try {
    write("a.txt", "a1\n");
    write("b.txt", "b1\n");
    git("add", ".");
    git("commit", "-qm", "base");
    write("a.txt", "a2\n");
    write("b.txt", "b2\n");
    write("c.txt", "new\n");
    git("add", "a.txt");
    assert.deepEqual(
      approvedResidue(root, ["a.txt", "b.txt", "c.txt"] as ExactRepoPath[], stagedPaths(root)),
      ["b.txt", "c.txt"],
    );
    git("add", "b.txt");
    git("add", "c.txt");
    assert.deepEqual(
      approvedResidue(root, ["a.txt", "b.txt", "c.txt"] as ExactRepoPath[], stagedPaths(root)),
      [],
    );
    write("stray.txt", "x\n");
    assert.deepEqual(
      approvedResidue(root, ["a.txt", "b.txt", "c.txt"] as ExactRepoPath[], stagedPaths(root)),
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeTree returns the current index tree without altering Git state", () => {
  const { root, git, write } = fixture();
  try {
    write("a.txt", "a\n");
    git("add", ".");
    git("commit", "-qm", "base");
    write("a.txt", "b\n");
    git("add", "a.txt");
    const beforeHead = git("rev-parse", "HEAD");
    const beforeStatus = git("status", "--porcelain");
    const tree = writeTree(root);
    assert.match(tree, /^[0-9a-f]{40}$/u);
    assert.equal(git("cat-file", "-t", tree), "tree");
    assert.equal(git("rev-parse", "HEAD"), beforeHead);
    assert.equal(git("status", "--porcelain"), beforeStatus);
    assert.equal(git("diff", "--cached", "--name-only"), "a.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prepareCommitReceipt verifies receipt, staged scope, residue, and staged content", () => {
  const { root, git, write } = fixture();
  try {
    mkdirSync(join(root, ".codex", "agents"), { recursive: true });
    cpSync(
      join(process.cwd(), ".codex", "agents", "change-receipt.ts"),
      join(root, ".codex", "agents", "change-receipt.ts"),
    );
    write("note.txt", "v1\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    const receiptFor = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", "note.txt"],
          { cwd: root, encoding: "utf8" },
        ),
      );
    write("note.txt", "v2\n");
    const receipt = receiptFor();
    const state = {
      review_target: { review_mode: "working_tree" },
      commit_authorization: { user_authorization: "authorized" },
      base_head: base,
      approved_paths: ["note.txt"],
      review_receipt: receipt,
    } as unknown as WorkflowState;
    assert.equal(
      errorCategory(() => prepareCommitReceipt(root, state)),
      "ERROR_STAGED_SCOPE",
    );
    git("add", "note.txt");
    const prepared = prepareCommitReceipt(root, state);
    assert.equal(prepared.prepared_head, base);
    assert.match(prepared.prepared_tree, /^[0-9a-f]{40}$/u);
    assert.deepEqual(prepared.expected_paths, ["note.txt"]);

    const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
      input: "v3\n",
      encoding: "utf8",
    }).trim();
    git("update-index", "--cacheinfo", "100644", blob, "note.txt");
    assert.equal(
      errorCategory(() => prepareCommitReceipt(root, state)),
      "ERROR_STAGED_CONTENT",
    );

    git("add", "note.txt");
    git("update-index", "--chmod=+x", "note.txt");
    assert.equal(
      errorCategory(() => prepareCommitReceipt(root, state)),
      "ERROR_STAGED_CONTENT",
    );

    git("update-index", "--chmod=-x", "note.txt");
    write("note.txt", "v3\n");
    git("add", "note.txt");
    assert.equal(
      errorCategory(() => prepareCommitReceipt(root, state)),
      "ERROR_STALE_RECEIPT",
    );

    assert.equal(
      errorCategory(() =>
        prepareCommitReceipt(root, {
          ...state,
          review_target: { review_mode: "commit_range" },
        } as unknown as WorkflowState),
      ),
      "ERROR_COMMIT_NOT_ALLOWED",
    );
    assert.equal(
      errorCategory(() => prepareCommitReceipt(root, { ...state, commit_authorization: null })),
      "ERROR_STALE_RECEIPT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree porcelain is normalized, sorted, and rejects ambiguous records", () => {
  const parsed = parseWorktreePorcelain(
    `worktree /tmp/worktree-z\nHEAD ${"a".repeat(40)}\nbranch refs/heads/topic/z\nlocked by test\n\nworktree /tmp/worktree-a\nHEAD ${"b".repeat(40)}\ndetached\nprunable missing\n`,
  );
  assert.deepEqual(
    parsed.map((entry) => entry.path),
    ["/private/tmp/worktree-a", "/private/tmp/worktree-z"],
  );
  assert.equal(parsed[0].head, "b".repeat(40));
  assert.equal(parsed[0].detached, true);
  assert.equal(parsed[1].branch, "topic/z");
  assert.equal(parsed[1].locked, true);
  const acceptedBranches = [
    ["/tmp/worktree-nbsp", "topic/\u00a0name"],
    ["/tmp/worktree-emspace", "topic/\u2003name"],
    ["/tmp/worktree-bracket", "topic]name"],
  ];
  for (const [path, branch] of acceptedBranches) {
    const accepted = parseWorktreePorcelain(
      `worktree ${path}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/${branch}\n`,
    );
    assert.equal(accepted[0]?.branch, branch);
  }
  for (const character of [
    " ",
    "\t",
    "\u0001",
    "\u0000",
    "\u007f",
    "~",
    "^",
    ":",
    "?",
    "*",
    "[",
    "\\",
  ]) {
    assert.equal(
      errorCategory(() =>
        parseWorktreePorcelain(
          `worktree /tmp/rejected-${character.charCodeAt(0)}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/topic${character}name\n`,
        ),
      ),
      "ERROR_GIT",
    );
  }
  assert.equal(
    errorCategory(() =>
      parseWorktreePorcelain(`worktree /tmp/a\nHEAD ${"a".repeat(40)}\nHEAD ${"b".repeat(40)}\n`),
    ),
    "ERROR_GIT",
  );
  assert.equal(
    errorCategory(() =>
      parseWorktreePorcelain(`worktree /tmp/a\nHEAD ${"a".repeat(40)}\nbranch main\n`),
    ),
    "ERROR_GIT",
  );
  assert.equal(
    errorCategory(() => parseWorktreePorcelain(`worktree /tmp/a\nHEAD ${"a".repeat(40)}\n`)),
    "ERROR_GIT",
  );
  assert.equal(
    errorCategory(() =>
      parseWorktreePorcelain(
        `worktree /tmp/a\nHEAD ${"a".repeat(40)}\nbranch refs/heads/topic@{upstream}\n`,
      ),
    ),
    "ERROR_GIT",
  );
  assert.equal(
    errorCategory(() =>
      parseWorktreePorcelain(
        `worktree /tmp/a\nHEAD ${"a".repeat(40)}\nbranch refs/heads/topic\u0001bad\n`,
      ),
    ),
    "ERROR_GIT",
  );
  const bare = parseWorktreePorcelain("worktree /tmp/bare\nbare\n");
  assert.equal(bare[0]?.bare, true);
});

test("worktree queries and planning use canonical project-owned values", async () => {
  const { root, git } = fixture();
  const linked = mkdtempSync(join(tmpdir(), "workflow-linked-parent-"));
  const linkedPath = join(linked, "child");
  try {
    git("worktree", "add", "-q", "-b", "topic/linked", linkedPath, "HEAD");
    const entries = await listWorktrees(root);
    assert.equal(entries.length, 2);
    assert.equal((await findWorktreeByBranch(root, "topic/linked")).found, true);
    assert.equal((await findWorktreeByPath(root, linkedPath)).found, true);
    assert.equal((await getMainWorktree(root)).path, realpathSync(root));
    assert.equal((await findCurrentWorktree(root))?.path, realpathSync(root));
    assert.equal((await verifyBranchName(root, "bad..branch")).valid, false);
    assert.equal(await branchExists(root, "topic/linked"), true);
    assert.equal(await branchAvailable(root, "topic/new"), true);
    assert.equal(await branchExists(root, "topic/linked^{commit}"), false);
    assert.equal(await branchAvailable(root, "topic/linked^{commit}"), false);
    const unicodeWhitespaceBranch = "topic/\u00a0name\u2003part";
    git("branch", unicodeWhitespaceBranch);
    assert.equal(await branchExists(root, unicodeWhitespaceBranch), true);
    assert.equal(await branchAvailable(root, unicodeWhitespaceBranch), false);
    assert.equal(await refExists(root, "HEAD"), true);
    const planned = await planWorktree(
      root,
      { path: "planned", workspaceName: "Issue 19", startRef: "HEAD" },
      linked,
    );
    assert.equal(planned.validation.valid, true);
    assert.equal(planned.plan?.directory_name, "Issue-19");
    assert.equal(planned.plan?.branch, "worktree/Issue-19");
    const unsafe = await planWorktree(
      root,
      { path: "../escape", workspaceName: "x", startRef: "HEAD" },
      linked,
    );
    assert.equal(unsafe.plan, null);
    assert.equal(unsafe.validation.valid, false);

    symlinkSync(join(linked, "not-created"), join(linked, "dangling"));
    const occupiedByDanglingSymlink = await planWorktree(
      root,
      { path: "dangling", workspaceName: "x", startRef: "HEAD" },
      linked,
    );
    assert.equal(occupiedByDanglingSymlink.validation.valid, false);
    assert.equal(
      occupiedByDanglingSymlink.validation.issues.some(
        (issue) => issue.category === "path_unavailable",
      ),
      true,
    );

    symlinkSync("loop", join(linked, "loop"));
    assert.equal(
      errorCategory(() => worktreePathExists(join(linked, "loop", "nested"))),
      "ERROR_PATH_ACCESS",
    );
    const unavailableThroughLoop = await planWorktree(
      root,
      { path: "loop/nested", workspaceName: "x", startRef: "HEAD" },
      linked,
    );
    assert.equal(unavailableThroughLoop.validation.valid, false);
    assert.equal(
      unavailableThroughLoop.validation.issues.some(
        (issue) => issue.category === "path_unavailable",
      ),
      true,
    );

    const outside = mkdtempSync(join(tmpdir(), "workflow-outside-root-"));
    try {
      symlinkSync(join(outside, "not-created"), join(linked, "outside-dangling"));
      const unavailableThroughDanglingAncestor = await planWorktree(
        root,
        { path: "outside-dangling/nested", workspaceName: "x", startRef: "HEAD" },
        linked,
      );
      assert.equal(unavailableThroughDanglingAncestor.validation.valid, false);
      assert.equal(unavailableThroughDanglingAncestor.plan, null);
      assert.equal(
        unavailableThroughDanglingAncestor.validation.issues.some(
          (issue) => issue.category === "path_unavailable",
        ),
        true,
      );

      mkdirSync(join(outside, "target"));
      symlinkSync(join(outside, "target"), join(linked, "outside-link"));
      const escapedThroughSymlink = await planWorktree(
        root,
        { path: "outside-link/nested", workspaceName: "x", startRef: "HEAD" },
        linked,
      );
      assert.equal(escapedThroughSymlink.validation.valid, false);
      assert.equal(escapedThroughSymlink.plan, null);
      assert.equal(
        escapedThroughSymlink.validation.issues.some((issue) => issue.category === "invalid_path"),
        true,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test("reviewRangeAsync bounds aggregate Git concurrency and preserves path order", () => {
  const { root, git, write } = fixture();
  const shim = gitShim();
  try {
    const paths = Array.from(
      { length: 200 },
      (_, index) => `file-${String(index).padStart(3, "0")}.txt`,
    );
    for (const path of paths) write(path, `${path}\n`);
    git("add", "-A");
    git("commit", "-qm", "async concurrency base");
    const base = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "async concurrency head");
    const head = git("rev-parse", "HEAD");

    const representativePaths = [paths[19], paths[0], paths[7]] as string[];
    const representative = runAsyncReviewChild(root, target(base, head, representativePaths), shim);
    assert.deepEqual(
      representative.paths.map((entry: { path: string }) => entry.path),
      [...representativePaths].sort(),
    );
    assert.equal(shimCounter(shim, "active"), 0);

    const maximum = runAsyncReviewChild(root, target(base, head, paths), shim);
    assert.deepEqual(
      maximum.paths.map((entry: { path: string }) => entry.path),
      paths,
    );
    assert.equal(shimCounter(shim, "max"), 4);
    assert.equal(shimCounter(shim, "active"), 0);
  } finally {
    shim.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("async raw Git rejects oversized textual output at collection time", () => {
  const { root, git, write } = fixture();
  const shim = gitShim();
  try {
    write("note.txt", "before\n");
    git("add", "note.txt");
    git("commit", "-qm", "async size base");
    const base = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "async size head");
    const head = git("rev-parse", "HEAD");
    let failure: { stderr?: string } | undefined;
    try {
      runAsyncReviewChild(root, target(base, head, ["note.txt"]), shim, { largeOutput: true });
    } catch (error) {
      failure = error as { stderr?: string };
    }
    assert.ok(failure);
    assert.match(failure.stderr ?? "", /ERROR_GIT_SIZE/u);

    const normal = runAsyncReviewChild(root, target(base, head, ["note.txt"]), shim);
    assert.equal(normal.paths[0].path, "note.txt");
  } finally {
    shim.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync and async tree adapters share malformed, absent, and mode failures", () => {
  const { root, git, write } = fixture();
  const shim = gitShim();
  try {
    write("fixture.txt", "content\n");
    git("add", "fixture.txt");
    git("commit", "-qm", "tree parser base");
    const base = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "tree parser head");
    const head = git("rev-parse", "HEAD");
    const reviewTarget = target(base, head, ["fixture.txt"]);
    const cases = [
      ["missing tab", "100644 blob object", "ERROR_INVALID_REVIEW_PATH"],
      [
        "extra metadata",
        "100644 blob object extra\\tfixture.txt\\x00",
        "ERROR_INVALID_REVIEW_PATH",
      ],
      ["absent", "", "ERROR_INVALID_REVIEW_PATH"],
      ["unsupported mode", "100664 blob object\\tfixture.txt\\x00", "ERROR_UNSUPPORTED_MODE"],
    ] as const;
    for (const [, output, expected] of cases) {
      assert.equal(
        childFailureCategory(() =>
          runSyncReviewChild(root, reviewTarget, shim, { treeOutput: output }),
        ),
        expected,
      );
      assert.equal(
        childFailureCategory(() =>
          runAsyncReviewChild(root, reviewTarget, shim, { treeOutput: output }),
        ),
        expected,
      );
    }
    const firstRecordOnly = "100644 blob object\\tfixture.txt\\x00malformed metadata";
    const expectedReview = {
      base_revision: base,
      head_revision: head,
      paths: [
        {
          path: "fixture.txt",
          kind: "unchanged",
          base: { mode: "100644", object: "object" },
          head: { mode: "100644", object: "object" },
        },
      ],
    };
    assert.deepEqual(
      runSyncReviewChild(root, reviewTarget, shim, { treeOutput: firstRecordOnly }),
      expectedReview,
    );
    assert.deepEqual(
      runAsyncReviewChild(root, reviewTarget, shim, { treeOutput: firstRecordOnly }),
      expectedReview,
    );
    assert.equal(
      childFailureCategory(() => runSyncReviewChild(root, reviewTarget, shim, { fail: true })),
      "ERROR_GIT",
    );
    assert.equal(
      childFailureCategory(() => runAsyncReviewChild(root, reviewTarget, shim, { fail: true })),
      "ERROR_GIT",
    );
  } finally {
    shim.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sync and async staged-entry adapters preserve filtering, overwrites, and modes", () => {
  const { root } = fixture();
  const shim = gitShim();
  try {
    const objectA = "a".repeat(40);
    const objectB = "b".repeat(40);
    const output = [
      "",
      "malformed",
      `100644 ${objectA} 1\\tignored.txt`,
      `100644 ${objectA} 0\\tz.txt`,
      `100755 ${objectB} 0\\tmode.txt`,
      `120000 ${objectA} 0\\tlink.txt`,
      `100644 ${objectA} 0\\tz.txt`,
      "",
    ].join("\\x00");
    const expected = [
      ["z.txt", { mode: "100644", object: objectA }],
      ["mode.txt", { mode: "100755", object: objectB }],
      ["link.txt", { mode: "120000", object: objectA }],
    ];
    const syncEntries = runStagedEntriesChild(root, shim, false, { indexOutput: output });
    assert.deepEqual(syncEntries, expected);
    assert.deepEqual(runStagedEntriesChild(root, shim, true, { indexOutput: output }), expected);
    const unsupported = `160000 ${objectA} 0\\tgitlink`;
    assert.equal(
      childFailureCategory(() =>
        runStagedEntriesChild(root, shim, false, { indexOutput: unsupported }),
      ),
      "ERROR_UNSUPPORTED_MODE",
    );
    assert.equal(
      childFailureCategory(() =>
        runStagedEntriesChild(root, shim, true, { indexOutput: unsupported }),
      ),
      "ERROR_UNSUPPORTED_MODE",
    );
  } finally {
    shim.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

test("async raw Git compatibility preserves exact ranges, NUL paths, and index trees", async () => {
  const { root, git, write } = fixture();
  try {
    write("async.txt", "one\n");
    git("add", "async.txt");
    git("commit", "-qm", "async base");
    const base = git("rev-parse", "HEAD") as GitCommitSha;
    write("async.txt", "two\n");
    write("async-add.txt", "add\n");
    git("add", "-A");
    const staged = await stagedPathsAsync(root);
    assert.deepEqual(staged, ["async-add.txt", "async.txt"]);
    assert.equal((await stagedEntriesAsync(root)).has("async-add.txt" as ExactRepoPath), true);
    const tree = await writeTreeAsync(root);
    assert.match(tree, /^[0-9a-f]{40}$/u);
    git("commit", "-qm", "async head");
    const head = git("rev-parse", "HEAD") as GitCommitSha;
    assert.deepEqual(await verifyRangeAsync(root, base, head), {
      base_revision: base,
      head_revision: head,
    });
    const range = await reviewRangeAsync(root, target(base, head, ["async.txt", "async-add.txt"]));
    assert.deepEqual(
      range.paths.map((entry) => [entry.path, entry.kind]),
      [
        ["async-add.txt", "added"],
        ["async.txt", "modified"],
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
