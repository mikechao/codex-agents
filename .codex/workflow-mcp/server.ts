#!/usr/bin/env bun

import type {
  CallToolResult,
  JSONValue,
  ListToolsResult,
  Tool,
} from "@modelcontextprotocol/server";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { withDiagnosticRequest } from "./diagnostics.js";
import { fail, safeError } from "./errors.js";
import type { WorkflowStore } from "./store.js";
import { openStore } from "./store.js";

type JsonSchema = Record<string, JSONValue>;

/* Legacy instructions were intentionally removed; protocolInstructions below is authoritative. */
const _instructions =
  "Authoritative local workflow state. The parent receives one parent capability; workers receive only workflow_id and use dedicated capability-free getters."; /*
  "Authoritative local workflow state for custom agents. The parent creates a workflow and passes each role only its workflow_id, capability, expected_version, and the instruction to read its own authoritative view with workflow_get; that view carries the role's full handoff and permitted next actions, so prompts carry no duplicated objective, approved plan, criteria, evidence, finding, receipt, or repair state. approved_plan is immutable authoritative execution intent, while approved_paths is an append-only narrow mutation scope: only the parent may expand it with fresh user authorization naming exact paths in permitted active states. Linked follow-ups retain that narrow remediation scope and require a fresh independent combined review over inherited logical-change paths before approval or commit. Plan-mode workflows must provide the exact non-empty approved text, while direct workflows explicitly provide null. Structured objective, paths, acceptance criteria, validation requirements, and remediation/findings remain enforceable workflow contracts. Workflow MCP owns receipt capture, comparison, persistence, and commit freshness checks; managed workers submit semantic evidence only. Validation IDs are workflow-local result correlation IDs, never repository command selectors; executable requirements carry exact argv and manual requirements carry argv null. Working-tree reviewers begin a review before inspection, while commit-range reviewers submit directly and never authorize commits. The parent owns user and commit authorization; only combined APPROVED stops a linked logical change; review-only workflows skip the implementer. Committers verify and prepare the fully staged index, then submit the external commit result whether it succeeded or failed. Incompatible persisted databases fail closed with an actionable reset-required diagnostic. If this server is unavailable for non-trivial work, ask the user before using documented prompt-only degraded mode. Capabilities are defense-in-depth, not a filesystem security boundary.";
*/
export const protocolInstructions =
  "Authoritative local workflow state. The parent receives one parent capability; workers receive only workflow_id and call dedicated capability-free getters before versioned mutations. Parent control-plane mutations and audit retain parent-capability authentication.";

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

const workerCommon: {
  type: "object";
  properties: Record<string, JSONValue>;
  required: string[];
  additionalProperties: false;
} = {
  type: "object",
  properties: {
    workflow_id: { type: "string" },
    expected_version: { type: "integer", minimum: 0 },
  },
  required: ["workflow_id", "expected_version"],
  additionalProperties: false,
};

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

const validationRequirementSchema: JsonSchema = {
  oneOf: [
    { type: "string", minLength: 1, maxLength: 4000 },
    {
      type: "object",
      properties: {
        description: { type: "string", minLength: 1, maxLength: 4000 },
        argv: {
          oneOf: [
            { type: "null" },
            {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 4000 },
              minItems: 1,
              maxItems: 50,
            },
          ],
        },
      },
      required: ["description", "argv"],
      additionalProperties: false,
    },
  ],
};

const workItemSchema: JsonSchema = {
  type: "object",
  properties: {
    provider: { type: "string", minLength: 1, maxLength: 64 },
    id: { type: "string", minLength: 1, maxLength: 200 },
    display_ref: { type: "string", minLength: 1, maxLength: 200 },
    url: { oneOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 2048 }] },
  },
  required: ["provider", "id", "display_ref"],
  additionalProperties: false,
};

