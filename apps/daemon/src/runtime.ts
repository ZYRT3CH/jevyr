import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { TemporalDeep } from "@jevyr/memory";
import { parseJsonBytes } from "@jevyr/core";
import {
  CaseRepository,
  compileAssayFrontier,
  compileJevyrIgnorePolicy,
  configuredMindAdapters,
  FileEventHub,
  FORGE_LIMIT_BOUNDS,
  DEFAULT_DOCKER_FORGE_IMAGE,
  JevyrOrchestrator,
  LIVE_JUGGLER_POLICY_DESCRIPTOR,
  createMetabolicAllowance,
  MAX_ORACLE_FILE_BYTES,
  MAX_ORACLE_WORKSPACE_ENTRIES,
  McpSamplingMindAdapter,
  SealedForgeAdapter,
  snapshotAdapterCapability,
  inspectLocalDockerImage,
  investigationImplementationDescriptor,
  createRepositoryEvaluationObserverPolicy,
  createRepositoryPureExecutionPolicy,
  loadRepositoryPureProducerAssetsSync,
  assertRepositoryPureProducerAssets,
  ORIGINAL_SUBJECT_CERTIFICATE_CHECKER,
  type RepositoryPureProducerAssets,
  REVISION_INVESTIGATION_POLICY,
  createReproductionMemoryGuard,
  createMetabolicReproductionPlan,
  METABOLIC_CHECKPOINT_POLICY,
  sealDockerSubstrateIdentity,
  toLiveCaseStatus,
  type CapabilityCard,
  type ForgePlan,
  type AssayFrontier,
  type ForgeConfig,
  type DockerImageResolver,
  type DockerSubstrateIdentity,
  type MindAdapter,
  type McpCreateMessageParams,
  type McpCreateMessageResult,
  type OrchestratorConfig,
  type RuntimeGrowthPolicy,
  type ReproductionMemoryGuard,
  type MetabolicReproductionPlan,
  type ToolAdapter,
  type JevyrIgnorePolicy,
} from "@jevyr/runtime";
import { assertCaseSubmission, createSearchEnvelope, digestJson, isSha256Digest, sha256Digest, validateAirlockChoices, type AirlockChoices, type CaseSubmission, type CaseIntent, type JsonValue, type LiveCaseStatus } from "@jevyr/protocol";
import { loadMetabolicCalibrations } from "./metabolic-startup.js";
import { loadMcpWitnesses, type LoadedMcpWitnesses } from "./mcp-witnesses.js";
import { loadGenomeStartupSelection, type LoadedGenomeStartupSelection } from "./genome-startup.js";
import { composeGenomeRuntime } from "./genome-runtime.js";
import { loadPresetStartupSelection, type LoadedPresetStartupSelection } from "./preset-startup.js";
import { selectBenchmarkGenome } from "./benchmark-genome.js";
import type { StoredGenome } from "@jevyr/growth";
import { loadProjectPolicy } from "./project-policy.js";
import { loadPeerMinds } from "./peer-minds.js";
import { createRuntimeSelfJudge } from "./self-judge-runtime.js";
import { ConnectionProfiles } from "./connection-profiles.js";

export interface DaemonRuntimeOptions {
  /** Trusted embedder/source-test seam. Ordinary compiled startup verifies packaged assets. */
  readonly originalSubjectAssets?: RepositoryPureProducerAssets;
  /** Laboratory embedder only; every resulting Seal names an unpromoted experiment. Never accepted by HTTP Cast. */
  readonly benchmarkGenome?: StoredGenome;
  readonly dataDir?: string;
  readonly projectRoot?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly minds?: readonly MindAdapter[];
  readonly forge?: ToolAdapter;
  /** Embedder-only override. The ordinary daemon never weakens project policy from environment variables. */
  readonly forgeConfig?: DaemonForgeConfigOverride;
  /** Embedder/test seam. Its provenance is sealed and it is invoked exactly once per daemon startup. */
  readonly dockerImageResolver?: DockerImageResolver;
}

/** The daemon owns artifact export; embedders may override only serializable Forge inputs. */
export type DaemonForgeConfigOverride = Readonly<Omit<ForgeConfig, "artifactExporter" | "dockerSubstrateIdentity">>;

/** Public daemon views. Record signing and ledger append stay inside Bone. */
export type DaemonRepository = Pick<CaseRepository,
  | "artifact"
  | "artifacts"
  | "dataDir"
  | "descriptor"
  | "genomeDescriptor"
  | "genomeDigest"
  | "genomeVersion"
  | "intentContract"
  | "policyDescriptor"
  | "policyDigest"
  | "publicTrustBundle"
  | "receipt"
  | "record"
  | "recordEnvelope"
  | "runAttestations"
  | "sealEnvelope"
  | "searchEnvelope"
  | "status"
  | "terminalEnvelope"
  | "terminalReceipt"
>;
export type DaemonEvents = Pick<FileEventHub, "lastSequence" | "list" | "read" | "wait">;
export type DaemonOrchestrator = Pick<JevyrOrchestrator, "abort" | "abortAll" | "cast" | "waitForTerminal" | "vouchers" | "redeemVoucher" | "metabolismOffers" | "redeemMetabolism">;
/** Read-only memory inspection; mutation remains closure-owned by Bone/Archivist. */
export type DaemonMemory = Pick<TemporalDeep,
  | "deriveTribunalEvidence"
  | "evidenceHistory"
  | "exportProject"
  | "projectMemoryStates"
  | "retrieve"
>;

/** One originating MCP tool transaction, not a persistent model or human-input channel. */
export interface ClientModelRunContext {
  readonly client: { readonly name: string; readonly version: string; readonly protocolVersion: string };
  readonly sample: (params: McpCreateMessageParams, signal: AbortSignal) => Promise<McpCreateMessageResult>;
  readonly signal: AbortSignal;
  readonly onSealed?: (receipt: unknown) => void;
}

export interface DaemonRuntime {
  readonly repository: DaemonRepository;
  readonly events: DaemonEvents;
  readonly orchestrator: DaemonOrchestrator;
  readonly minds: readonly MindAdapter[];
  readonly forge: ToolAdapter;
  readonly memory: DaemonMemory;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly witnesses: LoadedMcpWitnesses;
  readonly connections: ConnectionProfiles;
  /** Immutable startup snapshot; the active registry pointer is not polled during this runtime. */
  readonly genome: LoadedGenomeStartupSelection;
  readonly preset: LoadedPresetStartupSelection;
  readonly growthPolicy: RuntimeGrowthPolicy;
  /** Immutable, compile-admitted startup frontier; applicability is Case-dependent. */
  readonly assayFrontier: AssayFrontier;
  previewAirlock(choices?: AirlockChoices): { readonly policyDigest: string; readonly genomeDigest: string; readonly genomeVersion: string; readonly searchEnvelope: CaseRepository["searchEnvelope"]; readonly policy: JsonValue; readonly capabilities: readonly CapabilityCard[]; readonly availableCapabilities: readonly CapabilityCard[]; readonly resourceMaximum: CaseRepository["searchEnvelope"]["profile"]["resources"] };
  castAirlock(submission: CaseSubmission, choices: AirlockChoices, expectedPolicyDigest: string): ReturnType<JevyrOrchestrator["cast"]>;
  reproduceCase(sourceCaseId: string, seed: "same" | "new"): ReturnType<JevyrOrchestrator["cast"]>;
  ready(): Promise<void>;
  status(caseId: string): Promise<LiveCaseStatus | undefined>;
  runWithClientModel(intent: CaseIntent, context: ClientModelRunContext): Promise<unknown>;
  close(): Promise<void>;
}

function exposeRepository(repository: CaseRepository): DaemonRepository {
  return Object.freeze({
    artifact: repository.artifact.bind(repository),
    artifacts: repository.artifacts.bind(repository),
    dataDir: repository.dataDir,
    descriptor: repository.descriptor.bind(repository),
    genomeDescriptor: structuredClone(repository.genomeDescriptor),
    genomeDigest: repository.genomeDigest,
    genomeVersion: repository.genomeVersion,
    intentContract: repository.intentContract.bind(repository),
    policyDescriptor: structuredClone(repository.policyDescriptor),
    policyDigest: repository.policyDigest,
    publicTrustBundle: repository.publicTrustBundle.bind(repository),
    receipt: repository.receipt.bind(repository),
    record: repository.record.bind(repository),
    recordEnvelope: repository.recordEnvelope.bind(repository),
    runAttestations: repository.runAttestations.bind(repository),
    sealEnvelope: repository.sealEnvelope.bind(repository),
    searchEnvelope: structuredClone(repository.searchEnvelope),
    status: repository.status.bind(repository),
    terminalEnvelope: repository.terminalEnvelope.bind(repository),
    terminalReceipt: repository.terminalReceipt.bind(repository),
  });
}

