import type { ErrorCategory } from "./types.js";

export interface SafeError {
  category: ErrorCategory;
  detail: string;
}

export class WorkflowError extends Error {
  category: ErrorCategory;
  detail: string;
  constructor(category: ErrorCategory, detail = "") {
    super(category);
    this.name = "WorkflowError";
    this.category = category;
    this.detail = detail;
  }
}

export function fail(category: ErrorCategory, detail = ""): never {
  throw new WorkflowError(category, detail);
}

export function safeError(error: unknown): SafeError {
  if (error instanceof WorkflowError) {
    return { category: error.category, detail: error.detail };
  }
  return { category: "ERROR_INTERNAL", detail: "operation failed" };
}

export function isWorkflowError(error: unknown, category: ErrorCategory): boolean {
  return error instanceof WorkflowError && error.category === category;
}
