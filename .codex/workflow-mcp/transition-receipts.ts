import { fail } from "./errors.js";
import type { ApprovedPathBaseline, ChangeReceipt, ExactRepoPath, ReviewRange } from "./types.js";
import { canonicalJson } from "./validation.js";

export function changedReceiptPaths(receipt: ChangeReceipt | null | undefined): ExactRepoPath[] {
  if (!receipt || !Array.isArray(receipt.paths)) return [];
  return receipt.paths
    .filter((item) => item.state !== "unchanged")
    .map((item) => item.path)
    .sort();
}

export function dirtyBaselinePaths(receipt: ChangeReceipt | null | undefined): ExactRepoPath[] {
  if (!receipt || !Array.isArray(receipt.paths)) return [];
  return receipt.paths
    .filter((item) => ["added", "modified", "deleted"].includes(item.state))
    .map((item) => item.path)
    .sort();
}

export function rangeDirtyBaselinePaths(range: ReviewRange | null | undefined): ExactRepoPath[] {
  if (!range || !Array.isArray(range.paths)) return [];
  return range.paths
    .filter((item) => ["added", "modified", "deleted"].includes(item.kind))
    .map((item) => item.path)
    .sort();
}

export function scopeChangedPaths(
  initialReceipt: ChangeReceipt | null,
  approvedPathBaselines: ApprovedPathBaseline[],
  finalReceipt: ChangeReceipt | null,
): ExactRepoPath[] {
  if (
    !initialReceipt ||
    !Array.isArray(initialReceipt.paths) ||
    !finalReceipt ||
    !Array.isArray(finalReceipt.paths)
  ) {
    fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
  }
  const baselines = [
    ...initialReceipt.paths,
    ...approvedPathBaselines.map((entry) => entry.baseline),
  ];
  const initialByPath = new Map(baselines.map((entry) => [entry.path, entry]));
  const finalByPath = new Map(finalReceipt.paths.map((entry) => [entry.path, entry]));
  const changed: ExactRepoPath[] = [];
  for (const entry of baselines) {
    const initialEntry = initialByPath.get(entry.path);
    const finalEntry = finalByPath.get(entry.path);
    if (!initialEntry || !finalEntry) fail("ERROR_STATE_CORRUPT", "receipt scope is invalid");
    const { state: _initialState, ...initialRest } = initialEntry;
    const { state: _finalState, ...finalRest } = finalEntry;
    if (canonicalJson(initialRest) !== canonicalJson(finalRest)) changed.push(entry.path);
  }
  return changed.sort();
}
