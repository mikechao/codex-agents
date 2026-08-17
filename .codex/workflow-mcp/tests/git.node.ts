import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import {
  approvedResidue,
  prepareCommitReceipt,
  repositoryRoot,
  reviewRange,
  stagedEntries,
  stagedPaths,
  verifyRange,
  verifyRevision,
  writeTree,
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

test("reviewRange classifies unchanged, added, deleted, and modified paths", () => {
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
    const result = reviewRange(
      root,
      target(base, head, ["unchanged.txt", "modified.txt", "deleted.txt", "added.txt"]),
    );
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
