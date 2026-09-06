import type { WorkflowId, WorkflowState } from "./types.js";

export const MAX_LINEAGE_RECORDS = 32;

export function lineageReferences(state: WorkflowState): WorkflowId[] {
  const continuation = state.linked_continuation;
  return [
    ...new Set(
      [
        state.parent_workflow_id,
        state.source_workflow_id,
        state.superseded_by_workflow_id,
        continuation?.root_workflow_id ?? null,
        continuation?.predecessor_workflow_id ?? null,
        ...(continuation?.lineage_workflow_ids ?? []),
      ].filter((value): value is WorkflowId => value != null),
    ),
  ];
}
