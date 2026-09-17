import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Stats } from "node:fs";
import { chown, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseJsonText } from "@jevyr/core";
import { digestJson, isSha256Digest, type JsonValue } from "@jevyr/protocol";
import {
  candidateMaterializationDigest,
  candidateTreeDigest,
  type CandidateMaterializedFile,
} from "./candidate-blueprints.js";
import type {
  CapabilityCard,
  ProbeResult,
  ToolAdapter,
  ToolInvocation,
  ToolObservation,
} from "./contracts.js";
import {
  copySanitizedDirectory,
  jevyrRelativePath,
  type JevyrIgnorePolicy,
  type SanitizedDirectoryResult,
} from "./ignore-policy.js";
import { runBoundedProcess, type BoundedProcessResult } from "./process.js";
import {
  MAX_ORACLE_FILE_BYTES,
  MAX_ORACLE_OUTPUT_BYTES,
  MAX_ORACLE_WORKSPACE_ENTRIES,
  type BoundedWorkspaceManifest,
  type WorkspacePathMetadata,
} from "./typed-oracles.js";
import type { SealedDockerForgeAuthority } from "./forge-authority.js";

export type ForgeMode = "docker" | "trusted-host" | "observe-only";

export const DEFAULT_DOCKER_FORGE_IMAGE = "node:24-alpine" as const;
export const DOCKER_SUBSTRATE_IDENTITY_PROTOCOL = "jevyr.docker-substrate-identity/1" as const;

export type DockerImageResolutionFailure =
  | "command-unavailable"
  | "inspect-timeout"
  | "inspect-failed"
  | "malformed-identity"
  | "resolver-failed"
  | "not-resolved-at-startup";

export type DockerImageResolutionAttempt = Readonly<
  | { status: "resolved"; imageId: string }
  | { status: "unavailable"; failure: DockerImageResolutionFailure }
>;

export type DockerSubstrateResolutionAuthority =
  | "local-docker-cli"
  | "local-podman-cli"
  | "embedder-injected-resolver"
  | "unbound-direct-construction";

/**
 * Startup-owned identity. A tag is retained as provenance only; execution is
 * permitted exclusively by the content-addressed image ID captured here.
 */
export interface DockerSubstrateIdentity {
  readonly protocol: typeof DOCKER_SUBSTRATE_IDENTITY_PROTOCOL;
  readonly requestedReference: string;
  readonly status: "resolved" | "unavailable";
  readonly immutableImageId: string | null;
  readonly resolutionAuthority: DockerSubstrateResolutionAuthority;
  readonly failure: DockerImageResolutionFailure | null;
}

export interface DockerImageResolutionRequest {
  readonly dockerCommand: string;
  readonly requestedReference: string;
  readonly timeoutMs?: number;
}

export type DockerImageResolver = (
  request: DockerImageResolutionRequest,
) => DockerImageResolutionAttempt;

const DOCKER_IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const DOCKER_RESOLUTION_FAILURES = new Set<DockerImageResolutionFailure>([
  "command-unavailable",
  "inspect-timeout",
  "inspect-failed",
  "malformed-identity",
  "resolver-failed",
  "not-resolved-at-startup",
]);
const DOCKER_RESOLUTION_AUTHORITIES = new Set<DockerSubstrateResolutionAuthority>([
  "local-docker-cli",
  "local-podman-cli",
  "embedder-injected-resolver",
  "unbound-direct-construction",
]);
const DOCKER_FALLBACK_USER_ID = 65_532;

interface DockerForgeUserIdentity {
  readonly userId: number;
  readonly groupId: number;
  readonly requiresOwnershipTransfer: boolean;
}

function localDockerForgeUserIdentity(): DockerForgeUserIdentity {
  const hostUserId = typeof process.getuid === "function" ? process.getuid() : undefined;
  const hostGroupId = typeof process.getgid === "function" ? process.getgid() : undefined;
  const userId = hostUserId !== undefined && Number.isSafeInteger(hostUserId) && hostUserId > 0
    ? hostUserId
    : DOCKER_FALLBACK_USER_ID;
  const groupId = hostGroupId !== undefined && Number.isSafeInteger(hostGroupId) && hostGroupId > 0
    ? hostGroupId
    : userId;
  return Object.freeze({
    userId,
    groupId,
    requiresOwnershipTransfer: hostUserId === 0,
  });
}

export function parseOciImageInspection(stdout: string, engine: "docker" | "podman" = "docker"): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.includes("\n") || trimmed.includes("\r")) return undefined;
  try {
    const value = parseJsonText(trimmed, "Docker image inspection") as unknown;
    if (typeof value !== "string") return undefined;
    if (DOCKER_IMAGE_ID.test(value)) return value;
    return engine === "podman" && /^[a-f0-9]{64}$/u.test(value) ? `sha256:${value}` : undefined;
  } catch {
    return undefined;
  }
}

function parseDockerContainerId(stdout: string): string | undefined {
  const value = stdout.trim();
  return /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

async function readDockerContainerIdFile(path: string): Promise<string | undefined> {
  let value: string;
  try {
    value = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const containerId = parseDockerContainerId(value);
  if (containerId === undefined) throw new Error("Docker Forge cidfile did not contain one exact container ID");
  return containerId;
}

function parseDockerExitCode(stdout: string): number | undefined {
  const value = stdout.trim();
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) return undefined;
  try {
    const parsed: unknown = parseJsonText(value, "Docker container state");
    return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 255
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

const DOCKER_FORGE_MOUNT_TOPOLOGY = Object.freeze(new Map<string, boolean>([
  ["/subject", false],
  ["/jevyr-writable", true],
  ["/tmp", true],
  ["/dev/shm", true],
]));

export interface DockerForgeMountRoots {
  readonly subjectRoot: string;
  readonly writableRoot: string;
}

function normalizedMountSource(value: string, caseInsensitive: boolean): string {
  const normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function expectedDockerMountSources(path: string): ReadonlySet<string> {
  const resolved = resolve(path);
  const windows = /^[a-z]:[\\/]/iu.exec(resolved);
  if (windows === null) return new Set([normalizedMountSource(resolved, false)]);
  const drive = resolved[0]?.toLowerCase();
  const tail = resolved.slice(2).replace(/\\/gu, "/").replace(/^\/+|\/+$/gu, "");
  return new Set([
    `${drive}:/${tail}`,
    `/host_mnt/${drive}/${tail}`,
    `/run/desktop/mnt/host/${drive}/${tail}`,
    `/mnt/host/${drive}/${tail}`,
  ].map((entry) => normalizedMountSource(entry, true)));
}

function mountSourceMatches(actual: string, expected: string): boolean {
  const variants = expectedDockerMountSources(expected);
  const windows = /^[a-z]:[\\/]/iu.test(resolve(expected));
  return variants.has(normalizedMountSource(actual, windows));
}

/**
 * Dockerfile `VOLUME` declarations become anonymous writable mounts even with
 * a read-only root. The concrete container is therefore admitted only when
 * Docker reports exactly the four bind mounts constructed by this module.
 */
export function dockerForgeMountTopologyProblem(
  value: unknown,
  roots: DockerForgeMountRoots,
): string | undefined {
  if (!Array.isArray(value) || value.length !== DOCKER_FORGE_MOUNT_TOPOLOGY.size) {
    return "Docker Forge container has an unexpected mount count";
  }
  const seen = new Set<string>();
  const expectedSources = new Map<string, string>([
    ["/subject", roots.subjectRoot],
    ["/jevyr-writable", roots.writableRoot],
    ["/tmp", join(roots.writableRoot, "runtime", "tmp")],
    ["/dev/shm", join(roots.writableRoot, "runtime", "shm")],
  ]);
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return "Docker Forge container returned a malformed mount";
    }
    const mount = entry as Record<string, unknown>;
    const destination = mount.Destination;
    const expectedWritable = typeof destination === "string"
      ? DOCKER_FORGE_MOUNT_TOPOLOGY.get(destination)
      : undefined;
    const expectedSource = typeof destination === "string" ? expectedSources.get(destination) : undefined;
    if (typeof destination !== "string"
      || expectedWritable === undefined
      || expectedSource === undefined
      || seen.has(destination)
      || mount.Type !== "bind"
      || typeof mount.Source !== "string"
      || mount.Source.length === 0
      || !mountSourceMatches(mount.Source, expectedSource)
      || mount.RW !== expectedWritable) {
      return "Docker Forge container has an unexpected writable mount topology";
    }
    seen.add(destination);
  }
  return seen.size === DOCKER_FORGE_MOUNT_TOPOLOGY.size
    ? undefined
    : "Docker Forge container is missing a sealed bind mount";
}

export function dockerForgeImageVolumeProblem(value: unknown): string | undefined {
  if (value === null) return undefined;
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return "Docker Forge image returned malformed volume configuration";
  }
  return Reflect.ownKeys(value).length === 0
    ? undefined
    : "Docker Forge image declares storage-bearing volumes outside the measured envelope";
}

function parseDockerJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.includes("\n") || trimmed.includes("\r")) return undefined;
  try {
    return parseJsonText(trimmed, "Docker inspection output") as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Resolves one local image without a shell. Failures are data, not startup
 * exceptions, so the daemon can remain observable while Forge stays closed.
 */
export const inspectLocalDockerImage: DockerImageResolver = (request) => {
  const timeoutMs = request.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Docker image inspection timeout must be a safe integer between 1 and 60000 milliseconds");
  }
  const result = spawnSync(
    request.dockerCommand,
    ["image", "inspect", "--format", "{{json .Id}}", request.requestedReference],
    {
      encoding: "utf8",
      maxBuffer: 16_384,
      shell: false,
      timeout: timeoutMs,
      windowsHide: true,
    },
  );
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    return Object.freeze({
      status: "unavailable",
      failure: code === "ETIMEDOUT" ? "inspect-timeout" : code === "ENOENT" ? "command-unavailable" : "inspect-failed",
    });
  }
  if (result.status !== 0) return Object.freeze({ status: "unavailable", failure: "inspect-failed" });
  const imageId = parseOciImageInspection(result.stdout, request.dockerCommand === "podman" ? "podman" : "docker");
  return imageId === undefined
    ? Object.freeze({ status: "unavailable", failure: "malformed-identity" })
    : Object.freeze({ status: "resolved", imageId });
};

