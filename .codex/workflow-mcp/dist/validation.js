import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fail } from "./errors.js";
export const MAX_PATHS = 200;
export const MAX_FINDINGS = 200;
export const MAX_CONTRACTS = 999;
export const MAX_TEXT = 4000;
export const MAX_DETAIL = 2000;
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
export const RESOLUTION_STATUSES = new Set([
    "resolved",
    "still_present",
    "superseded",
]);
export const ACCEPTANCE_STATUSES = new Set([
    "satisfied",
    "not_satisfied",
]);
export const VALIDATION_STATUSES = new Set([
    "passed",
    "failed",
    "not_run",
]);
export const ROLES = ["parent", "implementer", "reviewer", "committer"];
export function boundedString(value, name, max = MAX_TEXT) {
    if (typeof value !== "string" || value.length === 0 || value.length > max) {
        fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
    }
    return value;
}
export function optionalString(value, name, max = MAX_DETAIL) {
    if (value === null || value === undefined)
        return null;
    return boundedString(value, name, max);
}
export function optionalText(value, name, max = MAX_DETAIL) {
    return optionalString(value, name, max);
}
export function userAuthorization(value) {
    return boundedString(value, "user_authorization", MAX_DETAIL);
}
export function stringList(value, name, maxItems = 50, maxLength = 2000) {
    if (!Array.isArray(value) || value.length > maxItems)
        fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
    return value.map((item) => boundedString(item, name, maxLength));
}
export function repairCycle(value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 2)
        fail("ERROR_INVALID_SHAPE", "repair cycle is invalid");
    return value;
}
export function safeObject(value, name, maxKeys = 30) {
    if (!value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length > maxKeys) {
        fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
    }
    return value;
}
export function safeValidation(value) {
    safeObject(value, "validation", 20);
    const sanitize = (item, depth) => {
        if (depth > 3)
            fail("ERROR_INVALID_SHAPE", "validation is too deep");
        if (item === null || typeof item === "boolean" || typeof item === "number")
            return item;
        if (typeof item === "string") {
            if (item.length > 500)
                fail("ERROR_INVALID_SHAPE", "validation text is too long");
            return item;
        }
        if (Array.isArray(item)) {
            if (item.length > 20)
                fail("ERROR_INVALID_SHAPE", "validation array is too large");
            return item.map((child) => sanitize(child, depth + 1));
        }
        if (item && typeof item === "object") {
            const record = item;
            const keys = Object.keys(record);
            if (keys.length > 20 || keys.some((key) => key.length > 80))
                fail("ERROR_INVALID_SHAPE", "validation object is invalid");
            return Object.fromEntries(keys.map((key) => [key, sanitize(record[key], depth + 1)]));
        }
        fail("ERROR_INVALID_SHAPE", "validation value is invalid");
    };
    return sanitize(value, 0);
}
export function workflowId(value) {
    if (typeof value !== "string" || !/^[0-9a-f-]{36}$/u.test(value)) {
        fail("ERROR_NOT_FOUND", "workflow is not found");
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
    if (!ROLES.includes(value))
        fail("ERROR_INVALID_ROLE", "role is invalid");
    return value;
}
export function capability(value) {
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
        fail("ERROR_CAPABILITY_DENIED", "capability is invalid");
    }
    return value;
}
export function expectedVersion(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        fail("ERROR_INVALID_VERSION", "expected version is invalid");
    return value;
}
export function exactPaths(value, repositoryRoot, allowEmpty = false) {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > MAX_PATHS) {
        fail("ERROR_INVALID_PATHS", "path list is invalid");
    }
    if (value.length === 0)
        return [];
    const normalized = value.map((path) => {
        if (typeof path !== "string" ||
            path.length === 0 ||
            path.includes("\0") ||
            path.includes("\\") ||
            ["*", "?", "[", "]", "{", "}"].some((character) => path.includes(character)) ||
            path.split("/").some((segment) => segment === "." || segment === "..") ||
            isAbsolute(path)) {
            fail("ERROR_INVALID_PATHS", "path is unsafe");
        }
        const absolute = resolve(repositoryRoot, path);
        const relativePath = relative(repositoryRoot, absolute);
        if (relativePath === "" ||
            relativePath === ".." ||
            relativePath.startsWith(`..${sep}`) ||
            isAbsolute(relativePath)) {
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
    if (actual.some((key) => !allowed.includes(key)) ||
        required.some((key) => !actual.includes(key))) {
        fail("ERROR_INVALID_SHAPE", `${name} fields are invalid`);
    }
    return value;
}
export function findingIdList(value, name, errorCategory) {
    if (!Array.isArray(value) ||
        value.length === 0 ||
        new Set(value).size !== value.length ||
        value.some((id) => typeof id !== "string" || id.length === 0 || id.length > 80)) {
        fail(errorCategory, "finding IDs are invalid");
    }
    return value;
}
export function issueCapability() {
    return randomBytes(32).toString("hex");
}
export function hashCapability(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}
export function compareCapability(storedHash, value) {
    const token = capability(value);
    const expected = Buffer.from(storedHash, "hex");
    const actual = Buffer.from(hashCapability(token), "hex");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function canonicalJson(value) {
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        const record = value;
        return `{${Object.keys(record)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
}
export function objectDigest(value) {
    return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
export function isoNow() {
    return new Date().toISOString();
}
export function contractList(value, name, idPrefix, idField, allowEmpty = false) {
    if (!Array.isArray(value) ||
        (value.length === 0 && !allowEmpty) ||
        value.length > MAX_CONTRACTS) {
        fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
    }
    return value.map((description, index) => ({
        [idField]: `${idPrefix}-${String(index + 1).padStart(3, "0")}`,
        description: boundedString(description, `${name} description`),
    }));
}
export function evidenceResults(value, name, contracts, idField, statuses) {
    if (!Array.isArray(value) || value.length !== contracts.length) {
        fail("ERROR_INVALID_IMPLEMENTATION", `${name} results are invalid`);
    }
    return value.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            fail("ERROR_INVALID_IMPLEMENTATION", `${name} result ${index} is invalid`);
        }
        const record = item;
        const contract = contracts[index];
        const expectedId = idField === "criterion_id"
            ? contract.criterion_id
            : contract.validation_id;
        exactKeys(item, [idField, "status", "evidence"], `${name} result`);
        if (record[idField] !== expectedId) {
            fail("ERROR_INVALID_IMPLEMENTATION", `${name} ID is not in contract order`);
        }
        if (!statuses.has(record.status)) {
            fail("ERROR_INVALID_IMPLEMENTATION", `${name} status is invalid`);
        }
        return {
            [idField]: record[idField],
            status: record.status,
            evidence: boundedString(record.evidence, `${name} evidence`, MAX_DETAIL),
        };
    });
}
export function resolutionMap(value, expectedIds, name) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("ERROR_INVALID_SHAPE", `${name} is invalid`);
    }
    const record = value;
    const actual = Object.keys(record).sort();
    const expected = [...expectedIds].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
        fail("ERROR_INVALID_FINDING", `${name} IDs are incomplete`);
    }
    for (const id of expected) {
        if (!RESOLUTION_STATUSES.has(record[id]))
            fail("ERROR_INVALID_FINDING", `${name} status is invalid`);
    }
    return Object.fromEntries(expected.map((id) => [id, record[id]]));
}
export function finding(value, index, expectedBlocking) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        fail("ERROR_INVALID_FINDING", `finding ${index} is invalid`);
    }
    const record = value;
    const keys = Object.keys(record).sort();
    if (keys.length !== FINDING_KEYS.length ||
        keys.some((key, i) => key !== [...FINDING_KEYS].sort()[i])) {
        fail("ERROR_INVALID_FINDING", `finding ${index} has unknown fields`);
    }
    const result = {
        finding_id: boundedString(record.finding_id, "finding_id", 80),
        severity: record.severity,
        blocking: record.blocking,
        file_and_line: boundedString(record.file_and_line, "file_and_line", 300),
        failure_scenario: boundedString(record.failure_scenario, "failure_scenario", MAX_DETAIL),
        impact: boundedString(record.impact, "impact", MAX_DETAIL),
        violated_requirement: boundedString(record.violated_requirement, "violated_requirement", MAX_DETAIL),
        remediation: boundedString(record.remediation, "remediation", MAX_DETAIL),
        missing_or_inadequate_test: boundedString(record.missing_or_inadequate_test, "missing_or_inadequate_test", MAX_DETAIL),
    };
    if (!FINDING_SEVERITIES.has(result.severity) || typeof result.blocking !== "boolean") {
        fail("ERROR_INVALID_FINDING", `finding ${index} severity is invalid`);
    }
    const expected = result.severity !== "P3";
    if (result.blocking !== expected ||
        (expectedBlocking !== undefined && result.blocking !== expectedBlocking)) {
        fail("ERROR_INVALID_FINDING", `finding ${index} blocking flag is invalid`);
    }
    return result;
}
export function findings(value, name, expectedBlocking) {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
        fail("ERROR_INVALID_FINDING", `${name} is invalid`);
    }
    const parseFinding = finding;
    const result = value.map((item, index) => parseFinding(item, index, expectedBlocking));
    const ids = result.map((item) => item.finding_id);
    if (new Set(ids).size !== ids.length)
        fail("ERROR_INVALID_FINDING", "duplicate finding ID");
    return result;
}