function exposeEvents(events: FileEventHub): DaemonEvents {
  return Object.freeze({
    lastSequence: events.lastSequence.bind(events),
    list: events.list.bind(events),
    read: events.read.bind(events),
    wait: events.wait.bind(events),
  });
}

function exposeOrchestrator(orchestrator: JevyrOrchestrator, scopedOrchestrators: ReadonlySet<JevyrOrchestrator>, caseOwners: ReadonlyMap<string, JevyrOrchestrator>): DaemonOrchestrator {
  return Object.freeze({
    abortAll: orchestrator.abortAll.bind(orchestrator),
    abort: (caseId) => {
      if (orchestrator.abort(caseId) === "accepted") return "accepted";
      for (const scoped of scopedOrchestrators) if (scoped.abort(caseId) === "accepted") return "accepted";
      return "closed";
    },
    cast: orchestrator.cast.bind(orchestrator),
    waitForTerminal: orchestrator.waitForTerminal.bind(orchestrator),
    vouchers: orchestrator.vouchers.bind(orchestrator),
    redeemVoucher: orchestrator.redeemVoucher.bind(orchestrator),
    metabolismOffers: (caseId) => (caseOwners.get(caseId) ?? orchestrator).metabolismOffers(caseId),
    redeemMetabolism: (caseId, value) => (caseOwners.get(caseId) ?? orchestrator).redeemMetabolism(caseId, value),
  });
}

function exposeMemory(memory: TemporalDeep): DaemonMemory {
  return Object.freeze({
    deriveTribunalEvidence: memory.deriveTribunalEvidence.bind(memory),
    evidenceHistory: memory.evidenceHistory.bind(memory),
    exportProject: memory.exportProject.bind(memory),
    projectMemoryStates: memory.projectMemoryStates.bind(memory),
    retrieve: memory.retrieve.bind(memory),
  });
}

interface LeaseOwner {
  readonly protocol: "jevyr.daemon-lease/1";
  readonly instanceId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

interface DataDirLease {
  readonly owner: LeaseOwner;
  release(): void;
}

const MAX_ASSAY_CONFIG_BYTES = 1_048_576;

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function stableOpenedFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameFileIdentity(left, right)
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function readStableAssayConfig(configuredPath: string, projectRoot: string, label: string): unknown {
  const wasRelative = !isAbsolute(configuredPath);
  const path = resolve(projectRoot, configuredPath);
  const pathBefore = lstatSync(path, { bigint: true });
  if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new TypeError(`${label} must be a regular non-symbolic-link file`);
  }
  if (pathBefore.size < 1n || pathBefore.size > BigInt(MAX_ASSAY_CONFIG_BYTES)) {
    throw new TypeError(`${label} must contain 1-${MAX_ASSAY_CONFIG_BYTES} bytes`);
  }
  const resolvedPath = realpathSync(path);
  if (wasRelative) {
    const resolvedRoot = realpathSync(resolve(projectRoot));
    const fromRoot = relative(resolvedRoot, resolvedPath);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new TypeError(`${label} resolves outside the explicit project root`);
    }
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new TypeError(`${label} must be a regular non-symbolic-link file`, { cause: error });
    }
    throw error;
  }
  let bytes: Buffer;
  try {
    const beforeRead = fstatSync(descriptor, { bigint: true });
    if (!beforeRead.isFile() || !sameFileIdentity(pathBefore, beforeRead)) {
      throw new Error(`${label} changed before the daemon could bind its opened file`);
    }
    if (beforeRead.size < 1n || beforeRead.size > BigInt(MAX_ASSAY_CONFIG_BYTES)) {
      throw new TypeError(`${label} must contain 1-${MAX_ASSAY_CONFIG_BYTES} bytes`);
    }
    bytes = readFileSync(descriptor);
    const afterRead = fstatSync(descriptor, { bigint: true });
    let pathAfter: BigIntStats;
    try {
      pathAfter = lstatSync(path, { bigint: true });
    } catch (error) {
      throw new Error(`${label} changed while the daemon was binding its opened file`, { cause: error });
    }
    if (!stableOpenedFile(beforeRead, afterRead)
      || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || !sameFileIdentity(afterRead, pathAfter)
      || BigInt(bytes.byteLength) !== afterRead.size) {
      throw new Error(`${label} changed while the daemon was binding its opened file`);
    }
  } finally {
    closeSync(descriptor);
  }
  return parseJsonBytes(bytes, label);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw error;
  }
}

/**
 * A directory is the atomic lease primitive. Dead same-host owners are moved to
 * a unique quarantine path before a contender attempts acquisition; ambiguous
 * or cross-host leases fail closed and require operator inspection.
 */
