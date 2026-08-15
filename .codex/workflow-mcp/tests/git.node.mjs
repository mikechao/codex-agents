import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkflowError } from "../errors.mjs";
import { reviewRange, verifyRange, verifyRevision } from "../git.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-git-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "workflow@example.invalid");
  git("config", "user.name", "Workflow Tests");
  const write = (path, content) => {
    const directory = join(root, path.split("/").slice(0, -1).join("/"));
    if (directory !== root) mkdirSync(directory, { recursive: true });
    writeFileSync(join(root, path), content);
  };
  return { root, git, write };
}

function errorCategory(callback) {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof WorkflowError);
    return error.category;
  }
  assert.fail("expected workflow error");
}

function target(base, head, paths) {
  return { base_revision: base, head_revision: head, approved_paths: paths };
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
    assert.equal(verifyRevision(root, commit), commit);
    assert.equal(errorCategory(() => verifyRevision(root, "abc")), "ERROR_INVALID_REVISION");
    assert.equal(errorCategory(() => verifyRevision(root, blob)), "ERROR_INVALID_REVISION");
    assert.equal(
      errorCategory(() => verifyRevision(root, `${"0".repeat(39)}f`)),
      "ERROR_INVALID_REVISION",
    );
    assert.equal(
      errorCategory(() => verifyRevision(root, "1234567890ABCDEF")),
      "ERROR_INVALID_REVISION",
    );
  } finally {
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
    assert.deepEqual(verifyRange(root, base, head), { base_revision: base, head_revision: head });
    assert.equal(errorCategory(() => verifyRange(root, head, base)), "ERROR_NON_ANCESTOR");
    assert.equal(errorCategory(() => verifyRange(root, base, base)), "ERROR_INVALID_REVISION");
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
    const head = git("rev-parse", "HEAD");
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
    const byPath = new Map(result.paths.map((entry) => [entry.path, entry]));
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
    const byPath = new Map(result.paths.map((entry) => [entry.path, entry]));
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
      execFileSync("git", ["-C", root, "update-index", "--add", "--cacheinfo", `160000,${subCommit},submod`], {
        stdio: "ignore",
      });
      execFileSync("git", ["-C", root, "commit", "-qm", "add submodule"], { stdio: "ignore" });
      const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
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