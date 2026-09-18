import { fail } from "../errors.js";
import type {
  ChangeReceipt,
  ImplementationStatus,
  ManualValidationRepairDecisionAudit,
  RecoveryContext,
  ValidationResult,
  WorkflowEvidenceState,
  WorkflowPhase,
  WorkflowState,
} from "../types.js";
import { boundedString, isoNow } from "../validation.js";
import { compareDependencyReceipt, dependencyReceiptIdentityDigest } from "./receipts.js";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function ensurePhase<const P extends WorkflowPhase>(
  state: WorkflowState,
  ...allowed: readonly P[]
): asserts state is WorkflowState & { phase: P } {
  if (!(allowed as readonly WorkflowPhase[]).includes(state.phase))
    fail("ERROR_INVALID_TRANSITION", `phase ${state.phase}`);
}

export function applyRecovery(
  state: WorkflowState,
  phase: WorkflowPhase,
  kind: RecoveryContext["kind"],
  context: unknown,
  contextLabel: string,
): void {
  state.phase = phase;
  state.stop_context = null;
  state.recovery_context = {
    kind,
    context: boundedString(context, contextLabel, 2000),
    recovered_at: isoNow(),
  };
}

export function invalidateImplementationSubmissionEvidence(
  state: WorkflowEvidenceState<"implementation_submission">,
): void {
  Object.assign(state, {
    implementation_summary: null,
    implementation_status: null,
    implementation_known_failures: [],
    agent_touched_paths: [],
    scope_changed_paths: [],
    acceptance_results: [],
    validation_results: [],
    finding_resolution_map: {},
    implementation_receipt: null,
  } satisfies WorkflowEvidenceState<"implementation_submission">);
}

const STALE_INTERSECTION_EVIDENCE =
  "manual validation evidence is stale after repair changed an authorized dependency";
const STALE_UNPROVABLE_EVIDENCE =
  "manual validation evidence is stale because repair impact could not be proven disjoint";

/** Repair-only reconciliation. Generic authority invalidators remain conservatively unchanged. */
export function reconcileRepairManualValidationEvidence(
  state: WorkflowState,
  submitted: ValidationResult[],
  freshReceipt: ChangeReceipt,
  status: ImplementationStatus,
): ValidationResult[] {
  const priorById = new Map(
    state.validation_results.map((result) => [result.validation_id, result]),
  );
  if (status === "INCOMPLETE") {
    return submitted.map((result) => {
      const requirement = state.validation_requirements.find(
        (candidate) => candidate.validation_id === result.validation_id,
      );
      const prior = priorById.get(result.validation_id);
      return requirement?.kind === "inspection" &&
        prior &&
        (prior.status !== "not_run" || prior.manual_lifecycle !== undefined)
        ? clone(prior)
        : result;
    });
  }
  if (status !== "DONE" && status !== "DONE_WITH_CONCERNS") return submitted;

  return submitted.map((result) => {
    const requirement = state.validation_requirements.find(
      (candidate) => candidate.validation_id === result.validation_id,
    );
    const prior = priorById.get(result.validation_id);
    if (requirement?.kind !== "inspection" || !prior || prior.status === "not_run") return result;
    const lifecycle = prior.manual_lifecycle;
    const dependencies = requirement.dependencies;
    if (
      lifecycle?.state === "observed" &&
      dependencies?.kind === "repository_paths" &&
      lifecycle.dependency_receipt !== null
    ) {
      const comparison = compareDependencyReceipt(
        lifecycle.dependency_receipt,
        freshReceipt,
        dependencies.paths,
      );
      if (comparison.status === "proven" && comparison.changed_paths.length === 0) {
        return {
          ...clone(prior),
          manual_lifecycle: {
            ...clone(lifecycle),
            retained_at: [
              ...clone(lifecycle.retained_at),
              {
                repair_cycle: state.repair_cycle,
                workflow_version: (state.version + 1) as WorkflowState["version"],
              },
            ],
          },
        };
      }
      if (comparison.status === "proven") {
        return {
          validation_id: result.validation_id,
          status: "not_run",
          evidence: STALE_INTERSECTION_EVIDENCE,
          manual_lifecycle: {
            state: "stale",
            observed_at_version: lifecycle.observed_at_version,
            observed_repair_cycle: lifecycle.observed_repair_cycle,
            stale_at_version: (state.version + 1) as WorkflowState["version"],
            stale_at_repair_cycle: state.repair_cycle,
            reason: "dependency_intersection",
            affected_paths: comparison.changed_paths,
          },
        };
      }
    }
    return {
      validation_id: result.validation_id,
      status: "not_run",
      evidence: STALE_UNPROVABLE_EVIDENCE,
      manual_lifecycle: {
        state: "stale",
        observed_at_version: lifecycle?.state === "observed" ? lifecycle.observed_at_version : null,
        observed_repair_cycle:
          lifecycle?.state === "observed" ? lifecycle.observed_repair_cycle : null,
        stale_at_version: (state.version + 1) as WorkflowState["version"],
        stale_at_repair_cycle: state.repair_cycle,
        reason: "dependency_unprovable",
        affected_paths: [],
      },
    };
  });
}

