#!/usr/bin/env bun

import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TRUSTED_PATHS = [
  ".codex/workflow-mcp",
  ".codex/agents/change-receipt.ts",
  ".codex/agents/receipt.ts",
] as const;

function git(root: string, args: readonly string[]): Buffer {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error("committed runtime supervisor could not be resolved");
  }
}

function committedRevision(root: string): string {
  const revision = git(root, ["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("committed runtime supervisor revision is invalid");
  }
  return revision;
}

function canonicalRepositoryRoot(path: string): string {
  const topLevel = git(path, ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  return realpathSync(topLevel);
}

function assertRegularTrustedFiles(root: string, revision: string): void {
  const tree = git(root, ["ls-tree", "-r", "-z", revision, "--", ...TRUSTED_PATHS])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  if (tree.length === 0) throw new Error("committed runtime supervisor source is missing");
  for (const entry of tree) {
    const separator = entry.indexOf("\t");
    const [mode, type] = entry.slice(0, separator).split(" ");
    if (type !== "blob" || (mode !== "100644" && mode !== "100755")) {
      throw new Error("committed runtime supervisor contains an unsupported file type");
    }
  }
  if (!tree.some((entry) => entry.endsWith("\t.codex/workflow-mcp/runtime-supervisor.ts"))) {
    throw new Error("committed runtime supervisor source is missing");
  }
}

function materializeCommittedSupervisor(root: string, revision: string): string {
  assertRegularTrustedFiles(root, revision);
  const staging = mkdtempSync(join(tmpdir(), "workflow-mcp-supervisor-"));
  const archive = join(staging, "source.tar");
  const source = join(staging, "source");
  mkdirSync(source, { mode: 0o700 });
  try {
    git(root, ["archive", "--format=tar", `--output=${archive}`, revision, "--", ...TRUSTED_PATHS]);
    execFileSync("tar", ["-xf", archive, "-C", source], {
      stdio: ["ignore", "ignore", "ignore"],
      maxBuffer: 1024 * 1024,
    });
    rmSync(archive, { force: true });
    const supervisor = join(source, ".codex/workflow-mcp/runtime-supervisor.ts");
    const stat = lstatSync(supervisor);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("committed runtime supervisor is not a regular file");
    }
    return staging;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function launchCommittedSupervisor(providerRoot: string): number {
  const root = canonicalRepositoryRoot(providerRoot);
  const supervisedRoot = canonicalRepositoryRoot(process.cwd());
  if (root !== supervisedRoot) {
    throw new Error("committed runtime supervisor and supervised repository roots do not match");
  }
  const revision = committedRevision(root);
  const staging = materializeCommittedSupervisor(root, revision);
  const supervisor = join(staging, "source/.codex/workflow-mcp/runtime-supervisor.ts");
  const cacheRoot = process.env.WORKFLOW_MCP_RUNTIME_CACHE_ROOT;
  const installDependencies = process.env.WORKFLOW_MCP_INSTALL_DEPENDENCIES === "0";
  const script = `import { main } from ${JSON.stringify(pathToFileURL(supervisor).href)}; main({ providerRoot: ${JSON.stringify(root)}${cacheRoot ? `, cacheRoot: ${JSON.stringify(cacheRoot)}` : ""}${installDependencies ? ", installDependencies: false" : ""} });`;
  try {
    const result = spawnSync(process.execPath, ["--no-warnings", "--eval", script], {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// This checkout entrypoint is intentionally only a launcher. The supervisor itself is loaded from
// the provider's committed source into a private temporary directory before it is imported.
if (import.meta.main) {
  try {
    // The target checkout remains the workflow repository, while this provider checkout supplies
    // committed runtime revisions. The host command supplies the trusted provider root; the
    // legacy direct-entry fallback derives it from this module's committed location.
    const providerRoot =
      process.env.WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT ?? resolve(import.meta.dir, "../..");
    process.exitCode = launchCommittedSupervisor(providerRoot);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "runtime bootstrap failed"}\n`,
    );
    process.exitCode = 1;
  }
}
