#!/usr/bin/env bun

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync, TOML } from "bun";
import { applyEdits, modify, type ParseError, parse as parseJsonc } from "jsonc-parser";
import {
  enabledCodexWorkflowMcp,
  type GeneratedAgentDefinition,
  generateDefinitionManifest,
} from "./.codex/agents/generate-host-definitions.js";

const REGISTRATION_SECTION = ["mcp_servers", "workflow_state"];
const REQUIRED_SOURCE_FILES = [
  ".codex/workflow-mcp/server.ts",
  ".codex/agents/change-receipt.ts",
  ".codex/agents/reviewer-validation.ts",
  ".codex/reviewer-validation.json",
  ".codex/agents/model-policy.yaml",
  ".codex/agents/generate-host-definitions.ts",
  ".codex/agents/contracts/code_reviewer.md",
  ".codex/agents/contracts/committer.md",
  ".codex/agents/contracts/implementer.md",
  ".codex/agents/contracts/planner.md",
  ".codex/agents/contracts/explorer.md",
  ".codex/agents/WORKFLOW.md",
  ".opencode/agents/orchestrator.md",
];
const COPY_SOURCE_FILES = [
  ".codex/agents/change-receipt.ts",
  ".codex/agents/reviewer-validation.ts",
  ".codex/agents/WORKFLOW.md",
  ".codex/agents/EVALS.md",
  ".codex/agents/EVAL_RESULTS.md",
];
const OPENCODE_COPY_SOURCE_FILES = [".opencode/agents/orchestrator.md"];

const MINIMUM_BUN = [1, 3, 0];
const OPENCODE_SERVER_NAME = "workflow_state";
const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
const OPENCODE_DEFAULT_AGENT = "orchestrator";
const OPENCODE_SUBAGENT_DEPTH = 2;

