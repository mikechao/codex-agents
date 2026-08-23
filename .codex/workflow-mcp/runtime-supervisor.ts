import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  createDiagnosticRecorder,
  type DiagnosticRecorder,
  withDiagnosticRequest,
} from "./diagnostics.js";
import { WorkflowError } from "./errors.js";
import { currentHead, repositoryRoot } from "./git.js";
import {
  materializeRuntimeArtifact,
  type RuntimeArtifact,
  type RuntimeArtifactOptions,
} from "./runtime-artifact.js";
import {
  createRuntimeAttestation,
  openStore,
  type RuntimeAffinity,
  resolveStatePath,
} from "./store.js";

export interface RuntimeSupervisorOptions extends RuntimeArtifactOptions {
  repositoryRoot?: string;
  /** Repository whose committed runtime is trusted (the provider checkout). */
  providerRoot?: string;
  databasePath?: string;
  bunExecutable?: string;
  diagnostics?: DiagnosticRecorder;
  diagnosticsDirectory?: string;
}

export interface ResolvedRuntime extends RuntimeArtifact {
  runtime_id: string;
  revision: string;
}

function runtimeFailure(
  category: "ERROR_RUNTIME_ISOLATION" | "ERROR_RUNTIME_RECOVERY",
  detail: string,
): WorkflowError {
  return new WorkflowError(category, detail);
}

function childInput(child: ChildProcess): NonNullable<ChildProcess["stdin"]> {
  if (!child.stdin) throw runtimeFailure("ERROR_RUNTIME_RECOVERY", "runtime stdin is unavailable");
  return child.stdin;
}

function childOutput(child: ChildProcess): NonNullable<ChildProcess["stdout"]> {
  if (!child.stdout)
    throw runtimeFailure("ERROR_RUNTIME_RECOVERY", "runtime stdout is unavailable");
  return child.stdout;
}

export function resolveCurrentRuntime(options: RuntimeSupervisorOptions = {}): ResolvedRuntime {
  const root = options.providerRoot ?? options.repositoryRoot ?? process.cwd();
  try {
    const artifact = materializeRuntimeArtifact(root, currentHead(root), options);
    return artifact;
  } catch (error) {
    throw runtimeFailure(
      "ERROR_RUNTIME_ISOLATION",
      error instanceof Error ? error.message : "default runtime cannot be materialized",
    );
  }
}

export function resolveOwningRuntime(
  root: string,
  affinity: RuntimeAffinity,
  options: RuntimeSupervisorOptions = {},
): ResolvedRuntime {
  if (affinity.runtime_id === null || affinity.runtime_revision === null) {
    throw runtimeFailure("ERROR_RUNTIME_RECOVERY", "workflow has no owning immutable runtime");
  }
  try {
    const artifact = materializeRuntimeArtifact(root, affinity.runtime_revision, options);
    if (artifact.runtime_id !== affinity.runtime_id) {
      throw runtimeFailure(
        "ERROR_RUNTIME_RECOVERY",
        "workflow runtime identity does not match its committed revision",
      );
    }
    return artifact;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw runtimeFailure(
      "ERROR_RUNTIME_RECOVERY",
      error instanceof Error ? error.message : "owning runtime cannot be recovered",
    );
  }
}

interface JsonRpcMessage {
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
  error?: unknown;
  result?: unknown;
}

function isCommitReconciliation(message: JsonRpcMessage): boolean {
  return (
    message.method === "tools/call" && message.params?.name === "workflow_reconcile_commit_result"
  );
}

type RequestId = string | number | null;

interface PendingRequest {
  id: RequestId;
  message: JsonRpcMessage;
}

function directToolResult(value: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function augmentHistoricalParentRecovery(
  request: JsonRpcMessage,
  response: JsonRpcMessage,
  historicalOwner: boolean,
): JsonRpcMessage {
  if (!historicalOwner || request.params?.name !== "workflow_parent_get") return response;
  const result = response.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return response;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1) return response;
  const item = content[0];
  if (!item || typeof item !== "object" || Array.isArray(item)) return response;
  const text = (item as { text?: unknown }).text;
  if (typeof text !== "string") return response;
  let view: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return response;
    view = parsed as Record<string, unknown>;
  } catch {
    return response;
  }
  if (
    view.workflow_id !== request.params?.arguments?.workflow_id ||
    view.phase !== "COMMIT_PREPARED" ||
    !Array.isArray(view.permitted_next_actions) ||
    view.permitted_next_actions.some((action) => typeof action !== "string")
  )
    return response;
  const action = "workflow_reconcile_commit_result";
  if ((view.permitted_next_actions as string[]).includes(action)) return response;
  const augmented = {
    ...response,
    result: {
      ...(result as Record<string, unknown>),
      content: [
        {
          ...(item as Record<string, unknown>),
          text: JSON.stringify({
            ...view,
            permitted_next_actions: [...(view.permitted_next_actions as string[]), action].sort(),
          }),
        },
      ],
    },
  };
  return augmented;
}

