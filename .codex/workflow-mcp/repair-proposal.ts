import { fail } from "./errors.js";
import { effectiveBlockingFindings } from "./transitions/queries.js";
import type {
  BlockingFinding,
  FindingId,
  OperatorRepairProposal,
  RepairDirective,
  WorkflowState,
} from "./types.js";
import { canonicalJson, findingIdList } from "./validation.js";

const MAX_SUMMARY = 240;

export interface RepairProposalSelection {
  eligible_finding_ids: FindingId[];
  selected_finding_ids: FindingId[];
  selected_findings: BlockingFinding[];
}

/** The single validated repair selection and bounded proposal for one projection. */
export interface RepairProposalBinding extends RepairProposalSelection {
  readonly proposal: OperatorRepairProposal;
}

function bounded(value: string, limit = MAX_SUMMARY): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

/** Resolve the exact eligible and selected blocker sets in authoritative finding order. */
export function repairProposalSelection(
  state: WorkflowState,
  selectedFindingIds?: ReadonlyArray<FindingId>,
): RepairProposalSelection {
  const eligibleFindings = effectiveBlockingFindings(state);
  const eligibleFindingIds = eligibleFindings.map((finding) => finding.finding_id);
  const selectedIds = selectedFindingIds
    ? findingIdList(selectedFindingIds, "selected repair finding_ids", "ERROR_INVALID_REPAIR")
    : eligibleFindingIds;
  const eligible = new Set(eligibleFindingIds);
  if (selectedIds.some((findingId) => !eligible.has(findingId))) {
    fail("ERROR_INVALID_REPAIR", "selected repair finding ID is not an eligible blocker");
  }
  const selected = eligibleFindings.filter((finding) => selectedIds.includes(finding.finding_id));
  if (selected.length !== selectedIds.length) {
    fail("ERROR_INVALID_REPAIR", "selected repair finding IDs are invalid");
  }
  return {
    eligible_finding_ids: eligibleFindingIds,
    selected_finding_ids: selected.map((finding) => finding.finding_id),
    selected_findings: selected,
  };
}

/** Build the bounded proposal that both the operator and mutation boundary must use. */
export function repairProposalForFindings(
  selectedFindings: ReadonlyArray<BlockingFinding>,
): OperatorRepairProposal {
  if (selectedFindings.length === 0) {
    fail("ERROR_INVALID_REPAIR", "repair proposal requires selected blockers");
  }
  const noun = selectedFindings.length === 1 ? "finding" : "findings";
  return {
    required_outcome: `Resolve the selected blocking ${noun} without changing the approved intent.`,
    strategy_constraints: bounded(
      selectedFindings.map((finding) => finding.remediation).join("; "),
      MAX_SUMMARY,
    ),
    fallbacks: [
      {
        strategy: "Stop and request bounded context",
        condition: "the requested repair strategy is infeasible without changing approved intent",
      },
    ],
    required_paths: [],
    forbidden_paths: [],
  };
}

/** Derive the immutable internal repair input shared by semantic and executable projections. */
export function repairProposalBinding(
  state: WorkflowState,
  selectedFindingIds?: ReadonlyArray<FindingId>,
): RepairProposalBinding {
  const selection = repairProposalSelection(state, selectedFindingIds);
  return {
    ...selection,
    proposal: repairProposalForFindings(selection.selected_findings),
  };
}

/** Compare only server-derived directive fields; user authorization remains caller-provided. */
export function repairDirectiveMatchesProposal(
  directive: RepairDirective,
  proposal: OperatorRepairProposal,
): boolean {
  return (
    canonicalJson({
      required_outcome: directive.required_outcome,
      strategy_constraints: directive.strategy_constraints,
      fallbacks: directive.fallbacks,
      required_paths: directive.required_paths,
      forbidden_paths: directive.forbidden_paths,
    }) === canonicalJson(proposal)
  );
}
