import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { digestJson, type JsonValue, type SealedSearchProfile } from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import {
  DEFAULT_SEARCH_PROFILE,
  FORGE_LIMIT_BOUNDS,
  FORGE_LIMIT_DEFAULTS,
  MAX_ORACLE_FILE_BYTES,
  normalizeSubjectSnapshotPolicy,
  type ForgeConfig,
  type NormalizedSubjectSnapshotPolicy,
  type RepositorySealProfile,
  type SubjectSnapshotPolicy,
} from "@jevyr/runtime";

export const PROJECT_POLICY_PROTOCOL = "jevyr.policy/1" as const;
export const PROJECT_POLICY_DESCRIPTOR_PROTOCOL = "jevyr.project-policy-descriptor/1" as const;

const MAX_POLICY_BYTES = 1_048_576;
const MAX_ATTEMPT_CEILING_DIGITS = 128;
const MAX_SUBJECT_DIRECTORY_FILES = 1_000_000;
const MAX_SUBJECT_BYTES = 10_000_000_000;
const MAX_URL_ORIGINS = 64;
const MAX_URL_TIMEOUT_MS = 600_000;
const MAX_URL_REDIRECTS = 20;
const MAX_FORGE_MEMORY_MB = 1_048_576;
const MAX_FORGE_CPUS = 1_024;
const MAX_FORGE_PIDS = 1_000_000;
const MAX_FORGE_FILES = 10_000;
const MAX_FORGE_FILE_BYTES = MAX_ORACLE_FILE_BYTES;

const SEARCH_NURSERY_FIELDS = [
  "minimumAttempts",
  "saturationWindow",
  "independentLineages",
  "challengeInterval",
] as const;

const SEARCH_RESOURCE_FIELDS = [
  "maxMindInvocations",
  "maxInputTokens",
  "maxOutputTokens",
  "maxWallMillis",
  "maxSingleInvocationMillis",
  "maxGeneratedBytes",
  "maxForgeCpuMillis",
  "maxForgeWallMillis",
  "maxMemorySeconds",
  "maxWritableBytes",
  "maxWritableInodes",
  "maxArtifactBytes",
  "maxNetworkBytes",
  "concurrentLineages",
  "maxTotalAssayCost",
] as const;

type SearchNurseryField = (typeof SEARCH_NURSERY_FIELDS)[number];
type SearchResourceField = (typeof SEARCH_RESOURCE_FIELDS)[number];

export interface CanonicalProjectPolicy {
  readonly protocol: typeof PROJECT_POLICY_PROTOCOL;
  readonly policyVersion: "bone-v1" | "bone-v2";
  readonly semanticContinuation: false;
  readonly reflex: {
    readonly required: true;
    readonly maximumLoops: 1 | 2;
  };
  readonly forge: {
    readonly mode: "docker";
    readonly network: "denied";
    readonly source: "read_only";
    readonly missingDocker: "INVALID" | "UNPROVEN";
    readonly engine: "docker" | "podman";
    readonly dockerImage: string;
    readonly limits: {
      readonly memoryMb: number;
      readonly cpus: number;
      readonly pidsLimit: number;
      readonly maxFiles: number;
      readonly maxFileBytes: number;
      readonly maxProcessOutputBytes: number;
      readonly workspacePollIntervalMs: number;
    };
  };
  readonly memory: {
    readonly firstWave: "amnesic";
    readonly maximumLateInfluence: 0.2;
  };
  readonly growth: {
    readonly liveBoneMutation: false;
    readonly promotion: "signed_governance";
  };
  readonly subjectSnapshots: NormalizedSubjectSnapshotPolicy;
  readonly search: SealedSearchProfile;
}

export interface PolicyEnforcementClassification {
  /** Values returned as concrete inputs to an enforcing runtime component. */
  readonly operationalInputPaths: readonly string[];
  /** Constitutional values checked here; they are not configurable runtime overrides. */
  readonly validatedInvariants: readonly string[];
  /** Values sealed for provenance/telemetry but not currently enforced end to end. */
  readonly sealedDeclarationOnlyPaths: readonly string[];
}

export type PortableForgeConfig = Readonly<Pick<
  ForgeConfig,
  | "mode"
  | "allowTrustedHost"
  | "allowNetwork"
  | "dockerImage"
  | "dockerCommand"
  | "memoryMb"
  | "cpus"
  | "pidsLimit"
  | "maxFiles"
  | "maxFileBytes"
  | "maxWritableBytes"
  | "maxWritableInodes"
  | "maxProcessOutputBytes"
  | "workspacePollIntervalMs"
  | "retainFailedWorkspace"
