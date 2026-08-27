import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fail, WorkflowError } from "./errors.js";
import type {
  AcceptanceCriterion,
  AcceptanceResult,
  AcceptanceStatus,
  BlockingFinding,
  CapabilityHash,
  CapabilityToken,
  ErrorCategory,
  ExactRepoPath,
  Finding,
  FindingId,
  FindingResolution,
  FindingResolutionMap,
  FindingSeverity,
  GitCommitSha,
  IsoTimestamp,
  OptionalFinding,
  PlanApproval,
  PlanId,
  PlanRevision,
  PlanRevisionArtifact,
  ReviewFinding,
  Role,
  StateDigest,
  ValidationRequirement,
  ValidationResult,
  ValidationStatus,
  WorkflowId,
  WorkflowVersion,
  WorkItemReference,
  WorktreePlan,
  WorktreeValidationIssue,
  WorktreeValidationResult,
} from "./types.js";

export const MAX_PATHS = 200;
export const MAX_FINDINGS = 200;
export const MAX_CONTRACTS = 999;
export const MAX_TEXT = 4000;
export const MAX_DETAIL = 2000;
export const MAX_APPROVED_PLAN = 1024 * 1024;
export const MAX_EXECUTION_BRIEF = 32 * 1024;

const WORKTREE_NAME_SEPARATOR = /[\\/]+/gu;
const WORKTREE_NAME_INVALID = /[^a-zA-Z0-9._-]+/gu;

const FINDING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set(["P0", "P1", "P2", "P3"]);
const FINDING_KEYS = [
  "finding_id",
  "severity",
  "blocking",
  "file_and_line",
  "failure_scenario",
  "impact",
  "violated_requirement",
  "remediation",
  "missing_or_inadequate_test",
] as const satisfies readonly (keyof Finding)[];

export const RESOLUTION_STATUSES: ReadonlySet<FindingResolution> = new Set([
  "resolved",
  "still_present",
  "superseded",
]);
export const ACCEPTANCE_STATUSES: ReadonlySet<AcceptanceStatus> = new Set([
  "satisfied",
  "not_satisfied",
]);
export const VALIDATION_STATUSES: ReadonlySet<ValidationStatus> = new Set([
  "passed",
  "failed",
  "not_run",
]);

export const ROLES: readonly Role[] = ["parent", "implementer", "reviewer", "committer"];

function hasWorkItemControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code >= 0 && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029
    );
  });
}

