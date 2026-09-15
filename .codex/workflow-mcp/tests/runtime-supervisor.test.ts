import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { currentHead } from "../git.js";
import type { ResolvedRuntime } from "../runtime-supervisor.js";
import {
  augmentHistoricalRecovery,
  RuntimeSupervisor,
  requestsCurrentRuntime,
  resolveOwningRuntime,
  selectAffinedRuntime,
} from "../runtime-supervisor.js";
import { createRuntimeAttestation, WorkflowStore } from "../store.js";
import type { GitCommitSha, RuntimeId } from "../types.js";
import { objectDigest, runtimeId as validateRuntimeId } from "../validation.js";
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

function dirtyAdoptionAudit(revision: string) {
  const runtimeId = "a".repeat(64);
  return {
    scope_expansion_id: "expansion",
    scope_expansion_version: 1,
    adopted_paths: ["note.txt"],
    base_head: revision,
    current_states: [{ path: "note.txt", state: "unchanged", kind: "file" }],
    index_states: [{ path: "note.txt", state: "unchanged", kind: "file" }],
    current_state_commitment: "b".repeat(64),
    runtime_id: runtimeId,
    runtime_revision: revision,
    executing_runtime_id: runtimeId,
    executing_runtime_revision: revision,
    cross_runtime: false,
    reason: "test",
    user_authorization: "authorized",
  };
}

function operatorProjectionResponse(primary: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [{ type: "text", text: JSON.stringify({ primary }) }],
    },
  };
}

function resolvedRuntime(runtimeId: string, revision: string): ResolvedRuntime {
  return {
    runtime_id: validateRuntimeId(runtimeId),
    revision: revision as GitCommitSha,
  } as ResolvedRuntime;
}

function affinity(
  runtimeId: string,
  revision: string,
): {
  runtime_id: RuntimeId;
  runtime_revision: GitCommitSha;
} {
  return { runtime_id: validateRuntimeId(runtimeId), runtime_revision: revision as GitCommitSha };
}

const operatorProjectionRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: {
    name: "workflow_operator_decision_get",
    arguments: { workflow_id: "00000000-0000-4000-8000-000000000001" },
  },
};

