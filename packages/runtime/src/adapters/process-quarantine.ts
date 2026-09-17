import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

const WORKSPACE_POINTERS = new Set([
  "INIT_CWD",
  "OLDPWD",
  "PROJECT_CWD",
  "GITHUB_WORKSPACE",
  "npm_config_local_prefix",
  "npm_package_json",
]);

function pathInside(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalize(resolve(candidate));
  const normalizedParent = normalize(resolve(parent));
  const comparableCandidate = process.platform === "win32" ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const comparableParent = process.platform === "win32" ? normalizedParent.toLowerCase() : normalizedParent;
  return comparableCandidate === comparableParent || comparableCandidate.startsWith(`${comparableParent}${sep}`);
}

function scrubPathList(value: string, ambientCwd: string): string {
  return value
    .split(process.platform === "win32" ? ";" : ":")
    .filter((entry) => entry.length > 0 && !pathInside(entry, ambientCwd))
    .join(process.platform === "win32" ? ";" : ":");
}

/**
 * Keep provider authentication and installation state, but remove the conventional
 * environment pointers that would lead a child back into the daemon workspace.
 */
export function quarantinedProviderEnvironment(
  isolatedCwd: string,
  source: NodeJS.ProcessEnv = process.env,
  ambientCwd = process.cwd(),
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...source, PWD: isolatedCwd };
  for (const key of WORKSPACE_POINTERS) delete result[key];

  for (const key of ["PATH", "Path"] as const) {
    const value = result[key];
    if (value) result[key] = scrubPathList(value, ambientCwd);
  }

  for (const [key, value] of Object.entries(result)) {
    if (!value || key === "PATH" || key === "Path" || key === "PWD") continue;
    const unquoted = value.replace(/^(["'])(.*)\1$/, "$2");
    if (isAbsolute(unquoted) && pathInside(unquoted, ambientCwd)) delete result[key];
  }

  return result;
}

/** A process adapter gets one empty, disposable working directory per call. */
export async function withQuarantinedMindWorkspace<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const temporaryRoot = resolve(tmpdir());
  const directory = resolve(await mkdtemp(join(temporaryRoot, "jevyr-mind-")));
  if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith("jevyr-mind-")) {
    throw new Error(`Refusing unexpected mind quarantine path: ${directory}`);
  }
  const identity = await lstat(directory);
  if (!identity.isDirectory() || identity.isSymbolicLink()) {
    throw new Error(`Mind quarantine is not a physical directory: ${directory}`);
  }
  try {
    return await action(directory);
  } finally {
    const current = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (current) {
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw new Error(`Refusing to clean a replaced mind quarantine path: ${directory}`);
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 25 });
    }
  }
}

export function rejectCallerWorkingDirectory(options: object, adapterName: string): void {
  if (Object.prototype.hasOwnProperty.call(options, "cwd")) {
    throw new Error(`${adapterName} does not accept cwd; every invocation runs in a fresh quarantined directory`);
  }
}
