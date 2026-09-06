import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import type {
  ContentDigest,
  PlanApproval,
  PlanId,
  PlannerPlanRead,
  PlanProvenance,
  PlanRead,
  PlanRevision,
  PlanRevisionArtifact,
} from "./types.js";
import {
  canonicalJson,
  isoNow,
  objectDigest,
  planApproval,
  planArtifact,
  planId,
  planRevision,
  planRevisionInput,
  planRevisionInputFromArtifact,
  planRevisionReplacements,
  userAuthorization,
} from "./validation.js";

interface PlanRow {
  plan_id: string;
  current_revision: number;
  created_at: string;
  updated_at: string;
}

interface PlanRevisionRow {
  plan_id: string;
  revision: number;
  artifact_json: string;
  artifact_digest: string;
  created_at: string;
}

interface PlanApprovalRow {
  plan_id: string;
  revision: number;
  artifact_digest: string;
  user_authorization: string;
  approved_at: string;
}

type PlanRevisionContent = Pick<
  PlanRevisionArtifact,
  | "full_plan"
  | "execution_brief"
  | "objective"
  | "approved_paths"
  | "acceptance_criteria"
  | "validation_requirements"
>;

interface ResolvedPlan {
  plan: PlanRow;
  revision: PlanRevisionRow;
  artifact: PlanRevisionArtifact;
  approval: PlanApproval | null;
}

export interface ApprovedPlan {
  artifact: PlanRevisionArtifact;
  artifact_digest: ContentDigest;
  approval: PlanApproval;
  provenance: PlanProvenance;
}

function planRevisionContent(value: PlanRevisionContent): PlanRevisionContent {
  return {
    full_plan: value.full_plan,
    execution_brief: value.execution_brief,
    objective: value.objective,
    approved_paths: value.approved_paths,
    acceptance_criteria: value.acceptance_criteria,
    validation_requirements: value.validation_requirements,
  };
}

function persistedTimestamp(value: unknown, name: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail("ERROR_STATE_CORRUPT", `${name} is invalid`);
  }
}

function parsePlanRow(row: PlanRow): PlanRow {
  try {
    planId(row.plan_id);
    planRevision(row.current_revision, "current_revision");
    persistedTimestamp(row.created_at, "plan created_at");
    persistedTimestamp(row.updated_at, "plan updated_at");
  } catch {
    fail("ERROR_STATE_CORRUPT", "plan aggregate is invalid");
  }
  return row;
}

function parsePlanRevisionRow(row: PlanRevisionRow, root: string): PlanRevisionArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.artifact_json);
  } catch {
    fail("ERROR_STATE_CORRUPT", "plan revision JSON is invalid");
  }
  const artifact = planArtifact(parsed, root);
  if (artifact.plan_id !== row.plan_id || artifact.revision !== row.revision) {
    fail("ERROR_STATE_CORRUPT", "plan revision identity is inconsistent");
  }
  if (row.artifact_digest !== objectDigest(artifact)) {
    fail("ERROR_STATE_CORRUPT", "plan revision digest is corrupted");
  }
  persistedTimestamp(row.created_at, "plan revision created_at");
  if (artifact.created_at !== row.created_at) {
    fail("ERROR_STATE_CORRUPT", "plan revision timestamp is inconsistent");
  }
  return artifact;
}

function parsePlanApprovalRow(row: PlanApprovalRow): PlanApproval {
  try {
    return planApproval({
      plan_id: row.plan_id,
      revision: row.revision,
      artifact_digest: row.artifact_digest,
      user_authorization: row.user_authorization,
      approved_at: row.approved_at,
    });
  } catch {
    fail("ERROR_STATE_CORRUPT", "plan approval is invalid");
  }
}

