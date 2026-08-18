#!/usr/bin/env bun

import type {
  CallToolResult,
  JSONValue,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/server";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { fail, safeError } from "./errors.js";
import type { WorkflowStore } from "./store.js";
import { openStore } from "./store.js";

type JsonSchema = Record<string, JSONValue>;

const instructions =
  "Authoritative local workflow state for custom agents. The parent creates a workflow and passes each role only its workflow_id, capability, expected_version, and the instruction to read its own authoritative view with workflow_get; that view carries the role's full handoff and permitted next actions, so prompts carry no duplicated objective, criteria, evidence, finding, receipt, or repair state. Workflow MCP owns receipt capture, comparison, persistence, and commit freshness checks; managed workers submit semantic evidence only. Working-tree reviewers begin a review before inspection, while commit-range reviewers submit directly and never authorize commits. The parent owns user and commit authorization; APPROVED stops optional remediation; review-only workflows skip the implementer. Committers verify and prepare the fully staged index, then submit the external commit result whether it succeeded or failed. Migrated v1 workflows keep only limited legacy compatibility. If this server is unavailable for non-trivial work, ask the user before using documented prompt-only degraded mode. Capabilities are defense-in-depth, not a filesystem security boundary.";

const common: {
  type: "object";
  properties: Record<string, JSONValue>;
  required: string[];
  additionalProperties: false;
} = {
  type: "object",
  properties: {
    workflow_id: { type: "string" },
    capability: { type: "string" },
    expected_version: { type: "integer", minimum: 0 },
  },
  required: ["workflow_id", "capability", "expected_version"],
  additionalProperties: false,
};

function schema(
  properties: Record<string, JSONValue>,
  required: string[],
  extra: Record<string, JSONValue> = {},
): Tool["inputSchema"] {
  return {
    type: "object",
    properties: { ...properties },
    required,
    additionalProperties: false,
    ...extra,
  };
}

const resolutionMapSchema: JsonSchema = {
  type: "object",
  additionalProperties: { type: "string", enum: ["resolved", "still_present", "superseded"] },
};

const findingSchema: JsonSchema = {
  type: "object",
  properties: {
    finding_id: { type: "string", minLength: 1, maxLength: 80 },
    severity: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
    blocking: { type: "boolean" },
    file_and_line: { type: "string", minLength: 1, maxLength: 300 },
    failure_scenario: { type: "string", minLength: 1, maxLength: 2000 },
    impact: { type: "string", minLength: 1, maxLength: 2000 },
    violated_requirement: { type: "string", minLength: 1, maxLength: 2000 },
    remediation: { type: "string", minLength: 1, maxLength: 2000 },
    missing_or_inadequate_test: { type: "string", minLength: 1, maxLength: 2000 },
  },
  required: [
    "finding_id",
    "severity",
    "blocking",
    "file_and_line",
    "failure_scenario",
    "impact",
    "violated_requirement",
    "remediation",
    "missing_or_inadequate_test",
  ],
  additionalProperties: false,
};

const workingTreeReviewTargetSchema: JsonSchema = {
  type: "object",
  properties: {
    review_mode: { type: "string", enum: ["working_tree"] },
    base_revision: { type: "string", pattern: "^[0-9a-f]{40}$" },
    head_revision: { type: "null" },
    approved_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
    include_staged: { type: "boolean", const: true },
    include_unstaged: { type: "boolean", const: true },
    include_untracked: { type: "boolean", const: true },
  },
  required: [
    "review_mode",
    "base_revision",
    "head_revision",
    "approved_paths",
    "include_staged",
    "include_unstaged",
    "include_untracked",
  ],
  additionalProperties: false,
};

const commitRangeReviewTargetSchema: JsonSchema = {
  type: "object",
  properties: {
    review_mode: { type: "string", enum: ["commit_range"] },
    base_revision: { type: "string", pattern: "^[0-9a-f]{40}$" },
    head_revision: { type: "string", pattern: "^[0-9a-f]{40}$" },
    approved_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
    include_staged: { type: "boolean", const: false },
    include_unstaged: { type: "boolean", const: false },
    include_untracked: { type: "boolean", const: false },
  },
  required: [
    "review_mode",
    "base_revision",
    "head_revision",
    "approved_paths",
    "include_staged",
    "include_unstaged",
    "include_untracked",
  ],
  additionalProperties: false,
};

const createReviewTargetSchema: JsonSchema = {
  oneOf: [workingTreeReviewTargetSchema, commitRangeReviewTargetSchema],
};

export const tools: Tool[] = [
  {
    name: "workflow_create",
    description:
      "Create a change or review-only workflow and return the parent view plus one-time role capabilities.",
    inputSchema: schema(
      {
        workflow_type: { type: "string", enum: ["change", "review_only"] },
        objective: { type: "string", minLength: 1, maxLength: 4000 },
        approved_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        acceptance_criteria: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4000 },
          minItems: 1,
          maxItems: 999,
        },
        validation_requirements: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4000 },
          minItems: 0,
          maxItems: 999,
        },
        review_target: createReviewTargetSchema,
        max_repair_cycles: { type: "integer", minimum: 0, maximum: 2 },
      },
      [
        "workflow_type",
        "objective",
        "approved_paths",
        "acceptance_criteria",
        "validation_requirements",
        "review_target",
      ],
    ),
    annotations: {
      title: "Create workflow",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_get",
    description:
      "Read the authenticated role's least-authority workflow view with its permitted next actions; capabilities are never returned.",
    inputSchema: schema(
      {
        workflow_id: { type: "string" },
        capability: { type: "string" },
        role: { type: "string", enum: ["parent", "implementer", "reviewer", "committer"] },
      },
      ["workflow_id", "capability", "role"],
    ),
    annotations: {
      title: "Get workflow",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_get_audit",
    description: "Read append-only workflow audit events.",
    inputSchema: schema(
      {
        workflow_id: { type: "string" },
        capability: { type: "string" },
        role: { type: "string", enum: ["parent", "implementer", "reviewer", "committer"] },
      },
      ["workflow_id", "capability", "role"],
    ),
    annotations: {
      title: "Get workflow audit",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_submit_implementation",
    description:
      "Submit complete ID-addressed implementation evidence; DONE advances IMPLEMENTING or REPAIRING to REVIEWING.",
    inputSchema: schema(
      {
        ...common.properties,
        status: {
          type: "string",
          enum: ["DONE", "DONE_WITH_CONCERNS", "NEEDS_CONTEXT", "BLOCKED"],
        },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        agent_touched_paths: {
          type: "array",
          items: { type: "string" },
          minItems: 0,
          maxItems: 200,
        },
        acceptance_results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              criterion_id: { type: "string" },
              status: { type: "string", enum: ["satisfied", "not_satisfied"] },
              evidence: { type: "string", minLength: 1, maxLength: 2000 },
            },
            required: ["criterion_id", "status", "evidence"],
            additionalProperties: false,
          },
        },
        validation_results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              validation_id: { type: "string" },
              status: { type: "string", enum: ["passed", "failed", "not_run"] },
              evidence: { type: "string", minLength: 1, maxLength: 2000 },
            },
            required: ["validation_id", "status", "evidence"],
            additionalProperties: false,
          },
        },
        known_failures: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 2000 },
          maxItems: 50,
        },
        finding_resolution_map: resolutionMapSchema,
      },
      [
        ...common.required,
        "status",
        "summary",
        "agent_touched_paths",
        "acceptance_results",
        "validation_results",
        "known_failures",
        "finding_resolution_map",
      ],
    ),
    annotations: {
      title: "Submit implementation",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_resume_implementation",
    description: "Resume an implementation context or block stop to its prior active phase.",
    inputSchema: schema(
      {
        ...common.properties,
        resume_context: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "resume_context"],
    ),
    annotations: {
      title: "Resume implementation",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_accept_concerns",
    description:
      "Accept DONE_WITH_CONCERNS results with explicit user authorization and enter review.",
    inputSchema: schema(
      {
        ...common.properties,
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "user_authorization"],
    ),
    annotations: {
      title: "Accept concerns",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_begin_review",
    description:
      "Capture the authoritative working-tree review start snapshot; the snapshot remains internal and binds the subsequent review submission.",
    inputSchema: schema(common.properties, common.required),
    annotations: {
      title: "Begin review",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_submit_review",
    description:
      "Submit semantic reviewer findings; approved working-tree reviews are compared with the internal review-start snapshot.",
    inputSchema: schema(
      {
        ...common.properties,
        review_status: { type: "string", enum: ["APPROVED", "CHANGES_REQUESTED", "INCONCLUSIVE"] },
        blocking_findings: { type: "array", items: findingSchema, maxItems: 200 },
        optional_findings: { type: "array", items: findingSchema, maxItems: 200 },
        review_target: createReviewTargetSchema,
        prior_finding_classifications: resolutionMapSchema,
      },
      [
        ...common.required,
        "review_status",
        "blocking_findings",
        "optional_findings",
        "review_target",
        "prior_finding_classifications",
      ],
    ),
    annotations: {
      title: "Submit review",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_authorize_repair",
    description: "Authorize exact existing blocking finding IDs for the next bounded repair cycle.",
    inputSchema: schema(
      {
        ...common.properties,
        finding_ids: { type: "array", items: { type: "string" }, minItems: 1 },
      },
      [...common.required, "finding_ids"],
    ),
    annotations: {
      title: "Authorize repair",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_resume_review",
    description: "Resume an inconclusive review stop to REVIEWING.",
    inputSchema: schema(
      {
        ...common.properties,
        resume_context: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "resume_context"],
    ),
    annotations: {
      title: "Resume review",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_finalize_repair_exhausted",
    description: "Finalize STOPPED_REPAIR_EXHAUSTED after the maximum repair cycle is exhausted.",
    inputSchema: schema(common.properties, common.required),
    annotations: {
      title: "Finalize repair exhausted",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_create_linked_followup",
    description:
      "Create a fresh linked cycle-0 change workflow that copies exact source findings, remediation context, and parent/source links.",
    inputSchema: schema(
      {
        ...common.properties,
        objective: { type: "string", minLength: 1, maxLength: 4000 },
        approved_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        acceptance_criteria: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4000 },
          minItems: 1,
          maxItems: 999,
        },
        validation_requirements: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4000 },
          minItems: 1,
          maxItems: 999,
        },
        finding_ids: { type: "array", items: { type: "string" }, minItems: 1 },
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [
        ...common.required,
        "objective",
        "approved_paths",
        "acceptance_criteria",
        "validation_requirements",
        "finding_ids",
        "user_authorization",
      ],
    ),
    annotations: {
      title: "Create linked follow-up",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_authorize_commit",
    description:
      "Record separate parent/user commit authorization after receipt freshness verification.",
    inputSchema: schema(
      {
        ...common.properties,
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "user_authorization"],
    ),
    annotations: {
      title: "Authorize commit",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_prepare_commit",
    description:
      "Verify the fully staged index against the internal authorized review receipt and prepare a commit binding the exact HEAD, tree, and paths.",
    inputSchema: schema(common.properties, common.required),
    annotations: {
      title: "Prepare commit",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_submit_commit_result",
    description:
      "Submit the outcome of an external commit attempt; a verified commit enters COMMITTED, an unchanged-HEAD failure enters a retryable stop, and any verification mismatch enters a terminal stop.",
    inputSchema: schema(
      {
        ...common.properties,
        attempt_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        outcome: { type: "string", enum: ["committed", "not_committed"] },
        commit_hash: {
          oneOf: [{ type: "string", pattern: "^[0-9a-f]{40}$" }, { type: "null" }],
        },
        failure_summary: {
          oneOf: [{ type: "string", minLength: 1, maxLength: 2000 }, { type: "null" }],
        },
      },
      [...common.required, "attempt_id", "outcome", "commit_hash", "failure_summary"],
    ),
    annotations: {
      title: "Submit commit result",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_retry_commit",
    description:
      "Authorize a retry after an unchanged-HEAD commit failure; clears the attempt and result and returns to commit authorization.",
    inputSchema: schema(
      {
        ...common.properties,
        retry_context: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "retry_context"],
    ),
    annotations: {
      title: "Retry commit",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_record_commit",
    description:
      "Migrated-v1 compatibility: record a legacy committer Git result after verifying current HEAD and reviewed content; rejected for new v2 workflows.",
    inputSchema: schema(
      { ...common.properties, commit_hash: { type: "string", pattern: "^[0-9a-f]{40}$" } },
      [...common.required, "commit_hash"],
    ),
    annotations: {
      title: "Record commit",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
];

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(safe) }] };
}

export function createServer(store: WorkflowStore = openStore()): Server {
  const server = new Server(
    { name: "workflow-state", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions },
  );
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
  server.setRequestHandler("tools/call", async (request) => {
    try {
      const args = request.params.arguments ?? {};
      let result: unknown;
      switch (request.params.name) {
        case "workflow_create":
          result = store.create(args);
          break;
        case "workflow_get":
          result = store.get(args.workflow_id, args.role, args.capability);
          break;
        case "workflow_get_audit":
          result = store.audit(args.workflow_id, args.role, args.capability);
          break;
        case "workflow_submit_implementation":
          result = store.submitImplementation(args);
          break;
        case "workflow_resume_implementation":
          result = store.resumeImplementation(args);
          break;
        case "workflow_accept_concerns":
          result = store.acceptConcerns(args);
          break;
        case "workflow_begin_review":
          result = store.beginReview(args);
          break;
        case "workflow_submit_review":
          result = store.submitReview(args);
          break;
        case "workflow_authorize_repair":
          result = store.authorizeRepair(args);
          break;
        case "workflow_resume_review":
          result = store.resumeReview(args);
          break;
        case "workflow_finalize_repair_exhausted":
          result = store.finalizeRepairExhausted(args);
          break;
        case "workflow_create_linked_followup":
          result = store.createLinkedFollowup(args);
          break;
        case "workflow_authorize_commit":
          result = store.authorizeCommit(args);
          break;
        case "workflow_prepare_commit":
          result = store.prepareCommit(args);
          break;
        case "workflow_submit_commit_result":
          result = store.submitCommitResult(args);
          break;
        case "workflow_retry_commit":
          result = store.retryCommit(args);
          break;
        case "workflow_record_commit":
          result = store.recordCommit(args);
          break;
        default:
          fail("ERROR_UNKNOWN_TOOL", "tool is not available");
      }
      return json(result);
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}

export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  let store: WorkflowStore | undefined;
  let server: Server | undefined;
  let shuttingDown = false;
  let connected = false;
  const shutdown = async (exitCode: number | null = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (connected && server) await server.close();
    } catch {
      // The transport may already be closed by the client.
    }
    try {
      await transport.close();
    } catch {
      // Closing an already-closed STDIO transport is harmless.
    }
    store?.close();
    if (exitCode !== null) process.exitCode = exitCode;
  };
  transport.onclose = () => {
    void shutdown(null);
  };
  process.stdin.once("end", () => {
    void shutdown(null);
  });
  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    void shutdown(0);
  });
  store = openStore();
  server = createServer(store);
  await server.connect(transport);
  connected = true;
}

if (import.meta.main) {
  main().catch((error) => {
    const safe = safeError(error);
    process.stderr.write(`${safe.category}: ${safe.detail}\n`);
    process.exitCode = 1;
  });
}