>>;

export interface LoadedProjectPolicy {
  readonly projectRoot: string;
  readonly policyPath: string;
  readonly source: "project-file" | "built-in-default";
  readonly policy: CanonicalProjectPolicy;
  /** Portable canonical JSON. `descriptorDigest` covers exactly this value. */
  readonly policyDescriptor: JsonValue;
  readonly descriptorDigest: string;
  readonly enforcement: PolicyEnforcementClassification;
  readonly repositorySealProfile: RepositorySealProfile;
  readonly subjectSnapshotPolicy: NormalizedSubjectSnapshotPolicy;
  readonly forgeConfig: PortableForgeConfig;
  readonly searchProfile: SealedSearchProfile;
  readonly reflexLoops: 1 | 2;
}

const VALIDATED_INVARIANTS = Object.freeze([
  "policyVersion=bone-v1",
  "semanticContinuation=false",
  "reflex.required=true",
  "memory.firstWave=amnesic",
  "memory.maximumLateInfluence=0.2",
  "growth.liveBoneMutation=false",
  "growth.promotion=signed_governance",
]);

const OPERATIONAL_INPUT_PATHS = Object.freeze([
  "reflex.maximumLoops",
  "forge.mode",
  "forge.missingDocker",
  "forge.network",
  "forge.source",
  "forge.dockerImage",
  "forge.limits.memoryMb",
  "forge.limits.cpus",
  "forge.limits.pidsLimit",
  "forge.limits.maxFiles",
  "forge.limits.maxFileBytes",
  "forge.limits.maxProcessOutputBytes",
  "forge.limits.workspacePollIntervalMs",
  "subjectSnapshots",
  "search.attemptSafetyCeiling",
  "search.seedDerivation",
  "search.nursery.minimumAttempts",
  "search.nursery.saturationWindow",
  "search.nursery.independentLineages",
  "search.nursery.challengeInterval",
  "search.resources.maxMindInvocations",
  "search.resources.maxInputTokens",
  "search.resources.maxOutputTokens",
  "search.resources.maxWallMillis",
  "search.resources.maxSingleInvocationMillis",
  "search.resources.maxGeneratedBytes",
  "search.resources.maxForgeWallMillis",
  "search.resources.maxMemorySeconds",
  "search.resources.maxWritableBytes",
  "search.resources.maxWritableInodes",
  "search.resources.maxArtifactBytes",
  "search.resources.maxTotalAssayCost",
]);

const SEALED_DECLARATION_ONLY_PATHS = Object.freeze([
  // Enforced only for adapters that return a strict measured CPU reading. The
  // built-in Forge currently rate-limits Docker CPU but cannot meter total CPU.
  "search.resources.maxForgeCpuMillis",
  "search.resources.maxNetworkBytes",
  "search.resources.concurrentLineages",
]);

const ENFORCEMENT: PolicyEnforcementClassification = deepFreeze({
  operationalInputPaths: OPERATIONAL_INPUT_PATHS,
  validatedInvariants: VALIDATED_INVARIANTS,
  sealedDeclarationOnlyPaths: SEALED_DECLARATION_ONLY_PATHS,
});

const DEFAULT_INPUT = deepFreeze({
  protocol: PROJECT_POLICY_PROTOCOL,
  policyVersion: "bone-v1",
  semanticContinuation: false,
  reflex: { required: true, maximumLoops: 2 },
  forge: { network: "denied", source: "read_only", missingDocker: "UNPROVEN" },
  memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 },
  growth: { liveBoneMutation: false, promotion: "signed_governance" },
});

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new TypeError(`${path}.${key} is not a recognized policy field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${path}.${key} is required`);
  }
}

function exactValue<T>(value: unknown, expected: T, path: string): T {
  if (value !== expected) throw new TypeError(`${path} must equal ${JSON.stringify(expected)}`);
  return expected;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function boundedNumber(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  fallback: number,
  path: string,
  minimum: number,
  maximum: number,
): number {
  return value[key] === undefined ? fallback : boundedInteger(value[key], `${path}.${key}`, minimum, maximum);
}

function parseAttemptCeiling(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_ATTEMPT_CEILING_DIGITS ||
    !/^[1-9][0-9]*$/u.test(value)
  ) {
    throw new TypeError(`${path} must be a canonical positive decimal string of at most ${MAX_ATTEMPT_CEILING_DIGITS} digits`);
  }
  return value;
}

