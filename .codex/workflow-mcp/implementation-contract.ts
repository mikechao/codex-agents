import type {
  AuthoritativeImplementationContract,
  PersistedImplementationAuthority,
  PlanProvenance,
  PlanRevisionArtifact,
  WorkflowState,
} from "./types.js";

/** Map one exact approved PlanArtifact and provenance value to workflow implementation authority. */
export function authoritativeImplementationContract(
  artifact: PlanRevisionArtifact,
  provenance: PlanProvenance,
): AuthoritativeImplementationContract {
  return {
    workflow_type: artifact.workflow_type,
    objective: artifact.objective,
    approved_plan: artifact.full_plan,
    execution_brief: artifact.execution_brief,
    plan_provenance: provenance,
    artifact_approved_paths: artifact.approved_paths,
    acceptance_criteria: artifact.acceptance_criteria,
    validation_requirements: artifact.validation_requirements,
  };
}

/** Project the immutable non-scope contract fields from workflow state for transition guards. */
export function authoritativeImplementationAuthorityFromState(
  state: WorkflowState,
): PersistedImplementationAuthority {
  return {
    workflow_type: state.workflow_type,
    objective: state.objective,
    approved_plan: state.approved_plan,
    execution_brief: state.execution_brief,
    plan_provenance: state.plan_provenance,
    acceptance_criteria: state.acceptance_criteria,
    validation_requirements: state.validation_requirements,
  };
}
