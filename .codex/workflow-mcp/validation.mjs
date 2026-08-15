import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fail } from "./errors.mjs";

const MAX_PATHS = 200;
const MAX_FINDINGS = 200;
const MAX_TEXT = 4000;
const MAX_DETAIL = 2000;
const FINDING_SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);
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
];
export const RESOLUTION_STATUSES = new Set(["resolved", "still_present", "superseded"]);

export const ROLES = ["parent", "implementer", "reviewer", "committer"];

export function boundedString(value, name, max = MAX_TEXT) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  return value;
}

function optionalString(value, name, max = MAX_DETAIL) {
  if (value === null || value === undefined) return null;
  return boundedString(value, name, max);
}

export function exactPaths(value, repositoryRoot, allowEmpty = false) {
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
    return relativePath.split(sep).join("/");
  });
  if (new Set(normalized).size !== normalized.length) {
    fail("ERROR_INVALID_PATHS", "duplicate path");
  }
  return normalized.sort();
}

export function exactKeys(value, keys, name, optional = []) {
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
  return value;
}

export function revision(value, name = "revision") {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  return value;
}

export function role(value) {
  if (!ROLES.includes(value)) fail("ERROR_INVALID_ROLE", "role is invalid");
  return value;
}

export function capability(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    fail("ERROR_CAPABILITY_DENIED", "capability is invalid");
  }
  return value;
}

export function stringList(value, name, maxItems = 50, maxLength = 2000) {
  if (!Array.isArray(value) || value.length > maxItems)
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  return value.map((item) => boundedString(item, name, maxLength));
}

export function resolutionMap(value, expectedIds, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedIds].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("ERROR_INVALID_FINDING", `${name} IDs are incomplete`);
  }
  for (const id of expected) {
    if (!RESOLUTION_STATUSES.has(value[id]))
      fail("ERROR_INVALID_FINDING", `${name} status is invalid`);
  }
  return Object.fromEntries(expected.map((id) => [id, value[id]]));
}

export function issueCapability() {
  return randomBytes(32).toString("hex");
}

export function hashCapability(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function compareCapability(storedHash, value) {
  capability(value);
  const expected = Buffer.from(storedHash, "hex");
  const actual = Buffer.from(hashCapability(value), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function finding(value, index, expectedBlocking = undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ERROR_INVALID_FINDING", `finding ${index} is invalid`);
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== FINDING_KEYS.length ||
    keys.some((key, i) => key !== [...FINDING_KEYS].sort()[i])
  ) {
    fail("ERROR_INVALID_FINDING", `finding ${index} has unknown fields`);
  }
  const result = {
    finding_id: boundedString(value.finding_id, "finding_id", 80),
    severity: value.severity,
    blocking: value.blocking,
    file_and_line: boundedString(value.file_and_line, "file_and_line", 300),
    failure_scenario: boundedString(value.failure_scenario, "failure_scenario", MAX_DETAIL),
    impact: boundedString(value.impact, "impact", MAX_DETAIL),
    violated_requirement: boundedString(
      value.violated_requirement,
      "violated_requirement",
      MAX_DETAIL,
    ),
    remediation: boundedString(value.remediation, "remediation", MAX_DETAIL),
    missing_or_inadequate_test: boundedString(
      value.missing_or_inadequate_test,
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
  return result;
}

export function findings(value, name, expectedBlocking = undefined) {
  if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
    fail("ERROR_INVALID_FINDING", `${name} is invalid`);
  }
  const result = value.map((item, index) => finding(item, index, expectedBlocking));
  const ids = result.map((item) => item.finding_id);
  if (new Set(ids).size !== ids.length) fail("ERROR_INVALID_FINDING", "duplicate finding ID");
  return result;
}

export function expectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    fail("ERROR_INVALID_VERSION", "expected version is invalid");
  return value;
}

export function repairCycle(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2)
    fail("ERROR_INVALID_SHAPE", "repair cycle is invalid");
  return value;
}

export function userAuthorization(value) {
  return boundedString(value, "user_authorization", MAX_DETAIL);
}

export function optionalText(value, name, max = MAX_DETAIL) {
  return optionalString(value, name, max);
}

export function safeObject(value, name, maxKeys = 30) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > maxKeys
  ) {
    fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
  }
  return value;
}

export function safeValidation(value) {
  safeObject(value, "validation", 20);
  const sanitize = (item, depth) => {
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
      const keys = Object.keys(item);
      if (keys.length > 20 || keys.some((key) => key.length > 80))
        fail("ERROR_INVALID_SHAPE", "validation object is invalid");
      return Object.fromEntries(keys.map((key) => [key, sanitize(item[key], depth + 1)]));
    }
    fail("ERROR_INVALID_SHAPE", "validation value is invalid");
  };
  return sanitize(value, 0);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function objectDigest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
