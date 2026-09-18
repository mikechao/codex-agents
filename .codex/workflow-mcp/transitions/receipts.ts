import { fail } from "../errors.js";
import type {
  ApprovedPathBaseline,
  ChangeReceipt,
  ExactRepoPath,
  ReviewRange,
  StateDigest,
} from "../types.js";
import { canonicalJson, objectDigest } from "../validation.js";

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

export type DependencyReceiptComparison =
  | { status: "proven"; changed_paths: ExactRepoPath[] }
  | { status: "unprovable" };

/** Commit the exact semantic identities used by dependency comparison, excluding relative state. */
export function dependencyReceiptIdentityDigest(
  receipt: ChangeReceipt | null | undefined,
  dependencyPaths: ExactRepoPath[],
): StateDigest | null {
  if (!receipt || receipt.base_head.length === 0) return null;
  const byPath = new Map(receipt.paths.map((entry) => [entry.path, entry]));
  const identities = [];
  for (const path of dependencyPaths) {
    const entry = byPath.get(path);
    if (!entry) return null;
    const { state: _state, ...identity } = entry;
    identities.push(identity);
  }
  return objectDigest({
    base_head: receipt.base_head,
    dependency_paths: dependencyPaths,
    path_identities: identities,
  });
}

/** Compare only the exact dependency paths captured when manual evidence was observed. */
export function compareDependencyReceipt(
  baseline: ChangeReceipt,
  current: ChangeReceipt,
  dependencyPaths: ExactRepoPath[],
): DependencyReceiptComparison {
  if (
    baseline.base_head !== current.base_head ||
    canonicalJson(baseline.approved_paths) !== canonicalJson(dependencyPaths) ||
    baseline.paths.length !== dependencyPaths.length
  ) {
    return { status: "unprovable" };
  }
  const baselineByPath = new Map(baseline.paths.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(current.paths.map((entry) => [entry.path, entry]));
  const changed: ExactRepoPath[] = [];
  for (const path of dependencyPaths) {
    const before = baselineByPath.get(path);
    const after = currentByPath.get(path);
    if (!before || !after) return { status: "unprovable" };
    const { state: _beforeState, ...beforeIdentity } = before;
    const { state: _afterState, ...afterIdentity } = after;
    if (canonicalJson(beforeIdentity) !== canonicalJson(afterIdentity)) changed.push(path);
  }
  return { status: "proven", changed_paths: changed.sort() };
}
