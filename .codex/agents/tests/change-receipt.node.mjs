import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { safePaths } from "../change-receipt.mjs";

const utility = resolve(import.meta.dirname, "..", "change-receipt.mjs");

function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function repository() {
  const root = mkdtempSync(join(tmpdir(), "change-receipt-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "receipt-tests@example.invalid");
  git(root, "config", "user.name", "Receipt Tests");
  return root;
}

function commit(root, message = "fixture") {
  git(root, "add", "--", ".");
  git(root, "commit", "-qm", message);
}

function run(root, paths) {
  const result = spawnSync(process.execPath, [utility, "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function receipt(root, paths) {
  const result = run(root, paths);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function withRepository(callback) {
  const root = repository();
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("reports modified tracked content and remains stable across git add", () => {
  withRepository((root) => {
    writeFileSync(join(root, "note.md"), "before\n");
    commit(root);
    writeFileSync(join(root, "note.md"), "after\n");

    const beforeStage = receipt(root, ["note.md"]);
    assert.equal(beforeStage.paths[0].state, "modified");
    assert.equal(beforeStage.paths[0].kind, "file");
    assert.equal(beforeStage.paths[0].mode, "100644");
    git(root, "add", "--", "note.md");
    assert.deepEqual(receipt(root, ["note.md"]), beforeStage);
  });
});

test("reports new untracked content with a content digest", () => {
  withRepository((root) => {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    writeFileSync(join(root, "new.txt"), "new\n");
    const result = receipt(root, ["new.txt"]);
    assert.equal(result.paths[0].state, "added");
    assert.equal(result.paths[0].kind, "file");
    assert.match(result.paths[0].digest, /^[0-9a-f]{64}$/u);
  });
});

test("reports deletion using HEAD metadata without a digest", () => {
  withRepository((root) => {
    writeFileSync(join(root, "gone.txt"), "gone\n");
    commit(root);
    unlinkSync(join(root, "gone.txt"));
    const result = receipt(root, ["gone.txt"]);
    assert.equal(result.paths[0].state, "deleted");
    assert.equal(result.paths[0].kind, "missing");
    assert.equal(result.paths[0].mode, "100644");
    assert.equal("digest" in result.paths[0], false);
  });
});

test("handles symlinks and changes to their link targets", { skip: process.platform === "win32" }, () => {
  withRepository((root) => {
    writeFileSync(join(root, "target.txt"), "target\n");
    symlinkSync("target.txt", join(root, "link.txt"));
    commit(root);
    const original = receipt(root, ["link.txt"]);
    assert.equal(original.paths[0].state, "unchanged");
    assert.equal(original.paths[0].kind, "symlink");
    assert.equal(original.paths[0].mode, "120000");
    unlinkSync(join(root, "link.txt"));
    symlinkSync("other.txt", join(root, "link.txt"));
    const changed = receipt(root, ["link.txt"]);
    assert.equal(changed.paths[0].state, "modified");
    assert.notEqual(changed.paths[0].digest, original.paths[0].digest);
  });
});

test("rejects a path nested under an escaping symlink parent regardless of leaf existence", { skip: process.platform === "win32" }, () => {
  withRepository((root) => {
    writeFileSync(join(root, "base.txt"), "base\n");
    commit(root);
    const outside = mkdtempSync(join(tmpdir(), "change-receipt-outside-"));
    try {
      writeFileSync(join(outside, "present.txt"), "present\n");
      symlinkSync(outside, join(root, "escape"));
      for (const path of ["escape/present.txt", "escape/missing.txt"]) {
        const result = run(root, [path]);
        assert.notEqual(result.status, 0, path);
        assert.equal(result.stderr, "ERROR_UNSAFE_PATH", path);
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

test("validates path safety independently of repository inspection", () => {
  const root = mkdtempSync(join(tmpdir(), "change-receipt-safety-"));
  try {
    assert.deepEqual(safePaths(root, ["b/c", "a", "d"]), ["a", "b/c", "d"]);
    assert.throws(() => safePaths(root, []), { message: "ERROR_EMPTY_PATHS" });
    assert.throws(() => safePaths(root, ["../outside.txt"]), { message: "ERROR_UNSAFE_PATH" });
    assert.throws(() => safePaths(root, [resolve(root, "note.txt")]), { message: "ERROR_UNSAFE_PATH" });
    assert.throws(() => safePaths(root, ["a", "./a"]), { message: "ERROR_DUPLICATE_PATH" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("sorts paths and is deterministic regardless of argument order", () => {
  withRepository((root) => {
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "b.txt"), "b\n");
    commit(root);
    writeFileSync(join(root, "a.txt"), "changed a\n");
    writeFileSync(join(root, "b.txt"), "changed b\n");
    const first = receipt(root, ["b.txt", "a.txt"]);
    const second = receipt(root, ["a.txt", "b.txt"]);
    assert.deepEqual(first, second);
    assert.deepEqual(first.approved_paths, ["a.txt", "b.txt"]);
  });
});

test("changes the digest and scope hash when content changes", () => {
  withRepository((root) => {
    writeFileSync(join(root, "note.txt"), "one\n");
    commit(root);
    const first = receipt(root, ["note.txt"]);
    writeFileSync(join(root, "note.txt"), "two\n");
    const second = receipt(root, ["note.txt"]);
    assert.notEqual(first.paths[0].digest, second.paths[0].digest);
    assert.notEqual(first.overall_scope_hash, second.overall_scope_hash);
  });
});

test("reads tracked blobs larger than four MiB", () => {
  withRepository((root) => {
    const content = Buffer.alloc(4 * 1024 * 1024 + 1, 0x5a);
    writeFileSync(join(root, "large.bin"), content);
    commit(root);
    const result = receipt(root, ["large.bin"]);
    assert.equal(result.paths[0].state, "unchanged");
    assert.equal(
      result.paths[0].digest,
      createHash("sha256").update(content).digest("hex"),
    );
  });
});

test("rejects unsafe, invalid, directory, and absent paths", () => {
  withRepository((root) => {
    writeFileSync(join(root, "note.txt"), "note\n");
    mkdirSync(join(root, "folder"));
    commit(root);
    const invalid = [
      { paths: [], error: "ERROR_EMPTY_PATHS" },
      { paths: ["note.txt", "./note.txt"], error: "ERROR_DUPLICATE_PATH" },
      { paths: ["../outside.txt"], error: "ERROR_UNSAFE_PATH" },
      { paths: [resolve(root, "note.txt")], error: "ERROR_UNSAFE_PATH" },
      { paths: ["folder"], error: "ERROR_DIRECTORY_PATH" },
      { paths: ["missing.txt"], error: "ERROR_UNTRACKED_PATH" },
    ];
    for (const scenario of invalid) {
      const result = run(root, scenario.paths);
      assert.notEqual(result.status, 0, scenario.error);
      assert.equal(result.stderr, scenario.error);
    }
  });
});

test("requires a repository with an existing HEAD", () => {
  const root = repository();
  try {
    writeFileSync(join(root, "pending.txt"), "pending\n");
    const result = run(root, ["pending.txt"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "ERROR_NO_HEAD");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects unsupported Unix-domain socket filesystem objects", { skip: process.platform === "win32" }, async (context) => {
  const root = repository();
  const socketPath = join(root, "socket");
  const server = createServer();
  let listening = false;
  try {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
    } catch (error) {
      if (error && typeof error === "object" && (error.code === "EPERM" || error.code === "ENOSYS")) {
        context.skip("Unix-domain sockets are unavailable in this environment");
        return;
      }
      throw error;
    }
    listening = true;
    const result = run(root, ["socket"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "ERROR_UNSUPPORTED_FILE_TYPE");
  } finally {
    if (listening) await new Promise((resolve) => server.close(resolve));
    rmSync(socketPath, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not include source contents in the receipt", () => {
  withRepository((root) => {
    writeFileSync(join(root, "private.txt"), "PRIVATE_SENTINEL_CONTENT\n");
    commit(root);
    const result = run(root, ["private.txt"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.includes(readFileSync(join(root, "private.txt"), "utf8")), false);
  });
});