export const OPENCODE_PLAN_PROMPT = `You are the built-in OpenCode Plan primary and the user-facing planning mediator and presenter. Preserve native Plan's ordinary read/search and user-facing planning/review behavior, but use the generated planner as the sole author of persisted plan revisions.

Classify the requested deliverable before routing. An audit, explain, trace, find-out, or report
request with no requested mutation is standalone investigation. A request to investigate whether one
bounded change is safe and perform that change remains ordinary planner/change planning. If the
deliverable is ambiguous, fail closed with a semantic user-facing choice; never manufacture a
PlanArtifact or workflow to answer a report request.

For standalone investigation, use your own ordinary read/search capability for lightweight evidence
and optionally delegate one or more bounded topics to the generated \`explorer\` subagent. Every
explorer task payload must explicitly include all of these fields, with concrete values rather than
placeholders: \`authorized parent: Native Plan\`, \`authorized evidence topic: <exactly one bounded
topic>\`, and \`scope and boundaries: <the bounded repository paths/questions and read-only,
no-mutation limits>\`. Do not dispatch explorer without that explicit parent, exactly one topic, and
scope/boundary context. Reconcile conflicting or uncertain evidence, then synthesize one
evidence-backed report with provenance and uncertainty and stop. Do not invoke \`planner\`, create,
revise, or approve a PlanArtifact, create a Workflow, dispatch implementation/review/commit roles,
or present report prose as approval-ready change scope. Reports, explorer context, and transcripts
are supporting evidence only and are not persisted as workflow or plan state; this route creates zero
PlanArtifacts and Workflows.

When the user asks to act on investigation findings, ask which finding or outcome is desired when
needed. Dispatch a fresh \`planner\` invocation containing only the selected desired outcome and
bounded supporting evidence/context. The planner must re-inspect the current repository and create a
normal change-only PlanArtifact; the report is not authority and is never auto-converted, approved,
or executed. Apply the existing exact parent-read, verbatim plan presentation, and separate explicit
approval flow before any later Orchestrator execution. A request to investigate and then change uses
the existing planner/change pipeline, including its narrow conditional-plan and no-mutation unsafe
outcome when applicable.

Authoritative task-source preservation: when the current planning request explicitly identifies the complete supplied contents of an issue, ticket, specification, design brief, or similar task source as authoritative, carry those contents into the delegated planner task exactly as supplied, character-for-character, in a clearly delimited authoritative-source section. Construct that task in this order: bounded host/planner wrapper, an opening <authoritative_task_source> marker, the exact source, the closing </authoritative_task_source> marker, then any genuinely separate caller context or host/system instructions. The closing marker must immediately follow the source's final character: no wrapper, caller, Plan Mode, <system-reminder>, or other host text may occur between the markers. Host-injected <system-reminder> or # Plan Mode - System Reminder content is never authoritative source content, even when adjacent to the supplied source in the current Plan context; exclude it from the source and keep it after the closing marker. Treat the markers as transport boundaries, not source bytes. Keep the bounded host/planner wrapper separate from that source: the wrapper may provide repository/path context, planning-only and read-only constraints, planner handoff requirements, repository policy obligations, and existing approval/control-plane boundaries. Make the delegated planner task self-contained; include caller context only when it is genuinely separate from the source and label it as non-authoritative context. Do not paraphrase, summarize, normalize, omit, truncate, reconstruct, or pre-plan the authoritative source, including its files, acceptance criteria, non-goals, edge cases, validation commands, or implementation structure; repository investigation and repository-specific plan derivation belong to the isolated planner.

This lossless rule applies generically to complete authoritative sources, not only one tracker or provider. Ordinary conversational planning without an explicitly identified complete authoritative source retains bounded task formulation and must not copy the whole conversation. A missing or referenced source, explicitly incomplete source, explicitly summarized source, or explicitly non-authoritative context is not complete authority and retains the existing retrieval or clarification behavior; do not silently promote it to byte-preserved source content. Never copy arbitrary parent conversation history or rely on a source that exists only in an inaccessible parent message. If a hard host payload or context limit prevents safely carrying a complete authoritative source, fail closed with bounded input or clarification rather than silently compressing, summarizing, or truncating it. When complete source contents are present, the planner uses them directly and does not redundantly re-fetch them solely for duplication or verification.

Compatibility limitation: this is the strongest currently supported prompt-level fallback, not a host-typed or immutable payload, collision-proof parser, or semantic sandbox. The delimiters are convention only; they do not make source bytes trusted or prevent model-level prompt injection. Do not replace this fallback with a guessed adapter or claim mechanical preservation until a supported OpenCode mechanism passes fresh end-to-end dogfood.

For every substantial non-trivial change-planning request, and for every material refinement, delegate only to the generated \`planner\` subagent. Accept only its bounded \`PlannerHandoff\` (\`plan_id\`, revision, status, summary, questions, and risks). For refinement, send the exact plan identity, exact base revision, and bounded user feedback; never paste or reconstruct the old full plan. Do not call planner-side plan creation, reading, or revision operations yourself, and do not edit, run bash, implement, create workflows, or dispatch implementation workers.

When the planner returns \`needs_input\`, present that handoff's semantic questions and bounded risks to the user once for that handoff. Do not invoke a question tool, directly ask through a tool, or re-invoke the planner without new user input. After the user supplies a bounded answer or context, delegate a fresh refinement with only that answer/context, the exact \`plan_id\`, and the exact base revision from the handoff; do not paste the old plan or retain a same-child, task, session, invocation, or host-lifecycle continuation. If the answer or identity/base is missing, stale, malformed, conflicting, or ambiguous, stop without guessing or revising.

When the planner reports \`ready_for_approval\`, use \`workflow_state_plan_parent_get\` to retrieve the exact returned plan ID and revision. Verify that the result is the current requested draft revision and stop with bounded input on missing, stale, historical, malformed, conflicting, or \`needs_input\` state. Present the authoritative \`full_plan\` character-for-character as Markdown: do not paraphrase, normalize, reorder, truncate, wrap, or substitute the summary. Clearly label an unapproved artifact as a draft awaiting approval. After rendering it, add a concise CTA separately, outside the authoritative \`full_plan\`, offering natural-language approval of that exact displayed candidate or a natural-language revision request; never put CTA text inside or alter the \`full_plan\`.

Wait for an explicit user instruction approving that exact plan ID and revision. Then parent-read the same exact identity again and call \`workflow_state_plan_approve\` with that identity and bounded authorization only. Never create a workflow or dispatch an implementer. After approval, report the exact plan ID and revision so the user can switch to Orchestrator and name them for execution. Plan approval is separate from workflow and commit authorization.`;

export const OPENCODE_PLAN_PERMISSION = {
  edit: "deny",
  bash: "deny",
  question: "deny",
  task: { "*": "deny", planner: "allow", explorer: "allow" },
  "workflow_state_*": "deny",
  workflow_state_plan_parent_get: "allow",
  workflow_state_plan_approve: "allow",
} as const;