export function manualValidationRepairDecisionAudit(
  before: WorkflowState,
  after: WorkflowState,
): ManualValidationRepairDecisionAudit | undefined {
  if (
    before.phase !== "REPAIRING" ||
    (after.implementation_status !== "DONE" && after.implementation_status !== "DONE_WITH_CONCERNS")
  )
    return undefined;
  const retained: ManualValidationRepairDecisionAudit["retained"] = [];
  const stale: ManualValidationRepairDecisionAudit["stale"] = [];
  const priorById = new Map(
    before.validation_results.map((result) => [result.validation_id, result]),
  );
  for (const result of after.validation_results) {
    const lifecycle = result.manual_lifecycle;
    const requirement = after.validation_requirements.find(
      (candidate) => candidate.validation_id === result.validation_id,
    );
    const dependencyPaths =
      requirement?.kind === "inspection" ? requirement.dependencies?.paths : undefined;
    const priorLifecycle = priorById.get(result.validation_id)?.manual_lifecycle;
    const baselineDigest = dependencyReceiptIdentityDigest(
      priorLifecycle?.state === "observed" ? priorLifecycle.dependency_receipt : null,
      dependencyPaths ?? [],
    );
    const repairedDigest = dependencyReceiptIdentityDigest(
      after.implementation_receipt,
      dependencyPaths ?? [],
    );
    if (
      lifecycle?.state === "observed" &&
      lifecycle.retained_at.at(-1)?.workflow_version === after.version
    ) {
      if (!dependencyPaths || baselineDigest === null || repairedDigest === null) {
        fail("ERROR_STATE_CORRUPT", "retained validation audit evidence is incomplete");
      }
      retained.push({
        validation_id: result.validation_id,
        observed_at_version: lifecycle.observed_at_version,
        dependency_paths: clone(dependencyPaths),
        baseline_dependency_digest: baselineDigest,
        repaired_dependency_digest: repairedDigest,
      });
    } else if (lifecycle?.state === "stale" && lifecycle.stale_at_version === after.version) {
      stale.push({
        validation_id: result.validation_id,
        observed_at_version: lifecycle.observed_at_version,
        reason: lifecycle.reason,
        affected_paths: clone(lifecycle.affected_paths),
        baseline_dependency_digest: baselineDigest,
        repaired_dependency_digest: dependencyPaths ? repairedDigest : null,
      });
    }
  }
  return { repair_cycle: after.repair_cycle, submission_version: after.version, retained, stale };
}

export function invalidateReviewReceipts(state: WorkflowEvidenceState<"review_receipts">): void {
  Object.assign(state, {
    review_start_receipt: null,
    review_receipt: null,
  } satisfies WorkflowEvidenceState<"review_receipts">);
}

export function invalidateRepairAuthorization(
  state: WorkflowEvidenceState<"repair_authority">,
): void {
  Object.assign(state, {
    repair_authorized_ids: [],
    repair_directive: null,
  } satisfies WorkflowEvidenceState<"repair_authority">);
}

function invalidateCurrentReviewResult(
  state: WorkflowEvidenceState<"current_review_result">,
): void {
  Object.assign(state, {
    blocking_findings: [],
    optional_findings: [],
    prior_finding_classifications: {},
    review_result_version: null,
  } satisfies WorkflowEvidenceState<"current_review_result">);
}

export function invalidateCurrentReviewResultAndRepairAuthority(
  state: WorkflowEvidenceState<"current_review_result"> & WorkflowEvidenceState<"repair_authority">,
): void {
  invalidateCurrentReviewResult(state);
  invalidateRepairAuthorization(state);
}

export function invalidateFullCommitAuthorityAndEvidence(
  state: WorkflowEvidenceState<"commit_authorization"> &
    WorkflowEvidenceState<"commit_attempt_evidence">,
): void {
  Object.assign(state, {
    commit_authorization: null,
  } satisfies WorkflowEvidenceState<"commit_authorization">);
  Object.assign(state, {
    commit_preparation: null,
    commit_result: null,
  } satisfies WorkflowEvidenceState<"commit_attempt_evidence">);
}

export function invalidateLinkedReviewProgress(
  state: WorkflowEvidenceState<"linked_continuation">,
): void {
  if (!state.linked_continuation) return;
  state.linked_continuation.remediation_review_receipt = null;
  state.linked_continuation.review_stage = "remediation";
}
