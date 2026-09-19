import { Plugin } from "@opencode/plugin";
import type { Tool } from "@opencode/schema/tool";
import {
  failedInspection,
  type GitRangeInspection,
  type GitRangeRequest,
  inspectGitRange,
} from "./inspect-git-range.js";
import {
  MAX_ARGUMENT_LENGTH,
  MAX_EVIDENCE_ID_LENGTH,
  rejectedEvidence,
  runEvidence,
} from "./run-evidence.js";
import { resolveSessionWorktree } from "./worktree.js";

const MAX_REVISION_LENGTH = 200;

const inspectGitRangeInput = {
  type: "object",
  properties: {
    base: { type: "string", minLength: 1, maxLength: MAX_REVISION_LENGTH },
    head: { type: "string", minLength: 1, maxLength: MAX_REVISION_LENGTH },
  },
  required: ["base", "head"],
  additionalProperties: false,
} as const;

const inspectGitRangeOutput = {
  type: "object",
  properties: {
    requested: {
      type: "object",
      properties: {
        base: { type: "string" },
        head: { type: "string" },
      },
      required: ["base", "head"],
      additionalProperties: false,
    },
    resolved: {
      type: "object",
      properties: {
        base: { type: ["string", "null"] },
        head: { type: ["string", "null"] },
      },
      required: ["base", "head"],
      additionalProperties: false,
    },
    exitStatus: { type: ["integer", "null"] },
    changedPaths: { type: "array", items: { type: "string" } },
    stat: { type: "string" },
    diff: { type: "string" },
    incomplete: { type: "boolean" },
  },
  required: ["requested", "resolved", "exitStatus", "changedPaths", "stat", "diff", "incomplete"],
  additionalProperties: false,
} as const;

const runEvidenceInput = {
  type: "object",
  properties: {
    evidenceId: { type: "string", minLength: 1, maxLength: MAX_EVIDENCE_ID_LENGTH },
    argv: {
      type: "array",
      items: { type: "string", minLength: 1, maxLength: MAX_ARGUMENT_LENGTH },
      minItems: 1,
      maxItems: 50,
    },
  },
  required: ["evidenceId", "argv"],
  additionalProperties: false,
} as const;

const runEvidenceOutput = {
  type: "object",
  properties: {
    validation_id: { type: "string" },
    requested_argv: { type: "array", items: { type: "string" } },
    executed_argv: { type: "array", items: { type: "string" } },
    status: { type: "string", enum: ["passed", "failed", "unavailable", "mutated"] },
    exit_code: { type: ["integer", "null"] },
    timed_out: { type: "boolean" },
    output: { type: "string" },
    working_tree_changed: { type: "boolean" },
  },
  required: [
    "validation_id",
    "requested_argv",
    "executed_argv",
    "status",
    "exit_code",
    "timed_out",
    "output",
    "working_tree_changed",
  ],
  additionalProperties: false,
} as const;

function inspectResult(inspection: GitRangeInspection): Tool.Result {
  return {
    content: JSON.stringify(inspection),
    output: inspection,
    metadata: inspection,
  };
}

function evidenceResult(evidence: ReturnType<typeof runEvidence>): Tool.Result {
  return {
    content: JSON.stringify(evidence),
    output: evidence,
    metadata: {
      evidenceId: evidence.validation_id,
      status: evidence.status,
      executedArgv: evidence.executed_argv,
      workingTreeChanged: evidence.working_tree_changed,
    },
  };
}

export default Plugin.define({
  id: "codex-agents.explorer-tools",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "inspectGitRange",
        description:
          "Inspect one bounded, read-only Git revision range. Explorer-only and non-authoritative.",
        input: inspectGitRangeInput,
        output: inspectGitRangeOutput,
        options: { codemode: false },
        execute: async (input, toolContext) => {
          const request = input as GitRangeRequest;
          if (toolContext.agent !== "explorer") {
            return inspectResult(failedInspection(request.base, request.head, null));
          }
          const worktree = await resolveSessionWorktree(ctx.session, toolContext.sessionID);
          if (worktree === null) {
            return inspectResult(failedInspection(request.base, request.head, null));
          }
          return inspectResult(inspectGitRange(request, worktree));
        },
      });

      editor.add({
        name: "runEvidence",
        description:
          "Run one exact repository-policy-authorized executable evidence argv without a shell. Explorer-only; failures are bounded evidence.",
        input: runEvidenceInput,
        output: runEvidenceOutput,
        options: { codemode: false },
        execute: async (input, toolContext) => {
          const request = input as { evidenceId: string; argv: string[] };
          if (toolContext.agent !== "explorer") {
            return evidenceResult(
              rejectedEvidence(
                request.evidenceId,
                request.argv,
                "runEvidence is restricted to explorer",
              ),
            );
          }
          const worktree = await resolveSessionWorktree(ctx.session, toolContext.sessionID);
          if (worktree === null) {
            return evidenceResult(
              rejectedEvidence(
                request.evidenceId,
                request.argv,
                "unable to resolve session worktree",
              ),
            );
          }
          return evidenceResult(runEvidence(request.evidenceId, request.argv, worktree));
        },
      });
    });
  },
});
