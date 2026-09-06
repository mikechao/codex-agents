import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { disposeFixture } from "./test-fixtures.js";

export const SERVER = join(process.cwd(), ".codex", "workflow-mcp", "server.ts");

export function workingTreeTarget(base: string, paths = ["note.txt"]) {
  return {
    review_mode: "working_tree",
    base_revision: base,
    head_revision: null,
    approved_paths: paths,
    include_staged: true,
    include_unstaged: true,
    include_untracked: true,
  };
}

interface WorkflowOptions {
  workflow_type?: string;
  objective?: string;
  approved_paths?: string[];
  approved_plan?: string | null;
  validation_requirements?: Array<unknown>;
  review_target?: Record<string, unknown>;
  max_repair_cycles?: number;
}

export function workflowCreateInput(
  git: (...args: string[]) => string,
  options: WorkflowOptions = {},
) {
  const paths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "stdio protocol",
    approved_plan: options.approved_plan ?? null,
    approved_paths: paths,
    acceptance_criteria: ["criterion"],
    validation_requirements: options.validation_requirements ?? [
      { description: "validation", argv: ["bun", "run", "check"] },
    ],
    review_target: options.review_target ?? workingTreeTarget(git("rev-parse", "HEAD"), paths),
    ...(options.max_repair_cycles === undefined
      ? {}
      : { max_repair_cycles: options.max_repair_cycles }),
  };
}

export function implementationInput(
  id: string,
  version: number,
  status = "DONE",
  resolution: Record<string, string> = {},
) {
  return {
    workflow_id: id,
    expected_version: version,
    status,
    summary: "implementation evidence",
    agent_touched_paths: [],
    acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
    validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
    known_failures: [],
    finding_resolution_map: resolution,
  };
}

export interface ProtocolResponse {
  result: Awaited<ReturnType<Client["callTool"]>>;
  body: ReturnType<typeof JSON.parse>;
}

export interface ProtocolSession {
  client: Client;
  transport: StdioClientTransport;
  callRaw(name: string, arguments_: Record<string, unknown>): Promise<ProtocolResponse>;
  call(name: string, arguments_: Record<string, unknown>): Promise<ReturnType<typeof JSON.parse>>;
  version(workflowId: string): Promise<number>;
}

export async function connectProtocol(root: string, diagnostics = false): Promise<ProtocolSession> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", SERVER],
    cwd: root,
    env: {
      ...process.env,
      WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite"),
      ...(diagnostics ? { WORKFLOW_MCP_DIAGNOSTICS: "1" } : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const callRaw = async (name: string, arguments_: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    return {
      result,
      body: JSON.parse((result.content[0] as { text: string }).text),
    };
  };
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const response = await callRaw(name, arguments_);
    if (response.result.isError) throw new Error(`${name}: ${response.body.category}`);
    return response.body;
  };
  return {
    client,
    transport,
    callRaw,
    call,
    version: async (workflowId: string) =>
      (await call("workflow_parent_get", { workflow_id: workflowId })).version,
  };
}

export async function closeProtocol(session: ProtocolSession): Promise<void> {
  await session.client.close();
  await session.transport.close();
}

export async function disposeProtocolFixture(
  root: string,
  session?: ProtocolSession,
): Promise<void> {
  try {
    if (session) await closeProtocol(session);
  } finally {
    disposeFixture(root);
  }
}
