import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReceipt } from "../../agents/receipt.js";

type Git = (...args: string[]) => string;
type Receipt = ReturnType<typeof createReceipt>;
let template: string | undefined;
let emptyTemplatePath: string | undefined;

export interface FixtureDiagnosticContext {
  stage: string;
  operation: string;
  cleanupStarted: boolean;
  child?: {
    pid?: number;
    role: string;
    live: boolean;
    killed: boolean;
    exitCode: number | null;
    signalCode: string | null;
  };
}

const OBSERVATION_LIMIT = 4_096;

type BoundedObservationValue = {
  status: "available";
  value: string;
  length_bytes: number;
  length_chars: number;
  truncated: boolean;
};

type UnavailableObservationValue = {
  status: "unavailable";
  reason: string;
};

type ObservationValue = BoundedObservationValue | UnavailableObservationValue;

export interface HeadObservation {
  label: "pre-call" | "post-failure";
  qualification: string;
  repository_identity: {
    supplied_root: ObservationValue;
    realpath: ObservationValue;
    git_top_level: ObservationValue;
  };
  head: {
    raw_stdout: ObservationValue;
    trimmed: ObservationValue;
  };
  object_format: ObservationValue;
  environment: {
    GIT_DEFAULT_HASH: ObservationValue;
  };
  config: {
    init_defaultObjectFormat: ObservationValue;
  };
  git_head: ObservationValue;
  symbolic_head: ObservationValue;
}

function boundedValue(value: string): BoundedObservationValue {
  const lengthBytes = Buffer.byteLength(value, "utf8");
  const lengthChars = value.length;
  let bounded = value;
  let truncated = false;
  if (lengthBytes > OBSERVATION_LIMIT) {
    bounded = Buffer.from(value, "utf8").subarray(0, OBSERVATION_LIMIT).toString("utf8");
    truncated = true;
  }
  return {
    status: "available",
    value: bounded,
    length_bytes: lengthBytes,
    length_chars: lengthChars,
    truncated,
  };
}

function unavailable(reason: string): UnavailableObservationValue {
  return { status: "unavailable", reason: reason.slice(0, 300) };
}

