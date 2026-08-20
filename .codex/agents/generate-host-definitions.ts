#!/usr/bin/env bun
// Generates the host-specific agent definitions from the canonical contract
// fragments in .codex/agents/contracts/. Codex TOML and OpenCode Markdown are
// adapters over the same host-neutral contract prose; this generator is the
// single place where host frontmatter (models, permissions, sandbox modes) is
// declared, and .codex/agents/tests/contract-consistency.test.ts fails when the
// checked-in generated files drift from this output.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const CONTRACTS_DIR = resolve(ROOT, "contracts");
const CODEX_AGENTS_DIR = resolve(ROOT);
const OPENCODE_AGENTS_DIR = resolve(ROOT, "../../.opencode/agents");

interface CodexConfig {
  model: string;
  reasoningEffort: string;
  sandboxMode: string;
}

interface OpenCodeConfig {
  description: string;
  model: string;
  reasoningEffort?: string;
  permission: string[];
  // OpenCode-only runtime handoff: the MCP tool that carries the authoritative
  // workflow-state submission and the label of the required final report the
  // agent must write after that tool call succeeds.
  terminalTool: string;
  finalReportLabel: string;
}

interface RoleSpec {
  name: string;
  description: string;
  codex: CodexConfig;
  opencode: OpenCodeConfig;
}