describe("Workflow MCP runtime supervision", () => {
  test("classifies only reconciliation control requests as current-runtime routes", () => {
    const reconciled = operatorProjectionRequest;
    const worker = {
      ...operatorProjectionRequest,
      params: { ...operatorProjectionRequest.params, name: "workflow_implementer_get" },
    };
    const commitResult = {
      ...operatorProjectionRequest,
      params: {
        ...operatorProjectionRequest.params,
        name: "workflow_reconcile_commit_result",
      },
    };
    let lookedUp = false;
    const lookup = () => {
      lookedUp = true;
      return true;
    };

    assert.equal(requestsCurrentRuntime(commitResult, lookup), true);
    assert.equal(lookedUp, false);
    assert.equal(requestsCurrentRuntime(reconciled, lookup), true);
    assert.equal(requestsCurrentRuntime(worker, lookup), false);
    assert.equal(
      requestsCurrentRuntime(
        {
          ...reconciled,
          params: { ...reconciled.params, name: "workflow_operator_decision_get" },
        },
        () => false,
      ),
      false,
    );
  });

  test("selects an exact live child before historical resolution", () => {
    const defaultRuntime = resolvedRuntime("d".repeat(64), "default");
    const historicalRuntime = resolvedRuntime("a".repeat(64), "revision-a");
    const fallbackRuntime = resolvedRuntime("a".repeat(64), "revision-a");
    const children = new Map([
      [
        `${historicalRuntime.runtime_id}\u0000${historicalRuntime.revision}`,
        {
          artifact: historicalRuntime,
          dead: false,
          killed: false,
        },
      ],
    ]);
    let resolutions = 0;
    const resolveOwner = () => {
      resolutions += 1;
      return fallbackRuntime;
    };
    const lookup = (runtimeId: string, revision: string) =>
      children.get(`${runtimeId}\u0000${revision}`);

    assert.equal(
      selectAffinedRuntime(
        { runtime_id: historicalRuntime.runtime_id, runtime_revision: historicalRuntime.revision },
        defaultRuntime,
        lookup,
        resolveOwner,
      ),
      historicalRuntime,
    );
    assert.equal(
      selectAffinedRuntime(
        { runtime_id: historicalRuntime.runtime_id, runtime_revision: historicalRuntime.revision },
        defaultRuntime,
        lookup,
        resolveOwner,
      ),
      historicalRuntime,
    );
    assert.equal(resolutions, 0);
  });

  test("revalidates when the exact live child is unavailable or invalid", () => {
    const defaultRuntime = resolvedRuntime("d".repeat(64), "default");
    const runtimeId = "a".repeat(64);
    const revisionA = "revision-a";
    const revisionB = "revision-b";
    const fallbackRuntime = resolvedRuntime(runtimeId, revisionB);
    const candidates = new Map([
      [
        `${runtimeId}\u0000${revisionA}`,
        {
          artifact: resolvedRuntime(runtimeId, revisionA),
          dead: false,
          killed: false,
        },
      ],
      [
        `${runtimeId}\u0000dead`,
        {
          artifact: resolvedRuntime(runtimeId, "dead"),
          dead: true,
          killed: false,
        },
      ],
      [
        `${runtimeId}\u0000killed`,
        {
          artifact: resolvedRuntime(runtimeId, "killed"),
          dead: false,
          killed: true,
        },
      ],
    ]);
    const calls: string[] = [];
    const lookup = (candidateRuntimeId: string, revision: string) =>
      candidates.get(`${candidateRuntimeId}\u0000${revision}`);
    const resolveOwner = (affinity: {
      runtime_id: string | null;
      runtime_revision: string | null;
    }) => {
      calls.push(`${affinity.runtime_id}\u0000${affinity.runtime_revision}`);
      return fallbackRuntime;
    };

    for (const revision of ["missing", "dead", "killed", revisionB]) {
      assert.equal(
        selectAffinedRuntime(affinity(runtimeId, revision), defaultRuntime, lookup, resolveOwner),
        fallbackRuntime,
      );
    }

    assert.deepEqual(calls, [
      `${runtimeId}\u0000missing`,
      `${runtimeId}\u0000dead`,
      `${runtimeId}\u0000killed`,
      `${runtimeId}\u0000${revisionB}`,
    ]);
  });

  test("evicts a child whose historical initialization fails", async () => {
    const artifact = resolvedRuntime("a".repeat(64), "revision-a");
    const key = `${artifact.runtime_id}\u0000${artifact.revision}`;
    let killed = false;
    let readerClosed = false;
    const child: any = {
      artifact,
      process: {
        stdin: { write: () => true, destroy: () => undefined },
        kill: () => {
          killed = true;
          return true;
        },
      },
      reader: { close: () => (readerClosed = true) },
      initialized: false,
      initializing: null,
      initId: null,
      initializingResponseIds: new Set(),
      initResolve: null,
      initReject: null,
      initializationRequestId: undefined,
      pending: new Map(),
      tools: null,
      dead: false,
    };
    const supervisor: any = Object.create(RuntimeSupervisor.prototype);
    supervisor.initialized = true;
    supervisor.initializationLines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
    ];
    supervisor.children = new Map([[key, child]]);

    const initializing = supervisor.initializeOwner(child);
    child.initReject(new WorkflowError("ERROR_RUNTIME_RECOVERY", "test initialization failure"));
    await assert.rejects(
      initializing,
      (error: unknown) =>
        error instanceof WorkflowError && error.detail === "test initialization failure",
    );
    assert.equal(child.dead, true);
    assert.equal(supervisor.children.has(key), false);
    assert.equal(killed, true);
    assert.equal(readerClosed, true);
  });

  test("historical operator projection overrides only for legal reconciliation", () => {
    const owner = operatorProjectionResponse({ kind: "no_user_action", route: "commit" });
    const reconciliation = {
      primary: {
        kind: "reconcile_commit",
        reason: "an existing commit requires server-owned result reconciliation",
      },
    };
    const routed = augmentHistoricalRecovery(
      operatorProjectionRequest,
      owner,
      true,
      () => {
        throw new Error("operator routing must not run a separate action preflight");
      },
      () => reconciliation,
    );
    assert.deepEqual(JSON.parse((routed.result as any).content[0].text), reconciliation);
  });

  test("historical parent projection preserves reconciliation actions", () => {
    const request = {
      ...operatorProjectionRequest,
      params: { ...operatorProjectionRequest.params, name: "workflow_parent_get" },
    };
    const response = {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              workflow_id: request.params.arguments.workflow_id,
              phase: "COMMIT_PREPARED",
              permitted_next_actions: [],
            }),
          },
        ],
      },
    };
    const routed = augmentHistoricalRecovery(
      request,
      response,
      true,
      () => ["workflow_reconcile_commit_result"],
      () => ({ primary: { kind: "reconcile_commit" } }),
    );
    assert.deepEqual(JSON.parse((routed.result as any).content[0].text), {
      workflow_id: request.params.arguments.workflow_id,
      phase: "COMMIT_PREPARED",
      permitted_next_actions: ["workflow_reconcile_commit_result"],
    });
  });

  test("historical operator projection preserves the owner route when reconciliation changes", () => {
    const owner = operatorProjectionResponse({ kind: "no_user_action", route: "commit" });
    let actionPreflightRequested = false;
    const routed = augmentHistoricalRecovery(
      operatorProjectionRequest,
      owner,
      true,
      () => {
        actionPreflightRequested = true;
        return ["workflow_reconcile_commit_result"];
      },
      () => ({ primary: { kind: "operator_intervention" } }),
    );
    assert.equal(routed, owner);
    assert.equal(actionPreflightRequested, false);
  });

  test("historical terminal and verified-mismatch projections remain owner-authoritative", () => {
    for (const primary of [
      { kind: "terminal", outcome: "committed" },
      { kind: "terminal", outcome: "commit_mismatch" },
    ]) {
      const owner = operatorProjectionResponse(primary);
      assert.equal(
        augmentHistoricalRecovery(
          operatorProjectionRequest,
          owner,
          true,
          () => [],
          () => {
            throw new Error("terminal workflows do not have reconciliation readiness");
          },
        ),
        owner,
      );
    }
  });

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

  test("validates dirty-adoption runtime evidence when reading audit events", () => {
    const { root } = fixture();
    const revision = fixtureHead(root, "audit runtime evidence setup");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    try {
      const created = create(store, revision, "audit runtime evidence");
      const row = store.db
        .prepare("SELECT summary_json FROM audit_events WHERE workflow_id = ?")
        .get(created.workflow_id) as { summary_json: string };
      const summary = JSON.parse(row.summary_json);
      const validDetail = dirtyAdoptionAudit(revision);
      const writeDetail = (detail: unknown) =>
        store.db
          .prepare("UPDATE audit_events SET summary_json = ? WHERE workflow_id = ?")
          .run(JSON.stringify({ ...summary, dirty_scope_adoption: detail }), created.workflow_id);

      for (const detail of [
        { ...validDetail, runtime_id: "invalid" },
        { ...validDetail, runtime_revision: "invalid" },
        { ...validDetail, runtime_id: null },
      ]) {
        writeDetail(detail);
        assert.throws(
          () => store.audit(created.workflow_id),
          (error: unknown) =>
            error instanceof WorkflowError && error.category === "ERROR_STALE_ADOPTION",
        );
      }

      writeDetail(validDetail);
      const audit = store.audit(created.workflow_id);
      assert.deepEqual(audit[0].dirty_scope_adoption, validDetail);
      assert.deepEqual((audit[0].summary as any).dirty_scope_adoption, validDetail);
    } finally {
      store.close();
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

  test("rejects missing, mismatched, and borrowed launch attestations", () => {
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
      assert.throws(
        () =>
          new WorkflowStore({
            repositoryRoot: root,
            databasePath: path,
            runtimeId: foreignId,
            runtimeRevision: revision,
            runtimeAttestation: "malformed",
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
      const cases = [
        {
          name: "same-owner missing",
          options: { runtimeId: ownerId, runtimeRevision: revision },
        },
        {
          name: "same-owner mismatched",
          options: {
            runtimeId: ownerId,
            runtimeRevision: revision,
            runtimeAttestation: "0".repeat(64),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          },
        },
        {
          name: "same-owner borrowed",
          options: {
            runtimeId: ownerId,
            runtimeRevision: revision,
            runtimeAttestation: createRuntimeAttestation(ownerId, revision, nonce, "3".repeat(64)),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          },
        },
        {
          name: "foreign missing",
          options: { runtimeId: foreignId, runtimeRevision: revision },
        },
        {
          name: "foreign mismatched",
          options: {
            runtimeId: foreignId,
            runtimeRevision: revision,
            runtimeAttestation: "0".repeat(64),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          },
        },
        {
          name: "foreign borrowed",
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
          () => store.parentGet(created.workflow_id),
          (error: unknown) =>
            error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
          candidate.name,
        );
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
