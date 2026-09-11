import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { currentHead } from "../git.js";
import { RuntimeSupervisor, resolveOwningRuntime } from "../runtime-supervisor.js";
import { createRuntimeAttestation, WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";

function attestation(runtimeId: string, revision: string) {
  const nonce = "1".repeat(64);
  const key = "2".repeat(64);
  return {
    runtimeAttestation: createRuntimeAttestation(runtimeId, revision, nonce, key),
    runtimeAttestationNonce: nonce,
    runtimeAttestationKey: key,
  };
}

function fixtureHead(root: string, _stage: string): string {
  return currentHead(root);
}

function create(store: any, revision: string, objective: string) {
  return store.create({
    workflow_type: "change",
    objective,
    approved_plan: null,
    approved_paths: ["note.txt"],
    acceptance_criteria: ["criterion"],
    validation_requirements: [
      { description: "validation", kind: "command", argv: ["bun", "run", "check"] },
    ],
    review_target: {
      review_mode: "working_tree",
      base_revision: revision,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
  });
}

describe("Workflow MCP runtime supervision", () => {
  test("persists immutable runtime affinity and keeps it across reopen", () => {
    const { root } = fixture();
    const path = join(root, "runtime.sqlite");
    const revision = fixtureHead(root, "runtime affinity setup");
    const runtimeId = "a".repeat(64);
    try {
      const first: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId,
        runtimeRevision: revision,
      });
      const created = create(first, revision, "runtime affinity");
      expect(first.runtimeAffinity(created.workflow_id)).toEqual({
        runtime_id: runtimeId,
        runtime_revision: revision,
      });
      first.close();
      const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
      expect(reopened.runtimeAffinity(created.workflow_id)).toEqual({
        runtime_id: runtimeId,
        runtime_revision: revision,
      });
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps exact affinity reads visible across two long-lived WAL connections", () => {
    const { root } = fixture();
    const databasePath = join(root, "same-wal.sqlite");
    const revision = fixtureHead(root, "same WAL setup");
    const runtimeId = "a".repeat(64);
    let owner: any;
    let supervisor: any;
    try {
      owner = new WorkflowStore({
        repositoryRoot: root,
        databasePath,
        runtimeId,
        runtimeRevision: revision,
        ...attestation(runtimeId, revision),
      });
      supervisor = new WorkflowStore({
        repositoryRoot: root,
        databasePath,
        runtimeId,
        runtimeRevision: revision,
      });
      const created = create(owner, revision, "same WAL owner");
      for (let index = 0; index < 20; index += 1) {
        create(owner, revision, `same WAL write ${index}`);
        expect(supervisor.runtimeAffinity(created.workflow_id)).toEqual({
          runtime_id: runtimeId,
          runtime_revision: revision,
        });
        expect(owner.parentGet(created.workflow_id).workflow_id).toBe(created.workflow_id);
      }
      expect(owner.db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      const audit = owner.audit(created.workflow_id);
      expect(audit).toHaveLength(1);
      expect(audit[0].event_type).toBe("WORKFLOW_CREATED");
    } finally {
      owner?.close();
      supervisor?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed with runtime recovery for incomplete persisted affinity", () => {
    const { root } = fixture();
    const path = join(root, "incomplete.sqlite");
    try {
      const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
      const created = create(
        store,
        fixtureHead(root, "incomplete affinity setup"),
        "incomplete runtime",
      );
      const row = store.db
        .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
        .get(created.workflow_id) as { state_json: string };
      const state = JSON.parse(row.state_json);
      state.runtime_id = "a".repeat(64);
      state.runtime_revision = null;
      store.db
        .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
        .run(JSON.stringify(state), objectDigest(state), created.workflow_id);
      store.close();
      assert.throws(
        () => new WorkflowStore({ repositoryRoot: root, databasePath: path }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_RECOVERY",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects direct role access without the owning runtime identity", () => {
    const { root } = fixture();
    const path = join(root, "owned.sqlite");
    const revision = fixtureHead(root, "runtime ownership setup");
    const ownerId = "a".repeat(64);
    const foreignId = "b".repeat(64);
    try {
      const owner: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId: ownerId,
        runtimeRevision: revision,
        ...attestation(ownerId, revision),
      });
      const created = create(owner, revision, "owned workflow");
      owner.close();
      const foreign: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId: foreignId,
        runtimeRevision: revision,
      });
      assert.throws(
        () => foreign.parentGet(created.workflow_id),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
      assert.throws(
        () => foreign.implementerGet(created.workflow_id),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
      foreign.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for incomplete affinity and cross-repository providers", () => {
    assert.throws(
      () => resolveOwningRuntime(process.cwd(), { runtime_id: null, runtime_revision: null }),
      (error: unknown) =>
        error instanceof WorkflowError && error.category === "ERROR_RUNTIME_RECOVERY",
    );
    const provider = fixture();
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-isolation-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-isolation-db-"));
    try {
      assert.throws(
        () =>
          new RuntimeSupervisor({
            repositoryRoot: target.root,
            providerRoot: provider.root,
            cacheRoot,
            databasePath: join(databaseRoot, "state.sqlite"),
            installDependencies: false,
          }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
    } finally {
      rmSync(provider.root, { recursive: true, force: true });
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  });

  test("requires launch attestation before cross-runtime review start", () => {
    const { root } = fixture();
    const path = join(root, "cross-runtime-review.sqlite");
    const revision = fixtureHead(root, "cross-repository setup");
    const ownerId = "a".repeat(64);
    const foreignId = "b".repeat(64);
    const nonce = "1".repeat(64);
    const ownerKey = "2".repeat(64);
    try {
      const owner: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId: ownerId,
        runtimeRevision: revision,
        ...attestation(ownerId, revision),
      });
      const created = create(owner, revision, "cross-runtime review attestation");
      owner.close();
      const cases = [
        { name: "missing", options: { runtimeId: foreignId, runtimeRevision: revision } },
        {
          name: "mismatched",
          options: {
            runtimeId: foreignId,
            runtimeRevision: revision,
            runtimeAttestation: "0".repeat(64),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          },
        },
        {
          name: "borrowed",
          options: {
            runtimeId: foreignId,
            runtimeRevision: revision,
            runtimeAttestation: createRuntimeAttestation(
              foreignId,
              revision,
              nonce,
              "3".repeat(64),
            ),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          },
        },
      ];
      for (const candidate of cases) {
        const store: any = new WorkflowStore({
          repositoryRoot: root,
          databasePath: path,
          ...candidate.options,
        });
        assert.throws(
          () =>
            store.beginReviewCrossRuntime({
              workflow_id: created.workflow_id,
              expected_version: 0,
            }),
          (error: unknown) =>
            error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
          candidate.name,
        );
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