const ROLES: readonly RoleSpec[] = [
  {
    name: "implementer",
    description:
      "Executes an approved implementation plan, validates the changes, and reports the results.",
    codex: { model: "gpt-5.6-luna", reasoningEffort: "high", sandboxMode: "workspace-write" },
    opencode: {
      description:
        "Executes an approved implementation plan, validates the changes, and reports the results.",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      permission: [
        "  edit: allow",
        "  bash:",
        // Broad bash for validation, with explicit denies for the Git/history
        // operations the contract forbids. Rules match last-match-wins, so the
        // denies must follow the catch-all allow.
        '    "*": allow',
        '    "git add": deny',
        '    "git add *": deny',
        '    "git commit": deny',
        '    "git commit *": deny',
        '    "git push": deny',
        '    "git push *": deny',
        '    "git reset": deny',
        '    "git reset *": deny',
        '    "git rebase": deny',
        '    "git rebase *": deny',
        '    "git checkout": deny',
        '    "git checkout *": deny',
        '    "git switch": deny',
        '    "git switch *": deny',
        '    "git restore": deny',
        '    "git restore *": deny',
        '    "git revert": deny',
        '    "git revert *": deny',
        '    "git cherry-pick": deny',
        '    "git cherry-pick *": deny',
        '    "git rm": deny',
        '    "git rm *": deny',
        '    "git mv": deny',
        '    "git mv *": deny',
        '    "git clean": deny',
        '    "git clean *": deny',
        '    "git stash": deny',
        '    "git stash *": deny',
        "  task:",
        '    "*": deny',
        // Defense in depth: the server-side role capability check stays
        // authoritative; exposing only this role's tools reduces context.
        "  workflow_state_*: deny",
        "  workflow_state_workflow_get: allow",
        "  workflow_state_workflow_submit_implementation: allow",
      ],
      terminalTool: "workflow_submit_implementation",
      finalReportLabel: "final implementation report",
    },
  },
  {
    name: "code_reviewer",
    description: "Performs an independent, read-only review of an approved implementation diff.",
    codex: { model: "gpt-5.6-sol", reasoningEffort: "medium", sandboxMode: "read-only" },
    opencode: {
      description: "Performs an independent, read-only review of an approved implementation diff.",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      permission: [
        // OpenCode permissions are not equivalent to the Codex read-only
        // filesystem sandbox; edit denial plus a narrow bash allowlist is the
        // closest equivalent and must stay fail-closed.
        "  edit: deny",
        "  bash:",
        '    "*": deny',
        '    "git status": allow',
        '    "git status *": allow',
        '    "git diff": allow',
        '    "git diff *": allow',
        '    "git log": allow',
        '    "git log *": allow',
        '    "git show *": allow',
        '    "git rev-parse *": allow',
        '    "git grep": allow',
        '    "git grep *": allow',
        '    "bun .codex/agents/change-receipt.ts *": allow',
        '    "bun .codex/agents/reviewer-validation.ts *": allow',
        "  task:",
        '    "*": deny',
        "  workflow_state_*: deny",
        "  workflow_state_workflow_get: allow",
        "  workflow_state_workflow_begin_review: allow",
        "  workflow_state_workflow_submit_review: allow",
      ],
      terminalTool: "workflow_submit_review",
      finalReportLabel: "final review report",
    },
  },
  {
    name: "committer",
    description:
      "Stages relevant project changes, generates an accurate commit message, and creates a Git commit.",
    codex: { model: "gpt-5.6-luna", reasoningEffort: "medium", sandboxMode: "workspace-write" },
    opencode: {
      description:
        "Stages relevant project changes, generates an accurate commit message, and creates a Git commit.",
      model: "openai/gpt-5.6-luna",
      reasoningEffort: "high",
      permission: [
        // edit denial is stricter than the Codex workspace-write sandbox: the
        // committer must never modify source files. bash fails closed with an
        // allowlist for the documented commit flow, and the specific denies
        // follow the allows so last-match-wins applies.
        "  edit: deny",
        "  bash:",
        '    "*": deny',
        '    "git status": allow',
        '    "git status *": allow',
        '    "git diff": allow',
        '    "git diff *": allow',
        '    "git log": allow',
        '    "git log *": allow',
        '    "git show *": allow',
        '    "git rev-parse": allow',
        '    "git rev-parse *": allow',
        '    "git ls-files": allow',
        '    "git ls-files *": allow',
        '    "git add *": allow',
        '    "git commit": allow',
        '    "git commit *": allow',
        '    "bun .codex/agents/change-receipt.ts *": allow',
        '    "git add -p": deny',
        '    "git add -p *": deny',
        '    "git add -i": deny',
        '    "git add -i *": deny',
        '    "git commit --amend": deny',
        '    "git commit --amend *": deny',
        '    "git push": deny',
        '    "git push *": deny',
        '    "git rebase": deny',
        '    "git rebase *": deny',
        '    "git reset": deny',
        '    "git reset *": deny',
        '    "git checkout": deny',
        '    "git checkout *": deny',
        '    "git switch": deny',
        '    "git switch *": deny',
        '    "git restore": deny',
        '    "git restore *": deny',
        '    "git rm": deny',
        '    "git rm *": deny',
        '    "git mv": deny',
        '    "git mv *": deny',
        '    "git clean": deny',
        '    "git clean *": deny',
        '    "git stash": deny',
        '    "git stash *": deny',
        "  task:",
        '    "*": deny',
        "  workflow_state_*: deny",
        "  workflow_state_workflow_get: allow",
        "  workflow_state_workflow_prepare_commit: allow",
        "  workflow_state_workflow_submit_commit_result: allow",
      ],
      terminalTool: "workflow_submit_commit_result",
      finalReportLabel: "final commit report",
    },
  },
];

function tomlEscape(value: string): string {
  if (value.includes('"""')) {
    throw new Error(`contract body contains a TOML terminator: ${value}`);
  }
  return value.replace(/\\/g, "\\\\");
}

// Model/reasoning identity is host-specific metadata; the shared contract
// prose carries this marker and each host injects its own identity line.
const HOST_IDENTITY_MARKER = "__HOST_IDENTITY__";

// OpenCode-only terminal-response section appended after the shared contract
// body by opencodeTerminalHandoff. Exported so the consistency test can strip
// it before the Codex/OpenCode equivalence comparison and assert its presence
// and absence respectively. Codex TOML never carries this section.
export const OPENCODE_TERMINAL_SECTION_HEADING = "## Required terminal response (OpenCode-only)";