function acquireDataDirLease(dataDir: string): DataDirLease {
  mkdirSync(dataDir, { recursive: true });
  const leasePath = join(dataDir, ".daemon-lease");
  const ownerPath = join(leasePath, "owner.json");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const instanceId = randomUUID();
    const owner: LeaseOwner = {
      protocol: "jevyr.daemon-lease/1",
      instanceId,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
    };
    try {
      mkdirSync(leasePath);
      try {
        writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      } catch (error) {
        rmSync(leasePath, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        owner,
        release(): void {
          if (released) return;
          let stored: LeaseOwner;
          try {
            stored = parseJsonBytes(readFileSync(ownerPath), "Jevyr data-directory lease") as LeaseOwner;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              if (!existsSync(leasePath)) {
                released = true;
                return;
              }
              throw new Error("Jevyr's owned lease directory remains present but its ownership token disappeared", { cause: error });
            }
            throw error;
          }
          if (stored.protocol !== owner.protocol || stored.instanceId !== owner.instanceId) {
            throw new Error("Refusing to release a Jevyr data-directory lease owned by another daemon instance");
          }
          const releasePath = join(dataDir, `.daemon-lease.release-${owner.instanceId}`);
          renameSync(leasePath, releasePath);
          rmSync(releasePath, { recursive: true, force: false });
          released = true;
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let existing: LeaseOwner;
    try {
      existing = parseJsonBytes(readFileSync(ownerPath), "Jevyr data-directory lease") as LeaseOwner;
    } catch (error) {
      throw new Error(`Jevyr data directory is locked by an unreadable lease at ${leasePath}; inspect it before removal`, { cause: error });
    }
    if (
      existing.protocol !== "jevyr.daemon-lease/1" ||
      typeof existing.instanceId !== "string" ||
      !Number.isSafeInteger(existing.pid) ||
      typeof existing.hostname !== "string" ||
      typeof existing.acquiredAt !== "string"
    ) {
      throw new Error(`Jevyr data directory is locked by an invalid lease at ${leasePath}; inspect it before removal`);
    }
    if (existing.hostname !== hostname() || processIsAlive(existing.pid)) {
      throw new Error(`Jevyr data directory is already owned by daemon ${existing.instanceId} (pid ${existing.pid} on ${existing.hostname})`);
    }
    const stalePath = join(dataDir, `.daemon-lease.stale-${existing.instanceId}-${randomUUID()}`);
    try {
      renameSync(leasePath, stalePath);
      rmSync(stalePath, { recursive: true, force: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("Could not acquire the Jevyr data-directory lease after retiring a stale owner");
}

function mimeType(path: string): string {
  return (
    {
      ".json": "application/json",
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".ts": "text/plain; charset=utf-8",
      ".md": "text/markdown; charset=utf-8",
      ".txt": "text/plain; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
    } as Record<string, string>
  )[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function loadCandidateIgnorePolicy(projectRoot: string): {
  readonly policy: JevyrIgnorePolicy;
  readonly descriptor: JsonValue;
} {
  const realRoot = realpathSync(resolve(projectRoot));
  const path = join(realRoot, ".jevyrignore");
  let data = Buffer.alloc(0);
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > 64 * 1024) {
      throw new TypeError("Project .jevyrignore must be a regular file of at most 65536 bytes");
    }
    const resolvedPolicy = realpathSync(path);
    const fromRoot = relative(realRoot, resolvedPolicy);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new TypeError("Project .jevyrignore resolves outside the explicit project root");
    }
    data = readFileSync(resolvedPolicy);
    const after = lstatSync(path);
    if (after.isSymbolicLink() || !after.isFile()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || data.byteLength !== after.size) {
      throw new Error("Project .jevyrignore changed while the daemon was binding it");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const policy = compileJevyrIgnorePolicy(realRoot, data);
  return Object.freeze({
    policy,
    descriptor: Object.freeze({
      protocol: "jevyr.ignore-policy/1",
      source: new TextDecoder("utf-8", { fatal: true }).decode(data),
      sourceDigest: policy.sourceDigest,
      sourceBytes: policy.sourceBytes,
    }) as unknown as JsonValue,
  });
}

function loadForgePlan(env: NodeJS.ProcessEnv, projectRoot = process.cwd()): ForgePlan | undefined {
  if (!env.JEVYR_FORGE_PLAN_FILE) return undefined;
  const loaded = readStableAssayConfig(env.JEVYR_FORGE_PLAN_FILE, projectRoot, "Legacy Forge plan");
  if (!loaded || typeof loaded !== "object" || Array.isArray(loaded)) {
    throw new TypeError("Legacy Forge plan must contain an object");
  }
  const value = loaded as Record<string, unknown>;
  const allowed = new Set([
    "command",
    "args",
    "timeoutMs",
    "obligationId",
    "sealedSubjectDigest",
    "sealedTestSuite",
    "requestedAssay",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`Forge plan contains unknown or obsolete fields: ${unknown.sort().join(", ")}`);
  }
  if (typeof value.command !== "string" || !value.command.trim()) throw new TypeError("Forge plan requires command");
  const args = value.args === undefined ? [] : value.args;
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
    throw new TypeError("Forge plan args must be strings");
  }
  const timeoutMs = value.timeoutMs === undefined ? 120_000 : value.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
    throw new TypeError("Forge plan timeoutMs must be 1000–600000");
  }
  const obligationId = value.obligationId;
  if (obligationId !== undefined && (typeof obligationId !== "string" || !/^obl_[a-f0-9]{20}$/u.test(obligationId))) {
    throw new TypeError("Forge plan obligationId must be a deterministic sealed obligation id");
  }
  const sealedSubjectDigest = value.sealedSubjectDigest;
  if (sealedSubjectDigest !== undefined && (typeof sealedSubjectDigest !== "string" || !isSha256Digest(sealedSubjectDigest))) {
    throw new TypeError("Forge plan sealedSubjectDigest must be a SHA-256 digest");
  }
  const typedDigestObject = (
    input: unknown,
    label: string,
    fields: readonly string[],
  ): Record<string, string> | undefined => {
    if (input === undefined) return undefined;
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError(`Forge plan ${label} must be an object`);
    }
    const record = input as Record<string, unknown>;
    if (Object.keys(record).length !== fields.length || fields.some((field) => !(field in record))) {
      throw new TypeError(`Forge plan ${label} must contain exactly ${fields.join(", ")}`);
    }
    for (const field of fields) {
      if (typeof record[field] !== "string" || !isSha256Digest(record[field] as string)) {
        throw new TypeError(`Forge plan ${label}.${field} must be a SHA-256 digest`);
      }
    }
    return record as Record<string, string>;
  };
  const sealedTestSuite = typedDigestObject(value.sealedTestSuite, "sealedTestSuite", ["suiteDigest"]);
  const requestedAssay = typedDigestObject(value.requestedAssay, "requestedAssay", ["definitionDigest", "evaluatorDigest"]);
  return Object.freeze({
    tool: "forge.command",
    args: Object.freeze({
      command: value.command,
      args: Object.freeze([...args]),
    }),
    timeoutMs,
    ...(obligationId === undefined ? {} : { obligationId }),
    ...(sealedSubjectDigest === undefined ? {} : { sealedSubjectDigest }),
    ...(sealedTestSuite === undefined ? {} : { sealedTestSuite: { suiteDigest: sealedTestSuite.suiteDigest as string } }),
    ...(requestedAssay === undefined
      ? {}
      : {
          requestedAssay: {
            definitionDigest: requestedAssay.definitionDigest as string,
            evaluatorDigest: requestedAssay.evaluatorDigest as string,
          },
        }),
  });
}

function loadAssayFrontier(
  env: NodeJS.ProcessEnv,
  projectRoot: string,
  resources: import("@jevyr/protocol").SearchResourceEnvelope,
  archive: import("@jevyr/runtime").AssayArchiveGenomeKnobs,
): AssayFrontier {
  if (env.JEVYR_ASSAY_FRONTIER_FILE && env.JEVYR_FORGE_PLAN_FILE) {
    throw new TypeError("Configure JEVYR_ASSAY_FRONTIER_FILE or legacy JEVYR_FORGE_PLAN_FILE, never both");
  }
  const conventionalPath = join(projectRoot, ".jevyr", "assay-frontier.json");
  const configuredFrontier = env.JEVYR_ASSAY_FRONTIER_FILE
    ?? (env.JEVYR_FORGE_PLAN_FILE === undefined && existsSync(conventionalPath)
      ? conventionalPath
      : undefined);
  if (configuredFrontier) {
    const value = readStableAssayConfig(configuredFrontier, projectRoot, "Assay Frontier file");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Assay Frontier file must contain an object");
    }
    const input = value as Record<string, unknown>;
    const unknown = Object.keys(input).filter((key) => !["protocol", "assays"].includes(key));
    if (unknown.length > 0) {
      throw new TypeError(`Assay Frontier contains unknown fields: ${unknown.sort().join(", ")}`);
    }
    if (input.protocol !== "jevyr.assay-frontier/1" || !Array.isArray(input.assays)) {
      throw new TypeError("Assay Frontier requires protocol jevyr.assay-frontier/1 and an assays array");
    }
    return compileAssayFrontier(input.assays, resources, archive);
  }
  const legacy = loadForgePlan(env, projectRoot);
  return compileAssayFrontier(
    legacy === undefined
      ? []
      : [{ assayId: "legacy.default", costUnits: 1, ...legacy }],
    resources,
    archive,
  );
}

const DAEMON_FORGE_CONFIG_FIELDS = Object.freeze([
  "mode",
  "dockerCommand",
  "dockerImage",
  "allowTrustedHost",
  "allowNetwork",
  "memoryMb",
  "cpus",
  "pidsLimit",
  "maxFiles",
  "maxFileBytes",
  "maxWritableBytes",
  "maxWritableInodes",
  "maxProcessOutputBytes",
  "workspacePollIntervalMs",
  "retainFailedWorkspace",
] as const);

function integerOverride(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${path} must be a safe integer between ${minimum} and ${maximum}`);
  }
}

function numberOverride(value: unknown, path: string, minimum: number, maximum: number): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${path} must be a finite number between ${minimum} and ${maximum}`);
  }
}

/**
 * Reads an embedder object exactly once. Accessors, inherited values, symbols,
 * unknown aliases, and the daemon-owned exporter are rejected rather than
 * becoming an unsealed second configuration channel.
 */
function snapshotForgeConfigOverride(value: DaemonForgeConfigOverride | undefined): DaemonForgeConfigOverride | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("forgeConfig must be a plain object");
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("forgeConfig must be a plain object without inherited configuration");
  }
  const allowed = new Set<string>(DAEMON_FORGE_CONFIG_FIELDS);
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new TypeError(`forgeConfig.${String(key)} is not a recognized daemon Forge input`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new TypeError(`forgeConfig.${key} must be an inert data property`);
    }
    if (descriptor.value !== undefined) snapshot[key] = descriptor.value;
  }

  if (snapshot.mode !== undefined && !["docker", "trusted-host", "observe-only"].includes(snapshot.mode as string)) {
    throw new TypeError("forgeConfig.mode must equal docker, trusted-host, or observe-only");
  }
  for (const key of ["dockerCommand", "dockerImage"] as const) {
    const field = snapshot[key];
    if (field !== undefined && (typeof field !== "string" || field.trim().length === 0 || field.length > 4_096 || field.includes("\0"))) {
      throw new TypeError(`forgeConfig.${key} must be a non-empty string of at most 4096 characters`);
    }
  }
  for (const key of ["allowTrustedHost", "allowNetwork", "retainFailedWorkspace"] as const) {
    if (snapshot[key] !== undefined && typeof snapshot[key] !== "boolean") {
      throw new TypeError(`forgeConfig.${key} must be boolean`);
    }
  }
  if (snapshot.memoryMb !== undefined) integerOverride(snapshot.memoryMb, "forgeConfig.memoryMb", 64, 1_048_576);
  if (snapshot.cpus !== undefined) numberOverride(snapshot.cpus, "forgeConfig.cpus", 0.1, 1_024);
  if (snapshot.pidsLimit !== undefined) integerOverride(snapshot.pidsLimit, "forgeConfig.pidsLimit", 1, 1_000_000);
  if (snapshot.maxFiles !== undefined) {
    integerOverride(snapshot.maxFiles, "forgeConfig.maxFiles", 1, MAX_ORACLE_WORKSPACE_ENTRIES);
  }
  if (snapshot.maxFileBytes !== undefined) {
    integerOverride(snapshot.maxFileBytes, "forgeConfig.maxFileBytes", 1, MAX_ORACLE_FILE_BYTES);
  }
  if (snapshot.maxWritableBytes !== undefined) {
    integerOverride(
      snapshot.maxWritableBytes,
      "forgeConfig.maxWritableBytes",
      FORGE_LIMIT_BOUNDS.maxWritableBytes.minimum,
      FORGE_LIMIT_BOUNDS.maxWritableBytes.maximum,
    );
  }
  if (snapshot.maxWritableInodes !== undefined) {
    integerOverride(
      snapshot.maxWritableInodes,
      "forgeConfig.maxWritableInodes",
      FORGE_LIMIT_BOUNDS.maxWritableInodes.minimum,
      FORGE_LIMIT_BOUNDS.maxWritableInodes.maximum,
    );
  }
  if (snapshot.maxProcessOutputBytes !== undefined) {
    integerOverride(
      snapshot.maxProcessOutputBytes,
      "forgeConfig.maxProcessOutputBytes",
      FORGE_LIMIT_BOUNDS.maxProcessOutputBytes.minimum,
      FORGE_LIMIT_BOUNDS.maxProcessOutputBytes.maximum,
    );
  }
  if (snapshot.workspacePollIntervalMs !== undefined) {
    integerOverride(
      snapshot.workspacePollIntervalMs,
      "forgeConfig.workspacePollIntervalMs",
      FORGE_LIMIT_BOUNDS.workspacePollIntervalMs.minimum,
      FORGE_LIMIT_BOUNDS.workspacePollIntervalMs.maximum,
    );
  }
  return Object.freeze(snapshot) as DaemonForgeConfigOverride;
}