export const tools: Tool[] = [
  {
    name: "workflow_adopt_dirty_scope",
    description:
      "Adopt exact already-dirty repository paths from STOPPED_INCONCLUSIVE under fresh parent/user authorization.",
    inputSchema: schema(
      {
        ...common.properties,
        added_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        adopted_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "reason", "user_authorization"],
      {
        oneOf: [{ required: ["added_paths"] }, { required: ["adopted_paths"] }],
      },
    ),
    annotations: {
      title: "Adopt dirty scope",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_expand_scope",
    description:
      "Append exact clean or absent repository paths to an active working-tree change workflow under fresh parent/user authorization.",
    inputSchema: schema(
      {
        ...common.properties,
        added_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "added_paths", "reason", "user_authorization"],
    ),
    annotations: {
      title: "Expand workflow scope",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_create",
    description:
      "Create a change or review-only workflow and return the parent view plus one parent capability.",
    inputSchema: schema(
      {
        workflow_type: { type: "string", enum: ["change", "review_only"] },
        objective: { type: "string", minLength: 1, maxLength: 4000 },
        approved_plan: {
          oneOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 1048576 }],
        },
        approved_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        acceptance_criteria: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4000 },
          minItems: 1,
          maxItems: 999,
        },
        validation_requirements: {
          type: "array",
          items: validationRequirementSchema,
          minItems: 0,
          maxItems: 999,
        },
        review_target: createReviewTargetSchema,
        max_repair_cycles: { type: "integer", minimum: 0, maximum: 2 },
        work_items: { type: "array", items: workItemSchema, minItems: 0, maxItems: 50 },
      },
      [
        "workflow_type",
        "objective",
        "approved_plan",
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
    name: "workflow_parent_get",
    description: "Read the parent workflow view by exact workflow_id.",
    inputSchema: schema({ workflow_id: { type: "string" } }, ["workflow_id"]),
    annotations: {
      title: "Get workflow",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_implementer_get",
    description: "Read the implementer workflow view by exact workflow_id.",
    inputSchema: schema({ workflow_id: { type: "string" } }, ["workflow_id"]),
    annotations: {
      title: "Get implementer workflow",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_reviewer_get",
    description: "Read the reviewer workflow view by exact workflow_id.",
    inputSchema: schema({ workflow_id: { type: "string" } }, ["workflow_id"]),
    annotations: {
      title: "Get reviewer workflow",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_committer_get",
    description: "Read the committer workflow view by exact workflow_id.",
    inputSchema: schema({ workflow_id: { type: "string" } }, ["workflow_id"]),
    annotations: {
      title: "Get committer workflow",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_get_audit",
    description: "Read append-only workflow audit events with the parent capability.",
    inputSchema: schema(
      {
        workflow_id: { type: "string" },
        capability: { type: "string" },
      },
      ["workflow_id", "capability"],
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
      "Submit ID-addressed implementation-attempt evidence; DONE advances to REVIEWING, INCOMPLETE preserves IMPLEMENTING or REPAIRING, and other outcomes stop for their documented recovery path.",
    inputSchema: schema(
      {
        ...workerCommon.properties,
        status: {
          type: "string",
          enum: ["DONE", "DONE_WITH_CONCERNS", "INCOMPLETE", "NEEDS_CONTEXT", "BLOCKED"],
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
        ...workerCommon.required,
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
    inputSchema: workerCommon,
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
        ...workerCommon.properties,
        review_status: { type: "string", enum: ["APPROVED", "CHANGES_REQUESTED", "INCONCLUSIVE"] },
        blocking_findings: { type: "array", items: findingSchema, maxItems: 200 },
        optional_findings: { type: "array", items: findingSchema, maxItems: 200 },
        prior_finding_classifications: resolutionMapSchema,
      },
      [
        ...workerCommon.required,
        "review_status",
        "blocking_findings",
        "optional_findings",
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
    name: "workflow_adjudicate_findings",
    description:
      "Record an explicit parent/user disposition for exact blocking findings that are inconsistent with the approved contract or outside approved scope.",
    inputSchema: schema(
      {
        ...common.properties,
        findings: {
          type: "array",
          minItems: 1,
          maxItems: 200,
          items: {
            type: "object",
            properties: {
              finding_id: { type: "string", minLength: 1, maxLength: 80 },
              disposition: {
                type: "string",
                enum: ["CONTRACT_INCONSISTENT", "OUTSIDE_APPROVED_SCOPE"],
              },
              reason: { type: "string", minLength: 1, maxLength: 2000 },
            },
            required: ["finding_id", "disposition", "reason"],
            additionalProperties: false,
          },
        },
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "findings", "user_authorization"],
    ),
    annotations: {
      title: "Adjudicate findings",
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
      "Create a fresh linked cycle-0 remediation workflow with a narrow authorized mutation scope; after remediation approval it requires a fresh combined review of the inherited logical-change scope before commit eligibility.",
    inputSchema: schema(
      {
        ...common.properties,
        objective: { type: "string", minLength: 1, maxLength: 4000 },
        approved_plan: {
          oneOf: [{ type: "null" }, { type: "string", minLength: 1, maxLength: 1048576 }],
        },
        approved_paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 200 },
        acceptance_criteria: {
          type: "array",
          items: { type: "string", minLength: 1, maxLength: 4000 },
          minItems: 1,
          maxItems: 999,
        },
        validation_requirements: {
          type: "array",
          items: validationRequirementSchema,
          minItems: 1,
          maxItems: 999,
        },
        finding_ids: { type: "array", items: { type: "string" }, minItems: 1 },
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [
        ...common.required,
        "objective",
        "approved_plan",
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
    inputSchema: workerCommon,
    annotations: {
      title: "Prepare commit",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_retry_commit_preparation",
    description:
      "Authorize an explicit retry after a retryable commit-preparation failure; clears the failure stop and returns to commit authorization without staging or preparing automatically.",
    inputSchema: schema(
      {
        ...common.properties,
        retry_context: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "retry_context"],
    ),
    annotations: {
      title: "Retry commit preparation",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_return_commit_to_review",
    description:
      "Return a review-invalidating commit-preparation failure to review; clears the old receipt and commit authorization and requires fresh review before authorization.",
    inputSchema: schema(
      {
        ...common.properties,
        review_context: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "review_context"],
    ),
    annotations: {
      title: "Return commit to review",
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
        ...workerCommon.properties,
        attempt_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
        outcome: { type: "string", enum: ["committed", "not_committed"] },
        failure_summary: {
          oneOf: [{ type: "string", minLength: 1, maxLength: 2000 }, { type: "null" }],
        },
      },
      [...workerCommon.required, "attempt_id", "outcome", "failure_summary"],
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
    name: "workflow_reconcile_commit_result",
    description:
      "Reconcile a commit that already exists after commit-result bookkeeping failed on an old immutable runtime; this parent-only recovery never creates or changes Git history.",
    inputSchema: schema(
      {
        ...common.properties,
        attempt_id: { type: "string", pattern: "^[0-9a-f-]{36}$" },
      },
      [...common.required, "attempt_id"],
    ),
    annotations: {
      title: "Reconcile commit result",
      readOnlyHint: false,
      destructiveHint: false,
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
    { capabilities: { tools: {} }, instructions: protocolInstructions },
  );
  server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
  server.setRequestHandler("tools/call", async (request, context) => {
    const requestId = context.mcpReq.id;
    const tool = request.params.name;
    const args = request.params.arguments ?? {};
    store.diagnostics.record({
      event: "tool_receipt",
      request_id: requestId,
      tool,
      workflow_id: args.workflow_id,
      runtime_id: store.runtimeId,
      runtime_revision: store.runtimeRevision,
      outcome: "received",
    });
    try {
      let result: unknown;
      withDiagnosticRequest({ request_id: requestId, method: "tools/call", tool }, () => {
        switch (request.params.name) {
          case "workflow_expand_scope":
            result = store.expandScope(args);
            break;
          case "workflow_adopt_dirty_scope":
            result = store.adoptDirtyScope(args);
            break;
          case "workflow_create":
            result = store.create(args);
            break;
          case "workflow_parent_get":
            result = store.parentGet(args.workflow_id);
            break;
          case "workflow_implementer_get":
            result = store.implementerGet(args.workflow_id);
            break;
          case "workflow_reviewer_get":
            result = store.reviewerGet(args.workflow_id);
            break;
          case "workflow_committer_get":
            result = store.committerGet(args.workflow_id);
            break;
          case "workflow_get_audit":
            result = store.audit(args.workflow_id, args.capability);
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
          case "workflow_adjudicate_findings":
            result = store.adjudicateFindings(args);
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
          case "workflow_retry_commit_preparation":
            result = store.retryCommitPreparation(args);
            break;
          case "workflow_return_commit_to_review":
            result = store.returnCommitToReview(args);
            break;
          case "workflow_submit_commit_result":
            result = store.submitCommitResult(args);
            break;
          case "workflow_reconcile_commit_result":
            result = store.reconcileCommitResult(args);
            break;
          case "workflow_retry_commit":
            result = store.retryCommit(args);
            break;
          default:
            fail("ERROR_UNKNOWN_TOOL", "tool is not available");
        }
      });
      store.diagnostics.record({
        event: "tool_result",
        request_id: requestId,
        tool,
        workflow_id: args.workflow_id,
        runtime_id: store.runtimeId,
        runtime_revision: store.runtimeRevision,
        outcome: "success",
      });
      return json(result);
    } catch (error) {
      const safe = safeError(error);
      store.diagnostics.record({
        event: "tool_result",
        request_id: requestId,
        tool,
        workflow_id: args.workflow_id,
        runtime_id: store.runtimeId,
        runtime_revision: store.runtimeRevision,
        outcome: "error",
        error_category: safe.category,
      });
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
