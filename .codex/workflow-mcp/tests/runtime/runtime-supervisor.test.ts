import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { currentHead } from "../../git.js";
import { materializeRuntimeArtifact } from "../../runtime-artifact.js";
import { RuntimeSupervisor } from "../../runtime-supervisor.js";
import { createRuntimeAttestation, WorkflowStore } from "../../store.js";
import {
  annotateFixtureFailure,
  type FixtureDiagnosticContext,
  fixture,
  fixtureDiagnostic,
} from "../test-fixtures.js";

function runtimeChildContext(
  child: ReturnType<typeof spawn> | undefined,
  role: string,
): FixtureDiagnosticContext["child"] {
  if (!child) return undefined;
  return {
    pid: child.pid,
    role,
    live: child.exitCode === null && child.signalCode === null,
    killed: child.killed,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
}

function runtimeDiagnostic(
  root: string,
  stage: string,
  operation: string,
  child: ReturnType<typeof spawn> | undefined,
  role: string,
  cleanupStarted: boolean,
): string {
  return fixtureDiagnostic(root, {
    stage,
    operation,
    cleanupStarted,
    child: runtimeChildContext(child, role),
  });
}

function removeRuntimeFixture(
  root: string,
  stage: string,
  child: ReturnType<typeof spawn> | undefined,
  role: string,
): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    throw annotateFixtureFailure(error, root, {
      stage,
      operation: "repository removal",
      cleanupStarted: true,
      child: runtimeChildContext(child, role),
    });
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} remained alive after initialization failure cleanup`);
}

function fixtureHead(root: string, stage: string): string {
  try {
    return currentHead(root);
  } catch (error) {
    throw annotateFixtureFailure(error, root, {
      stage,
      operation: "HEAD-dependent currentHead operation",
      cleanupStarted: false,
    });
  }
}

const MAX_CHILD_DIAGNOSTIC_TEXT = 4_000;
const MAX_CHILD_DIAGNOSTIC_LINES = 8;
const MAX_CHILD_DIAGNOSTIC_LINE = 512;
const MAX_CHILD_RESPONSE_LINE = 64 * 1024;
const MAX_CLEANUP_FAILURES = 8;
const BOOTSTRAP_CLOSE_TIMEOUT = 2_000;

type ChildRequestDescriptor = {
  id: string | number;
  stage: string;
  method: string;
  tool?: string;
};

type ChildOutputEvidence = {
  stderr: string;
  stderrTruncated: boolean;
  malformed: string[];
  malformedCount: number;
  malformedTruncated: boolean;
  unmatched: string[];
  unmatchedCount: number;
  unmatchedTruncated: boolean;
};

type ChildLifecycle = {
  event: "error" | "exit" | "close";
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: unknown;
};

type ChildRequestHarness = {
  child: ReturnType<typeof spawn>;
  role: string;
  request: (message: Record<string, unknown>, descriptor: ChildRequestDescriptor) => Promise<any>;
  stop: (closeTimeout?: number) => Promise<void>;
  diagnostics: () => string;
  readonly stderr: string;
};

function extendChildHarness<T extends object>(harness: ChildRequestHarness, methods: T) {
  return {
    ...harness,
    ...methods,
    get stderr() {
      return harness.stderr;
    },
  };
}

function appendBoundedText(current: string, value: string): [string, boolean] {
  if (current.length >= MAX_CHILD_DIAGNOSTIC_TEXT) return [current, true];
  const remaining = MAX_CHILD_DIAGNOSTIC_TEXT - current.length;
  if (value.length <= remaining) return [current + value, false];
  return [`${current}${value.slice(0, remaining)}`, true];
}

function recordBoundedLine(lines: string[], line: string, lineTruncated = false): boolean {
  if (lines.length >= MAX_CHILD_DIAGNOSTIC_LINES) return true;
  lines.push(line.slice(0, MAX_CHILD_DIAGNOSTIC_LINE));
  return lineTruncated || line.length > MAX_CHILD_DIAGNOSTIC_LINE;
}

function childProcessState(child: ReturnType<typeof spawn>, lifecycle?: ChildLifecycle): string {
  const stdin = child.stdin as (typeof child.stdin & { writableEnded?: boolean }) | null;
  const stdout = child.stdout as (typeof child.stdout & { readableEnded?: boolean }) | null;
  const state = {
    pid: child.pid ?? null,
    live: child.exitCode === null && child.signalCode === null,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    killed: child.killed,
    stdin: stdin
      ? {
          destroyed: stdin.destroyed,
          writableEnded: stdin.writableEnded ?? null,
          writableFinished: stdin.writableFinished ?? null,
        }
      : null,
    stdout: stdout
      ? {
          destroyed: stdout.destroyed,
          readableEnded: stdout.readableEnded ?? null,
        }
      : null,
    lifecycle: lifecycle
      ? {
          event: lifecycle.event,
          exitCode: lifecycle.code ?? null,
          signalCode: lifecycle.signal ?? null,
          error: lifecycle.error ? boundedCleanupError(lifecycle.error) : undefined,
        }
      : null,
  };
  return JSON.stringify(state);
}

function childEvidenceText(evidence: ChildOutputEvidence): string {
  const lines = (label: string, values: string[], count: number, truncated: boolean) =>
    `${label}=${count}${values.length ? ` [${values.join(" | ")}]` : ""}${truncated ? " (truncated)" : ""}`;
  return [
    `stderr=${JSON.stringify(evidence.stderr)}${evidence.stderrTruncated ? " (truncated)" : ""}`,
    lines(
      "malformedStdout",
      evidence.malformed,
      evidence.malformedCount,
      evidence.malformedTruncated,
    ),
    lines(
      "unmatchedStdout",
      evidence.unmatched,
      evidence.unmatchedCount,
      evidence.unmatchedTruncated,
    ),
  ].join(" ");
}

function childRequestDescription(descriptor: ChildRequestDescriptor): string {
  return `request=${descriptor.id} stage=${descriptor.stage} method=${descriptor.method}${
    descriptor.tool ? ` tool=${descriptor.tool}` : ""
  }`;
}

function isJsonRpcNotification(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  return message.jsonrpc === "2.0" && typeof message.method === "string" && !("id" in message);
}

function isJsonRpcResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (response.jsonrpc !== "2.0" || !("id" in response)) return false;
  const id = response.id;
  if (id !== null && typeof id !== "string" && !(typeof id === "number" && Number.isFinite(id)))
    return false;
  const hasResult = "result" in response;
  const hasError = "error" in response;
  if (hasResult === hasError) return false;
  if (!hasError) return true;
  const error = response.error;
  return (
    error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    typeof (error as Record<string, unknown>).code === "number" &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

type CleanupFailure = { operation: string; error: unknown };

type CleanupCollector = {
  failures: CleanupFailure[];
  truncated: number;
};

function createCleanupCollector(): CleanupCollector {
  return { failures: [], truncated: 0 };
}

async function collectCleanup(
  collector: CleanupCollector,
  operation: string,
  action: () => unknown | Promise<unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (collector.failures.length < MAX_CLEANUP_FAILURES) {
      collector.failures.push({ operation, error });
    } else {
      collector.truncated += 1;
    }
  }
}

function boundedCleanupError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length <= MAX_CHILD_DIAGNOSTIC_TEXT
    ? text
    : `${text.slice(0, MAX_CHILD_DIAGNOSTIC_TEXT)}… (truncated)`;
}

function retainCleanupFailures(primary: unknown, collector: CleanupCollector): void {
  if (collector.failures.length === 0 && collector.truncated === 0) return;
  const details = collector.failures.map(
    ({ operation, error }) =>
      `secondary cleanup failure (${operation}): ${boundedCleanupError(error)}`,
  );
  if (collector.truncated > 0) {
    details.push(`secondary cleanup failures truncated=${collector.truncated}`);
  }
  const message = details.join("\n");
  if (primary instanceof Error) {
    primary.message = `${primary.message}\n${message}`;
    return;
  }
  const failures = collector.failures.map(({ error }) => error);
  if (primary !== undefined) failures.unshift(primary);
  throw new AggregateError(failures, message);
}

const terminatedBootstrapGroups = new WeakSet<ReturnType<typeof spawn>>();

async function killBootstrapProcessGroup(child: ReturnType<typeof spawn>): Promise<void> {
  if (terminatedBootstrapGroups.has(child)) return;
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("bootstrap shell exit timed out")),
            BOOTSTRAP_CLOSE_TIMEOUT,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  try {
    if (process.platform !== "win32" && child.pid !== undefined)
      process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  terminatedBootstrapGroups.add(child);
}

async function stopBootstrapChild(
  child: ReturnType<typeof spawn>,
  harness: ChildRequestHarness,
  failed: boolean,
  closeTimeout = BOOTSTRAP_CLOSE_TIMEOUT,
): Promise<void> {
  const cleanup = createCleanupCollector();
  if (failed) {
    await collectCleanup(cleanup, "bootstrap process group kill", () =>
      killBootstrapProcessGroup(child),
    );
  }
  await collectCleanup(cleanup, "bootstrap child stop", () => harness.stop(closeTimeout));
  if (cleanup.failures.some(({ operation }) => operation === "bootstrap child stop")) {
    await collectCleanup(cleanup, "bootstrap process group kill after stop", () =>
      killBootstrapProcessGroup(child),
    );
    await collectCleanup(cleanup, "bootstrap stdout close", () => child.stdout?.destroy());
    await collectCleanup(cleanup, "bootstrap stderr close", () => child.stderr?.destroy());
  }
  retainCleanupFailures(undefined, cleanup);
}

type CappedStdoutReader = {
  close: () => void;
  bufferedEvidence: () => { text: string; truncated: boolean };
};

function createCappedStdoutReader(
  stream: NonNullable<ReturnType<typeof spawn>["stdout"]>,
  onLine: (line: string, truncated: boolean) => void,
): CappedStdoutReader {
  let buffer = "";
  let truncated = false;
  let closed = false;
  let flushed = false;
  const decoder = new StringDecoder("utf8");

  const emitLine = () => {
    onLine(buffer, truncated);
    buffer = "";
    truncated = false;
  };
  const processText = (text: string) => {
    let offset = 0;
    while (offset < text.length) {
      const newline = text.indexOf("\n", offset);
      const segment = newline >= 0 ? text.slice(offset, newline) : text.slice(offset);
      if (!truncated) {
        const remaining = MAX_CHILD_RESPONSE_LINE - buffer.length;
        if (segment.length > remaining) {
          buffer += segment.slice(0, remaining);
          truncated = true;
        } else {
          buffer += segment;
        }
      }
      if (newline < 0) break;
      emitLine();
      offset = newline + 1;
    }
  };
  const onData = (chunk: unknown) => {
    if (closed) return;
    processText(decoder.write(chunk instanceof Buffer ? chunk : Buffer.from(String(chunk))));
  };
  const flush = () => {
    if (flushed) return;
    flushed = true;
    processText(decoder.end());
    if (buffer || truncated) emitLine();
  };
  const onEnd = () => flush();
  stream.on("data", onData);
  stream.on("end", onEnd);

  return {
    close: () => {
      if (closed) return;
      closed = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      flush();
    },
    bufferedEvidence: () => ({
      text: buffer.slice(0, MAX_CHILD_DIAGNOSTIC_LINE),
      truncated: truncated || buffer.length > MAX_CHILD_DIAGNOSTIC_LINE,
    }),
  };
}

function createChildRequestHarness(
  child: ReturnType<typeof spawn>,
  role: string,
  root: string,
  teardownStage: string,
  requestTimeout = 10_000,
): ChildRequestHarness {
  const closePromise = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const evidence: ChildOutputEvidence = {
    stderr: "",
    stderrTruncated: false,
    malformed: [],
    malformedCount: 0,
    malformedTruncated: false,
    unmatched: [],
    unmatchedCount: 0,
    unmatchedTruncated: false,
  };
  const pending = new Map<
    string | number,
    {
      descriptor: ChildRequestDescriptor;
      resolve: (value: any) => void;
      reject: (error: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  let lifecycle: ChildLifecycle | undefined;
  let stopPromise: Promise<void> | undefined;
  const stderrDecoder = new StringDecoder("utf8");
  let stderrFlushed = false;
  const appendStderr = (value: string) => {
    if (!value) return;
    const [stderr, truncated] = appendBoundedText(evidence.stderr, value);
    evidence.stderr = stderr;
    evidence.stderrTruncated ||= truncated;
  };
  const flushStderr = () => {
    if (stderrFlushed) return;
    stderrFlushed = true;
    appendStderr(stderrDecoder.end());
  };

  child.stderr?.on("data", (chunk) => {
    appendStderr(stderrDecoder.write(chunk instanceof Buffer ? chunk : Buffer.from(String(chunk))));
  });
  child.stderr?.on("end", flushStderr);

  let stdoutReader: CappedStdoutReader | undefined;
  const diagnostics = () => {
    const partial = stdoutReader?.bufferedEvidence();
    return `${childProcessState(child, lifecycle)} ${childEvidenceText(evidence)}${
      partial && (partial.text || partial.truncated)
        ? ` partialStdout=${JSON.stringify(partial.text)}${partial.truncated ? " (truncated)" : ""}`
        : ""
    }`;
  };

  const recordStdoutLine = (rawLine: string, lineTruncated = false) => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (lineTruncated) {
      evidence.malformedCount += 1;
      evidence.malformedTruncated =
        recordBoundedLine(evidence.malformed, line, true) || evidence.malformedTruncated;
      return undefined;
    }
    let response: any;
    try {
      response = JSON.parse(line);
    } catch {
      evidence.malformedCount += 1;
      evidence.malformedTruncated =
        recordBoundedLine(evidence.malformed, line) || evidence.malformedTruncated;
      return undefined;
    }
    if (isJsonRpcNotification(response)) return undefined;
    if (!isJsonRpcResponse(response)) {
      evidence.malformedCount += 1;
      evidence.malformedTruncated =
        recordBoundedLine(evidence.malformed, line) || evidence.malformedTruncated;
      return undefined;
    }
    if (!pending.has(response.id)) {
      evidence.unmatchedCount += 1;
      evidence.unmatchedTruncated =
        recordBoundedLine(evidence.unmatched, line) || evidence.unmatchedTruncated;
    }
    return response;
  };

  stdoutReader = createCappedStdoutReader(child.stdout!, (line, truncated) => {
    const response = recordStdoutLine(line, truncated);
    if (response !== undefined) {
      const entry = pending.get(response.id);
      if (entry) {
        clearTimeout(entry.timeout);
        pending.delete(response.id);
        entry.resolve(response);
      }
    }
  });

  const rejection = (descriptor: ChildRequestDescriptor, reason: string, cause?: unknown) => {
    const error = new Error(
      `${childRequestDescription(descriptor)} ${reason}; ${diagnostics()}`,
      cause === undefined ? undefined : { cause },
    );
    return error;
  };

  const rejectPending = (nextLifecycle: ChildLifecycle) => {
    lifecycle ??= nextLifecycle;
    if (pending.size === 0) return;
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeout);
      pending.delete(id);
      const lifecycleText =
        lifecycle.event === "error"
          ? "child emitted error"
          : `child ${lifecycle.event} (exitCode=${lifecycle.code ?? "null"}, signalCode=${lifecycle.signal ?? "null"})`;
      entry.reject(rejection(entry.descriptor, lifecycleText, lifecycle.error));
    }
  };

  child.on("error", (error) => {
    lifecycle ??= { event: "error", error };
  });
  child.on("exit", (code, signal) => {
    lifecycle ??= { event: "exit", code, signal };
  });
  child.on("close", (code, signal) => {
    stdoutReader?.close();
    flushStderr();
    rejectPending({ event: "close", code, signal });
  });

  const request = (message: Record<string, unknown>, descriptor: ChildRequestDescriptor) =>
    new Promise<any>((resolve, reject) => {
      if (pending.has(descriptor.id)) {
        reject(rejection(descriptor, "duplicate pending request id"));
        return;
      }
      if (lifecycle || child.exitCode !== null || child.signalCode !== null) {
        reject(
          rejection(
            descriptor,
            lifecycle?.event === "error"
              ? "child is unavailable after error"
              : `child is unavailable (exitCode=${child.exitCode ?? "null"}, signalCode=${child.signalCode ?? "null"})`,
            lifecycle?.error,
          ),
        );
        return;
      }
      const timeout = setTimeout(() => {
        const entry = pending.get(descriptor.id);
        if (!entry) return;
        pending.delete(descriptor.id);
        reject(rejection(descriptor, "timed out"));
      }, requestTimeout);
      pending.set(descriptor.id, { descriptor, resolve, reject, timeout });
      try {
        child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => {
          if (!error) return;
          const entry = pending.get(descriptor.id);
          if (!entry) return;
          clearTimeout(entry.timeout);
          pending.delete(descriptor.id);
          reject(rejection(descriptor, "write failed", error));
        });
      } catch (error) {
        const entry = pending.get(descriptor.id);
        if (!entry) return;
        clearTimeout(entry.timeout);
        pending.delete(descriptor.id);
        reject(rejection(descriptor, "write failed", error));
      }
    });

  const stop = async (closeTimeout?: number) => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        pending.delete(id);
        entry.reject(rejection(entry.descriptor, `${role} stopped`));
      }
      const cleanup = createCleanupCollector();
      await collectCleanup(cleanup, "child stdin end", () => {
        child.stdin?.end();
      });
      await collectCleanup(cleanup, "child close wait", async () => {
        if (closeTimeout === undefined) {
          await closePromise;
          return;
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closePromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("child close timed out")), closeTimeout);
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      });
      if (cleanup.failures.length > 0 || cleanup.truncated > 0) {
        const error = new AggregateError(
          cleanup.failures.map(({ error: failure }) => failure),
          cleanup.failures
            .map(
              ({ operation, error: failure }) =>
                `child shutdown failure (${operation}): ${boundedCleanupError(failure)}`,
            )
            .concat(
              cleanup.truncated > 0
                ? [`child shutdown failures truncated=${cleanup.truncated}`]
                : [],
            )
            .join("\n"),
        );
        const annotated = annotateFixtureFailure(error, root, {
          stage: teardownStage,
          operation: "runtime child shutdown",
          cleanupStarted: true,
          child: runtimeChildContext(child, role),
        });
        if (annotated instanceof Error)
          annotated.message = `${annotated.message}; ${diagnostics()}`;
        throw annotated;
      }
    })();
    return stopPromise;
  };

  return {
    child,
    role,
    request,
    stop,
    diagnostics,
    get stderr() {
      return evidence.stderr;
    },
  };
}

describe("Workflow MCP runtime supervision", () => {
  function attestation(runtimeId: string, revision: string) {
    const nonce = "1".repeat(64);
    const key = "2".repeat(64);
    return {
      runtimeAttestation: createRuntimeAttestation(runtimeId, revision, nonce, key),
      runtimeAttestationNonce: nonce,
      runtimeAttestationKey: key,
    };
  }

  function create(store: any, _root: string, revision: string, objective: string) {
    return store.create({
      workflow_type: "change",
      objective,
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: [
        { description: "validation", kind: "command", argv: ["bun", "run", "check"] },
      ],
      review_target: {
        review_mode: "working_tree",
        base_revision: revision,
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
  }

  test("bootstrap rejects a missing trusted provider root before launch", () => {
    const target = fixture();
    try {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      mkdirSync(workflowRoot, { recursive: true });
      cpSync(
        join(process.cwd(), ".codex/workflow-mcp/bootstrap.ts"),
        join(workflowRoot, "bootstrap.ts"),
      );

      let error: unknown;
      try {
        const env = { ...process.env };
        delete env.WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT;
        execFileSync(process.execPath, ["--no-warnings", join(workflowRoot, "bootstrap.ts")], {
          cwd: target.root,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        assert.fail("expected bootstrap to require a trusted provider root");
      } catch (caught) {
        error = caught;
      }

      assert.equal((error as { status?: number }).status, 1);
      assert.equal(String((error as { stdout?: string | Buffer }).stdout ?? ""), "");
      assert.match(
        String((error as { stderr?: string | Buffer }).stderr ?? ""),
        /WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT is required as the trusted provider root/u,
      );
    } finally {
      rmSync(target.root, { recursive: true, force: true });
    }
  });

  test("bootstrap rejects a provider from a different canonical repository", () => {
    const target = fixture();
    const provider = fixture();
    const workflowSource = join(process.cwd(), ".codex/workflow-mcp");
    try {
      cpSync(workflowSource, join(target.root, ".codex/workflow-mcp"), { recursive: true });
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
      git("add", ".");
      git("commit", "-qm", "bootstrap target");
      let error: unknown;
      try {
        execFileSync(
          process.execPath,
          ["--no-warnings", join(target.root, ".codex/workflow-mcp/bootstrap.ts")],
          {
            cwd: target.root,
            env: {
              ...process.env,
              WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT: provider.root,
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        assert.fail("expected bootstrap to reject a foreign provider");
      } catch (caught) {
        error = caught;
      }
      assert.match(
        String((error as { stderr?: string | Buffer }).stderr ?? ""),
        /roots do not match/u,
      );
    } finally {
      rmSync(target.root, { recursive: true, force: true });
      rmSync(provider.root, { recursive: true, force: true });
    }
  });

  test("routes workflows to their immutable runtime after promotion and restart", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-routing-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-routing-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const fakeServer = `
       import { createInterface } from "node:readline";
       const runtimeLabel = "current";
       createInterface({ input: process.stdin }).on("line", (line) => {
         const request = JSON.parse(line);
         if (request.id === undefined) return;
           const parentView = request.params?.name === "workflow_parent_get" ? {
              content: [{ type: "text", text: JSON.stringify({
                workflow_id: request.params?.arguments?.workflow_id,
                phase: runtimeLabel === "current" ? "COMMITTED" : "COMMIT_PREPARED",
               permitted_next_actions: [],
               runtime_label: runtimeLabel,
             }) }],
           } : {};
           const operatorDecision = request.params?.name === "workflow_operator_decision_get" ? {
             content: [{ type: "text", text: JSON.stringify({
               primary: runtimeLabel === "current" ? {
                 kind: "terminal",
                 outcome: "committed",
                 reason: "the workflow commit is verified and complete",
               } : null,
             }) }],
           } : {};
         process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
           runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
           runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
           expected_version: request.params?.arguments?.expected_version,
           method: request.method,
           tool: request.params?.name,
           ...parentView,
           ...operatorDecision,
         } }) + "\\n");
       });
     `;
    const historicalServer = fakeServer.replace(
      'const runtimeLabel = "current";',
      'const runtimeLabel = "historical";',
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const writeProvider = () => {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      mkdirSync(workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), historicalServer);
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(target.root, "package.json"),
        '{"name":"runtime-routing-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
    };
    const start = (bunExecutable?: string, role = "runtime-routing-child") => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)}; new RuntimeSupervisor(${JSON.stringify(
        {
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: false,
          ...(bunExecutable ? { bunExecutable } : {}),
        },
      )}).run();`;
      const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const harness = createChildRequestHarness(
        child,
        role,
        target.root,
        "runtime routing teardown",
      );
      const request = (
        id: number,
        method: string,
        workflowId?: string,
        args: any = {},
        tool?: string,
      ) =>
        harness.request(
          {
            jsonrpc: "2.0",
            id,
            method,
            ...(workflowId
              ? {
                  params: {
                    ...(tool ? { name: tool } : {}),
                    arguments: { workflow_id: workflowId, ...args },
                  },
                }
              : {}),
          },
          { id, stage: "runtime routing request", method, tool },
        );
      return extendChildHarness(harness, { request });
    };
    let active: ReturnType<typeof start> | undefined;
    let restarted: ReturnType<typeof start> | undefined;
    let secondStore: any;
    let primaryFailure: unknown;
    try {
      writeProvider();
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = fixtureHead(target.root, "runtime routing revision A");
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: false,
      });
      const firstStore: any = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactA.runtime_id,
        runtimeRevision: revisionA,
        ...attestation(artifactA.runtime_id, revisionA),
      });
      const workflowA = create(firstStore, target.root, revisionA, "runtime A");
      firstStore.close();
      active = start();
      assert.equal((await active.request(1, "initialize")).result.runtime_revision, revisionA);
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const routedA = await active.request(
        2,
        "tools/call",
        workflowA.workflow_id,
        {},
        "workflow_parent_get",
      );
      assert.equal(routedA.result.runtime_revision, revisionA);
      assert.equal(routedA.result.tool, "workflow_parent_get");
      writeFileSync(join(target.root, ".codex", "workflow-mcp", "server.ts"), fakeServer);
      writeFileSync(join(target.root, "runtime-b.txt"), "B\n");
      git("add", "runtime-b.txt", ".codex/workflow-mcp/server.ts");
      git(
        "commit",
        "-qm",
        "runtime B",
        "--",
        "note.txt",
        "runtime-b.txt",
        ".codex/workflow-mcp/server.ts",
      );
      await active.stop();
      active = undefined;
      const revisionB = fixtureHead(target.root, "runtime routing revision B");
      const artifactB = materializeRuntimeArtifact(target.root, revisionB, {
        cacheRoot,
        installDependencies: false,
      });
      assert.notEqual(artifactB.runtime_id, artifactA.runtime_id);
      assert.notEqual(artifactB.revision, artifactA.revision);
      secondStore = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactB.runtime_id,
        runtimeRevision: revisionB,
        ...attestation(artifactB.runtime_id, revisionB),
      });
      const workflowB = create(secondStore, target.root, revisionB, "runtime B");
      restarted = start();
      assert.equal((await restarted.request(3, "initialize")).result.runtime_revision, revisionB);
      restarted.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const routedB = await restarted.request(
        4,
        "tools/call",
        workflowB.workflow_id,
        {},
        "workflow_implementer_get",
      );
      assert.equal(routedB.result.runtime_revision, revisionB);
      assert.equal(routedB.result.tool, "workflow_implementer_get");
      const routedAAfterRestart = await restarted.request(
        5,
        "tools/call",
        workflowA.workflow_id,
        {},
        "workflow_parent_get",
      );
      assert.equal(routedAAfterRestart.result.runtime_revision, revisionA);
      assert.equal(routedAAfterRestart.result.tool, "workflow_parent_get");
      const historicalView = JSON.parse(routedAAfterRestart.result.content[0].text);
      assert.equal(historicalView.runtime_label, "historical");
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup = createCleanupCollector();
      await collectCleanup(cleanup, "second store close", () => secondStore?.close());
      for (const harness of [active, restarted]) {
        if (!harness) continue;
        await collectCleanup(cleanup, `${harness.role} stop`, () => harness.stop());
      }
      await collectCleanup(cleanup, "runtime routing fixture removal", () =>
        removeRuntimeFixture(
          target.root,
          "runtime routing fixture teardown",
          restarted?.child ?? active?.child,
          restarted?.role ?? active?.role ?? "runtime-routing-child",
        ),
      );
      await collectCleanup(cleanup, "runtime routing cache removal", () =>
        rmSync(cacheRoot, { recursive: true, force: true }),
      );
      await collectCleanup(cleanup, "runtime routing database removal", () =>
        rmSync(dirname(databasePath), { recursive: true, force: true }),
      );
      retainCleanupFailures(primaryFailure, cleanup);
    }
  });

  test("rejects pending child requests with bounded exit, signal, and output diagnostics", async () => {
    const runTermination = async (mode: "exit" | "signal") => {
      const child = spawn(
        process.execPath,
        [
          "--no-warnings",
          "-e",
          `process.stdin.resume(); process.stderr.write("child diagnostic\\n"); process.stdout.write("not-json\\n{}\\n[]\\n{\\"jsonrpc\\":\\"2.0\\",\\"result\\":{}}\\n{\\"id\\":1}\\n" + JSON.stringify({ jsonrpc: "2.0", id: 999, result: {} }) + "\\n", () => { ${mode === "exit" ? "process.exit(17);" : ""} });`,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const harness = createChildRequestHarness(
        child,
        `diagnostic-${mode}-child`,
        process.cwd(),
        `diagnostic ${mode} teardown`,
      );
      const outputSeen = (stream: NonNullable<typeof child.stdout>, marker: string) =>
        new Promise<void>((resolve) => {
          let text = "";
          const onData = (chunk: Buffer) => {
            text = `${text}${chunk.toString()}`.slice(-2_000);
            if (!text.includes(marker)) return;
            stream.off("data", onData);
            resolve();
          };
          stream.on("data", onData);
        });
      const stdoutSeen = outputSeen(child.stdout!, '"id":999');
      const stderrSeen = outputSeen(child.stderr!, "child diagnostic");
      try {
        const request = harness.request(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "diagnostic_tool" } },
          {
            id: 1,
            stage: "diagnostic child request",
            method: "tools/call",
            tool: "diagnostic_tool",
          },
        );
        if (mode === "signal") {
          await Promise.race([
            Promise.all([stdoutSeen, stderrSeen]),
            request.then(
              () => {
                throw new Error("diagnostic request resolved before signal");
              },
              (error: unknown) => {
                throw error;
              },
            ),
          ]);
          child.kill("SIGTERM");
        }
        await assert.rejects(request, (error: unknown) => {
          assert.match(
            String(error),
            /request=1 stage=diagnostic child request method=tools\/call tool=diagnostic_tool/u,
          );
          assert.match(String(error), /stderr=.*child diagnostic/u);
          assert.match(String(error), /malformedStdout=5/u);
          assert.match(String(error), /unmatchedStdout=1/u);
          assert.match(String(error), mode === "exit" ? /exitCode=17/u : /signalCode=SIGTERM/u);
          return true;
        });
      } finally {
        if (mode === "signal" && child.exitCode === null && child.signalCode === null)
          child.kill("SIGTERM");
        await harness.stop();
      }
    };

    await runTermination("exit");
    await runTermination("signal");
  });

  test("bounds unterminated oversized stdout evidence without resolving a request", async () => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        'process.stdout.write("x".repeat(100_000), () => setTimeout(() => process.exit(17), 40));',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const harness = createChildRequestHarness(
      child,
      "oversized-stdout-child",
      process.cwd(),
      "oversized stdout teardown",
    );
    try {
      await assert.rejects(
        harness.request(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oversized_tool" } },
          {
            id: 1,
            stage: "oversized stdout request",
            method: "tools/call",
            tool: "oversized_tool",
          },
        ),
        (error: unknown) => {
          assert.match(
            String(error),
            /request=1 stage=oversized stdout request method=tools\/call tool=oversized_tool/u,
          );
          assert.match(String(error), /exitCode=17/u);
          return true;
        },
      );
      await harness.stop();
      const diagnostics = harness.diagnostics();
      assert.match(diagnostics, /malformedStdout=1 \[x{512}\] \(truncated\)/u);
      assert.ok(diagnostics.length < 2_000);
    } finally {
      await harness.stop();
    }
  });

  test("keeps oversized unterminated stdout bounded while the child remains alive", async () => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        'process.stdin.resume(); process.stdin.on("end", () => process.exit(17)); process.stdout.write("x".repeat(100_000));',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const harness = createChildRequestHarness(
      child,
      "live-oversized-stdout-child",
      process.cwd(),
      "live oversized stdout teardown",
    );
    let settled = false;
    let bytes = 0;
    const outputSeen = new Promise<void>((resolve) =>
      child.stdout!.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes >= 100_000) resolve();
      }),
    );
    try {
      const request = harness
        .request(
          { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "oversized_tool" } },
          {
            id: 1,
            stage: "live oversized stdout request",
            method: "tools/call",
            tool: "oversized_tool",
          },
        )
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      await outputSeen;
      assert.equal(settled, false);
      assert.match(harness.diagnostics(), /partialStdout="x{512}" \(truncated\)/u);
      assert.ok(harness.diagnostics().length < 2_000);
      await harness.stop();
      const error = await request;
      assert.match(String(error), /live oversized stdout request/u);
      assert.match(String(error), /partialStdout="x{512}" \(truncated\)/u);
      assert.match(harness.diagnostics(), /malformedStdout=1 \[x{512}\] \(truncated\)/u);
      assert.ok(harness.diagnostics().length < 2_000);
    } finally {
      await harness.stop();
    }
  });

  test("captures stream drain after exit before rejecting a pending request", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const harness = createChildRequestHarness(
      child as unknown as ReturnType<typeof spawn>,
      "drain-child",
      process.cwd(),
      "drain teardown",
    );
    const wrapped = extendChildHarness(harness, { request: harness.request });
    let settled = false;
    const request = harness
      .request(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "drain_tool" } },
        { id: 1, stage: "drain request", method: "tools/call", tool: "drain_tool" },
      )
      .catch((error: unknown) => {
        settled = true;
        return error;
      });
    child.exitCode = 17;
    child.emit("exit", 17, null);
    child.stdout!.write("final partial stdout");
    child.stderr!.write("final stderr");
    assert.equal(wrapped.stderr, "final stderr");
    assert.equal(settled, false);
    child.stdout!.end();
    child.stderr!.end();
    child.emit("close", 17, null);
    const error = await request;
    assert.match(
      String(error),
      /request=1 stage=drain request method=tools\/call tool=drain_tool/u,
    );
    assert.match(
      String(error),
      /partialStdout="final partial stdout"|malformedStdout=1 \[final partial stdout\]/u,
    );
    assert.match(String(error), /stderr="final stderr"/u);
    assert.match(String(error), /exitCode=17/u);
    await harness.stop();
  });

  test("timeout reports live partial stdout and late stderr", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 124,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const harness = createChildRequestHarness(
      child as unknown as ReturnType<typeof spawn>,
      "timeout-child",
      process.cwd(),
      "timeout teardown",
      20,
    );
    const wrapped = extendChildHarness(harness, { request: harness.request });
    const rejected = assert.rejects(
      wrapped.request(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "timeout_tool" } },
        { id: 1, stage: "timeout stage", method: "tools/call", tool: "timeout_tool" },
      ),
      (error: unknown) => {
        assert.match(
          String(error),
          /request=1 stage=timeout stage method=tools\/call tool=timeout_tool timed out/u,
        );
        assert.match(String(error), /partialStdout="x{512}" \(truncated\)/u);
        assert.match(String(error), /stderr="late stderr"/u);
        assert.ok(String(error).length < 2_000);
        return true;
      },
    );
    child.stdout!.write("x".repeat(100_000));
    child.stderr!.write("late stderr");
    assert.equal(wrapped.stderr, "late stderr");
    await rejected;
    child.emit("close", 0, null);
    await harness.stop();
  });

  test("decodes split UTF-8 responses and flushes an incomplete final character", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 125,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const harness = createChildRequestHarness(
      child as unknown as ReturnType<typeof spawn>,
      "unicode-child",
      process.cwd(),
      "unicode teardown",
    );
    const response = harness.request(
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { id: 1, stage: "unicode request", method: "initialize" },
    );
    const encoded = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "café🙂" } }),
    );
    const accent = encoded.indexOf(Buffer.from("é"));
    const emoji = encoded.indexOf(Buffer.from("🙂"));
    child.stdout.write(encoded.subarray(0, accent + 1));
    child.stdout.write(encoded.subarray(accent + 1, emoji + 2));
    child.stdout.write(encoded.subarray(emoji + 2));
    const stderr = Buffer.from("café🙂");
    child.stderr.write(stderr.subarray(0, 4));
    child.stderr.write(stderr.subarray(4, 7));
    child.stderr.write(stderr.subarray(7));
    assert.equal(harness.stderr, "café🙂");
    child.stdout.end();
    assert.equal((await response).result.text, "café🙂");
    child.emit("close", 0, null);
    await harness.stop();

    const incomplete = new PassThrough();
    const lines: string[] = [];
    createCappedStdoutReader(incomplete, (line) => lines.push(line));
    const ended = once(incomplete, "end");
    incomplete.end(Buffer.from([0xe2, 0x82]));
    await ended;
    assert.deepEqual(lines, ["�"]);
  });

  test("keeps sampling malformed and unmatched lines after truncation", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 126,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      killed: false,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const harness = createChildRequestHarness(
      child as unknown as ReturnType<typeof spawn>,
      "sampling-child",
      process.cwd(),
      "sampling teardown",
    );
    const rejected = assert.rejects(
      harness.request(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { id: 1, stage: "sampling request", method: "initialize" },
      ),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, /malformedStdout=2 \[x{512} \| later-malformed\] \(truncated\)/u);
        assert.match(message, /unmatchedStdout=2 \[/u);
        assert.match(message, /later-unmatched/u);
        assert.match(message, /unmatchedStdout=.*\(truncated\)/u);
        assert.ok(message.length < 3_000);
        return true;
      },
    );
    child.stdout.write(`${"x".repeat(1_000)}\nlater-malformed\n`);
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 999, result: { text: "y".repeat(1_000) } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 998, result: "later-unmatched" })}\n`,
    );
    child.emit("close", 0, null);
    await harness.stop();
    await rejected;
  });

  test("retains bounded secondary teardown failures and continues cleanup", async () => {
    const attempts: string[] = [];
    const cleanup = createCleanupCollector();
    await collectCleanup(cleanup, "store close", () => {
      attempts.push("store close");
      throw new Error("store close failed");
    });
    await collectCleanup(cleanup, "fixture removal", () => {
      attempts.push("fixture removal");
      throw new Error("fixture removal failed");
    });
    await collectCleanup(cleanup, "temporary directory removal", () => {
      attempts.push("temporary directory removal");
      throw new Error("temporary directory removal failed");
    });

    const primary = new Error("primary assertion failure");
    retainCleanupFailures(primary, cleanup);

    assert.deepEqual(attempts, ["store close", "fixture removal", "temporary directory removal"]);
    assert.match(primary.message, /primary assertion failure/u);
    assert.match(
      primary.message,
      /secondary cleanup failure \(store close\): Error: store close failed/u,
    );
    assert.match(
      primary.message,
      /secondary cleanup failure \(fixture removal\): Error: fixture removal failed/u,
    );
    assert.match(primary.message, /secondary cleanup failure \(temporary directory removal\)/u);
  });

  test("terminates a historical child after initialization failure", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-init-failure-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-init-failure-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const pidPath = join(target.root, "initialization-child.pid");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const failingServer = `
      import { appendFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      const pidPath = process.env.WORKFLOW_MCP_INIT_FAILURE_PID_FILE;
      if (pidPath) appendFileSync(pidPath, String(process.pid) + "\\n");
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32001, message: "initialization failed" },
          }) + "\\n");
        }
      });
    `;
    const healthyServer = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
            runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
          },
        }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const writeRuntimeFiles = (server: string) => {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      mkdirSync(workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), server);
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(target.root, "package.json"),
        '{"name":"runtime-init-failure-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
    };
    const start = () => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)}; new RuntimeSupervisor(${JSON.stringify(
        {
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: false,
        },
      )}).run();`;
      const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
        env: { ...process.env, WORKFLOW_MCP_INIT_FAILURE_PID_FILE: pidPath },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const role = "runtime-initialization-failure-child";
      const harness = createChildRequestHarness(
        child,
        role,
        target.root,
        "runtime initialization-failure teardown",
      );
      const request = (message: Record<string, unknown>) =>
        harness.request(message, {
          id: message.id as string | number,
          stage: "runtime initialization-failure request",
          method: String(message.method ?? "unknown"),
          tool:
            typeof (message.params as { name?: unknown } | undefined)?.name === "string"
              ? ((message.params as { name: string }).name as string)
              : undefined,
        });
      return extendChildHarness(harness, { request });
    };
    let owner: WorkflowStore | undefined;
    let active: ReturnType<typeof start> | undefined;
    let historicalPid: number | undefined;
    let primaryFailure: unknown;
    try {
      writeRuntimeFiles(failingServer);
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = fixtureHead(target.root, "runtime initialization failure revision A");
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: false,
      });
      writeFileSync(join(target.root, ".codex", "workflow-mcp", "server.ts"), healthyServer);
      git("add", ".codex/workflow-mcp/server.ts");
      git("commit", "-qm", "runtime B");
      const revisionB = fixtureHead(target.root, "runtime initialization failure revision B");
      const ownerKey = readFileSync(artifactA.attestationKeyPath);
      const ownerNonce = "1".repeat(64);
      owner = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactA.runtime_id,
        runtimeRevision: revisionA,
        runtimeAttestation: createRuntimeAttestation(
          artifactA.runtime_id,
          revisionA,
          ownerNonce,
          ownerKey,
        ),
        runtimeAttestationNonce: ownerNonce,
        runtimeAttestationKey: ownerKey as any,
      });
      const workflow = create(owner, target.root, revisionB, "historical initialization failure");
      owner.close();
      owner = undefined;

      active = start();
      const initialized = await active.request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      assert.ok(initialized.result);
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const failed = await active.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "workflow_parent_get", arguments: { workflow_id: workflow.workflow_id } },
      });
      assert.equal(failed.error?.data?.category, "ERROR_RUNTIME_RECOVERY");
      historicalPid = Number(readFileSync(pidPath, "utf8").trim());
      assert.ok(Number.isInteger(historicalPid) && historicalPid > 0);
      await waitForProcessExit(historicalPid);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup = createCleanupCollector();
      if (historicalPid === undefined) {
        try {
          const candidate = Number(readFileSync(pidPath, "utf8").trim());
          if (Number.isInteger(candidate) && candidate > 0) historicalPid = candidate;
        } catch {
          // The historical child may not have started before an earlier assertion failed.
        }
      }
      if (historicalPid !== undefined) {
        try {
          process.kill(historicalPid, "SIGKILL");
        } catch {
          // The regression assertion already confirmed the child exited.
        }
      }
      if (active) {
        const current = active;
        await collectCleanup(cleanup, `${current.role} stop`, () => current.stop());
      }
      await collectCleanup(cleanup, "initialization-failure owner close", () => owner?.close());
      await collectCleanup(cleanup, "initialization-failure fixture removal", () =>
        removeRuntimeFixture(
          target.root,
          "runtime initialization failure fixture teardown",
          active?.child,
          "runtime-initialization-failure-child",
        ),
      );
      await collectCleanup(cleanup, "initialization-failure cache removal", () =>
        rmSync(cacheRoot, { recursive: true, force: true }),
      );
      await collectCleanup(cleanup, "initialization-failure database removal", () =>
        rmSync(databaseRoot, { recursive: true, force: true }),
      );
      retainCleanupFailures(primaryFailure, cleanup);
    }
  }, 60_000);

  test("shutdown rejects pending initialization before terminating its child", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-shutdown-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-shutdown-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const server = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined || request.method !== "initialize") return;
        // Hold initialization open until the supervisor performs shutdown cleanup.
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const workflowRoot = join(target.root, ".codex", "workflow-mcp");
    let supervisor: RuntimeSupervisor | undefined;
    let child: any;
    try {
      mkdirSync(workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), server);
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(target.root, "package.json"),
        '{"name":"runtime-shutdown-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
      git("add", ".");
      git("commit", "-qm", "runtime shutdown");

      supervisor = new RuntimeSupervisor({
        repositoryRoot: target.root,
        providerRoot: target.root,
        databasePath,
        cacheRoot,
        installDependencies: false,
      });
      const internal = supervisor as any;
      child = internal.launch(supervisor.defaultRuntime);
      const key = `${supervisor.defaultRuntime.runtime_id}\u0000${supervisor.defaultRuntime.revision}`;
      internal.children.set(key, child);
      internal.initialized = true;
      internal.initializationLines = [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      ];
      const childClosed = once(child.process, "close");
      const initializing = internal.initializeOwner(child);
      supervisor.close();
      supervisor = undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new Error("runtime shutdown exceeded the prompt cleanup deadline")),
            2_000,
          );
        });
        const [initializationOutcome, processOutcome] = await Promise.race([
          Promise.all([
            initializing.then(
              () => "resolved",
              () => "rejected",
            ),
            childClosed.then(() => "closed"),
          ]),
          deadline,
        ]);
        assert.equal(initializationOutcome, "rejected");
        assert.equal(processOutcome, "closed");
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
    } finally {
      child?.initReject?.(new Error("runtime shutdown fixture cleanup"));
      supervisor?.close();
      try {
        child?.process.kill("SIGKILL");
      } catch {
        // The child was already terminated by supervisor shutdown.
      }
      removeRuntimeFixture(
        target.root,
        "runtime shutdown fixture teardown",
        child?.process,
        "runtime-shutdown-child",
      );
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test("recovers dirty adoption through a real historical owner after promotion", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-adoption-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-adoption-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const ownerServer = `
      import { createInterface } from "node:readline";
      import { openStore } from "./store.js";
      const store = openStore();
      const tools = ["workflow_parent_get", "workflow_resume_review", "workflow_begin_review", "workflow_implementer_get"];
      const handlers = {
        workflow_parent_get: (args) => store.parentGet(args.workflow_id),
        workflow_resume_review: (args) => store.resumeReview(args),
        workflow_begin_review: (args) => store.beginReview(args),
        workflow_implementer_get: (args) => store.implementerGet(args.workflow_id),
      };
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
            runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
            runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
          } }) + "\\n");
          return;
        }
        if (request.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: tools.map((name) => ({ name })) } }) + "\\n");
          return;
        }
        const handler = handlers[request.params?.name];
        if (!handler) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "ERROR_UNKNOWN_TOOL" } }) + "\\n");
          return;
        }
        try {
          const value = handler(request.params?.arguments ?? {});
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
            content: [{ type: "text", text: JSON.stringify(value) }],
            tools: tools.map((name) => ({ name })),
            runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
            runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
            tool: request.params?.name,
          } }) + "\\n");
        } catch (error) {
          const category = error?.category ?? "ERROR_RUNTIME_RECOVERY";
          const detail = error?.detail ?? category;
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: {
            code: -1,
            message: category,
            data: { category, detail },
          } }) + "\\n");
        }
      });
      process.stdin.on("close", () => store.close());
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const start = (role = "runtime-adoption-child") => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)}; new RuntimeSupervisor(${JSON.stringify(
        {
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: false,
        },
      )}).run();`;
      const nodePath = [join(process.cwd(), "node_modules"), process.env.NODE_PATH]
        .filter((value): value is string => Boolean(value))
        .join(delimiter);
      const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
        env: { ...process.env, NODE_PATH: nodePath },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const harness = createChildRequestHarness(
        child,
        role,
        target.root,
        "runtime adoption teardown",
      );
      const request = (id: number, tool: string, args: any) =>
        harness.request(
          {
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: tool, arguments: args },
          },
          { id, stage: "runtime adoption request", method: "tools/call", tool },
        );
      const initialize = () =>
        harness.request(
          { jsonrpc: "2.0", id: 1, method: "initialize" },
          { id: 1, stage: "runtime adoption initialization", method: "initialize" },
        );
      return extendChildHarness(harness, { initialize, request });
    };
    let active: ReturnType<typeof start> | undefined;
    let owner: any;
    let primaryFailure: unknown;
    try {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      cpSync(join(process.cwd(), ".codex/workflow-mcp"), workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), ownerServer);
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(target.root, "package.json"),
        '{"name":"runtime-adoption-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = fixtureHead(target.root, "runtime adoption revision A");
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: false,
      });

      writeFileSync(join(target.root, "runtime-b.txt"), "B\n");
      git("add", "runtime-b.txt");
      git("commit", "-qm", "runtime B");
      const revisionB = fixtureHead(target.root, "runtime adoption revision B");
      const ownerNonce = "1".repeat(64);
      const ownerKey = readFileSync(artifactA.attestationKeyPath);
      owner = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactA.runtime_id,
        runtimeRevision: revisionA,
        runtimeAttestation: createRuntimeAttestation(
          artifactA.runtime_id,
          revisionA,
          ownerNonce,
          ownerKey,
        ),
        runtimeAttestationNonce: ownerNonce,
        runtimeAttestationKey: ownerKey as any,
      });
      const created = owner.create({
        workflow_type: "change",
        objective: "historical dirty adoption",
        approved_plan: null,
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: [
          { description: "validation", kind: "command", argv: ["bun", "run", "check"] },
        ],
        review_target: {
          review_mode: "working_tree",
          base_revision: revisionB,
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      });
      const id = created.workflow_id;
      owner.expandScope({
        workflow_id: id,
        expected_version: 0,
        added_paths: ["dirty.txt"],
        reason: "planned path",
        user_authorization: "authorized",
      });
      owner.submitImplementation({
        workflow_id: id,
        expected_version: 1,
        status: "DONE",
        summary: "implemented",
        agent_touched_paths: [],
        acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
        validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }],
        known_failures: [],
        finding_resolution_map: {},
      });
      owner.beginReview({ workflow_id: id, expected_version: 2 });
      owner.submitReview({
        workflow_id: id,
        expected_version: 3,
        review_status: "INCONCLUSIVE",
        blocking_findings: [],
        optional_findings: [],
        prior_finding_classifications: {},
      });
      writeFileSync(join(target.root, "dirty.txt"), "authorized\n");
      owner.close();
      owner = undefined;

      active = start();
      const initialized = await active.initialize();
      assert.ok(
        initialized.result,
        `${JSON.stringify(initialized)}\n${active.stderr}\n${runtimeDiagnostic(
          target.root,
          "runtime adoption request",
          "initialize owning runtime",
          active.child,
          active.role,
          false,
        )}`,
      );
      assert.equal(initialized.result.runtime_revision, revisionB);
      assert.equal(initialized.result.runtime_id, artifactA.runtime_id);
      assert.notEqual(initialized.result.runtime_revision, revisionA);
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const routedHistorical = await active.request(2, "workflow_parent_get", {
        workflow_id: id,
      });
      assert.equal(routedHistorical.result.runtime_revision, revisionA);
      assert.equal(routedHistorical.result.tool, "workflow_parent_get");
      assert.equal(
        routedHistorical.result.tools.some(
          (tool: { name: string }) => tool.name === "workflow_adopt_dirty_scope",
        ),
        false,
      );
      const adopted = await active.request(3, "workflow_adopt_dirty_scope", {
        workflow_id: id,
        expected_version: 4,
        adopted_paths: ["dirty.txt"],
        reason: "recover dirty path",
        user_authorization: "explicit recovery",
      });
      assert.ok(adopted.result);
      const forwardedResume = await active.request(5, "workflow_resume_review", {
        workflow_id: id,
        expected_version: 5,
        resume_context: "resume after adoption",
      });
      assert.ok(
        forwardedResume.result,
        `${JSON.stringify(forwardedResume)}\n${active.stderr}\n${runtimeDiagnostic(
          target.root,
          "runtime adoption request",
          "resume historical review",
          active.child,
          active.role,
          false,
        )}`,
      );
      assert.equal(forwardedResume.result.runtime_revision, revisionA);
      assert.equal(forwardedResume.result.tool, "workflow_resume_review");
      const resumedView = JSON.parse(forwardedResume.result.content[0].text);
      assert.equal(resumedView.workflow_id, id);
      assert.equal(resumedView.version, 6);
      assert.equal(resumedView.phase, "REVIEWING");
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup = createCleanupCollector();
      if (active) {
        const current = active;
        await collectCleanup(cleanup, `${current.role} stop`, () => current.stop());
      }
      await collectCleanup(cleanup, "adoption owner close", () => owner?.close());
      await collectCleanup(cleanup, "adoption fixture removal", () =>
        removeRuntimeFixture(
          target.root,
          "runtime adoption fixture teardown",
          active?.child,
          active?.role ?? "runtime-adoption-child",
        ),
      );
      await collectCleanup(cleanup, "adoption cache removal", () =>
        rmSync(cacheRoot, { recursive: true, force: true }),
      );
      await collectCleanup(cleanup, "adoption database removal", () =>
        rmSync(databaseRoot, { recursive: true, force: true }),
      );
      retainCleanupFailures(primaryFailure, cleanup);
    }
  }, 60_000);

  test("bootstrap executes committed supervisor source despite dirty checkout launchers", async () => {
    const target = fixture();
    const provider = target.root;
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-bootstrap-cache-"));
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "workflow-bootstrap-db-")),
      "state.sqlite",
    );
    const workflowSource = join(process.cwd(), ".codex/workflow-mcp");
    const server = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { label: "committed" } }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", provider, ...args], { encoding: "utf8" }).trim();
    const bootstrap = join(provider, ".codex/workflow-mcp/bootstrap.ts");
    const supervisor = join(provider, ".codex/workflow-mcp/runtime-supervisor.ts");
    const committedServer = join(provider, ".codex/workflow-mcp/server.ts");
    let child: ReturnType<typeof spawn> | undefined;
    let harness: ChildRequestHarness | undefined;
    let primaryFailure: unknown;
    try {
      cpSync(workflowSource, join(provider, ".codex/workflow-mcp"), { recursive: true });
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(provider, ".codex/agents/receipt.ts"),
      );
      writeFileSync(committedServer, server);
      writeFileSync(
        join(provider, "package.json"),
        '{"name":"bootstrap-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(provider, "bun.lock"), "{}\n");
      git("add", ".");
      git("commit", "-qm", "committed bootstrap");

      writeFileSync(
        bootstrap,
        `${readFileSync(bootstrap, "utf8")}\nprocess.stderr.write("dirty bootstrap\\n");\n`,
      );
      writeFileSync(supervisor, 'process.stderr.write("dirty supervisor\\n");\n');
      writeFileSync(committedServer, `${server}\nprocess.stderr.write("dirty server\\n");\n`);

      const command =
        `bootstrap=$(mktemp) && trap 'rm -f "$bootstrap"' EXIT && ` +
        `git -C ${JSON.stringify(provider)} show HEAD:.codex/workflow-mcp/bootstrap.ts >"$bootstrap" && ` +
        `bun --no-warnings "$bootstrap"`;
      child = spawn("sh", ["-c", command], {
        detached: true,
        cwd: provider,
        env: {
          ...process.env,
          WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT: provider,
          WORKFLOW_MCP_DB_PATH: databasePath,
          WORKFLOW_MCP_PROVIDER_ROOT: "/definitely/not-the-provider",
          WORKFLOW_MCP_RUNTIME_CACHE_ROOT: cacheRoot,
          WORKFLOW_MCP_INSTALL_DEPENDENCIES: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      harness = createChildRequestHarness(
        child,
        "bootstrap child",
        target.root,
        "bootstrap teardown",
        15_000,
      );
      const response = await harness.request(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { id: 1, stage: "bootstrap initialization", method: "initialize" },
      );
      assert.equal(response.result.label, "committed");
      assert.equal(harness.stderr.includes("dirty bootstrap"), false);
      assert.equal(harness.stderr.includes("dirty supervisor"), false);
      assert.equal(harness.stderr.includes("dirty server"), false);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      const cleanup = createCleanupCollector();
      if (child && harness) {
        const currentChild = child;
        const currentHarness = harness;
        await collectCleanup(cleanup, "bootstrap shutdown", () =>
          stopBootstrapChild(currentChild, currentHarness, primaryFailure !== undefined),
        );
      } else if (child) {
        const current = child;
        await collectCleanup(cleanup, "bootstrap process group kill", () =>
          killBootstrapProcessGroup(current),
        );
      }
      await collectCleanup(cleanup, "bootstrap fixture removal", () =>
        removeRuntimeFixture(target.root, "bootstrap fixture teardown", child, "bootstrap child"),
      );
      await collectCleanup(cleanup, "bootstrap cache removal", () =>
        rmSync(cacheRoot, { recursive: true, force: true }),
      );
      await collectCleanup(cleanup, "bootstrap database removal", () =>
        rmSync(dirname(databasePath), { recursive: true, force: true }),
      );
      retainCleanupFailures(primaryFailure, cleanup);
    }
  });

  test("bounds bootstrap cleanup when a descendant holds output pipes open", async () => {
    const child = spawn(
      "sh",
      [
        "-c",
        '"$0" -e \'process.stdout.write(String(process.pid) + "\\n"); setInterval(() => {}, 1000)\' & wait',
        process.execPath,
      ],
      { detached: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const harness = createChildRequestHarness(
      child,
      "bootstrap descendant child",
      process.cwd(),
      "bootstrap descendant teardown",
    );
    let pidText = "";
    const descendantReady = new Promise<number>((resolve) =>
      child.stdout!.on("data", (chunk) => {
        pidText = `${pidText}${chunk.toString()}`.slice(0, 32);
        if (pidText.includes("\n")) resolve(Number(pidText.trim()));
      }),
    );
    let descendantPid: number | undefined;
    try {
      descendantPid = await descendantReady;
      assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
      const shellExit = once(child, "exit");
      child.kill("SIGKILL");
      await shellExit;
      assert.equal(child.stdout!.readableEnded, false);
      const primary = new Error("primary bootstrap failure");
      const cleanup = createCleanupCollector();
      await collectCleanup(cleanup, "bootstrap shutdown", () =>
        stopBootstrapChild(child, harness, true, 1_000),
      );
      retainCleanupFailures(primary, cleanup);
      assert.equal(primary.message, "primary bootstrap failure");
      assert.equal(child.stdout!.readableEnded, true);
    } finally {
      await killBootstrapProcessGroup(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  });

  test("retains the primary bootstrap failure when bounded shutdown times out", async () => {
    const child = spawn(
      "sh",
      [
        "-c",
        '"$0" -e \'process.stdout.write("ready\\n"); setInterval(() => {}, 1000)\' & wait',
        process.execPath,
      ],
      {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const harness = createChildRequestHarness(
      child,
      "hung bootstrap",
      process.cwd(),
      "hung bootstrap teardown",
    );
    const primary = new Error("primary bootstrap failure");
    const cleanup = createCleanupCollector();
    try {
      await once(child.stdout!, "data");
      await collectCleanup(cleanup, "bootstrap shutdown", () =>
        stopBootstrapChild(child, harness, false, 20),
      );
      retainCleanupFailures(primary, cleanup);
      assert.match(primary.message, /primary bootstrap failure/u);
      assert.match(primary.message, /child close timed out/u);
      assert.match(primary.message, /secondary cleanup failure \(bootstrap shutdown\)/u);
      assert.doesNotMatch(primary.message, /bootstrap process group kill after stop/u);
    } finally {
      await killBootstrapProcessGroup(child);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  });

  test("reports bounded live bootstrap output and rejects invalid matching responses", async () => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        'process.stdin.once("data", () => { process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,label:"invalid"}) + "\\n" + "x".repeat(100_000)); process.stdin.on("end", () => process.exit(17)); });',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const harness = createChildRequestHarness(
      child,
      "bootstrap-child",
      process.cwd(),
      "bootstrap teardown",
      15_000,
    );
    let bytes = 0;
    const outputSeen = new Promise<void>((resolve) =>
      child.stdout!.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes >= 100_000) resolve();
      }),
    );
    try {
      const response = harness.request(
        { jsonrpc: "2.0", id: 1, method: "initialize" },
        { id: 1, stage: "bootstrap initialization", method: "initialize" },
      );
      await outputSeen;
      const live = harness.diagnostics();
      assert.match(live, /malformedStdout=1/u);
      assert.match(live, /partialStdout="x{512}" \(truncated\)/u);
      assert.ok(live.length < 2_000);
      const rejected = assert.rejects(response, (error: unknown) => {
        assert.match(String(error), /stage=bootstrap initialization method=initialize/u);
        assert.match(String(error), /partialStdout="x{512}" \(truncated\)/u);
        assert.match(String(error), /malformedStdout=1/u);
        assert.ok(String(error).length < 2_000);
        return true;
      });
      await harness.stop();
      await rejected;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await harness.stop();
    }
  });

  test("rejects an early bootstrap child exit with its final output", async () => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "-e",
        'process.stdin.once("data", () => process.stderr.write("bootstrap failed", () => process.stdout.write("invalid bootstrap output", () => process.exit(17))));',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const harness = createChildRequestHarness(
      child,
      "bootstrap-child",
      process.cwd(),
      "bootstrap teardown",
      15_000,
    );
    try {
      await assert.rejects(
        harness.request(
          { jsonrpc: "2.0", id: 1, method: "initialize" },
          { id: 1, stage: "bootstrap initialization", method: "initialize" },
        ),
        (error: unknown) => {
          assert.match(
            String(error),
            /stage=bootstrap initialization method=initialize child exit/u,
          );
          assert.match(String(error), /malformedStdout=1 \[invalid bootstrap output\]/u);
          assert.match(String(error), /stderr="bootstrap failed"/u);
          assert.match(String(error), /exitCode=17/u);
          return true;
        },
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await harness.stop();
    }
  });
});
