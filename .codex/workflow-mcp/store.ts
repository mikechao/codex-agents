import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";
import { fail } from "./errors.js";
import {
  createReceipt,
  currentHead,
  prepareCommitReceipt,
  repositoryRoot,
  reviewRange,
  verifyCommit,
  verifyCommitResult,
  verifyReviewReceipt,
} from "./git.js";
import {
  acceptConcerns,
  authorizeCommit,
  authorizeRepair,
  commitMismatch,
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
  retryCommit,
  roleView,
  submitCommitResult,
  submitImplementation,
  submitReview,
  validateWorkflowStateV2,
} from "./transitions.js";
import {
  canonicalJson,
  compareCapability,
  exactKeys,
  exactPaths,
  expectedVersion,
  hashCapability,
  issueCapability,
  isoNow,
  objectDigest,
  role,
  workflowId,
} from "./validation.js";
import type {
  ActorRole,
  AuditEnvelope,
  AuditEvent,
  AuditEventType,
  AuditOutcome,
  CapabilityHash,
  CapabilityToken,
  ChangeReceipt,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitVerification,
  ExactRepoPath,
  GitCommitSha,
  IsoTimestamp,
  LegacyAuditSummary,
  ParentView,
  ReviewStatus,
  Role,
  RoleCapabilities,
  RoleView,
  StateDigest,
  WorkflowId,
  WorkflowRow,
  WorkflowState,
  WorkflowVersion,
} from "./types.js";

export function resolveStatePath(root: string): string {
  const stableRoot = realpathSync(root);
  const digest = createHash("sha256").update(stableRoot, "utf8").digest("hex").slice(0, 24);
  return join(homedir(), ".codex", "state", "workflow-mcp", digest, "state.sqlite");
}

export interface WorkflowStoreOptions {
  repositoryRoot?: string;
  databasePath?: string;
  faultAfterLinkedChildInsert?: boolean;
  faultAfterMigrationUpdate?: boolean;
}

function mutationInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", "mutation input is invalid");
  }
  return value as Record<string, unknown>;
}

function changedFields(before: WorkflowState | null, after: WorkflowState): string[] {
  const beforeRecord = (before ?? {}) as Record<string, unknown>;
  const afterRecord = after as unknown as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
  return keys.filter(
    (key) =>
      key !== "version" && canonicalJson(beforeRecord[key]) !== canonicalJson(afterRecord[key]),
  );
}

function auditEnvelope(
  before: WorkflowState | null,
  after: WorkflowState,
  digestBefore: StateDigest | null,
  options: { linked_workflow_id?: WorkflowId | null; outcome?: AuditOutcome | null } = {},
): AuditEnvelope {
  return {
    schema_version: 2,
    phase_before: before ? before.phase : null,
    phase_after: after.phase,
    state_digest_before: digestBefore ?? null,
    state_digest_after: objectDigest(after),
    changed_fields: changedFields(before, after),
    linked_workflow_id: options.linked_workflow_id ?? null,
    outcome: options.outcome ?? null,
  };
}

function parseState(row: WorkflowRow): WorkflowState {
  if (row.state_digest === null || row.state_digest === undefined) {
    fail("ERROR_MIGRATION_REQUIRED", "workflow requires state migration");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
  }
  if (row.state_digest !== objectDigest(parsed)) {
    fail("ERROR_STATE_CORRUPT", "workflow state digest is corrupted");
  }
  return validateWorkflowStateV2(parsed);
}

// roleView's public overloads only accept literal roles; the store reaches the
// implementation signature (which validates via `role`) with the Role from #assertAuth.
const roleViewForRole = roleView as unknown as (state: WorkflowState, actorRole: Role) => RoleView;

export class WorkflowStore {
  readonly root: string;
  readonly path: string;
  readonly faultAfterLinkedChildInsert: boolean;
  readonly faultAfterMigrationUpdate: boolean;
  private db: Database;
  private closed = false;

  constructor(options: WorkflowStoreOptions = {}) {
    this.root = realpathSync(options.repositoryRoot ?? repositoryRoot(process.cwd()));
    this.path =
      options.databasePath ?? (process.env.WORKFLOW_MCP_DB_PATH || resolveStatePath(this.root));
    this.faultAfterLinkedChildInsert = options.faultAfterLinkedChildInsert === true;
    this.faultAfterMigrationUpdate = options.faultAfterMigrationUpdate === true;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new Database(this.path);
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
      .map((column) => (column as { name: string }).name);
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

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  #ensureOpen(): void {
    if (this.closed) fail("ERROR_STORE_CLOSED", "workflow store is closed");
  }

