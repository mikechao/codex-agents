import { Database } from "bun:sqlite";
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";

function unsupportedDatabase(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE unrelated (value TEXT NOT NULL);");
  db.close();
}

function sameColumnsWithoutInvariants(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      parent_capability_hash TEXT NOT NULL,
      implementer_capability_hash TEXT NOT NULL,
      reviewer_capability_hash TEXT NOT NULL,
      committer_capability_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.close();
}

function category(callback: () => void): string {
  try {
    callback();
  } catch (error) {
    assert.ok(error instanceof WorkflowError);
    return error.category;
  }
  assert.fail("expected workflow error");
}

test("rejects incompatible SQLite tables without upgrading or mutating them", () => {
  const root = fixture();
  const path = join(root.root, "state.sqlite");
  try {
    unsupportedDatabase(path);
    const before = readFileSync(path);
    const result = category(
      () => new WorkflowStore({ repositoryRoot: root.root, databasePath: path }),
    );
    assert.equal(result, "ERROR_MIGRATION_REQUIRED");
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("rejects unrelated tables alongside the current schema without mutating the database", () => {
  const root = fixture();
  const path = join(root.root, "state.sqlite");
  try {
    const store = new WorkflowStore({ repositoryRoot: root.root, databasePath: path });
    store.close();
    const db = new Database(path);
    db.exec("CREATE TABLE unrelated (value TEXT NOT NULL);");
    db.prepare("INSERT INTO unrelated (value) VALUES (?)").run("preserve me");
    db.close();
    const before = readFileSync(path);
    assert.equal(
      category(() => new WorkflowStore({ repositoryRoot: root.root, databasePath: path })),
      "ERROR_MIGRATION_REQUIRED",
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("rejects matching columns with missing indexes and foreign-key constraints", () => {
  const root = fixture();
  const path = join(root.root, "state.sqlite");
  try {
    sameColumnsWithoutInvariants(path);
    const before = readFileSync(path);
    assert.equal(
      category(() => new WorkflowStore({ repositoryRoot: root.root, databasePath: path })),
      "ERROR_MIGRATION_REQUIRED",
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("rejects the current tables when the required audit index is missing", () => {
  const root = fixture();
  const path = join(root.root, "state.sqlite");
  try {
    const store = new WorkflowStore({ repositoryRoot: root.root, databasePath: path });
    store.close();
    const db = new Database(path);
    db.exec("DROP INDEX audit_events_workflow;");
    db.close();
    const before = readFileSync(path);
    assert.equal(
      category(() => new WorkflowStore({ repositoryRoot: root.root, databasePath: path })),
      "ERROR_MIGRATION_REQUIRED",
    );
    assert.deepEqual(readFileSync(path), before);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("rejects an incompatible persisted state schema without rewriting its row", () => {
  const root = fixture();
  const path = join(root.root, "state.sqlite");
  try {
    const store = new WorkflowStore({ repositoryRoot: root.root, databasePath: path });
    const created = store.create({
      workflow_type: "change",
      objective: "schema rejection",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["state is rejected"],
      validation_requirements: ["startup"],
      review_target: {
        review_mode: "working_tree",
        base_revision: root.git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    store.close();
    const db = new Database(path);
    const row = db.prepare("SELECT state_json, state_digest FROM workflows").get() as {
      state_json: string;
      state_digest: string;
    };
    const state = JSON.parse(row.state_json) as Record<string, unknown>;
    state.schema_version = 1;
    const stateJson = JSON.stringify(state);
    db.prepare("UPDATE workflows SET state_json = ?, state_digest = ?").run(
      stateJson,
      objectDigest(state),
    );
    db.close();
    const before = new Database(path)
      .prepare("SELECT version, state_json, state_digest FROM workflows")
      .all();
    assert.equal(
      category(() => new WorkflowStore({ repositoryRoot: root.root, databasePath: path })),
      "ERROR_MIGRATION_REQUIRED",
    );
    const afterDb = new Database(path);
    const after = afterDb.prepare("SELECT version, state_json, state_digest FROM workflows").all();
    afterDb.close();
    assert.deepEqual(after, before);
    assert.equal(created.workflow.schema_version, 2);
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("rejects current-schema digest corruption distinctly", () => {
  const root = fixture();
  const path = join(root.root, "state.sqlite");
  try {
    const store = new WorkflowStore({ repositoryRoot: root.root, databasePath: path });
    store.create({
      workflow_type: "change",
      objective: "digest rejection",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["state is corrupt"],
      validation_requirements: ["startup"],
      review_target: {
        review_mode: "working_tree",
        base_revision: root.git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    store.close();
    const db = new Database(path);
    db.prepare("UPDATE workflows SET state_digest = ?").run("0".repeat(64));
    db.close();
    assert.equal(
      category(() => new WorkflowStore({ repositoryRoot: root.root, databasePath: path })),
      "ERROR_STATE_CORRUPT",
    );
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});

test("fresh current-schema stores start with no migration audit behavior", () => {
  const root = fixture();
  const path = join(mkdtempSync(join(tmpdir(), "fresh-store-")), "state.sqlite");
  try {
    const store = new WorkflowStore({ repositoryRoot: root.root, databasePath: path });
    const created = store.create({
      workflow_type: "change",
      objective: "fresh state",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["created"],
      validation_requirements: ["startup"],
      review_target: {
        review_mode: "working_tree",
        base_revision: root.git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    assert.equal(created.workflow.schema_version, 2);
    const events = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent);
    assert.deepEqual(
      events.map((event) => event.event_type),
      ["WORKFLOW_CREATED"],
    );
    store.close();
  } finally {
    rmSync(root.root, { recursive: true, force: true });
  }
});