function parseSubjectSnapshots(value: unknown): NormalizedSubjectSnapshotPolicy {
  if (value === undefined) return normalizeSubjectSnapshotPolicy();
  const input = record(value, "$.subjectSnapshots");
  exactKeys(
    input,
    ["maxDirectoryFiles", "maxDirectoryBytes", "maxGitOutputBytes", "gitCommand", "url"],
    [],
    "$.subjectSnapshots",
  );
  const policy: SubjectSnapshotPolicy = {
    ...(input.maxDirectoryFiles === undefined
      ? {}
      : { maxDirectoryFiles: boundedInteger(input.maxDirectoryFiles, "$.subjectSnapshots.maxDirectoryFiles", 1, MAX_SUBJECT_DIRECTORY_FILES) }),
    ...(input.maxDirectoryBytes === undefined
      ? {}
      : { maxDirectoryBytes: boundedInteger(input.maxDirectoryBytes, "$.subjectSnapshots.maxDirectoryBytes", 1, MAX_SUBJECT_BYTES) }),
    ...(input.maxGitOutputBytes === undefined
      ? {}
      : { maxGitOutputBytes: boundedInteger(input.maxGitOutputBytes, "$.subjectSnapshots.maxGitOutputBytes", 1, MAX_SUBJECT_BYTES) }),
  };
  if (input.gitCommand !== undefined) {
    exactValue(input.gitCommand, "git", "$.subjectSnapshots.gitCommand");
    Object.assign(policy, { gitCommand: "git" });
  }
  if (input.url !== undefined) {
    const url = record(input.url, "$.subjectSnapshots.url");
    exactKeys(url, ["mode", "allowedOrigins", "maxBytes", "timeoutMs", "maxRedirects"], [], "$.subjectSnapshots.url");
    const mode = url.mode === undefined ? "declaration" : url.mode;
    if (mode !== "declaration" && mode !== "fetch") {
      throw new TypeError("$.subjectSnapshots.url.mode must equal declaration or fetch");
    }
    let allowedOrigins: readonly string[] | undefined;
    if (url.allowedOrigins !== undefined) {
      if (!Array.isArray(url.allowedOrigins) || url.allowedOrigins.length > MAX_URL_ORIGINS) {
        throw new TypeError(`$.subjectSnapshots.url.allowedOrigins must be an array of at most ${MAX_URL_ORIGINS} origins`);
      }
      allowedOrigins = url.allowedOrigins.map((origin, index) => {
        if (typeof origin !== "string" || origin.length === 0 || origin.length > 2_048) {
          throw new TypeError(`$.subjectSnapshots.url.allowedOrigins[${index}] must be a non-empty string of at most 2048 characters`);
        }
        return origin;
      });
    }
    Object.assign(policy, {
      url: {
        mode,
        ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
        ...(url.maxBytes === undefined
          ? {}
          : { maxBytes: boundedInteger(url.maxBytes, "$.subjectSnapshots.url.maxBytes", 1, MAX_SUBJECT_BYTES) }),
        ...(url.timeoutMs === undefined
          ? {}
          : { timeoutMs: boundedInteger(url.timeoutMs, "$.subjectSnapshots.url.timeoutMs", 1, MAX_URL_TIMEOUT_MS) }),
        ...(url.maxRedirects === undefined
          ? {}
          : { maxRedirects: boundedInteger(url.maxRedirects, "$.subjectSnapshots.url.maxRedirects", 0, MAX_URL_REDIRECTS) }),
      },
    });
  }
  return normalizeSubjectSnapshotPolicy(policy);
}

