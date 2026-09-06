import { Database } from "bun:sqlite";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  createDiagnosticRecorder,
  type DiagnosticRecorder,
  type DiagnosticRecorderOptions,
  diagnosticRequestContext,
} from "./diagnostics.js";
import { fail, WorkflowError } from "./errors.js";
import {
  createReceipt,
  currentHead,
  prepareCommitReceipt,
  repositoryRoot,
  reviewRange,
  stagedAdoptionStates,
  stagedScopeChanges,
  verifyCommitResult,
  verifyReviewReceipt,
} from "./git.js";
import { lineageReferences, MAX_LINEAGE_RECORDS } from "./lineage.js";
import { assertSupportedStateSchema } from "./migration.js";
import { deriveOperatorDecision, type OperatorLineageRecord } from "./operator-decision.js";
import { PlanStore, validatePersistedPlanRows } from "./plan-store.js";
import {
  isValidRuntimeArtifact,
  type RuntimeArtifact,
  type RuntimeManifest,
} from "./runtime-artifact.js";
import type { LinkedFollowupPlan } from "./transitions.js";
import {
  acceptConcerns,
  adjudicateFindings,
  adoptDirtyScope,
  allRequiredValidationsPassed,
  approvedPathBaselineView,
  authorizeCommit,
  authorizeRepair,
  beginReview,
  commitMismatch,
  commitPreparationFailed,
  createState,
  createStateFromPlan,
  dirtyBaselinePaths,
  expandScope,
  finalizeRepairExhausted,
  IMPLEMENTATION_STOP_PHASES,
  linkedFollowupChildState,
  linkedFollowupInput,
  linkedFollowupInputFromPlan,
  pendingManualValidations,
  permittedNextActions,
  prepareCommit,
  rangeDirtyBaselinePaths,
  recordManualValidation,
  resumeImplementation,
  resumeReview,
  retryCommit,
  retryCommitPreparation,
  returnCommitToReview,
  roleView,
  submitCommitResult,
  submitImplementation,
  submitReview,
  validateCommitResult,
  validateWorkflowStateV9,
} from "./transitions.js";
import type {
  ActorRole,
  AuditEnvelope,
  AuditEvent,
  AuditEventType,
  AuditOutcome,
  ChangeReceipt,
  CommitPreparationEvidence,
  CommitPreparationFailureCategory,
  DirtyScopeAdoptionAudit,
  DirtyScopeAdoptionIndexState,
  DirtyScopeAdoptionState,
  FindingAdjudication,
  GitCommitSha,
  IsoTimestamp,
  OperatorDecision,
  ParentView,
  PlannerPlanRead,
  PlanRead,
  Role,
  RoleView,
  ScopeExpansionAudit,
  StateDigest,
  WorkflowAction,
  WorkflowId,
  WorkflowRow,
  WorkflowState,
  WorkflowVersion,
} from "./types.js";
import {
  canonicalJson,
  exactKeys,
  exactPaths,
  expectedVersion,
  isoNow,
  objectDigest,
  repairCycle,
  workItems,
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
  /** Immutable runtime identity supplied by bootstrap for newly created workflows. */
  runtimeId?: string;
  runtimeRevision?: string;
  /** Ephemeral supervisor launch attestation for the current immutable child. */
  runtimeAttestation?: string;
  runtimeAttestationNonce?: string;
  /** Test-only key override for stores instantiated directly from source. */
  runtimeAttestationKey?: string;
  diagnostics?: DiagnosticRecorder;
  diagnosticsOptions?: DiagnosticRecorderOptions;
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

function isMutationRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mutationInput(value: unknown): Record<string, unknown> {
  if (!isMutationRecord(value)) {
    fail("ERROR_INVALID_SHAPE", "mutation input is invalid");
  }
  return value;
}

/** Raw pre-routing envelopes. Runtime validation remains at the established mutation/transition boundary. */
export interface RawParentMutation {
  workflow_id?: unknown;
  expected_version?: unknown;
}

export interface RawWorkerMutation {
  workflow_id?: unknown;
  expected_version?: unknown;
}

export interface RawContextMutation extends RawParentMutation {
  resume_context?: unknown;
}

export interface RawRetryContextMutation extends RawParentMutation {
  retry_context?: unknown;
}

export interface RawReviewContextMutation extends RawParentMutation {
  review_context?: unknown;
}

export interface RawAuthorizationMutation extends RawParentMutation {
  user_authorization?: unknown;
}

export interface RawManualValidationMutation extends RawParentMutation {
  validation_id?: unknown;
  status?: unknown;
  evidence?: unknown;
}

export interface RawFindingIdsMutation extends RawParentMutation {
  finding_ids?: unknown;
  repair_directive?: unknown;
}

export interface RawImplementationSubmissionMutation extends RawWorkerMutation {
  status?: unknown;
  summary?: unknown;
  agent_touched_paths?: unknown;
  acceptance_results?: unknown;
  validation_results?: unknown;
  known_failures?: unknown;
  finding_resolution_map?: unknown;
}

export interface RawReviewSubmissionMutation extends RawWorkerMutation {
  review_status?: unknown;
  blocking_findings?: unknown;
  optional_findings?: unknown;
  prior_finding_classifications?: unknown;
  validation_results?: unknown;
}

export interface RawCommitResultMutation extends RawWorkerMutation {
  attempt_id?: unknown;
  outcome?: unknown;
  failure_summary?: unknown;
}

type RawMutationRecord = Record<string, unknown>;
type ParentFields = RawMutationRecord & RawParentMutation;
type WorkerFields = RawMutationRecord & RawWorkerMutation;
type ContextFields = RawMutationRecord & RawContextMutation;
type RetryContextFields = RawMutationRecord & RawRetryContextMutation;
type ReviewContextFields = RawMutationRecord & RawReviewContextMutation;
type AuthorizationFields = RawMutationRecord & RawAuthorizationMutation;
type ManualValidationFields = RawMutationRecord & RawManualValidationMutation;
type FindingIdsFields = RawMutationRecord & RawFindingIdsMutation;
type ImplementationFields = RawMutationRecord & RawImplementationSubmissionMutation;
type ReviewFields = RawMutationRecord & RawReviewSubmissionMutation;
type CommitResultFields = RawMutationRecord & RawCommitResultMutation;

function parentMutation(value: unknown): ParentFields {
  const input = mutationInput(value);
  if ("capability" in input) {
    fail("ERROR_INVALID_SHAPE", "capability is not supported");
  }
  return input;
}

function workerMutation(value: unknown): WorkerFields {
  return mutationInput(value);
}

function parentContextMutation(value: unknown): ContextFields {
  return parentMutation(value);
}

function parentRetryContextMutation(value: unknown): RetryContextFields {
  return parentMutation(value);
}

function parentReviewContextMutation(value: unknown): ReviewContextFields {
  return parentMutation(value);
}

function parentAuthorizationMutation(value: unknown): AuthorizationFields {
  return parentMutation(value);
}

function parentManualValidationMutation(value: unknown): ManualValidationFields {
  return parentMutation(value);
}

function parentFindingIdsMutation(value: unknown): FindingIdsFields {
  return parentMutation(value);
}

function implementationMutation(value: unknown): ImplementationFields {
  return workerMutation(value);
}

function reviewMutation(value: unknown): ReviewFields {
  return workerMutation(value);
}

function commitResultMutation(value: unknown): CommitResultFields {
  return workerMutation(value);
}

function reviewAuditOutcome(value: unknown): AuditOutcome | null {
  return value === "APPROVED" || value === "CHANGES_REQUESTED" || value === "INCONCLUSIVE"
    ? value
    : null;
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

function assertApprovedPlanUnchanged(before: WorkflowState, after: WorkflowState): void {
  if (
    before.objective !== after.objective ||
    before.approved_plan !== after.approved_plan ||
    before.execution_brief !== after.execution_brief ||
    canonicalJson(before.plan_provenance) !== canonicalJson(after.plan_provenance) ||
    canonicalJson(before.acceptance_criteria) !== canonicalJson(after.acceptance_criteria) ||
    canonicalJson(before.validation_requirements) !== canonicalJson(after.validation_requirements)
  ) {
    fail("ERROR_INVALID_TRANSITION", "approved plan and execution contract are immutable");
  }
}

function assertWorkItemsUnchanged(before: WorkflowState, after: WorkflowState): void {
  if (canonicalJson(before.work_items) !== canonicalJson(after.work_items)) {
    fail("ERROR_INVALID_TRANSITION", "work-item provenance is immutable");
  }
}

function assertScopeUnchanged(before: WorkflowState, after: WorkflowState): void {
  if (
    canonicalJson(before.approved_paths) !== canonicalJson(after.approved_paths) ||
    canonicalJson(before.review_target.approved_paths) !==
      canonicalJson(after.review_target.approved_paths) ||
    canonicalJson(before.scope_expansions) !== canonicalJson(after.scope_expansions) ||
    canonicalJson(before.approved_path_baselines) !== canonicalJson(after.approved_path_baselines)
  ) {
    fail("ERROR_INVALID_TRANSITION", "approved scope is immutable outside workflow_expand_scope");
  }
}

function assertFindingAdjudicationsAppendOnly(
  before: WorkflowState,
  after: WorkflowState,
  eventType: AuditEventType,
): void {
  const prior = before.finding_adjudications;
  const current = after.finding_adjudications;
  const appendOnly =
    current.length >= prior.length &&
    canonicalJson(current.slice(0, prior.length)) === canonicalJson(prior);
  if (!appendOnly || (eventType !== "FINDINGS_ADJUDICATED" && current.length !== prior.length)) {
    fail("ERROR_INVALID_TRANSITION", "finding adjudication history is not append-only");
  }
  if (eventType === "FINDINGS_ADJUDICATED" && current.length === prior.length) {
    fail("ERROR_INVALID_TRANSITION", "finding adjudication history was not appended");
  }
}

function isLinkedReviewStageTransition(before: WorkflowState, after: WorkflowState): boolean {
  const continuation = after.linked_continuation;
  return (
    before.linked_continuation?.review_stage === "remediation" &&
    continuation?.review_stage === "combined" &&
    canonicalJson(before.approved_paths) === canonicalJson(after.approved_paths) &&
    canonicalJson(after.review_target.approved_paths) ===
      canonicalJson(continuation.combined_review_paths)
  );
}

function auditEnvelope(
  before: WorkflowState | null,
  after: WorkflowState,
  digestBefore: StateDigest | null,
  options: {
    linked_workflow_id?: WorkflowId | null;
    outcome?: AuditOutcome | null;
    state_digest_after?: StateDigest;
  } = {},
): AuditEnvelope {
  return {
    schema_version: 2,
    phase_before: before ? before.phase : null,
    phase_after: after.phase,
    state_digest_before: digestBefore ?? null,
    state_digest_after: options.state_digest_after ?? objectDigest(after),
    changed_fields: changedFields(before, after),
    linked_workflow_id: options.linked_workflow_id ?? null,
    outcome: options.outcome ?? null,
  };
}

function createCurrentSchema(db: Database): void {
  db.exec(`
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      state_digest TEXT,
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
    CREATE TABLE plans (
      plan_id TEXT PRIMARY KEY,
      current_revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE plan_revisions (
      plan_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      artifact_json TEXT NOT NULL,
      artifact_digest TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, revision),
      FOREIGN KEY (plan_id) REFERENCES plans(plan_id)
    );
    CREATE TABLE plan_approvals (
      plan_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      artifact_digest TEXT NOT NULL,
      user_authorization TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (plan_id, revision),
      FOREIGN KEY (plan_id, revision) REFERENCES plan_revisions(plan_id, revision)
    );
  `);
}

function quotedIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function schemaSignature(db: Database): string {
  const master = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name)
    .map((table) => ({
      name: table,
      info: db.prepare(`PRAGMA table_xinfo(${quotedIdentifier(table)})`).all(),
      indexes: db.prepare(`PRAGMA index_list(${quotedIdentifier(table)})`).all(),
      foreignKeys: db.prepare(`PRAGMA foreign_key_list(${quotedIdentifier(table)})`).all(),
    }));
  return JSON.stringify({ master, tables });
}

function unsupportedSchema(): never {
  fail(
    "ERROR_MIGRATION_REQUIRED",
    "persisted Workflow MCP database schema is unsupported; reset the database and restart",
  );
}

function currentSchemaSignature(): string {
  const db = new Database(":memory:");
  try {
    createCurrentSchema(db);
    return schemaSignature(db);
  } finally {
    db.close();
  }
}

function requireCurrentSchema(db: Database): void {
  const objects = db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
  if (!objects) {
    createCurrentSchema(db);
    return;
  }
  let signature: string;
  try {
    signature = schemaSignature(db);
  } catch {
    unsupportedSchema();
  }
  if (signature !== currentSchemaSignature()) unsupportedSchema();
}

function parseState(row: WorkflowRow): WorkflowState {
  if (row.state_digest === null || row.state_digest === undefined) {
    fail("ERROR_STATE_CORRUPT", "workflow state digest is missing");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.state_json);
  } catch {
    fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
  }
  assertSupportedStateSchema(parsed);
  if (row.state_digest !== objectDigest(parsed)) {
    fail("ERROR_STATE_CORRUPT", "workflow state digest is corrupted");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== row.version
  ) {
    fail("ERROR_STATE_CORRUPT", "workflow state version is corrupted");
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
  return validateWorkflowStateV9(parsed);
}

function validatePersistedRows(db: Database): void {
  const rows = db.prepare("SELECT * FROM workflows").all() as WorkflowRow[];
  for (const row of rows) parseState(row);
}

function adoptionStates(
  receipt: ChangeReceipt,
  paths: ReadonlyArray<string>,
): DirtyScopeAdoptionState[] {
  return paths.map((path) => {
    const entry = receipt.paths.find((candidate) => candidate.path === path);
    if (!entry) {
      fail("ERROR_STALE_ADOPTION", "adopted path is no longer dirty");
    }
    return {
      path: entry.path,
      state: entry.state,
      kind: entry.kind,
      ...("mode" in entry ? { mode: entry.mode } : {}),
    };
  });
}

function adoptionCommitment(
  baseHead: GitCommitSha,
  receiptPaths: ChangeReceipt["paths"],
  indexStates: DirtyScopeAdoptionIndexState[],
): StateDigest {
  return objectDigest({ base_head: baseHead, paths: receiptPaths, index_states: indexStates });
}

function samePathList(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

type MutationAuditDetails = {
  dirty_scope_adoption?: DirtyScopeAdoptionAudit;
  finding_adjudications?: FindingAdjudication[];
};

type ExistingWorkflowTransition = {
  row: WorkflowRow;
  current: WorkflowState;
  expectedVersion: WorkflowVersion;
  next: WorkflowState;
  eventType: AuditEventType;
  actorRole: ActorRole;
  outcome: AuditOutcome | null;
  details: MutationAuditDetails;
};

// roleView's public overloads only accept literal roles; the store reaches the
// implementation signature with the exact role selected by each dedicated getter.
const roleViewForRole = roleView as unknown as (state: WorkflowState, actorRole: Role) => RoleView;

function supportedPreparationFailure(
  error: unknown,
): { category: CommitPreparationFailureCategory; detail: string } | null {
  if (!(error instanceof WorkflowError)) return null;
  if (
    error.category !== "ERROR_STAGED_SCOPE" &&
    error.category !== "ERROR_STAGED_CONTENT" &&
    error.category !== "ERROR_STALE_RECEIPT"
  ) {
    return null;
  }
  return { category: error.category, detail: error.detail || error.category };
}

export class WorkflowStore {
  readonly root: string;
  readonly path: string;
  readonly faultAfterLinkedChildInsert: boolean;
  readonly runtimeId: string | null;
  readonly runtimeRevision: GitCommitSha | null;
  readonly runtimeAttestation: string | null;
  readonly runtimeAttestationNonce: string | null;
  private readonly runtimeAttestationKey: Buffer | null;
  readonly diagnostics: DiagnosticRecorder;
  private db: Database;
  private readonly planStore: PlanStore;
  private closed = false;

  constructor(options: WorkflowStoreOptions = {}) {
    this.root = realpathSync(options.repositoryRoot ?? repositoryRoot(process.cwd()));
    this.path =
      options.databasePath ?? (process.env.WORKFLOW_MCP_DB_PATH || resolveStatePath(this.root));
    this.faultAfterLinkedChildInsert = options.faultAfterLinkedChildInsert === true;
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
    this.diagnostics =
      options.diagnostics ??
      createDiagnosticRecorder("runtime-store", this.root, options.diagnosticsOptions);
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Bun 1.3.x strict mode validates named parameter bindings (positional `?`
    // counts are not checked in this version); every query here binds positionally.
    this.db = new Database(this.path, { strict: true });
    try {
      requireCurrentSchema(this.db);
      validatePersistedRows(this.db);
      validatePersistedPlanRows(this.db, this.root);
      if (this.path !== ":memory:")
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      else this.db.exec("PRAGMA journal_mode = MEMORY; PRAGMA synchronous = OFF;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.planStore = new PlanStore(this.db, this.root);
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

  #assertRuntimeOwnership(row: WorkflowRow): void {
    const state = parseState(row);
    const affinity = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
    if (affinity.runtime_id === null && affinity.runtime_revision === null) return;
    this.#assertRuntimeAttestation();
    if (
      affinity.runtime_id !== this.runtimeId ||
      affinity.runtime_revision !== this.runtimeRevision
    ) {
      fail("ERROR_RUNTIME_ISOLATION", "workflow is owned by a different runtime");
    }
  }

  #isCrossRuntimeCommitReconciled(row: WorkflowRow, state: WorkflowState): boolean {
    const affinity = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
    if (
      affinity.runtime_id === null ||
      affinity.runtime_revision === null ||
      (affinity.runtime_id === this.runtimeId &&
        affinity.runtime_revision === this.runtimeRevision) ||
      (state.phase !== "COMMITTED" && state.phase !== "STOPPED_COMMIT_MISMATCH")
    ) {
      return false;
    }

    const event = this.db
      .prepare(
        "SELECT actor_role, summary_json FROM audit_events WHERE workflow_id = ? AND version = ? AND event_type = 'COMMIT_RESULT_SUBMITTED'",
      )
      .all(row.workflow_id, row.version) as Array<{
      actor_role: string;
      summary_json: string;
    }>;
    if (event.length !== 1 || event[0].actor_role !== "parent") return false;

    let summary: unknown;
    try {
      summary = JSON.parse(event[0].summary_json);
    } catch {
      return false;
    }
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
    const envelope = summary as Partial<AuditEnvelope>;
    return (
      envelope.phase_before === "COMMIT_PREPARED" &&
      envelope.phase_after === state.phase &&
      envelope.state_digest_after === row.state_digest
    );
  }

  #assertRuntimeAttestation(): void {
    if (this.runtimeId === null || this.runtimeRevision === null) {
      fail(
        "ERROR_RUNTIME_ISOLATION",
        "current runtime identity is unavailable for this affined workflow",
      );
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

  #assertReconciliationRuntime(row: WorkflowRow): void {
    const state = parseState(row);
    const affinity = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
    if (affinity.runtime_id === null || affinity.runtime_revision === null) {
      fail("ERROR_COMMIT_NOT_ALLOWED", "commit reconciliation requires an owning old runtime");
    }
    if (
      affinity.runtime_id === this.runtimeId &&
      affinity.runtime_revision === this.runtimeRevision
    ) {
      fail(
        "ERROR_COMMIT_NOT_ALLOWED",
        "ordinary commit-result submission is available on the owning runtime",
      );
    }
    this.#assertRuntimeAttestation();
  }

  #row(workflowIdValue: unknown): WorkflowRow {
    const context = diagnosticRequestContext();
    const common = {
      request_id: context?.request_id,
      method: context?.method,
      tool: context?.tool,
      workflow_id: workflowIdValue,
      database_path: this.path,
    };
    if (typeof workflowIdValue !== "string" || !/^[0-9a-f-]{36}$/u.test(workflowIdValue)) {
      this.diagnostics.record({ ...common, event: "workflow_lookup", outcome: "malformed_id" });
      fail("ERROR_NOT_FOUND", "workflow is not found");
    }
    const workflowId = workflowIdValue as WorkflowId;
    const row = this.db.prepare("SELECT * FROM workflows WHERE workflow_id = ?").get(workflowId) as
      | WorkflowRow
      | undefined;
    if (!row) {
      this.diagnostics.record({
        ...common,
        event: "workflow_lookup",
        outcome: "missing_row",
        found: false,
      });
      fail("ERROR_NOT_FOUND", "workflow is not found");
    }
    const state = parseState(row);
    this.diagnostics.record({
      ...common,
      event: "workflow_lookup",
      outcome: "found",
      found: true,
      version: row.version,
      phase: state.phase,
      runtime_id: state.runtime_id,
      runtime_revision: state.runtime_revision,
    });
    return row;
  }

  #audit(
    workflowId: WorkflowId,
    version: number,
    eventType: AuditEventType,
    actorRole: ActorRole,
    summary: AuditEnvelope,
    details: {
      dirty_scope_adoption?: DirtyScopeAdoptionAudit;
      finding_adjudications?: FindingAdjudication[];
    } = {},
  ): void {
    this.db
      .prepare(
        "INSERT INTO audit_events (workflow_id, version, event_type, actor_role, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        workflowId,
        version,
        eventType,
        actorRole,
        JSON.stringify({ ...summary, ...details }),
        isoNow(),
      );
  }

  #persistExistingTransition({
    row,
    current,
    expectedVersion,
    next,
    eventType,
    actorRole,
    outcome,
    details,
  }: ExistingWorkflowTransition): WorkflowState {
    next.version = (expectedVersion + 1) as WorkflowVersion;
    validateWorkflowStateV9(next);
    const serialized = JSON.stringify(next);
    const digest = objectDigest(next);
    const workflowId = row.workflow_id as WorkflowId;
    const update = this.db
      .prepare(
        "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
      )
      .run(next.version, serialized, digest, isoNow(), workflowId, expectedVersion);
    if (update.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
    this.#audit(
      workflowId,
      next.version,
      eventType,
      actorRole,
      auditEnvelope(current, next, row.state_digest as StateDigest | null, {
        outcome,
        state_digest_after: digest,
      }),
      details,
    );
    return next;
  }

  create(input: unknown): ParentView {
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
    const now = isoNow();
    const created = this.db
      .transaction(() => {
        this.db
          .prepare(
            "INSERT INTO workflows (workflow_id, version, state_json, state_digest, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?)",
          )
          .run(workflowId, JSON.stringify(state), objectDigest(state), now, now);
        this.#audit(workflowId, 0, "WORKFLOW_CREATED", "parent", auditEnvelope(null, state, null));
        return state;
      })
      .immediate();
    return roleView(created, "parent") as ParentView;
  }

  #get(workflowIdValue: unknown, actorRole: Role): RoleView {
    this.#ensureOpen();
    const row = this.#row(workflowIdValue);
    const state = parseState(row);
    const reconciledParentRead =
      actorRole === "parent" && this.#isCrossRuntimeCommitReconciled(row, state);
    if (reconciledParentRead) this.#assertRuntimeAttestation();
    else this.#assertRuntimeOwnership(row);
    const view = roleViewForRole(state, actorRole);
    const affinity = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
    if (
      actorRole === "parent" &&
      state.phase === "COMMIT_PREPARED" &&
      affinity.runtime_id !== null &&
      (affinity.runtime_id !== this.runtimeId || affinity.runtime_revision !== this.runtimeRevision)
    ) {
      view.permitted_next_actions = [
        ...view.permitted_next_actions,
        "workflow_reconcile_commit_result",
      ];
    }
    return view;
  }

  planCreate(input: unknown): PlannerPlanRead {
    this.#ensureOpen();
    const args = mutationInput(input);
    exactKeys(
      args,
      [
        "full_plan",
        "execution_brief",
        "objective",
        "approved_paths",
        "acceptance_criteria",
        "validation_requirements",
      ],
      "plan create",
    );
    return this.planStore.planCreate({
      full_plan: args.full_plan,
      execution_brief: args.execution_brief,
      objective: args.objective,
      approved_paths: args.approved_paths,
      acceptance_criteria: args.acceptance_criteria,
      validation_requirements: args.validation_requirements,
    });
  }

  planGet(input: unknown): PlannerPlanRead {
    this.#ensureOpen();
    const args = mutationInput(input);
    exactKeys(args, ["plan_id", "revision"], "plan get");
    return this.planStore.planGet(args.plan_id, args.revision);
  }

  planParentGet(input: unknown): PlanRead {
    this.#ensureOpen();
    const args = mutationInput(input);
    exactKeys(args, ["plan_id", "revision"], "plan parent get");
    return this.planStore.planParentGet(args.plan_id, args.revision);
  }

  planRevise(input: unknown): PlannerPlanRead {
    this.#ensureOpen();
    const args = mutationInput(input);
    exactKeys(args, ["plan_id", "base_revision", "replacements"], "plan revise");
    return this.planStore.planRevise(args.plan_id, args.base_revision, args.replacements);
  }

  planApprove(input: unknown): PlanRead {
    this.#ensureOpen();
    const args = mutationInput(input);
    exactKeys(args, ["plan_id", "revision", "user_authorization"], "plan approval");
    return this.planStore.planApprove(args.plan_id, args.revision, args.user_authorization);
  }

  createFromPlan(input: unknown): ParentView {
    this.#ensureOpen();
    const args = mutationInput(input);
    exactKeys(args, ["plan_id", "revision"], "workflow create from plan", [
      "max_repair_cycles",
      "work_items",
    ]);
    const maxRepairCycles = repairCycle(args.max_repair_cycles ?? 2);
    const inheritedItems = workItems(args.work_items ?? []);
    return this.db
      .transaction(() => {
        const resolved = this.planStore.resolveApprovedPlan(args.plan_id, args.revision);
        const head = currentHead(this.root);
        const state = createStateFromPlan(
          resolved.artifact,
          resolved.provenance,
          head,
          maxRepairCycles,
          inheritedItems,
        );
        state.runtime_id = this.runtimeId;
        state.runtime_revision = this.runtimeRevision;
        state.workflow_id = randomUUID() as WorkflowId;
        const receipt = createReceipt(this.root, state.approved_paths, true);
        if (receipt.base_head !== head) fail("ERROR_STALE_BASE", "scope base is stale");
        state.initial_receipt = receipt;
        state.dirty_baseline_paths = dirtyBaselinePaths(receipt);
        validateWorkflowStateV9(state);
        const now = isoNow();
        this.db
          .prepare(
            "INSERT INTO workflows (workflow_id, version, state_json, state_digest, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?)",
          )
          .run(state.workflow_id, JSON.stringify(state), objectDigest(state), now, now);
        this.#audit(
          state.workflow_id,
          0,
          "WORKFLOW_CREATED",
          "parent",
          auditEnvelope(null, state, null),
        );
        return roleView(state, "parent") as ParentView;
      })
      .immediate();
  }

  parentGet(workflowIdValue: unknown): ParentView {
    return this.#get(workflowIdValue, "parent") as ParentView;
  }

  /**
   * Return the bounded semantic parent projection. This intentionally does not accept a
   * capability or mutation input: runtime ownership is the same read boundary as parentGet,
   * while privileged details remain available only through the explicit parent/audit surfaces.
   */
  operatorDecisionGet(workflowIdValue: unknown): OperatorDecision {
    this.#ensureOpen();
    const row = this.#row(workflowIdValue);
    const state = parseState(row);
    if (this.#isCrossRuntimeCommitReconciled(row, state)) this.#assertRuntimeAttestation();
    else this.#assertRuntimeOwnership(row);
    if (!state.workflow_id) fail("ERROR_STATE_CORRUPT", "workflow ID is missing");

    const records = new Map<string, OperatorLineageRecord>();
    const pending: WorkflowId[] = [state.workflow_id];
    while (pending.length > 0) {
      const id = pending.shift() as WorkflowId;
      if (records.has(id)) continue;
      if (records.size >= MAX_LINEAGE_RECORDS)
        fail("ERROR_STATE_CORRUPT", "explicit workflow lineage exceeds its bound");
      const relatedRow = id === row.workflow_id ? row : this.#row(id);
      const relatedState = id === row.workflow_id ? state : parseState(relatedRow);
      const actions: Partial<Record<Role, WorkflowAction[]>> = {
        parent: permittedNextActions(relatedState, "parent"),
        implementer: permittedNextActions(relatedState, "implementer"),
        reviewer: permittedNextActions(relatedState, "reviewer"),
        committer: permittedNextActions(relatedState, "committer"),
      };
      records.set(id, { state: relatedState, actions });
      for (const reference of lineageReferences(relatedState)) {
        if (!records.has(reference)) pending.push(reference);
      }
    }
    return deriveOperatorDecision(state, [...records.values()]);
  }

  isCrossRuntimeCommitReconciled(workflowIdValue: unknown): boolean {
    this.#ensureOpen();
    const row = this.#row(workflowIdValue);
    return this.#isCrossRuntimeCommitReconciled(row, parseState(row));
  }

  implementerGet(workflowIdValue: unknown): RoleView {
    return this.#get(workflowIdValue, "implementer");
  }

  reviewerGet(workflowIdValue: unknown): RoleView {
    return this.#get(workflowIdValue, "reviewer");
  }

  committerGet(workflowIdValue: unknown): RoleView {
    return this.#get(workflowIdValue, "committer");
  }

  expandScope(input: unknown): RoleView {
    const args = parentMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "SCOPE_EXPANDED",
      (state) => {
        if (
          state.workflow_type !== "change" ||
          state.review_target.review_mode !== "working_tree"
        ) {
          fail(
            "ERROR_UNSUPPORTED_WORKFLOW_TYPE",
            "scope expansion requires a working-tree change workflow",
          );
        }
        const addedPaths = exactPaths(args.adopted_paths ?? args.added_paths, this.root);
        if (addedPaths.some((path) => state.approved_paths.includes(path))) {
          fail("ERROR_INVALID_PATHS", "scope expansion path is already approved");
        }
        const head = currentHead(this.root);
        if (head !== state.base_head) fail("ERROR_STALE_BASE", "scope base is stale");
        const stagedChanges = stagedScopeChanges(this.root, addedPaths);
        const inheritedCombined = state.linked_continuation?.combined_review_paths ?? [];
        const expandingInherited =
          state.linked_continuation?.review_stage === "combined" &&
          addedPaths.every((path) => inheritedCombined.includes(path));
        if (stagedChanges.length > 0 && !expandingInherited) {
          fail("ERROR_SCOPE_EXPANSION_DIRTY", "scope expansion paths have staged changes");
        }
        const baseline = createReceipt(this.root, addedPaths, true);
        if (expandingInherited) {
          baseline.paths = baseline.paths.map((entry) =>
            entry.state === "deleted"
              ? { path: entry.path, state: "absent", kind: "missing" }
              : entry.state === "modified" || entry.state === "added"
                ? { ...entry, state: "unchanged" }
                : entry,
          ) as typeof baseline.paths;
        }
        return expandScope(state, args, baseline, this.root);
      },
    );
  }

  adoptDirtyScope(input: unknown): RoleView {
    const args = parentMutation(input);
    let adoptedReceipt: ChangeReceipt | null = null;
    let adoptedIndexStates: DirtyScopeAdoptionIndexState[] | null = null;
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "DIRTY_SCOPE_ADOPTED",
      (state) => {
        if (state.review_target.review_mode !== "working_tree") {
          fail(
            "ERROR_UNSUPPORTED_WORKFLOW_TYPE",
            "dirty scope adoption requires a working-tree review",
          );
        }
        const addedPaths = exactPaths(args.adopted_paths ?? args.added_paths, this.root);
        const pending = this.#pendingDirtyAdoptions(state, { crossRuntime: false });
        if (
          pending.some((adoption) =>
            adoption.adopted_paths.some((path) => addedPaths.includes(path)),
          )
        ) {
          fail("ERROR_INVALID_PATHS", "dirty scope adoption paths were already adopted");
        }
        const receipt = createReceipt(this.root, addedPaths, true);
        adoptedReceipt = receipt;
        adoptedIndexStates = stagedAdoptionStates(this.root, addedPaths, receipt.base_head);
        return adoptDirtyScope(
          state,
          args,
          receipt,
          this.root,
          adoptedIndexStates
            .filter((entry) => ["added", "modified", "deleted"].includes(entry.state))
            .map((entry) => entry.path),
        );
      },
      (next) => next.phase,
      (_before, next) => {
        if (!adoptedReceipt || !adoptedIndexStates)
          fail("ERROR_STALE_ADOPTION", "dirty scope adoption receipt is missing");
        const expansion = next.scope_expansions.find((candidate) =>
          samePathList(
            candidate.added_paths,
            exactPaths(args.adopted_paths ?? args.added_paths, this.root),
          ),
        );
        if (!expansion) fail("ERROR_STALE_ADOPTION", "dirty scope expansion is missing");
        return {
          dirty_scope_adoption: {
            scope_expansion_id: expansion.expansion_id,
            scope_expansion_version: expansion.resulting_version,
            adopted_paths: expansion.added_paths,
            base_head: adoptedReceipt.base_head,
            current_states: adoptionStates(adoptedReceipt, expansion.added_paths),
            index_states: adoptedIndexStates,
            current_state_commitment: adoptionCommitment(
              adoptedReceipt.base_head,
              adoptedReceipt.paths,
              adoptedIndexStates,
            ),
            runtime_id: next.runtime_id,
            runtime_revision: next.runtime_revision,
            executing_runtime_id: this.runtimeId,
            executing_runtime_revision: this.runtimeRevision,
            cross_runtime: false,
            reason: args.reason as string,
            user_authorization: args.user_authorization as string,
          },
        };
      },
    );
  }

  /** Read only the persisted owning runtime; used by the bootstrap supervisor before auth. */
  runtimeAffinity(workflowIdValue: unknown): RuntimeAffinity {
    this.#ensureOpen();
    const state = parseState(this.#row(workflowIdValue));
    return runtimeAffinityPair(state.runtime_id, state.runtime_revision);
  }

  /** Bind an un-affined current-schema row to this host's immutable runtime on first use. */
  adoptRuntime(workflowIdValue: unknown): RuntimeAffinity {
    this.#ensureOpen();
    if (this.runtimeId === null || this.runtimeRevision === null) {
      fail("ERROR_RUNTIME_RECOVERY", "current immutable runtime is unavailable for adoption");
    }
    return this.db
      .transaction(() => {
        const row = this.#row(workflowIdValue);
        const id = row.workflow_id as WorkflowId;
        const state = parseState(row);
        const current = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
        if (current.runtime_id !== null || current.runtime_revision !== null) return current;
        const next = {
          ...state,
          runtime_id: this.runtimeId,
          runtime_revision: this.runtimeRevision,
          version: (row.version + 1) as WorkflowVersion,
        };
        assertApprovedPlanUnchanged(state, next);
        assertWorkItemsUnchanged(state, next);
        assertScopeUnchanged(state, next);
        validateWorkflowStateV9(next);
        const result = this.db
          .prepare(
            "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
          )
          .run(next.version, JSON.stringify(next), objectDigest(next), isoNow(), id, row.version);
        if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        this.#audit(
          id,
          next.version,
          "WORKFLOW_RUNTIME_ADOPTED",
          "parent",
          auditEnvelope(state, next, row.state_digest as StateDigest | null, {
            outcome: next.phase,
          }),
        );
        return { runtime_id: next.runtime_id, runtime_revision: next.runtime_revision };
      })
      .immediate();
  }

  audit(workflowIdValue: unknown): AuditEvent[] {
    this.#ensureOpen();
    const row = this.#row(workflowIdValue);
    const id = row.workflow_id as WorkflowId;
    this.#assertRuntimeOwnership(row);
    const state = parseState(row);
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
    ).map((event) => {
      const result: AuditEvent = {
        version: event.version,
        event_type: event.event_type as AuditEventType,
        actor_role: event.actor_role as ActorRole,
        summary: JSON.parse(event.summary_json) as AuditEnvelope,
        created_at: event.created_at as IsoTimestamp,
      };
      const rawSummary = JSON.parse(event.summary_json) as AuditEnvelope & {
        dirty_scope_adoption?: DirtyScopeAdoptionAudit;
        finding_adjudications?: FindingAdjudication[];
      };
      if (rawSummary.dirty_scope_adoption)
        result.dirty_scope_adoption = rawSummary.dirty_scope_adoption;
      if (result.event_type === "SCOPE_EXPANDED") {
        const expansion = state.scope_expansions.find(
          (candidate) => candidate.resulting_version === result.version,
        );
        if (expansion) {
          const auditProjection: ScopeExpansionAudit = {
            expansion,
            baselines: state.approved_path_baselines
              .filter((entry) => entry.approved_at_version === result.version)
              .map(approvedPathBaselineView),
          };
          result.scope_expansion = auditProjection;
        }
      }
      if (result.event_type === "FINDINGS_ADJUDICATED") {
        result.finding_adjudications = rawSummary.finding_adjudications;
      }
      return result;
    });
  }

  #pendingDirtyAdoptions(
    state: WorkflowState,
    options: { crossRuntime: boolean | "any" | "historical-owner" },
  ): DirtyScopeAdoptionAudit[] {
    const id = state.workflow_id;
    if (!id) fail("ERROR_STATE_CORRUPT", "workflow ID is missing");
    const rows = this.db
      .prepare(
        "SELECT version, event_type, summary_json FROM audit_events WHERE workflow_id = ? ORDER BY event_id",
      )
      .all(id) as Array<{ version: number; event_type: string; summary_json: string }>;
    let lastReviewStart = -1;
    rows.forEach((row, index) => {
      if (row.event_type === "REVIEW_STARTED") lastReviewStart = index;
    });
    const pending = rows
      .slice(lastReviewStart + 1)
      .filter((row) => row.event_type === "DIRTY_SCOPE_ADOPTED");
    const seen = new Set<string>();
    const result: DirtyScopeAdoptionAudit[] = [];
    const owner = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
    for (const row of pending) {
      let summary: unknown;
      try {
        summary = JSON.parse(row.summary_json);
      } catch {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption audit evidence is malformed");
      }
      const detail =
        summary && typeof summary === "object" && !Array.isArray(summary)
          ? (summary as { dirty_scope_adoption?: DirtyScopeAdoptionAudit }).dirty_scope_adoption
          : undefined;
      if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption audit evidence is missing");
      }
      if (
        !Array.isArray(detail.adopted_paths) ||
        detail.adopted_paths.length === 0 ||
        detail.adopted_paths.some((path) => typeof path !== "string") ||
        new Set(detail.adopted_paths).size !== detail.adopted_paths.length ||
        typeof detail.scope_expansion_id !== "string" ||
        !Number.isSafeInteger(detail.scope_expansion_version) ||
        typeof detail.base_head !== "string" ||
        !Array.isArray(detail.current_states) ||
        !Array.isArray(detail.index_states) ||
        typeof detail.current_state_commitment !== "string" ||
        typeof detail.cross_runtime !== "boolean" ||
        typeof detail.reason !== "string" ||
        typeof detail.user_authorization !== "string"
      ) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption audit evidence is invalid");
      }
      const expansion = state.scope_expansions.find(
        (candidate) =>
          candidate.expansion_id === detail.scope_expansion_id &&
          candidate.resulting_version === detail.scope_expansion_version,
      );
      if (!expansion || !samePathList(expansion.added_paths, detail.adopted_paths)) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption expansion evidence is inconsistent");
      }
      if (row.version <= expansion.resulting_version || row.version > state.version) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption audit version is inconsistent");
      }
      const baselines = state.approved_path_baselines.filter(
        (baseline) => baseline.approved_at_version === expansion.resulting_version,
      );
      if (
        !samePathList(
          baselines.map((baseline) => baseline.path),
          detail.adopted_paths,
        )
      ) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption baselines are inconsistent");
      }
      if (
        detail.adopted_paths.some((path) => !state.approved_paths.includes(path) || seen.has(path))
      ) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption paths are duplicated or unapproved");
      }
      for (const path of detail.adopted_paths) seen.add(path);
      if (detail.base_head !== state.base_head) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption base is stale");
      }
      if (
        detail.runtime_id !== owner.runtime_id ||
        detail.runtime_revision !== owner.runtime_revision
      ) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption runtime evidence is inconsistent");
      }
      if (
        detail.cross_runtime !==
        (detail.executing_runtime_id !== detail.runtime_id ||
          detail.executing_runtime_revision !== detail.runtime_revision)
      ) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption runtime evidence is inconsistent");
      }
      if (
        options.crossRuntime !== "any" &&
        options.crossRuntime !== "historical-owner" &&
        options.crossRuntime !== detail.cross_runtime
      ) {
        fail(
          "ERROR_STALE_ADOPTION",
          "dirty scope adoption is not authorized for this runtime path",
        );
      }
      const executingOwner =
        detail.executing_runtime_id === owner.runtime_id &&
        detail.executing_runtime_revision === owner.runtime_revision;
      const executingCurrent =
        detail.executing_runtime_id === this.runtimeId &&
        detail.executing_runtime_revision === this.runtimeRevision;
      const historicalOwnerEvidence =
        options.crossRuntime === "historical-owner" && detail.cross_runtime && !executingCurrent;
      const expectedExecutingRuntime =
        historicalOwnerEvidence ||
        (options.crossRuntime === "any" && !detail.cross_runtime
          ? executingOwner
          : executingCurrent);
      if (!expectedExecutingRuntime) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption executing runtime is unavailable");
      }
      if (
        detail.current_states.length !== detail.adopted_paths.length ||
        detail.current_states.some(
          (item, index) =>
            !item ||
            typeof item !== "object" ||
            item.path !== detail.adopted_paths[index] ||
            !["added", "modified", "deleted", "unchanged", "absent"].includes(item.state) ||
            !["file", "symlink", "missing"].includes(item.kind),
        )
      ) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption state evidence is invalid");
      }
      if (
        detail.index_states.length !== detail.adopted_paths.length ||
        detail.index_states.some(
          (item, index) =>
            !item ||
            typeof item !== "object" ||
            item.path !== detail.adopted_paths[index] ||
            !["added", "modified", "deleted", "unchanged", "absent"].includes(item.state) ||
            !["file", "symlink", "missing"].includes(item.kind),
        )
      ) {
        fail("ERROR_STALE_ADOPTION", "dirty scope adoption index evidence is invalid");
      }
      result.push(detail);
    }
    return result;
  }

  #verifyPendingDirtyAdoptions(
    state: WorkflowState,
    currentReceipt: ChangeReceipt,
    options: { crossRuntime: boolean | "any" | "historical-owner" },
  ): void {
    if (currentReceipt.base_head !== state.base_head) {
      fail("ERROR_STALE_ADOPTION", "current HEAD changed after dirty scope adoption");
    }
    const pending = this.#pendingDirtyAdoptions(state, options);
    const receiptByPath = new Map(currentReceipt.paths.map((entry) => [entry.path, entry]));
    for (const adoption of pending) {
      const paths = adoption.adopted_paths.map((path) => receiptByPath.get(path));
      if (paths.some((entry) => !entry)) {
        fail("ERROR_STALE_ADOPTION", "adopted path is outside the current review scope");
      }
      const projected = paths as ChangeReceipt["paths"];
      const states = adoptionStates(currentReceipt, adoption.adopted_paths);
      const indexStates = stagedAdoptionStates(
        this.root,
        adoption.adopted_paths,
        currentReceipt.base_head,
      );
      if (canonicalJson(states) !== canonicalJson(adoption.current_states)) {
        fail("ERROR_STALE_ADOPTION", "adopted path state changed after authorization");
      }
      if (canonicalJson(indexStates) !== canonicalJson(adoption.index_states)) {
        fail("ERROR_STALE_ADOPTION", "adopted index state changed after authorization");
      }
      if (
        adoptionCommitment(state.base_head, projected, indexStates) !==
        adoption.current_state_commitment
      ) {
        fail("ERROR_STALE_ADOPTION", "adopted path content changed after authorization");
      }
    }
  }

  /** Read-only commitment preflight used by the narrow historical-runtime recovery path. */
  verifyPendingDirtyScope(workflowIdValue: unknown): void {
    this.#ensureOpen();
    const row = this.#row(workflowIdValue);
    const state = parseState(row);
    if (state.review_target.review_mode !== "working_tree") {
      fail("ERROR_STALE_ADOPTION", "dirty scope recovery requires a working-tree review");
    }
    const receipt = createReceipt(this.root, state.review_target.approved_paths, true);
    this.#verifyPendingDirtyAdoptions(state, receipt, { crossRuntime: true });
  }

  pendingDirtyScope(workflowIdValue: unknown): boolean {
    this.#ensureOpen();
    const row = this.#row(workflowIdValue);
    const state = parseState(row);
    return this.#pendingDirtyAdoptions(state, { crossRuntime: "any" }).some(
      (adoption) => adoption.cross_runtime,
    );
  }

  /** The only cross-runtime state mutation: finish a dirty adoption when the owner lacks the tool. */
  adoptDirtyScopeCrossRuntime(input: unknown): RoleView {
    const args = parentMutation(input);
    const expectedVersionNumber = expectedVersion(args.expected_version);
    let adoptedReceipt: ChangeReceipt | null = null;
    let adoptedIndexStates: DirtyScopeAdoptionIndexState[] | null = null;
    const result = this.db
      .transaction(() => {
        const row = this.#row(args.workflow_id);
        this.#assertRuntimeAttestation();
        if (row.version !== expectedVersionNumber)
          fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        const state = parseState(row);
        const owner = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
        if (
          owner.runtime_id === null ||
          owner.runtime_revision === null ||
          this.runtimeId === null ||
          this.runtimeRevision === null ||
          (owner.runtime_id === this.runtimeId && owner.runtime_revision === this.runtimeRevision)
        ) {
          fail("ERROR_RUNTIME_ISOLATION", "dirty adoption is not a cross-runtime recovery");
        }
        if (state.review_target.review_mode !== "working_tree") {
          fail(
            "ERROR_UNSUPPORTED_WORKFLOW_TYPE",
            "dirty scope adoption requires a working-tree review",
          );
        }
        if (this.#pendingDirtyAdoptions(state, { crossRuntime: true }).length > 0) {
          const current = createReceipt(this.root, state.review_target.approved_paths, true);
          this.#verifyPendingDirtyAdoptions(state, current, { crossRuntime: true });
        }
        const addedPaths = exactPaths(args.adopted_paths ?? args.added_paths, this.root);
        const pending = this.#pendingDirtyAdoptions(state, { crossRuntime: true });
        if (
          pending.some((adoption) =>
            adoption.adopted_paths.some((path) => addedPaths.includes(path)),
          )
        ) {
          fail("ERROR_INVALID_PATHS", "dirty scope adoption paths were already adopted");
        }
        const receipt = createReceipt(this.root, addedPaths, true);
        adoptedReceipt = receipt;
        adoptedIndexStates = stagedAdoptionStates(this.root, addedPaths, receipt.base_head);
        const next = adoptDirtyScope(
          state,
          args,
          receipt,
          this.root,
          adoptedIndexStates
            .filter((entry) => ["added", "modified", "deleted"].includes(entry.state))
            .map((entry) => entry.path),
        );
        assertApprovedPlanUnchanged(state, next);
        assertWorkItemsUnchanged(state, next);
        const expansion = next.scope_expansions.find((candidate) =>
          samePathList(candidate.added_paths, addedPaths),
        );
        if (!expansion || !adoptedReceipt || !adoptedIndexStates)
          fail("ERROR_STALE_ADOPTION", "dirty adoption evidence is missing");
        const dirtyScopeAdoption: DirtyScopeAdoptionAudit = {
          scope_expansion_id: expansion.expansion_id,
          scope_expansion_version: expansion.resulting_version,
          adopted_paths: expansion.added_paths,
          base_head: adoptedReceipt.base_head,
          current_states: adoptionStates(adoptedReceipt, expansion.added_paths),
          index_states: adoptedIndexStates,
          current_state_commitment: adoptionCommitment(
            adoptedReceipt.base_head,
            adoptedReceipt.paths,
            adoptedIndexStates,
          ),
          runtime_id: owner.runtime_id,
          runtime_revision: owner.runtime_revision as GitCommitSha,
          executing_runtime_id: this.runtimeId,
          executing_runtime_revision: this.runtimeRevision,
          cross_runtime: true,
          reason: args.reason as string,
          user_authorization: args.user_authorization as string,
        };
        return this.#persistExistingTransition({
          row,
          current: state,
          expectedVersion: expectedVersionNumber,
          next,
          eventType: "DIRTY_SCOPE_ADOPTED",
          actorRole: "parent",
          outcome: next.phase,
          details: { dirty_scope_adoption: dirtyScopeAdoption },
        });
      })
      .immediate();
    return roleViewForRole(result, "parent");
  }

  /** Establish the review-start receipt in the narrow historical-runtime recovery boundary. */
  beginReviewCrossRuntime(input: unknown): RoleView {
    const args = workerMutation(input);
    exactKeys(args, ["workflow_id", "expected_version"], "review begin");
    const expectedVersionNumber = expectedVersion(args.expected_version);
    const result = this.db
      .transaction(() => {
        const row = this.#row(args.workflow_id);
        this.#assertRuntimeAttestation();
        if (row.version !== expectedVersionNumber)
          fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        const state = parseState(row);
        const owner = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
        if (
          owner.runtime_id === null ||
          owner.runtime_revision === null ||
          this.runtimeId === null ||
          this.runtimeRevision === null ||
          (owner.runtime_id === this.runtimeId && owner.runtime_revision === this.runtimeRevision)
        ) {
          fail("ERROR_RUNTIME_ISOLATION", "review snapshot is not a cross-runtime recovery");
        }
        if (state.review_target.review_mode !== "working_tree") {
          fail("ERROR_INVALID_REVIEW", "commit-range reviews do not use review snapshots");
        }
        if (this.#pendingDirtyAdoptions(state, { crossRuntime: true }).length === 0) {
          fail("ERROR_STALE_ADOPTION", "no pending dirty scope adoption exists");
        }
        const startReceipt = createReceipt(this.root, state.review_target.approved_paths, true);
        this.#verifyPendingDirtyAdoptions(state, startReceipt, { crossRuntime: true });
        const next = beginReview(state, args, startReceipt);
        assertApprovedPlanUnchanged(state, next);
        assertWorkItemsUnchanged(state, next);
        assertScopeUnchanged(state, next);
        return this.#persistExistingTransition({
          row,
          current: state,
          expectedVersion: expectedVersionNumber,
          next,
          eventType: "REVIEW_STARTED",
          actorRole: "reviewer",
          outcome: null,
          details: {},
        });
      })
      .immediate();
    return roleViewForRole(result, "reviewer");
  }

  #mutate(
    workflowIdValue: unknown,
    actorRole: Role,
    expected: unknown,
    eventType: AuditEventType | ((next: WorkflowState) => AuditEventType),
    action: (state: WorkflowState) => WorkflowState,
    outcome: AuditOutcome | null | ((next: WorkflowState) => AuditOutcome | null) = null,
    details: (before: WorkflowState, next: WorkflowState) => MutationAuditDetails = () => ({}),
    ownership: "normal" | "reconciliation" = "normal",
  ): RoleView {
    this.#ensureOpen();
    const expectedVersionNumber = expectedVersion(expected);
    const next = this.db
      .transaction(() => {
        const row = this.#row(workflowIdValue);
        if (ownership === "reconciliation") this.#assertReconciliationRuntime(row);
        else this.#assertRuntimeOwnership(row);
        if (row.version !== expectedVersionNumber) {
          fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        }
        const current = parseState(row);
        const next = action(current);
        assertApprovedPlanUnchanged(current, next);
        assertWorkItemsUnchanged(current, next);
        const resolvedEventType = typeof eventType === "function" ? eventType(next) : eventType;
        assertFindingAdjudicationsAppendOnly(current, next, resolvedEventType);
        if (resolvedEventType === "SCOPE_EXPANDED") {
          if (
            next.scope_expansions.length !== current.scope_expansions.length + 1 ||
            canonicalJson(next.scope_expansions.slice(0, -1)) !==
              canonicalJson(current.scope_expansions) ||
            next.approved_paths.length <= current.approved_paths.length ||
            !current.approved_paths.every((path) => next.approved_paths.includes(path)) ||
            !next.approved_paths.every(
              (path) =>
                current.approved_paths.includes(path) ||
                next.scope_expansions.at(-1)?.added_paths.includes(path),
            ) ||
            (next.linked_continuation?.review_stage === "combined"
              ? canonicalJson(next.review_target.approved_paths) !==
                canonicalJson(next.linked_continuation.combined_review_paths)
              : canonicalJson(next.review_target.approved_paths) !==
                canonicalJson(next.approved_paths))
          ) {
            fail("ERROR_INVALID_TRANSITION", "scope expansion history is not append-only");
          }
        } else if (!isLinkedReviewStageTransition(current, next)) {
          assertScopeUnchanged(current, next);
        }
        const resolvedOutcome = typeof outcome === "function" ? outcome(next) : outcome;
        const resolvedDetails = details(current, {
          ...next,
          version: (expectedVersionNumber + 1) as WorkflowVersion,
        });
        return this.#persistExistingTransition({
          row,
          current,
          expectedVersion: expectedVersionNumber,
          next,
          eventType: resolvedEventType,
          actorRole,
          outcome: resolvedOutcome,
          details: resolvedDetails,
        });
      })
      .immediate();
    return roleViewForRole(next, actorRole);
  }

  submitImplementation(input: unknown): RoleView {
    const args = implementationMutation(input);
    const eventType =
      args.status === "DONE"
        ? "IMPLEMENTATION_SUBMITTED"
        : args.status === "INCOMPLETE"
          ? "IMPLEMENTATION_INCOMPLETE"
          : "IMPLEMENTATION_STOPPED";
    const outcome: AuditOutcome | null =
      args.status === "DONE"
        ? null
        : args.status === "INCOMPLETE"
          ? null
          : args.status === "DONE_WITH_CONCERNS"
            ? IMPLEMENTATION_STOP_PHASES.DONE_WITH_CONCERNS
            : args.status === "NEEDS_CONTEXT"
              ? IMPLEMENTATION_STOP_PHASES.NEEDS_CONTEXT
              : args.status === "BLOCKED"
                ? IMPLEMENTATION_STOP_PHASES.BLOCKED
                : null;
    return this.#mutate(
      args.workflow_id,
      "implementer",
      args.expected_version,
      eventType,
      (state) => {
        const currentReceipt = createReceipt(this.root, state.approved_paths, true);
        if (currentReceipt.base_head !== state.base_head) {
          fail("ERROR_STALE_RECEIPT", "implementation receipt base is stale");
        }
        return submitImplementation(state, args, this.root, currentReceipt);
      },
      args.status === "INCOMPLETE" ? (next) => next.phase : outcome,
    );
  }

  beginReview(input: unknown): RoleView {
    const args = workerMutation(input);
    return this.#mutate(
      args.workflow_id,
      "reviewer",
      args.expected_version,
      "REVIEW_STARTED",
      (state) => {
        if (pendingManualValidations(state).length > 0) {
          fail("ERROR_INVALID_REVIEW", "required manual validation evidence is pending");
        }
        if (state.review_target.review_mode !== "working_tree") {
          fail("ERROR_INVALID_REVIEW", "commit-range reviews do not use review snapshots");
        }
        const startReceipt = createReceipt(this.root, state.review_target.approved_paths, true);
        if (startReceipt.base_head !== state.base_head) {
          fail("ERROR_STALE_RECEIPT", "review snapshot base is stale; begin review again");
        }
        this.#verifyPendingDirtyAdoptions(state, startReceipt, { crossRuntime: false });
        return beginReview(state, args, startReceipt);
      },
    );
  }

  resumeImplementation(input: unknown): RoleView {
    const args = parentContextMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "IMPLEMENTATION_RESUMED",
      (state) => resumeImplementation(state, args),
    );
  }

  acceptConcerns(input: unknown): RoleView {
    const args = parentAuthorizationMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "CONCERNS_ACCEPTED",
      (state) => acceptConcerns(state, args),
    );
  }

  submitReview(input: unknown): RoleView {
    const args = reviewMutation(input);
    return this.#mutate(
      args.workflow_id,
      "reviewer",
      args.expected_version,
      "REVIEW_SUBMITTED",
      (state) => {
        if (pendingManualValidations(state).length > 0) {
          fail("ERROR_INVALID_REVIEW", "required manual validation evidence is pending");
        }
        if (
          state.review_target.base_revision !== state.base_head ||
          (state.linked_continuation?.review_stage === "combined"
            ? canonicalJson(state.review_target.approved_paths) !==
              canonicalJson(state.linked_continuation.combined_review_paths)
            : canonicalJson(state.review_target.approved_paths) !==
              canonicalJson(state.approved_paths))
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
            finalReceipt = createReceipt(this.root, state.review_target.approved_paths, true);
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
      reviewAuditOutcome(args.review_status),
    );
  }

  authorizeRepair(input: unknown): RoleView {
    const args = parentFindingIdsMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "REPAIR_AUTHORIZED",
      (state) => authorizeRepair(state, args, this.root),
    );
  }

  adjudicateFindings(input: unknown): RoleView {
    const args = parentMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "FINDINGS_ADJUDICATED",
      (state) => adjudicateFindings(state, args),
      (next) => next.phase,
      (_before, next) => ({
        finding_adjudications: next.finding_adjudications.filter(
          (item) => item.resulting_workflow_version === next.version,
        ),
      }),
    );
  }

  resumeReview(input: unknown): RoleView {
    const args = parentContextMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "REVIEW_RESUMED",
      (state) => {
        if (state.review_target.review_mode !== "working_tree") return resumeReview(state, args);
        const currentReceipt = createReceipt(this.root, state.review_target.approved_paths, true);
        this.#verifyPendingDirtyAdoptions(state, currentReceipt, {
          crossRuntime: "historical-owner",
        });
        return resumeReview(state, args);
      },
    );
  }

  finalizeRepairExhausted(input: unknown): RoleView {
    const args = parentMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "REPAIR_EXHAUSTED",
      (state) => finalizeRepairExhausted(state, args),
      "STOPPED_REPAIR_EXHAUSTED",
    );
  }

  authorizeCommit(input: unknown): RoleView {
    const args = parentAuthorizationMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "COMMIT_AUTHORIZED",
      (state) => {
        if (state.review_target.review_mode !== "working_tree") {
          fail("ERROR_COMMIT_NOT_ALLOWED", "commit authorization requires a working-tree review");
        }
        if (state.superseded_by_workflow_id) {
          fail("ERROR_COMMIT_NOT_ALLOWED", "superseded workflow cannot authorize a commit");
        }
        if (!allRequiredValidationsPassed(state)) {
          fail(
            "ERROR_COMMIT_NOT_ALLOWED",
            "all required validations must pass before commit authorization",
          );
        }
        if (!state.review_receipt) fail("ERROR_STALE_RECEIPT", "review receipt is missing");
        verifyReviewReceipt(
          this.root,
          state.review_receipt,
          state.review_target.approved_paths,
          state.base_head,
        );
        return authorizeCommit(state, args);
      },
    );
  }

  recordManualValidation(input: unknown): RoleView {
    const args = parentManualValidationMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "MANUAL_VALIDATION_RECORDED",
      (state) => recordManualValidation(state, args),
    );
  }

  prepareCommit(input: unknown): RoleView {
    const args = workerMutation(input);
    exactKeys(args, ["workflow_id", "expected_version"], "commit preparation");
    return this.#mutate(
      args.workflow_id,
      "committer",
      args.expected_version,
      (next) =>
        next.phase === "STOPPED_COMMIT_PREPARATION"
          ? "COMMIT_PREPARATION_FAILED"
          : "COMMIT_PREPARED",
      (state) => {
        try {
          const evidence: CommitPreparationEvidence = prepareCommitReceipt(this.root, state);
          return prepareCommit(state, args, evidence);
        } catch (error) {
          const failure = supportedPreparationFailure(error);
          if (!failure) throw error;
          return commitPreparationFailed(state, failure.category, failure.detail);
        }
      },
    );
  }

  retryCommitPreparation(input: unknown): RoleView {
    const args = parentRetryContextMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "COMMIT_PREPARATION_RETRY_AUTHORIZED",
      (state) => retryCommitPreparation(state, args),
      "retry",
    );
  }

  returnCommitToReview(input: unknown): RoleView {
    const args = parentReviewContextMutation(input);
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "COMMIT_PREPARATION_REVIEW_AUTHORIZED",
      (state) => {
        const next = returnCommitToReview(state, args);
        const head = currentHead(this.root);
        if (next.review_target.review_mode === "working_tree" && next.base_head !== head) {
          // Keep the original receipt boundary separate from authorization-time baselines for
          // paths appended by scope expansion. Re-baselining the full effective scope would
          // duplicate those paths and lose their provenance in scopeChangedPaths().
          const originalPaths = next.initial_receipt?.approved_paths ?? next.approved_paths;
          const initialReceipt = createReceipt(this.root, originalPaths, true);
          if (initialReceipt.base_head !== head) {
            fail("ERROR_STALE_BASE", "review recovery base is stale");
          }
          next.base_head = head;
          next.review_target = { ...next.review_target, base_revision: head };
          if (next.linked_continuation?.review_stage === "combined") {
            // A linked combined review has an invariant tying its inherited base to the
            // continuation provenance. Rebase both sides together after an external HEAD
            // change so recovery can begin a fresh combined review instead of leaving a
            // state that validation rejects.
            next.linked_continuation = {
              ...next.linked_continuation,
              original_base_head: head,
            };
          }
          next.initial_receipt = initialReceipt;
          next.dirty_baseline_paths = dirtyBaselinePaths(initialReceipt);
        }
        return next;
      },
    );
  }

  submitCommitResult(input: unknown): RoleView {
    const args = commitResultMutation(input);
    exactKeys(
      args,
      ["workflow_id", "expected_version", "attempt_id", "outcome", "failure_summary"],
      "commit result",
    );
    return this.#mutate(
      args.workflow_id,
      "committer",
      args.expected_version,
      "COMMIT_RESULT_SUBMITTED",
      (state) => {
        validateCommitResult(state, args);
        const verification = verifyCommitResult(this.root, state, args);
        if (verification.category) return commitMismatch(state, verification.category);
        return submitCommitResult(state, args, verification.commit_hash);
      },
      (next) => next.commit_result!.outcome,
    );
  }

  reconcileCommitResult(input: unknown): RoleView {
    const args = parentMutation(input);
    exactKeys(args, ["workflow_id", "expected_version", "attempt_id"], "commit reconciliation");
    const result = {
      workflow_id: args.workflow_id,
      expected_version: args.expected_version,
      attempt_id: args.attempt_id,
      outcome: "committed",
      failure_summary: null,
    };
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "COMMIT_RESULT_SUBMITTED",
      (state) => {
        validateCommitResult(state, result);
        const verification = verifyCommitResult(this.root, state, result);
        if (verification.category) return commitMismatch(state, verification.category);
        return submitCommitResult(state, result, verification.commit_hash);
      },
      (next) => next.commit_result!.outcome,
      undefined,
      "reconciliation",
    );
  }

  retryCommit(input: unknown): RoleView {
    const args = parentRetryContextMutation(input);
    exactKeys(args, ["workflow_id", "expected_version", "retry_context"], "commit retry");
    return this.#mutate(
      args.workflow_id,
      "parent",
      args.expected_version,
      "COMMIT_RETRY_AUTHORIZED",
      (state) => retryCommit(state, args),
      "retry",
    );
  }

  #createLinkedFollowupSuccessor(
    row: WorkflowRow,
    state: WorkflowState,
    expectedVersionNumber: number,
    followup: LinkedFollowupPlan,
  ): WorkflowState {
    const id = row.workflow_id as WorkflowId;
    const childId = randomUUID() as WorkflowId;
    const childState = linkedFollowupChildState(followup);
    const parentAffinity = runtimeAffinityPair(state.runtime_id, state.runtime_revision);
    childState.runtime_id = parentAffinity.runtime_id;
    childState.runtime_revision = parentAffinity.runtime_revision as GitCommitSha | null;
    childState.workflow_id = childId;
    const childReceipt = createReceipt(this.root, childState.approved_paths, true);
    if (childReceipt.base_head !== followup.base_head)
      fail("ERROR_STALE_BASE", "scope base is stale");
    childState.initial_receipt = childReceipt;
    childState.dirty_baseline_paths = dirtyBaselinePaths(childReceipt);
    validateWorkflowStateV9(childState);
    const now = isoNow();
    this.db
      .prepare(
        "INSERT INTO workflows (workflow_id, version, state_json, state_digest, created_at, updated_at) VALUES (?, 0, ?, ?, ?, ?)",
      )
      .run(childId, JSON.stringify(childState), objectDigest(childState), now, now);
    this.#audit(
      childId,
      0,
      "WORKFLOW_CREATED",
      "parent",
      auditEnvelope(null, childState, null, { linked_workflow_id: state.workflow_id }),
    );
    const next = {
      ...state,
      superseded_by_workflow_id: childId,
      version: (expectedVersionNumber + 1) as WorkflowVersion,
    };
    assertWorkItemsUnchanged(state, next);
    validateWorkflowStateV9(next);
    const update = this.db
      .prepare(
        "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
      )
      .run(next.version, JSON.stringify(next), objectDigest(next), now, id, expectedVersionNumber);
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
    return childState;
  }

  createLinkedFollowup(input: unknown): ParentView {
    this.#ensureOpen();
    const args = parentMutation(input);
    const expectedVersionNumber = expectedVersion(args.expected_version);
    const result = this.db
      .transaction(() => {
        const row = this.#row(args.workflow_id);
        this.#assertRuntimeOwnership(row);
        if (row.version !== expectedVersionNumber)
          fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        const state = parseState(row);
        const followup = linkedFollowupInput(state, args, this.root, currentHead(this.root));
        return this.#createLinkedFollowupSuccessor(row, state, expectedVersionNumber, followup);
      })
      .immediate();
    return roleView(result, "parent") as ParentView;
  }

  createLinkedFollowupFromPlan(input: unknown): ParentView {
    this.#ensureOpen();
    const args = parentMutation(input);
    exactKeys(
      args,
      [
        "workflow_id",
        "expected_version",
        "plan_id",
        "revision",
        "finding_ids",
        "user_authorization",
      ],
      "plan linked follow-up",
    );
    const expectedVersionNumber = expectedVersion(args.expected_version);
    const result = this.db
      .transaction(() => {
        const row = this.#row(args.workflow_id);
        this.#assertRuntimeOwnership(row);
        if (row.version !== expectedVersionNumber)
          fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
        const state = parseState(row);
        // Resolve and approve the child plan inside the same immediate transaction as the
        // source supersession and child insertion. The caller supplies identity only.
        const resolved = this.planStore.resolveApprovedPlan(args.plan_id, args.revision);
        const followup = linkedFollowupInputFromPlan(
          state,
          args,
          resolved.artifact,
          resolved.provenance,
          currentHead(this.root),
        );
        return this.#createLinkedFollowupSuccessor(row, state, expectedVersionNumber, followup);
      })
      .immediate();
    return roleView(result, "parent") as ParentView;
  }
}

export function openStore(options: WorkflowStoreOptions = {}): WorkflowStore {
  return new WorkflowStore(options);
}

export { exactPaths };
