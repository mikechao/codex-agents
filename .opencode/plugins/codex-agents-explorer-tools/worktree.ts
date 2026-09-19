import { spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

const MAX_ROOT_OUTPUT_BYTES = 4096;
const MAX_TIMEOUT_MS = 30_000;

interface SessionLocation {
  location?: { directory?: string } | null;
}

interface SessionClient {
  get(input: { sessionID: string }): Promise<SessionLocation>;
}

function decodeRoot(stdout: Buffer): string | null {
  if (stdout.byteLength === 0 || stdout.byteLength > MAX_ROOT_OUTPUT_BYTES) return null;
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
  } catch {
    return null;
  }
  const lines = value.split("\n");
  if (lines.length !== 2 || lines[1] !== "" || !isAbsolute(lines[0] ?? "")) return null;
  return lines[0] ?? null;
}

export function resolveGitWorktree(directory: string): string | null {
  if (!isAbsolute(directory)) return null;
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
      cwd: directory,
      encoding: "buffer",
      shell: false,
      timeout: MAX_TIMEOUT_MS,
      maxBuffer: MAX_ROOT_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) return null;
  return decodeRoot(
    Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
  );
}

export async function resolveSessionWorktree(
  session: SessionClient,
  sessionID: string,
): Promise<string | null> {
  try {
    const info = await session.get({ sessionID });
    const directory = info.location?.directory;
    return typeof directory === "string" ? resolveGitWorktree(directory) : null;
  } catch {
    return null;
  }
}
