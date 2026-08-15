import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.mjs";
import {
  createReceipt,
  currentHead,
  repositoryRoot,
  verifyCommit,
  verifyReviewReceipt,
} from "./git.mjs";
import {
  authorizeCommit,
  authorizeRepair,
  changedReceiptPaths,
  createState,
  finalizeBlocked,
  optionalFollowupInput,
  recordCommit,
  submitImplementation,
  submitReview,
} from "./transitions.mjs";
import {
  compareCapability,
  exactKeys,
  exactPaths,
  expectedVersion,
  hashCapability,
  issueCapability,
  role,
} from "./validation.mjs";

export function resolveStatePath(root) {
  const stableRoot = realpathSync(root);
  const digest = createHash("sha256").update(stableRoot, "utf8").digest("hex").slice(0, 24);
  return join(homedir(), ".codex", "state", "workflow-mcp", digest, "state.sqlite");
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mutationInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", "mutation input is invalid");
  }
  return value;
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
    this.faultAfterChildInsert = options.faultAfterChildInsert === true;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
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

  #row(workflowId) {
    if (typeof workflowId !== "string" || !/^[0-9a-f-]{36}$/u.test(workflowId)) {
      fail("ERROR_NOT_FOUND", "workflow is not found");
    }
    const row = this.db.prepare("SELECT * FROM workflows WHERE workflow_id = ?").get(workflowId);
    if (!row) fail("ERROR_NOT_FOUND", "workflow is not found");
    return row;
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

  #publicState(state) {
    return clone(state);
  }

  create(input) {
    this.#ensureOpen();
    const head = currentHead(this.root);
    const workflowId = randomUUID();
    const state = createState(input, this.root, head);
    const scopeReceipt = createReceipt(this.root, state.approved_paths);
    if (scopeReceipt.base_head !== head) fail("ERROR_STALE_BASE", "scope base is stale");
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
          "INSERT INTO workflows (workflow_id, version, state_json, parent_capability_hash, implementer_capability_hash, reviewer_capability_hash, committer_capability_hash, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          workflowId,
          JSON.stringify(state),
          hashes.parent,
          hashes.implementer,
          hashes.reviewer,
          hashes.committer,
          now,
          now,
        );
      this.#audit(workflowId, 0, "WORKFLOW_CREATED", "parent", {
        phase: state.phase,
        base_head: state.base_head,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { workflow: this.#publicState(state), capabilities };
  }

  get(workflowId, actorRole, token) {
    this.#ensureOpen();
    const row = this.#row(workflowId);
    this.#assertAuth(row, actorRole, token);
    return this.#publicState(parseState(row));
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

  #mutate(workflowId, actorRole, token, expected, eventType, action) {
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
          "UPDATE workflows SET version = ?, state_json = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
        )
        .run(nextVersion, JSON.stringify(next), now, workflowId, expected);
      if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      this.#audit(workflowId, nextVersion, eventType, actorRole, { phase: next.phase });
      this.db.exec("COMMIT");
      return this.#publicState(next);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  submitImplementation(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "implementer",
      input.capability,
      input.expected_version,
      "IMPLEMENTATION_SUBMITTED",
      (state) => {
        const currentReceipt = verifyReviewReceipt(
          this.root,
          input.implementation_receipt,
          state.approved_paths,
          state.base_head,
        );
        const changedPaths = changedReceiptPaths(currentReceipt);
        if (JSON.stringify(changedPaths) !== JSON.stringify(input.changed_paths)) {
          fail("ERROR_INVALID_IMPLEMENTATION", "changed paths do not match receipt");
        }
        return submitImplementation(state, input, this.root);
      },
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
        const targetPaths = exactPaths(target.approved_paths, this.root);
        if (
          target.review_mode !== "working_tree" ||
          target.base_revision !== state.base_head ||
          target.head_revision !== null ||
          JSON.stringify(targetPaths) !== JSON.stringify(state.approved_paths) ||
          target.include_staged !== true ||
          target.include_unstaged !== true ||
          target.include_untracked !== true
        ) {
          fail("ERROR_INVALID_REVIEW", "review target is incomplete or stale");
        }
        const next = submitReview(state, input);
        if (input.review_status === "APPROVED") {
          if (!input.review_receipt)
            fail("ERROR_STALE_RECEIPT", "approved review requires receipt");
          verifyReviewReceipt(
            this.root,
            input.review_receipt,
            state.approved_paths,
            state.base_head,
          );
        } else if (input.review_receipt !== undefined && input.review_receipt !== null) {
          fail("ERROR_INVALID_REVIEW", "only approved review may include receipt");
        }
        return next;
      },
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

  finalizeBlocked(input) {
    mutationInput(input);
    return this.#mutate(
      input.workflow_id,
      "parent",
      input.capability,
      input.expected_version,
      "WORKFLOW_BLOCKED",
      (state) => finalizeBlocked(state, input),
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
    );
  }

  createOptionalFollowup(input) {
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
      const followup = optionalFollowupInput(state, input, this.root, currentHead(this.root));
      const childId = randomUUID();
      const childState = createState(
        {
          objective: followup.objective,
          approved_paths: followup.approved_paths,
          base_head: followup.base_head,
          max_repair_cycles: followup.max_repair_cycles,
          parent_workflow_id: followup.parent_workflow_id,
        },
        this.root,
        currentHead(this.root),
      );
      createReceipt(this.root, childState.approved_paths);
      childState.workflow_id = childId;
      childState.authorized_optional_ids = followup.optional_finding_ids;
      childState.user_authorization_summary = followup.user_authorization;
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
          "INSERT INTO workflows (workflow_id, version, state_json, parent_capability_hash, implementer_capability_hash, reviewer_capability_hash, committer_capability_hash, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          childId,
          JSON.stringify(childState),
          childHashes.parent,
          childHashes.implementer,
          childHashes.reviewer,
          childHashes.committer,
          now,
          now,
        );
      if (this.faultAfterChildInsert)
        fail("ERROR_INJECTED_FAILURE", "injected transaction failure");
      this.#audit(childId, 0, "WORKFLOW_CREATED", "parent", {
        phase: childState.phase,
        base_head: childState.base_head,
        parent_workflow_id: state.workflow_id,
      });
      const next = { ...state, version: input.expected_version + 1 };
      const result = this.db
        .prepare(
          "UPDATE workflows SET version = ?, state_json = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
        )
        .run(next.version, JSON.stringify(next), now, input.workflow_id, input.expected_version);
      if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      this.#audit(input.workflow_id, next.version, "OPTIONAL_FOLLOWUP_CREATED", "parent", {
        phase: next.phase,
        linked_workflow_id: childId,
      });
      this.db.exec("COMMIT");
      return { workflow: this.#publicState(childState), capabilities: childCapabilities };
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
