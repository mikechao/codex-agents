import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";
import {
  authorized,
  category,
  currentVersion,
  deterministicParentActions,
  implementation,
  input,
  rawState,
  review,
} from "./workflow-test-helpers.js";

test("commit preparation failures distinguish staged scope, stale review, and retry recovery", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const first = authorized(store, root, git, { objective: "scope failure" });
    const gitHead = join(root, ".git", "HEAD");
    const unavailableHead = join(root, ".git", "HEAD.unavailable");
    const beforeUnavailable = rawState(store, first.id);
    renameSync(gitHead, unavailableHead);
    try {
      assert.deepEqual(store.committerGet(first.id).permitted_next_actions, []);
      assert.equal(store.operatorDecisionGet(first.id).primary.kind, "operator_intervention");
      assert.equal(
        category(() =>
          store.prepareCommit({
            workflow_id: first.id,
            expected_version: beforeUnavailable.version,
          }),
        ),
        "ERROR_NOT_REPOSITORY",
      );
      assert.deepEqual(rawState(store, first.id), beforeUnavailable);
    } finally {
      renameSync(unavailableHead, gitHead);
    }
    assert.deepEqual(store.committerGet(first.id).permitted_next_actions, [
      "workflow_prepare_commit",
    ]);
    const failed = store.prepareCommit({
      workflow_id: first.id,
      expected_version: currentVersion(store, first.id),
    });
    assert.equal(failed.phase, "STOPPED_COMMIT_PREPARATION");
    assert.equal(failed.stop_context.category, "ERROR_STAGED_SCOPE");
    assert.equal(failed.stop_context.recovery, "retry");
    assert.ok(failed.commit_authorization);
    assert.ok(failed.review_receipt === undefined);
    assert.equal(rawState(store, first.id).review_receipt !== null, true);
    assert.equal(failed.commit_preparation, null);
    assert.equal(failed.commit_result, null);
    assert.deepEqual(deterministicParentActions(store, first.id), [
      "workflow_retry_commit_preparation",
    ]);
    git("add", "note.txt");
    const retried = store.retryCommitPreparation({
      workflow_id: first.id,
      expected_version: currentVersion(store, first.id),
      retry_context: "stage the reviewed path",
    });
    assert.equal(retried.phase, "COMMIT_AUTHORIZED");
    assert.equal(retried.stop_context, null);
    assert.deepEqual(retried.recovery_context.kind, "commit");
    assert.equal(retried.recovery_context.context, "stage the reviewed path");
    assert.ok(retried.commit_authorization);
    assert.equal(retried.commit_preparation, null);
    assert.equal(retried.commit_result, null);
    assert.equal(rawState(store, first.id).review_receipt !== null, true);
    const prepared = store.prepareCommit({
      workflow_id: first.id,
      expected_version: currentVersion(store, first.id),
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");

    const second = authorized(store, root, git, { objective: "stale review" });
    writeFileSync(join(root, "note.txt"), "changed after approval\n");
    const stale = store.prepareCommit({
      workflow_id: second.id,
      expected_version: currentVersion(store, second.id),
    });
    assert.equal(stale.phase, "STOPPED_COMMIT_PREPARATION");
    assert.equal(stale.stop_context.category, "ERROR_STALE_RECEIPT");
    assert.equal(stale.stop_context.recovery, "review");
    assert.deepEqual(store.parentGet(second.id).permitted_next_actions, [
      "workflow_return_commit_to_review",
    ]);
    const returned = store.returnCommitToReview({
      workflow_id: second.id,
      expected_version: currentVersion(store, second.id),
      review_context: "review changed worktree",
    });
    assert.equal(returned.phase, "REVIEWING");
    assert.equal(returned.stop_context, null);
    assert.equal(returned.commit_authorization, null);
    assert.equal(rawState(store, second.id).review_receipt, null);
    assert.equal(rawState(store, second.id).review_start_receipt, null);
    assert.equal(rawState(store, second.id).commit_preparation, null);
    assert.equal(rawState(store, second.id).commit_result, null);
    assert.equal(returned.implementation_summary, "implementation evidence");
    assert.deepEqual(returned.recovery_context.kind, "review");
    assert.equal(returned.recovery_context.context, "review changed worktree");
    review(store, second.created);
    assert.equal(
      store.authorizeCommit({
        workflow_id: second.id,
        expected_version: currentVersion(store, second.id),
        user_authorization: "fresh authorization",
      }).phase,
      "COMMIT_AUTHORIZED",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit preparation store matrix preserves Git state and routes every failure", () => {
  const scopeCases = [
    {
      name: "empty",
      stage: (_git: (...args: string[]) => string, _root: string) => {},
    },
    {
      name: "partial",
      stage: (git: (...args: string[]) => string) => git("add", "note.txt"),
    },
    {
      name: "extra and untracked",
      stage: (git: (...args: string[]) => string, root: string) => {
        writeFileSync(join(root, "untracked.txt"), "untracked\n");
        git("add", "note.txt", "other.txt", "untracked.txt");
      },
    },
  ];
  for (const candidate of scopeCases) {
    const { root, git } = fixture();
    let store: any = new WorkflowStore({
      repositoryRoot: root,
      databasePath: candidate.name === "empty" ? join(root, "matrix.sqlite") : ":memory:",
    });
    try {
      const workflow = authorized(store, root, git, {
        objective: `scope ${candidate.name}`,
        approved_paths: ["note.txt", "other.txt"],
      });
      candidate.stage(git, root);
      const id = workflow.id;
      const headBefore = git("rev-parse", "HEAD");
      const statusBefore = git("status", "--porcelain");
      const stagedBefore = git("diff", "--cached", "--name-status");
      const stopped = store.prepareCommit({
        workflow_id: id,
        expected_version: currentVersion(store, id),
      });
      assert.equal(stopped.phase, "STOPPED_COMMIT_PREPARATION", candidate.name);
      assert.equal(stopped.stop_context.category, "ERROR_STAGED_SCOPE", candidate.name);
      assert.equal(
        stopped.stop_context.recovery,
        candidate.name === "extra and untracked" ? "choose" : "retry",
        candidate.name,
      );
      assert.equal(stopped.commit_preparation, null);
      assert.equal(stopped.commit_result, null);
      assert.equal(git("rev-parse", "HEAD"), headBefore, candidate.name);
      assert.equal(git("status", "--porcelain"), statusBefore, candidate.name);
      assert.equal(git("diff", "--cached", "--name-status"), stagedBefore, candidate.name);
      assert.deepEqual(
        deterministicParentActions(store, id),
        candidate.name === "extra and untracked"
          ? ["workflow_reconcile_staged_scope"]
          : ["workflow_retry_commit_preparation"],
      );
      if (candidate.name === "empty") {
        const version = stopped.version;
        store.close();
        store = new WorkflowStore({
          repositoryRoot: root,
          databasePath: join(root, "matrix.sqlite"),
        });
        assert.equal(currentVersion(store, id), version);
        assert.equal(store.audit(id).at(-1).event_type, "COMMIT_PREPARATION_FAILED");
      }
      if (candidate.name === "extra and untracked") {
        const versionBeforeBlockedRetry = currentVersion(store, id);
        assert.equal(
          category(() =>
            store.retryCommitPreparation({
              workflow_id: id,
              expected_version: versionBeforeBlockedRetry,
              retry_context: "preserve approved scope after accidental staging",
            }),
          ),
          "ERROR_INVALID_TRANSITION",
        );
        assert.equal(currentVersion(store, id), versionBeforeBlockedRetry);
        git("reset", "-q", "--", "untracked.txt");
      }
      const retried = store.retryCommitPreparation({
        workflow_id: id,
        expected_version: currentVersion(store, id),
        retry_context: `repair ${candidate.name}`,
      });
      assert.equal(retried.phase, "COMMIT_AUTHORIZED", candidate.name);
      if (candidate.name === "extra and untracked") {
        assert.equal(
          store.prepareCommit({
            workflow_id: id,
            expected_version: currentVersion(store, id),
          }).phase,
          "COMMIT_PREPARED",
        );
      }
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  const contentAndModeCases = [
    {
      name: "content",
      mutate: (root: string, git: (...args: string[]) => string) => {
        const blob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], {
          input: "tampered\n",
          encoding: "utf8",
        }).trim();
        git("update-index", "--cacheinfo", "100644", blob, "note.txt");
      },
    },
    {
      name: "mode",
      mutate: (_root: string, git: (...args: string[]) => string) =>
        git("update-index", "--chmod=+x", "note.txt"),
    },
  ];
  for (const candidate of contentAndModeCases) {
    const { root, git } = fixture();
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    try {
      const workflow = authorized(store, root, git, { objective: candidate.name });
      git("add", "note.txt");
      candidate.mutate(root, git);
      const headBefore = git("rev-parse", "HEAD");
      const statusBefore = git("status", "--porcelain");
      const stopped = store.prepareCommit({
        workflow_id: workflow.id,
        expected_version: currentVersion(store, workflow.id),
      });
      assert.equal(stopped.stop_context.category, "ERROR_STAGED_CONTENT", candidate.name);
      assert.equal(stopped.stop_context.recovery, "retry", candidate.name);
      assert.equal(git("rev-parse", "HEAD"), headBefore, candidate.name);
      assert.equal(git("status", "--porcelain"), statusBefore, candidate.name);
      assert.deepEqual(deterministicParentActions(store, workflow.id), [
        "workflow_retry_commit_preparation",
      ]);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  const staleCases = [
    {
      name: "stale receipt",
      mutate: (root: string, _git: (...args: string[]) => string) =>
        writeFileSync(join(root, "note.txt"), "changed after approval\n"),
    },
    {
      name: "changed HEAD",
      mutate: (_root: string, git: (...args: string[]) => string) =>
        git("commit", "--allow-empty", "-qm", "external head"),
    },
  ];
  for (const candidate of staleCases) {
    const { root, git } = fixture();
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    try {
      const workflow = authorized(store, root, git, { objective: candidate.name });
      candidate.mutate(root, git);
      const stopped = store.prepareCommit({
        workflow_id: workflow.id,
        expected_version: currentVersion(store, workflow.id),
      });
      assert.equal(stopped.stop_context.category, "ERROR_STALE_RECEIPT", candidate.name);
      assert.equal(stopped.stop_context.recovery, "review", candidate.name);
      assert.equal("reconciliation_paths" in stopped.stop_context, false, candidate.name);
      assert.doesNotMatch(stopped.stop_context.summary, /rename|reconcil/iu, candidate.name);
      const staleDecision = store.operatorDecisionGet(workflow.id);
      assert.equal(
        staleDecision.recovery_summary.choice,
        "return_commit_to_review",
        candidate.name,
      );
      assert.doesNotMatch(JSON.stringify(staleDecision), /rename reconciliation/iu, candidate.name);
      assert.deepEqual(deterministicParentActions(store, workflow.id), [
        "workflow_return_commit_to_review",
      ]);
      const returned = store.returnCommitToReview({
        workflow_id: workflow.id,
        expected_version: currentVersion(store, workflow.id),
        review_context: `refresh ${candidate.name}`,
      });
      assert.equal(returned.phase, "REVIEWING", candidate.name);
      assert.equal(returned.commit_authorization, null, candidate.name);
      assert.equal(returned.review_receipt, undefined, candidate.name);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }

  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "range.txt"), "range\n");
    git("add", "range.txt");
    git("commit", "-qm", "range head");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const range = store.create(
      input(git, {
        workflow_type: "review_only",
        approved_paths: ["range.txt"],
        validation_requirements: [],
        review_target: {
          review_mode: "commit_range",
          base_revision: base,
          head_revision: head,
          approved_paths: ["range.txt"],
          include_staged: false,
          include_unstaged: false,
          include_untracked: false,
        },
      }),
    );
    const rangeId = range.workflow_id;
    store.submitReview({
      workflow_id: rangeId,
      expected_version: currentVersion(store, rangeId),
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    const beforeVersion = currentVersion(store, rangeId);
    const beforeAudit = store.audit(rangeId);
    assert.equal(
      category(() =>
        store.prepareCommit({
          workflow_id: rangeId,
          expected_version: beforeVersion,
        }),
      ),
      "ERROR_COMMIT_NOT_ALLOWED",
    );
    assert.equal(currentVersion(store, rangeId), beforeVersion);
    assert.deepEqual(store.audit(rangeId), beforeAudit);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("return-to-review legality preflights receipt reconstruction", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const workflow = authorized(store, root, git, { objective: "return receipt readiness" });
    writeFileSync(join(root, "note.txt"), "changed after approval\n");
    const stopped = store.prepareCommit({
      workflow_id: workflow.id,
      expected_version: currentVersion(store, workflow.id),
    });
    assert.equal(stopped.phase, "STOPPED_COMMIT_PREPARATION");
    assert.equal(stopped.stop_context.recovery, "review");

    git("commit", "--allow-empty", "-qm", "advance before review recovery");
    unlinkSync(join(root, "note.txt"));
    mkdirSync(join(root, "note.txt"));
    const before = rawState(store, workflow.id);
    assert.deepEqual(store.parentGet(workflow.id).permitted_next_actions, []);
    assert.equal(store.operatorDecisionGet(workflow.id).primary.kind, "operator_intervention");
    assert.equal(
      category(() =>
        store.returnCommitToReview({
          workflow_id: workflow.id,
          expected_version: before.version,
          review_context: "reconstruct review target",
        }),
      ),
      "ERROR_DIRECTORY_PATH",
    );
    assert.deepEqual(rawState(store, workflow.id), before);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit result rejects malformed claims and records terminal verification mismatches", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const first = authorized(store, root, git, { objective: "result validation" });
    git("add", "note.txt");
    const prepared = store.prepareCommit({
      workflow_id: first.id,
      expected_version: currentVersion(store, first.id),
    });
    const submit = (overrides: any = {}) =>
      store.submitCommitResult({
        workflow_id: first.id,
        expected_version: currentVersion(store, first.id),
        attempt_id: prepared.commit_preparation.attempt_id,
        outcome: "committed",
        failure_summary: null,
        ...overrides,
      });
    assert.equal(
      category(() => submit({ outcome: "mismatch" })),
      "ERROR_INVALID_SHAPE",
    );
    assert.equal(
      category(() => submit({ outcome: "committed", failure_summary: "unexpected" })),
      "ERROR_INVALID_SHAPE",
    );
    assert.equal(
      category(() => submit({ attempt_id: "0".repeat(36) })),
      "ERROR_COMMIT_MISMATCH",
    );
    const before = currentVersion(store, first.id);
    assert.equal(currentVersion(store, first.id), before);

    git("commit", "-qm", "unexpected head");
    git("commit", "--allow-empty", "-qm", "unexpected second head");
    const mismatch = submit();
    assert.equal(mismatch.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(mismatch.commit_result.mismatch_category, "PARENT_MISMATCH");
    assert.deepEqual(mismatch.permitted_next_actions, []);
    assert.equal(
      category(() =>
        store.retryCommit({
          workflow_id: first.id,
          expected_version: currentVersion(store, first.id),
          retry_context: "cannot retry terminal mismatch",
        }),
      ),
      "ERROR_INVALID_TRANSITION",
    );
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit verification distinguishes every prepared-result mismatch and preserves terminal guards", () => {
  const cases = [
    {
      name: "HEAD_CHANGED",
      mutate: (_root: string, _git: (...args: string[]) => string) => {},
      outcome: "committed",
      expected: "HEAD_CHANGED",
    },
    {
      name: "TREE_MISMATCH",
      mutate: (root: string, git: (...args: string[]) => string) => {
        writeFileSync(join(root, "note.txt"), "tree changed after preparation\n");
        git("add", "note.txt");
        git("commit", "-qm", "tree mismatch");
      },
      outcome: "committed",
      expected: "TREE_MISMATCH",
    },
    {
      name: "PATH_MISMATCH",
      mutate: (_root: string, _git: (...args: string[]) => string, store: any, id: string) => {
        const state = rawState(store, id);
        _git("commit", "-qm", "path mismatch source");
        state.commit_preparation.expected_paths = ["other.txt"];
        store.db
          .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
          .run(JSON.stringify(state), objectDigest(state), id);
      },
      outcome: "committed",
      expected: "PATH_MISMATCH",
    },
    {
      name: "changed-head not-committed",
      mutate: (_root: string, git: (...args: string[]) => string) => {
        git("commit", "--allow-empty", "-qm", "head changed before failure report");
      },
      outcome: "not_committed",
      expected: "HEAD_CHANGED",
    },
  ];
  for (const candidate of cases) {
    const { root, git } = fixture();
    try {
      const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
      const authorizedWorkflow = authorized(store, root, git, { objective: candidate.name });
      git("add", "note.txt");
      const prepared = store.prepareCommit({
        workflow_id: authorizedWorkflow.id,
        expected_version: currentVersion(store, authorizedWorkflow.id),
      });
      candidate.mutate(root, git, store, authorizedWorkflow.id);
      const result = store.submitCommitResult({
        workflow_id: authorizedWorkflow.id,
        expected_version: currentVersion(store, authorizedWorkflow.id),
        attempt_id: prepared.commit_preparation.attempt_id,
        outcome: candidate.outcome,
        failure_summary: candidate.outcome === "committed" ? null : "external commit failed",
      });
      assert.equal(result.phase, "STOPPED_COMMIT_MISMATCH", candidate.name);
      assert.equal(result.commit_result.mismatch_category, candidate.expected, candidate.name);
      assert.deepEqual(result.permitted_next_actions, []);
      assert.equal(
        category(() =>
          store.retryCommit({
            workflow_id: authorizedWorkflow.id,
            expected_version: currentVersion(store, authorizedWorkflow.id),
            retry_context: "terminal mismatch cannot retry",
          }),
        ),
        "ERROR_INVALID_TRANSITION",
        candidate.name,
      );
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("post-commit hook-created extra commits are rejected as a parent mismatch", () => {
  const { root, git } = fixture();
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(
      join(root, ".git", "hooks", "post-commit"),
      "#!/bin/sh\nif [ ! -f .hook-ran ]; then\n  touch .hook-ran\n  git commit --allow-empty -qm 'hook extra commit'\nfi\n",
    );
    chmodSync(join(root, ".git", "hooks", "post-commit"), 0o755);
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const authorizedWorkflow = authorized(store, root, git, { objective: "hook extra commit" });
    git("add", "note.txt");
    const prepared = store.prepareCommit({
      workflow_id: authorizedWorkflow.id,
      expected_version: currentVersion(store, authorizedWorkflow.id),
    });
    git("commit", "-qm", "primary commit");
    const result = store.submitCommitResult({
      workflow_id: authorizedWorkflow.id,
      expected_version: currentVersion(store, authorizedWorkflow.id),
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "committed",
      failure_summary: null,
    });
    assert.equal(result.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(result.commit_result.mismatch_category, "PARENT_MISMATCH");
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit preparation binds exact modify, add, delete, and mode paths", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "mod.txt"), "before\n");
    writeFileSync(join(root, "del.txt"), "delete\n");
    writeFileSync(join(root, "mode.txt"), "mode\n");
    git("add", ".");
    git("commit", "-qm", "preparation fixture");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: ":memory:" });
    const approvedPaths = ["add.txt", "del.txt", "mod.txt", "mode.txt"];
    const created = store.create(input(git, { approved_paths: approvedPaths }));
    const id = created.workflow_id;
    implementation(store, created);
    writeFileSync(join(root, "mod.txt"), "after\n");
    writeFileSync(join(root, "add.txt"), "added\n");
    unlinkSync(join(root, "del.txt"));
    chmodSync(join(root, "mode.txt"), 0o755);
    review(store, created);
    store.authorizeCommit({
      workflow_id: id,
      expected_version: currentVersion(store, id),
      user_authorization: "exact preparation",
    });
    for (const path of approvedPaths) git("add", path);
    const tree = git("write-tree");
    const prepared = store.prepareCommit({
      workflow_id: id,
      expected_version: currentVersion(store, id),
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    assert.deepEqual(prepared.commit_preparation.expected_paths, approvedPaths);
    assert.equal(prepared.commit_preparation.prepared_tree, tree);
    assert.equal(git("rev-parse", "HEAD"), created.base_head);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
