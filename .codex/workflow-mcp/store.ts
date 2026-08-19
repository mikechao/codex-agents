import { Database } from "bun:sqlite";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
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
  isValidRuntimeArtifact,
  type RuntimeArtifact,
  type RuntimeManifest,
} from "./runtime-artifact.js";
import {
  acceptConcerns,
  authorizeCommit,
  authorizeRepair,
  beginReview,
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
import type {
  ActorRole,
  AuditEnvelope,
  AuditEvent,
  AuditEventType,
  AuditOutcome,
  CapabilityHash,
  ChangeReceipt,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitVerification,
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
import {
  canonicalJson,
  compareCapability,
  exactKeys,
  exactPaths,
  expectedVersion,
  hashCapability,
  isoNow,
  issueCapability,
  objectDigest,
  role,
  workflowId,
} from "./validation.js";

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
  /** Immutable runtime identity supplied by bootstrap for newly created workflows. */
  runtimeId?: string;
  runtimeRevision?: string;
  /** Ephemeral supervisor launch attestation for the current immutable child. */
  runtimeAttestation?: string;
  runtimeAttestationNonce?: string;
  /** Test-only key override for stores instantiated directly from source. */
  runtimeAttestationKey?: string;
}

export interface RuntimeAffinity {
  runtime_id: string | null;
  runtime_revision: string | null;
}

function runtimeAffinityPair(
  runtimeId: string | null,
  runtimeRevision: string | null,
): RuntimeAffinity {
  if ((runtimeId === null) !== (runtimeRevision === null)) {
    fail("ERROR_RUNTIME_RECOVERY", "workflow runtime affinity is incomplete");
  }
  return { runtime_id: runtimeId, runtime_revision: runtimeRevision };
}

export function createRuntimeAttestation(
  runtimeId: string,
  runtimeRevision: string,
  nonce: string,
  key: string | Buffer,
): string {
  return createHmac("sha256", key)
    .update(`${runtimeId}\u0000${runtimeRevision}\u0000${nonce}`, "utf8")
    .digest("hex");
}

function immutableRuntimeKey(
  repositoryRoot: string,
  runtimeId: string,
  runtimeRevision: string,
): Buffer | null {
  const repository = realpathSync(repositoryRoot);
  try {
    const sourceDirectory = realpathSync(import.meta.dir);
    const artifactRoot = realpathSync(join(sourceDirectory, "..", ".."));
    if (artifactRoot === repository || artifactRoot.startsWith(`${repository}${sep}`)) return null;
    const markerPath = join(artifactRoot, ".runtime-complete");
    const manifestPath = join(artifactRoot, ".runtime-manifest.json");
    const keyPath = join(artifactRoot, ".runtime-attestation-key");
    const marker = lstatSync(markerPath);
    const manifestStat = lstatSync(manifestPath);
    const key = lstatSync(keyPath);
    if (
      marker.isSymbolicLink() ||
      !marker.isFile() ||
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile() ||
      key.isSymbolicLink() ||
      !key.isFile()
    )
      return null;
    if (readFileSync(markerPath, "utf8").trim() !== runtimeId) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RuntimeManifest;
    // The manifest revision records the artifact's historical materialization. Content-addressed
    // reuse intentionally ignores it; the requested launch revision is authenticated below by
    // HMAC(runtime_id, runtime_revision, nonce).
    const artifact: RuntimeArtifact = {
      runtime_id: runtimeId,
      runtimePath: join(artifactRoot, manifest.entrypoint),
      runtime_path: join(artifactRoot, manifest.entrypoint),
      cachePath: artifactRoot,
      attestationKeyPath: keyPath,
      revision: runtimeRevision,
      manifest,
      reused: true,
    };
    if (!isValidRuntimeArtifact(artifact)) return null;
    const contents = readFileSync(keyPath);
    return contents.byteLength === 32 ? contents : null;
  } catch {
    return null;
  }
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
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "runtime_id" in parsed &&
    "runtime_revision" in parsed
  ) {
    runtimeAffinityPair(
      (parsed as { runtime_id: string | null }).runtime_id,
      (parsed as { runtime_revision: GitCommitSha | null }).runtime_revision,
    );
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
  readonly runtimeId: string | null;
  readonly runtimeRevision: GitCommitSha | null;
  readonly runtimeAttestation: string | null;
  readonly runtimeAttestationNonce: string | null;
  private readonly runtimeAttestationKey: Buffer | null;
  private db: Database;
  private closed = false;

  constructor(options: WorkflowStoreOptions = {}) {
    this.root = realpathSync(options.repositoryRoot ?? repositoryRoot(process.cwd()));
    this.path =
      options.databasePath ?? (process.env.WORKFLOW_MCP_DB_PATH || resolveStatePath(this.root));
    this.faultAfterLinkedChildInsert = options.faultAfterLinkedChildInsert === true;
    this.faultAfterMigrationUpdate = options.faultAfterMigrationUpdate === true;
    const runtimeId = options.runtimeId ?? process.env.WORKFLOW_MCP_RUNTIME_ID ?? null;
    const runtimeRevision =
      options.runtimeRevision ?? process.env.WORKFLOW_MCP_RUNTIME_REVISION ?? null;
    const runtimeAttestation =
      options.runtimeAttestation ?? process.env.WORKFLOW_MCP_RUNTIME_ATTESTATION ?? null;
    const runtimeAttestationNonce =
      options.runtimeAttestationNonce ?? process.env.WORKFLOW_MCP_RUNTIME_ATTESTATION_NONCE ?? null;
    if (runtimeId !== null && !/^[0-9a-f]{64}$/u.test(runtimeId))
      fail("ERROR_RUNTIME_ISOLATION", "runtime identity is invalid");
    if (runtimeRevision !== null && !/^[0-9a-f]{40}$/u.test(runtimeRevision))
      fail("ERROR_RUNTIME_ISOLATION", "runtime revision is invalid");
    if (runtimeAttestation !== null && !/^[0-9a-f]{64}$/u.test(runtimeAttestation))
      fail("ERROR_RUNTIME_ISOLATION", "runtime launch attestation is invalid");
    if (runtimeAttestationNonce !== null && !/^[0-9a-f]{64}$/u.test(runtimeAttestationNonce))
      fail("ERROR_RUNTIME_ISOLATION", "runtime launch attestation nonce is invalid");
    if ((runtimeId === null) !== (runtimeRevision === null))
      fail("ERROR_RUNTIME_ISOLATION", "runtime identity is incomplete");
    this.runtimeId = runtimeId;
    this.runtimeRevision = runtimeRevision as GitCommitSha | null;
    this.runtimeAttestation = runtimeAttestation;
    this.runtimeAttestationNonce = runtimeAttestationNonce;
    this.runtimeAttestationKey =
      options.runtimeAttestationKey !== undefined
        ? Buffer.from(options.runtimeAttestationKey, "utf8")
        : runtimeId !== null && runtimeRevision !== null
          ? immutableRuntimeKey(this.root, runtimeId, runtimeRevision)
          : null;
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Bun 1.3.x strict mode validates named parameter bindings (positional `?`
    // counts are not checked in this version); every query here binds positionally.
    this.db = new Database(this.path, { strict: true });
    if (this.path !== ":memory:")
      this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    else this.db.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;");
    this.db.exec("PRAGMA foreign_keys = ON;");
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

  #assertRuntimeOwnership(row: WorkflowRow): void {
    const state = parseState(row);
    const affinity = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
    if (affinity.runtime_id === null && affinity.runtime_revision === null) return;
    if (this.runtimeId === null || this.runtimeRevision === null) {
      fail(
        "ERROR_RUNTIME_ISOLATION",
        "current runtime identity is unavailable for this affined workflow",
      );
    }
    if (
      affinity.runtime_id !== this.runtimeId ||
      affinity.runtime_revision !== this.runtimeRevision
    ) {
      fail("ERROR_RUNTIME_ISOLATION", "workflow is owned by a different runtime");
    }
    if (
      this.runtimeAttestation === null ||
      this.runtimeAttestationNonce === null ||
      this.runtimeAttestationKey === null
    )
      fail("ERROR_RUNTIME_ISOLATION", "supervisor launch attestation is unavailable");
    const expected = Buffer.from(
      createRuntimeAttestation(
        this.runtimeId,
        this.runtimeRevision,
        this.runtimeAttestationNonce,
        this.runtimeAttestationKey,
      ),
      "hex",
    );
    const actual = Buffer.from(this.runtimeAttestation, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      fail("ERROR_RUNTIME_ISOLATION", "supervisor launch attestation is invalid");
  }

  #row(workflowId: WorkflowId): WorkflowRow {
    if (typeof workflowId !== "string" || !/^[0-9a-f-]{36}$/u.test(workflowId)) {
      fail("ERROR_NOT_FOUND", "workflow is not found");
    }
    const row = this.db.prepare("SELECT * FROM workflows WHERE workflow_id = ?").get(workflowId) as
      | WorkflowRow
      | undefined;
    if (!row) fail("ERROR_NOT_FOUND", "workflow is not found");
    parseState(row);
    return row;
  }

  #migrateLegacyRows(): void {
    const rows = this.db
      .prepare("SELECT workflow_id, version, state_json, state_digest FROM workflows")
      .all() as Array<Pick<WorkflowRow, "workflow_id" | "version" | "state_json" | "state_digest">>;
    if (rows.length === 0) return;
    this.db
      .transaction(() => {
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
            next.runtime_id = this.runtimeId;
            next.runtime_revision = this.runtimeRevision;
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
          } else if (schema === 2) {
            // v2 rows created before runtime affinity existed are safely upgraded in place. They
            // remain unowned until the first host using a current immutable runtime opens them.
            if (
              typeof parsed === "object" &&
              parsed !== null &&
              (!("runtime_id" in parsed) ||
                !("runtime_revision" in parsed) ||
                !("review_start_receipt" in parsed))
            ) {
              if (row.state_digest === null || row.state_digest === undefined) {
                fail("ERROR_MIGRATION_REQUIRED", "workflow requires state migration");
              }
              if (row.state_digest !== objectDigest(parsed)) {
                fail("ERROR_STATE_CORRUPT", "workflow state digest is corrupted");
              }
              const next = {
                ...(parsed as WorkflowState),
                runtime_id: "runtime_id" in parsed ? parsed.runtime_id : null,
                runtime_revision: "runtime_revision" in parsed ? parsed.runtime_revision : null,
                review_start_receipt:
                  "review_start_receipt" in parsed ? parsed.review_start_receipt : null,
              };
              runtimeAffinityPair(
                next.runtime_id as string | null,
                next.runtime_revision as GitCommitSha | null,
              );
              validateWorkflowStateV2(next);
              const result = this.db
                .prepare(
                  "UPDATE workflows SET state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
                )
                .run(
                  JSON.stringify(next),
                  objectDigest(next),
                  isoNow(),
                  row.workflow_id,
                  row.version,
                );
              if (result.changes !== 1) fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
              parsed = next;
            }
            runtimeAffinityPair(
              (parsed as WorkflowState).runtime_id,
              (parsed as WorkflowState).runtime_revision,
            );
            validateWorkflowStateV2(parsed);
          } else {
            fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
          }
        }
      })
      .immediate();
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
    state.runtime_id = this.runtimeId;
    state.runtime_revision = this.runtimeRevision;
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
    const created = this.db
      .transaction(() => {
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
        return state;
      })
      .immediate();
    return { workflow: roleView(created, "parent"), capabilities };
  }

  get(workflowIdValue: unknown, actorRole: unknown, token: unknown): RoleView {
    this.#ensureOpen();
    const id = workflowId(workflowIdValue);
    const row = this.#row(id);
    const selectedRole = this.#assertAuth(row, actorRole, token);
    this.#assertRuntimeOwnership(row);
    return roleViewForRole(parseState(row), selectedRole);
  }

  /** Read only the persisted owning runtime; used by the bootstrap supervisor before auth. */
  runtimeAffinity(workflowIdValue: unknown): RuntimeAffinity {
    this.#ensureOpen();
    const id = workflowId(workflowIdValue);
    const state = parseState(this.#row(id));
    return runtimeAffinityPair(state.runtime_id, state.runtime_revision);
  }

  /** Bind a pre-affinity v2 row to this host's current immutable runtime on first use. */
  adoptRuntime(workflowIdValue: unknown): RuntimeAffinity {
    this.#ensureOpen();
    const id = workflowId(workflowIdValue);
    if (this.runtimeId === null || this.runtimeRevision === null) {
      fail("ERROR_RUNTIME_RECOVERY", "current immutable runtime is unavailable for adoption");
    }
    return this.db
      .transaction(() => {
        const row = this.#row(id);
        const state = parseState(row);
        const current = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
        if (current.runtime_id !== null || current.runtime_revision !== null) return current;
        const next = {
          ...state,
          runtime_id: this.runtimeId,
          runtime_revision: this.runtimeRevision,
          version: (row.version + 1) as WorkflowVersion,
        };
        validateWorkflowStateV2(next);
        const result = this.db
          .prepare(
            "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
          )
          .run(next.version, JSON.stringify(next), objectDigest(next), isoNow(), id, row.version);
        if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        this.#audit(
          id,
          next.version,
          "WORKFLOW_MIGRATED",
          "parent",
          auditEnvelope(state, next, row.state_digest as StateDigest | null, {
            outcome: next.phase,
          }),
        );
        return { runtime_id: next.runtime_id, runtime_revision: next.runtime_revision };
      })
      .immediate();
  }

  audit(workflowIdValue: unknown, actorRole: unknown, token: unknown): AuditEvent[] {
    this.#ensureOpen();
    const id = workflowId(workflowIdValue);
    const row = this.#row(id);
    this.#assertAuth(row, actorRole, token);
    this.#assertRuntimeOwnership(row);
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
    const { next, selectedRole } = this.db
      .transaction(() => {
        const row = this.#row(id);
        const selectedRole = this.#assertAuth(row, actorRole, token);
        this.#assertRuntimeOwnership(row);
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
          .run(
            nextVersion,
            JSON.stringify(next),
            objectDigest(next),
            now,
            id,
            expectedVersionNumber,
          );
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
        return { next, selectedRole };
      })
      .immediate();
    return roleViewForRole(next, selectedRole);
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
        return submitImplementation(state, args, this.root, currentReceipt);
      },
      outcome,
    );
  }

  beginReview(input: unknown): RoleView {
    const args = mutationInput(input);
    return this.#mutate(
      args.workflow_id,
      "reviewer",
      args.capability,
      args.expected_version,
      "REVIEW_STARTED",
      (state) => {
        if (state.review_target.review_mode !== "working_tree") {
          fail("ERROR_INVALID_REVIEW", "commit-range reviews do not use review snapshots");
        }
        const startReceipt = createReceipt(this.root, state.approved_paths, true);
        if (startReceipt.base_head !== state.base_head) {
          fail("ERROR_STALE_RECEIPT", "review snapshot base is stale; begin review again");
        }
        return beginReview(state, args, startReceipt);
      },
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
        if (
          state.review_target.base_revision !== state.base_head ||
          canonicalJson(state.review_target.approved_paths) !== canonicalJson(state.approved_paths)
        ) {
          fail("ERROR_INVALID_REVIEW", "authoritative review target is stale or corrupt");
        }
        if (state.review_target.review_mode === "commit_range") {
          if (state.workflow_type !== "review_only") {
            fail("ERROR_INVALID_REVIEW", "authoritative commit-range target is invalid");
          }
          // Re-resolve the persisted range so a deleted or rewritten authoritative target fails
          // closed instead of allowing semantic review of an unavailable revision.
          reviewRange(this.root, state.review_target);
        }
        let finalReceipt: ChangeReceipt | null = null;
        if (state.review_target.review_mode === "working_tree") {
          if (!state.review_start_receipt) {
            fail("ERROR_INVALID_REVIEW", "working-tree review must begin before submission");
          }
          if (args.review_status === "APPROVED") {
            finalReceipt = createReceipt(this.root, state.approved_paths, true);
            if (finalReceipt.base_head !== state.base_head) {
              fail("ERROR_STALE_RECEIPT", "review base changed; begin a new review");
            }
            if (canonicalJson(finalReceipt) !== canonicalJson(state.review_start_receipt)) {
              fail(
                "ERROR_INVALID_REVIEW",
                "working tree changed after review began; begin a new review before approving",
              );
            }
          }
        }
        return submitReview(state, args, finalReceipt);
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
    exactKeys(
      args,
      ["workflow_id", "capability", "expected_version", "commit_hash"],
      "commit record",
    );
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
    exactKeys(
      args,
      ["workflow_id", "capability", "expected_version", "retry_context"],
      "commit retry",
    );
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
    const result = this.db
      .transaction(() => {
        const row = this.#row(id);
        this.#assertAuth(row, "parent", args.capability);
        this.#assertRuntimeOwnership(row);
        if (row.version !== expectedVersionNumber)
          fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        const state = parseState(row);
        const followup = linkedFollowupInput(state, args, this.root, currentHead(this.root));
        const childId = randomUUID() as WorkflowId;
        const childState = linkedFollowupChildState(followup);
        const parentAffinity = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
        childState.runtime_id = parentAffinity.runtime_id;
        childState.runtime_revision = parentAffinity.runtime_revision as GitCommitSha | null;
        childState.workflow_id = childId;
        validateWorkflowStateV2(childState);
        const childReceipt = createReceipt(this.root, childState.approved_paths, true);
        if (childReceipt.base_head !== followup.base_head)
          fail("ERROR_STALE_BASE", "scope base is stale");
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
        const update = this.db
          .prepare(
            "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
          )
          .run(
            next.version,
            JSON.stringify(next),
            objectDigest(next),
            now,
            id,
            expectedVersionNumber,
          );
        if (update.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
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
        return { childState, childCapabilities };
      })
      .immediate();
    return {
      workflow: roleView(result.childState, "parent"),
      capabilities: result.childCapabilities,
    };
  }
}

export function openStore(options: WorkflowStoreOptions = {}): WorkflowStore {
  return new WorkflowStore(options);
}

export { exactPaths };