function parseForge(value: unknown): CanonicalProjectPolicy["forge"] {
  const forge = record(value, "$.forge");
  exactKeys(
    forge,
    ["mode", "engine", "network", "source", "missingDocker", "dockerImage", "limits"],
    ["network", "source", "missingDocker"],
    "$.forge",
  );
  const mode = forge.mode === undefined ? "docker" : exactValue(forge.mode, "docker", "$.forge.mode");
  const network = exactValue(forge.network, "denied", "$.forge.network");
  const source = exactValue(forge.source, "read_only", "$.forge.source");
  // Read legacy installs, but seal the strengthened canonical rule explicitly.
  if (forge.missingDocker !== "UNPROVEN" && forge.missingDocker !== "INVALID") throw new TypeError("$.forge.missingDocker must equal UNPROVEN or INVALID");
  const missingDocker = forge.missingDocker;
  const engine = forge.engine ?? "docker";
  if (engine !== "docker" && engine !== "podman") throw new TypeError("$.forge.engine must equal docker or podman");
  const dockerImage = forge.dockerImage === undefined ? "node:24-alpine" : forge.dockerImage;
  if (
    typeof dockerImage !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,511}$/u.test(dockerImage)
  ) {
    throw new TypeError("$.forge.dockerImage must be a Docker image reference of at most 512 characters");
  }
  const limits = forge.limits === undefined ? {} : record(forge.limits, "$.forge.limits");
  exactKeys(
    limits,
    [
      "memoryMb",
      "cpus",
      "pidsLimit",
      "maxFiles",
      "maxFileBytes",
      "maxProcessOutputBytes",
      "workspacePollIntervalMs",
    ],
    [],
    "$.forge.limits",
  );
  return deepFreeze({
    mode,
    network,
    source,
    missingDocker,
    engine,
    dockerImage,
    limits: {
      memoryMb: optionalInteger(limits, "memoryMb", 1_024, "$.forge.limits", 64, MAX_FORGE_MEMORY_MB),
      cpus: limits.cpus === undefined ? 2 : boundedNumber(limits.cpus, "$.forge.limits.cpus", 0.1, MAX_FORGE_CPUS),
      pidsLimit: optionalInteger(limits, "pidsLimit", 256, "$.forge.limits", 1, MAX_FORGE_PIDS),
      maxFiles: optionalInteger(limits, "maxFiles", 10_000, "$.forge.limits", 1, MAX_FORGE_FILES),
      maxFileBytes: optionalInteger(limits, "maxFileBytes", 20_000_000, "$.forge.limits", 1, MAX_FORGE_FILE_BYTES),
      maxProcessOutputBytes: optionalInteger(
        limits,
        "maxProcessOutputBytes",
        FORGE_LIMIT_DEFAULTS.maxProcessOutputBytes,
        "$.forge.limits",
        FORGE_LIMIT_BOUNDS.maxProcessOutputBytes.minimum,
        FORGE_LIMIT_BOUNDS.maxProcessOutputBytes.maximum,
      ),
      workspacePollIntervalMs: optionalInteger(
        limits,
        "workspacePollIntervalMs",
        FORGE_LIMIT_DEFAULTS.workspacePollIntervalMs,
        "$.forge.limits",
        FORGE_LIMIT_BOUNDS.workspacePollIntervalMs.minimum,
        FORGE_LIMIT_BOUNDS.workspacePollIntervalMs.maximum,
      ),
    },
  });
}

function defaultSearchProfile(): SealedSearchProfile {
  return deepFreeze(structuredClone(DEFAULT_SEARCH_PROFILE));
}