export function workItems(value: unknown): WorkItemReference[] {
  if (!Array.isArray(value) || value.length > 50) {
    fail("ERROR_INVALID_SHAPE", "work_items is invalid");
  }
  const result: WorkItemReference[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const record = exactKeys(item, ["provider", "id", "display_ref"], "work item", ["url"]);
    for (const [name, max] of [
      ["provider", 64],
      ["id", 200],
      ["display_ref", 200],
    ] as const) {
      const field = record[name];
      if (
        typeof field !== "string" ||
        field.length === 0 ||
        field.length > max ||
        field.trim() !== field ||
        hasWorkItemControl(field)
      ) {
        fail("ERROR_INVALID_SHAPE", `work item ${name} is invalid`);
      }
    }
    let url: string | null = null;
    const suppliedUrl = record.url ?? null;
    if (suppliedUrl !== null) {
      if (
        typeof suppliedUrl !== "string" ||
        suppliedUrl.length === 0 ||
        suppliedUrl.length > 2048 ||
        suppliedUrl.trim() !== suppliedUrl ||
        hasWorkItemControl(suppliedUrl)
      ) {
        fail("ERROR_INVALID_SHAPE", "work item url is invalid");
      }
      try {
        const parsed = new URL(suppliedUrl);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          fail("ERROR_INVALID_SHAPE", "work item url is invalid");
        }
      } catch {
        fail("ERROR_INVALID_SHAPE", "work item url is invalid");
      }
      url = suppliedUrl;
    }
    const normalized = {
      provider: record.provider as string,
      id: record.id as string,
      display_ref: record.display_ref as string,
      url,
    };
    const key = canonicalJson(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

export function boundedString(value: unknown, name: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  return value;
}

export function optionalString(value: unknown, name: string, max = MAX_DETAIL): string | null {
  if (value === null || value === undefined) return null;
  return boundedString(value, name, max);
}

export function optionalText(value: unknown, name: string, max = MAX_DETAIL): string | null {
  return optionalString(value, name, max);
}

export function approvedPlan(value: unknown, name = "approved_plan"): string | null {
  if (value === null) return null;
  return boundedString(value, name, MAX_APPROVED_PLAN);
}

const PLAN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function planId(value: unknown): PlanId {
  if (typeof value !== "string" || !PLAN_ID_PATTERN.test(value)) {
    fail("ERROR_PLAN_INVALID", "plan ID is invalid");
  }
  return value as PlanId;
}

export function planRevision(value: unknown, name = "revision"): PlanRevision {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail("ERROR_PLAN_INVALID", `${name} is invalid`);
  }
  return value as PlanRevision;
}

export function executionBrief(value: unknown): string {
  return boundedString(value, "execution_brief", MAX_EXECUTION_BRIEF);
}

export function planRevisionInput(
  value: unknown,
  repositoryRoot: string,
): Omit<PlanRevisionArtifact, "plan_id" | "revision" | "created_at"> {
  const args = exactKeys(
    value,
    [
      "full_plan",
      "execution_brief",
      "objective",
      "approved_paths",
      "acceptance_criteria",
      "validation_requirements",
    ],
    "plan revision",
  );
  const objective = boundedString(args.objective, "objective");
  const fullPlan = boundedString(args.full_plan, "full_plan", MAX_APPROVED_PLAN);
  const brief = executionBrief(args.execution_brief);
  const approvedPaths = exactPaths(args.approved_paths, repositoryRoot);
  const acceptanceCriteria = contractList(
    args.acceptance_criteria,
    "acceptance_criteria",
    "AC",
    "criterion_id",
  );
  const validationRequirements = contractList(
    args.validation_requirements,
    "validation_requirements",
    "VAL",
    "validation_id",
  );
  return {
    plan_schema_version: 1,
    full_plan: fullPlan,
    execution_brief: brief,
    objective,
    approved_paths: approvedPaths,
    acceptance_criteria: acceptanceCriteria,
    validation_requirements: validationRequirements,
  };
}

export function planArtifact(value: unknown, repositoryRoot: string): PlanRevisionArtifact {
  try {
    const record = safeObject(value, "plan artifact", 10);
    exactKeys(
      record,
      [
        "plan_schema_version",
        "plan_id",
        "revision",
        "full_plan",
        "execution_brief",
        "objective",
        "approved_paths",
        "acceptance_criteria",
        "validation_requirements",
        "created_at",
      ],
      "plan artifact",
    );
    if (record.plan_schema_version !== 1)
      fail("ERROR_STATE_CORRUPT", "plan schema version is invalid");
    const acceptanceCriteria = persistedPlanRecords(
      record.acceptance_criteria,
      "acceptance criteria",
      ["criterion_id", "description"],
    );
    const validationRequirements = persistedPlanRecords(
      record.validation_requirements,
      "validation requirements",
      ["description", "argv", "validation_id"],
    );
    const normalized = planRevisionInput(
      {
        full_plan: record.full_plan,
        execution_brief: record.execution_brief,
        objective: record.objective,
        approved_paths: record.approved_paths,
        acceptance_criteria: acceptanceCriteria.map((item) => item.description),
        validation_requirements: validationRequirements.map((item) => ({
          description: item.description,
          argv: item.argv,
        })),
      },
      repositoryRoot,
    );
    planId(record.plan_id);
    planRevision(record.revision);
    if (typeof record.created_at !== "string" || Number.isNaN(Date.parse(record.created_at)))
      fail("ERROR_STATE_CORRUPT", "plan artifact timestamp is invalid");
    if (canonicalJson(normalized.approved_paths) !== canonicalJson(record.approved_paths))
      fail("ERROR_STATE_CORRUPT", "plan artifact paths are not normalized");
    if (canonicalJson(normalized.acceptance_criteria) !== canonicalJson(record.acceptance_criteria))
      fail("ERROR_STATE_CORRUPT", "plan artifact acceptance criteria are not normalized");
    if (
      canonicalJson(normalized.validation_requirements) !==
      canonicalJson(record.validation_requirements)
    )
      fail("ERROR_STATE_CORRUPT", "plan artifact validation requirements are not normalized");
    return record as unknown as PlanRevisionArtifact;
  } catch (error) {
    if (error instanceof WorkflowError && error.category === "ERROR_STATE_CORRUPT") throw error;
    fail("ERROR_STATE_CORRUPT", "plan artifact is invalid");
  }
}

function persistedPlanRecords(
  value: unknown,
  name: string,
  keys: readonly string[],
): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail("ERROR_STATE_CORRUPT", `${name} are invalid`);
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      fail("ERROR_STATE_CORRUPT", `${name} entry is invalid`);
    const record = item as Record<string, unknown>;
    const actual = Object.keys(record).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
      fail("ERROR_STATE_CORRUPT", `${name} entry fields are invalid`);
    return record;
  });
}

