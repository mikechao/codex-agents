import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { verifyRevision } from "./git.js";

const ENTRYPOINT = ".codex/workflow-mcp/server.ts";
const RECEIPT_MODULES = [".codex/agents/change-receipt.ts", ".codex/agents/receipt.ts"];
const PACKAGE_METADATA = ["package.json", "bun.lock"];
const SCHEMA_VERSION = 1;

export interface RuntimeManifestEntry {
  path: string;
  mode: "100644" | "100755" | "120000";
  digest: string;
  size: number;
}

export interface RuntimeManifest {
  schema_version: 1;
  revision: string;
  entrypoint: string;
  files: RuntimeManifestEntry[];
  package_metadata: string[];
}

export interface RuntimeArtifact {
  runtime_id: string;
  runtimePath: string;
  runtime_path: string;
  cachePath: string;
  revision: string;
  manifest: RuntimeManifest;
  reused: boolean;
}

export interface RuntimeArtifactOptions {
  /** Override the external cache location, primarily for tests. */
  cacheRoot?: string;
  /** Skip dependency installation only when a caller supplies dependencies itself. */
  installDependencies?: boolean;
  /** Bun executable used to install the artifact's committed dependencies. */
  bunExecutable?: string;
}

interface CommittedFile {
  content: Buffer;
  mode: RuntimeManifestEntry["mode"];
}

interface RuntimeDependencyManifest {
  schema_version: 1;
  files: RuntimeManifestEntry[];
}

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function git(root: string, args: readonly string[], maxBuffer = 4 * 1024 * 1024): Buffer {
  try {
    return execFileSync("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer,
    });
  } catch {
    throw new Error("runtime artifact git operation failed");
  }
}

function gitText(root: string, args: readonly string[]): string {
  return git(root, args).toString("utf8");
}

function committedFile(root: string, revision: string, path: string): CommittedFile {
  const record = gitText(root, ["ls-tree", "-z", revision, "--", path]).split("\0")[0] ?? "";
  const separator = record.indexOf("\t");
  if (separator < 0) throw new Error(`trusted runtime file is missing: ${path}`);
  const fields = record.slice(0, separator).split(" ");
  if (fields.length !== 3 || fields[1] !== "blob") {
    throw new Error(`trusted runtime file is not a regular file: ${path}`);
  }
  const mode = fields[0];
  if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
    throw new Error(`trusted runtime file mode is unsupported: ${path}`);
  }
  if (mode === "120000") {
    throw new Error(`trusted runtime symlink is unsupported: ${path}`);
  }
  const sizeText = gitText(root, ["cat-file", "-s", `${revision}:${path}`]).trim();
  const size = Number(sizeText);
  if (!/^\d+$/u.test(sizeText) || !Number.isSafeInteger(size)) {
    throw new Error(`trusted runtime file size is invalid: ${path}`);
  }
  return {
    content: git(root, ["cat-file", "blob", `${revision}:${path}`], Math.max(size + 1, 1024)),
    mode,
  };
}

function localImportPaths(source: string): string[] {
  const imports: string[] = [];
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/gu, "");
  const dynamicImports = /\bimport\s*\(\s*(?:"([^"]*)"|'([^']*)')\s*\)/gu;
  const dynamicImportCalls = /\bimport\s*\(([^)]*)\)/gu;
  for (const match of withoutComments.matchAll(dynamicImportCalls)) {
    const expression = match[1]?.trim() ?? "";
    if (!/^(['"]).*\1$/su.test(expression)) {
      throw new Error("trusted runtime dynamic import is unsupported");
    }
  }
  for (const match of withoutComments.matchAll(dynamicImports)) {
    const specifier = match[1] ?? match[2];
    if (specifier?.startsWith(".")) imports.push(specifier);
  }
  const pattern =
    /(?:\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s*|\bexport\s+[\s\S]*?\s+from\s*|\bimport\s*)["']([^"']+)["']/gu;
  for (const match of withoutComments.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier?.startsWith(".")) imports.push(specifier);
  }
  return imports;
}