function parseSearch(value: unknown): SealedSearchProfile {
  if (value === undefined) return defaultSearchProfile();
  const search = record(value, "$.search");
  exactKeys(search, ["attemptSafetyCeiling", "nursery", "resources", "seedDerivation"], ["attemptSafetyCeiling", "nursery", "resources", "seedDerivation"], "$.search");
  const attemptSafetyCeiling = parseAttemptCeiling(search.attemptSafetyCeiling, "$.search.attemptSafetyCeiling");
  if (search.seedDerivation !== "sha256-run-digest-frontier-v1" && search.seedDerivation !== "sha256-case-seed-frontier-v2") throw new TypeError("$.search.seedDerivation must name a supported deterministic seed rule");

  const nursery = record(search.nursery, "$.search.nursery");
  exactKeys(nursery, SEARCH_NURSERY_FIELDS, SEARCH_NURSERY_FIELDS, "$.search.nursery");
  const parsedNursery: Record<SearchNurseryField, number> = {
    minimumAttempts: boundedInteger(nursery.minimumAttempts, "$.search.nursery.minimumAttempts", 1),
    // The current nursery requires a positive window; accepting zero would seal a run it cannot execute.
    saturationWindow: boundedInteger(nursery.saturationWindow, "$.search.nursery.saturationWindow", 1),
    independentLineages: boundedInteger(nursery.independentLineages, "$.search.nursery.independentLineages", 1),
    challengeInterval: boundedInteger(nursery.challengeInterval, "$.search.nursery.challengeInterval", 1),
  };
  if (BigInt(parsedNursery.minimumAttempts) > BigInt(attemptSafetyCeiling)) {
    throw new TypeError("$.search.nursery.minimumAttempts cannot exceed $.search.attemptSafetyCeiling");
  }

  const resources = record(search.resources, "$.search.resources");
  exactKeys(resources, SEARCH_RESOURCE_FIELDS, SEARCH_RESOURCE_FIELDS, "$.search.resources");
  const parsedResources = {} as Record<SearchResourceField, number>;
  for (const field of SEARCH_RESOURCE_FIELDS) {
    const minimum = field === "concurrentLineages" || [
      "maxMindInvocations",
      "maxWallMillis",
      "maxSingleInvocationMillis",
      "maxGeneratedBytes",
    ].includes(field)
      ? 1
      : 0;
    const maximum = field === "maxWritableBytes" || field === "maxArtifactBytes"
      ? FORGE_LIMIT_BOUNDS.maxWritableBytes.maximum
      : field === "maxWritableInodes"
        ? FORGE_LIMIT_BOUNDS.maxWritableInodes.maximum
        : Number.MAX_SAFE_INTEGER;
    parsedResources[field] = boundedInteger(resources[field], `$.search.resources.${field}`, minimum, maximum);
  }
  if (parsedResources.concurrentLineages > parsedNursery.independentLineages) {
    throw new TypeError("$.search.resources.concurrentLineages cannot exceed $.search.nursery.independentLineages");
  }
  if (parsedResources.maxSingleInvocationMillis > parsedResources.maxWallMillis) {
    throw new TypeError("$.search.resources.maxSingleInvocationMillis cannot exceed $.search.resources.maxWallMillis");
  }
  // Forge networking is constitutionally denied. A non-zero network envelope would be a false capability claim.
  if (parsedResources.maxNetworkBytes !== 0) {
    throw new TypeError("$.search.resources.maxNetworkBytes must be zero while forge.network is denied");
  }
  return deepFreeze({
    attemptSafetyCeiling,
    nursery: parsedNursery,
    resources: parsedResources,
    seedDerivation: search.seedDerivation,
  });
}

function normalizePolicy(value: unknown): CanonicalProjectPolicy {
  const input = record(value, "$");
  exactKeys(
    input,
    ["protocol", "policyVersion", "semanticContinuation", "reflex", "forge", "memory", "growth", "subjectSnapshots", "search"],
    ["protocol", "policyVersion", "semanticContinuation", "reflex", "forge", "memory", "growth"],
    "$",
  );
  exactValue(input.protocol, PROJECT_POLICY_PROTOCOL, "$.protocol");
  if (input.policyVersion !== "bone-v1" && input.policyVersion !== "bone-v2") throw new TypeError("$.policyVersion must be bone-v1 or bone-v2");
  const policyVersion = input.policyVersion;
  const semanticContinuation = exactValue(input.semanticContinuation, false, "$.semanticContinuation");

  const reflex = record(input.reflex, "$.reflex");
  exactKeys(reflex, ["required", "maximumLoops"], ["required", "maximumLoops"], "$.reflex");
  const required = exactValue(reflex.required, true, "$.reflex.required");
  const maximumLoops = boundedInteger(reflex.maximumLoops, "$.reflex.maximumLoops", 1, 2) as 1 | 2;

  const memory = record(input.memory, "$.memory");
  exactKeys(memory, ["firstWave", "maximumLateInfluence"], ["firstWave", "maximumLateInfluence"], "$.memory");
  const firstWave = exactValue(memory.firstWave, "amnesic", "$.memory.firstWave");
  // The current memory boundary enforces 0.2 exactly. Tighter values would be promises it cannot yet honor.
  const maximumLateInfluence = exactValue(memory.maximumLateInfluence, 0.2, "$.memory.maximumLateInfluence");

  const growth = record(input.growth, "$.growth");
  exactKeys(growth, ["liveBoneMutation", "promotion"], ["liveBoneMutation", "promotion"], "$.growth");
  const liveBoneMutation = exactValue(growth.liveBoneMutation, false, "$.growth.liveBoneMutation");
  const promotion = exactValue(growth.promotion, "signed_governance", "$.growth.promotion");

  return deepFreeze({
    protocol: PROJECT_POLICY_PROTOCOL,
    policyVersion,
    semanticContinuation,
    reflex: { required, maximumLoops },
    forge: parseForge(input.forge),
    memory: { firstWave, maximumLateInfluence },
    growth: { liveBoneMutation, promotion },
    subjectSnapshots: parseSubjectSnapshots(input.subjectSnapshots),
    search: parseSearch(input.search),
  });
}