export function planApproval(value: unknown): PlanApproval {
  const record = safeObject(value, "plan approval", 5);
  exactKeys(
    record,
    ["plan_id", "revision", "artifact_digest", "user_authorization", "approved_at"],
    "plan approval",
  );
  planId(record.plan_id);
  planRevision(record.revision);
  if (typeof record.artifact_digest !== "string" || !/^[0-9a-f]{64}$/u.test(record.artifact_digest))
    fail("ERROR_STATE_CORRUPT", "plan approval digest is invalid");
  userAuthorization(record.user_authorization);
  if (typeof record.approved_at !== "string" || Number.isNaN(Date.parse(record.approved_at)))
    fail("ERROR_STATE_CORRUPT", "plan approval timestamp is invalid");
  return record as unknown as PlanApproval;
}

export function userAuthorization(value: unknown): string {
  return boundedString(value, "user_authorization", MAX_DETAIL);
}

export function stringList(
  value: unknown,
  name: string,
  maxItems = 50,
  maxLength = 2000,
): string[] {
  if (!Array.isArray(value) || value.length > maxItems)
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  return value.map((item) => boundedString(item, name, maxLength));
}

export function repairCycle(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2)
    fail("ERROR_INVALID_SHAPE", "repair cycle is invalid");
  return value as number;
}

export function safeObject(value: unknown, name: string, maxKeys = 30): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > maxKeys
  ) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  return value as Record<string, unknown>;
}

export function safeValidation(value: unknown): unknown {
  safeObject(value, "validation", 20);
  const sanitize = (item: unknown, depth: number): unknown => {
    if (depth > 3) fail("ERROR_INVALID_SHAPE", "validation is too deep");
    if (item === null || typeof item === "boolean" || typeof item === "number") return item;
    if (typeof item === "string") {
      if (item.length > 500) fail("ERROR_INVALID_SHAPE", "validation text is too long");
      return item;
    }
    if (Array.isArray(item)) {
      if (item.length > 20) fail("ERROR_INVALID_SHAPE", "validation array is too large");
      return item.map((child) => sanitize(child, depth + 1));
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const keys = Object.keys(record);
      if (keys.length > 20 || keys.some((key) => key.length > 80))
        fail("ERROR_INVALID_SHAPE", "validation object is invalid");
      return Object.fromEntries(
        keys.map((key) => [key, sanitize(record[key], depth + 1)] as [string, unknown]),
      );
    }
    fail("ERROR_INVALID_SHAPE", "validation value is invalid");
  };
  return sanitize(value, 0);
}

export function workflowId(value: unknown): WorkflowId {
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/u.test(value)) {
    fail("ERROR_NOT_FOUND", "workflow is not found");
  }
  return value as WorkflowId;
}

export function revision(value: unknown, name = "revision"): GitCommitSha {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  return value as GitCommitSha;
}

export function role(value: unknown): Role {
  if (!ROLES.includes(value as Role)) fail("ERROR_INVALID_ROLE", "role is invalid");
  return value as Role;
}

export function capability(value: unknown): CapabilityToken {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail("ERROR_CAPABILITY_DENIED", "capability is invalid");
  }
  return value as CapabilityToken;
}

export function expectedVersion(value: unknown): WorkflowVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    fail("ERROR_INVALID_VERSION", "expected version is invalid");
  return value as WorkflowVersion;
}