function unknownToolResponse(message: JsonRpcMessage): boolean {
  const error = message.error as { data?: { category?: unknown }; message?: unknown } | undefined;
  if (error?.data?.category === "ERROR_UNKNOWN_TOOL" || error?.message === "ERROR_UNKNOWN_TOOL")
    return true;
  const result = message.result as
    | { isError?: boolean; content?: Array<{ text?: unknown }> }
    | undefined;
  if (!result?.isError || !Array.isArray(result.content)) return false;
  return result.content.some((item) => {
    if (typeof item.text !== "string") return false;
    try {
      return (JSON.parse(item.text) as { category?: unknown }).category === "ERROR_UNKNOWN_TOOL";
    } catch {
      return false;
    }
  });
}

interface ChildRuntime {
  artifact: ResolvedRuntime;
  process: ChildProcess;
  initialized: boolean;
  initializing: Promise<void> | null;
  initId: RequestId;
  initializingResponseIds: Set<RequestId>;
  initResolve: (() => void) | null;
  initReject: ((error: unknown) => void) | null;
  initializationRequestId: RequestId | undefined;
  pending: Map<RequestId, PendingRequest>;
  tools: Set<string> | null;
  dead: boolean;
}

function runtimeKey(artifact: Pick<ResolvedRuntime, "runtime_id" | "revision">): string {
  return `${artifact.runtime_id}\u0000${artifact.revision}`;
}

/**
 * MCP STDIO supervisor. The provider checkout is only used to resolve artifacts and read affinity;
 * every authority request is handled by a child launched from an immutable artifact.
 */
