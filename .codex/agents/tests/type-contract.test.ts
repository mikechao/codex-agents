import { test } from "bun:test";
import assert from "node:assert/strict";
import type {
  AbsentReceiptEntry,
  DeletedReceiptEntry,
  PresentReceiptEntry,
  ReceiptEntry,
} from "../change-receipt.js";

const absent: AbsentReceiptEntry = { path: "missing.txt", state: "absent", kind: "missing" };
const deleted: DeletedReceiptEntry = {
  path: "deleted.txt",
  state: "deleted",
  kind: "missing",
  mode: "100644",
};
const present: PresentReceiptEntry = {
  path: "present.txt",
  state: "modified",
  kind: "file",
  mode: "100644",
  digest: "a".repeat(64),
};
const entries: ReceiptEntry[] = [absent, deleted, present];
void entries;

// @ts-expect-error absent entries cannot carry a mode
const absentWithMode: ReceiptEntry = { ...absent, mode: "100644" };
void absentWithMode;
// @ts-expect-error deleted entries cannot carry a digest
const deletedWithDigest: ReceiptEntry = { ...deleted, digest: "a".repeat(64) };
void deletedWithDigest;
// @ts-expect-error present entries require a digest
const presentWithoutDigest: ReceiptEntry = {
  path: "present.txt",
  state: "added",
  kind: "file",
  mode: "100644",
};
void presentWithoutDigest;

test("receipt entry variants are named discriminated types", () => {
  assert.equal(absent.kind, "missing");
  assert.equal(deleted.mode, "100644");
  assert.equal(present.digest.length, 64);
});
