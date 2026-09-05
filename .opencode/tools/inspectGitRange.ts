import { spawnSync } from "node:child_process";
import { tool, type ToolResult } from "@opencode-ai/plugin";

const MAX_REVISION_LENGTH = 200;
const MAX_RESOLUTION_OUTPUT_BYTES = 4096;
const MAX_PATH_OUTPUT_BYTES = 256 * 1024;
const MAX_STAT_OUTPUT_BYTES = 64 * 1024;
const MAX_DIFF_OUTPUT_BYTES = 512 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const OID = /^[0-9a-f]{40,64}$/u;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export interface GitRangeRequest {
  base: string;
  head: string;
}

export interface GitRangeInspection {
  requested: { base: string; head: string };
  resolved: { base: string | null; head: string | null };
  exitStatus: number | null;
  changedPaths: string[];
  stat: string;
  diff: string;
  incomplete: boolean;
}

interface GitInvocation {
  status: number | null;
  stdout: Buffer;
  stderr: Buffer;
  incomplete: boolean;
}

function boundedText(value: Buffer, maximum: number): {
  text: string;
  truncated: boolean;
  malformed: boolean;
} {
  let malformed = false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    malformed = true;
  }
  if (value.byteLength <= maximum) {
    return { text: value.toString("utf8"), truncated: false, malformed };
  }
  const marker = Buffer.from("\n[output truncated]", "utf8");
  const content = value.subarray(0, Math.max(0, maximum - marker.byteLength));
  return {
    text:
      maximum <= marker.byteLength
        ? marker.subarray(0, maximum).toString("utf8")
        : `${content.toString("utf8")}${marker.toString("utf8")}`,
    truncated: true,
    malformed,
  };
}

function validRevision(value: string): boolean {
  const components = value.split("/");
  return (
    value.length > 0 &&
    value.length <= MAX_REVISION_LENGTH &&
    !value.startsWith("-") &&
    REVISION.test(value) &&
    !value.includes("..") &&
    !value.includes("@") &&
    !value.includes("//") &&
    !value.includes("/.") &&
    !value.endsWith("/") &&
    components.every(
      (component) =>
        component.length > 0 &&
        !component.endsWith(".") &&
        !component.endsWith(".lock") &&
        !component.includes("@{"),
    ) &&
    value !== "." &&
    value !== ".."
  );
}

function invokeGit(worktree: string, args: readonly string[], maximum: number): GitInvocation {
  const result = spawnSync("git", ["-C", worktree, ...args], {
    cwd: worktree,
    encoding: "buffer",
    shell: false,
    timeout: MAX_TIMEOUT_MS,
    maxBuffer: maximum,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? "");
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    status: typeof result.status === "number" ? result.status : null,
    stdout,
    stderr,
    incomplete:
      error?.code === "ETIMEDOUT" ||
      error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      result.signal !== null ||
      stdout.byteLength > maximum ||
      stderr.byteLength > maximum,
  };
}

function resolveRevision(worktree: string, revision: string): GitInvocation & { oid: string | null } {
  const invocation = invokeGit(
    worktree,
    ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
    MAX_RESOLUTION_OUTPUT_BYTES,
  );
  const output = boundedText(invocation.stdout, MAX_RESOLUTION_OUTPUT_BYTES);
  const lines = output.text.split("\n");
  const oid =
    invocation.status === 0 &&
    !invocation.incomplete &&
    !output.truncated &&
    !output.malformed &&
    lines.length === 2 &&
    lines[1] === "" &&
    OID.test(lines[0] ?? "")
      ? (lines[0] ?? null)
      : null;
  return { ...invocation, oid, incomplete: invocation.incomplete || oid === null };
}