function injectHostIdentity(body: string, identity: string, role: string): string {
  if (!body.includes(HOST_IDENTITY_MARKER)) {
    throw new Error(`contract for ${role} is missing the ${HOST_IDENTITY_MARKER} identity marker`);
  }
  return body.replace(HOST_IDENTITY_MARKER, identity);
}

function codexToml(spec: RoleSpec, body: string): string {
  const header = [
    `name = "${spec.name}"`,
    `description = "${spec.description}"`,
    `model = "${spec.codex.model}"`,
    `model_reasoning_effort = "${spec.codex.reasoningEffort}"`,
    `sandbox_mode = "${spec.codex.sandboxMode}"`,
  ].join("\n");
  const identity = `${spec.codex.model} | Reasoning: ${spec.codex.reasoningEffort}`;
  return `${header}\n\ndeveloper_instructions = """\n${tomlEscape(injectHostIdentity(body, identity, spec.name))}\n"""\n`;
}

function opencodeMarkdown(spec: RoleSpec, body: string): string {
  const frontmatter = [
    "---",
    `description: ${spec.opencode.description}`,
    "mode: subagent",
    `model: ${spec.opencode.model}`,
    ...(spec.opencode.reasoningEffort ? [`reasoningEffort: ${spec.opencode.reasoningEffort}`] : []),
    "permission:",
    ...spec.opencode.permission,
    "---",
  ].join("\n");
  const contract = injectHostIdentity(body, spec.opencode.model, spec.name);
  return `${frontmatter}\n${contract}${opencodeTerminalHandoff(spec)}\n`;
}

// OpenCode-only runtime ordering section appended after the shared contract
// body. It does not restate contract behavior; it pins the host-specific
// requirement that the agent always ends with a non-empty normal assistant
// text response after (not instead of) its terminal MCP submission call. Codex
// TOML output must remain byte-identical, so this never touches codexToml.
function opencodeTerminalHandoff(spec: RoleSpec): string {
  const { terminalTool, finalReportLabel } = spec.opencode;
  const failureClause =
    spec.name === "committer"
      ? " The report is required whether the commit succeeded or failed."
      : "";
  return [
    "",
    "",
    OPENCODE_TERMINAL_SECTION_HEADING,
    "",
    "Every subagent invocation must terminate with a non-empty normal assistant text response.",
    "A successful MCP tool call is never itself the final response, and an empty final report is",
    "never acceptable.",
    "",
    `The MCP submission (\`${terminalTool}\`) is the authoritative machine-readable workflow-state`,
    "handoff; the final assistant response is the parent-agent handoff. Both are required and",
    "neither replaces the other.",
    "",
    `Ordering: complete the role work first, then call \`${terminalTool}\`, and only after it succeeds`,
    `write the ${finalReportLabel} as a non-empty normal assistant text response. Do not end`,
    `immediately after the tool call.${failureClause}`,
  ].join("\n");
}

export interface GeneratedDefinitions {
  [path: string]: string;
}

export function generateDefinitions(): GeneratedDefinitions {
  const definitions: GeneratedDefinitions = {};
  for (const spec of ROLES) {
    const contractPath = resolve(CONTRACTS_DIR, `${spec.name}.md`);
    const body = readFileSync(contractPath, "utf8").trimEnd();
    definitions[resolve(CODEX_AGENTS_DIR, `${spec.name}.toml`)] = codexToml(spec, body);
    definitions[resolve(OPENCODE_AGENTS_DIR, `${spec.name}.md`)] = opencodeMarkdown(spec, body);
  }
  return definitions;
}

function main(args: readonly string[]): number {
  const definitions = generateDefinitions();
  if (!args.includes("--write")) {
    for (const [path, content] of Object.entries(definitions)) {
      process.stdout.write(`== ${path}\n${content}`);
    }
    return 0;
  }
  for (const [path, content] of Object.entries(definitions)) {
    if (!existsSync(dirname(path))) {
      throw new Error(`generator output directory is missing: ${dirname(path)}`);
    }
    writeFileSync(path, content);
  }
  process.stdout.write(`Wrote ${Object.keys(definitions).length} host agent definitions.\n`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
