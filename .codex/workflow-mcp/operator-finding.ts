import type { BlockingFinding, Finding, OperatorFinding, OptionalFinding } from "./types.js";

const MAX_OPERATOR_FINDING_TEXT = 240;

function bounded(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_OPERATOR_FINDING_TEXT
    ? normalized
    : `${normalized.slice(0, MAX_OPERATOR_FINDING_TEXT - 1)}…`;
}

/** Project a validated persisted finding into bounded operator-facing display data. */
export function projectOperatorFinding(
  finding: Finding | BlockingFinding | OptionalFinding,
): OperatorFinding {
  return {
    finding_id: finding.finding_id,
    severity: finding.severity,
    file_and_line: finding.file_and_line,
    summary: bounded(finding.impact || finding.remediation || finding.violated_requirement),
    failure_scenario: bounded(finding.failure_scenario),
    impact: bounded(finding.impact),
    remediation: bounded(finding.remediation),
  };
}