  #capabilityHashes(capabilities: RoleCapabilities): Record<Role, CapabilityHash> {
    return {
      parent: hashCapability(capabilities.parent),
      implementer: hashCapability(capabilities.implementer),
      reviewer: hashCapability(capabilities.reviewer),
      committer: hashCapability(capabilities.committer),
    };
  }

  #assertAuth(row: WorkflowRow, actorRole: unknown, token: unknown): Role {
    const selectedRole = role(actorRole);
    const hash = row[`${selectedRole}_capability_hash`];
    if (typeof hash !== "string" || !compareCapability(hash, token)) {
      fail("ERROR_CAPABILITY_DENIED", "capability is not valid for role");
    }
    return selectedRole;
  }

  #row(workflowId: WorkflowId): WorkflowRow {
    if (typeof workflowId !== "string" || !/^[0-9a-f-]{36}$/u.test(workflowId)) {
      fail("ERROR_NOT_FOUND", "workflow is not found");
    }
    const row = this.db
      .prepare("SELECT * FROM workflows WHERE workflow_id = ?")
      .get(workflowId) as WorkflowRow | undefined;
    if (!row) fail("ERROR_NOT_FOUND", "workflow is not found");
    parseState(row);
    return row;
  }

  #migrateLegacyRows(): void {
    const rows = this.db.prepare("SELECT workflow_id, version, state_json FROM workflows").all() as
      Array<Pick<WorkflowRow, "workflow_id" | "version" | "state_json">>;
    if (rows.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let migrated = false;
      for (const row of rows) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(row.state_json);
        } catch {
          fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
        }
        const schema = (parsed as { schema_version?: unknown }).schema_version;
        const state = parsed as WorkflowState; // envelope/before view; migrateV1State revalidates
        if (schema === 1) {
          if (row.version !== (parsed as { version: number }).version) {
            fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
          }
          const next = migrateV1State(parsed);
          validateWorkflowStateV2(next);
          next.version = ((parsed as { version: number }).version + 1) as WorkflowVersion;
          const now = isoNow();
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
          this.#audit(
            row.workflow_id as WorkflowId,
            next.version,
            "WORKFLOW_MIGRATED",
            "parent",
            auditEnvelope(state, next, null, { outcome: next.phase }),
          );
          migrated = true;
        } else if (schema === 2) {
          validateWorkflowStateV2(parsed);
        } else {
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

  #audit(
    workflowId: WorkflowId,
    version: number,
    eventType: AuditEventType,
    actorRole: ActorRole,
    summary: AuditEnvelope,
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_events (workflow_id, version, event_type, actor_role, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(workflowId, version, eventType, actorRole, JSON.stringify(summary), isoNow());
  }

  create(input: unknown): { workflow: ParentView; capabilities: RoleCapabilities } {
    this.#ensureOpen();
    const head = currentHead(this.root);
    const workflowId = randomUUID() as WorkflowId;
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
    const capabilities: RoleCapabilities = {
      parent: issueCapability(),
      implementer: issueCapability(),
      reviewer: issueCapability(),
      committer: issueCapability(),
    };
    const hashes = this.#capabilityHashes(capabilities);
    const now = isoNow();
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

  get(workflowIdValue: unknown, actorRole: unknown, token: unknown): RoleView {
    this.#ensureOpen();
    const id = workflowId(workflowIdValue);
    const row = this.#row(id);
    const selectedRole = this.#assertAuth(row, actorRole, token);
    return roleViewForRole(parseState(row), selectedRole);
  }

  audit(workflowIdValue: unknown, actorRole: unknown, token: unknown): AuditEvent[] {
    this.#ensureOpen();
    const id = workflowId(workflowIdValue);
    const row = this.#row(id);
    this.#assertAuth(row, actorRole, token);
    return (
      this.db
        .prepare(
          "SELECT version, event_type, actor_role, summary_json, created_at FROM audit_events WHERE workflow_id = ? ORDER BY event_id",
        )
        .all(id) as Array<{
        version: number;
        event_type: string;
        actor_role: string;
        summary_json: string;
        created_at: string;
      }>
    ).map((event) => ({
      version: event.version,
      event_type: event.event_type as AuditEventType,
      actor_role: event.actor_role as ActorRole,
      summary: JSON.parse(event.summary_json) as AuditEnvelope | LegacyAuditSummary,
      created_at: event.created_at as IsoTimestamp,
    }));
  }

  #mutate(
    workflowIdValue: unknown,
    actorRole: Role,
    token: unknown,
    expected: unknown,
    eventType: AuditEventType,
    action: (state: WorkflowState) => WorkflowState,
    outcome: AuditOutcome | null | ((next: WorkflowState) => AuditOutcome | null) = null,
  ): RoleView {
    this.#ensureOpen();
    const expectedVersionNumber = expectedVersion(expected);
    const id = workflowId(workflowIdValue); // brand at boundary; regex also inside #row
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(id);
      const selectedRole = this.#assertAuth(row, actorRole, token);
      if (row.version !== expectedVersionNumber) {
        fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      }
      const current = parseState(row);
      const next = action(current);
      const nextVersion = (expectedVersionNumber + 1) as WorkflowVersion;
      next.version = nextVersion;
      const now = isoNow();
      const result = this.db
        .prepare(
          "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
        )
        .run(nextVersion, JSON.stringify(next), objectDigest(next), now, id, expectedVersionNumber);
      if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      const resolvedOutcome = typeof outcome === "function" ? outcome(next) : outcome;
      this.#audit(
        id,
        nextVersion,
        eventType,
        selectedRole,
        auditEnvelope(current, next, row.state_digest as StateDigest | null, {
          outcome: resolvedOutcome,
        }),
      );
      this.db.exec("COMMIT");
      return roleViewForRole(next, selectedRole);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  submitImplementation(input: unknown): RoleView {
    const args = mutationInput(input);
    const eventType =
      args.status === "DONE" ? "IMPLEMENTATION_SUBMITTED" : "IMPLEMENTATION_STOPPED";
    const outcome: AuditOutcome | null =
      args.status === "DONE"
        ? null
        : IMPLEMENTATION_STOP_PHASES[
            args.status as "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED"
          ];
    return this.#mutate(
      args.workflow_id,
      "implementer",
      args.capability,
      args.expected_version,
      eventType,
      (state) => {
        const currentReceipt = createReceipt(this.root, state.approved_paths, true);
        if (currentReceipt.base_head !== state.base_head) {
          fail("ERROR_STALE_RECEIPT", "implementation receipt base is stale");
        }
        if (canonicalJson(currentReceipt) !== canonicalJson(args.implementation_receipt)) {
          fail("ERROR_STALE_RECEIPT", "implementation receipt is stale");
        }
        return submitImplementation(state, args, this.root, currentReceipt);
      },
      outcome,
    );
  }

  resumeImplementation(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.capability,
      args.expected_version,
      "IMPLEMENTATION_RESUMED",
      (state) => resumeImplementation(state, args),
    );
  }

  acceptConcerns(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.capability,
      args.expected_version,
      "CONCERNS_ACCEPTED",
      (state) => acceptConcerns(state, args),
    );
  }

  submitReview(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "reviewer",
      args.capability,
      args.expected_version,
      "REVIEW_SUBMITTED",
      (state) => {
        const target = args.review_target;
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
        const targetRecord = target as Record<string, unknown>;
        const normalized = {
          ...targetRecord,
          approved_paths: exactPaths(targetRecord.approved_paths, this.root),
        };
        if (canonicalJson(normalized) !== canonicalJson(state.review_target)) {
          fail("ERROR_INVALID_REVIEW", "review target is incomplete or stale");
        }
        const next = submitReview(state, args);
        if (args.review_status === "APPROVED") {
          if (state.review_target.review_mode === "working_tree") {
            if (!args.review_receipt) fail("ERROR_STALE_RECEIPT", "approved review requires receipt");
            verifyReviewReceipt(
              this.root,
              args.review_receipt as ChangeReceipt,
              state.approved_paths,
              state.base_head,
            );
          } else {
            if (args.review_receipt !== null)
              fail("ERROR_INVALID_REVIEW", "range approval cannot include receipt");
          }
        } else if (args.review_receipt !== undefined && args.review_receipt !== null) {
          fail("ERROR_INVALID_REVIEW", "only approved review may include receipt");
        }
        return next;
      },
      args.review_status as ReviewStatus,
    );
  }

  authorizeRepair(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.capability,
      args.expected_version,
      "REPAIR_AUTHORIZED",
      (state) => authorizeRepair(state, args),
    );
  }

  resumeReview(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.capability,
      args.expected_version,
      "REVIEW_RESUMED",
      (state) => resumeReview(state, args),
    );
  }

  finalizeRepairExhausted(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.capability,
      args.expected_version,
      "REPAIR_EXHAUSTED",
      (state) => finalizeRepairExhausted(state, args),
      "STOPPED_REPAIR_EXHAUSTED",
    );
  }

  authorizeCommit(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.capability,
      args.expected_version,
      "COMMIT_AUTHORIZED",
      (state) => {
        if (state.review_target.review_mode !== "working_tree") {
          fail("ERROR_COMMIT_NOT_ALLOWED", "commit authorization requires a working-tree review");
        }
        if (!state.review_receipt) fail("ERROR_STALE_RECEIPT", "review receipt is missing");
        verifyReviewReceipt(this.root, state.review_receipt, state.approved_paths, state.base_head);
        return authorizeCommit(state, args);
      },
    );
  }

  recordCommit(input: unknown): RoleView {
    const args = mutationInput(input);
    exactKeys(args, ["workflow_id", "capability", "expected_version", "commit_hash"], "commit record");
    return this.#mutate(
      args.workflow_id,
      "committer",
      args.capability,
      args.expected_version,
      "COMMIT_RECORDED",
      (state) => {
        if (state.legacy_v1 !== true) {
          fail("ERROR_LEGACY_WORKFLOW", "workflow_record_commit is only for migrated workflows");
        }
        if (state.phase !== "COMMIT_AUTHORIZED") {
          fail("ERROR_INVALID_TRANSITION", `phase ${state.phase}`);
        }
        const evidence: CommitVerification = verifyCommit(this.root, state, args.commit_hash);
        return recordCommit(state, evidence, args);
      },
      (next) => next.commit_result!.outcome,
    );
  }

  prepareCommit(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "committer",
      args.capability,
      args.expected_version,
      "COMMIT_PREPARED",
      (state) => {
        const evidence: CommitPreparationEvidence = prepareCommitReceipt(this.root, state);
        return prepareCommit(state, args, evidence);
      },
    );
  }

  submitCommitResult(input: unknown): RoleView {
    const args = mutationInput(input);
    exactKeys(
      args,
      [
        "workflow_id",
        "capability",
        "expected_version",
        "attempt_id",
        "outcome",
        "commit_hash",
        "failure_summary",
      ],
      "commit result",
    );
    return this.#mutate(
      args.workflow_id,
      "committer",
      args.capability,
      args.expected_version,
      "COMMIT_RESULT_SUBMITTED",
      (state) => {
        const next = submitCommitResult(state, args);
        const mismatch: CommitMismatchCategory | null = verifyCommitResult(this.root, state, args);
        if (mismatch) return commitMismatch(state, mismatch);
        return next;
      },
      (next) => next.commit_result!.outcome,
    );
  }

  retryCommit(input: unknown): RoleView {
    const args = mutationInput(input);
    exactKeys(args, ["workflow_id", "capability", "expected_version", "retry_context"], "commit retry");
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.capability,
      args.expected_version,
      "COMMIT_RETRY_AUTHORIZED",
      (state) => retryCommit(state, args),
      "retry",
    );
  }

  createLinkedFollowup(input: unknown): {
    workflow: ParentView;
    capabilities: RoleCapabilities;
  } {
    this.#ensureOpen();
    const args = mutationInput(input);
    const expectedVersionNumber = expectedVersion(args.expected_version);
    const id = workflowId(args.workflow_id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#row(id);
      this.#assertAuth(row, "parent", args.capability);
      if (row.version !== expectedVersionNumber)
        fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      const state = parseState(row);
      const followup = linkedFollowupInput(state, args, this.root, currentHead(this.root));
      const childId = randomUUID() as WorkflowId;
      const childState = linkedFollowupChildState(followup);
      const childReceipt = createReceipt(this.root, childState.approved_paths, true);
      if (childReceipt.base_head !== followup.base_head)
        fail("ERROR_STALE_BASE", "scope base is stale");
      childState.workflow_id = childId;
      childState.initial_receipt = childReceipt;
      childState.dirty_baseline_paths = dirtyBaselinePaths(childReceipt);
      const childCapabilities: RoleCapabilities = {
        parent: issueCapability(),
        implementer: issueCapability(),
        reviewer: issueCapability(),
        committer: issueCapability(),
      };
      const childHashes = this.#capabilityHashes(childCapabilities);
      const now = isoNow();
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
      const next = { ...state, version: (expectedVersionNumber + 1) as WorkflowVersion };
      const result = this.db
        .prepare(
          "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
        )
        .run(next.version, JSON.stringify(next), objectDigest(next), now, id, expectedVersionNumber);
      if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
      this.#audit(
        id,
        next.version,
        "LINKED_FOLLOWUP_CREATED",
        "parent",
        auditEnvelope(state, next, row.state_digest as StateDigest | null, {
          linked_workflow_id: childId,
        }),
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

export function openStore(options: WorkflowStoreOptions = {}): WorkflowStore {
  return new WorkflowStore(options);
}

export { exactPaths };
