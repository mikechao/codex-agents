import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { WorkflowError } from "./errors.js";
import { currentHead } from "./git.js";
import {
  materializeRuntimeArtifact,
  type RuntimeArtifact,
  type RuntimeArtifactOptions,
} from "./runtime-artifact.js";
import { openStore, type RuntimeAffinity, resolveStatePath } from "./store.js";

export interface RuntimeSupervisorOptions extends RuntimeArtifactOptions {
  repositoryRoot?: string;
  /** Repository whose committed runtime is trusted (the provider checkout). */
  providerRoot?: string;
  databasePath?: string;
  bunExecutable?: string;
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
  params?: { arguments?: Record<string, unknown> };
  error?: unknown;
}

type RequestId = string | number | null;

interface PendingRequest {
  id: RequestId;
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
  dead: boolean;
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
  private readonly children = new Map<string, ChildRuntime>();
  private readonly initializationLines: string[] = [];
  private initialized = false;
  private inputChain = Promise.resolve();

  constructor(options: RuntimeSupervisorOptions = {}) {
    this.options = options;
    this.root = options.repositoryRoot ?? process.cwd();
    this.providerRoot = options.providerRoot ?? process.env.WORKFLOW_MCP_PROVIDER_ROOT ?? this.root;
    this.defaultRuntime = resolveCurrentRuntime({
      ...options,
      providerRoot: this.providerRoot,
    });
    this.store = openStore({
      repositoryRoot: this.root,
      databasePath:
        options.databasePath ?? process.env.WORKFLOW_MCP_DB_PATH ?? resolveStatePath(this.root),
      runtimeId: this.defaultRuntime.runtime_id,
      runtimeRevision: this.defaultRuntime.revision,
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
    if (this.children.get(child.artifact.runtime_id) === child)
      this.children.delete(child.artifact.runtime_id);
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
    const environment = {
      ...process.env,
      WORKFLOW_MCP_RUNTIME_ID: artifact.runtime_id,
      WORKFLOW_MCP_RUNTIME_REVISION: artifact.revision,
      ...(this.options.databasePath ? { WORKFLOW_MCP_DB_PATH: this.options.databasePath } : {}),
    };
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
      if (message && message.id !== undefined) {
        runtime.pending.delete(message.id);
        if (message.id === runtime.initializationRequestId && message.error === undefined) {
          runtime.initialized = true;
        }
        if (message.id === runtime.initializationRequestId)
          runtime.initializationRequestId = undefined;
      }
      process.stdout.write(`${line}\n`);
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
    const existing = this.children.get(artifact.runtime_id);
    if (existing && !existing.dead && !existing.process.killed) return existing;
    const child = this.launch(artifact);
    this.children.set(artifact.runtime_id, child);
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

  private affinityFor(message: JsonRpcMessage): ResolvedRuntime {
    const workflowId = message.params?.arguments?.workflow_id;
    if (typeof workflowId !== "string") return this.defaultRuntime;
    let affinity = this.store.runtimeAffinity(workflowId);
    if (affinity.runtime_id === null && affinity.runtime_revision === null) {
      affinity = this.store.adoptRuntime(workflowId);
    }
    if (
      affinity.runtime_id === this.defaultRuntime.runtime_id &&
      affinity.runtime_revision === this.defaultRuntime.revision
    )
      return this.defaultRuntime;
    return resolveOwningRuntime(this.providerRoot, affinity, this.options);
  }

  private async forward(line: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      process.stdout.write(`${line}\n`);
      return;
    }
    try {
      const artifact = this.affinityFor(message);
      const child = this.childFor(artifact);
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
        child.pending.set(message.id, { id: message.id });
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
      childInput(child.process).write(`${line}\n`);
    } catch (error) {
      if (message.id === undefined) return;
      const detail = error instanceof WorkflowError ? error.detail : "runtime request failed";
      const category = error instanceof WorkflowError ? error.category : "ERROR_RUNTIME_RECOVERY";
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
