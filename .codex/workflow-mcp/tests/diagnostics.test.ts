import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DiagnosticEvent, DiagnosticRecorder, withDiagnosticRequest } from "../diagnostics.js";
import { WorkflowError } from "../errors.js";
import { WorkflowStore } from "../store.js";
import { fixture } from "./test-fixtures.js";

describe("Workflow MCP diagnostics", () => {
  test("is disabled by default and writes bounded per-process JSONL only when opted in", () => {
    const directory = mkdtempSync(join(tmpdir(), "workflow-diagnostics-"));
    try {
      const disabled = new DiagnosticRecorder("runtime", "/", {
        enabled: false,
        directory,
      });
      disabled.record({ event: "ignored", workflow_id: "secret-payload-sentinel" });
      expect(readdirSync(directory)).toEqual([]);

      const recorder = new DiagnosticRecorder("runtime", "/", {
        directory,
        enabled: true,
        maxBytes: 1024,
      });
      withDiagnosticRequest(
        { request_id: 17, method: "tools/call", tool: "workflow_parent_get" },
        () => {
          recorder.record({
            event: "receipt",
            workflow_id: "12345678-1234-1234-1234-123456789abc",
            database_path: "/tmp/state.sqlite",
            outcome: "received",
          });
        },
      );
      recorder.record({
        event: "ignored-payload",
        workflow_id: "capability-secret-sentinel",
        capability: "capability-secret-sentinel",
        payload: "payload-secret-sentinel",
      } as DiagnosticEvent & Record<string, unknown>);
      const files = readdirSync(directory).filter((file) => file.endsWith(".jsonl"));
      assert.equal(files.length, 1);
      assert.match(files[0], /^runtime-\d+\.jsonl$/u);
      const lines = readFileSync(join(directory, files[0]), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines[0]).toMatchObject({
        layer: "runtime",
        request_id: 17,
        method: "tools/call",
        tool: "workflow_parent_get",
        workflow_id: { kind: "valid", prefix: "12345678" },
      });
      expect(readFileSync(join(directory, files[0]), "utf8")).not.toContain("secret-sentinel");
      for (let index = 0; index < 20; index += 1) recorder.record({ event: "full" });
      expect(readFileSync(join(directory, files[0]), "utf8").length).toBeLessThanOrEqual(1024);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("cleanup and diagnostic I/O failures do not affect workflow results", () => {
    const directory = mkdtempSync(join(tmpdir(), "workflow-diagnostics-cleanup-"));
    const file = join(directory, "runtime-old.jsonl");
    try {
      for (let index = 0; index < 10; index += 1) {
        writeFileSync(join(directory, `runtime-old-${index}.jsonl`), "{}\n");
      }
      const recorder = new DiagnosticRecorder("runtime", "/", {
        directory,
        enabled: true,
        maxFiles: 3,
      });
      expect(
        readdirSync(directory).filter((entry) => entry.endsWith(".jsonl")).length,
      ).toBeLessThanOrEqual(3);
      const failed = new DiagnosticRecorder("runtime", "/", { enabled: true, directory: file });
      expect(() => failed.record({ event: "must-not-throw" })).not.toThrow();
      recorder.record({ event: "cleanup-complete" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("distinguishes malformed IDs from valid missing rows while preserving ERROR_NOT_FOUND", () => {
    const { root } = fixture();
    const directory = mkdtempSync(join(tmpdir(), "workflow-diagnostics-lookup-"));
    const databasePath = join(root, "state.sqlite");
    try {
      const recorder = new DiagnosticRecorder("runtime-store", root, { enabled: true, directory });
      const store = new WorkflowStore({
        repositoryRoot: root,
        databasePath,
        diagnostics: recorder,
      });
      assert.throws(
        () => store.runtimeAffinity("malformed-id"),
        (error: unknown) => error instanceof WorkflowError && error.category === "ERROR_NOT_FOUND",
      );
      assert.throws(
        () => store.runtimeAffinity("12345678-1234-1234-1234-123456789abc"),
        (error: unknown) => error instanceof WorkflowError && error.category === "ERROR_NOT_FOUND",
      );
      store.close();
      const content = readFileSync(recorder.path, "utf8");
      expect(content).toContain('"outcome":"malformed_id"');
      expect(content).toContain('"outcome":"missing_row"');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