function parseChangedPaths(value: Buffer): { paths: string[]; malformed: boolean; truncated: boolean } {
  const bounded = boundedText(value, MAX_PATH_OUTPUT_BYTES);
  if (bounded.truncated) return { paths: [], malformed: bounded.malformed, truncated: true };
  if (bounded.malformed) return { paths: [], malformed: true, truncated: false };
  if (value.byteLength === 0) return { paths: [], malformed: false, truncated: false };
  if (value[value.byteLength - 1] !== 0) return { paths: [], malformed: true, truncated: false };
  const records = value.toString("utf8").split("\0");
  records.pop();
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 2) {
    const status = records[index];
    const path = records[index + 1];
    if (status === undefined || path === undefined || !/^[ACDMRTUXB?]{1,2}$/u.test(status)) {
      return { paths: [], malformed: true, truncated: false };
    }
    paths.push(path);
  }
  return { paths, malformed: false, truncated: false };
}

function failedInspection(base: string, head: string, exitStatus: number | null): GitRangeInspection {
  return {
    requested: { base, head },
    resolved: { base: null, head: null },
    exitStatus,
    changedPaths: [],
    stat: "",
    diff: "",
    incomplete: true,
  };
}

export function inspectGitRange(
  request: GitRangeRequest,
  worktree: string,
): GitRangeInspection {
  const { base, head } = request;
  if (!validRevision(base) || !validRevision(head)) return failedInspection(base, head, null);

  const resolvedBase = resolveRevision(worktree, base);
  const resolvedHead = resolveRevision(worktree, head);
  const resolved = { base: resolvedBase.oid, head: resolvedHead.oid };
  if (resolvedBase.oid === null || resolvedHead.oid === null) {
    return {
      ...failedInspection(base, head, resolvedBase.status ?? resolvedHead.status),
      resolved,
    };
  }

  const range = `${resolvedBase.oid}...${resolvedHead.oid}`;
  const paths = invokeGit(
    worktree,
    [
      "diff",
      "--name-status",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--format=",
      range,
      "--",
    ],
    MAX_PATH_OUTPUT_BYTES,
  );
  const stat = invokeGit(
    worktree,
    ["diff", "--stat", "--no-ext-diff", "--no-textconv", "--format=", range, "--"],
    MAX_STAT_OUTPUT_BYTES,
  );
  const patch = invokeGit(
    worktree,
    ["diff", "--binary", "--patch", "--no-ext-diff", "--no-textconv", range, "--"],
    MAX_DIFF_OUTPUT_BYTES,
  );
  const parsedPaths = parseChangedPaths(paths.stdout);
  const statText = boundedText(stat.stdout, MAX_STAT_OUTPUT_BYTES);
  const diffText = boundedText(patch.stdout, MAX_DIFF_OUTPUT_BYTES);
  const incomplete =
    paths.status !== 0 ||
    stat.status !== 0 ||
    patch.status !== 0 ||
    paths.incomplete ||
    stat.incomplete ||
    patch.incomplete ||
    parsedPaths.malformed ||
    parsedPaths.truncated ||
    statText.truncated ||
    diffText.truncated ||
    statText.malformed ||
    diffText.malformed;
  return {
    requested: { base, head },
    resolved,
    exitStatus:
      paths.status !== 0
        ? paths.status
        : stat.status !== 0
          ? stat.status
          : patch.status,
    changedPaths: parsedPaths.paths,
    stat: statText.text,
    diff: diffText.text,
    incomplete,
  };
}

function result(inspection: GitRangeInspection): ToolResult {
  return {
    title: `Git range ${inspection.requested.base}...${inspection.requested.head}`,
    output: JSON.stringify(inspection),
    metadata: inspection,
  };
}

export default tool({
  description:
    "Inspect one bounded, read-only Git revision range. Explorer-only and non-authoritative.",
  args: {
    base: tool.schema.string().min(1).max(MAX_REVISION_LENGTH),
    head: tool.schema.string().min(1).max(MAX_REVISION_LENGTH),
  },
  async execute(args, context) {
    if (context.agent !== "explorer") {
      return result(failedInspection(args.base, args.head, null));
    }
    return result(inspectGitRange({ base: args.base, head: args.head }, context.worktree));
  },
});