export function sealDockerSubstrateIdentity(
  requestedReference: string,
  attempt: DockerImageResolutionAttempt,
  resolutionAuthority: DockerSubstrateResolutionAuthority,
): DockerSubstrateIdentity {
  if (typeof requestedReference !== "string" || requestedReference.length === 0 || requestedReference.includes("\0")) {
    throw new TypeError("Docker substrate requestedReference must be a non-empty string without NUL bytes");
  }
  if (!DOCKER_RESOLUTION_AUTHORITIES.has(resolutionAuthority)) {
    throw new TypeError("Docker substrate resolutionAuthority is invalid");
  }
  if (attempt.status === "resolved") {
    if (!DOCKER_IMAGE_ID.test(attempt.imageId)) {
      throw new TypeError("Resolved Docker substrate imageId must be a full lowercase SHA-256 image ID");
    }
    return Object.freeze({
      protocol: DOCKER_SUBSTRATE_IDENTITY_PROTOCOL,
      requestedReference,
      status: "resolved",
      immutableImageId: attempt.imageId,
      resolutionAuthority,
      failure: null,
    });
  }
  if (attempt.status !== "unavailable" || !DOCKER_RESOLUTION_FAILURES.has(attempt.failure)) {
    throw new TypeError("Docker image resolver returned an invalid unavailable result");
  }
  return Object.freeze({
    protocol: DOCKER_SUBSTRATE_IDENTITY_PROTOCOL,
    requestedReference,
    status: "unavailable",
    immutableImageId: null,
    resolutionAuthority,
    failure: attempt.failure,
  });
}

export interface ForgeConfig {
  readonly mode?: ForgeMode;
  readonly dockerCommand?: string;
  readonly dockerImage?: string;
  /** Daemon-owned, once-per-startup binding for Docker execution. */
  readonly dockerSubstrateIdentity?: DockerSubstrateIdentity;
  readonly allowTrustedHost?: boolean;
  readonly allowNetwork?: boolean;
  readonly memoryMb?: number;
  readonly cpus?: number;
  readonly pidsLimit?: number;
  /** Legacy sanitized-input file ceiling. */
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  /** Aggregate regular-file bytes permitted across the complete writable envelope. */
  readonly maxWritableBytes?: number;
  /** Files and directories permitted across that envelope (root excluded). */
  readonly maxWritableInodes?: number;
  /** Combined stdout + stderr bytes permitted before the process is terminated. */
  readonly maxProcessOutputBytes?: number;
  /** Best-effort workspace meter cadence; final admission always uses a full scan. */
  readonly workspacePollIntervalMs?: number;
  readonly retainFailedWorkspace?: boolean;
  readonly artifactExporter?: (
    caseId: string,
    workspace: string,
    changedFiles: readonly string[],
    limits: Readonly<{ maxArtifactBytes: number }>,
  ) => Promise<readonly string[]>;
}

interface ForgeCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

interface FileFingerprint {
  readonly size: number;
  readonly digest: string;
}

interface DirectoryManifest {
  readonly files: ReadonlyMap<string, FileFingerprint>;
  readonly entries: readonly WorkspacePathMetadata[];
  readonly digest: string;
  readonly totalBytes: number;
  readonly totalInodes: number;
  readonly fileCount: number;
  readonly directoryCount: number;
}

interface PhysicalLimits {
  readonly maxEntries: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

type ForgeLimitKind =
  | "workspace-inodes"
  | "workspace-bytes"
  | "workspace-file-bytes"
  | "workspace-monitor"
  | "workspace-integrity"
  | "process-output";

class ForgeResourceLimitError extends Error {
  override readonly name = "ForgeResourceLimitError";