function policyLocation(projectRoot: string): { root: string; path: string; realRoot: string } {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new TypeError("projectRoot must be an explicit non-empty path");
  }
  const root = resolve(projectRoot);
  let info;
  try {
    info = lstatSync(root);
  } catch (error) {
    throw new TypeError(`Project root does not exist: ${root}`, { cause: error });
  }
  if (!info.isDirectory()) throw new TypeError(`Project root is not a directory: ${root}`);
  return { root, path: join(root, ".jevyr", "policy.json"), realRoot: realpathSync(root) };
}

/** Returns only the exact policy location below the explicit root. It never walks parent or home directories. */
export function projectPolicyPath(projectRoot: string): string {
  return policyLocation(projectRoot).path;
}

function readPolicy(projectRoot: string): { root: string; path: string; source: LoadedProjectPolicy["source"]; value: unknown } {
  const location = policyLocation(projectRoot);
  let info;
  try {
    info = lstatSync(location.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { root: location.root, path: location.path, source: "built-in-default", value: DEFAULT_INPUT };
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new TypeError(`Project policy must be a regular, non-symbolic file: ${location.path}`);
  }
  if (info.size < 1 || info.size > MAX_POLICY_BYTES) {
    throw new TypeError(`Project policy must contain between 1 and ${MAX_POLICY_BYTES} bytes: ${location.path}`);
  }
  const realPolicy = realpathSync(location.path);
  const fromRoot = relative(location.realRoot, realPolicy);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new TypeError(`Project policy resolves outside the explicit project root: ${location.path}`);
  }
  let value: unknown;
  try {
    value = parseJsonBytes(readFileSync(location.path), "Project policy");
  } catch (error) {
    const detail = error instanceof Error ? ` (${error.message})` : "";
    throw new TypeError(`Project policy is not valid unambiguous UTF-8 JSON: ${location.path}${detail}`, { cause: error });
  }
  return { root: location.root, path: location.path, source: "project-file", value };
}

/**
 * Loads one portable policy from `<explicitProjectRoot>/.jevyr/policy.json`.
 * The returned descriptor contains no machine-local path, so equal policies
 * have equal descriptor digests in every checkout.
 */
export function loadProjectPolicy(projectRoot: string): LoadedProjectPolicy {
  const loaded = readPolicy(projectRoot);
  const policy = normalizePolicy(loaded.value);
  const enforcement = policy.policyVersion === "bone-v1" ? ENFORCEMENT : deepFreeze({ ...ENFORCEMENT,
    validatedInvariants: ENFORCEMENT.validatedInvariants.map(value => value === "policyVersion=bone-v1" ? "policyVersion=bone-v2" : value) });
  const policyDescriptor = deepFreeze({
    protocol: PROJECT_POLICY_DESCRIPTOR_PROTOCOL,
    policy,
    enforcement,
  }) as unknown as JsonValue;
  const forgeConfig: PortableForgeConfig = deepFreeze({
    mode: "docker",
    allowTrustedHost: false,
    allowNetwork: false,
    dockerImage: policy.forge.dockerImage,
    ...(policy.forge.engine === "podman" ? { dockerCommand: "podman" } : {}),
    memoryMb: policy.forge.limits.memoryMb,
    cpus: policy.forge.limits.cpus,
    pidsLimit: policy.forge.limits.pidsLimit,
    maxFiles: policy.forge.limits.maxFiles,
    maxFileBytes: policy.forge.limits.maxFileBytes,
    maxWritableBytes: policy.search.resources.maxWritableBytes,
    maxWritableInodes: policy.search.resources.maxWritableInodes,
    maxProcessOutputBytes: policy.forge.limits.maxProcessOutputBytes,
    workspacePollIntervalMs: policy.forge.limits.workspacePollIntervalMs,
    retainFailedWorkspace: false,
  });
  const repositorySealProfile: RepositorySealProfile = deepFreeze({ searchProfile: policy.search,
    ...(policy.policyVersion === "bone-v2" ? { policyVersion: "jevyr.bone/2" as const } : {}) });
  return deepFreeze({
    projectRoot: loaded.root,
    policyPath: loaded.path,
    source: loaded.source,
    policy,
    policyDescriptor,
    descriptorDigest: digestJson(policyDescriptor),
    enforcement,
    repositorySealProfile,
    subjectSnapshotPolicy: policy.subjectSnapshots,
    forgeConfig,
    searchProfile: policy.search,
    reflexLoops: policy.reflex.maximumLoops,
  });
}
