import { fail } from "./errors.js";

/** Persisted workflow-state schema version. Changes are clean breaks; no implicit upgrades occur. */
export const CURRENT_STATE_SCHEMA_VERSION = 4;

export function assertSupportedStateSchema(value: unknown): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { schema_version?: unknown }).schema_version !== CURRENT_STATE_SCHEMA_VERSION
  ) {
    fail(
      "ERROR_MIGRATION_REQUIRED",
      "persisted workflow state schema is unsupported; reset the database and restart",
    );
  }
}
