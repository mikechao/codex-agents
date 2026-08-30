import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createReceipt, safePaths } from "../change-receipt.js";

const utility = resolve(import.meta.dirname, "..", "change-receipt.ts");

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

interface ReceiptEntry {
  path: string;
  state: string;
  kind: string;
  mode?: string;
  digest?: string;
}

interface Receipt {
  schema_version: number;
  base_head: string;
  approved_paths: string[];
  paths: ReceiptEntry[];
  overall_scope_hash: string;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "change-receipt-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "receipt-tests@example.invalid");
  git(root, "config", "user.name", "Receipt Tests");
  return root;
}

function commit(root: string, message = "fixture"): void {
  git(root, "add", "--", ".");
  git(root, "commit", "-qm", message);
}

function run(root: string, paths: string[]): RunResult {
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

function runWithFlags(root: string, flags: string[], paths: string[]): RunResult {
  const result = spawnSync(process.execPath, [utility, ...flags, "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function receipt(root: string, paths: string[]): Receipt {
  const result = run(root, paths);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as Receipt;
}

function withRepository(callback: (root: string) => void): void {
  const root = repository();
  try {
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function udsUnsupported(): Promise<boolean> {
  if (process.platform === "win32") return true;
  const dir = mkdtempSync(join(tmpdir(), "uds-probe-"));
  const server = createServer();
  const socketPath = join(dir, "socket");
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    listening = true;
    return false;
  } catch (error) {
    if (isErrno(error, "EPERM") || isErrno(error, "ENOSYS")) return true;
    throw error;
  } finally {
    if (listening) await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(socketPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}

const skipIfUdsUnsupported = test.skipIf(await udsUnsupported());

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
    assert.match(String(result.paths[0].digest), /^[0-9a-f]{64}$/u);
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

test("reports an explicitly allowed absent path with no mode or digest", () => {
  withRepository((root) => {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    const result = runWithFlags(root, ["--allow-absent"], ["not-present.txt"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as Receipt;
    assert.deepEqual(parsed.paths[0], {
      path: "not-present.txt",
      state: "absent",
      kind: "missing",
    });
    assert.equal("mode" in parsed.paths[0], false);
    assert.equal("digest" in parsed.paths[0], false);
  });
});

const skipOnWindows = test.skipIf(process.platform === "win32");

skipOnWindows("handles symlinks and changes to their link targets", () => {
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

skipOnWindows(
  "rejects a path nested under an escaping symlink parent regardless of leaf existence",
  () => {
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
  },
);

test("validates path safety independently of repository inspection", () => {
  const root = mkdtempSync(join(tmpdir(), "change-receipt-safety-"));
  try {
    assert.deepEqual(safePaths(root, ["b/c", "a", "d"]), ["a", "b/c", "d"]);
    assert.throws(() => safePaths(root, []), { message: "ERROR_EMPTY_PATHS" });
    assert.throws(() => safePaths(root, ["../outside.txt"]), { message: "ERROR_UNSAFE_PATH" });
    assert.throws(() => safePaths(root, [resolve(root, "note.txt")]), {
      message: "ERROR_UNSAFE_PATH",
    });
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

test("unrelated untracked files do not affect an approved-path receipt", () => {
  withRepository((root) => {
    writeFileSync(join(root, "approved.txt"), "approved\n");
    commit(root);
    const before = receipt(root, ["approved.txt"]);
    writeFileSync(join(root, "notes.txt"), "stale reference\n");
    const withNotes = receipt(root, ["approved.txt"]);
    assert.deepEqual(withNotes, before);
    writeFileSync(join(root, "notes.txt"), "different stale reference\n");
    assert.deepEqual(receipt(root, ["approved.txt"]), before);
  });
});

test("reads tracked blobs larger than four MiB", () => {
  withRepository((root) => {
    const content = Buffer.alloc(4 * 1024 * 1024 + 1, 0x5a);
    writeFileSync(join(root, "large.bin"), content);
    commit(root);
    const result = receipt(root, ["large.bin"]);
    assert.equal(result.paths[0].state, "unchanged");
    assert.equal(result.paths[0].digest, createHash("sha256").update(content).digest("hex"));
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

test("library emits the absent entry only with allowAbsent opt-in", () => {
  withRepository((root) => {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    assert.throws(() => createReceipt(["new/file.txt"], root), { message: "ERROR_UNTRACKED_PATH" });
    assert.throws(() => createReceipt(["new/file.txt"], root, { allowAbsent: false }), {
      message: "ERROR_UNTRACKED_PATH",
    });
    const absentReceipt = createReceipt(["new/file.txt"], root, { allowAbsent: true });
    assert.deepEqual(absentReceipt.paths, [
      { path: "new/file.txt", state: "absent", kind: "missing" },
    ]);
    assert.equal("mode" in absentReceipt.paths[0], false);
    assert.equal("digest" in absentReceipt.paths[0], false);
  });
});

test("library rejects unknown or non-boolean options", () => {
  withRepository((root) => {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    const invalid: unknown[] = [
      null,
      true,
      [],
      { allowAbsent: "yes" },
      { allowAbsent: 1 },
      { bogus: true },
    ];
    for (const options of invalid) {
      assert.throws(
        () => createReceipt(["tracked.txt"], root, options as Record<string, unknown>),
        {
          message: "ERROR_INVALID_ARGUMENTS",
        },
      );
    }
    const normalReceipt = createReceipt(["tracked.txt"], root, {});
    assert.equal(normalReceipt.paths[0].state, "unchanged");
  });
});

test("absent entries sort with present paths and keep the hash deterministic", () => {
  withRepository((root) => {
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "b.txt"), "b\n");
    commit(root);
    const first = createReceipt(["b.txt", "new/z.txt", "a.txt"], root, { allowAbsent: true });
    const second = createReceipt(["a.txt", "new/z.txt", "b.txt"], root, { allowAbsent: true });
    assert.deepEqual(first, second);
    assert.deepEqual(first.approved_paths, ["a.txt", "b.txt", "new/z.txt"]);
    assert.deepEqual(
      first.paths.map((entry) => entry.path),
      ["a.txt", "b.txt", "new/z.txt"],
    );
    assert.deepEqual(
      first.paths.find((entry) => entry.path === "new/z.txt"),
      { path: "new/z.txt", state: "absent", kind: "missing" },
    );
    assert.equal(first.overall_scope_hash, second.overall_scope_hash);
    const third = createReceipt(["b.txt", "new/z.txt", "a.txt", "other/missing.txt"], root, {
      allowAbsent: true,
    });
    assert.notEqual(first.overall_scope_hash, third.overall_scope_hash);
  });
});

test("allowAbsent keeps tracked deletions as deleted, never absent", () => {
  withRepository((root) => {
    writeFileSync(join(root, "gone.txt"), "gone\n");
    commit(root);
    unlinkSync(join(root, "gone.txt"));
    const result = runWithFlags(root, ["--allow-absent"], ["gone.txt"]);
    assert.equal(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(parsed.paths, [
      { path: "gone.txt", state: "deleted", kind: "missing", mode: "100644" },
    ]);
  });
});

test("CLI opt-in emits absent entries while default calls reject them", () => {
  withRepository((root) => {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    const rejected = run(root, ["future.txt"]);
    assert.notEqual(rejected.status, 0);
    assert.equal(rejected.stderr, "ERROR_UNTRACKED_PATH");
    assert.equal(rejected.stdout, "");

    const result = runWithFlags(root, ["--allow-absent"], ["future.txt"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(parsed.paths, [{ path: "future.txt", state: "absent", kind: "missing" }]);
    assert.equal(parsed.base_head, git(root, "rev-parse", "HEAD"));
  });
});

test("CLI rejects duplicate or unknown flags and paths before the separator", () => {
  withRepository((root) => {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    const scenarios = [
      { flags: ["--allow-absent", "--allow-absent"], paths: ["tracked.txt"] },
      { flags: ["--unknown"], paths: ["tracked.txt"] },
      { flags: ["tracked.txt"], paths: ["tracked.txt"] },
      { flags: ["--allow-absent", "--unknown"], paths: ["tracked.txt"] },
    ];
    for (const scenario of scenarios) {
      const result = runWithFlags(root, scenario.flags, scenario.paths);
      assert.notEqual(result.status, 0, JSON.stringify(scenario));
      assert.equal(result.stderr, "ERROR_INVALID_ARGUMENTS", JSON.stringify(scenario));
      assert.equal(result.stdout, "", JSON.stringify(scenario));
    }
  });
});

skipIfUdsUnsupported("rejects unsupported Unix-domain socket filesystem objects", async () => {
  const root = repository();
  const socketPath = join(root, "socket");
  const server = createServer();
  let listening = false;
  try {
    writeFileSync(join(root, "tracked.txt"), "tracked\n");
    commit(root);
    await new Promise<void>((listenResolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, listenResolve);
    });
    listening = true;
    const result = run(root, ["socket"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stderr, "ERROR_UNSUPPORTED_FILE_TYPE");
  } finally {
    if (listening) await new Promise((resolveClose) => server.close(resolveClose));
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