/** Validate only the plan aggregate during WorkflowStore startup. */
export function validatePersistedPlanRows(db: Database, root: string): void {
  const plans = db.prepare("SELECT * FROM plans").all() as PlanRow[];
  const planIds = new Set<string>();
  for (const plan of plans) {
    parsePlanRow(plan);
    if (
      planIds.has(plan.plan_id) ||
      !Number.isSafeInteger(plan.current_revision) ||
      plan.current_revision < 1
    )
      fail("ERROR_STATE_CORRUPT", "plan aggregate is invalid");
    planIds.add(plan.plan_id);
    const revisions = db
      .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? ORDER BY revision")
      .all(plan.plan_id) as PlanRevisionRow[];
    if (
      revisions.length === 0 ||
      revisions[0].revision !== 1 ||
      revisions.at(-1)?.revision !== plan.current_revision
    )
      fail("ERROR_STATE_CORRUPT", "plan revisions are not contiguous");
    revisions.forEach((row, index) => {
      if (row.revision !== index + 1)
        fail("ERROR_STATE_CORRUPT", "plan revisions are not contiguous");
      parsePlanRevisionRow(row, root);
    });
    const approvals = db
      .prepare("SELECT * FROM plan_approvals WHERE plan_id = ?")
      .all(plan.plan_id) as PlanApprovalRow[];
    for (const approvalRow of approvals) {
      const approval = parsePlanApprovalRow(approvalRow);
      const revisionRow = revisions.find((revision) => revision.revision === approval.revision);
      if (!revisionRow || approval.artifact_digest !== revisionRow.artifact_digest)
        fail("ERROR_STATE_CORRUPT", "plan approval relationship is invalid");
    }
  }
  const orphan = db
    .prepare(
      "SELECT plan_id FROM plan_revisions WHERE plan_id NOT IN (SELECT plan_id FROM plans) LIMIT 1",
    )
    .get();
  if (orphan) fail("ERROR_STATE_CORRUPT", "plan revision aggregate is missing");
  const orphanApproval = db
    .prepare(
      "SELECT plan_id FROM plan_approvals WHERE plan_id NOT IN (SELECT plan_id FROM plans) OR (plan_id, revision) NOT IN (SELECT plan_id, revision FROM plan_revisions) LIMIT 1",
    )
    .get();
  if (orphanApproval) fail("ERROR_STATE_CORRUPT", "plan approval relationship is missing");
}

export class PlanStore {
  readonly #db: Database;
  readonly #root: string;

  constructor(db: Database, root: string) {
    this.#db = db;
    this.#root = root;
  }

  #planRevision(planValue: unknown, revisionValue: unknown): ResolvedPlan {
    const id = planId(planValue);
    const revision = planRevision(revisionValue);
    const planRow = this.#db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(id) as
      | PlanRow
      | undefined;
    if (!planRow) fail("ERROR_PLAN_NOT_FOUND", "plan is not found");
    const plan = parsePlanRow(planRow);
    const row = this.#db
      .prepare("SELECT * FROM plan_revisions WHERE plan_id = ? AND revision = ?")
      .get(id, revision) as PlanRevisionRow | undefined;
    if (!row) fail("ERROR_PLAN_NOT_FOUND", "plan revision is not found");
    const artifact = parsePlanRevisionRow(row, this.#root);
    const approvalRow = this.#db
      .prepare("SELECT * FROM plan_approvals WHERE plan_id = ? AND revision = ?")
      .get(id, revision) as PlanApprovalRow | undefined;
    const approval = approvalRow ? parsePlanApprovalRow(approvalRow) : null;
    if (approval && approval.artifact_digest !== row.artifact_digest)
      fail("ERROR_STATE_CORRUPT", "plan approval digest is corrupted");
    return { plan, revision: row, artifact, approval };
  }