function forgeConfigDescriptor(config: DaemonForgeConfigOverride): JsonValue {
  return Object.freeze({
    mode: config.mode ?? null,
    dockerCommand: config.dockerCommand ?? null,
    dockerImage: config.dockerImage ?? null,
    allowTrustedHost: config.allowTrustedHost ?? null,
    allowNetwork: config.allowNetwork ?? null,
    memoryMb: config.memoryMb ?? null,
    cpus: config.cpus ?? null,
    pidsLimit: config.pidsLimit ?? null,
    maxFiles: config.maxFiles ?? null,
    maxFileBytes: config.maxFileBytes ?? null,
    maxWritableBytes: config.maxWritableBytes ?? null,
    maxWritableInodes: config.maxWritableInodes ?? null,
    maxProcessOutputBytes: config.maxProcessOutputBytes ?? null,
    workspacePollIntervalMs: config.workspacePollIntervalMs ?? null,
    retainFailedWorkspace: config.retainFailedWorkspace ?? null,
  }) as JsonValue;
}

function forgeAdapterLimitsDescriptor(capability: CapabilityCard): JsonValue {
  const limits = capability.limits;
  if (limits === undefined) return null;
  const result: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(limits).sort(([left], [right]) => left.localeCompare(right))) {
    if (
      key.length === 0
      || key.length > 256
      || (typeof value === "number" && !Number.isFinite(value))
      || !["number", "string", "boolean"].includes(typeof value)
    ) {
      throw new TypeError(`Embedder Forge capability limit ${JSON.stringify(key)} is not canonical JSON`);
    }
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return Object.freeze(result) as JsonValue;
}

type ForgeSubstrateDescriptor = Readonly<
  | {
      protocol: "jevyr.forge-substrate-binding/1";
      adapterBoundary: "built-in";
      mode: "docker";
      requestedReference: string;
      status: "resolved" | "unavailable";
      immutableImageId: string | null;
      resolutionAuthority: DockerSubstrateIdentity["resolutionAuthority"];
      failure: DockerSubstrateIdentity["failure"];
    }
  | {
      protocol: "jevyr.forge-substrate-binding/1";
      adapterBoundary: "built-in";
      mode: "trusted-host" | "observe-only";
      requestedReference: null;
      status: "not-applicable";
      immutableImageId: null;
      resolutionAuthority: "not-applicable";
      failure: null;
    }
  | {
      protocol: "jevyr.forge-substrate-binding/1";
      adapterBoundary: "opaque-embedder";
      mode: null;
      requestedReference: null;
      status: "opaque-adapter";
      immutableImageId: null;
      resolutionAuthority: "adapter-defined-unverified";
      failure: null;
    }
>;

function bindStartupForgeSubstrate(
  config: DaemonForgeConfigOverride,
  resolver: DockerImageResolver | undefined,
): { readonly descriptor: ForgeSubstrateDescriptor; readonly dockerIdentity?: DockerSubstrateIdentity } {
  const mode = config.mode ?? "docker";
  if (mode !== "docker") {
    return Object.freeze({
      descriptor: Object.freeze({
        protocol: "jevyr.forge-substrate-binding/1",
        adapterBoundary: "built-in",
        mode,
        requestedReference: null,
        status: "not-applicable",
        immutableImageId: null,
        resolutionAuthority: "not-applicable",
        failure: null,
      }),
    });
  }
  const requestedReference = config.dockerImage ?? DEFAULT_DOCKER_FORGE_IMAGE;
  const selectedResolver = resolver ?? inspectLocalDockerImage;
  let identity: DockerSubstrateIdentity;
  try {
    identity = sealDockerSubstrateIdentity(
      requestedReference,
      selectedResolver({
        dockerCommand: config.dockerCommand ?? "docker",
        requestedReference,
        timeoutMs: 8_000,
      }),
      resolver === undefined ? (config.dockerCommand === "podman" ? "local-podman-cli" : "local-docker-cli") : "embedder-injected-resolver",
    );
  } catch {
    identity = sealDockerSubstrateIdentity(
      requestedReference,
      Object.freeze({ status: "unavailable", failure: "resolver-failed" }),
      resolver === undefined ? (config.dockerCommand === "podman" ? "local-podman-cli" : "local-docker-cli") : "embedder-injected-resolver",
    );
  }
  return Object.freeze({
    dockerIdentity: identity,
    descriptor: Object.freeze({
      ...identity,
      protocol: "jevyr.forge-substrate-binding/1",
      adapterBoundary: "built-in",
      mode: "docker",
    }),
  });
}

function opaqueForgeSubstrateDescriptor(): ForgeSubstrateDescriptor {
  return Object.freeze({
    protocol: "jevyr.forge-substrate-binding/1",
    adapterBoundary: "opaque-embedder",
    mode: null,
    requestedReference: null,
    status: "opaque-adapter",
    immutableImageId: null,
    resolutionAuthority: "adapter-defined-unverified",
    failure: null,
  });
}