  constructor(
    readonly kind: ForgeLimitKind,
    message: string,
    readonly used: number,
    readonly ceiling: number,
  ) {
    super(message);
  }
}

const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_FILE_BYTES = 20_000_000;

/**
 * Physical Forge defaults are public so every policy loader can bind the same
 * values instead of silently inheriting constructor-local fallbacks.
 */
export const FORGE_LIMIT_DEFAULTS = Object.freeze({
  maxWritableBytes: 100_000_000,
  maxWritableInodes: 10_000,
  maxProcessOutputBytes: MAX_ORACLE_OUTPUT_BYTES,
  workspacePollIntervalMs: 100,
});

/** Hard admission bounds shared by policy parsing and adapter construction. */
export const FORGE_LIMIT_BOUNDS = Object.freeze({
  maxWritableBytes: Object.freeze({ minimum: 0, maximum: 10_000_000_000 }),
  maxWritableInodes: Object.freeze({ minimum: 0, maximum: MAX_ORACLE_WORKSPACE_ENTRIES }),
  maxProcessOutputBytes: Object.freeze({ minimum: 0, maximum: MAX_ORACLE_OUTPUT_BYTES }),
  workspacePollIntervalMs: Object.freeze({ minimum: 10, maximum: 60_000 }),
});

interface NormalizedForgeLimits {
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxWritableBytes: number;
  readonly maxWritableInodes: number;
  readonly maxProcessOutputBytes: number;
  readonly workspacePollIntervalMs: number;
}

function safeInteger(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${name} must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function boundedInteger(name: string, value: number, minimum: number, maximum: number): number {
  const checked = safeInteger(name, value, minimum);
  if (checked > maximum) throw new RangeError(`${name} cannot exceed the hard limit ${maximum}`);
  return checked;
}

function normalizedLimits(config: ForgeConfig): NormalizedForgeLimits {
  return Object.freeze({
    maxFiles: safeInteger("maxFiles", config.maxFiles ?? DEFAULT_MAX_FILES, 1),
    maxFileBytes: boundedInteger(
      "maxFileBytes",
      config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      1,
      MAX_ORACLE_FILE_BYTES,
    ),
    maxWritableBytes: boundedInteger(
      "maxWritableBytes",
      config.maxWritableBytes ?? FORGE_LIMIT_DEFAULTS.maxWritableBytes,
      FORGE_LIMIT_BOUNDS.maxWritableBytes.minimum,
      FORGE_LIMIT_BOUNDS.maxWritableBytes.maximum,
    ),
    maxWritableInodes: boundedInteger(
      "maxWritableInodes",
      config.maxWritableInodes ?? config.maxFiles ?? FORGE_LIMIT_DEFAULTS.maxWritableInodes,
      FORGE_LIMIT_BOUNDS.maxWritableInodes.minimum,
      FORGE_LIMIT_BOUNDS.maxWritableInodes.maximum,
    ),
    maxProcessOutputBytes: boundedInteger(
      "maxProcessOutputBytes",
      config.maxProcessOutputBytes ?? FORGE_LIMIT_DEFAULTS.maxProcessOutputBytes,
      FORGE_LIMIT_BOUNDS.maxProcessOutputBytes.minimum,
      FORGE_LIMIT_BOUNDS.maxProcessOutputBytes.maximum,
    ),
    workspacePollIntervalMs: boundedInteger(
      "workspacePollIntervalMs",
      config.workspacePollIntervalMs ?? FORGE_LIMIT_DEFAULTS.workspacePollIntervalMs,
      FORGE_LIMIT_BOUNDS.workspacePollIntervalMs.minimum,
      FORGE_LIMIT_BOUNDS.workspacePollIntervalMs.maximum,
    ),
  });
}

function invocationLimits(base: NormalizedForgeLimits, invocation: ToolInvocation): NormalizedForgeLimits {
  const requested = invocation.resourceLimits;
  if (requested === undefined) return base;
  const maxWritableBytes = boundedInteger(
    "resourceLimits.maxWritableBytes",
    requested.maxWritableBytes,
    FORGE_LIMIT_BOUNDS.maxWritableBytes.minimum,
    FORGE_LIMIT_BOUNDS.maxWritableBytes.maximum,
  );
  const maxWritableInodes = boundedInteger(
    "resourceLimits.maxWritableInodes",
    requested.maxWritableInodes,
    FORGE_LIMIT_BOUNDS.maxWritableInodes.minimum,
    FORGE_LIMIT_BOUNDS.maxWritableInodes.maximum,
  );
  return Object.freeze({
    ...base,
    maxWritableBytes: Math.min(base.maxWritableBytes, maxWritableBytes),
    maxWritableInodes: Math.min(base.maxWritableInodes, maxWritableInodes),
  });
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function parseCommand(args: Readonly<Record<string, unknown>>): ForgeCommand {
  if (typeof args.command !== "string" || !args.command.trim()) throw new TypeError("forge.command requires a command");
  const commandArgs = Array.isArray(args.args)
    ? args.args.map((value) => {
        if (typeof value !== "string") throw new TypeError("forge.command args must be strings");
        return value;
      })
    : [];
  const environment =
    args.environment && typeof args.environment === "object" && !Array.isArray(args.environment)
      ? Object.fromEntries(
          Object.entries(args.environment).map(([key, value]) => {
            if (typeof value !== "string" || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
              throw new TypeError("Forge environment must contain string values and conventional names");
            }
            return [key, value];
          }),
        )
      : undefined;
  return {
    command: args.command,
    args: commandArgs,
    ...(environment ? { environment } : {}),
  };
}

function strictMaterialRecord(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${context} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${context} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set(keys);
  const ownKeys = Reflect.ownKeys(record);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))) {
    throw new TypeError(`${context} has an invalid field set`);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${context}.${key} must be an enumerable data property`);
    }
  }
  return record;
}

interface ResolvedForgeMaterials {
  readonly workspace: Readonly<{ role: "empty-tooling"; sourceRoot: string }> | Readonly<{
    role: "candidate";
    readonly sourceRoot: string;
    readonly blueprintDigest: string;
    readonly materializationDigest: string;
    readonly treeDigest: string;
  }>;
  readonly subjects: {
    readonly subjectRoot: string;
    readonly captureDigest: string;
    readonly materializationDigest: string;
  };
}

async function resolveForgeMaterials(value: ToolInvocation["forgeMaterials"]): Promise<ResolvedForgeMaterials> {
  const tooling = value !== null && typeof value === "object"
    && Object.getOwnPropertyDescriptor(value, "protocol")?.value === "jevyr.forge-invocation-materials/2";
  const envelope = strictMaterialRecord(value, ["protocol", tooling ? "workspace" : "candidate", "subjects"], "forgeMaterials");
  if (envelope.protocol !== (tooling ? "jevyr.forge-invocation-materials/2" : "jevyr.forge-invocation-materials/1")) {
    throw new TypeError("forgeMaterials has an unsupported protocol");
  }
  const candidate = strictMaterialRecord(
    tooling ? envelope.workspace : envelope.candidate,
    tooling ? ["role", "sourceRoot"] : ["sourceRoot", "blueprintDigest", "materializationDigest", "treeDigest"],
    tooling ? "forgeMaterials.workspace" : "forgeMaterials.candidate",
  );
  if (tooling && candidate.role !== "empty-tooling") throw new TypeError("Forge tooling workspace has an unsupported role");
  const subjects = strictMaterialRecord(
    envelope.subjects,
    ["subjectRoot", "captureDigest", "materializationDigest"],
    "forgeMaterials.subjects",
  );
  for (const [context, digest] of [
    ...(tooling ? [] : [
      ["forgeMaterials.candidate.blueprintDigest", candidate.blueprintDigest],
      ["forgeMaterials.candidate.materializationDigest", candidate.materializationDigest],
      ["forgeMaterials.candidate.treeDigest", candidate.treeDigest],
    ]),
    ["forgeMaterials.subjects.captureDigest", subjects.captureDigest],
    ["forgeMaterials.subjects.materializationDigest", subjects.materializationDigest],
  ] as const) {
    if (typeof digest !== "string" || !isSha256Digest(digest)) throw new TypeError(`${context} must be a SHA-256 digest`);
  }
  if (typeof candidate.sourceRoot !== "string" || typeof subjects.subjectRoot !== "string") {
    throw new TypeError("Forge material roots must be strings");
  }
  const candidateInput = resolve(candidate.sourceRoot);
  const subjectInput = resolve(subjects.subjectRoot);
  const [candidateInfo, subjectInfo] = await Promise.all([lstat(candidateInput), lstat(subjectInput)]);
  if (candidateInfo.isSymbolicLink() || !candidateInfo.isDirectory()
    || subjectInfo.isSymbolicLink() || !subjectInfo.isDirectory()) {
    throw new TypeError("Forge material roots must be real directories");
  }
  const [candidateRoot, subjectRoot] = await Promise.all([realpath(candidateInput), realpath(subjectInput)]);
  if (candidateRoot === subjectRoot || dirname(candidateRoot) !== dirname(subjectRoot)) {
    throw new TypeError("Forge candidate and subject roots must be distinct siblings");
  }
  const [candidateResolvedInfo, subjectResolvedInfo] = await Promise.all([lstat(candidateRoot), lstat(subjectRoot)]);
  if (!candidateResolvedInfo.isDirectory() || candidateResolvedInfo.isSymbolicLink()
    || !subjectResolvedInfo.isDirectory() || subjectResolvedInfo.isSymbolicLink()
    || candidateResolvedInfo.dev !== candidateInfo.dev || candidateResolvedInfo.ino !== candidateInfo.ino
    || subjectResolvedInfo.dev !== subjectInfo.dev || subjectResolvedInfo.ino !== subjectInfo.ino) {
    throw new Error("Forge material roots changed while being resolved");
  }
  return Object.freeze({
    workspace: tooling ? Object.freeze({ role: "empty-tooling" as const, sourceRoot: candidateRoot }) : Object.freeze({
      role: "candidate" as const,
      sourceRoot: candidateRoot,
      blueprintDigest: candidate.blueprintDigest as string,
      materializationDigest: candidate.materializationDigest as string,
      treeDigest: candidate.treeDigest as string,
    }),
    subjects: Object.freeze({
      subjectRoot,
      captureDigest: subjects.captureDigest as string,
      materializationDigest: subjects.materializationDigest as string,
    }),
  });
}

function candidateFilesFromManifest(manifest: DirectoryManifest): readonly CandidateMaterializedFile[] {
  return Object.freeze(manifest.entries.flatMap((entry) => entry.kind === "file"
    ? [Object.freeze({
        path: entry.path,
        byteLength: entry.byteLength as number,
        digest: entry.digest as string,
      })]
    : []));
}

async function directoryManifest(
  root: string,
  limits: PhysicalLimits,
  ignorePolicy?: JevyrIgnorePolicy,
): Promise<DirectoryManifest> {
  const result = new Map<string, FileFingerprint>();
  const entries: WorkspacePathMetadata[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  let directoryCount = 0;

  const admitEntry = (key: string): void => {
    const used = entries.length + 1;
    if (used > limits.maxEntries) {
      throw new ForgeResourceLimitError(
        "workspace-inodes",
        `Forge workspace exceeds ${limits.maxEntries} files/directories at ${key}`,
        used,
        limits.maxEntries,
      );
    }
  };

  const stableFile = async (absolute: string, initial: Stats): Promise<Buffer> => {
    if (initial.nlink > 1) throw new TypeError(`Forge observations refuse multiply-linked files: ${absolute}`);
    const handle = await open(absolute, "r");
    try {
      const before = await handle.stat();
      if (!before.isFile() || !sameStat(initial, before)) {
        throw new Error(`Forge workspace file changed before reading: ${absolute}`);
      }
      const data = await handle.readFile();
      const after = await handle.stat();
      const pathAfter = await lstat(absolute);
      if (!after.isFile() || !pathAfter.isFile() || !sameStat(before, after) || !sameStat(after, pathAfter)) {
        throw new Error(`Forge workspace file changed while reading: ${absolute}`);
      }
      return data;
    } finally {
      await handle.close();
    }
  };

  const visit = async (directory: string): Promise<void> => {
    const directoryBefore = await lstat(directory);
    if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory()) {
      throw new TypeError(`Forge observations require a stable real directory: ${directory}`);
    }
    const children = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of children) {
      const absolute = join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new TypeError(`Forge observations refuse symbolic links: ${absolute}`);
      const key = jevyrRelativePath(root, absolute);
      if (ignorePolicy?.decide(key, info.isDirectory()).ignored === true) continue;
      admitEntry(key);
      if (info.isDirectory()) {
        entries.push(Object.freeze({ path: key, kind: "directory" }));
        directoryCount += 1;
        await visit(absolute);
      } else if (info.isFile()) {
        if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > limits.maxFileBytes) {
          throw new ForgeResourceLimitError(
            "workspace-file-bytes",
            `Forge workspace file ${key} exceeds ${limits.maxFileBytes} bytes`,
            info.size,
            limits.maxFileBytes,
          );
        }
        if (info.size > limits.maxTotalBytes - totalBytes) {
          throw new ForgeResourceLimitError(
            "workspace-bytes",
            `Forge workspace exceeds ${limits.maxTotalBytes} aggregate bytes at ${key}`,
            totalBytes + info.size,
            limits.maxTotalBytes,
          );
        }
        const data = await stableFile(absolute, info);
        totalBytes += data.byteLength;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
          throw new ForgeResourceLimitError(
            "workspace-bytes",
            `Forge workspace exceeds ${limits.maxTotalBytes} aggregate bytes at ${key}`,
            totalBytes,
            limits.maxTotalBytes,
          );
        }
        const digest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
        result.set(key, { size: data.byteLength, digest });
        entries.push(Object.freeze({ path: key, kind: "file", byteLength: data.byteLength, digest }));
        fileCount += 1;
      } else {
        throw new TypeError(`Forge observations refuse special filesystem entries: ${absolute}`);
      }
    }
    const directoryAfter = await lstat(directory);
    const endingChildren = (await readdir(directory, { withFileTypes: true }))
      .map((entry) => entry.name)
      .sort();
    if (
      directoryAfter.isSymbolicLink()
      || !directoryAfter.isDirectory()
      || !sameStat(directoryBefore, directoryAfter)
      || endingChildren.join("\0") !== children.map((entry) => entry.name).join("\0")
    ) {
      throw new Error(`Forge workspace directory changed while manifesting: ${directory}`);
    }
  };
  await visit(root);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : left.kind.localeCompare(right.kind));
  const subjectEntries = entries.map((entry) => entry.kind === "directory"
    ? { path: entry.path, type: "directory" as const }
    : { path: entry.path, type: "file" as const, digest: entry.digest as string, byteLength: entry.byteLength as number });
  return Object.freeze({
    files: result,
    entries: Object.freeze(entries),
    digest: digestJson({ protocol: "jevyr.directory-manifest/1", entries: subjectEntries } as unknown as JsonValue),
    totalBytes,
    totalInodes: entries.length,
    fileCount,
    directoryCount,
  });
}

/** Lightweight best-effort meter. Final admission always uses directoryManifest. */
async function workspaceLimitViolation(root: string, limits: PhysicalLimits): Promise<string | undefined> {
  let entries = 0;
  let bytes = 0;
  const visit = async (directory: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      let info: Stats;
      try { info = await lstat(absolute); }
      catch (error) {
        // Scratch files may disappear between enumeration and inspection while
        // the candidate runs. The strict post-execution manifest is unchanged.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const key = jevyrRelativePath(root, absolute);
      if (info.isSymbolicLink()) return `workspace contains a forbidden symbolic link at ${key}`;
      entries += 1;
      if (entries > limits.maxEntries) {
        return `workspace inode use ${entries} exceeded ${limits.maxEntries}`;
      }
      if (info.isDirectory()) {
        let nested: string | undefined;
        try { nested = await visit(absolute); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (nested !== undefined) return nested;
      } else if (info.isFile()) {
        if (info.nlink > 1) return `workspace contains a forbidden multiply-linked file at ${key}`;
        if (!Number.isSafeInteger(info.size) || info.size < 0 || info.size > limits.maxFileBytes) {
          return `workspace file ${key} used ${info.size} bytes, exceeding ${limits.maxFileBytes}`;
        }
        bytes += info.size;
        if (!Number.isSafeInteger(bytes) || bytes > limits.maxTotalBytes) {
          return `workspace byte use ${bytes} exceeded ${limits.maxTotalBytes}`;
        }
      } else {
        return `workspace contains a forbidden special entry at ${key}`;
      }
    }
    return undefined;
  };
  return await visit(root);
}

async function transferDirectoryOwnership(root: string, userId: number, groupId: number): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new TypeError(`Docker Forge ownership transfer requires real directories: ${directory}`);
    }
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const entryInfo = await lstat(absolute);
      if (entryInfo.isSymbolicLink()) {
        throw new TypeError(`Docker Forge ownership transfer refuses symbolic links: ${absolute}`);
      }
      if (entryInfo.isDirectory()) await visit(absolute);
      else if (!entryInfo.isFile()) throw new TypeError(`Docker Forge ownership transfer refuses special entries: ${absolute}`);
      await chown(absolute, userId, groupId);
    }
  };
  await visit(root);
  await chown(root, userId, groupId);
}

function changedFiles(before: ReadonlyMap<string, FileFingerprint>, after: ReadonlyMap<string, FileFingerprint>): string[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  return [...keys]
    .filter((key) => before.get(key)?.digest !== after.get(key)?.digest)
    .sort();
}

function changedOutputBytes(
  changed: readonly string[],
  after: ReadonlyMap<string, FileFingerprint>,
): number {
  let bytes = 0;
  for (const path of changed) {
    bytes += after.get(path)?.size ?? 0;
    if (!Number.isSafeInteger(bytes)) throw new Error("Forge changed-output byte accounting exceeded safe integer range");
  }
  return bytes;
}

function exactArtifactRefs(value: readonly string[]): readonly string[] {
  if (!Array.isArray(value)
    || value.some((entry) => typeof entry !== "string" || !/^artifact_[a-f0-9]{24}$/u.test(entry))) {
    throw new Error("Forge artifact exporter returned an invalid artifact reference");
  }
  const sorted = [...value].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new Error("Forge artifact exporter returned duplicate artifact references");
  }
  return Object.freeze(sorted);
}

function manifestUsage(manifest: DirectoryManifest | undefined): Readonly<Record<string, unknown>> {
  return Object.freeze({
    measurement: manifest === undefined ? "UNAVAILABLE" : "MEASURED",
    complete: manifest !== undefined,
    bytes: manifest?.totalBytes ?? null,
    inodes: manifest?.totalInodes ?? null,
    files: manifest?.fileCount ?? null,
    directories: manifest?.directoryCount ?? null,
    digest: manifest?.digest ?? null,
  });
}

function forgeResourceAccounting(
  mode: ForgeMode,
  limits: NormalizedForgeLimits,
  config: ForgeConfig,
  before?: DirectoryManifest,
  after?: DirectoryManifest,
  processResult?: BoundedProcessResult,
): Readonly<Record<string, unknown>> {
  const networkDenied = mode === "docker" && config.allowNetwork !== true;
  return Object.freeze({
    protocol: "jevyr.forge-resource-accounting/1",
    workspace: Object.freeze({
      enforcement: "BEST_EFFORT_POLL_PLUS_COMPLETE_POST_SCAN",
      byteCeiling: limits.maxWritableBytes,
      inodeCeiling: Math.min(limits.maxWritableInodes, MAX_ORACLE_WORKSPACE_ENTRIES),
      fileByteCeiling: limits.maxFileBytes,
      before: manifestUsage(before),
      after: manifestUsage(after),
    }),
    processOutput: Object.freeze({
      measurement: processResult === undefined ? "UNAVAILABLE" : "MEASURED",
      usedBytes: processResult?.outputBytes ?? null,
      stdoutBytes: processResult?.stdoutBytes ?? null,
      stderrBytes: processResult?.stderrBytes ?? null,
      retainedBytes: processResult === undefined
        ? null
        : processResult.stdoutCapture.byteLength + processResult.stderrCapture.byteLength,
      exactCapturesComplete: processResult === undefined
        ? false
        : processResult.stdoutCapture.complete && processResult.stderrCapture.complete,
      ceilingBytes: limits.maxProcessOutputBytes,
      complete: processResult !== undefined,
    }),
    wall: Object.freeze({
      measurement: processResult === undefined ? "UNAVAILABLE" : "MEASURED",
      usedMillis: processResult?.durationMs ?? null,
    }),
    cpu: Object.freeze({
      measurement: "DECLARED_ONLY",
      usedMillis: null,
      enforcement: mode === "docker" ? "RATE_ONLY_NOT_TOTAL_CPU" : "UNENFORCED_AND_UNMEASURED",
      ...(mode === "docker" ? { rateLimitCpus: config.cpus ?? 2 } : {}),
    }),
    network: networkDenied
      ? Object.freeze({
          measurement: "UPPER_BOUND",
          externalBytes: 0,
          enforcement: "DOCKER_NETWORK_NONE",
        })
      : Object.freeze({
          measurement: "DECLARED_ONLY",
          externalBytes: null,
          enforcement: "UNMEASURED",
        }),
  });
}

function topLevelProcessFields(result: BoundedProcessResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    stdoutCapture: result.stdoutCapture,
    stderrCapture: result.stderrCapture,
  });
}

function oracleProcessFields(result: BoundedProcessResult): Readonly<Record<string, unknown>> {
  return Object.freeze({
    stdoutCapture: result.stdoutCapture,
    stderrCapture: result.stderrCapture,
  });
}

function inheritedValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

const FORGE_RUNTIME_ENVIRONMENT_KEYS = new Set([
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
]);

function candidateEnvironment(
  explicit: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(explicit).filter(([key]) => !FORGE_RUNTIME_ENVIRONMENT_KEYS.has(key.toUpperCase())),
  ));
}

function fixedRuntimeEnvironment(
  home: string,
  temporary: string,
  append: (root: string, child: string) => string = join,
): Readonly<Record<string, string>> {
  return Object.freeze({
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: append(home, ".config"),
    XDG_CACHE_HOME: append(home, ".cache"),
    XDG_DATA_HOME: append(home, ".local/share"),
    XDG_STATE_HOME: append(home, ".local/state"),
    XDG_RUNTIME_DIR: append(home, ".runtime"),
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
  });
}

/** A deliberately small environment for the exceptional trusted-host mode. */
export function cleanForgeEnvironment(
  isolationRoot: string,
  explicit: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const home = join(isolationRoot, "home");
  const temporary = join(isolationRoot, "tmp");
  const path = inheritedValue("PATH", "Path");
  const systemRoot = inheritedValue("SystemRoot", "SYSTEMROOT");
  const comspec = inheritedValue("ComSpec", "COMSPEC");
  const pathext = inheritedValue("PATHEXT", "PathExt");
  return Object.freeze({
    ...(path ? { PATH: path } : {}),
    ...(systemRoot ? { SystemRoot: systemRoot } : {}),
    ...(comspec ? { ComSpec: comspec } : {}),
    ...(pathext ? { PATHEXT: pathext } : {}),
    CI: "1",
    NO_COLOR: "1",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TZ: "UTC",
    GIT_TERMINAL_PROMPT: "0",
    ...candidateEnvironment(explicit),
    ...fixedRuntimeEnvironment(home, temporary),
  });
}

export interface DockerForgeArgumentsInput {
  readonly engine?: "docker" | "podman";
  /** Exact observed Podman server mode; required for Podman, including remote clients. */
  readonly podmanRootless?: boolean;
  readonly subjectRoot: string;
  /** Host root containing both `work` and Forge-owned `runtime` state. */
  readonly writableRoot: string;
  readonly image: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly allowNetwork: boolean;
  readonly memoryMb: number;
  readonly cpus: number;
  readonly pidsLimit: number;
  /** Numeric, non-root identity used inside the container. */
  readonly userId: number;
  readonly groupId: number;
  /** Host-side Docker cidfile used for shell-free forced cleanup on interruption. */
  readonly containerIdFile?: string;
}

/** Pure construction keeps the Docker membrane reviewable and directly testable. */
export function buildDockerForgeArguments(input: DockerForgeArgumentsInput): readonly string[] {
  if (!DOCKER_IMAGE_ID.test(input.image)) {
    throw new TypeError("Docker Forge execution requires a full lowercase SHA-256 image ID");
  }
  return [
    "run",
    "--rm",
    ...dockerContainerCreateArguments(input),
  ];
}

function dockerContainerCreateArguments(input: DockerForgeArgumentsInput): readonly string[] {
  if (!DOCKER_IMAGE_ID.test(input.image)) {
    throw new TypeError("Docker Forge execution requires a full lowercase SHA-256 image ID");
  }
  if (!Number.isSafeInteger(input.userId) || input.userId < 1 || input.userId > 2_147_483_647
    || !Number.isSafeInteger(input.groupId) || input.groupId < 1 || input.groupId > 2_147_483_647) {
    throw new TypeError("Docker Forge requires bounded numeric non-root user and group IDs");
  }
  if (input.engine === "podman" && typeof input.podmanRootless !== "boolean") {
    throw new TypeError("Podman Forge requires its observed rootless server mode");
  }
  const volume = (path: string, target: string, access: "ro" | "rw"): string => `${resolve(path)}:${target}:${access}`;
  const subjectRoot = resolve(input.subjectRoot);
  const writableRoot = resolve(input.writableRoot);
  const subjectToWritable = relative(subjectRoot, writableRoot);
  const writableToSubject = relative(writableRoot, subjectRoot);
  const nested = (path: string): boolean => path === ""
    || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
  if (nested(subjectToWritable) || nested(writableToSubject)) {
    throw new TypeError("Docker Forge subject and writable roots must not overlap");
  }
  const runtimeRoot = join(writableRoot, "runtime");
  const runtimeTemporary = join(runtimeRoot, "tmp");
  const runtimeSharedMemory = join(runtimeRoot, "shm");
  const environment = Object.freeze({
    ...candidateEnvironment(input.environment ?? {}),
    ...fixedRuntimeEnvironment(
      "/jevyr-writable/runtime/home",
      "/tmp",
      (root, child) => `${root}/${child}`,
    ),
  });
  return [
    ...(input.containerIdFile ? ["--cidfile", resolve(input.containerIdFile)] : []),
    "--stop-timeout",
    "1",
    "--pull",
    "never",
    "--network",
    input.allowNetwork ? "bridge" : "none",
    "--ipc",
    "none",
    "--read-only",
    ...(input.engine === "podman" ? [
      "--read-only-tmpfs=false",
      "--userns",
      input.podmanRootless ? `keep-id:uid=${input.userId},gid=${input.groupId}` : "host",
    ] : []),
    "--user",
    `${input.userId}:${input.groupId}`,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(input.pidsLimit),
    "--memory",
    `${input.memoryMb}m`,
    "--cpus",
    String(input.cpus),
    "--volume",
    volume(subjectRoot, "/subject", "ro"),
    "--volume",
    volume(writableRoot, "/jevyr-writable", "rw"),
    "--volume",
    volume(runtimeTemporary, "/tmp", "rw"),
    "--volume",
    volume(runtimeSharedMemory, "/dev/shm", "rw"),
    "--workdir",
    "/jevyr-writable/work",
    ...Object.entries(environment).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    input.image,
    input.command,
    ...input.args,
  ];
}

/** Docker `create` permits image inspection before the candidate can execute. */
export function buildDockerForgeCreateArguments(input: DockerForgeArgumentsInput): readonly string[] {
  return ["create", ...dockerContainerCreateArguments(input)];
}

export function parsePodmanRootlessInspection(stdout: string): boolean | undefined {
  const value = stdout.trim();
  return value === "true" ? true : value === "false" ? false : undefined;
}

interface DockerExecutionResult {
  readonly process: BoundedProcessResult;
  readonly executionImageId: string;
}

export class SealedForgeAdapter implements ToolAdapter {
  static readonly #instances = new WeakSet<object>();

  readonly #capability: CapabilityCard;
  readonly #mode: ForgeMode;
  readonly #dockerSubstrateIdentity?: DockerSubstrateIdentity;
  readonly #dockerUserIdentity: DockerForgeUserIdentity | undefined;
  readonly #limits: NormalizedForgeLimits;
  readonly #config: Readonly<ForgeConfig>;

  constructor(config: ForgeConfig = {}) {
    if (new.target !== SealedForgeAdapter) {
      throw new TypeError("SealedForgeAdapter is a final execution boundary and cannot be subclassed");
    }
    const suppliedIdentity = config.dockerSubstrateIdentity === undefined
      ? undefined
      : Object.freeze({ ...config.dockerSubstrateIdentity });
    this.#config = Object.freeze({
      ...config,
      ...(suppliedIdentity === undefined ? {} : { dockerSubstrateIdentity: suppliedIdentity }),
    });
    this.#mode = this.#config.mode ?? "docker";
    this.#dockerUserIdentity = this.#mode === "docker" ? localDockerForgeUserIdentity() : undefined;
    this.#limits = normalizedLimits(this.#config);
    if (this.#mode === "docker") {
      const requestedReference = this.#config.dockerImage ?? DEFAULT_DOCKER_FORGE_IMAGE;
      const supplied = suppliedIdentity;
      if (supplied !== undefined) {
        if (supplied.protocol !== DOCKER_SUBSTRATE_IDENTITY_PROTOCOL) {
          throw new TypeError("Docker substrate identity has an unsupported protocol");
        }
        if (supplied.requestedReference !== requestedReference) {
          throw new TypeError("Docker substrate identity requestedReference does not match dockerImage");
        }
        if (!DOCKER_RESOLUTION_AUTHORITIES.has(supplied.resolutionAuthority)) {
          throw new TypeError("Docker substrate identity resolutionAuthority is invalid");
        }
        if (supplied.status === "resolved") {
          if (!DOCKER_IMAGE_ID.test(supplied.immutableImageId ?? "") || supplied.failure !== null) {
            throw new TypeError("Resolved Docker substrate identity is internally inconsistent");
          }
        } else if (supplied.status === "unavailable") {
          if (supplied.immutableImageId !== null
            || supplied.failure === null
            || !DOCKER_RESOLUTION_FAILURES.has(supplied.failure)) {
            throw new TypeError("Unavailable Docker substrate identity is internally inconsistent");
          }
        } else {
          throw new TypeError("Docker substrate identity has an invalid status");
        }
        this.#dockerSubstrateIdentity = supplied;
      } else {
        this.#dockerSubstrateIdentity = sealDockerSubstrateIdentity(
          requestedReference,
          Object.freeze({ status: "unavailable", failure: "not-resolved-at-startup" }),
          "unbound-direct-construction",
        );
      }
    } else if (suppliedIdentity !== undefined) {
      throw new TypeError("dockerSubstrateIdentity is only valid for Docker Forge mode");
    }
    this.#capability = Object.freeze({
      id: `tool.forge.${this.#mode}.v1`,
      kind: "tool",
      displayName: `Sealed Forge · ${this.#config.dockerCommand === "podman" ? "podman" : this.#mode}`,
      version: "1.0.0",
      transport: this.#mode === "docker" ? "process" : "in-process",
      trust: "local-deterministic",
      modalities: Object.freeze(["files", "commands", "structured-data"] as const),
      network: this.#mode === "observe-only"
        ? "none"
        : this.#mode === "trusted-host" || this.#config.allowNetwork ? "unrestricted" : "none",
      canExecuteTools: this.#mode === "docker"
        ? this.#dockerSubstrateIdentity?.status === "resolved"
        : this.#mode !== "observe-only",
      deterministic: false,
      limits: Object.freeze({
        sourceReadOnly: true,
        disposableOverlay: true,
        networkDeniedByDefault: this.#mode === "docker" && !this.#config.allowNetwork,
        maxWritableBytes: this.#limits.maxWritableBytes,
        maxWritableInodes: Math.min(this.#limits.maxWritableInodes, MAX_ORACLE_WORKSPACE_ENTRIES),
        maxProcessOutputBytes: this.#limits.maxProcessOutputBytes,
        workspacePollIntervalMs: this.#limits.workspacePollIntervalMs,
        workspaceEnforcement: "best-effort-poll-plus-complete-post-scan",
        cpuMeasurement: "declared-only",
        ...(this.#mode === "docker"
          ? { dockerSubstrateStatus: this.#dockerSubstrateIdentity?.status ?? "unavailable" }
          : {}),
      }),
    });
    SealedForgeAdapter.#instances.add(this);
    Object.freeze(this);
  }

  get capability(): CapabilityCard {
    return this.#capability;
  }

  get mode(): ForgeMode {
    return this.#mode;
  }

  get dockerSubstrateIdentity(): DockerSubstrateIdentity | undefined {
    return this.#dockerSubstrateIdentity;
  }

  static isBuiltIn(adapter: ToolAdapter): adapter is SealedForgeAdapter {
    return SealedForgeAdapter.#instances.has(adapter as object);
  }

  /**
   * Proves that an adapter is this module's final, frozen Docker boundary and
   * that its private startup identity equals the authenticated Case policy.
   */
  static liveAuthorityProblem(
    adapter: ToolAdapter,
    authority: SealedDockerForgeAuthority,
  ): string | undefined {
    if (!SealedForgeAdapter.isBuiltIn(adapter)) {
      return "An opaque Forge adapter may report observations but cannot mint sandbox verdict evidence.";
    }
    const forge = adapter;
    const substrate = forge.#dockerSubstrateIdentity;
    if (forge.#mode !== "docker"
      || substrate?.status !== "resolved"
      || substrate.failure !== null
      || substrate.requestedReference !== authority.requestedReference
      || substrate.immutableImageId !== authority.immutableImageId
      || substrate.resolutionAuthority !== authority.resolutionAuthority
      || forge.#config.dockerImage !== authority.requestedReference
      || (forge.#config.dockerCommand ?? "docker") !== (authority.engine ?? "docker")
      || (forge.#config.dockerCommand !== undefined && !["docker", "podman"].includes(forge.#config.dockerCommand))) {
      return "The live Forge boundary does not equal the Docker identity sealed into the Case policy.";
    }
    return undefined;
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    if (this.mode === "observe-only") {
      return {
        available: true,
        observedAt: new Date().toISOString(),
        latencyMs: 0,
        version: "observe-only",
        detail: "Observation mode is active; commands will be recorded but not executed.",
      };
    }
    if (this.mode === "trusted-host") {
      return {
        available: this.#config.allowTrustedHost === true,
        observedAt: new Date().toISOString(),
        latencyMs: 0,
        version: process.version,
        detail:
          this.#config.allowTrustedHost === true
            ? "Trusted-host execution is explicitly enabled; source is copied to a disposable workspace."
            : "Trusted-host execution requires allowTrustedHost=true.",
      };
    }
    const substrate = this.dockerSubstrateIdentity;
    if (substrate?.status !== "resolved" || substrate.immutableImageId === null) {
      return {
        available: false,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        detail: `Docker image identity was unavailable at daemon startup (${substrate?.failure ?? "not-resolved-at-startup"}); Forge remains closed until restart.`,
      };
    }
    try {
      const result = await runBoundedProcess({
        command: this.#config.dockerCommand ?? "docker",
        args: ["image", "inspect", "--format", "{{json .Id}}", substrate.immutableImageId],
        timeoutMs: 8_000,
        maxOutputBytes: 16_000,
        ...(signal ? { signal } : {}),
      });
      const observedImageId = result.exitCode === 0 ? parseOciImageInspection(result.stdout, this.#config.dockerCommand === "podman" ? "podman" : "docker") : undefined;
      const matches = observedImageId === substrate.immutableImageId;
      return {
        available: matches,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        ...(matches ? { version: substrate.immutableImageId } : {}),
        detail:
          matches
            ? "The startup-sealed Docker image ID is locally present. Forge will execute that immutable ID with source mounted read-only."
            : result.exitCode === 0
              ? "Docker returned an image identity that does not match the startup seal; Forge remains closed."
              : `The startup-sealed Docker image is unavailable: ${result.stderr.trim().slice(0, 500)}`,
      };
    } catch (error) {
      return {
        available: false,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        detail: `Docker is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    const startedAt = new Date().toISOString();
    if (invocation.tool !== "forge.command") {
      return {
        invocationId: invocation.invocationId,
        status: "failed",
        summary: `Unsupported Forge operation: ${invocation.tool}`,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
    const command = parseCommand(invocation.args);
    const limits = invocationLimits(this.#limits, invocation);
    if (this.mode === "observe-only") {
      return {
        invocationId: invocation.invocationId,
        status: "not-executed",
        summary: `Observed proposed command ${command.command}; Forge is in observe-only mode.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        metadata: { command: command.command, args: command.args, reason: "observe-only" },
      };
    }
    if (this.mode === "trusted-host" && !this.#config.allowTrustedHost) {
      return {
        invocationId: invocation.invocationId,
        status: "not-executed",
        summary: "Trusted-host execution was not explicitly enabled.",
        startedAt,
        finishedAt: new Date().toISOString(),
        metadata: { reason: "trusted-host-opt-in-required" },
      };
    }
    if (this.mode === "docker") {
      if (isAbsolute(command.command)) {
        return {
          invocationId: invocation.invocationId,
          status: "not-executed",
          summary: "Docker Forge requires a container-local executable name, not a host absolute path.",
          startedAt,
          finishedAt: new Date().toISOString(),
          metadata: { reason: "host-path-not-portable-to-container" },
        };
      }
      const probe = await this.probe(invocation.signal);
      if (!probe.available) {
        return {
          invocationId: invocation.invocationId,
          status: "not-executed",
          summary: "Docker-default Forge could not execute because its startup-sealed image identity is unavailable.",
          startedAt,
          finishedAt: new Date().toISOString(),
          metadata: {
            reason: "docker-unavailable",
            diagnostic: probe.detail,
            dockerSubstrateIdentity: this.dockerSubstrateIdentity,
          },
        };
      }
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "jevyr-forge-"));
    const writableRoot = tempRoot;
    const workspace = join(writableRoot, "work");
    const runtimeRoot = join(writableRoot, "runtime");
    const workspaceLimits: PhysicalLimits = Object.freeze({
      maxEntries: Math.min(limits.maxWritableInodes, MAX_ORACLE_WORKSPACE_ENTRIES),
      maxFileBytes: limits.maxFileBytes,
      maxTotalBytes: limits.maxWritableBytes,
    });
    let sanitization: SanitizedDirectoryResult | undefined;
    let candidateBefore: DirectoryManifest | undefined;
    let candidateAfter: DirectoryManifest | undefined;
    let before: DirectoryManifest | undefined;
    let after: DirectoryManifest | undefined;
    let subjectBefore: DirectoryManifest | undefined;
    let subjectAfter: DirectoryManifest | undefined;
    let materials: ResolvedForgeMaterials | undefined;
    let result: BoundedProcessResult | undefined;
    let executionImageId: string | undefined;
    let dockerUserIdentity: DockerForgeUserIdentity | undefined;
    let retain = false;
    try {
      invocation.signal.throwIfAborted();
      materials = await resolveForgeMaterials(invocation.forgeMaterials);
      if (materials.workspace.role === "empty-tooling") {
        // Check the unsanitized root as well: ignored secrets, empty directories
        // and hidden files cannot be silently removed to manufacture emptiness.
        const scratch = await directoryManifest(materials.workspace.sourceRoot, workspaceLimits);
        if (scratch.entries.length !== 0) throw new Error("Forge tooling workspace must start completely empty");
      }
      sanitization = await copySanitizedDirectory(materials.workspace.sourceRoot, workspace, {
        maxFiles: limits.maxFiles,
        maxFileBytes: limits.maxFileBytes,
      });
      candidateBefore = await directoryManifest(workspace, workspaceLimits);
      const candidateFiles = candidateFilesFromManifest(candidateBefore);
      const expectedDirectories = new Set<string>();
      for (const file of candidateFiles) {
        const parts = file.path.split("/");
        for (let index = 1; index < parts.length; index += 1) expectedDirectories.add(parts.slice(0, index).join("/"));
      }
      const actualDirectories = candidateBefore.entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path);
      if (materials.workspace.role === "empty-tooling") {
        const scratch = await directoryManifest(materials.workspace.sourceRoot, workspaceLimits);
        if (scratch.entries.length !== 0 || candidateBefore.entries.length !== 0)
          throw new Error("Forge tooling workspace changed during empty scratch materialization");
      } else if (actualDirectories.length !== expectedDirectories.size
        || actualDirectories.some((path) => !expectedDirectories.has(path))
        || candidateTreeDigest(candidateFiles) !== materials.workspace.treeDigest
        || candidateMaterializationDigest(materials.workspace.blueprintDigest, candidateFiles)
          !== materials.workspace.materializationDigest) {
        throw new Error("Sanitized Forge candidate copy does not match its runtime materialization binding");
      }

      // Runtime-owned directories are created only after the candidate copy has
      // matched Bone's exact blueprint identity. They live beside the worktree
      // under one envelope so HOME, temporary files, shared memory, and project
      // writes are covered by the same poller and complete post-scan.
      await mkdir(join(runtimeRoot, "home"), { recursive: true });
      await mkdir(join(runtimeRoot, "tmp"), { recursive: false });
      await mkdir(join(runtimeRoot, "shm"), { recursive: false });
      if (this.mode === "docker") {
        dockerUserIdentity = this.#dockerUserIdentity;
        if (dockerUserIdentity === undefined) throw new Error("Docker Forge has no sealed non-root identity");
        if (dockerUserIdentity.requiresOwnershipTransfer) {
          await transferDirectoryOwnership(
            writableRoot,
            dockerUserIdentity.userId,
            dockerUserIdentity.groupId,
          );
        }
      }
      before = await directoryManifest(writableRoot, workspaceLimits);
      const subjectLimits: PhysicalLimits = Object.freeze({
        maxEntries: Math.min(limits.maxFiles, MAX_ORACLE_WORKSPACE_ENTRIES),
        maxFileBytes: limits.maxFileBytes,
        maxTotalBytes: Number.MAX_SAFE_INTEGER,
      });
      subjectBefore = await directoryManifest(materials.subjects.subjectRoot, subjectLimits);
      invocation.signal.throwIfAborted();

      if (this.mode === "docker") {
        if (dockerUserIdentity === undefined) throw new Error("Docker Forge has no sealed non-root identity");
        const dockerExecution = await this.runDocker(
          command,
          materials.subjects.subjectRoot,
          writableRoot,
          dockerUserIdentity,
          invocation,
          limits,
        );
        result = dockerExecution.process;
        executionImageId = dockerExecution.executionImageId;
      } else {
        result = await runBoundedProcess({
              command: command.command,
              args: command.args,
              cwd: workspace,
              env: cleanForgeEnvironment(runtimeRoot, command.environment ?? {}),
              inheritEnv: false,
              timeoutMs: invocation.timeoutMs,
              maxOutputBytes: limits.maxProcessOutputBytes,
              terminateOnOutputLimit: true,
              limitMonitor: {
                intervalMs: limits.workspacePollIntervalMs,
                inspect: async () => await workspaceLimitViolation(writableRoot, workspaceLimits),
              },
              signal: invocation.signal,
            });
      }
      if (result.terminationReason === "output-limit") {
        try {
          after = await directoryManifest(writableRoot, workspaceLimits);
        } catch {
          // The process-output breach is already decisive; an unavailable
          // final manifest remains explicitly incomplete in accounting.
        }
        retain = this.#config.retainFailedWorkspace === true;
        return {
          invocationId: invocation.invocationId,
          status: "failed",
          summary: `Forge terminated the command after combined process output exceeded ${limits.maxProcessOutputBytes} bytes; the result is non-admissible.`,
          startedAt,
          finishedAt: new Date().toISOString(),
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          ...topLevelProcessFields(result),
          metadata: {
            mode: this.mode,
            admissible: false,
            nonAdmissibleReason: "physical-resource-limit",
            resourceViolation: {
              kind: "process-output" satisfies ForgeLimitKind,
              used: result.outputBytes,
              ceiling: limits.maxProcessOutputBytes,
              detail: result.limitDetail,
            },
            outputTruncated: true,
            resourceAccounting: forgeResourceAccounting(this.mode, limits, this.#config, before, after, result),
            ...(retain ? { retainedWorkspace: writableRoot } : {}),
          },
        };
      }
      if (result.terminationReason === "external-limit") {
        retain = this.#config.retainFailedWorkspace === true;
        return {
          invocationId: invocation.invocationId,
          status: "failed",
          summary: "Forge terminated the command because the writable workspace crossed its monitored physical envelope; the result is non-admissible.",
          startedAt,
          finishedAt: new Date().toISOString(),
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
          ...topLevelProcessFields(result),
          metadata: {
            mode: this.mode,
            admissible: false,
            nonAdmissibleReason: "physical-resource-limit",
            resourceViolation: {
              kind: "workspace-monitor" satisfies ForgeLimitKind,
              used: null,
              ceiling: null,
              detail: result.limitDetail,
            },
            resourceAccounting: forgeResourceAccounting(this.mode, limits, this.#config, before, undefined, result),
            ...(retain ? { retainedWorkspace: writableRoot } : {}),
          },
        };
      }

      after = await directoryManifest(writableRoot, workspaceLimits);
      candidateAfter = await directoryManifest(workspace, workspaceLimits);
      subjectAfter = this.mode === "docker"
        ? await directoryManifest(materials.subjects.subjectRoot, subjectLimits)
        : undefined;
      if (this.mode === "docker" && subjectAfter?.digest !== subjectBefore.digest) {
        throw new Error("Dedicated reconstructed subject tree changed during Docker execution");
      }
      const changed = changedFiles(candidateBefore.files, candidateAfter.files);
      const exportedArtifactRefs = this.#config.artifactExporter
        ? await this.#config.artifactExporter(invocation.caseId, workspace, changed, Object.freeze({
            maxArtifactBytes: invocation.resourceLimits?.maxArtifactBytes ?? Number.MAX_SAFE_INTEGER,
          }))
        : [];
      const artifactRefs = exactArtifactRefs(exportedArtifactRefs);
      const outputArtifactBytes = changedOutputBytes(changed, candidateAfter.files);
      if (this.#config.artifactExporter) {
        const [verifiedEnvelopeAfterExport, verifiedCandidateAfterExport] = await Promise.all([
          directoryManifest(writableRoot, workspaceLimits),
          directoryManifest(workspace, workspaceLimits),
        ]);
        if (verifiedEnvelopeAfterExport.digest !== after.digest
          || verifiedCandidateAfterExport.digest !== candidateAfter.digest) {
          throw new Error("Forge artifact export changed the disposable workspace after the post-execution manifest");
        }
        after = verifiedEnvelopeAfterExport;
        candidateAfter = verifiedCandidateAfterExport;
      }
      const succeeded = result.exitCode === 0 && result.terminationReason === "exit";
      retain = !succeeded && this.#config.retainFailedWorkspace === true;
      return {
        invocationId: invocation.invocationId,
        status: succeeded ? "succeeded" : "failed",
        summary: succeeded
          ? `Forge command completed; ${changed.length} file${changed.length === 1 ? "" : "s"} changed in the disposable overlay.`
          : `Forge command failed${result.timedOut ? " after timing out" : ` with exit ${result.exitCode}`}.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
        ...(artifactRefs.length ? { artifactRefs } : {}),
        oracle: {
          ...(materials.workspace.role === "empty-tooling" ? { toolingWorkspace: {
            schema: "jevyr.empty-tooling-workspace/1" as const, initialEntries: 0 as const, initialDigest: candidateBefore.digest,
          } } : {}),
          execution: {
            state: result.terminationReason === "timeout"
              ? "timed-out"
              : result.terminationReason === "exit" && result.exitCode !== null ? "exited" : "not-executed",
            mode: this.mode,
            command: command.command,
            args: command.args,
            shell: false,
            ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
            ...oracleProcessFields(result),
            outputTruncated: result.truncated,
            ...(this.mode === "docker"
              && this.dockerSubstrateIdentity?.status === "resolved"
              && executionImageId !== undefined
              ? {
                  substrate: {
                    schema: "jevyr.docker-execution-substrate/1" as const,
                    requestedReference: this.dockerSubstrateIdentity.requestedReference,
                    startupResolvedImageId: this.dockerSubstrateIdentity.immutableImageId as string,
                    executionImageId,
                    contentAddressed: true as const,
                    inspectedBeforeExecution: true as const,
                  },
                }
              : {}),
          },
          workspace: {
            root: "disposable-workspace",
            complete: true,
            maxEntries: workspaceLimits.maxEntries,
            entries: candidateAfter.entries,
          } satisfies BoundedWorkspaceManifest,
          ...(this.mode === "docker" && this.#config.allowNetwork !== true
            ? {
                networkIsolation: {
                  schema: "jevyr.docker-network-none/1" as const,
                  networkMode: "none" as const,
                  enforced: true,
                  complete: true,
                  externalAccessCount: 0,
                },
              }
            : {}),
          ...(this.mode === "docker" && subjectAfter !== undefined
            ? {
                subjectBoundary: {
                  schema: "jevyr.sanitized-subject-boundary/2" as const,
                  sanitized: true,
                  disposableWorkspace: true,
                  sealedSubjectReadOnly: true,
                  originalSubjectAccessible: false,
                  complete: true,
                  captureDigest: materials.subjects.captureDigest,
                  materializationDigest: materials.subjects.materializationDigest,
                  beforeDigest: subjectBefore.digest,
                  afterDigest: subjectAfter.digest,
                },
              }
            : {}),
        },
        metadata: {
          mode: this.mode,
          admissible: true,
          command: command.command,
          args: command.args,
          shell: false,
          changedFiles: changed,
          artifactReceipt: {
            protocol: "jevyr.forge-artifact-receipt/1",
            invocationId: invocation.invocationId,
            artifactRefs,
            outputBytes: outputArtifactBytes,
          },
          outputTruncated: result.truncated,
          sourceReadOnly: this.mode === "docker",
          sourceSanitized: true,
          networkDenied: this.mode === "docker" && !this.#config.allowNetwork,
          originalSourceIsolation: this.mode === "docker" ? "ENFORCED_BY_EXCLUSIVE_MOUNTS" : "UNVERIFIED_TRUSTED_HOST",
          ignorePolicyDigest: sanitization.ignoreDigest,
          excludedPaths: sanitization?.excluded ?? [],
          resourceAccounting: forgeResourceAccounting(this.mode, limits, this.#config, before, after, result),
          ...(this.mode === "docker" ? { dockerSubstrateIdentity: this.dockerSubstrateIdentity } : {}),
          ...(retain ? { retainedWorkspace: writableRoot } : {}),
        },
      };
    } catch (error) {
      retain = this.#config.retainFailedWorkspace === true;
      const limit = error instanceof ForgeResourceLimitError ? error : undefined;
      return {
        invocationId: invocation.invocationId,
        status: "failed",
        summary: limit === undefined
          ? `Forge failed before producing an admissible observation: ${error instanceof Error ? error.message : String(error)}`
          : `Forge refused a workspace outside the physical envelope: ${limit.message}; the result is non-admissible.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        ...(result?.exitCode === null || result?.exitCode === undefined ? {} : { exitCode: result.exitCode }),
        ...(result === undefined ? {} : topLevelProcessFields(result)),
        metadata: {
          mode: this.mode,
          admissible: false,
          nonAdmissibleReason: limit === undefined ? "boundary-or-integrity-failure" : "physical-resource-limit",
          ...(limit === undefined
            ? { boundaryFailure: error instanceof Error ? error.message : String(error) }
            : {
                resourceViolation: {
                  kind: limit.kind,
                  used: limit.used,
                  ceiling: limit.ceiling,
                  detail: limit.message,
                },
              }),
          resourceAccounting: forgeResourceAccounting(this.mode, limits, this.#config, before, after, result),
          ...(retain ? { retainedWorkspace: writableRoot } : {}),
        },
      };
    } finally {
      if (!retain) await rm(tempRoot, { recursive: true, force: true });
    }
  }

  private async runDocker(
    command: ForgeCommand,
    subjectRoot: string,
    writableRoot: string,
    userIdentity: DockerForgeUserIdentity,
    invocation: ToolInvocation,
    forgeLimits: NormalizedForgeLimits,
  ): Promise<DockerExecutionResult> {
    const limits: PhysicalLimits = Object.freeze({
      maxEntries: Math.min(forgeLimits.maxWritableInodes, MAX_ORACLE_WORKSPACE_ENTRIES),
      maxFileBytes: forgeLimits.maxFileBytes,
      maxTotalBytes: forgeLimits.maxWritableBytes,
    });
    const substrate = this.#dockerSubstrateIdentity;
    if (substrate?.status !== "resolved" || substrate.immutableImageId === null) {
      throw new Error("Docker execution requires a startup-sealed immutable image ID");
    }
    const dockerCommand = this.#config.dockerCommand ?? "docker";
    let podmanRootless: boolean | undefined;
    if (dockerCommand === "podman") {
      const inspection = await runBoundedProcess({
        command: dockerCommand,
        args: ["info", "--format", "{{json .Host.Security.Rootless}}"],
        timeoutMs: Math.min(8_000, invocation.timeoutMs),
        maxOutputBytes: 1_024,
        terminateOnOutputLimit: true,
        signal: invocation.signal,
      });
      podmanRootless = inspection.terminationReason === "exit" && inspection.exitCode === 0
        ? parsePodmanRootlessInspection(inspection.stdout) : undefined;
      if (podmanRootless === undefined) throw new Error("Podman did not return its exact rootless server mode");
    }
    const imageVolumeInspection = await runBoundedProcess({
      command: dockerCommand,
      args: ["image", "inspect", "--format", "{{json .Config.Volumes}}", substrate.immutableImageId],
      timeoutMs: Math.min(8_000, invocation.timeoutMs),
      maxOutputBytes: 64_000,
      terminateOnOutputLimit: true,
      signal: invocation.signal,
    });
    const imageVolumeProblem = imageVolumeInspection.terminationReason === "exit"
      && imageVolumeInspection.exitCode === 0
      ? dockerForgeImageVolumeProblem(parseDockerJson(imageVolumeInspection.stdout))
      : "Docker did not return the sealed image's volume configuration";
    if (imageVolumeProblem !== undefined) throw new Error(imageVolumeProblem);

    const dockerControlRoot = await mkdtemp(join(tmpdir(), "jevyr-forge-docker-control-"));
    const containerIdFile = join(dockerControlRoot, "container.cid");
    let containerId: string | undefined;
    const cleanupContainerIds = new Set<string>();
    try {
      const create = await runBoundedProcess({
        command: dockerCommand,
        args: buildDockerForgeCreateArguments({
          engine: dockerCommand === "podman" ? "podman" : "docker",
          ...(podmanRootless === undefined ? {} : { podmanRootless }),
          subjectRoot,
          writableRoot,
          image: substrate.immutableImageId,
          command: command.command,
          args: command.args,
          ...(command.environment ? { environment: command.environment } : {}),
          allowNetwork: this.#config.allowNetwork === true,
          memoryMb: this.#config.memoryMb ?? 1_024,
          cpus: this.#config.cpus ?? 2,
          pidsLimit: this.#config.pidsLimit ?? 256,
          userId: userIdentity.userId,
          groupId: userIdentity.groupId,
          containerIdFile,
        }),
        timeoutMs: Math.min(30_000, invocation.timeoutMs),
        maxOutputBytes: 16_000,
        terminateOnOutputLimit: true,
        signal: invocation.signal,
      });
      const stdoutContainerId = parseDockerContainerId(create.stdout);
      if (stdoutContainerId !== undefined) cleanupContainerIds.add(stdoutContainerId);
      containerId = stdoutContainerId;
      const fileContainerId = await readDockerContainerIdFile(containerIdFile);
      if (fileContainerId !== undefined) cleanupContainerIds.add(fileContainerId);
      if (stdoutContainerId !== undefined && fileContainerId !== undefined && stdoutContainerId !== fileContainerId) {
        throw new Error("Docker Forge stdout and cidfile named different containers");
      }
      containerId = fileContainerId ?? stdoutContainerId;
      if (create.terminationReason !== "exit"
        || create.exitCode !== 0
        || stdoutContainerId === undefined
        || fileContainerId === undefined) {
        throw new Error(`Docker could not create one cidfile-bound Forge container: ${create.stderr.trim().slice(0, 500)}`);
      }
      const admittedContainerId = fileContainerId;

      // `docker create` has not run the candidate. Inspect the concrete
      // container object, then start only if its Image field equals the seal.
      const inspection = await runBoundedProcess({
        command: dockerCommand,
        args: ["container", "inspect", "--format", "{{json .Image}}", admittedContainerId],
        timeoutMs: Math.min(8_000, invocation.timeoutMs),
        maxOutputBytes: 16_000,
        terminateOnOutputLimit: true,
        signal: invocation.signal,
      });
      const executionImageId = inspection.terminationReason === "exit" && inspection.exitCode === 0
        ? parseOciImageInspection(inspection.stdout, dockerCommand === "podman" ? "podman" : "docker")
        : undefined;
      if (executionImageId !== substrate.immutableImageId) {
        throw new Error("Created Docker container image identity does not match the startup seal");
      }

      const mountInspection = await runBoundedProcess({
        command: dockerCommand,
        args: ["container", "inspect", "--format", "{{json .Mounts}}", admittedContainerId],
        timeoutMs: Math.min(8_000, invocation.timeoutMs),
        maxOutputBytes: 64_000,
        terminateOnOutputLimit: true,
        signal: invocation.signal,
      });
      const mountProblem = mountInspection.terminationReason === "exit" && mountInspection.exitCode === 0
        ? dockerForgeMountTopologyProblem(parseDockerJson(mountInspection.stdout), { subjectRoot, writableRoot })
        : "Docker did not return the candidate container's exact mount topology";
      if (mountProblem !== undefined) throw new Error(mountProblem);

      let processResult = await runBoundedProcess({
        command: dockerCommand,
        args: ["start", "--attach", admittedContainerId],
        timeoutMs: invocation.timeoutMs,
        maxOutputBytes: forgeLimits.maxProcessOutputBytes,
        terminateOnOutputLimit: true,
        limitMonitor: {
          intervalMs: forgeLimits.workspacePollIntervalMs,
          inspect: async () => await workspaceLimitViolation(writableRoot, limits),
        },
        signal: invocation.signal,
      });
      if (processResult.terminationReason === "exit") {
        const state = await runBoundedProcess({
          command: dockerCommand,
          args: ["container", "inspect", "--format", "{{json .State.ExitCode}}", admittedContainerId],
          timeoutMs: Math.min(8_000, invocation.timeoutMs),
          maxOutputBytes: 16_000,
          terminateOnOutputLimit: true,
          signal: invocation.signal,
        });
        const exitCode = state.terminationReason === "exit" && state.exitCode === 0
          ? parseDockerExitCode(state.stdout)
          : undefined;
        if (exitCode === undefined) throw new Error("Docker did not return the candidate container's exact exit code");
        processResult = Object.freeze({ ...processResult, exitCode });
      }
      return Object.freeze({ process: processResult, executionImageId });
    } finally {
      let cidfileFailure: unknown;
      if (containerId === undefined) {
        try {
          containerId = await readDockerContainerIdFile(containerIdFile);
          if (containerId !== undefined) cleanupContainerIds.add(containerId);
        } catch (error) {
          cidfileFailure = error;
        }
      }
      let cleanupFailure: unknown;
      for (const cleanupContainerId of cleanupContainerIds) {
        try {
          const cleanup = await runBoundedProcess({
            command: dockerCommand,
            args: ["rm", "--force", "--volumes", cleanupContainerId],
            timeoutMs: 5_000,
            maxOutputBytes: 16_000,
            terminateOnOutputLimit: true,
          });
          if (cleanup.terminationReason !== "exit" || cleanup.exitCode !== 0) {
            cleanupFailure = new Error("Docker Forge could not prove disposal of its assay container and volumes");
          }
        } catch (error) {
          cleanupFailure = error;
        }
      }
      await rm(dockerControlRoot, { recursive: true, force: true });
      if (cleanupFailure !== undefined) throw cleanupFailure;
      if (cidfileFailure !== undefined) throw cidfileFailure;
    }
  }
}

// The instance is frozen in the constructor; freezing the prototype closes the
// remaining JavaScript method-replacement route around the branded boundary.
Object.freeze(SealedForgeAdapter.prototype);
Object.freeze(SealedForgeAdapter);

export function forgeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  extensions: Pick<ForgeConfig, "artifactExporter"> = {},
): SealedForgeAdapter {
  const configuredMode = env.JEVYR_FORGE_MODE;
  const mode: ForgeMode = ["docker", "trusted-host", "observe-only"].includes(configuredMode ?? "")
    ? (configuredMode as ForgeMode)
    : "docker";
  const dockerImage = env.JEVYR_FORGE_IMAGE ?? DEFAULT_DOCKER_FORGE_IMAGE;
  const engine = env.JEVYR_FORGE_ENGINE ?? "docker";
  if (engine !== "docker" && engine !== "podman") throw new TypeError("JEVYR_FORGE_ENGINE must be docker or podman");
  const dockerSubstrateIdentity = mode === "docker"
    ? sealDockerSubstrateIdentity(
        dockerImage,
        inspectLocalDockerImage({ dockerCommand: engine, requestedReference: dockerImage }),
        engine === "podman" ? "local-podman-cli" : "local-docker-cli",
      )
    : undefined;
  return new SealedForgeAdapter({
    mode,
    allowTrustedHost: env.JEVYR_ALLOW_TRUSTED_HOST === "1",
    allowNetwork: env.JEVYR_FORGE_ALLOW_NETWORK === "1",
    ...(mode === "docker" && dockerSubstrateIdentity !== undefined
      ? { dockerImage, dockerSubstrateIdentity, ...(engine === "podman" ? { dockerCommand: engine } : {}) }
      : {}),
    ...extensions,
  });
}
