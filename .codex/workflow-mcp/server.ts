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
import {
  ACCEPTANCE_STATUS_VALUES,
  COMMIT_SUBMISSION_OUTCOME_VALUES,
  FINDING_ADJUDICATION_VALUES,
  FINDING_RESOLUTION_VALUES,
  FINDING_SEVERITY_VALUES,
  IMPLEMENTATION_STATUS_VALUES,
  REVIEW_MODE_VALUES,
  REVIEW_STATUS_VALUES,
  VALIDATION_STATUS_VALUES,
  WORKFLOW_TYPE_VALUES,
} from "./values.js";

type JsonSchema = Record<string, JSONValue>;

/* Legacy instructions were intentionally removed; protocolInstructions below is authoritative. */
const _instructions =
  "Authoritative local workflow state. The parent receives one parent capability; workers receive only workflow_id and use dedicated capability-free getters."; /*
  "Authoritative local workflow state for custom agents. The parent creates a workflow and passes each role only its workflow_id, capability, expected_version, and the instruction to read its own authoritative view with workflow_get; that view carries the role's full handoff and permitted next actions, so prompts carry no duplicated objective, approved plan, criteria, evidence, finding, receipt, or repair state. approved_plan is immutable authoritative execution intent, while approved_paths is an append-only narrow mutation scope: only the parent may expand it with fresh user authorization naming exact paths in permitted active states. Linked follow-ups retain that narrow remediation scope and require a fresh independent combined review over inherited logical-change paths before approval or commit. Plan-mode workflows must provide the exact non-empty approved text, while direct workflows explicitly provide null. Structured objective, paths, acceptance criteria, validation requirements, and remediation/findings remain enforceable workflow contracts. Workflow MCP owns receipt capture, comparison, persistence, and commit freshness checks; managed workers submit semantic evidence only. Validation IDs are workflow-local result correlation IDs, never repository command selectors; executable requirements carry exact argv and manual requirements carry argv null. Working-tree reviewers begin a review before inspection, while commit-range reviewers submit directly and never authorize commits. The parent owns user and commit authorization; only combined APPROVED stops a linked logical change; review-only workflows skip the implementer. Committers verify and prepare the fully staged index, then submit the external commit result whether it succeeded or failed. Incompatible persisted databases fail closed with an actionable reset-required diagnostic. If this server is unavailable for non-trivial work, ask the user before using documented prompt-only degraded mode. Capabilities are defense-in-depth, not a filesystem security boundary.";
*/
export const protocolInstructions =
  "Authoritative local workflow state. Planning is a separate pre-workflow domain: revisions are complete and immutable, exact revision approval is parent-only, and only the current approved revision may seed a workflow. The parent receives one parent capability; workers receive only workflow_id and call dedicated capability-free getters before versioned mutations. Parent control-plane mutations and audit retain parent-capability authentication. The parent may use the read-only workflow_operator_decision_get projection for bounded semantic routing; it never authorizes or mutates state. Plan-native linked follow-ups accept exact child plan identity only; the server resolves the current approved PlanArtifact.";

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
  additionalProperties: { type: "string", enum: [...FINDING_RESOLUTION_VALUES] },
};