  #approvedPlan(planValue: unknown, revisionValue: unknown): ApprovedPlan {
    const resolved = this.#planRevision(planValue, revisionValue);
    if (resolved.plan.current_revision !== resolved.revision.revision)
      fail("ERROR_PLAN_STALE", "plan revision is stale");
    if (
      !resolved.approval ||
      resolved.approval.artifact_digest !== resolved.revision.artifact_digest
    )
      fail("ERROR_PLAN_UNAPPROVED", "plan revision is not approved");
    const artifactDigest = resolved.revision.artifact_digest as ContentDigest;
    return {
      artifact: resolved.artifact,
      artifact_digest: artifactDigest,
      approval: resolved.approval,
      provenance: {
        plan_id: resolved.artifact.plan_id,
        revision: resolved.artifact.revision,
        artifact_digest: artifactDigest,
        approved_at: resolved.approval.approved_at,
      },
    };
  }

  #plannerPlanRead(planValue: unknown, revisionValue: unknown): PlannerPlanRead {
    const resolved = this.#planRevision(planValue, revisionValue);
    const current = resolved.plan.current_revision === resolved.revision.revision;
    return {
      ...planRevisionInputFromArtifact(resolved.artifact),
      plan_id: resolved.artifact.plan_id,
      revision: resolved.artifact.revision,
      artifact_digest: resolved.revision.artifact_digest as PlannerPlanRead["artifact_digest"],
      created_at: resolved.artifact.created_at,
      metadata: {
        current_revision: resolved.plan.current_revision as PlanRevision,
        status: resolved.approval ? "approved" : "draft",
        is_current: current,
      },
    };
  }

  #parentPlanRead(planValue: unknown, revisionValue: unknown): PlanRead {
    const resolved = this.#planRevision(planValue, revisionValue);
    const current = resolved.plan.current_revision === resolved.revision.revision;
    return {
      ...resolved.artifact,
      artifact_digest: resolved.revision.artifact_digest as PlanRead["artifact_digest"],
      metadata: {
        current_revision: resolved.plan.current_revision as PlanRevision,
        status: resolved.approval ? "approved" : "draft",
        is_current: current,
        approval: resolved.approval,
      },
    };
  }

  planCreate(input: unknown): PlannerPlanRead {
    const normalized = planRevisionInput(input, this.#root);
    const id = randomUUID() as PlanId;
    const revision = 1 as PlanRevision;
    const artifact: PlanRevisionArtifact = {
      ...normalized,
      plan_id: id,
      revision,
      created_at: isoNow(),
    };
    const digest = objectDigest(artifact);
    const now = isoNow();
    this.#db
      .transaction(() => {
        this.#db
          .prepare(
            "INSERT INTO plans (plan_id, current_revision, created_at, updated_at) VALUES (?, ?, ?, ?)",
          )
          .run(id, revision, now, now);
        this.#db
          .prepare(
            "INSERT INTO plan_revisions (plan_id, revision, artifact_json, artifact_digest, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, revision, JSON.stringify(artifact), digest, artifact.created_at);
      })
      .immediate();
    return this.#plannerPlanRead(id, revision);
  }

  planGet(planValue: unknown, revisionValue: unknown): PlannerPlanRead {
    return this.#plannerPlanRead(planValue, revisionValue);
  }

  planParentGet(planValue: unknown, revisionValue: unknown): PlanRead {
    return this.#parentPlanRead(planValue, revisionValue);
  }

  planRevise(planValue: unknown, baseValue: unknown, replacementsValue: unknown): PlannerPlanRead {
    const base = planRevision(baseValue, "base_revision");
    const id = planId(planValue);
    const replacements = planRevisionReplacements(replacementsValue);
    return this.#db
      .transaction(() => {
        const plan = this.#db.prepare("SELECT * FROM plans WHERE plan_id = ?").get(id) as
          | PlanRow
          | undefined;
        if (!plan) fail("ERROR_PLAN_NOT_FOUND", "plan is not found");
        if (plan.current_revision !== base)
          fail("ERROR_VERSION_CONFLICT", "plan revision is stale");
        const current = this.#planRevision(id, base);
        const normalized = planRevisionInput(
          { ...planRevisionInputFromArtifact(current.artifact), ...replacements },
          this.#root,
        );
        if (
          canonicalJson(planRevisionContent(current.artifact)) ===
          canonicalJson(planRevisionContent(normalized))
        ) {
          return this.#plannerPlanRead(id, base);
        }
        const nextRevision = (base + 1) as PlanRevision;
        const artifact: PlanRevisionArtifact = {
          ...normalized,
          plan_id: id,
          revision: nextRevision,
          created_at: isoNow(),
        };
        const digest = objectDigest(artifact);
        this.#db
          .prepare(
            "INSERT INTO plan_revisions (plan_id, revision, artifact_json, artifact_digest, created_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, nextRevision, JSON.stringify(artifact), digest, artifact.created_at);
        const update = this.#db
          .prepare(
            "UPDATE plans SET current_revision = ?, updated_at = ? WHERE plan_id = ? AND current_revision = ?",
          )
          .run(nextRevision, isoNow(), id, base);
        if (update.changes !== 1) fail("ERROR_VERSION_CONFLICT", "plan revision is stale");
        return this.#plannerPlanRead(id, nextRevision);
      })
      .immediate();
  }

  planApprove(planValue: unknown, revisionValue: unknown, authorizationValue: unknown): PlanRead {
    const id = planId(planValue);
    const requested = planRevision(revisionValue);
    return this.#db
      .transaction(() => {
        const resolved = this.#planRevision(id, requested);
        if (resolved.plan.current_revision !== requested)
          fail("ERROR_PLAN_STALE", "only the current plan revision may be approved");
        if (resolved.approval)
          fail("ERROR_PLAN_APPROVAL_EXISTS", "plan revision is already approved");
        const approvedAt = isoNow();
        // userAuthorization is intentionally validated by the parent-only operation, not by planner writes.
        const normalizedAuth = userAuthorization(authorizationValue);
        this.#db
          .prepare(
            "INSERT INTO plan_approvals (plan_id, revision, artifact_digest, user_authorization, approved_at) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, requested, resolved.revision.artifact_digest, normalizedAuth, approvedAt);
        return this.#parentPlanRead(id, requested);
      })
      .immediate();
  }

  /** Resolve an approved artifact without opening or nesting a transaction. */
  resolveApprovedPlan(planValue: unknown, revisionValue: unknown): ApprovedPlan {
    return this.#approvedPlan(planValue, revisionValue);
  }
}