export class RuntimeSupervisor {
  readonly root: string;
  readonly providerRoot: string;
  readonly options: RuntimeSupervisorOptions;
  readonly defaultRuntime: ResolvedRuntime;
  private readonly store;
  private readonly diagnostics: DiagnosticRecorder;
  private readonly children = new Map<string, ChildRuntime>();
  private readonly initializationLines: string[] = [];
  private initialized = false;
  private inputChain = Promise.resolve();

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.options = options;
    this.root = repositoryRoot(options.repositoryRoot ?? process.cwd());
    this.providerRoot = repositoryRoot(
      options.providerRoot ?? process.env.WORKFLOW_MCP_PROVIDER_ROOT ?? this.root,
    );
    if (this.providerRoot !== this.root) {
      throw runtimeFailure(
        "ERROR_RUNTIME_ISOLATION",
        "supervised and provider repository roots do not match",
      );
    }
    this.defaultRuntime = resolveCurrentRuntime({
      ...options,
      providerRoot: this.providerRoot,
    });
    this.diagnostics =
      options.diagnostics ??
      createDiagnosticRecorder("supervisor", this.root, {
        directory: options.diagnosticsDirectory,
      });
    this.store = openStore({
      repositoryRoot: this.root,
      databasePath:
        options.databasePath ?? process.env.WORKFLOW_MCP_DB_PATH ?? resolveStatePath(this.root),
      runtimeId: this.defaultRuntime.runtime_id,
      runtimeRevision: this.defaultRuntime.revision,
      diagnostics: createDiagnosticRecorder("supervisor-store", this.root, {
        directory: options.diagnosticsDirectory,
      }),
    });
  }

  close(): void {
    for (const child of this.children.values()) {
      child.dead = true;
      child.process.kill();
    }
    this.children.clear();
    this.store.close();
  }

  private childError(_child: ChildRuntime, detail: string): WorkflowError {
    return runtimeFailure("ERROR_RUNTIME_RECOVERY", detail);
  }

  private emitRequestError(id: RequestId, error: WorkflowError): void {
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error.category,
          data: { category: error.category, detail: error.detail },
        },
      })}\n`,
    );
  }

  private failChild(child: ChildRuntime, detail: string): void {
    if (child.dead) return;
    child.dead = true;
    const key = runtimeKey(child.artifact);
    if (this.children.get(key) === child) this.children.delete(key);
    const error = this.childError(child, detail);
    for (const pending of child.pending.values()) this.emitRequestError(pending.id, error);
    child.pending.clear();
    const rejectInitialization = child.initReject;
    child.initializingResponseIds.clear();
    child.initializing = null;
    child.initResolve = null;
    child.initReject = null;
    child.initializationRequestId = undefined;
    rejectInitialization?.(error);
  }

  private launch(artifact: ResolvedRuntime): ChildRuntime {
    let runtimeAttestationNonce: string;
    let runtimeAttestation: string;
    try {
      const key = readFileSync(artifact.attestationKeyPath);
      runtimeAttestationNonce = randomBytes(32).toString("hex");
      runtimeAttestation = createRuntimeAttestation(
        artifact.runtime_id,
        artifact.revision,
        runtimeAttestationNonce,
        key,
      );
    } catch (error) {
      throw runtimeFailure(
        "ERROR_RUNTIME_RECOVERY",
        error instanceof Error ? error.message : "runtime attestation could not be created",
      );
    }
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      WORKFLOW_MCP_RUNTIME_ID: artifact.runtime_id,
      WORKFLOW_MCP_RUNTIME_REVISION: artifact.revision,
      WORKFLOW_MCP_RUNTIME_ATTESTATION: runtimeAttestation,
      WORKFLOW_MCP_RUNTIME_ATTESTATION_NONCE: runtimeAttestationNonce,
      ...(this.options.databasePath ? { WORKFLOW_MCP_DB_PATH: this.options.databasePath } : {}),
    };
    delete environment.WORKFLOW_MCP_RUNTIME_ATTESTATION_KEY_PATH;
    let child: ChildProcess;
    try {
      child = spawn(
        this.options.bunExecutable ?? process.execPath,
        ["--no-warnings", artifact.runtimePath],
        {
          cwd: this.root,
          env: environment,
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
    } catch (error) {
      throw runtimeFailure(
        "ERROR_RUNTIME_RECOVERY",
        error instanceof Error ? error.message : "runtime process could not be launched",
      );
    }
    const runtime: ChildRuntime = {
      artifact,
      process: child,
      initialized: false,
      initializing: null,
      initId: null,
      initializingResponseIds: new Set(),
      initResolve: null,
      initReject: null,
      initializationRequestId: undefined,
      pending: new Map(),
      tools: null,
      dead: false,
    };
    const lines = createInterface({ input: childOutput(child) });
    lines.on("line", (line) => {
      let message: JsonRpcMessage | null = null;
      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        // Preserve the existing protocol passthrough behavior for non-JSON child output.
      }
      if (message && message.id !== undefined && runtime.initializingResponseIds.has(message.id)) {
        runtime.initializingResponseIds.delete(message.id);
        const failed = message.error !== undefined;
        const reject = runtime.initReject;
        const resolve = runtime.initResolve;
        runtime.initReject = null;
        runtime.initResolve = null;
        if (failed) {
          reject?.(this.childError(runtime, "owning runtime initialization was rejected"));
        } else {
          resolve?.();
        }
        return;
      }
      if (
        message &&
        message.id !== undefined &&
        message.result &&
        typeof message.result === "object" &&
        !Array.isArray(message.result) &&
        "tools" in message.result &&
        Array.isArray((message.result as { tools?: unknown }).tools)
      ) {
        runtime.tools = new Set(
          (message.result as { tools: Array<{ name?: unknown }> }).tools
            .map((tool) => tool.name)
            .filter((name): name is string => typeof name === "string"),
        );
      }
      const pending = message?.id === undefined ? undefined : runtime.pending.get(message.id);
      if (message && message.id !== undefined) {
        runtime.pending.delete(message.id);
        if (
          pending &&
          unknownToolResponse(message) &&
          pending.message.params?.name === "workflow_adopt_dirty_scope"
        ) {
          try {
            const result = this.store.adoptDirtyScopeCrossRuntime(
              pending.message.params.arguments ?? {},
            );
            process.stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: directToolResult(result) })}\n`,
            );
          } catch (error) {
            const category =
              error instanceof WorkflowError ? error.category : "ERROR_RUNTIME_RECOVERY";
            const detail =
              error instanceof WorkflowError ? error.detail : "dirty adoption fallback failed";
            process.stdout.write(
              `${JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                error: { code: -32000, message: category, data: { category, detail } },
              })}\n`,
            );
          }
          return;
        }
        if (message.id === runtime.initializationRequestId && message.error === undefined) {
          runtime.initialized = true;
        }
        if (message.id === runtime.initializationRequestId)
          runtime.initializationRequestId = undefined;
      }
      if (!message) {
        process.stdout.write(`${line}\n`);
      } else {
        const output = pending
          ? augmentHistoricalParentRecovery(
              pending.message,
              message,
              runtimeKey(runtime.artifact) !== runtimeKey(this.defaultRuntime),
            )
          : message;
        process.stdout.write(`${output === message ? line : JSON.stringify(output)}\n`);
      }
    });
    child.on("error", (error) => {
      this.failChild(
        runtime,
        error instanceof Error ? error.message : "runtime process could not be launched",
      );
    });
    child.on("exit", (code, signal) => {
      lines.close();
      this.failChild(
        runtime,
        `runtime process exited before completing the request${code === null ? ` (${signal ?? "unknown signal"})` : ` (code ${code})`}`,
      );
    });
    child.on("close", (code, signal) => {
      lines.close();
      this.failChild(
        runtime,
        `runtime process closed before completing the request${code === null ? ` (${signal ?? "unknown signal"})` : ` (code ${code})`}`,
      );
    });
    return runtime;
  }

  private childFor(artifact: ResolvedRuntime): ChildRuntime {
    const key = runtimeKey(artifact);
    const existing = this.children.get(key);
    if (existing && !existing.dead && !existing.process.killed) return existing;
    const child = this.launch(artifact);
    this.children.set(key, child);
    return child;
  }

  private async initializeOwner(child: ChildRuntime): Promise<void> {
    if (child.initialized) return;
    if (child.initializing) return child.initializing;
    if (!this.initialized || this.initializationLines.length === 0) {
      // The first request is always initialize and is forwarded normally to the default child.
      child.initialized = true;
      return;
    }
    const initLine = this.initializationLines.find((line) => {
      try {
        return (JSON.parse(line) as JsonRpcMessage).method === "initialize";
      } catch {
        return false;
      }
    });
    if (!initLine)
      throw runtimeFailure("ERROR_RUNTIME_RECOVERY", "MCP initialization context is unavailable");
    const init = JSON.parse(initLine) as JsonRpcMessage;
    const internal = child;
    internal.initId = init.id ?? null;
    internal.initializingResponseIds.add(internal.initId);
    child.initializing = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(runtimeFailure("ERROR_RUNTIME_RECOVERY", "owning runtime initialization timed out"));
      }, 30_000);
      internal.initResolve = () => {
        clearTimeout(timer);
        for (const notification of this.initializationLines.filter((value) => value !== initLine)) {
          childInput(child.process).write(`${notification}\n`);
        }
        child.initialized = true;
        resolve();
      };
      internal.initReject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
      childInput(child.process).write(`${initLine}\n`);
    });
    try {
      await child.initializing;
    } finally {
      child.initializingResponseIds.clear();
      child.initId = null;
      child.initResolve = null;
      child.initReject = null;
      child.initializing = null;
    }
  }

  private affinityFor(message: JsonRpcMessage): { artifact: ResolvedRuntime; adopted: boolean } {
    if (isCommitReconciliation(message)) return { artifact: this.defaultRuntime, adopted: false };
    const workflowId = message.params?.arguments?.workflow_id;
    if (typeof workflowId !== "string") return { artifact: this.defaultRuntime, adopted: false };
    if (
      message.method === "tools/call" &&
      message.params?.name === "workflow_parent_get" &&
      this.store.isCrossRuntimeCommitReconciled(workflowId)
    ) {
      return { artifact: this.defaultRuntime, adopted: false };
    }
    let affinity = this.store.runtimeAffinity(workflowId);
    let adopted = false;
    if (affinity.runtime_id === null && affinity.runtime_revision === null) {
      affinity = this.store.adoptRuntime(workflowId);
      adopted = true;
    }
    if (
      affinity.runtime_id === this.defaultRuntime.runtime_id &&
      affinity.runtime_revision === this.defaultRuntime.revision
    )
      return { artifact: this.defaultRuntime, adopted };
    return { artifact: resolveOwningRuntime(this.providerRoot, affinity, this.options), adopted };
  }

  private adoptedRequest(message: JsonRpcMessage, adopted: boolean): string {
    if (!adopted) return JSON.stringify(message);
    const args = message.params?.arguments;
    if (!args || typeof args.expected_version !== "number") return JSON.stringify(message);
    args.expected_version += 1;
    return JSON.stringify(message);
  }

  private async forward(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    const workflowId = message.params?.arguments?.workflow_id;
    this.diagnostics.record({
      event: "request_receipt",
      request_id: message.id,
      method: message.method,
      tool: message.params?.name,
      workflow_id: workflowId,
      outcome: "received",
    });
    try {
      const affinity = withDiagnosticRequest(
        { request_id: message.id, method: message.method, tool: message.params?.name },
        () => this.affinityFor(message),
      );
      const artifact = affinity.artifact;
      this.diagnostics.record({
        event: "affinity_result",
        request_id: message.id,
        method: message.method,
        tool: message.params?.name,
        workflow_id: workflowId,
        adopted: affinity.adopted,
        selected_runtime: artifact.runtime_id.slice(0, 12),
        runtime_revision: artifact.revision,
        outcome: "resolved",
      });
      const child = this.childFor(artifact);
      const historicalOwner = runtimeKey(artifact) !== runtimeKey(this.defaultRuntime);
      const tool = message.params?.name;
      if (historicalOwner && tool === "workflow_resume_review") {
        if (this.store.pendingDirtyScope(workflowId)) {
          this.store.verifyPendingDirtyScope(workflowId);
        }
      }
      if (historicalOwner && tool === "workflow_begin_review") {
        if (this.store.pendingDirtyScope(workflowId)) {
          const result = this.store.beginReviewCrossRuntime(message.params?.arguments ?? {});
          if (message.id !== undefined) {
            process.stdout.write(
              `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: directToolResult(result) })}\n`,
            );
          }
          return;
        }
      }
      if (
        historicalOwner &&
        tool === "workflow_adopt_dirty_scope" &&
        child.tools !== null &&
        !child.tools.has("workflow_adopt_dirty_scope")
      ) {
        const result = this.store.adoptDirtyScopeCrossRuntime(message.params?.arguments ?? {});
        if (message.id !== undefined) {
          process.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: directToolResult(result) })}\n`,
          );
        }
        return;
      }
      const isInitialize = message.method === "initialize";
      if (
        this.initialized &&
        message.method !== "initialize" &&
        message.method !== "notifications/initialized" &&
        !child.initialized &&
        child.initializationRequestId === undefined
      ) {
        await this.initializeOwner(child);
      }
      if (message.id !== undefined) {
        child.pending.set(message.id, { id: message.id, message });
      }
      if (!child.process.stdin || child.dead)
        throw runtimeFailure("ERROR_RUNTIME_RECOVERY", "runtime process is unavailable");
      if (isInitialize) {
        child.initializationRequestId = message.id;
        this.initializationLines.push(line);
        this.initialized = true;
      } else if (message.method === "notifications/initialized") {
        this.initializationLines.push(line);
      }
      childInput(child.process).write(`${this.adoptedRequest(message, affinity.adopted)}\n`);
      this.diagnostics.record({
        event: "child_forward",
        request_id: message.id,
        method: message.method,
        tool: message.params?.name,
        workflow_id: workflowId,
        selected_runtime: artifact.runtime_id.slice(0, 12),
        runtime_revision: artifact.revision,
        outcome: "forwarded",
      });
    } catch (error) {
      if (message.id === undefined) return;
      const detail = error instanceof WorkflowError ? error.detail : "runtime request failed";
      const category = error instanceof WorkflowError ? error.category : "ERROR_RUNTIME_RECOVERY";
      this.diagnostics.record({
        event: "routing_error",
        request_id: message.id,
        method: message.method,
        tool: message.params?.name,
        workflow_id: workflowId,
        error_category: category,
        outcome: "error",
      });
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: category, data: { category, detail } },
        })}\n`,
      );
    }
  }

  run(): void {
    const input = createInterface({ input: process.stdin });
    input.on("line", (line) => {
      this.inputChain = this.inputChain
        .then(() => this.forward(line))
        .catch((error) => {
          process.stderr.write(
            `${error instanceof Error ? error.message : "runtime supervisor failed"}\n`,
          );
          process.exitCode = 1;
        });
    });
    input.on("close", () => {
      void this.inputChain.finally(() => this.close());
    });
  }
}

export function main(options: RuntimeSupervisorOptions = {}): void {
  const supervisor = new RuntimeSupervisor(options);
  process.once("SIGINT", () => supervisor.close());
  process.once("SIGTERM", () => supervisor.close());
  supervisor.run();
}
