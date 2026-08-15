export class WorkflowError extends Error {
  constructor(category, detail = "") {
    super(category);
    this.name = "WorkflowError";
    this.category = category;
    this.detail = detail;
  }
}

export function fail(category, detail = "") {
  throw new WorkflowError(category, detail);
}

export function safeError(error) {
  if (error instanceof WorkflowError) {
    return { category: error.category, detail: error.detail };
  }
  return { category: "ERROR_INTERNAL", detail: "operation failed" };
}

export function isWorkflowError(error, category) {
  return error instanceof WorkflowError && error.category === category;
}