function localImportCandidates(path: string, specifier: string): string[] {
  const base = posix.normalize(posix.join(posix.dirname(path), specifier));
  if (base === ".." || base.startsWith("../") || base.startsWith("/")) {
    throw new Error(`trusted runtime local import escapes repository: ${path} -> ${specifier}`);
  }
  const candidates = [base];
  if (base.endsWith(".js")) candidates.unshift(`${base.slice(0, -3)}.ts`);
  else if (!base.includes(".")) candidates.push(`${base}.ts`, `${base}.js`);
  return candidates;
}

function resolveLocalImport(
  root: string,
  revision: string,
  path: string,
  specifier: string,
): string {
  for (const candidate of localImportCandidates(path, specifier)) {
    try {
      committedFile(root, revision, candidate);
      return candidate;
    } catch {
      // Probe the committed revision rather than the mutable checkout. The first
      // existing candidate preserves Bun's TypeScript/JavaScript precedence.
    }
  }
  throw new Error(`trusted runtime local import has no committed target: ${path} -> ${specifier}`);
}

function runtimeClosure(root: string, revision: string): Map<string, CommittedFile> {
  const paths = [...RECEIPT_MODULES, ...PACKAGE_METADATA, ENTRYPOINT];
  const files = new Map<string, CommittedFile>();
  const pending = [...paths];
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || files.has(path)) continue;
    const file = committedFile(root, revision, path);
    files.set(path, file);
    if (!path.endsWith(".ts") && !path.endsWith(".js")) continue;
    for (const specifier of localImportPaths(file.content.toString("utf8"))) {
      let imported = "";
      try {
        imported = resolveLocalImport(root, revision, path, specifier);
        if (files.has(imported)) continue;
        pending.push(imported);
      } catch {
        throw new Error(
          `trusted runtime local import is missing: ${path} -> ${specifier} (${imported})`,
        );
      }
    }
  }
  return files;
}

