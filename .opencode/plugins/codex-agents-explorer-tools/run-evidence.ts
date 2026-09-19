import {
  runStructuredReviewerEvidence,
  type ValidationEvidence,
} from "../../../.codex/agents/reviewer-validation.js";

export const MAX_EVIDENCE_ID_LENGTH = 200;
export const MAX_ARGUMENT_LENGTH = 4096;

export function rejectedEvidence(
  evidenceId: string,
  argv: string[],
  output: string,
): ValidationEvidence {
  return {
    validation_id: evidenceId.slice(0, MAX_EVIDENCE_ID_LENGTH),
    requested_argv: argv.slice(0, 50).map((argument) => argument.slice(0, MAX_ARGUMENT_LENGTH)),
    executed_argv: [],
    status: "failed",
    exit_code: null,
    timed_out: false,
    output: output.slice(0, 512),
    working_tree_changed: false,
  };
}

export function runEvidence(
  evidenceId: string,
  argv: string[],
  worktree: string,
): ValidationEvidence {
  return runStructuredReviewerEvidence({ evidenceId, argv }, worktree);
}