export function exactPaths(
  value: unknown,
  repositoryRoot: string,
  allowEmpty = false,
): ExactRepoPath[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_PATHS) {
    fail("ERROR_INVALID_PATHS", "path list is invalid");
  }
  if (value.length === 0) return [];
  const normalized = value.map((path) => {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\0") ||
      path.includes("\\") ||
      ["*", "?", "[", "]", "{", "}"].some((character) => path.includes(character)) ||
      path.split("/").some((segment) => segment === "." || segment === "..") ||
      isAbsolute(path)
    ) {
      fail("ERROR_INVALID_PATHS", "path is unsafe");
    }
    const absolute = resolve(repositoryRoot, path);
    const relativePath = relative(repositoryRoot, absolute);
    if (
      relativePath === "" ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`) ||
      isAbsolute(relativePath)
    ) {
      fail("ERROR_INVALID_PATHS", "path is unsafe");
    }
    return relativePath.split(sep).join("/") as ExactRepoPath;
  });
  if (new Set(normalized).size !== normalized.length) {
    fail("ERROR_INVALID_PATHS", "duplicate path");
  }
  return normalized.sort();
}

/** Validate a user supplied name before it is joined to a managed worktree root. */
export function validateWorktreePathName(value: unknown): WorktreeValidationResult {
  const issues: WorktreeValidationIssue[] = [];
  if (typeof value !== "string" || value.length === 0) {
    issues.push({ category: "invalid_path", field: "path", detail: "path is empty" });
    return { valid: false, issues };
  }
  if (
    value.includes("\0") ||
    isAbsolute(value) ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    issues.push({ category: "invalid_path", field: "path", detail: "path must be relative" });
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    issues.push({
      category: "invalid_path",
      field: "path",
      detail: "path contains an unsafe segment",
    });
  }
  const normalized = segments.join("/");
  if (normalized === "") {
    issues.push({ category: "invalid_path", field: "path", detail: "path is empty" });
  }
  return { valid: issues.length === 0, issues };
}

export function assertWorktreePathName(value: unknown): string {
  const result = validateWorktreePathName(value);
  if (!result.valid) fail("ERROR_UNSAFE_PATH", result.issues[0]?.detail ?? "path is unsafe");
  return String(value).replaceAll("\\", "/");
}

export function deriveWorktreeDirectoryName(workspaceName: string): string {
  if (typeof workspaceName !== "string") fail("ERROR_UNSAFE_PATH", "worktree name is invalid");
  const name = workspaceName
    .trim()
    .replace(WORKTREE_NAME_SEPARATOR, "-")
    .replace(WORKTREE_NAME_INVALID, "-");
  const normalized = name.replace(/-+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "");
  if (!normalized || normalized === "." || normalized === "..") {
    fail("ERROR_UNSAFE_PATH", "worktree directory name is invalid");
  }
  return normalized;
}

export function deriveWorktreeBranch(
  workspaceName: string,
  prefix = "worktree",
  separator = "/",
): string {
  if (
    typeof prefix !== "string" ||
    typeof separator !== "string" ||
    !prefix ||
    !separator ||
    prefix.includes("\0") ||
    separator.includes("\0")
  ) {
    fail("ERROR_INVALID_ARGUMENTS", "worktree branch policy is invalid");
  }
  const branch = `${prefix}${separator}${deriveWorktreeDirectoryName(workspaceName)}`;
  if (!branch || branch.startsWith("/") || branch.endsWith("/"))
    fail("ERROR_INVALID_ARGUMENTS", "worktree branch is invalid");
  return branch;
}

export function worktreeValidationResult(
  issues: WorktreeValidationIssue[],
): WorktreeValidationResult {
  const normalized = [...issues].sort(
    (a, b) =>
      (a.category < b.category ? -1 : a.category > b.category ? 1 : 0) ||
      (a.field < b.field ? -1 : a.field > b.field ? 1 : 0) ||
      (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0),
  );
  return { valid: normalized.length === 0, issues: normalized };
}

export function worktreePlan(
  input: {
    path: string;
    workspaceName: string;
    branch?: string;
    startRef: string;
    createBranch?: boolean;
  },
  externalRoot: string,
): WorktreePlan {
  if (!input || typeof input !== "object")
    fail("ERROR_INVALID_ARGUMENTS", "worktree plan is invalid");
  const pathName = assertWorktreePathName(input.path);
  const directoryName = deriveWorktreeDirectoryName(input.workspaceName);
  const branch = input.branch ?? deriveWorktreeBranch(input.workspaceName);
  if (typeof branch !== "string" || !branch || branch.includes("\0"))
    fail("ERROR_INVALID_ARGUMENTS", "worktree branch is invalid");
  if (typeof input.startRef !== "string" || !input.startRef || input.startRef.includes("\0"))
    fail("ERROR_INVALID_ARGUMENTS", "start ref is invalid");
  const path = resolve(externalRoot, pathName);
  const root = resolve(externalRoot);
  const escaped = relative(root, path);
  if (!escaped || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped))
    fail("ERROR_UNSAFE_PATH", "worktree path escapes external root");
  return {
    path,
    directory_name: directoryName,
    branch,
    start_ref: input.startRef,
    create_branch: input.createBranch ?? true,
  };
}

export function exactKeys(
  value: unknown,
  keys: readonly string[],
  name: string,
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const allowed = [...new Set([...keys, ...optional])].sort();
  const required = keys.filter((key) => !optional.includes(key));
  if (
    actual.some((key) => !allowed.includes(key)) ||
    required.some((key) => !actual.includes(key))
  ) {
    fail("ERROR_INVALID_SHAPE", `${name} fields are invalid`);
  }
  return value as Record<string, unknown>;
}

export function findingIdList(
  value: unknown,
  _name: string,
  errorCategory: ErrorCategory,
): FindingId[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    new Set(value).size !== value.length ||
    value.some((id) => typeof id !== "string" || id.length === 0 || id.length > 80)
  ) {
    fail(errorCategory, "finding IDs are invalid");
  }
  return value as FindingId[];
}

export function issueCapability(): CapabilityToken {
  return randomBytes(32).toString("hex") as CapabilityToken;
}

export function hashCapability(value: CapabilityToken): CapabilityHash {
  return createHash("sha256").update(value, "utf8").digest("hex") as CapabilityHash;
}

export function compareCapability(storedHash: string, value: unknown): boolean {
  const token = capability(value);
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashCapability(token), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function objectDigest(value: unknown): StateDigest {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex") as StateDigest;
}

export function isoNow(): IsoTimestamp {
  return new Date().toISOString() as IsoTimestamp;
}

export function contractList(
  value: unknown,
  name: string,
  idPrefix: "AC",
  idField: "criterion_id",
  allowEmpty?: boolean,
): AcceptanceCriterion[];
export function contractList(
  value: unknown,
  name: string,
  idPrefix: "VAL",
  idField: "validation_id",
  allowEmpty?: boolean,
): ValidationRequirement[];
export function contractList(
  value: unknown,
  name: string,
  idPrefix: string,
  idField: "criterion_id" | "validation_id",
  allowEmpty = false,
): AcceptanceCriterion[] | ValidationRequirement[] {
  if (
    !Array.isArray(value) ||
    (value.length === 0 && !allowEmpty) ||
    value.length > MAX_CONTRACTS
  ) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  return value.map((item, index) => {
    const id = `${idPrefix}-${String(index + 1).padStart(3, "0")}`;
    if (idField === "criterion_id") {
      return {
        criterion_id: id,
        description: boundedString(item, `${name} description`),
      };
    }
    // String requirements remain accepted as manual requirements for compatibility with
    // pre-Issue #33 callers. Executable requirements must use the structured object form;
    // descriptions are never interpreted as commands.
    if (typeof item === "string") {
      return {
        validation_id: id,
        description: boundedString(item, `${name} description`),
        argv: null,
      };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail("ERROR_INVALID_SHAPE", `${name} requirement is invalid`);
    }
    const record = item as Record<string, unknown>;
    exactKeys(item, ["description", "argv"], `${name} requirement`);
    if (record.argv !== null && !Array.isArray(record.argv)) {
      fail("ERROR_INVALID_SHAPE", `${name} requirement argv is invalid`);
    }
    const argv =
      record.argv === null
        ? null
        : record.argv.map((argument, argumentIndex) =>
            boundedString(argument, `${name} argv[${argumentIndex}]`, MAX_TEXT),
          );
    if (argv !== null && (argv.length === 0 || argv.length > 50)) {
      fail("ERROR_INVALID_SHAPE", `${name} requirement argv is invalid`);
    }
    return {
      validation_id: id,
      description: boundedString(record.description, `${name} description`),
      argv,
    };
  }) as unknown as AcceptanceCriterion[] | ValidationRequirement[];
}

export function evidenceResults(
  value: unknown,
  name: string,
  contracts: ReadonlyArray<AcceptanceCriterion>,
  idField: "criterion_id",
  statuses: ReadonlySet<AcceptanceStatus>,
): AcceptanceResult[];
export function evidenceResults(
  value: unknown,
  name: string,
  contracts: ReadonlyArray<ValidationRequirement>,
  idField: "validation_id",
  statuses: ReadonlySet<ValidationStatus>,
): ValidationResult[];
export function evidenceResults(
  value: unknown,
  name: string,
  contracts: ReadonlyArray<AcceptanceCriterion | ValidationRequirement>,
  idField: "criterion_id" | "validation_id",
  statuses: ReadonlySet<AcceptanceStatus | ValidationStatus>,
): AcceptanceResult[] | ValidationResult[] {
  if (!Array.isArray(value) || value.length !== contracts.length) {
    fail("ERROR_INVALID_IMPLEMENTATION", `${name} results are invalid`);
  }
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      fail("ERROR_INVALID_IMPLEMENTATION", `${name} result ${index} is invalid`);
    }
    const record = item as Record<string, unknown>;
    const contract = contracts[index];
    const expectedId =
      idField === "criterion_id"
        ? (contract as AcceptanceCriterion).criterion_id
        : (contract as ValidationRequirement).validation_id;
    exactKeys(item, [idField, "status", "evidence"], `${name} result`);
    if (record[idField] !== expectedId) {
      fail("ERROR_INVALID_IMPLEMENTATION", `${name} ID is not in contract order`);
    }
    if (!statuses.has(record.status as AcceptanceStatus | ValidationStatus)) {
      fail("ERROR_INVALID_IMPLEMENTATION", `${name} status is invalid`);
    }
    return {
      [idField]: record[idField],
      status: record.status,
      evidence: boundedString(record.evidence, `${name} evidence`, MAX_DETAIL),
    };
  }) as unknown as AcceptanceResult[] | ValidationResult[];
}

export function resolutionMap(
  value: unknown,
  expectedIds: ReadonlyArray<FindingId>,
  name: string,
): FindingResolutionMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedIds].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("ERROR_INVALID_FINDING", `${name} IDs are incomplete`);
  }
  for (const id of expected) {
    if (!RESOLUTION_STATUSES.has(record[id] as FindingResolution))
      fail("ERROR_INVALID_FINDING", `${name} status is invalid`);
  }
  return Object.fromEntries(
    expected.map((id) => [id, record[id] as FindingResolution] as [FindingId, FindingResolution]),
  ) as FindingResolutionMap;
}

export function finding(value: unknown, index: number, expectedBlocking: true): BlockingFinding;
export function finding(value: unknown, index: number, expectedBlocking: false): OptionalFinding;
export function finding(value: unknown, index: number, expectedBlocking?: boolean): ReviewFinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_FINDING", `finding ${index} is invalid`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== FINDING_KEYS.length ||
    keys.some((key, i) => key !== [...FINDING_KEYS].sort()[i])
  ) {
    fail("ERROR_INVALID_FINDING", `finding ${index} has unknown fields`);
  }
  const result = {
    finding_id: boundedString(record.finding_id, "finding_id", 80) as FindingId,
    severity: record.severity as FindingSeverity,
    blocking: record.blocking as boolean,
    file_and_line: boundedString(record.file_and_line, "file_and_line", 300),
    failure_scenario: boundedString(record.failure_scenario, "failure_scenario", MAX_DETAIL),
    impact: boundedString(record.impact, "impact", MAX_DETAIL),
    violated_requirement: boundedString(
      record.violated_requirement,
      "violated_requirement",
      MAX_DETAIL,
    ),
    remediation: boundedString(record.remediation, "remediation", MAX_DETAIL),
    missing_or_inadequate_test: boundedString(
      record.missing_or_inadequate_test,
      "missing_or_inadequate_test",
      MAX_DETAIL,
    ),
  };
  if (!FINDING_SEVERITIES.has(result.severity) || typeof result.blocking !== "boolean") {
    fail("ERROR_INVALID_FINDING", `finding ${index} severity is invalid`);
  }
  const expected = result.severity !== "P3";
  if (
    result.blocking !== expected ||
    (expectedBlocking !== undefined && result.blocking !== expectedBlocking)
  ) {
    fail("ERROR_INVALID_FINDING", `finding ${index} blocking flag is invalid`);
  }
  return result as ReviewFinding;
}

export function findings(value: unknown, name: string, expectedBlocking: true): BlockingFinding[];
export function findings(value: unknown, name: string, expectedBlocking: false): OptionalFinding[];
export function findings(
  value: unknown,
  name: string,
  expectedBlocking?: boolean,
): ReviewFinding[] {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    fail("ERROR_INVALID_FINDING", `${name} is invalid`);
  }
  const parseFinding = finding as (
    value: unknown,
    index: number,
    expectedBlocking: boolean | undefined,
  ) => ReviewFinding;
  const result = value.map((item, index) => parseFinding(item, index, expectedBlocking));
  const ids = result.map((item) => item.finding_id);
  if (new Set(ids).size !== ids.length) fail("ERROR_INVALID_FINDING", "duplicate finding ID");
  return result;
}
