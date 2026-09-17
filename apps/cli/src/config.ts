import { realpathSync, statSync } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseJsonBytes } from "@jevyr/core";

export interface JevyrConfig {
  readonly daemonUrl: string;
  readonly chamberUrl: string;
  readonly privacy: "full_case" | "provider_scoped" | "local_only";
  readonly control: "sovereign" | "juggler";
}

export interface InitializationResult {
  readonly root: string;
  readonly created: readonly string[];
  readonly existing: readonly string[];
  readonly replaced: readonly string[];
  readonly configPath: string;
  readonly policyPath: string;
  readonly assayFrontierPath: string;
}

export interface InitializationOptions {
  /** Replace only Jevyr's five known portable initialization files. */
  readonly force?: boolean;
}

export const DEFAULT_CONFIG: JevyrConfig = {
  daemonUrl: "http://127.0.0.1:4317",
  chamberUrl: "http://localhost:3001",
  privacy: "local_only",
  control: "juggler",
};

export const DEFAULT_POLICY = Object.freeze({
  protocol: "jevyr.policy/1",
  // Portable onboarding selects v2; existing project files and embedded daemon defaults are independent.
  policyVersion: "bone-v2",
  semanticContinuation: false,
  reflex: { required: true, maximumLoops: 2 },
  forge: { network: "denied", source: "read_only", missingDocker: "UNPROVEN" },
  memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 },
  growth: { liveBoneMutation: false, promotion: "signed_governance" },
});

const JEVYR_IGNORE = ".env\n.env.*\n*.pem\n*.key\nnode_modules\n.git\n";
const STATE_IGNORE = "cases/\nmemory/\nkeys/\n*.sqlite\n*.sqlite-*\n";
const DEFAULT_ASSAY_FRONTIER = Object.freeze({
  protocol: "jevyr.assay-frontier/1",
  assays: Object.freeze([
    Object.freeze({
      assayId: "jevyr.experiment.node-v1",
      costUnits: 1,
      tool: "forge.command",
      args: Object.freeze({ command: "node", args: Object.freeze(["jevyr.experiment.mjs"]) }),
      timeoutMs: 30_000,
    }),
  ]),
});
const MAX_CLI_CONFIG_BYTES = 1_048_576;

function configRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["daemonUrl", "chamberUrl", "privacy", "control"]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown fields: ${unknown.sort().join(", ")}`);
  return record;
}

function endpoint(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 2_048) {
    throw new TypeError(`${path} must be a bounded HTTP(S) origin`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (cause) {
    throw new TypeError(`${path} must be an absolute HTTP(S) origin`, { cause });
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.username !== "" || parsed.password !== ""
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(`${path} must be an HTTP(S) origin without credentials, path, query, or fragment`);
  }
  return parsed.origin;
}

/**
 * Package-manager scripts execute from their package directory rather than the
 * directory where the operator invoked them. INIT_CWD is the lifecycle
 * contract for that original directory. Accept it only when it resolves to an
 * existing directory; direct binaries and malformed environments fall back to
 * the actual process cwd.
 */
export function invocationBase(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const fallback = resolve(cwd);
  const candidate = env.INIT_CWD?.trim();
  if (!candidate || !isAbsolute(candidate)) return fallback;
  try {
    const resolved = realpathSync(candidate);
    return statSync(resolved).isDirectory() ? resolved : fallback;
  } catch {
    return fallback;
  }
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, () => false);
}

async function writeIfMissing(path: string, contents: string, created: string[], existing: string[]): Promise<void> {
  try {
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    created.push(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    existing.push(path);
  }
}

async function installFile(
  path: string,
  contents: string,
  options: InitializationOptions,
  created: string[],
  existing: string[],
  replaced: string[],
): Promise<void> {
  if (!options.force) return await writeIfMissing(path, contents, created, existing);
  const wasPresent = await exists(path);
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600, flag: "w" });
  (wasPresent ? replaced : created).push(path);
}

export async function findConfig(start = process.cwd()): Promise<string | undefined> {
  let directory = resolve(start);
  while (true) {
    const candidate = join(directory, ".jevyr", "config.json");
    if (await exists(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

export async function loadConfig(start = process.cwd()): Promise<JevyrConfig> {
  const path = await findConfig(start);
  let stored: Record<string, unknown> = {};
  if (path) {
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_CLI_CONFIG_BYTES) {
      throw new RangeError(`${path} exceeds ${MAX_CLI_CONFIG_BYTES} bytes`);
    }
    stored = configRecord(parseJsonBytes(bytes, path), path);
  }
  const privacy = stored.privacy ?? DEFAULT_CONFIG.privacy;
  const control = stored.control ?? DEFAULT_CONFIG.control;
  if (typeof privacy !== "string" || !["full_case", "provider_scoped", "local_only"].includes(privacy)) {
    throw new TypeError(`${path} contains an invalid privacy mode`);
  }
  if (control !== "sovereign" && control !== "juggler") throw new TypeError(`${path} contains an invalid control mode`);
  return {
    daemonUrl: endpoint(process.env.JEVYR_URL ?? stored.daemonUrl ?? DEFAULT_CONFIG.daemonUrl, "daemonUrl"),
    chamberUrl: endpoint(process.env.JEVYR_CHAMBER_URL ?? stored.chamberUrl ?? DEFAULT_CONFIG.chamberUrl, "chamberUrl"),
    privacy: privacy as JevyrConfig["privacy"],
    control: control as JevyrConfig["control"],
  };
}

/** Installs missing portable files; force replaces only the five exact Jevyr-owned targets. */
export async function initialize(
  directory: string,
  options: InitializationOptions = {},
): Promise<InitializationResult> {
  const root = resolve(directory);
  const targetDirectory = join(root, ".jevyr");
  const configPath = join(targetDirectory, "config.json");
  const policyPath = join(targetDirectory, "policy.json");
  const assayFrontierPath = join(targetDirectory, "assay-frontier.json");
  const created: string[] = [];
  const existing: string[] = [];
  const replaced: string[] = [];
  await mkdir(targetDirectory, { recursive: true });
  await installFile(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, options, created, existing, replaced);
  await installFile(policyPath, `${JSON.stringify(DEFAULT_POLICY, null, 2)}\n`, options, created, existing, replaced);
  await installFile(assayFrontierPath, `${JSON.stringify(DEFAULT_ASSAY_FRONTIER, null, 2)}\n`, options, created, existing, replaced);
  await installFile(join(targetDirectory, ".gitignore"), STATE_IGNORE, options, created, existing, replaced);
  await installFile(join(root, ".jevyrignore"), JEVYR_IGNORE, options, created, existing, replaced);
  return { root, created, existing, replaced, configPath, policyPath, assayFrontierPath };
}
