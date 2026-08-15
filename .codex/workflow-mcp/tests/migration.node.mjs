import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { WorkflowError } from "../errors.mjs";
import { WorkflowStore } from "../store.mjs";
import { hashCapability, issueCapability, objectDigest } from "../validation.mjs";

function v1State(overrides = {}) {
  return {
    schema_version: 1,
    version: 0,
    workflow_id: randomUUID(),
    phase: "IMPLEMENTING",
    objective: "legacy objective",
    base_head: "a".repeat(40),
    approved_paths: ["note.txt"],
    repair_cycle: 0,
    max_repair_cycles: 2,
    parent_workflow_id: null,
    implementation_summary: null,
    implementation_status: null,
    implementation_changed_paths: [],
    implementation_acceptance_evidence: [],
    implementation_validation_evidence: [],
    implementation_receipt: null,
    implementation_known_failures: [],
    finding_resolution_map: {},
    prior_finding_classifications: {},
    blocking_findings: [],
    optional_findings: [],
    review_receipt: null,
    commit_authorization: null,
    commit_result: null,
    repair_authorized_ids: [],
    authorized_optional_ids: [],
    user_authorization_summary: null,
    ...overrides,
  };
}

function createV1Database(path, states, audits = []) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
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
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    );
    CREATE INDEX audit_events_workflow ON audit_events(workflow_id, event_id);
  `);
  const insertWorkflow = db.prepare(
    "INSERT INTO workflows (workflow_id, version, state_json, parent_capability_hash, implementer_capability_hash, reviewer_capability_hash, committer_capability_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertAudit = db.prepare(
    "INSERT INTO audit_events (workflow_id, version, event_type, actor_role, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const issued = new Map();
  for (const state of states) {
    const capabilities = {
      parent: issueCapability(),
      implementer: issueCapability(),
      reviewer: issueCapability(),
      committer: issueCapability(),
    };
    issued.set(state.workflow_id, capabilities);
    insertWorkflow.run(
      state.workflow_id,
      state.version,
      JSON.stringify(state),
      hashCapability(capabilities.parent),
      hashCapability(capabilities.implementer),
      hashCapability(capabilities.reviewer),
      hashCapability(capabilities.committer),
      "2024-01-01T00:00:00.000Z",
      "2024-01-01T00:00:00.000Z",
    );
  }
  for (const event of audits) {
    insertAudit.run(
      event.workflow_id,
      event.version,
      event.event_type,
      event.actor_role,
      event.summary_json,
      event.created_at,
    );
  }
  db.close();
  return issued;
}

function rawAudits(path) {
  const db = new DatabaseSync(path);
  const rows = db
    .prepare(
      "SELECT event_id, workflow_id, version, event_type, actor_role, summary_json, created_at FROM audit_events ORDER BY event_id",
    )
    .all();
  db.close();
  return rows;
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

function blocker() {
  return {
    finding_id: "BLK-1",
    severity: "P1",
    blocking: true,
    file_and_line: "note.txt:1",
    failure_scenario: "fails",
    impact: "bad",
    violated_requirement: "safe",
    remediation: "fix",
    missing_or_inadequate_test: "test",
  };
}

test("migrates a single v1 row to complete v2 state in one transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-single-"));
  try {
    const path = join(root, "state.sqlite");
    const state = v1State({
      version: 3,
      phase: "REVIEWING",
      implementation_summary: "legacy implementation",
      implementation_status: "DONE",
      implementation_changed_paths: ["note.txt"],
      implementation_acceptance_evidence: ["accepted"],
      implementation_validation_evidence: ["validated"],
      implementation_receipt: { base_head: "a".repeat(40) },
      implementation_known_failures: ["flaky"],
      finding_resolution_map: { "BLK-1": "resolved" },
    });
    const issued = createV1Database(path, [state]);
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const migrated = store.get(state.workflow_id, "parent", issued.get(state.workflow_id).parent);
    assert.equal(migrated.schema_version, 2);
    assert.equal(migrated.version, 4);
    assert.equal(migrated.workflow_type, "change");
    assert.equal(migrated.legacy_v1, true);
    assert.equal(migrated.phase, "REVIEWING");
    assert.equal(migrated.objective, "legacy objective");
    assert.equal(migrated.base_head, state.base_head);
    assert.deepEqual(migrated.approved_paths, ["note.txt"]);
    assert.deepEqual(migrated.acceptance_criteria, []);
    assert.deepEqual(migrated.validation_requirements, []);
    assert.deepEqual(migrated.review_target, {
      review_mode: "working_tree",
      base_revision: state.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    });
    assert.equal(migrated.initial_receipt, null);
    assert.deepEqual(migrated.dirty_baseline_paths, []);
    assert.equal(migrated.repair_cycle, 0);
    assert.equal(migrated.max_repair_cycles, 2);
    assert.equal(migrated.parent_workflow_id, null);
    assert.equal(migrated.source_workflow_id, null);
    assert.deepEqual(migrated.linked_findings, []);
    assert.equal(migrated.remediation_context, null);
    assert.equal(migrated.implementation_summary, "legacy implementation");
    assert.equal(migrated.implementation_status, "DONE");
    assert.deepEqual(migrated.agent_touched_paths, ["note.txt"]);
    assert.deepEqual(migrated.scope_changed_paths, ["note.txt"]);
    assert.deepEqual(migrated.implementation_changed_paths, ["note.txt"]);
    assert.deepEqual(migrated.acceptance_results, []);
    assert.deepEqual(migrated.validation_results, []);
    assert.deepEqual(migrated.implementation_receipt, { base_head: "a".repeat(40) });
    assert.deepEqual(migrated.implementation_known_failures, ["flaky"]);
    assert.deepEqual(migrated.finding_resolution_map, { "BLK-1": "resolved" });
    assert.deepEqual(migrated.prior_finding_classifications, {});
    assert.deepEqual(migrated.blocking_findings, []);
    assert.deepEqual(migrated.optional_findings, []);
    assert.equal(migrated.review_receipt, null);
    assert.equal(migrated.stop_context, null);
    assert.equal(migrated.recovery_context, null);
    assert.deepEqual(migrated.repair_authorized_ids, []);
    assert.equal(migrated.concern_acceptance, null);
    assert.equal(migrated.commit_authorization, null);
    assert.equal(migrated.commit_preparation, null);
    assert.equal(migrated.commit_result, null);
    assert.deepEqual(migrated.implementation_acceptance_evidence, ["accepted"]);
    assert.deepEqual(migrated.implementation_validation_evidence, ["validated"]);
    assert.deepEqual(migrated.authorized_optional_ids, []);
    assert.equal(migrated.user_authorization_summary, null);
    assert.deepEqual(migrated.legacy_evidence, {
      acceptance_evidence: ["accepted"],
      validation_evidence: ["validated"],
    });
    const row = store.db
      .prepare("SELECT state_digest FROM workflows WHERE workflow_id = ?")
      .get(state.workflow_id);
    assert.equal(row.state_digest, objectDigest(migrated));
    const events = store.audit(state.workflow_id, "parent", issued.get(state.workflow_id).parent);
    assert.equal(events.filter((event) => event.event_type === "WORKFLOW_MIGRATED").length, 1);
    assert.equal(events.filter((event) => event.event_type === "WORKFLOW_MIGRATED")[0].version, 4);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("maps STOPPED_BLOCKED phases and preserves other phases", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-phases-"));
  try {
    const path = join(root, "state.sqlite");
    const states = [
      v1State({ phase: "STOPPED_BLOCKED", implementation_status: "BLOCKED" }),
      v1State({ phase: "STOPPED_BLOCKED", implementation_status: "DONE" }),
      v1State({ phase: "COMMIT_AUTHORIZED", commit_authorization: { user_authorization: "legacy auth" } }),
      v1State({ phase: "STOPPED_NEEDS_CONTEXT", implementation_status: "NEEDS_CONTEXT" }),
    ];
    const issued = createV1Database(path, states);
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const phases = states.map((state) =>
      store.get(state.workflow_id, "parent", issued.get(state.workflow_id).parent).phase,
    );
    assert.deepEqual(phases, [
      "STOPPED_IMPLEMENTATION_BLOCKED",
      "STOPPED_REPAIR_EXHAUSTED",
      "COMMIT_AUTHORIZED",
      "STOPPED_NEEDS_CONTEXT",
    ]);
    const authorized = store.get(states[2].workflow_id, "parent", issued.get(states[2].workflow_id).parent);
    assert.deepEqual(authorized.commit_authorization, { user_authorization: "legacy auth" });
    assert.equal(
      store.audit(states[0].workflow_id, "parent", issued.get(states[0].workflow_id).parent).filter(
        (event) => event.event_type === "WORKFLOW_MIGRATED",
      ).length,
      1,
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves capability hashes and enforces stale versions after migration", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-capability-"));
  try {
    const path = join(root, "state.sqlite");
    const state = v1State({
      phase: "REPAIR_REQUIRED",
      repair_cycle: 0,
      max_repair_cycles: 1,
      blocking_findings: [blocker()],
    });
    const issued = createV1Database(path, [state]);
    const capabilities = issued.get(state.workflow_id);
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    assert.equal(store.get(state.workflow_id, "parent", capabilities.parent).version, 1);
    assert.equal(
      errorCategory(() => store.get(state.workflow_id, "parent", "bad")),
      "ERROR_CAPABILITY_DENIED",
    );
    const row = store.db.prepare("SELECT * FROM workflows WHERE workflow_id = ?").get(state.workflow_id);
    assert.equal(row.parent_capability_hash, hashCapability(capabilities.parent));
    assert.equal(row.implementer_capability_hash, hashCapability(capabilities.implementer));
    assert.equal(row.reviewer_capability_hash, hashCapability(capabilities.reviewer));
    assert.equal(row.committer_capability_hash, hashCapability(capabilities.committer));
    assert.equal(
      errorCategory(() =>
        store.authorizeRepair({
          workflow_id: state.workflow_id,
          capability: capabilities.parent,
          expected_version: 0,
          finding_ids: ["BLK-1"],
        }),
      ),
      "ERROR_VERSION_CONFLICT",
    );
    const repairing = store.authorizeRepair({
      workflow_id: state.workflow_id,
      capability: capabilities.parent,
      expected_version: 1,
      finding_ids: ["BLK-1"],
    });
    assert.equal(repairing.phase, "REPAIRING");
    assert.equal(repairing.version, 2);
    assert.equal(
      errorCategory(() =>
        store.authorizeRepair({
          workflow_id: state.workflow_id,
          capability: capabilities.parent,
          expected_version: 1,
          finding_ids: ["BLK-1"],
        }),
      ),
      "ERROR_VERSION_CONFLICT",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("preserves old audits byte-for-byte and appends one migration event", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-audit-"));
  try {
    const path = join(root, "state.sqlite");
    const state = v1State({
      version: 1,
      phase: "REVIEWING",
      implementation_status: "DONE",
      implementation_summary: "done",
      implementation_changed_paths: ["note.txt"],
      implementation_acceptance_evidence: ["accepted"],
      implementation_validation_evidence: ["validated"],
    });
    const audits = [
      {
        workflow_id: state.workflow_id,
        version: 0,
        event_type: "WORKFLOW_CREATED",
        actor_role: "parent",
        summary_json: JSON.stringify({ phase: "IMPLEMENTING", base_head: state.base_head }),
        created_at: "2024-01-01T00:00:00.000Z",
      },
      {
        workflow_id: state.workflow_id,
        version: 1,
        event_type: "IMPLEMENTATION_SUBMITTED",
        actor_role: "implementer",
        summary_json: JSON.stringify({ phase: "REVIEWING" }),
        created_at: "2024-01-01T00:00:01.000Z",
      },
    ];
    const issued = createV1Database(path, [state], audits);
    const before = rawAudits(path);
    assert.equal(before.length, 2);
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const events = store.audit(state.workflow_id, "parent", issued.get(state.workflow_id).parent);
    assert.equal(events.length, 3);
    assert.deepEqual(events[0], {
      version: 0,
      event_type: "WORKFLOW_CREATED",
      actor_role: "parent",
      summary: { phase: "IMPLEMENTING", base_head: state.base_head },
      created_at: "2024-01-01T00:00:00.000Z",
    });
    assert.deepEqual(events[1], {
      version: 1,
      event_type: "IMPLEMENTATION_SUBMITTED",
      actor_role: "implementer",
      summary: { phase: "REVIEWING" },
      created_at: "2024-01-01T00:00:01.000Z",
    });
    assert.equal(events[2].event_type, "WORKFLOW_MIGRATED");
    assert.equal(events[2].version, 2);
    assert.equal(events[2].actor_role, "parent");
    assert.deepEqual(events[2].summary, { phase: "REVIEWING" });
    const after = store.db
      .prepare(
        "SELECT event_id, workflow_id, version, event_type, actor_role, summary_json, created_at FROM audit_events ORDER BY event_id",
      )
      .all();
    assert.deepEqual(after.slice(0, before.length), before);
    assert.equal(after.length, before.length + 1);
    assert.equal(after[before.length].event_type, "WORKFLOW_MIGRATED");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrates every v1 row in one batch with one event per row", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-multiple-"));
  try {
    const path = join(root, "state.sqlite");
    const states = [
      v1State({ phase: "IMPLEMENTING" }),
      v1State({ phase: "REVIEWING", implementation_status: "DONE", implementation_summary: "done" }),
      v1State({ phase: "STOPPED_APPROVED", optional_findings: [], review_receipt: null }),
    ];
    const issued = createV1Database(path, states);
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    for (const state of states) {
      const migrated = store.get(state.workflow_id, "parent", issued.get(state.workflow_id).parent);
      assert.equal(migrated.schema_version, 2);
      assert.equal(migrated.version, 1);
      const migrationEvents = store
        .audit(state.workflow_id, "parent", issued.get(state.workflow_id).parent)
        .filter((event) => event.event_type === "WORKFLOW_MIGRATED");
      assert.equal(migrationEvents.length, 1);
      assert.equal(migrationEvents[0].version, 1);
    }
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("injected migration failure rolls back the whole batch", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-fault-"));
  try {
    const path = join(root, "state.sqlite");
    const a = v1State();
    const b = v1State();
    createV1Database(path, [a, b]);
    assert.equal(
      errorCategory(
        () => new WorkflowStore({ repositoryRoot: root, databasePath: path, faultAfterMigrationUpdate: true }),
      ),
      "ERROR_INJECTED_FAILURE",
    );
    const db = new DatabaseSync(path);
    for (const state of [a, b]) {
      const row = db
        .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(state.workflow_id);
      assert.equal(row.version, 0);
      assert.equal(row.state_digest, null);
      assert.deepEqual(JSON.parse(row.state_json), state);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, 0);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reopening is idempotent and adds no second migration event", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-reopen-"));
  try {
    const path = join(root, "state.sqlite");
    const state = v1State({ phase: "REVIEWING", implementation_status: "DONE", implementation_summary: "done" });
    const issued = createV1Database(path, [state]);
    const capabilities = issued.get(state.workflow_id);
    const first = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const events1 = first.audit(state.workflow_id, "parent", capabilities.parent);
    const migrated1 = first.get(state.workflow_id, "parent", capabilities.parent);
    const row1 = first.db
      .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(state.workflow_id);
    first.close();
    const second = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const events2 = second.audit(state.workflow_id, "parent", capabilities.parent);
    const migrated2 = second.get(state.workflow_id, "parent", capabilities.parent);
    const row2 = second.db
      .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
      .get(state.workflow_id);
    assert.deepEqual(events2, events1);
    assert.deepEqual(migrated2, migrated1);
    assert.deepEqual(row2, row1);
    assert.equal(events2.filter((event) => event.event_type === "WORKFLOW_MIGRATED").length, 1);
    assert.equal(row2.version, 1);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed and unknown v1 schemas and rolls back the batch", () => {
  const root = mkdtempSync(join(tmpdir(), "migration-corrupt-"));
  try {
    const missingPath = join(root, "missing.sqlite");
    const valid = v1State();
    const malformed = v1State();
    delete malformed.approved_paths;
    createV1Database(missingPath, [valid, malformed]);
    assert.equal(
      errorCategory(() => new WorkflowStore({ repositoryRoot: root, databasePath: missingPath })),
      "ERROR_STATE_CORRUPT",
    );
    const db = new DatabaseSync(missingPath);
    for (const state of [valid, malformed]) {
      const row = db
        .prepare("SELECT version, state_json, state_digest FROM workflows WHERE workflow_id = ?")
        .get(state.workflow_id);
      assert.equal(row.version, 0);
      assert.equal(row.state_digest, null);
      assert.deepEqual(JSON.parse(row.state_json), state);
    }
    assert.equal(
      db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE event_type = 'WORKFLOW_MIGRATED'").get().count,
      0,
    );
    db.close();

    const unknownPath = join(root, "unknown.sqlite");
    createV1Database(unknownPath, [v1State({ schema_version: 3 })]);
    assert.equal(
      errorCategory(() => new WorkflowStore({ repositoryRoot: root, databasePath: unknownPath })),
      "ERROR_STATE_CORRUPT",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});