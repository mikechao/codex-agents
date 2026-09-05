import { tool, type ToolResult } from "@opencode-ai/plugin";
import {
  runStructuredReviewerEvidence,
  type ValidationEvidence,
} from "../../.codex/agents/reviewer-validation.js";

const MAX_EVIDENCE_ID_LENGTH = 200;
const MAX_ARGUMENT_LENGTH = 4096;

function rejectedEvidence(evidenceId: string, argv: string[], output: string): ValidationEvidence {
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

function result(evidence: ValidationEvidence): ToolResult {
  return {
    title: `Evidence ${evidence.validation_id}`,
    output: JSON.stringify(evidence),
    metadata: {
      evidenceId: evidence.validation_id,
      status: evidence.status,
      executedArgv: evidence.executed_argv,
      workingTreeChanged: evidence.working_tree_changed,
    },
  };
}

export default tool({
  description:
    "Run one exact repository-policy-authorized executable evidence argv without a shell. Explorer-only; failures are bounded evidence.",
  args: {
    evidenceId: tool.schema.string().min(1).max(MAX_EVIDENCE_ID_LENGTH),
    argv: tool.schema
      .array(tool.schema.string().min(1).max(MAX_ARGUMENT_LENGTH))
      .min(1)
      .max(50),
  },
  async execute(args, context) {
    if (context.agent !== "explorer") {
      return result(rejectedEvidence(args.evidenceId, args.argv, "runEvidence is restricted to explorer"));
    }
    return result(
      runStructuredReviewerEvidence(
        { evidenceId: args.evidenceId, argv: args.argv },
        context.worktree,
      ),
    );
  },
});