export function createDaemonRuntime(options: DaemonRuntimeOptions = {}): DaemonRuntime {
  const env = options.env ?? process.env;
  const embedderForge = options.forge;
  const configuredMinds = options.minds;
  const projectRoot = resolve(options.projectRoot ?? env.JEVYR_PROJECT_ROOT ?? process.cwd());
  const projectPolicy = loadProjectPolicy(projectRoot);
  const forgeConfigOverride = snapshotForgeConfigOverride(options.forgeConfig);
  if (embedderForge !== undefined && forgeConfigOverride !== undefined) {
    throw new TypeError("forge and forgeConfig cannot both be supplied because configuration of an opaque adapter cannot be proven");
  }
  if (embedderForge !== undefined && options.dockerImageResolver !== undefined) {
    throw new TypeError("forge and dockerImageResolver cannot both be supplied because an opaque adapter owns its substrate");
  }
  const requestedForgeConfig = Object.freeze({
    ...projectPolicy.forgeConfig,
    ...(forgeConfigOverride ?? {}),
  }) as DaemonForgeConfigOverride;
  const requestedForgeSubstrate: {
    readonly descriptor: ForgeSubstrateDescriptor;
    readonly dockerIdentity?: DockerSubstrateIdentity;
  } = embedderForge === undefined
    ? bindStartupForgeSubstrate(requestedForgeConfig, options.dockerImageResolver)
    : Object.freeze({ descriptor: opaqueForgeSubstrateDescriptor() });
  const preflightObserveOnly = embedderForge === undefined && projectPolicy.policy.forge.missingDocker === "UNPROVEN" && requestedForgeSubstrate.dockerIdentity?.status === "unavailable";
  const effectiveForgeConfig = Object.freeze({ ...requestedForgeConfig, ...(preflightObserveOnly ? { mode: "observe-only" as const } : {}) });
  const startupForgeSubstrate = preflightObserveOnly ? bindStartupForgeSubstrate(effectiveForgeConfig, undefined) : requestedForgeSubstrate;
  const forgePreflight = Object.freeze({ protocol: "jevyr.forge-preflight/1", missingSecureExecution: projectPolicy.policy.forge.missingDocker,
    requestedSubstrate: requestedForgeSubstrate.descriptor, decision: preflightObserveOnly ? "observe-only-before-seal" : "retain-requested-body", capabilityLossAfterSeal: "INVALID" });
  const candidateIgnore = loadCandidateIgnorePolicy(projectRoot);
  const dataInput = options.dataDir ?? env.JEVYR_DATA_DIR ?? join(projectRoot, ".jevyr");
  const dataDir = isAbsolute(dataInput) ? resolve(dataInput) : resolve(projectRoot, dataInput);
  const projectId = env.JEVYR_PROJECT_ID?.trim() || `project_${sha256Digest(dataDir).slice("sha256:".length, "sha256:".length + 24)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(projectId)) throw new TypeError("JEVYR_PROJECT_ID contains unsupported characters");
  const peers = loadPeerMinds(env, projectRoot);
  const connections = new ConnectionProfiles(projectRoot, env, loadMcpWitnesses(env, projectRoot));
  const primaryMinds = configuredMinds ?? connections.minds();
  const minds = Object.freeze([...(peers.minds.length ? primaryMinds.filter(mind => snapshotAdapterCapability(mind).id !== "mind.rule.v1") : primaryMinds), ...peers.minds]);
  const witnesses = connections.witnesses();
  const mindCapabilities = Object.freeze(minds.map((mind) => snapshotAdapterCapability(mind)));
  const witnessCapabilities = Object.freeze(witnesses.adapters.map((witness) => snapshotAdapterCapability(witness)));
  const embedderForgeCapability = embedderForge === undefined
    ? undefined
    : snapshotAdapterCapability(embedderForge);
  if (mindCapabilities.some((capability) => capability.kind !== "mind")) {
    throw new TypeError("Every configured daemon Mind adapter must declare kind mind");
  }
  if (witnessCapabilities.some((capability) => capability.kind !== "tool")) {
    throw new TypeError("Every configured MCP witness adapter must declare kind tool");
  }
  if (embedderForgeCapability !== undefined && embedderForgeCapability.kind !== "tool") {
    throw new TypeError("The configured daemon Forge adapter must declare kind tool");
  }
  const adapterIds = [
    ...mindCapabilities,
    ...witnessCapabilities,
    ...(embedderForgeCapability === undefined ? [] : [embedderForgeCapability]),
  ].map((capability) => capability.id);
  if (new Set(adapterIds).size !== adapterIds.length) {
    throw new TypeError("Configured daemon adapter capability ids must be unique");
  }
  const lease = acquireDataDirLease(dataDir);
  let memory: TemporalDeep | undefined;
  try {
    // The mutable active pointer is read and governance-verified exactly once,
    // before any CaseRepository exists. Every Case in this runtime shares this
    // immutable selection; pointer changes become visible only after restart.
    const activeGenome = loadGenomeStartupSelection(env, projectRoot, dataDir, projectPolicy.policy.policyVersion);
    const genome = options.benchmarkGenome === undefined ? activeGenome : selectBenchmarkGenome(options.benchmarkGenome, activeGenome);
    const preset = loadPresetStartupSelection(env, projectRoot, dataDir, genome);
    const composedGrowth = composeGenomeRuntime(
      projectPolicy.searchProfile,
      projectPolicy.policy.memory.maximumLateInfluence,
      preset.runtimeProfile,
    );
    const assayFrontier = loadAssayFrontier(
      env,
      projectRoot,
      composedGrowth.searchProfile.resources,
      composedGrowth.archive,
    );
    const temporalMemory = new TemporalDeep(join(dataDir, "memory", "temporal-deep.sqlite"));
    memory = temporalMemory;
    const metabolicCalibrations = loadMetabolicCalibrations(projectRoot);
    const metabolicAllowance = createMetabolicAllowance(createSearchEnvelope(composedGrowth.searchProfile), CaseRepository.metabolicSignerDescriptorSync(dataDir), metabolicCalibrations);
    const originalSubjectEnabled = projectPolicy.policy.policyVersion === "bone-v2" && embedderForge === undefined
      && startupForgeSubstrate.dockerIdentity?.status === "resolved" && startupForgeSubstrate.dockerIdentity.resolutionAuthority === "local-docker-cli"
      && effectiveForgeConfig.allowNetwork !== true;
    const originalSubjectAssets = originalSubjectEnabled ? options.originalSubjectAssets ?? loadRepositoryPureProducerAssetsSync() : undefined;
    if (originalSubjectAssets) assertRepositoryPureProducerAssets(originalSubjectAssets);
    const effectivePolicyDescriptor = {
      protocol: "jevyr.effective-policy/1",
      runAttestations: "jevyr.run-attestations/1",
      kernel: "jevyr.deterministic-policy/1",
      jugglerPolicy: LIVE_JUGGLER_POLICY_DESCRIPTOR,
      metabolicAllowance,
      investigationKernel: investigationImplementationDescriptor(),
      repositoryEvaluationObserver: embedderForge === undefined && startupForgeSubstrate.dockerIdentity && effectiveForgeConfig.allowNetwork !== true
        ? createRepositoryEvaluationObserverPolicy({ dockerIdentity: startupForgeSubstrate.dockerIdentity }) ?? null : null,
      ...(projectPolicy.policy.policyVersion === "bone-v2" ? {
        originalSubjectCertificateChecker: ORIGINAL_SUBJECT_CERTIFICATE_CHECKER,
        repositoryPureAssertions: originalSubjectAssets && startupForgeSubstrate.dockerIdentity
          ? createRepositoryPureExecutionPolicy(originalSubjectAssets, startupForgeSubstrate.dockerIdentity) : null,
      } : {}),
      executionRevisions: REVISION_INVESTIGATION_POLICY,
      metabolicCheckpoints: METABOLIC_CHECKPOINT_POLICY,
      projectPolicy: projectPolicy.policyDescriptor,
      projectPolicyDigest: projectPolicy.descriptorDigest,
      assayFrontierDigest: assayFrontier.digest,
      assayFrontier,
      mcpWitnessDigest: witnesses.digest,
      connectionStartup: connections.descriptor,
      peerMindsDigest: peers.digest,
      peerMinds: peers.descriptor,
      mcpWitnesses: witnesses.descriptor,
      candidateIgnorePolicyDigest: candidateIgnore.policy.sourceDigest,
      candidateIgnorePolicy: candidateIgnore.descriptor,
      genomeSelectionDigest: genome.descriptorDigest,
      genomeSelection: genome.descriptor,
      presetSelectionDigest: preset.descriptorDigest,
      presetSelection: preset.descriptor,
      runtimeGrowthPolicyDigest: composedGrowth.growthPolicy.digest,
      runtimeGrowthPolicy: composedGrowth.growthPolicy,
      forgeSubstrateIdentity: startupForgeSubstrate.descriptor,
      forgePreflight,
      effectiveForgeConfig: embedderForge === undefined ? forgeConfigDescriptor(effectiveForgeConfig) : null,
      mindCapabilities: mindCapabilities
        .map((capability) => ({
          id: capability.id,
          version: capability.version,
          transport: capability.transport,
          trust: capability.trust,
          network: capability.network,
          canExecuteTools: capability.canExecuteTools,
          limits: capability.limits ?? null,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      ...(embedderForgeCapability === undefined
        ? {}
        : {
            embedderForgeAdapter: {
              id: embedderForgeCapability.id,
              version: embedderForgeCapability.version,
              trust: embedderForgeCapability.trust,
              network: embedderForgeCapability.network,
              canExecuteTools: embedderForgeCapability.canExecuteTools,
              limits: forgeAdapterLimitsDescriptor(embedderForgeCapability),
            },
          }),
      ...(forgeConfigOverride === undefined
        ? {}
        : {
            embedderForgeConfig: forgeConfigDescriptor(forgeConfigOverride),
          }),
    } as unknown as JsonValue;
    const provisionalRepository = new CaseRepository(
      dataDir,
      effectivePolicyDescriptor,
      projectPolicy.subjectSnapshotPolicy,
      {
        ...projectPolicy.repositorySealProfile,
        ...genome.repositorySealProfile,
        searchProfile: composedGrowth.searchProfile,
      },
    );
    const events = new FileEventHub(dataDir);
    const artifactByteCeiling = projectPolicy.searchProfile.resources.maxArtifactBytes;
    const artifactCountCeiling = projectPolicy.searchProfile.resources.maxWritableInodes;
    const forge = embedderForge ?? new SealedForgeAdapter({
      ...effectiveForgeConfig,
      ...(startupForgeSubstrate.dockerIdentity === undefined
        ? {}
        : { dockerSubstrateIdentity: startupForgeSubstrate.dockerIdentity }),
      artifactExporter: async (caseId, workspace, changedFiles, invocationLimits) => {
        const admittedResources = (caseOwners.get(caseId) ?? orchestrator).effectiveResourceEnvelope(caseId);
        const admittedArtifactByteCeiling = admittedResources?.maxArtifactBytes ?? artifactByteCeiling;
        const admittedArtifactCountCeiling = admittedResources?.maxWritableInodes ?? artifactCountCeiling;
        const refs: string[] = [];
        const existingArtifacts = await provisionalRepository.artifacts(caseId);
        // Bone evidence has its own constitutional envelope. Candidate output
        // quotas count candidate exports only, never persisted observations.
        const existingCandidateArtifacts = existingArtifacts.filter(
          (artifact) => !artifact.mediaType.startsWith("application/vnd.jevyr."),
        );
        const allExistingIds = new Set(existingArtifacts.map((artifact) => artifact.id));
        const existingIds = new Set(existingCandidateArtifacts.map((artifact) => artifact.id));
        let exportedBytes = existingCandidateArtifacts.reduce((sum, artifact) => sum + artifact.size, 0);
        let invocationExportedBytes = 0;
        const paths = [...new Set(changedFiles)].sort();
        for (const relativePath of paths) {
          if (existingIds.size >= admittedArtifactCountCeiling) break;
          const absolute = resolve(workspace, relativePath);
          try {
            const info = await stat(absolute);
            if (!info.isFile() || info.size > projectPolicy.policy.forge.limits.maxFileBytes) continue;
            const data = await readFile(absolute);
            const prospectiveId = `artifact_${sha256Digest(data).slice("sha256:".length, "sha256:".length + 24)}`;
            // One digest has one immutable metadata record. Do not relabel an
            // evidence object as candidate output when the bytes collide.
            if (allExistingIds.has(prospectiveId) && !existingIds.has(prospectiveId)) continue;
            const newBytes = existingIds.has(prospectiveId) ? 0 : data.byteLength;
            if (data.byteLength !== info.size
              || exportedBytes + newBytes > admittedArtifactByteCeiling
              || invocationExportedBytes + newBytes > invocationLimits.maxArtifactBytes) continue;
            const artifact = await provisionalRepository.putArtifact(caseId, relativePath, mimeType(relativePath), data);
            refs.push(artifact.id);
            existingIds.add(artifact.id);
            allExistingIds.add(artifact.id);
            exportedBytes += newBytes;
            invocationExportedBytes += newBytes;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        return refs;
      },
    });
    const repository = provisionalRepository;
    const orchestratorConfig: OrchestratorConfig = {
      ...(originalSubjectAssets ? { originalSubjectAssets } : {}),
      metabolicCalibrations,
      repository,
      events,
      minds,
      forge,
      witnesses: {
        adapters: witnesses.adapters,
        calls: witnesses.calls.map((call) => ({
          id: call.id,
          adapterId: call.serverId,
          tool: call.tool,
          args: call.args,
          timeoutMs: call.timeoutMs,
        })),
        descriptorDigest: witnesses.digest,
      },
      memory: temporalMemory,
      memoryProjectId: projectId,
      includeSelfMemory: env.JEVYR_INCLUDE_SELF_MEMORY === "1",
      candidateIgnorePolicy: candidateIgnore.policy,
      reflexLoops: projectPolicy.reflexLoops,
      assayFrontier,
      runtimeGrowthPolicy: composedGrowth.growthPolicy,
    };
    const orchestrator = new JevyrOrchestrator(orchestratorConfig);
    const clientOrchestrators = new Set<JevyrOrchestrator>();
    const caseOwners = new Map<string, JevyrOrchestrator>();
    const clientRunCompletions = new Set<Promise<void>>();
    const publicRepository = exposeRepository(repository);
    const publicEvents = exposeEvents(events);
    const publicOrchestrator = exposeOrchestrator(orchestrator, clientOrchestrators, caseOwners);
    const publicMemory = exposeMemory(temporalMemory);
    const readyPromise = orchestrator.recoverInterruptedCases().then(() => undefined);
    orchestrator.bindReadiness(readyPromise);
    let closePromise: Promise<void> | undefined;
    const availableCapabilities = Object.freeze([...minds, forge, ...witnesses.adapters].map(snapshotAdapterCapability));
    const airlockPlan = (raw: AirlockChoices = {}) => {
      const choices = validateAirlockChoices(raw);
      const chosen = choices.capabilityIds === undefined ? availableCapabilities.map(value => value.id) : choices.capabilityIds;
      if (chosen.some(id => !availableCapabilities.some(value => value.id === id))) throw new TypeError("Airlock cannot grant an unconfigured capability");
      const selectedMinds = minds.filter(mind => chosen.includes(snapshotAdapterCapability(mind).id));
      if (!selectedMinds.length) throw new TypeError("Select at least one configured investigator");
      const selectedWitnesses = witnesses.adapters.filter(adapter => chosen.includes(snapshotAdapterCapability(adapter).id));
      const observing = choices.sandbox === "observe_only" || !chosen.includes(snapshotAdapterCapability(forge).id);
      const selectedForge = observing ? new SealedForgeAdapter({ mode: "observe-only" }) : forge;
      const selectedGrowth = choices.preset === "wild"
        ? composeGenomeRuntime(projectPolicy.searchProfile, projectPolicy.policy.memory.maximumLateInfluence, genome.runtimeProfile)
        : composedGrowth;
      const maximum = selectedGrowth.searchProfile.resources;
      for (const [name, amount] of Object.entries(choices.resourceCeiling ?? {})) {
        if (!Object.hasOwn(maximum, name) || amount > maximum[name as keyof typeof maximum]) throw new TypeError(`Airlock cannot widen or invent resource ${name}`);
      }
      const searchProfile = { ...selectedGrowth.searchProfile, resources: { ...maximum, ...choices.resourceCeiling } };
      const searchEnvelope = createSearchEnvelope(searchProfile);
      const selectedFrontier = compileAssayFrontier(assayFrontier.assays, searchProfile.resources, selectedGrowth.archive);
      const narrowedPolicy = Object.keys(choices).length ? {
        ...effectivePolicyDescriptor as Record<string, JsonValue>,
        airlockChoices: choices, airlockChoicesDigest: digestJson(choices as JsonValue),
        assayFrontier: selectedFrontier, assayFrontierDigest: selectedFrontier.digest,
        metabolicAllowance: createMetabolicAllowance(searchEnvelope, metabolicAllowance.signer, metabolicCalibrations),
        runtimeGrowthPolicyDigest: selectedGrowth.growthPolicy.digest, runtimeGrowthPolicy: selectedGrowth.growthPolicy,
        presetSelection: choices.preset === "wild" ? { ...preset.descriptor as Record<string, JsonValue>, airlockOverride: "wild", effectiveRuntimeProfile: genome.runtimeProfile ?? null } : preset.descriptor,
        mindCapabilities: (effectivePolicyDescriptor as any).mindCapabilities.filter((card: { id: string }) => chosen.includes(card.id)),
        selectedWitnessIds: selectedWitnesses.map(adapter => snapshotAdapterCapability(adapter).id),
        ...(observing ? { forgeSubstrateIdentity: bindStartupForgeSubstrate({ mode: "observe-only" }, undefined).descriptor,
          effectiveForgeConfig: forgeConfigDescriptor({ mode: "observe-only" }), repositoryEvaluationObserver: null,
          ...(projectPolicy.policy.policyVersion === "bone-v2" ? { repositoryPureAssertions: null } : {}),
          embedderForgeAdapter: null, embedderForgeConfig: null } : {}),
      } : effectivePolicyDescriptor;
      if (Object.keys(choices).length) (narrowedPolicy as any).presetSelectionDigest = digestJson((narrowedPolicy as any).presetSelection);
      const selectedRepository = Object.keys(choices).length ? new CaseRepository(dataDir, narrowedPolicy, projectPolicy.subjectSnapshotPolicy,
        { ...projectPolicy.repositorySealProfile, ...genome.repositorySealProfile, searchProfile }) : repository;
      return { choices, selectedMinds, selectedWitnesses, selectedForge, selectedGrowth, selectedRepository, selectedFrontier, maximum };
    };
    const executeAirlock = async (submission: CaseSubmission, choices: AirlockChoices, expectedPolicyDigest: string, capturedSubjectCaseId?: string, reproductionMemoryGuard?: ReproductionMemoryGuard, metabolicReproductionPlan?: MetabolicReproductionPlan) => {
      await readyPromise;
      if (closePromise) throw new Error("The daemon is closing");
      const plan = airlockPlan(choices);
      if (expectedPolicyDigest !== plan.selectedRepository.policyDigest) throw new TypeError("Airlock execution policy changed; review before sealing");
      if (plan.selectedRepository === repository && !reproductionMemoryGuard) return await orchestrator.cast(submission, capturedSubjectCaseId);
      if (clientOrchestrators.size >= 8) throw new Error("Concurrent scoped Case limit reached");
      const executionRepository = plan.selectedRepository === repository ? new CaseRepository(dataDir, effectivePolicyDescriptor, projectPolicy.subjectSnapshotPolicy,
        { ...projectPolicy.repositorySealProfile, ...genome.repositorySealProfile, searchProfile: plan.selectedGrowth.searchProfile }) : plan.selectedRepository;
      if (executionRepository.policyDigest !== expectedPolicyDigest) throw new TypeError("Controlled rerun repository changed the selected execution policy");
      const scoped = new JevyrOrchestrator({ ...orchestratorConfig, repository: executionRepository, minds: plan.selectedMinds,
        ...(reproductionMemoryGuard ? { reproductionMemoryGuard } : {}),
        ...(metabolicReproductionPlan ? { metabolicReproductionPlan } : {}),
        forge: plan.selectedForge, runtimeGrowthPolicy: plan.selectedGrowth.growthPolicy, assayFrontier: plan.selectedFrontier,
        witnesses: { ...orchestratorConfig.witnesses!, adapters: plan.selectedWitnesses,
          calls: orchestratorConfig.witnesses!.calls.filter(call => plan.selectedWitnesses.some(adapter => snapshotAdapterCapability(adapter).id === call.adapterId)) } });
      scoped.bindReadiness(readyPromise); clientOrchestrators.add(scoped);
      try {
        const created = await scoped.cast(submission, capturedSubjectCaseId); caseOwners.set(created.caseId, scoped);
        const completion = scoped.drain().finally(() => { caseOwners.delete(created.caseId); clientOrchestrators.delete(scoped); clientRunCompletions.delete(completion); });
        clientRunCompletions.add(completion); void completion.catch(() => undefined);
        return created;
      } catch (error) { clientOrchestrators.delete(scoped); throw error; }
    };
    let selfJudge: ReturnType<typeof createRuntimeSelfJudge> | undefined;
    const runtimeFacade: DaemonRuntime = {
      repository: publicRepository,
      events: publicEvents,
      orchestrator: publicOrchestrator,
      minds,
      forge,
      memory: publicMemory,
      projectId,
      projectRoot,
      witnesses,
      connections,
      genome,
      preset,
      growthPolicy: composedGrowth.growthPolicy,
      assayFrontier,
      previewAirlock(choices = {}) {
        const plan = airlockPlan(choices), selected = plan.selectedRepository;
        return { policyDigest: selected.policyDigest, genomeDigest: selected.genomeDigest, genomeVersion: selected.genomeVersion,
          searchEnvelope: selected.searchEnvelope, policy: selected.policyDescriptor,
          capabilities: [...plan.selectedMinds, plan.selectedForge, ...plan.selectedWitnesses].map(snapshotAdapterCapability),
          availableCapabilities, resourceMaximum: plan.maximum };
      },
      castAirlock: executeAirlock,
      async reproduceCase(sourceCaseId, seed) {
        await readyPromise;
        if (seed !== "same" && seed !== "new") throw new TypeError("Reproduction requires same or new seed");
        const original = await repository.reproductionSubmission(sourceCaseId);
        const source = (await repository.status(sourceCaseId))!;
        const policy = await repository.descriptor(source.sealed.policyDigest);
        const choices = validateAirlockChoices((policy?.descriptor as any)?.policy?.airlockChoices ?? {});
        const plan = airlockPlan(choices).selectedRepository;
        if (plan.policyDigest !== source.sealed.policyDigest || plan.genomeDigest !== source.sealed.genomeDigest || plan.searchEnvelope.digest !== source.sealed.searchEnvelope.digest)
          throw new TypeError("The source Case's exact policy, Genome, providers and search configuration are unavailable in this runtime");
        const [sourceEnvelope, sourceTerminal, trust] = await Promise.all([repository.recordEnvelope(sourceCaseId), repository.terminalReceipt(sourceCaseId), repository.publicTrustBundle()]);
        if (!sourceEnvelope || !sourceTerminal) throw new TypeError("Controlled reruns require an authenticated source Record and terminal closure");
        const memoryGuard = createReproductionMemoryGuard(sourceEnvelope, new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem])));
        if (memoryGuard.sourceRunDigest !== source.sealed.runDigest || memoryGuard.sourceCaseDigest !== source.sealed.caseDigest || memoryGuard.sourceRecordDigest !== sourceTerminal.recordDigest)
          throw new TypeError("Controlled rerun memory source changed or differs from its authenticated terminal Record");
        let metabolicPlan: MetabolicReproductionPlan | undefined;
        if (source.sealed.intent.control === "juggler") {
          const sourceArtifacts = await repository.artifacts(sourceCaseId);
          metabolicPlan = await createMetabolicReproductionPlan(sourceEnvelope, policy!.descriptor, await events.read(sourceCaseId), async digest => {
            const meta = sourceArtifacts.find(artifact => artifact.digest === digest);
            return meta ? (await repository.artifact(sourceCaseId, meta.id))?.data : undefined;
          }, new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem])), seed);
        }
        const submission = { ...original, case: { ...original.case, seed: seed === "same" ? source.sealed.intent.seed : randomBytes(32).toString("hex") } };
        return await executeAirlock(submission, choices, source.sealed.policyDigest, sourceCaseId, memoryGuard, metabolicPlan);
      },
      async ready(): Promise<void> {
        await readyPromise;
      },
      async runWithClientModel(intent, context): Promise<unknown> {
        await readyPromise;
        if (closePromise) throw new Error("The daemon is closing");
        if (clientOrchestrators.size >= 8) throw new Error("The daemon client-model run limit is reached");
        context.signal.throwIfAborted();
        assertCaseSubmission({ protocol: "jevyr.case/1", case: intent });
        // A loopback MCP transport says nothing about where its client's model runs.
        // Never silently upgrade the ordinary local_only default to disclosure.
        if (intent.privacy !== "provider_scoped" && intent.privacy !== "full_case") {
          throw new TypeError("Client-model runs require explicit provider_scoped or full_case privacy; local_only cannot attest the client's model location");
        }
        for (const value of [context.client.name, context.client.version]) {
          if (typeof value !== "string" || value.length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
            throw new TypeError("MCP client metadata must be bounded single-line text");
          }
        }
        if (!["2025-06-18", "2025-11-25"].includes(context.client.protocolVersion)) {
          throw new TypeError("Client-model compatibility requires MCP 2025-06-18 or 2025-11-25");
        }
        const binding = Object.freeze({
          protocol: "jevyr.mcp-sampling-binding/1" as const,
          bindingId: sha256Digest(randomUUID()),
          source: "originating-mcp-client" as const,
          clientName: context.client.name,
          clientVersion: context.client.version,
          mcpProtocolVersion: context.client.protocolVersion,
        });
        const adapter = new McpSamplingMindAdapter({ binding, sample: context.sample });
        const capability = snapshotAdapterCapability(adapter);
        // A new immutable policy per run; the startup policy and default Minds never change.
        // This repository shares the daemon-owned lease, CAS, signer and read surfaces.
        const scopedRepository = new CaseRepository(dataDir, {
          ...effectivePolicyDescriptor as Record<string, JsonValue>,
          mcpClientSampling: binding,
          mindCapabilities: [{
            id: capability.id, version: capability.version, transport: capability.transport,
            trust: capability.trust, network: capability.network, canExecuteTools: false,
            limits: capability.limits ?? {},
          }],
        }, projectPolicy.subjectSnapshotPolicy, {
          ...projectPolicy.repositorySealProfile,
          ...genome.repositorySealProfile,
          searchProfile: composedGrowth.searchProfile,
        });
        const clientReportedModels = new Set<string>();
        const receiptArtifacts: { id: string; digest: string }[] = [];
        let activeCaseId: string | undefined;
        let releaseCase!: () => void;
        const caseReady = new Promise<void>((resolveReady) => { releaseCase = resolveReady; });
        const trackedMind: MindAdapter = {
          capability: adapter.capability,
          probe: async (signal) => await adapter.probe(signal),
          run: (request) => adapter.run(request),
          runMetered: async (request) => {
            await caseReady;
            request.signal.throwIfAborted();
            const answer = await adapter.runMetered(request);
            const receipt = answer.samplingReceipt;
            if (!receipt || !activeCaseId) return answer;
            request.signal.throwIfAborted();
            const bytes = Buffer.from(JSON.stringify(receipt));
            const artifact = await scopedRepository.putArtifact(activeCaseId,
              `mcp-sampling-receipt-${sha256Digest(bytes).slice(7, 31)}.json`,
              "application/vnd.jevyr.mcp-sampling-receipt+json", bytes);
            receiptArtifacts.push({ id: artifact.id, digest: artifact.digest });
            clientReportedModels.add(receipt.clientReportedModel);
            return {
              ...answer,
              contributions: [...answer.contributions, {
                id: `sampling_${artifact.digest.slice(7, 31)}`,
                kind: "observation" as const,
                summary: `MCP client reported model ${receipt.clientReportedModel}; model identity is client-reported provenance, not evidence authority.`,
                evidenceRefs: [artifact.digest],
                tags: ["client-model-provenance"],
              }],
            };
          },
        };
        const scoped = new JevyrOrchestrator({ ...orchestratorConfig, repository: scopedRepository, minds: [trackedMind] });
        scoped.bindReadiness(readyPromise);
        clientOrchestrators.add(scoped);
        let finishRun!: () => void;
        const runClosed = new Promise<void>((resolveClosed) => { finishRun = resolveClosed; });
        clientRunCompletions.add(runClosed);
        const abort = (): void => scoped.abortAll();
        context.signal.addEventListener("abort", abort, { once: true });
        try {
          context.signal.throwIfAborted();
          const created = await scoped.cast({ protocol: "jevyr.case/1", case: intent });
          activeCaseId = created.caseId;
          caseOwners.set(created.caseId, scoped);
          releaseCase();
          if (context.signal.aborted || closePromise) abort();
          context.onSealed?.(created.receipt);
          await scoped.drain();
          const status = await scopedRepository.status(created.caseId);
          const terminal = await scopedRepository.terminalReceipt(created.caseId);
          if (!status || !terminal) throw new Error("Client-model run ended without an authenticated terminal closure");
          return {
            caseId: created.caseId, receipt: created.receipt, status: { ...toLiveCaseStatus(status), updatedAt: terminal.closedAt },
            record: await scopedRepository.record(created.caseId),
            recordEnvelope: await scopedRepository.recordEnvelope(created.caseId),
            terminal, terminalEnvelope: await scopedRepository.terminalEnvelope(created.caseId),
            sampling: { source: "originating-mcp-client", clientReportedModels: [...clientReportedModels], receiptArtifacts },
          };
        } finally {
          releaseCase();
          abort();
          await scoped.drain();
          context.signal.removeEventListener("abort", abort);
          clientOrchestrators.delete(scoped);
          if (activeCaseId) caseOwners.delete(activeCaseId);
          clientRunCompletions.delete(runClosed);
          finishRun();
        }
      },
      async status(caseId: string): Promise<LiveCaseStatus | undefined> {
        await readyPromise;
        const stored = await repository.status(caseId);
        if (!stored) return undefined;
        if (stored.lifecycle === "terminated" || stored.lifecycle === "invalid") {
          const terminal = await repository.terminalReceipt(caseId);
          if (terminal !== undefined) {
            return {
              protocol: "jevyr.status/1",
              caseDigest: terminal.caseDigest,
              runDigest: terminal.runDigest,
              lifecycle: terminal.lifecycle,
              stage: terminal.stage,
              stageStatus: terminal.stageStatus,
              lastSequence: terminal.lastSequence,
              headDigest: terminal.eventHeadDigest,
              updatedAt: terminal.closedAt,
            };
          }
        }
        // Sequence, head, and tail event must come from one stable ledger
        // snapshot. A separate lastSequence()/list() pair can straddle an
        // append and hand observers sequence N with the digest of N+1.
        let page = await events.list(caseId, Number.MAX_SAFE_INTEGER, 1);
        let lastSequence = page.latestSequence;
        let latest: (typeof page.events)[number] | undefined;
        while (lastSequence > 0) {
          page = await events.list(caseId, lastSequence - 1, 1);
          latest = page.events[0];
          if (
            page.latestSequence === lastSequence
            && latest?.sequence === lastSequence
            && latest.eventDigest === page.headDigest
          ) break;
          lastSequence = page.latestSequence;
        }
        if (latest && (
          latest.caseDigest !== stored.sealed.caseDigest
          || latest.runDigest !== stored.sealed.runDigest
        )) {
          throw new Error("Live event tail does not belong to the sealed Case and run");
        }
        const base = toLiveCaseStatus(stored);
        return {
          ...base,
          lastSequence,
          headDigest: page.headDigest,
          ...(latest === undefined ? {} : { stage: latest.stage, updatedAt: latest.observedAt }),
          ...(latest?.kind === "stage.status" ? { stageStatus: latest.payload.status } : {}),
        };
      },
      async close(): Promise<void> {
        if (closePromise) return await closePromise;
        closePromise = (async () => {
          await selfJudge?.stop();
          orchestrator.abortAll();
          for (const scoped of clientOrchestrators) scoped.abortAll();
          await readyPromise.catch(() => undefined);
          await orchestrator.drain();
          await Promise.allSettled([...clientOrchestrators].map(async (scoped) => await scoped.drain()));
          await Promise.allSettled([...clientRunCompletions]);
          try {
            temporalMemory.close();
          } finally {
            lease.release();
          }
        })();
        return await closePromise;
      },
    };
    selfJudge = createRuntimeSelfJudge(runtimeFacade, env);
    void readyPromise.then(() => selfJudge?.start()).catch(() => undefined);
    return runtimeFacade;
  } catch (error) {
    try {
      memory?.close();
    } finally {
      lease.release();
    }
    throw error;
  }
}
