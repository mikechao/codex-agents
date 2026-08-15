import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.mjs";
import {
  createReceipt,
  currentHead,
  prepareCommitReceipt,
  repositoryRoot,
  reviewRange,
  verifyCommit,
  verifyReviewReceipt,
} from "./git.mjs";
import {
  acceptConcerns,
  authorizeCommit,
  authorizeRepair,
  createState,
  dirtyBaselinePaths,
  finalizeRepairExhausted,
  IMPLEMENTATION_STOP_PHASES,
  linkedFollowupChildState,
  linkedFollowupInput,
  migrateV1State,
  prepareCommit,
  rangeDirtyBaselinePaths,
  recordCommit,
  resumeImplementation,
  resumeReview,
  roleView,
  submitImplementation,
  submitReview,
} from "./transitions.mjs";
import {
  canonicalJson,
  compareCapability,
  exactKeys,
  exactPaths,
  expectedVersion,
  hashCapability,
  issueCapability,
  objectDigest,
  role,
} from "./validation.mjs";

export function resolveStatePath(root) {
  const stableRoot = realpathSync(root);
  const digest = createHash("sha256").update(stableRoot, "utf8").digest("hex").slice(0, 24);
  return join(homedir(), ".codex", "state", "workflow-mcp", digest, "state.sqlite");
}

function mutationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", "mutation input is invalid");
  }
  return value;
}

function changedFields(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.filter(
    (key) => key !== "version" && canonicalJson(before[key]) !== canonicalJson(after[key]),
  );
}

function auditEnvelope(before, after, digestBefore, options = {}) {
  return {
    schema_version: 2,
    phase_before: before ? before.phase : null,
    phase_after: after.phase,
    state_digest_before: digestBefore ?? null,
    state_digest_after: objectDigest(after),
    changed_fields: changedFields(before ?? {}, after),
    linked_workflow_id: options.linked_workflow_id ?? null,
    outcome: options.outcome ?? null,
  };
}

function parseState(row) {
  try {
    return JSON.parse(row.state_json);
  } catch {
    fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
  }
}