export function openCodePlanAgent(): Record<string, unknown> {
  return {
    prompt: OPENCODE_PLAN_PROMPT,
    permission: {
      edit: OPENCODE_PLAN_PERMISSION.edit,
      bash: OPENCODE_PLAN_PERMISSION.bash,
      question: OPENCODE_PLAN_PERMISSION.question,
      task: { ...OPENCODE_PLAN_PERMISSION.task },
      "workflow_state_*": OPENCODE_PLAN_PERMISSION["workflow_state_*"],
      workflow_state_plan_parent_get: OPENCODE_PLAN_PERMISSION.workflow_state_plan_parent_get,
      workflow_state_plan_approve: OPENCODE_PLAN_PERMISSION.workflow_state_plan_approve,
    },
  };
}

export function materializeAgentDefinitions(
  sourceRoot: string,
  codexDestination: string,
  opencodeDestination: string,
  manifest?: readonly GeneratedAgentDefinition[],
): readonly GeneratedAgentDefinition[] {
  const definitions =
    manifest ??
    generateDefinitionManifest({
      policyPath: resolve(sourceRoot, ".codex/agents/model-policy.yaml"),
      contractsDir: resolve(sourceRoot, ".codex/agents/contracts"),
      codexWorkflowMcp: enabledCodexWorkflowMcp(
        resolve(sourceRoot, ".codex/workflow-mcp/server.ts"),
      ),
    });
  for (const definition of definitions) {
    const destination = definition.host === "codex" ? codexDestination : opencodeDestination;
    writeFileSync(resolve(destination, definition.filename), definition.content);
  }
  return definitions;
}

