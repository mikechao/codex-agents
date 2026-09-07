import { spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRYPOINT = ".codex/workflow-mcp/server.ts";
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

function outputText(value: string | Buffer | null | undefined): string {
  return value === undefined || value === null
    ? ""
    : String(value).replace(/\s+/gu, " ").trim().slice(0, 2_000);
}

function executableName(): string {
  return process.platform === "win32" ? "workflow-mcp.exe" : "workflow-mcp";
}

export function standaloneRuntimePath(runtimeDirectory: string): string {
  return resolve(runtimeDirectory, executableName());
}

function regularExecutable(path: string): void {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = lstatSync(path);
  } catch (cause) {
    throw new Error(`Standalone Workflow MCP build did not produce ${path}`, { cause });
  }
  if (!stats.isFile())
    throw new Error(`Standalone Workflow MCP output is not a regular file: ${path}`);
  if (process.platform !== "win32") {
    chmodSync(path, 0o755);
    const mode = statSync(path).mode;
    if ((mode & 0o111) === 0)
      throw new Error(`Standalone Workflow MCP output is not executable: ${path}`);
  }
}

function verifyProtocol(path: string, databasePath: string, cwd: string): void {
  const smokeScript = `
    const { spawn } = require("node:child_process");
    const child = spawn(process.env.WORKFLOW_MCP_SMOKE_TARGET, [], {
      cwd: process.env.WORKFLOW_MCP_SMOKE_CWD,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: process.env.WORKFLOW_MCP_SMOKE_DB },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const lines = [];
    let stderr = "";
    let finished = false;
    let fallbackTimer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallbackTimer);
      process.stdout.write(JSON.stringify({ lines, stderr }));
    };
    const send = (message) => child.stdin.write(JSON.stringify(message) + "\\n");
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const index = buffer.indexOf("\\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          lines.push(line);
          if (message.id === 1) {
            send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
            send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
          } else if (message.id === 2) {
            child.kill("SIGTERM");
          }
        } catch {
          lines.push(line);
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", finish);
    fallbackTimer = setTimeout(() => { child.kill("SIGTERM"); finish(); }, 10000);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "workflow-mcp-build-smoke", version: "1.0.0" },
      },
    });
  `;
  const result = spawnSync(process.execPath, ["-e", smokeScript], {
    cwd,
    env: {
      ...process.env,
      WORKFLOW_MCP_SMOKE_TARGET: path,
      WORKFLOW_MCP_SMOKE_CWD: cwd,
      WORKFLOW_MCP_SMOKE_DB: databasePath,
    },
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stderr = outputText(result.stderr);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Standalone Workflow MCP smoke test failed${stderr.length === 0 ? "" : `: ${stderr}`}`,
      { cause: result.error },
    );
  }
  let smoke: { lines?: unknown; stderr?: unknown };
  try {
    smoke = JSON.parse(String(result.stdout ?? "")) as { lines?: unknown; stderr?: unknown };
  } catch (cause) {
    throw new Error("Standalone Workflow MCP smoke test returned malformed harness output", {
      cause,
    });
  }
  const lines = Array.isArray(smoke.lines)
    ? smoke.lines.filter((line): line is string => typeof line === "string")
    : [];
  const childStderr = outputText(typeof smoke.stderr === "string" ? smoke.stderr : "");
  if (childStderr.length > 0)
    throw new Error(`Standalone Workflow MCP smoke test failed: ${childStderr}`);
  if (lines.length < 2)
    throw new Error("Standalone Workflow MCP smoke test returned too few responses");
  for (const line of lines) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (cause) {
      throw new Error("Standalone Workflow MCP emitted malformed or non-protocol stdout", {
        cause,
      });
    }
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message) ||
      (message as Record<string, unknown>).jsonrpc !== "2.0"
    ) {
      throw new Error("Standalone Workflow MCP emitted a non-protocol response");
    }
  }
  const responses = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  if (!responses.some((message) => message.id === 1 && message.result !== undefined)) {
    throw new Error("Standalone Workflow MCP did not answer initialize");
  }
  if (!responses.some((message) => message.id === 2 && message.result !== undefined)) {
    throw new Error("Standalone Workflow MCP did not answer tools/list");
  }
}

export interface BuildStandaloneWorkflowMcpOptions {
  sourceRoot: string;
  outputPath: string;
  bunExecutable?: string;
}

/** Compile and verify the target-local runtime. This module is intentionally not imported by server.ts. */
export function buildStandaloneWorkflowMcp(options: BuildStandaloneWorkflowMcpOptions): string {
  const sourceRoot = resolve(options.sourceRoot);
  const outputPath = resolve(options.outputPath);
  const entrypoint = resolve(sourceRoot, ENTRYPOINT);
  const bunExecutable = options.bunExecutable ?? process.execPath;
  const result = spawnSync(
    bunExecutable,
    ["build", "--compile", entrypoint, "--outfile", outputPath],
    {
      cwd: sourceRoot,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const details = outputText(result.stderr) || outputText(result.stdout);
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `Unable to compile standalone Workflow MCP${details.length === 0 ? "" : `: ${details}`}`,
      { cause: result.error },
    );
  }
  regularExecutable(outputPath);
  const smokeRoot = mkdtempSync(join(tmpdir(), "workflow-mcp-build-smoke-"));
  try {
    verifyProtocol(outputPath, join(smokeRoot, "state.sqlite"), sourceRoot);
  } finally {
    rmSync(smokeRoot, { recursive: true, force: true });
  }
  return outputPath;
}

export function verifyStandaloneWorkflowMcp(path: string): void {
  regularExecutable(resolve(path));
}
