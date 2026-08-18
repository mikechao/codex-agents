import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { currentHead } from "../git.js";
import {
  isValidRuntimeArtifact,
  materializeRuntimeArtifact,
  trustedRuntimeManifest,
} from "../runtime-artifact.js";

function gitFixture(
  files: Record<string, string>,
  symlinks: Record<string, string> = {},
): { root: string; revision: string } {
  const root = mkdtempSync(join(tmpdir(), "workflow-runtime-fixture-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Workflow Test"], { cwd: root });
  for (const [path, content] of Object.entries(files)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    writeFileSync(destination, content);
  }
  for (const [path, target] of Object.entries(symlinks)) {
    const destination = join(root, path);
    mkdirSync(join(destination, ".."), { recursive: true });
    symlinkSync(target, destination);
  }
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });
  return {
    root,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  };
}

function dependencyFile(root: string): string | undefined {
  const nodeModules = join(root, "node_modules");
  const pending = [nodeModules];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path) continue;
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const stat = lstatSync(child);
      if (stat.isDirectory()) pending.push(child);
      else if (stat.isFile()) return child;
    }
  }
  return undefined;
}

describe("Workflow MCP runtime artifacts", () => {
  test("fingerprints committed runtime closure and reuses a valid cache entry", () => {
    const root = process.cwd();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-cache-"));
    try {
      const revision = currentHead(root);
      const manifest = trustedRuntimeManifest(root, revision);
      expect(manifest.files.map((entry) => entry.path)).toContain(".codex/workflow-mcp/server.ts");
      expect(manifest.files.map((entry) => entry.path)).toContain(
        ".codex/agents/change-receipt.ts",
      );
      expect(manifest.package_metadata).toEqual(["bun.lock", "package.json"]);

      const first = materializeRuntimeArtifact(root, revision, { cacheRoot });
      expect(first.reused).toBe(false);
      expect(first.runtime_id).toMatch(/^[0-9a-f]{64}$/u);
      expect(first.runtimePath).toBe(join(first.cachePath, manifest.entrypoint));
      expect(relative(root, first.cachePath)).toMatch(/^\.\.(?:\/|\\)/u);
      expect(isValidRuntimeArtifact(first)).toBe(true);

      const second = materializeRuntimeArtifact(root, revision, { cacheRoot });
      expect(second.runtime_id).toBe(first.runtime_id);
      expect(second.runtimePath).toBe(first.runtimePath);
      expect(second.reused).toBe(true);

      writeFileSync(first.runtimePath, "corrupt\n");
      expect(isValidRuntimeArtifact(first)).toBe(false);
      const rebuilt = materializeRuntimeArtifact(root, revision, { cacheRoot });
      expect(rebuilt.reused).toBe(false);
      expect(readFileSync(rebuilt.runtimePath, "utf8")).toContain("workflow-state");
      expect(existsSync(join(rebuilt.cachePath, ".runtime-complete"))).toBe(true);

      const installedDependencyFile = dependencyFile(rebuilt.cachePath);
      expect(installedDependencyFile).toBeDefined();
      if (installedDependencyFile) {
        rmSync(installedDependencyFile);
        expect(isValidRuntimeArtifact(rebuilt)).toBe(false);
        const dependencyRebuilt = materializeRuntimeArtifact(root, revision, { cacheRoot });
        expect(dependencyRebuilt.reused).toBe(false);
        expect(isValidRuntimeArtifact(dependencyRebuilt)).toBe(true);
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  test("reuses the artifact when only unrelated committed content changes", () => {
    const fixture = gitFixture({
      "package.json": '{"name":"fixture","dependencies":{}}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
      ".codex/agents/change-receipt.ts": "export const receipt = true;\n",
      ".codex/agents/receipt.ts": "export const otherReceipt = true;\n",
      ".codex/workflow-mcp/server.ts": "export const server = true;\n",
    });
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-identity-cache-"));
    try {
      const first = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot,
        installDependencies: false,
      });
      const storedManifest = readFileSync(join(first.cachePath, ".runtime-manifest.json"), "utf8");
      writeFileSync(join(fixture.root, "unrelated.txt"), "unrelated\n");
      execFileSync("git", ["add", "unrelated.txt"], { cwd: fixture.root });
      execFileSync("git", ["commit", "-q", "-m", "unrelated"], { cwd: fixture.root });
      const secondRevision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.root,
        encoding: "utf8",
      }).trim();
      const second = materializeRuntimeArtifact(fixture.root, secondRevision, {
        cacheRoot,
        installDependencies: false,
      });

      expect(secondRevision).not.toBe(fixture.revision);
      expect(second.manifest.revision).toBe(secondRevision);
      expect(second.runtime_id).toBe(first.runtime_id);
      expect(second.cachePath).toBe(first.cachePath);
      expect(second.reused).toBe(true);
      expect(readFileSync(join(second.cachePath, ".runtime-manifest.json"), "utf8")).toBe(
        storedManifest,
      );
      expect(JSON.parse(storedManifest).revision).toBe(fixture.revision);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("assigns distinct identities to distinct committed runtime inputs", () => {
    const fixture = gitFixture({
      "package.json": '{"name":"fixture","dependencies":{}}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
      ".codex/agents/change-receipt.ts": "export const receipt = true;\n",
      ".codex/agents/receipt.ts": "export const otherReceipt = true;\n",
      ".codex/workflow-mcp/server.ts": 'export const server = "first";\n',
    });
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-trusted-change-cache-"));
    try {
      const first = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot,
        installDependencies: false,
      });
      writeFileSync(
        join(fixture.root, ".codex/workflow-mcp/server.ts"),
        'export const server = "second";\n',
      );
      execFileSync("git", ["add", ".codex/workflow-mcp/server.ts"], { cwd: fixture.root });
      execFileSync("git", ["commit", "-q", "-m", "trusted runtime change"], { cwd: fixture.root });
      const secondRevision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: fixture.root,
        encoding: "utf8",
      }).trim();
      const second = materializeRuntimeArtifact(fixture.root, secondRevision, {
        cacheRoot,
        installDependencies: false,
      });

      expect(secondRevision).not.toBe(fixture.revision);
      expect(second.runtime_id).not.toBe(first.runtime_id);
      expect(second.cachePath).not.toBe(first.cachePath);
      expect(isValidRuntimeArtifact(first)).toBe(true);
      expect(isValidRuntimeArtifact(second)).toBe(true);
      expect(readFileSync(first.runtimePath, "utf8")).toContain('server = "first"');
      expect(readFileSync(second.runtimePath, "utf8")).toContain('server = "second"');
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("materializes committed content despite dirty trusted runtime files", () => {
    const fixture = gitFixture({
      "package.json": '{"name":"fixture","dependencies":{}}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
      ".codex/agents/change-receipt.ts": "export const receipt = true;\n",
      ".codex/agents/receipt.ts": "export const otherReceipt = true;\n",
      ".codex/workflow-mcp/server.ts": 'export const server = "committed";\n',
    });
    const initialCacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-clean-cache-"));
    const freshCacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-dirty-cache-"));
    try {
      const committed = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot: initialCacheRoot,
        installDependencies: false,
      });
      const committedContent = readFileSync(committed.runtimePath, "utf8");
      writeFileSync(
        join(fixture.root, ".codex/workflow-mcp/server.ts"),
        'export const server = "dirty checkout";\n',
      );

      const isolated = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot: freshCacheRoot,
        installDependencies: false,
      });

      expect(isolated.runtime_id).toBe(committed.runtime_id);
      expect(isolated.manifest.revision).toBe(fixture.revision);
      expect(isolated.reused).toBe(false);
      expect(readFileSync(isolated.runtimePath, "utf8")).toBe(committedContent);
      expect(readFileSync(isolated.runtimePath, "utf8")).not.toContain("dirty checkout");
      expect(isValidRuntimeArtifact(isolated)).toBe(true);
    } finally {
      rmSync(initialCacheRoot, { recursive: true, force: true });
      rmSync(freshCacheRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("launches the materialized server without runtime sources in its checkout", async () => {
    const repository = process.cwd();
    const revision = currentHead(repository);
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-server-cache-"));
    const isolated = gitFixture({ "README.md": "runtime isolation fixture\n" });
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
    try {
      const artifact = materializeRuntimeArtifact(repository, revision, { cacheRoot });
      expect(existsSync(join(isolated.root, ".codex/workflow-mcp/server.ts"))).toBe(false);
      expect(existsSync(join(isolated.root, ".codex/agents/change-receipt.ts"))).toBe(false);

      transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--no-warnings", artifact.runtimePath],
        cwd: isolated.root,
        env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(isolated.root, "state.sqlite") },
        stderr: "pipe",
      });
      client = new Client(
        { name: "runtime-artifact-test", version: "1.0.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === "workflow_create")).toBe(true);
    } finally {
      await client?.close();
      await transport?.close();
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(isolated.root, { recursive: true, force: true });
    }
  });

  test("probes committed import candidates with Bun precedence and rejects absence", () => {
    const files = {
      "package.json": '{"name":"fixture","dependencies":{}}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
      ".codex/agents/change-receipt.ts": "export const receipt = true;\n",
      ".codex/agents/receipt.ts": "export const otherReceipt = true;\n",
      ".codex/workflow-mcp/server.ts":
        'import { extensionless } from "../../extensionless";\nimport { explicit } from "../../explicit.js";\nimport { preferred } from "../../preferred.js";\nconst dynamic = await import("../../dynamic.js");\nexport { extensionless, explicit, preferred, dynamic };\n',
      "extensionless.ts": "export const extensionless = true;\n",
      "explicit.js": "export const explicit = true;\n",
      "preferred.ts": 'export const preferred = "ts";\n',
      "preferred.js": 'export const preferred = "js";\n',
      "dynamic.js": "export const dynamic = true;\n",
    };
    const fixture = gitFixture(files);
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-fixture-cache-"));
    try {
      const manifest = trustedRuntimeManifest(fixture.root, fixture.revision);
      const manifestPaths = manifest.files.map((entry) => entry.path);
      expect(manifestPaths).toContain("extensionless.ts");
      expect(manifestPaths).toContain("explicit.js");
      expect(manifestPaths).toContain("preferred.ts");
      expect(manifestPaths).toContain("dynamic.js");
      expect(manifestPaths).not.toContain("preferred.js");
      const artifact = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot,
        installDependencies: false,
      });
      expect(readFileSync(join(artifact.cachePath, "extensionless.ts"), "utf8")).toContain(
        "extensionless",
      );
      expect(readFileSync(join(artifact.cachePath, "explicit.js"), "utf8")).toContain("explicit");
      expect(readFileSync(join(artifact.cachePath, "preferred.ts"), "utf8")).toContain('"ts"');
      expect(existsSync(join(artifact.cachePath, "preferred.js"))).toBe(false);
      execFileSync("bun", [artifact.runtimePath], { cwd: fixture.root, stdio: "ignore" });

      const missing = gitFixture(
        Object.fromEntries(Object.entries(files).filter(([path]) => path !== "explicit.js")),
      );
      try {
        expect(() => trustedRuntimeManifest(missing.root, missing.revision)).toThrow(
          "trusted runtime local import is missing",
        );
      } finally {
        rmSync(missing.root, { recursive: true, force: true });
      }

      const unsupported = gitFixture({
        ...files,
        ".codex/workflow-mcp/server.ts":
          'const moduleName = "../../dynamic.js";\nawait import(moduleName);\n',
      });
      try {
        expect(() => trustedRuntimeManifest(unsupported.root, unsupported.revision)).toThrow(
          "trusted runtime dynamic import is unsupported",
        );
      } finally {
        rmSync(unsupported.root, { recursive: true, force: true });
      }
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects committed runtime symlinks and symlinked cache entries", () => {
    for (const target of ["/tmp/workflow-runtime-outside.ts", "../../outside.ts"]) {
      const fixture = gitFixture(
        {
          "package.json": '{"name":"fixture","dependencies":{}}\n',
          "bun.lock": '{"lockfileVersion":1}\n',
          ".codex/agents/change-receipt.ts": "export const receipt = true;\n",
          ".codex/agents/receipt.ts": "export const otherReceipt = true;\n",
        },
        { ".codex/workflow-mcp/server.ts": target },
      );
      try {
        expect(() => trustedRuntimeManifest(fixture.root, fixture.revision)).toThrow(
          "trusted runtime symlink is unsupported",
        );
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    }

    const fixture = gitFixture({
      "package.json": '{"name":"fixture","dependencies":{}}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
      ".codex/agents/change-receipt.ts": "export const receipt = true;\n",
      ".codex/agents/receipt.ts": "export const otherReceipt = true;\n",
      ".codex/workflow-mcp/server.ts": "export const server = true;\n",
    });
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-symlink-cache-"));
    try {
      const artifact = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot,
        installDependencies: false,
      });
      rmSync(artifact.cachePath, { recursive: true, force: true });
      symlinkSync(fixture.root, artifact.cachePath);
      expect(() =>
        materializeRuntimeArtifact(fixture.root, fixture.revision, {
          cacheRoot,
          installDependencies: false,
        }),
      ).toThrow("runtime artifact cache entry must not be a symlink");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("rejects an artifact path whose parent is a symlink into the checkout", () => {
    const fixture = gitFixture({
      "package.json": '{"name":"fixture","dependencies":{}}\n',
      "bun.lock": '{"lockfileVersion":1}\n',
      ".codex/agents/change-receipt.ts": "export const receipt = true;\n",
      ".codex/agents/receipt.ts": "export const otherReceipt = true;\n",
      ".codex/workflow-mcp/server.ts": "export const server = true;\n",
    });
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-nested-symlink-cache-"));
    try {
      const artifact = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot,
        installDependencies: false,
      });
      rmSync(join(artifact.cachePath, ".codex"), { recursive: true, force: true });
      symlinkSync(join(fixture.root, ".codex"), join(artifact.cachePath, ".codex"), "dir");

      expect(isValidRuntimeArtifact(artifact)).toBe(false);
      const rebuilt = materializeRuntimeArtifact(fixture.root, fixture.revision, {
        cacheRoot,
        installDependencies: false,
      });
      expect(rebuilt.reused).toBe(false);
      expect(isValidRuntimeArtifact(rebuilt)).toBe(true);
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});
