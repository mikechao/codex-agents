import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DiagnosticLayer = "supervisor-store" | "runtime-store" | "supervisor" | "runtime";
export type DiagnosticRequestId = string | number | null | undefined;

export interface DiagnosticRequestContext {
  request_id?: DiagnosticRequestId;
  method?: string;
  tool?: string;
}

export interface DiagnosticEvent {
  event: string;
  request_id?: DiagnosticRequestId;
  method?: string;
  tool?: string;
  workflow_id?: unknown;
  database_path?: string;
  found?: boolean;
  version?: number;
  phase?: string;
  runtime_id?: string | null;
  runtime_revision?: string | null;
  adopted?: boolean;
  selected_runtime?: string;
  outcome?: string;
  error_category?: string;
}

export interface DiagnosticRecorderOptions {
  directory?: string;
  enabled?: boolean;
  maxBytes?: number;
  maxFiles?: number;
  pid?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const DEFAULT_MAX_FILES = 8;
const MAX_TEXT = 160;
const SAFE_CATEGORIES = new Set([
  "ERROR_NOT_FOUND",
  "ERROR_RUNTIME_ISOLATION",
  "ERROR_RUNTIME_RECOVERY",
  "ERROR_STATE_CORRUPT",
  "ERROR_MIGRATION_REQUIRED",
  "ERROR_INVALID_SHAPE",
  "ERROR_UNKNOWN_TOOL",
]);
const SAFE_EVENTS = new Set([
  "request_receipt",
  "affinity_result",
  "child_forward",
  "routing_error",
  "workflow_lookup",
  "tool_receipt",
  "tool_result",
]);
const SAFE_OUTCOMES = new Set([
  "received",
  "resolved",
  "forwarded",
  "error",
  "success",
  "malformed_id",
  "missing_row",
  "found",
]);

let requestContext: DiagnosticRequestContext | undefined;

export function withDiagnosticRequest<T>(context: DiagnosticRequestContext, action: () => T): T {
  const previous = requestContext;
  requestContext = context;
  try {
    return action();
  } finally {
    requestContext = previous;
  }
}

export function diagnosticRequestContext(): DiagnosticRequestContext | undefined {
  return requestContext;
}

export function diagnosticsDirectory(repositoryRoot: string): string {
  const digest = createHash("sha256").update(repositoryRoot, "utf8").digest("hex").slice(0, 24);
  return join(homedir(), ".codex", "state", "workflow-mcp", digest, "diagnostics");
}

function boundedText(value: string): string {
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

function workflowMetadata(value: unknown): {
  kind: "valid" | "malformed" | "absent";
  prefix?: string;
} {
  if (value === undefined || value === null) return { kind: "absent" };
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/u.test(value)) return { kind: "malformed" };
  return { kind: "valid", prefix: value.slice(0, 8) };
}

function safeEvent(event: DiagnosticEvent): Record<string, unknown> {
  const context = diagnosticRequestContext();
  const record: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    process_id: process.pid,
    event: SAFE_EVENTS.has(event.event) ? event.event : "unknown",
  };
  const requestId = event.request_id ?? context?.request_id;
  if (typeof requestId === "string" || typeof requestId === "number" || requestId === null)
    record.request_id = requestId;
  const method = event.method ?? context?.method;
  const tool = event.tool ?? context?.tool;
  if (method && /^(?:initialize|notifications\/initialized|tools\/call)$/u.test(method))
    record.method = method;
  if (tool && /^workflow_[a-z0-9_]+$/u.test(tool)) record.tool = boundedText(tool);
  if ("workflow_id" in event) record.workflow_id = workflowMetadata(event.workflow_id);
  if (event.database_path) record.database_path = boundedText(event.database_path);
  if (typeof event.found === "boolean") record.found = event.found;
  if (typeof event.version === "number" && Number.isSafeInteger(event.version))
    record.version = event.version;
  if (event.phase) record.phase = boundedText(event.phase);
  if (event.runtime_id !== undefined)
    record.runtime_identity = event.runtime_id ? boundedText(event.runtime_id.slice(0, 12)) : null;
  if (event.runtime_revision !== undefined)
    record.runtime_revision = event.runtime_revision
      ? boundedText(event.runtime_revision.slice(0, 12))
      : null;
  if (typeof event.adopted === "boolean") record.adopted = event.adopted;
  if (event.selected_runtime) record.selected_runtime = boundedText(event.selected_runtime);
  if (event.outcome && SAFE_OUTCOMES.has(event.outcome)) record.outcome = event.outcome;
  if (event.error_category && SAFE_CATEGORIES.has(event.error_category))
    record.error_category = event.error_category;
  return record;
}

export class DiagnosticRecorder {
  readonly layer: DiagnosticLayer;
  readonly enabled: boolean;
  readonly path: string;
  private readonly maxBytes: number;
  private stopped = false;

  constructor(
    layer: DiagnosticLayer,
    repositoryRoot: string,
    options: DiagnosticRecorderOptions = {},
  ) {
    this.layer = layer;
    this.enabled = options.enabled ?? process.env.WORKFLOW_MCP_DIAGNOSTICS === "1";
    this.maxBytes = Math.max(1024, options.maxBytes ?? DEFAULT_MAX_BYTES);
    const directory = options.directory ?? diagnosticsDirectory(repositoryRoot);
    const fileLayer = layer.endsWith("-store") ? layer.slice(0, -6) : layer;
    this.path = join(directory, `${fileLayer}-${options.pid ?? process.pid}.jsonl`);
    if (!this.enabled) return;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.cleanup(directory, options.maxFiles ?? DEFAULT_MAX_FILES);
    } catch {
      this.stopped = true;
    }
  }

  private cleanup(directory: string, maxFiles: number): void {
    const files = readdirSync(directory)
      .filter((file) => {
        const fileLayer = this.layer.endsWith("-store") ? this.layer.slice(0, -6) : this.layer;
        return file.startsWith(`${fileLayer}-`) && file.endsWith(".jsonl");
      })
      .map((file) => {
        const path = join(directory, file);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    for (const file of files.slice(Math.max(1, maxFiles))) {
      try {
        unlinkSync(file.path);
      } catch {
        // Diagnostics are strictly best effort.
      }
    }
  }

  record(event: DiagnosticEvent): void {
    if (!this.enabled || this.stopped) return;
    try {
      const line = `${JSON.stringify({ layer: this.layer, ...safeEvent(event) })}\n`;
      const currentSize = statSync(this.path, { throwIfNoEntry: false })?.size ?? 0;
      if (currentSize + Buffer.byteLength(line) > this.maxBytes) {
        this.stopped = true;
        return;
      }
      appendFileSync(this.path, line, { encoding: "utf8", mode: 0o600 });
    } catch {
      this.stopped = true;
    }
  }
}

export function createDiagnosticRecorder(
  layer: DiagnosticLayer,
  repositoryRoot: string,
  options: DiagnosticRecorderOptions = {},
): DiagnosticRecorder {
  return new DiagnosticRecorder(layer, repositoryRoot, options);
}

export const diagnosticLimits = {
  maxBytes: DEFAULT_MAX_BYTES,
  maxFiles: DEFAULT_MAX_FILES,
};