const findingSchema: JsonSchema = {
  type: "object",
  properties: {
    finding_id: { type: "string", minLength: 1, maxLength: 80 },
    severity: { type: "string", enum: [...FINDING_SEVERITY_VALUES] },
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
    review_mode: { type: "string", enum: [REVIEW_MODE_VALUES[0]] },
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
    review_mode: { type: "string", enum: [REVIEW_MODE_VALUES[1]] },
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

const planRevisionProperties: Record<string, JSONValue> = {
  full_plan: { type: "string", minLength: 1, maxLength: 1048576 },
  execution_brief: { type: "string", minLength: 1, maxLength: 32768 },
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
    items: validationRequirementSchema,
    minItems: 1,
    maxItems: 999,
  },
};

const planIdentityProperties: Record<string, JSONValue> = {
  plan_id: {
    type: "string",
    pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  },
  revision: { type: "integer", minimum: 1 },
};

/** Planning operations are split by authority; keep these sets mechanically testable. */
export const PLANNER_PLANNING_OPERATIONS = ["plan_create", "plan_get", "plan_revise"] as const;
export const PARENT_PLANNING_OPERATIONS = [
  "plan_parent_get",
  "plan_approve",
  "workflow_create_from_plan",
  "workflow_create_linked_followup_from_plan",
] as const;

/** Closed protocol names. This is deliberately separate from WorkflowAction: planning and the
 * semantic operator read are server surfaces, not phase transition actions. */
export const SERVER_TOOL_NAMES = [
  "plan_create",
  "plan_get",
  "plan_revise",
  "plan_parent_get",
  "plan_approve",
  "workflow_create_from_plan",
  "workflow_adopt_dirty_scope",
  "workflow_expand_scope",
  "workflow_create",
  "workflow_parent_get",
  "workflow_operator_decision_get",
  "workflow_implementer_get",
  "workflow_reviewer_get",
  "workflow_committer_get",
  "workflow_get_audit",
  "workflow_submit_implementation",
  "workflow_record_manual_validation",
  "workflow_resume_implementation",
  "workflow_accept_concerns",
  "workflow_begin_review",
  "workflow_submit_review",
  "workflow_authorize_repair",
  "workflow_adjudicate_findings",
  "workflow_resume_review",
  "workflow_finalize_repair_exhausted",
  "workflow_create_linked_followup",
  "workflow_create_linked_followup_from_plan",
  "workflow_authorize_commit",
  "workflow_prepare_commit",
  "workflow_retry_commit_preparation",
  "workflow_return_commit_to_review",
  "workflow_submit_commit_result",
  "workflow_reconcile_commit_result",
  "workflow_retry_commit",
] as const;
export type ServerToolName = (typeof SERVER_TOOL_NAMES)[number];
type ServerToolDefinition = Omit<Tool, "name"> & { name: ServerToolName };

export const toolDefinitions = [
  {
    name: "plan_create",
    description: "Create a complete immutable draft plan revision.",
    inputSchema: schema(planRevisionProperties, Object.keys(planRevisionProperties)),
    annotations: {
      title: "Create plan",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "plan_get",
    description: "Read one exact plan revision without workflow binding.",
    inputSchema: schema(planIdentityProperties, ["plan_id", "revision"]),
    annotations: {
      title: "Get plan",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_revise",
    description:
      "Create a complete replacement plan revision using optimistic base revision semantics.",
    inputSchema: schema(
      {
        plan_id: planIdentityProperties.plan_id,
        base_revision: { type: "integer", minimum: 1 },
        ...planRevisionProperties,
      },
      ["plan_id", "base_revision", ...Object.keys(planRevisionProperties)],
    ),
    annotations: {
      title: "Revise plan",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "plan_parent_get",
    description: "Parent-facing exact plan revision read including approval evidence.",
    inputSchema: schema(planIdentityProperties, ["plan_id", "revision"]),
    annotations: {
      title: "Get plan for parent",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "plan_approve",
    description: "Parent-only explicit approval of the current exact plan revision.",
    inputSchema: schema(
      {
        ...planIdentityProperties,
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      ["plan_id", "revision", "user_authorization"],
    ),
    annotations: {
      title: "Approve plan",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "workflow_create_from_plan",
    description:
      "Create a working-tree change workflow from one current, explicitly approved plan revision.",
    inputSchema: schema(
      {
        ...planIdentityProperties,
        max_repair_cycles: { type: "integer", minimum: 0, maximum: 2 },
        work_items: { type: "array", items: workItemSchema, minItems: 0, maxItems: 50 },
      },
      ["plan_id", "revision"],
    ),
    annotations: {
      title: "Create workflow from plan",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
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
        workflow_type: { type: "string", enum: [...WORKFLOW_TYPE_VALUES] },
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
    name: "workflow_operator_decision_get",
    description:
      "Read a bounded semantic operator decision for one workflow and its validated explicit linked lineage; this projection never authorizes or mutates state.",
    inputSchema: schema({ workflow_id: { type: "string" } }, ["workflow_id"]),
    annotations: {
      title: "Get operator decision",
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
          enum: [...IMPLEMENTATION_STATUS_VALUES],
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
              status: { type: "string", enum: [...ACCEPTANCE_STATUS_VALUES] },
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
              status: { type: "string", enum: [...VALIDATION_STATUS_VALUES] },
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
    name: "workflow_record_manual_validation",
    description:
      "Record bounded parent-owned terminal evidence for one unresolved manual validation requirement.",
    inputSchema: schema(
      {
        ...common.properties,
        validation_id: { type: "string", pattern: "^VAL-[0-9]{3}$" },
        status: { type: "string", enum: ["passed", "failed"] },
        evidence: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "validation_id", "status", "evidence"],
    ),
    annotations: {
      title: "Record manual validation",
      readOnlyHint: false,
      destructiveHint: true,
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
        review_status: { type: "string", enum: [...REVIEW_STATUS_VALUES] },
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
                enum: [...FINDING_ADJUDICATION_VALUES],
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
    name: "workflow_create_linked_followup_from_plan",
    description:
      "Create a fresh linked cycle-0 remediation workflow by resolving the exact current approved child PlanArtifact server-side; after remediation approval it requires a fresh combined review of the inherited logical-change scope before commit eligibility.",
    inputSchema: schema(
      {
        ...common.properties,
        ...planIdentityProperties,
        finding_ids: { type: "array", items: { type: "string" }, minItems: 1 },
        user_authorization: { type: "string", minLength: 1, maxLength: 2000 },
      },
      [...common.required, "plan_id", "revision", "finding_ids", "user_authorization"],
    ),
    annotations: {
      title: "Create linked follow-up from plan",
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
        outcome: { type: "string", enum: [...COMMIT_SUBMISSION_OUTCOME_VALUES] },
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
] as const satisfies readonly ServerToolDefinition[];
export const tools: Tool[] = [...toolDefinitions];

type MissingServerToolDefinition = Exclude<
  ServerToolName,
  (typeof toolDefinitions)[number]["name"]
>;
type UnknownServerToolDefinition = Exclude<
  (typeof toolDefinitions)[number]["name"],
  ServerToolName
>;
const SERVER_TOOL_DEFINITIONS_ARE_EXACT: MissingServerToolDefinition extends never
  ? UnknownServerToolDefinition extends never
    ? true
    : never
  : never = true;
void SERVER_TOOL_DEFINITIONS_ARE_EXACT;

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(safe) }] };
}

type ToolArguments = Record<string, unknown>;
type ToolHandler = (args: ToolArguments) => unknown;

function dispatchFor(store: WorkflowStore): Record<ServerToolName, ToolHandler> {
  return {
    plan_create: (args) => store.planCreate(args),
    plan_get: (args) => store.planGet(args),
    plan_revise: (args) => store.planRevise(args),
    plan_parent_get: (args) => store.planParentGet(args),
    plan_approve: (args) => store.planApprove(args),
    workflow_create_from_plan: (args) => store.createFromPlan(args),
    workflow_adopt_dirty_scope: (args) => store.adoptDirtyScope(args),
    workflow_expand_scope: (args) => store.expandScope(args),
    workflow_create: (args) => store.create(args),
    workflow_parent_get: (args) => store.parentGet(args.workflow_id),
    workflow_operator_decision_get: (args) => store.operatorDecisionGet(args.workflow_id),
    workflow_implementer_get: (args) => store.implementerGet(args.workflow_id),
    workflow_reviewer_get: (args) => store.reviewerGet(args.workflow_id),
    workflow_committer_get: (args) => store.committerGet(args.workflow_id),
    workflow_get_audit: (args) => store.audit(args.workflow_id, args.capability),
    workflow_submit_implementation: (args) => store.submitImplementation(args),
    workflow_record_manual_validation: (args) => store.recordManualValidation(args),
    workflow_resume_implementation: (args) => store.resumeImplementation(args),
    workflow_accept_concerns: (args) => store.acceptConcerns(args),
    workflow_begin_review: (args) => store.beginReview(args),
    workflow_submit_review: (args) => store.submitReview(args),
    workflow_authorize_repair: (args) => store.authorizeRepair(args),
    workflow_adjudicate_findings: (args) => store.adjudicateFindings(args),
    workflow_resume_review: (args) => store.resumeReview(args),
    workflow_finalize_repair_exhausted: (args) => store.finalizeRepairExhausted(args),
    workflow_create_linked_followup: (args) => store.createLinkedFollowup(args),
    workflow_create_linked_followup_from_plan: (args) => store.createLinkedFollowupFromPlan(args),
    workflow_authorize_commit: (args) => store.authorizeCommit(args),
    workflow_prepare_commit: (args) => store.prepareCommit(args),
    workflow_retry_commit_preparation: (args) => store.retryCommitPreparation(args),
    workflow_return_commit_to_review: (args) => store.returnCommitToReview(args),
    workflow_submit_commit_result: (args) => store.submitCommitResult(args),
    workflow_reconcile_commit_result: (args) => store.reconcileCommitResult(args),
    workflow_retry_commit: (args) => store.retryCommit(args),
  };
}

/** Runtime view of the exhaustive dispatch registry, used by protocol contract tests. */
export const DISPATCH_TOOL_NAMES = Object.keys(
  dispatchFor(undefined as unknown as WorkflowStore),
) as ServerToolName[];

export function isServerToolName(value: string): value is ServerToolName {
  return (SERVER_TOOL_NAMES as readonly string[]).includes(value);
}

const TOOL_NAME_SET_IS_UNIQUE = new Set(SERVER_TOOL_NAMES).size === SERVER_TOOL_NAMES.length;
const TOOL_DEFINITION_NAME_SET_IS_UNIQUE =
  new Set(toolDefinitions.map((tool) => tool.name)).size === toolDefinitions.length;
const TOOL_DISPATCH_NAME_SET_IS_EXACT =
  new Set(DISPATCH_TOOL_NAMES).size === DISPATCH_TOOL_NAMES.length &&
  DISPATCH_TOOL_NAMES.length === SERVER_TOOL_NAMES.length &&
  DISPATCH_TOOL_NAMES.every((name) => SERVER_TOOL_NAMES.includes(name));
if (
  !TOOL_NAME_SET_IS_UNIQUE ||
  !TOOL_DEFINITION_NAME_SET_IS_UNIQUE ||
  !TOOL_DISPATCH_NAME_SET_IS_EXACT
) {
  throw new Error("server tool registry contains duplicate names");
}

export function createServer(store: WorkflowStore = openStore()): Server {
  const server = new Server(
    { name: "workflow-state", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: protocolInstructions },
  );
  const dispatch = dispatchFor(store);
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
        if (!isServerToolName(request.params.name))
          fail("ERROR_UNKNOWN_TOOL", "tool is not available");
        result = dispatch[request.params.name](args);
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