export class WorkflowStore {
  constructor(options = {}) {
    this.root = realpathSync(options.repositoryRoot ?? repositoryRoot(process.cwd()));
    this.path =
      options.databasePath ?? (process.env.WORKFLOW_MCP_DB_PATH || resolveStatePath(this.root));
    this.faultAfterLinkedChildInsert = options.faultAfterLinkedChildInsert === true;
    this.faultAfterMigrationUpdate = options.faultAfterMigrationUpdate === true;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
        workflow_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        state_digest TEXT,
        parent_capability_hash TEXT NOT NULL,
        implementer_capability_hash TEXT NOT NULL,
        reviewer_capability_hash TEXT NOT NULL,
        committer_capability_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor_role TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
      );
      CREATE INDEX IF NOT EXISTS audit_events_workflow ON audit_events(workflow_id, event_id);
    `);
    const workflowColumns = this.db
      .prepare("PRAGMA table_info(workflows)")
      .all()
      .map((column) => column.name);
    if (!workflowColumns.includes("state_digest")) {
      this.db.exec("ALTER TABLE workflows ADD COLUMN state_digest TEXT");
    }
    try {
      this.#migrateLegacyRows();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  #ensureOpen() {
    if (this.closed) fail("ERROR_STORE_CLOSED", "workflow store is closed");
  }

  #capabilityHashes(capabilities) {
    return {
      parent: hashCapability(capabilities.parent),
      implementer: hashCapability(capabilities.implementer),
      reviewer: hashCapability(capabilities.reviewer),
      committer: hashCapability(capabilities.committer),
    };
  }

  #assertAuth(row, actorRole, token) {
    const selectedRole = role(actorRole);
    const hash = row[`${selectedRole}_capability_hash`];
    if (typeof hash !== "string" || !compareCapability(hash, token)) {
      fail("ERROR_CAPABILITY_DENIED", "capability is not valid for role");
    }
  }

  #verifyDigest(row) {
    if (row.state_digest === null || row.state_digest === undefined) {
      fail("ERROR_MIGRATION_REQUIRED", "workflow requires state migration");
    }
    if (row.state_digest !== objectDigest(parseState(row))) {
      fail("ERROR_STATE_CORRUPT", "workflow state digest is corrupted");
    }
  }

  #row(workflowId) {
    if (typeof workflowId !== "string" || !/^[0-9a-f-]{36}$/u.test(workflowId)) {
      fail("ERROR_NOT_FOUND", "workflow is not found");
    }
    const row = this.db.prepare("SELECT * FROM workflows WHERE workflow_id = ?").get(workflowId);
    if (!row) fail("ERROR_NOT_FOUND", "workflow is not found");
    this.#verifyDigest(row);
    return row;
  }

  #migrateLegacyRows() {
    const rows = this.db.prepare("SELECT workflow_id, version, state_json FROM workflows").all();
    if (rows.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let migrated = false;
      for (const row of rows) {
        const state = parseState(row);
        if (state.schema_version === 1) {
          if (row.version !== state.version) fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
          const next = migrateV1State(state);
          next.version = state.version + 1;
          const now = new Date().toISOString();
          const result = this.db
            .prepare(
              "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
            )
            .run(
              next.version,
              JSON.stringify(next),
              objectDigest(next),
              now,
              row.workflow_id,
              row.version,
            );
          if (result.changes !== 1) fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
          if (this.faultAfterMigrationUpdate)
            fail("ERROR_INJECTED_FAILURE", "injected migration failure");
          this.#audit(row.workflow_id, next.version, "WORKFLOW_MIGRATED", "parent", auditEnvelope(state, next, null, { outcome: next.phase }));
          migrated = true;
        } else if (state.schema_version !== 2) {
          fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
        }
      }
      if (migrated) this.db.exec("COMMIT");
      else this.db.exec("ROLLBACK");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #audit(workflowId, version, eventType, actorRole, summary) {
    this.db
      .prepare(
        "INSERT INTO audit_events (workflow_id, version, event_type, actor_role, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        workflowId,
        version,
        eventType,
        actorRole,
        JSON.stringify(summary),
        new Date().toISOString(),
      );
  }

  create(input) {
    this.#ensureOpen();
    const head = currentHead(this.root);
    const workflowId = randomUUID();
    const state = createState(input, this.root, head);
    if (state.review_target.review_mode === "working_tree") {
      const initialReceipt = createReceipt(this.root, state.approved_paths, true);
      if (initialReceipt.base_head !== head) fail("ERROR_STALE_BASE", "scope base is stale");
      state.initial_receipt = initialReceipt;
      state.dirty_baseline_paths = dirtyBaselinePaths(initialReceipt);
    } else {
      const range = reviewRange(this.root, state.review_target);
      state.initial_receipt = null;
      state.dirty_baseline_paths = rangeDirtyBaselinePaths(range);
    }
    state.workflow_id = workflowId;
    const capabilities = {
      parent: issueCapability(),
      implementer: issueCapability(),
      reviewer: issueCapability(),
      committer: issueCapability(),
    };
    const hashes = this.#capabilityHashes(capabilities);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT INTO workflows (workflow_id, version, state_json, state_digest, parent_capability_hash, implementer_capability_hash, reviewer_capability_hash, committer_capability_hash, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          workflowId,
          JSON.stringify(state),
          objectDigest(state),
          hashes.parent,
          hashes.implementer,
          hashes.reviewer,
          hashes.committer,
          now,
          now,
        );
      this.#audit(workflowId, 0, "WORKFLOW_CREATED", "parent", auditEnvelope(null, state, null));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { workflow: roleView(state, "parent"), capabilities };
  }

  get(workflowId, actorRole, token) {
    this.#ensureOpen();
    const row = this.#row(workflowId);
    this.#assertAuth(row, actorRole, token);
    return roleView(parseState(row), actorRole);
  }

  audit(workflowId, actorRole, token) {
    this.#ensureOpen();
    const row = this.#row(workflowId);
    this.#assertAuth(row, actorRole, token);
    return this.db
      .prepare(
        "SELECT version, event_type, actor_role, summary_json, created_at FROM audit_events WHERE workflow_id = ? ORDER BY event_id",
      )
      .all(workflowId)
      .map((event) => ({
        version: event.version,
        event_type: event.event_type,
        actor_role: event.actor_role,
        summary: JSON.parse(event.summary_json),
        created_at: event.created_at,
      }));
  }

  #mutate(workflowId, actorRole, token, expected, eventType, action, outcome = null) {
    this.#ensureOpen();
    expectedVersion(expected);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(workflowId);
      this.#assertAuth(row, actorRole, token);
      if (row.version !== expected) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      const current = parseState(row);
      const next = action(current);
      const nextVersion = expected + 1;
      next.version = nextVersion;
      const now = new Date().toISOString();
      const result = this.db
        .prepare(
          "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
        )
        .run(nextVersion, JSON.stringify(next), objectDigest(next), now, workflowId, expected);
      if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      this.#audit(
        workflowId,
        nextVersion,
        eventType,
        actorRole,
        auditEnvelope(current, next, row.state_digest, { outcome }),
      );
      this.db.exec("COMMIT");
      return roleView(next, actorRole);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  submitImplementation(input) {
    mutationInput(input);
    const eventType =
      input.status === "DONE" ? "IMPLEMENTATION_SUBMITTED" : "IMPLEMENTATION_STOPPED";
    const outcome = input.status === "DONE" ? null : IMPLEMENTATION_STOP_PHASES[input.status];
    return this.#mutate(
      input.workflow_id,
      "implementer",
      input.capability,
      input.expected_version,
      eventType,
      (state) => {
        const currentReceipt = createReceipt(this.root, state.approved_paths, true);
        if (currentReceipt.base_head !== state.base_head) {
          fail("ERROR_STALE_RECEIPT", "implementation receipt base is stale");
        }
        if (canonicalJson(currentReceipt) !== canonicalJson(input.implementation_receipt)) {
          fail("ERROR_STALE_RECEIPT", "implementation receipt is stale");
        }
        return submitImplementation(state, input, this.root, currentReceipt);
      },
      outcome,
    );
  }

  resumeImplementation(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "parent",
      input.capability,
      input.expected_version,
      "IMPLEMENTATION_RESUMED",
      (state) => resumeImplementation(state, input),
    );
  }

  acceptConcerns(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "parent",
      input.capability,
      input.expected_version,
      "CONCERNS_ACCEPTED",
      (state) => acceptConcerns(state, input),
    );
  }

  submitReview(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "reviewer",
      input.capability,
      input.expected_version,
      "REVIEW_SUBMITTED",
      (state) => {
        const target = input.review_target;
        exactKeys(
          target,
          [
            "review_mode",
            "base_revision",
            "head_revision",
            "approved_paths",
            "include_staged",
            "include_unstaged",
            "include_untracked",
          ],
          "review_target",
        );
        const normalized = {
          ...target,
          approved_paths: exactPaths(target.approved_paths, this.root),
        };
        if (canonicalJson(normalized) !== canonicalJson(state.review_target)) {
          fail("ERROR_INVALID_REVIEW", "review target is incomplete or stale");
        }
        const next = submitReview(state, input);
        if (input.review_status === "APPROVED") {
          if (state.review_target.review_mode === "working_tree") {
            if (!input.review_receipt)
              fail("ERROR_STALE_RECEIPT", "approved review requires receipt");
            verifyReviewReceipt(
              this.root,
              input.review_receipt,
              state.approved_paths,
              state.base_head,
            );
          } else {
            if (input.review_receipt !== null)
              fail("ERROR_INVALID_REVIEW", "range approval cannot include receipt");
          }
        } else if (input.review_receipt !== undefined && input.review_receipt !== null) {
          fail("ERROR_INVALID_REVIEW", "only approved review may include receipt");
        }
        return next;
      },
      input.review_status,
    );
  }

  authorizeRepair(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "parent",
      input.capability,
      input.expected_version,
      "REPAIR_AUTHORIZED",
      (state) => authorizeRepair(state, input),
    );
  }

  resumeReview(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "parent",
      input.capability,
      input.expected_version,
      "REVIEW_RESUMED",
      (state) => resumeReview(state, input),
    );
  }

  finalizeRepairExhausted(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "parent",
      input.capability,
      input.expected_version,
      "REPAIR_EXHAUSTED",
      (state) => finalizeRepairExhausted(state, input),
      "STOPPED_REPAIR_EXHAUSTED",
    );
  }

  authorizeCommit(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "parent",
      input.capability,
      input.expected_version,
      "COMMIT_AUTHORIZED",
      (state) => {
        if (state.review_target.review_mode !== "working_tree") {
          fail("ERROR_COMMIT_NOT_ALLOWED", "commit authorization requires a working-tree review");
        }
        if (!state.review_receipt) fail("ERROR_STALE_RECEIPT", "review receipt is missing");
        verifyReviewReceipt(this.root, state.review_receipt, state.approved_paths, state.base_head);
        return authorizeCommit(state, input);
      },
    );
  }

  recordCommit(input) {
    mutationInput(input);
    exactKeys(
      input,
      ["workflow_id", "capability", "expected_version", "commit_hash"],
      "commit record",
    );
    return this.#mutate(
      input.workflow_id,
      "committer",
      input.capability,
      input.expected_version,
      "COMMIT_RECORDED",
      (state) => {
        const evidence = verifyCommit(this.root, state, input.commit_hash);
        return recordCommit(state, evidence, input);
      },
      "committed",
    );
  }

  prepareCommit(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "committer",
      input.capability,
      input.expected_version,
      "COMMIT_PREPARED",
      (state) => {
        const evidence = prepareCommitReceipt(this.root, state);
        return prepareCommit(state, input, evidence);
      },
    );
  }

  createLinkedFollowup(input) {
    this.#ensureOpen();
    mutationInput(input);
    expectedVersion(input.expected_version);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(input.workflow_id);
      this.#assertAuth(row, "parent", input.capability);
      if (row.version !== input.expected_version)
        fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      const state = parseState(row);
      const followup = linkedFollowupInput(state, input, this.root, currentHead(this.root));
      const childId = randomUUID();
      const childState = linkedFollowupChildState(followup);
      const childReceipt = createReceipt(this.root, childState.approved_paths, true);
      if (childReceipt.base_head !== followup.base_head)
        fail("ERROR_STALE_BASE", "scope base is stale");
      childState.workflow_id = childId;
      childState.initial_receipt = childReceipt;
      childState.dirty_baseline_paths = dirtyBaselinePaths(childReceipt);
      const childCapabilities = {
        parent: issueCapability(),
        implementer: issueCapability(),
        reviewer: issueCapability(),
        committer: issueCapability(),
      };
      const childHashes = this.#capabilityHashes(childCapabilities);
      const now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO workflows (workflow_id, version, state_json, state_digest, parent_capability_hash, implementer_capability_hash, reviewer_capability_hash, committer_capability_hash, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          childId,
          JSON.stringify(childState),
          objectDigest(childState),
          childHashes.parent,
          childHashes.implementer,
          childHashes.reviewer,
          childHashes.committer,
          now,
          now,
        );
      this.#audit(
        childId,
        0,
        "WORKFLOW_CREATED",
        "parent",
        auditEnvelope(null, childState, null, { linked_workflow_id: state.workflow_id }),
      );
      const next = { ...state, version: input.expected_version + 1 };
      const result = this.db
        .prepare(
          "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
        )
        .run(next.version, JSON.stringify(next), objectDigest(next), now, input.workflow_id, input.expected_version);
      if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      this.#audit(
        input.workflow_id,
        next.version,
        "LINKED_FOLLOWUP_CREATED",
        "parent",
        auditEnvelope(state, next, row.state_digest, { linked_workflow_id: childId }),
      );
      if (this.faultAfterLinkedChildInsert)
        fail("ERROR_INJECTED_FAILURE", "injected transaction failure");
      this.db.exec("COMMIT");
      return { workflow: roleView(childState, "parent"), capabilities: childCapabilities };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openStore(options = {}) {
  return new WorkflowStore(options);
}

export { exactPaths };