function manifestFor(root: string, revision: string): RuntimeManifest {
  const files = runtimeClosure(root, revision);
  const entries = [...files.entries()]
    .map(([path, file]) => ({
      path,
      mode: file.mode,
      digest: digest(file.content),
      size: file.content.byteLength,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    schema_version: SCHEMA_VERSION,
    revision,
    entrypoint: ENTRYPOINT,
    files: entries,
    package_metadata: [...PACKAGE_METADATA].sort(),
  };
}

function runtimeId(manifest: RuntimeManifest): string {
  const { revision: _revision, ...trustedInputs } = manifest;
  return digest(Buffer.from(canonical(trustedInputs), "utf8"));
}

function externalCacheRoot(root: string, requested: string | undefined): string {
  const rootReal = realpathSync(root);
  const candidate = resolve(
    requested ?? join(homedir(), ".codex", "state", "workflow-mcp", "runtime-artifacts"),
  );
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const actualCandidate = realpathSync(candidate);
  const relativePath = relative(rootReal, actualCandidate);
  if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
    throw new Error("runtime artifact cache must be outside the supervised repository");
  }
  return actualCandidate;
}

function artifactWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function artifactPath(
  artifactRoot: string,
  artifactReal: string,
  externalReal: string,
  repositoryReal: string | undefined,
  path: string,
): string {
  const candidate = join(artifactRoot, path);
  if (!artifactWithin(artifactRoot, candidate)) {
    throw new Error("runtime artifact path escapes artifact");
  }
  const candidateReal = realpathSync(candidate);
  if (
    !artifactWithin(artifactReal, candidateReal) ||
    !artifactWithin(externalReal, candidateReal) ||
    (repositoryReal !== undefined && artifactWithin(repositoryReal, candidateReal))
  ) {
    throw new Error("runtime artifact path escapes its external boundary");
  }
  return candidate;
}

function assertSafeCacheEntry(cacheRoot: string, repository: string, cachePath: string): void {
  let stat: ReturnType<typeof lstatSync> | undefined;
  try {
    stat = lstatSync(cachePath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) throw new Error("runtime artifact cache entry must not be a symlink");
  const cacheReal = realpathSync(cacheRoot);
  const repositoryReal = realpathSync(repository);
  const entryReal = realpathSync(cachePath);
  if (!artifactWithin(cacheReal, entryReal) || artifactWithin(repositoryReal, entryReal)) {
    throw new Error("runtime artifact cache entry escapes its external boundary");
  }
}

function dependencyManifest(artifactRoot: string): RuntimeDependencyManifest {
  const artifactReal = realpathSync(artifactRoot);
  const files: RuntimeManifestEntry[] = [];
  const visitedDirectories = new Set<string>();

  const visit = (path: string): void => {
    const stat = lstatSync(path);
    const resolvedPath = realpathSync(path);
    if (!artifactWithin(artifactReal, resolvedPath)) {
      throw new Error("runtime dependency escapes artifact");
    }
    const relativePath = relative(artifactRoot, path).split(sep).join("/");
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(path);
      files.push({
        path: relativePath,
        mode: "120000",
        digest: digest(target),
        size: Buffer.byteLength(target),
      });
      visit(resolvedPath);
      return;
    }
    if (stat.isDirectory()) {
      const directoryKey = resolvedPath;
      if (visitedDirectories.has(directoryKey)) return;
      visitedDirectories.add(directoryKey);
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (!stat.isFile()) throw new Error("runtime dependency contains unsupported file type");
    const content = readFileSync(path);
    files.push({
      path: relativePath,
      mode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
      digest: digest(content),
      size: content.byteLength,
    });
  };

  if (!lstatSync(join(artifactRoot, "node_modules")).isDirectory()) {
    throw new Error("runtime dependency tree is missing");
  }
  visit(join(artifactRoot, "node_modules"));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { schema_version: SCHEMA_VERSION, files };
}

function validateDependencies(artifactRoot: string, packageContent: Buffer): boolean {
  let packageJson: unknown;
  try {
    packageJson = JSON.parse(packageContent.toString("utf8"));
  } catch {
    return false;
  }
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) return false;
  const dependencies = (packageJson as Record<string, unknown>).dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies))
    return false;
  const nodeModules = join(artifactRoot, "node_modules");
  try {
    const artifactReal = realpathSync(artifactRoot);
    if (!lstatSync(nodeModules).isDirectory()) return false;
    for (const name of Object.keys(dependencies)) {
      const dependency = join(nodeModules, name);
      const resolved = realpathSync(dependency);
      if (!artifactWithin(artifactReal, resolved)) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function validArtifact(
  artifactRoot: string,
  expectedId: string,
  manifest: RuntimeManifest,
  packageContent: Buffer,
  externalRoot: string,
  repository?: string,
): boolean {
  try {
    const rootStat = lstatSync(artifactRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    const artifactReal = realpathSync(artifactRoot);
    const externalReal = realpathSync(externalRoot);
    const repositoryReal = repository ? realpathSync(repository) : undefined;
    if (
      !artifactWithin(externalReal, artifactReal) ||
      (repositoryReal !== undefined && artifactWithin(repositoryReal, artifactReal))
    )
      return false;
    const marker = readFileSync(
      artifactPath(artifactRoot, artifactReal, externalReal, repositoryReal, ".runtime-complete"),
      "utf8",
    ).trim();
    const stored = JSON.parse(
      readFileSync(
        artifactPath(
          artifactRoot,
          artifactReal,
          externalReal,
          repositoryReal,
          ".runtime-manifest.json",
        ),
        "utf8",
      ),
    ) as RuntimeManifest;
    const { revision: _storedRevision, ...storedInputs } = stored;
    const { revision: _revision, ...trustedInputs } = manifest;
    if (marker !== expectedId || canonical(storedInputs) !== canonical(trustedInputs)) return false;
    for (const entry of manifest.files) {
      const path = artifactPath(
        artifactRoot,
        artifactReal,
        externalReal,
        repositoryReal,
        entry.path,
      );
      const stat = lstatSync(path);
      if (entry.mode === "120000") {
        if (
          !stat.isSymbolicLink() ||
          !artifactWithin(artifactReal, realpathSync(path)) ||
          digest(readlinkSync(path)) !== entry.digest
        )
          return false;
      } else {
        if (!stat.isFile() || digest(readFileSync(path)) !== entry.digest) return false;
        const executable = (stat.mode & 0o111) !== 0;
        if (executable !== (entry.mode === "100755")) return false;
      }
    }
    const storedDependencies = JSON.parse(
      readFileSync(
        artifactPath(
          artifactRoot,
          artifactReal,
          externalReal,
          repositoryReal,
          ".runtime-dependencies.json",
        ),
        "utf8",
      ),
    ) as RuntimeDependencyManifest;
    if (canonical(storedDependencies) !== canonical(dependencyManifest(artifactRoot))) return false;
    return validateDependencies(artifactRoot, packageContent);
  } catch {
    return false;
  }
}

function installDependencies(artifactRoot: string, options: RuntimeArtifactOptions): void {
  if (options.installDependencies === false) {
    mkdirSync(join(artifactRoot, "node_modules"), { recursive: true, mode: 0o755 });
    return;
  }
  try {
    execFileSync(
      options.bunExecutable ?? "bun",
      ["install", "--frozen-lockfile", "--production", "--ignore-scripts", "--no-save"],
      {
        cwd: artifactRoot,
        stdio: ["ignore", "ignore", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch {
    throw new Error("committed runtime dependencies could not be materialized");
  }
}

function writeCommittedFile(artifactRoot: string, path: string, file: CommittedFile): void {
  const destination = join(artifactRoot, path);
  mkdirSync(dirname(destination), { recursive: true });
  if (file.mode === "120000") {
    throw new Error(`trusted runtime symlink is unsupported: ${path}`);
  }
  writeFileSync(destination, file.content, { mode: file.mode === "100755" ? 0o755 : 0o644 });
  if (file.mode === "100755") chmodSync(destination, 0o755);
}

export function trustedRuntimeManifest(root: string, revision: string): RuntimeManifest {
  const repository = realpathSync(root);
  const committedRevision = verifyRevision(repository, revision);
  return manifestFor(repository, committedRevision);
}

export function isValidRuntimeArtifact(artifact: RuntimeArtifact): boolean {
  if (!artifact.manifest.files.some((entry) => entry.path === "package.json")) return false;
  try {
    return validArtifact(
      artifact.cachePath,
      artifact.runtime_id,
      artifact.manifest,
      readFileSync(join(artifact.cachePath, "package.json")),
      dirname(artifact.cachePath),
    );
  } catch {
    return false;
  }
}

export function materializeRuntimeArtifact(
  root: string,
  revision: string,
  options: RuntimeArtifactOptions = {},
): RuntimeArtifact {
  const repository = realpathSync(root);
  const committedRevision = verifyRevision(repository, revision);
  const manifest = manifestFor(repository, committedRevision);
  const id = runtimeId(manifest);
  const cacheRoot = externalCacheRoot(repository, options.cacheRoot);
  const cachePath = join(cacheRoot, id);
  assertSafeCacheEntry(cacheRoot, repository, cachePath);
  const packageContent = committedFile(repository, committedRevision, "package.json").content;
  const existing: RuntimeArtifact = {
    runtime_id: id,
    runtimePath: join(cachePath, manifest.entrypoint),
    runtime_path: join(cachePath, manifest.entrypoint),
    cachePath,
    revision: committedRevision,
    manifest,
    reused: true,
  };
  if (validArtifact(cachePath, id, manifest, packageContent, cacheRoot, repository))
    return existing;
  rmSync(cachePath, { recursive: true, force: true });

  const staging = mkdtempSync(join(cacheRoot, `.runtime-${id.slice(0, 12)}-${randomUUID()}-`));
  try {
    const files = runtimeClosure(repository, committedRevision);
    for (const [path, file] of files) writeCommittedFile(staging, path, file);
    installDependencies(staging, options);
    const dependencies = dependencyManifest(staging);
    writeFileSync(join(staging, ".runtime-manifest.json"), `${JSON.stringify(manifest)}\n`, {
      mode: 0o644,
    });
    writeFileSync(
      join(staging, ".runtime-dependencies.json"),
      `${JSON.stringify(dependencies)}\n`,
      {
        mode: 0o644,
      },
    );
    writeFileSync(join(staging, ".runtime-complete"), `${id}\n`, { mode: 0o644 });
    if (!validArtifact(staging, id, manifest, packageContent, cacheRoot, repository)) {
      throw new Error("materialized runtime artifact failed validation");
    }
    try {
      renameSync(staging, cachePath);
    } catch {
      assertSafeCacheEntry(cacheRoot, repository, cachePath);
      if (validArtifact(cachePath, id, manifest, packageContent, cacheRoot, repository)) {
        rmSync(staging, { recursive: true, force: true });
        return { ...existing, reused: true };
      }
      rmSync(cachePath, { recursive: true, force: true });
      renameSync(staging, cachePath);
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return { ...existing, reused: false };
}

export const resolveRuntimeArtifact = materializeRuntimeArtifact;