function probeGit(root: string, args: string[]): ObservationValue {
  try {
    return boundedValue(
      execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        maxBuffer: OBSERVATION_LIMIT,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch (error) {
    const candidate = error as { message?: unknown };
    return unavailable(typeof candidate.message === "string" ? candidate.message : "probe failed");
  }
}

function probeFile(path: string): ObservationValue {
  try {
    return boundedValue(readFileSync(path, "utf8"));
  } catch (error) {
    const candidate = error as { message?: unknown };
    return unavailable(typeof candidate.message === "string" ? candidate.message : "read failed");
  }
}

function probeRoot(root: string): ObservationValue {
  return boundedValue(root);
}

export function captureHeadObservation(
  root: string,
  label: HeadObservation["label"],
): HeadObservation {
  const realpath = (() => {
    try {
      return boundedValue(realpathSync(root));
    } catch {
      return unavailable("realpath unavailable");
    }
  })();
  const rawHead = probeGit(root, ["rev-parse", "--verify", "HEAD"]);
  const trimmedHead = rawHead.status === "available" ? boundedValue(rawHead.value.trim()) : rawHead;
  const defaultHash = process.env.GIT_DEFAULT_HASH;
  return {
    label,
    qualification:
      "bounded surrounding observation; not the exact stdout returned by the triggering currentHead() invocation",
    repository_identity: {
      supplied_root: probeRoot(root),
      realpath,
      git_top_level: probeGit(root, ["rev-parse", "--show-toplevel"]),
    },
    head: { raw_stdout: rawHead, trimmed: trimmedHead },
    object_format: probeGit(root, ["rev-parse", "--show-object-format"]),
    environment: {
      GIT_DEFAULT_HASH:
        defaultHash === undefined ? unavailable("no value") : boundedValue(defaultHash),
    },
    config: {
      init_defaultObjectFormat: probeGit(root, [
        "config",
        "--show-origin",
        "--get",
        "init.defaultObjectFormat",
      ]),
    },
    git_head: probeFile(join(root, ".git", "HEAD")),
    symbolic_head: probeGit(root, ["symbolic-ref", "--short", "HEAD"]),
  };
}

export function fixtureDiagnostic(
  root: string,
  context: FixtureDiagnosticContext,
  observations?: FixtureFailureObservations,
): string {
  const detail = JSON.stringify({
    repository_root: root,
    stage: context.stage,
    operation: context.operation,
    cleanup_started: context.cleanupStarted,
    ...(context.child ? { child: context.child } : {}),
    ...(observations ?? {}),
  });
  return `fixture diagnostic: ${detail.slice(0, observations ? 8_000 : 1_000)}`;
}

interface FixtureFailureObservations {
  pre_call_observation: HeadObservation;
  post_failure_observation: HeadObservation;
}

export function annotateFixtureFailure(
  error: unknown,
  root: string,
  context: FixtureDiagnosticContext,
  observations?: FixtureFailureObservations,
): unknown {
  const candidate = error as { message?: unknown; stderr?: unknown };
  const stderr =
    typeof candidate.stderr === "string"
      ? candidate.stderr
      : Buffer.isBuffer(candidate.stderr)
        ? candidate.stderr.toString("utf8")
        : "";
  const detail = `${typeof candidate.message === "string" ? candidate.message : ""} ${stderr}`;
  if (!detail.includes("ERROR_NO_HEAD")) return error;
  const diagnostic = fixtureDiagnostic(root, context, observations);
  if (error instanceof Error) error.message = `${error.message}; ${diagnostic}`;
  if (typeof candidate.stderr === "string") candidate.stderr = `${candidate.stderr}\n${diagnostic}`;
  if (Buffer.isBuffer(candidate.stderr)) candidate.stderr = Buffer.from(`${stderr}\n${diagnostic}`);
  return error;
}

function runGit(root: string, ...args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fixtureTemplate(): string {
  if (template) return template;
  template = mkdtempSync(join(tmpdir(), "workflow-template-"));
  runGit(template, "init", "--object-format=sha1", "-q");
  runGit(template, "config", "user.email", "workflow@example.invalid");
  runGit(template, "config", "user.name", "Workflow Tests");
  writeFileSync(join(template, "note.txt"), "before\n");
  mkdirSync(join(template, ".codex", "agents"), { recursive: true });
  cpSync(
    join(process.cwd(), ".codex", "reviewer-validation.json"),
    join(template, ".codex", "reviewer-validation.json"),
  );
  cpSync(
    join(process.cwd(), ".codex", "agents", "change-receipt.ts"),
    join(template, ".codex", "agents", "change-receipt.ts"),
  );
  runGit(template, "add", ".");
  runGit(template, "commit", "-qm", "fixture");
  return template;
}

function emptyFixtureTemplate(): string {
  if (emptyTemplatePath) return emptyTemplatePath;
  emptyTemplatePath = mkdtempSync(join(tmpdir(), "workflow-empty-template-"));
  runGit(emptyTemplatePath, "init", "--object-format=sha1", "-q");
  runGit(emptyTemplatePath, "config", "user.email", "workflow@example.invalid");
  runGit(emptyTemplatePath, "config", "user.name", "Workflow Tests");
  runGit(emptyTemplatePath, "commit", "--allow-empty", "-qm", "fixture");
  return emptyTemplatePath;
}

export interface Fixture {
  root: string;
  git: Git;
}

export function fixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-state-")));
  cpSync(fixtureTemplate(), root, { recursive: true });
  let cachedHead: string | undefined;
  const git = (...args: string[]) => {
    if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" && cachedHead) {
      return cachedHead;
    }
    try {
      const result = runGit(root, ...args);
      cachedHead =
        args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" ? result : undefined;
      return result;
    } catch (error) {
      throw annotateFixtureFailure(error, root, {
        stage: "fixture git operation",
        operation: args.join(" "),
        cleanupStarted: false,
      });
    }
  };
  return { root, git };
}

export function emptyFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "workflow-empty-")));
  cpSync(emptyFixtureTemplate(), root, { recursive: true });
  let cachedHead: string | undefined;
  const git = (...args: string[]) => {
    if (args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" && cachedHead) {
      return cachedHead;
    }
    try {
      const result = runGit(root, ...args);
      cachedHead =
        args.length === 2 && args[0] === "rev-parse" && args[1] === "HEAD" ? result : undefined;
      return result;
    } catch (error) {
      throw annotateFixtureFailure(error, root, {
        stage: "empty fixture git operation",
        operation: args.join(" "),
        cleanupStarted: false,
      });
    }
  };
  return { root, git };
}

export function disposeFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function receipt(root: string, paths: string[] = ["note.txt"]): Receipt {
  return createReceipt(paths, root);
}

export function absentReceipt(root: string, paths: string[]): Receipt {
  return createReceipt(paths, root, { allowAbsent: true });
}