function error(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function usage(): never {
  process.stderr.write("Usage: install-into.ts /absolute/path/to/target-repository\n");
  process.exit(2);
}

function bunVersionAtLeast(minimum: readonly number[]): boolean {
  const parts = Bun.version.split(".").map((part) => Number(part));
  if (parts.length < minimum.length || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}

function tomlString(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") {
      throw new Error("path cannot be represented in TOML");
    }
  }
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function registrationBlock(projectRoot: string): string {
  const command = providerServerCommand(resolve(projectRoot, ".codex/workflow-mcp/server.ts"));
  return [
    "# Local durable state for the reusable custom-agent workflow.",
    "[mcp_servers.workflow_state]",
    `command = ${tomlString(command[0])}`,
    `args = [${command.slice(1).map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 10",
    "tool_timeout_sec = 30",
    "required = false",
    'default_tools_approval_mode = "prompt"',
    "",
  ].join("\n");
}

export function hasWorkflowStateRegistration(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  let parsed: unknown;
  try {
    parsed = TOML.parse(readFileSync(configPath, "utf8"));
  } catch {
    error(`Existing config is not valid TOML; refusing to modify: ${configPath}`);
  }
  let section: unknown = parsed;
  for (const key of REGISTRATION_SECTION) {
    section = (section as Record<string, unknown> | null)?.[key];
    if (section === undefined || section === null) return false;
  }
  return section !== undefined && section !== null;
}

interface CommitStep {
  staging: string;
  target: string;
  original: string | null;
  originalDir: string | null;
}

export type OpenCodeAgentsBackupState = "unused" | "in-use" | "restored" | "unrecoverable";

export interface CommitRecoveryState {
  openCodeAgentsBackup: OpenCodeAgentsBackupState;
}

export interface OptionalProjectFile {
  staging: string;
  target: string;
  original: string | null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Rollback is itself failure-prone; a swallowed restore failure can destroy the
// only copy of pre-existing data. Every rollback step reports its failures so
// the caller can surface them together with the original install failure.
function rollback(
  committed: readonly CommitStep[],
  rename: (from: string, to: string) => void = renameSync,
  writeFile: (path: string, content: string) => void = writeFileSync,
  recoveryState?: CommitRecoveryState,
): Error[] {
  const failures: Error[] = [];
  for (const step of committed.slice().reverse()) {
    if (step.originalDir !== null) {
      try {
        rmSync(step.target, { recursive: true, force: true });
      } catch (cause) {
        failures.push(
          new Error(`failed to remove ${step.target}: ${errorMessage(cause)}`, { cause }),
        );
      }
      try {
        rename(step.originalDir, step.target);
        if (recoveryState !== undefined) {
          recoveryState.openCodeAgentsBackup = "restored";
        }
      } catch (cause) {
        if (recoveryState !== undefined) {
          recoveryState.openCodeAgentsBackup = "unrecoverable";
        }
        failures.push(
          new Error(
            `failed to restore ${step.target} from ${step.originalDir}: ${errorMessage(cause)}`,
            { cause },
          ),
        );
      }
    } else if (step.original === null) {
      try {
        rmSync(step.target, { recursive: true, force: true });
      } catch (cause) {
        failures.push(
          new Error(`failed to remove ${step.target}: ${errorMessage(cause)}`, { cause }),
        );
      }
    } else {
      try {
        writeFile(step.target, step.original);
      } catch (cause) {
        const recoveryPath = `${step.target}.recover`;
        let recovery: string;
        try {
          writeFileSync(recoveryPath, step.original);
          recovery = `; original content preserved at ${recoveryPath}`;
        } catch {
          recovery = "; original content could not be preserved";
        }
        failures.push(
          new Error(`failed to restore ${step.target}: ${errorMessage(cause)}${recovery}`, {
            cause,
          }),
        );
      }
    }
  }
  return failures;
}

export function commitBothHosts(
  codexAgentsStaging: string,
  codexAgentsTarget: string,
  codexConfigStaging: string,
  codexConfigTarget: string,
  opencodeAgentsStaging: string,
  opencodeAgentsTarget: string,
  opencodeConfigStaging: string,
  opencodeConfigTarget: string,
  originalCodexConfig: string | null,
  originalOpenCodeConfig: string | null,
  originalOpenCodeAgentsDir: string | null = null,
  rename: (from: string, to: string) => void = renameSync,
  writeFile: (path: string, content: string) => void = writeFileSync,
  recoveryState: CommitRecoveryState = { openCodeAgentsBackup: "unused" },
  projectFile?: OptionalProjectFile,
): void {
  const steps: readonly CommitStep[] = [
    { staging: codexAgentsStaging, target: codexAgentsTarget, original: null, originalDir: null },
    {
      staging: codexConfigStaging,
      target: codexConfigTarget,
      original: originalCodexConfig,
      originalDir: null,
    },
    {
      staging: opencodeAgentsStaging,
      target: opencodeAgentsTarget,
      original: null,
      originalDir: originalOpenCodeAgentsDir,
    },
    {
      staging: opencodeConfigStaging,
      target: opencodeConfigTarget,
      original: originalOpenCodeConfig,
      originalDir: null,
    },
    ...(projectFile === undefined
      ? []
      : [
          {
            staging: projectFile.staging,
            target: projectFile.target,
            original: projectFile.original,
            originalDir: null,
          },
        ]),
  ];
  const committed: CommitStep[] = [];
  try {
    for (const step of steps) {
      // A pre-existing directory cannot be atomically renamed over; remove it
      // first and rely on the backup snapshot for restore on any later failure.
      if (step.originalDir !== null) {
        rmSync(step.target, { recursive: true, force: true });
        recoveryState.openCodeAgentsBackup = "in-use";
      }
      rename(step.staging, step.target);
      committed.push(step);
    }
  } catch (cause) {
    const failures = rollback(committed, rename, writeFile, recoveryState);
    const failing = steps[committed.length];
    if (failing !== undefined && failing.originalDir !== null) {
      try {
        rename(failing.originalDir, failing.target);
        recoveryState.openCodeAgentsBackup = "restored";
      } catch (restoreCause) {
        recoveryState.openCodeAgentsBackup = "unrecoverable";
        failures.push(
          new Error(
            `failed to restore ${failing.target} from ${failing.originalDir}: ${errorMessage(restoreCause)}`,
            { cause: restoreCause },
          ),
        );
      }
    }
    if (failures.length === 0) {
      throw cause;
    }
    throw new Error(
      `${errorMessage(cause)}\nRollback was incomplete:\n${failures.map((failure) => `- ${failure.message}`).join("\n")}`,
      { cause },
    );
  }
}

export function cleanupOpenCodeAgentsBackup(
  backup: string | null,
  recoveryState: CommitRecoveryState,
  remove: (path: string) => void = (path) => rmSync(path, { recursive: true, force: true }),
  exists: (path: string) => boolean = existsSync,
  report: (message: string) => void = (message) => process.stderr.write(`${message}\n`),
): void {
  if (backup === null) return;
  if (recoveryState.openCodeAgentsBackup === "unrecoverable") {
    if (exists(backup)) {
      report(
        `Rollback could not restore the original OpenCode agents; the backup remains at: ${backup}`,
      );
    }
    return;
  }
  remove(backup);
}

function isGitRepository(target: string): boolean {
  const result = spawnSync(["git", "-C", target, "rev-parse", "--show-toplevel"], {
    cwd: target,
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0 && result.stdout.toString().trim().length > 0;
}

function parseJsoncConfig(configPath: string, text: string): unknown {
  const errors: ParseError[] = [];
  const strict = configPath.endsWith(".json");
  const parsed = parseJsonc(text, errors, {
    disallowComments: strict,
    allowTrailingComma: !strict,
  });
  if (errors.length > 0) {
    error(
      `Existing config is not valid ${strict ? "JSON" : "JSONC"}; refusing to modify: ${configPath}`,
    );
  }
  return parsed;
}

function objectValue(value: unknown, context: string): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    error(`${context} must be an object; refusing to modify the existing OpenCode config`);
  }
  return value as Record<string, unknown>;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (left && right && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          deepEqual(
            (left as Record<string, unknown>)[key],
            (right as Record<string, unknown>)[key],
          ),
      )
    );
  }
  return false;
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

function withoutKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return keys.reduce((result, key) => withoutKey(result, key), { ...value });
}

function shellString(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function trustedBootstrapCommand(serverPath: string): string[] {
  const bootstrapPath = serverPath.replaceAll("\\", "/");
  const suffix = "/.codex/workflow-mcp/bootstrap.ts";
  const providerRoot = bootstrapPath.endsWith(suffix)
    ? bootstrapPath.slice(0, -suffix.length) || "."
    : ".";
  const rootPrefix =
    providerRoot === "."
      ? 'export WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT="$PWD"; '
      : `export WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT=${shellString(providerRoot)}; `;
  const gitRoot = providerRoot === "." ? "" : `-C ${shellString(providerRoot)} `;
  return [
    "sh",
    "-c",
    `${rootPrefix}bootstrap=$(mktemp) && trap 'rm -f "$bootstrap"' EXIT && git ${gitRoot}show HEAD:.codex/workflow-mcp/bootstrap.ts >"$bootstrap" && bun --no-warnings "$bootstrap"; status=$?; exit "$status"`,
  ];
}

export function providerServerCommand(serverPath: string): string[] {
  return ["bun", resolve(serverPath)];
}

export function openCodeMcpRegistration(serverPath: string): Record<string, unknown> {
  return {
    type: "local",
    command: providerServerCommand(serverPath),
    enabled: true,
    timeout: 30000,
  };
}

export function createOpenCodeConfig(serverPath: string): string {
  return `${JSON.stringify(
    {
      $schema: OPENCODE_CONFIG_SCHEMA,
      default_agent: OPENCODE_DEFAULT_AGENT,
      subagent_depth: OPENCODE_SUBAGENT_DEPTH,
      agent: { plan: openCodePlanAgent() },
      mcp: { [OPENCODE_SERVER_NAME]: openCodeMcpRegistration(serverPath) },
    },
    null,
    2,
  )}\n`;
}

export function stageOpenCodeConfig(
  configPath: string,
  existing: string | null,
  serverPath: string,
): string {
  if (existing === null) return createOpenCodeConfig(serverPath);
  const parsedRoot = parseJsoncConfig(configPath, existing);
  const parsedExisting = objectValue(parsedRoot, "config") ?? {};
  if (Object.hasOwn(parsedExisting, "agent")) {
    const agent = parsedExisting.agent;
    if (agent === null || typeof agent !== "object" || Array.isArray(agent)) {
      error(
        `${configPath} agent must be an object; refusing to modify the existing OpenCode config`,
      );
    }
    if (Object.hasOwn(agent as Record<string, unknown>, "plan")) {
      const plan = (agent as Record<string, unknown>).plan;
      if (plan === null || typeof plan !== "object" || Array.isArray(plan)) {
        error(
          `${configPath} agent.plan must be an object; refusing to modify the existing OpenCode config`,
        );
      }
    }
  }
  if (Object.hasOwn(parsedExisting, "mcp")) {
    const mcp = objectValue(parsedExisting.mcp, "mcp");
    if (mcp !== null && Object.hasOwn(mcp, OPENCODE_SERVER_NAME)) {
      error(`Refusing to replace existing OpenCode workflow_state registration: ${configPath}`);
    }
  }
  const formattingOptions = {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  };
  let staged = existing;
  if (!Object.hasOwn(parsedExisting, "default_agent")) {
    staged = applyEdits(
      staged,
      modify(staged, ["default_agent"], OPENCODE_DEFAULT_AGENT, formattingOptions),
    );
  }
  if (!Object.hasOwn(parsedExisting, "subagent_depth")) {
    staged = applyEdits(
      staged,
      modify(staged, ["subagent_depth"], OPENCODE_SUBAGENT_DEPTH, formattingOptions),
    );
  }
  if (!Object.hasOwn(parsedExisting, "agent")) {
    staged = applyEdits(
      staged,
      modify(staged, ["agent"], { plan: openCodePlanAgent() }, formattingOptions),
    );
  } else if (!Object.hasOwn(parsedExisting.agent as Record<string, unknown>, "plan")) {
    staged = applyEdits(
      staged,
      modify(staged, ["agent", "plan"], openCodePlanAgent(), formattingOptions),
    );
  }
  staged = applyEdits(
    staged,
    modify(
      staged,
      ["mcp", OPENCODE_SERVER_NAME],
      openCodeMcpRegistration(serverPath),
      formattingOptions,
    ),
  );
  const parsedStaged = objectValue(parseJsoncConfig(configPath, staged), "staged config");
  const stagedRecord = parsedStaged ?? {};
  if (
    !deepEqual(
      withoutKeys(parsedExisting, ["mcp", "default_agent", "subagent_depth", "agent"]),
      withoutKeys(stagedRecord, ["mcp", "default_agent", "subagent_depth", "agent"]),
    )
  ) {
    error(
      `Staged OpenCode config would alter unrelated settings; refusing to install: ${configPath}`,
    );
  }
  const existingMcp = objectValue(parsedExisting.mcp, "mcp") ?? {};
  const stagedMcp = objectValue(stagedRecord.mcp, "mcp") ?? {};
  if (
    !deepEqual(
      withoutKey(existingMcp, OPENCODE_SERVER_NAME),
      withoutKey(stagedMcp, OPENCODE_SERVER_NAME),
    )
  ) {
    error(
      `Staged OpenCode config would alter unrelated MCP settings; refusing to install: ${configPath}`,
    );
  }
  if (!deepEqual(stagedMcp[OPENCODE_SERVER_NAME], openCodeMcpRegistration(serverPath))) {
    error(
      `Staged OpenCode workflow_state registration is invalid; refusing to install: ${configPath}`,
    );
  }
  const existingAgent = Object.hasOwn(parsedExisting, "agent")
    ? (parsedExisting.agent as Record<string, unknown>)
    : {};
  const stagedAgent = objectValue(stagedRecord.agent, "staged agent") ?? {};
  if (!deepEqual(withoutKey(existingAgent, "plan"), withoutKey(stagedAgent, "plan"))) {
    error(
      `Staged OpenCode agent settings would alter unrelated entries; refusing to install: ${configPath}`,
    );
  }
  const expectedPlan = Object.hasOwn(existingAgent, "plan")
    ? existingAgent.plan
    : openCodePlanAgent();
  if (!deepEqual(stagedAgent.plan, expectedPlan)) {
    error(
      `Staged OpenCode agent.plan would alter the existing preference; refusing to install: ${configPath}`,
    );
  }
  const expectedDefaultAgent = Object.hasOwn(parsedExisting, "default_agent")
    ? parsedExisting.default_agent
    : OPENCODE_DEFAULT_AGENT;
  if (!deepEqual(stagedRecord.default_agent, expectedDefaultAgent)) {
    error(
      `Staged OpenCode default_agent would alter the existing preference; refusing to install: ${configPath}`,
    );
  }
  const expectedSubagentDepth = Object.hasOwn(parsedExisting, "subagent_depth")
    ? parsedExisting.subagent_depth
    : OPENCODE_SUBAGENT_DEPTH;
  if (!deepEqual(stagedRecord.subagent_depth, expectedSubagentDepth)) {
    error(
      `Staged OpenCode subagent_depth would alter the existing preference; refusing to install: ${configPath}`,
    );
  }
  if (configPath.endsWith(".json")) {
    try {
      JSON.parse(staged);
    } catch (cause) {
      error(
        `Staged OpenCode config is not valid JSON; refusing to install: ${configPath} (${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  }
  return staged;
}

export function hasOpenCodeWorkflowStateRegistration(configPath: string): boolean {
  if (!existsSync(configPath)) return false;
  const parsed = objectValue(
    parseJsoncConfig(configPath, readFileSync(configPath, "utf8")),
    "config",
  );
  const mcp = parsed === null ? undefined : parsed.mcp;
  if (mcp === undefined || mcp === null) return false;
  if (typeof mcp !== "object" || Array.isArray(mcp)) return false;
  return Object.hasOwn(mcp, OPENCODE_SERVER_NAME);
}

export function findOpenCodeConfig(target: string): string | null {
  const json = resolve(target, "opencode.json");
  const jsonc = resolve(target, "opencode.jsonc");
  const hasJson = existsSync(json);
  const hasJsonc = existsSync(jsonc);
  if (hasJson && hasJsonc) {
    error(`Both opencode.json and opencode.jsonc exist; refusing to modify either: ${target}`);
  }
  return hasJsonc ? jsonc : hasJson ? json : null;
}

export function main(args: readonly string[]): number {
  if (args.length !== 1) {
    usage();
  }
  const projectRoot = realpathSync(import.meta.dir);
  const target = resolve(args[0]);

  if (!isGitRepository(target)) {
    error(`Target is not a Git repository: ${target}`);
  }
  if (existsSync(resolve(target, ".codex/agents"))) {
    error(`Refusing to replace existing agent definitions: ${target}/.codex/agents`);
  }
  const config = resolve(target, ".codex/config.toml");
  if (hasWorkflowStateRegistration(config)) {
    error(`Refusing to replace existing workflow_state registration: ${config}`);
  }
  const opencodeAgentsTarget = resolve(target, ".opencode/agents");
  const opencodeAgentsExisting = existsSync(opencodeAgentsTarget);
  const opencodeConfig = findOpenCodeConfig(target);
  if (opencodeConfig !== null && hasOpenCodeWorkflowStateRegistration(opencodeConfig)) {
    error(`Refusing to replace existing OpenCode workflow_state registration: ${opencodeConfig}`);
  }
  if (!bunVersionAtLeast(MINIMUM_BUN)) {
    error(
      `Bun ${MINIMUM_BUN.join(".")} or newer is required to run the workflow_state server; found ${Bun.version}.`,
    );
  }
  for (const file of REQUIRED_SOURCE_FILES) {
    if (!existsSync(resolve(projectRoot, file))) {
      error(`Required agent definition missing: ${projectRoot}/${file}`);
    }
  }
  let generatedManifest: readonly GeneratedAgentDefinition[];
  const serverPath = resolve(projectRoot, ".codex/workflow-mcp/server.ts");
  try {
    generatedManifest = generateDefinitionManifest({
      policyPath: resolve(projectRoot, ".codex/agents/model-policy.yaml"),
      contractsDir: resolve(projectRoot, ".codex/agents/contracts"),
      codexWorkflowMcp: enabledCodexWorkflowMcp(serverPath),
    });
  } catch (cause) {
    error(
      `Unable to materialize agent definitions: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (opencodeAgentsExisting) {
    for (const definition of generatedManifest.filter((item) => item.host === "opencode")) {
      if (existsSync(resolve(opencodeAgentsTarget, definition.filename))) {
        error(
          `Refusing to replace existing OpenCode agent definitions: ${resolve(opencodeAgentsTarget, definition.filename)}`,
        );
      }
    }
    if (existsSync(resolve(opencodeAgentsTarget, "orchestrator.md"))) {
      error(
        `Refusing to replace existing OpenCode agent definitions: ${resolve(opencodeAgentsTarget, "orchestrator.md")}`,
      );
    }
  }
  try {
    tomlString(resolve(projectRoot, ".codex/workflow-mcp/bootstrap.ts"));
  } catch {
    error(`Project path cannot be represented safely in TOML: ${projectRoot}`);
  }
  const existing = existsSync(config) ? `${readFileSync(config, "utf8")}\n` : "";
  const stagedContent = existing + registrationBlock(projectRoot);
  try {
    TOML.parse(stagedContent);
  } catch (cause) {
    error(
      `Staged config is not valid TOML; refusing to install: ${config} (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  const opencodeConfigTarget = opencodeConfig ?? resolve(target, "opencode.json");
  const opencodeConfigOriginal =
    opencodeConfig === null ? null : readFileSync(opencodeConfig, "utf8");
  const reviewerPolicyTarget = resolve(target, ".codex/reviewer-validation.json");
  const reviewerPolicyOriginal = existsSync(reviewerPolicyTarget)
    ? readFileSync(reviewerPolicyTarget, "utf8")
    : null;
  const stagedOpenCode = stageOpenCodeConfig(
    opencodeConfigTarget,
    opencodeConfigOriginal,
    serverPath,
  );

  mkdirSync(resolve(target, ".codex"), { recursive: true });
  mkdirSync(resolve(target, ".opencode"), { recursive: true });
  const agentsStaging = mkdtempSync(resolve(target, ".codex/.agents.install."));
  const configStaging = mkdtempSync(resolve(target, ".codex/.config.install."));
  const opencodeAgentsStaging = mkdtempSync(resolve(target, ".opencode/.agents.install."));
  const opencodeConfigStaging = mkdtempSync(resolve(target, ".opencode/.config.install."));
  const reviewerPolicyStaging = mkdtempSync(
    resolve(target, ".codex/.reviewer-validation.install."),
  );
  let opencodeAgentsBackup: string | null = null;
  const recoveryState: CommitRecoveryState = { openCodeAgentsBackup: "unused" };
  try {
    for (const file of COPY_SOURCE_FILES) {
      if (existsSync(resolve(projectRoot, file))) {
        cpSync(
          resolve(projectRoot, file),
          resolve(agentsStaging, file.slice(".codex/agents/".length)),
        );
      }
    }
    materializeAgentDefinitions(
      projectRoot,
      agentsStaging,
      opencodeAgentsStaging,
      generatedManifest,
    );
    if (reviewerPolicyOriginal === null) {
      cpSync(
        resolve(projectRoot, ".codex/reviewer-validation.json"),
        resolve(reviewerPolicyStaging, "reviewer-validation.json"),
      );
    }
    if (opencodeAgentsExisting) {
      cpSync(opencodeAgentsTarget, opencodeAgentsStaging, { recursive: true });
      opencodeAgentsBackup = mkdtempSync(resolve(target, ".opencode/.agents.backup."));
      cpSync(opencodeAgentsTarget, opencodeAgentsBackup, { recursive: true });
    }
    for (const file of OPENCODE_COPY_SOURCE_FILES) {
      if (existsSync(resolve(projectRoot, file))) {
        cpSync(
          resolve(projectRoot, file),
          resolve(opencodeAgentsStaging, file.slice(".opencode/agents/".length)),
        );
      }
    }
    const stagedConfig = resolve(configStaging, "config.toml");
    writeFileSync(stagedConfig, stagedContent);
    const stagedOpenCodePath = resolve(opencodeConfigStaging, basename(opencodeConfigTarget));
    writeFileSync(stagedOpenCodePath, stagedOpenCode);
    commitBothHosts(
      agentsStaging,
      resolve(target, ".codex/agents"),
      stagedConfig,
      config,
      opencodeAgentsStaging,
      opencodeAgentsTarget,
      stagedOpenCodePath,
      opencodeConfigTarget,
      existing === "" ? null : existing.replace(/\n$/, ""),
      opencodeConfigOriginal,
      opencodeAgentsBackup,
      renameSync,
      writeFileSync,
      recoveryState,
      reviewerPolicyOriginal === null
        ? {
            staging: resolve(reviewerPolicyStaging, "reviewer-validation.json"),
            target: reviewerPolicyTarget,
            original: null,
          }
        : undefined,
    );
  } catch (cause) {
    rmSync(agentsStaging, { recursive: true, force: true });
    rmSync(configStaging, { recursive: true, force: true });
    rmSync(opencodeAgentsStaging, { recursive: true, force: true });
    rmSync(opencodeConfigStaging, { recursive: true, force: true });
    rmSync(reviewerPolicyStaging, { recursive: true, force: true });
    cleanupOpenCodeAgentsBackup(opencodeAgentsBackup, recoveryState);
    throw cause;
  }
  rmSync(configStaging, { recursive: true, force: true });
  rmSync(opencodeConfigStaging, { recursive: true, force: true });
  rmSync(reviewerPolicyStaging, { recursive: true, force: true });
  if (opencodeAgentsBackup !== null) {
    rmSync(opencodeAgentsBackup, { recursive: true, force: true });
  }

  process.stdout.write(
    `Installed Codex agents and workflow_state MCP registration into: ${target}\n`,
  );
  process.stdout.write(
    `Installed OpenCode agents and workflow_state MCP registration into: ${target}\n`,
  );
  process.stdout.write("Restart or reload Codex, then run: codex mcp get workflow_state\n");
  process.stdout.write(
    "Restart or reload OpenCode, then verify the workflow_state tools are visible in a session.\n",
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
