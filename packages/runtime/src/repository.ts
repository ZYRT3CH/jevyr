import { access, link, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  canonicalize,
  assertRunAttestations,
  deriveRunStatements,
  IN_TOTO_DSSE_PAYLOAD_TYPE,
  RUN_ATTESTATIONS_PROTOCOL,
  assertMetabolicReceipt,
  assertMetabolicGrant,
  assertMetabolicAllowance,
  METABOLISM_DSSE_PAYLOAD_TYPE,
  digestJson,
  createSearchEnvelope,
  isSha256Digest,
  LIFECYCLE_STAGES,
  searchEnvelopeDescriptor,
  sha256Digest,
  validateCaseSubmission,
  validateSealReceipt,
  validateSealedCase,
  validateSignedRecord,
  validateTerminalReceipt,
  type CaseEvent,
  type CaseSubmission as ProtocolCaseSubmission,
  type DsseEnvelope,
  type JsonValue,
  type IntentContract,
  type LifecycleStage,
  type LiveCaseStatus,
  type PublicTrustBundle,
  type SealedSearchProfile,
  type SearchEnvelope,
  type SealReceipt as ProtocolSealReceipt,
  type SignedRecord,
  type TerminalReceipt,
  type MetabolicReceipt,
  type MetabolicRedemption,
  type RunAttestations,
} from "@jevyr/protocol";
import {
  crystallizeRecord,
  decodeDsseJson,
  generateSigningKeyPair,
  formalProofReplayOptions,
  originalSubjectKernelDigestFromPolicyDescriptor,
  ORIGINAL_SUBJECT_POLICY_VERSION,
  keyIdFor,
  RECORD_DSSE_PAYLOAD_TYPE,
  projectEvents,
  replayCase,
  SEAL_DSSE_PAYLOAD_TYPE,
  sealCase,
  sealReceipt,
  signJevyrRecord,
  signDsse,
  signSealReceipt,
  signTerminalReceipt,
  TERMINAL_DSSE_PAYLOAD_TYPE,
  verifyDsse,
  verifyEventChain,
  parseJsonBytes,
  type VerifiedEvidenceEdge,
  type ReplayProjectionOptions,
} from "@jevyr/core";
import { randomToken } from "./canonical.js";
import type { SealedCaseContext, CapabilityCard } from "./contracts.js";
import { createSubjectContext, type SubjectContext } from "./subject-context.js";
import { planRepositoryEvaluation, REPOSITORY_EVALUATION_LIMITS, type RepositoryEvaluationPlan } from "./repository-evaluation-plan.js";
import { repositoryEvaluationObserverPolicyFromDescriptor, observerPlannerRunner } from "./repository-evaluation-observer.js";
import { decodeToolObservation, TOOL_OBSERVATION_MEDIA_TYPE } from "./evidence-artifacts.js";
import { verifyAssayFrontier, type AssayFrontier } from "./assay-frontier.js";
import { verifyPersistedAssayEvidence } from "./evidence-replay.js";
import type { OriginalSubjectCertificateContext } from "./original-subject-certificate.js";
import { FileEventHub } from "./events.js";
import { assertRecordCommitAuthority, type RecordCommitAuthority } from "./record-authority.js";
import {
  normalizeSubjectSnapshotPolicy,
  type NormalizedSubjectSnapshotPolicy,
  type SubjectSnapshotPolicy,
} from "./subjects.js";
import {
  SUBJECT_MATERIAL_CAPTURE_PROTOCOL,
  captureSubjectMaterials,
  capturedSubjectMaterialReader,
  materializeSubjectMaterials as materializeCapturedSubjectMaterials,
  projectSubjectText as projectCapturedSubjectText,
  verifySubjectMaterialBinding,
  type SubjectMaterialBinding,
  type SubjectMaterialCaptureResult,
  type SubjectMaterializationResult,
  type SubjectTextProjection,
  type SubjectTextProjectionOptions,
} from "./subject-materials.js";

export type CastSubmission = ProtocolCaseSubmission;
export type SealReceipt = ProtocolSealReceipt;

/** Durable runtime metadata. HTTP status is projected to exact LiveCaseStatus. */
export interface CaseStatus {
  readonly protocol: "jevyr.runtime-status/1";
  readonly caseId: string;
  readonly lifecycle: LiveCaseStatus["lifecycle"];
  readonly stage: LifecycleStage;
  readonly stageStatus: LiveCaseStatus["stageStatus"];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSequence: number;
  readonly headDigest: string | null;
  readonly sealed: SealedCaseContext;
  readonly receipt: SealReceipt;
  readonly error?: string;
}

export interface ArtifactMeta {
  readonly protocol: "jevyr.artifact/1";
  readonly id: string;
  readonly caseId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: string;
  readonly createdAt: string;
}

export type RecoveryRecordCode = "RUNTIME_RESTART_INTERRUPTED_CASE" | "RUNTIME_FAILURE";

interface VerifiedRecordPair {
  readonly record: SignedRecord;
  readonly envelope: DsseEnvelope;
  readonly source: "record" | "recovery-record";
}

interface VerifiedTerminalPair {
  readonly receipt: TerminalReceipt;
  readonly envelope: DsseEnvelope;
}

const ARTIFACT_MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:;\s*charset=[a-z0-9._-]+)?$/i;

export interface DescriptorArtifact {
  readonly protocol: "jevyr.descriptor-artifact/1";
  readonly kind: "policy" | "genome" | "search";
  readonly digest: string;
  /** Canonical JSON value whose digest is exactly `digest`. */
  readonly descriptor: JsonValue;
}

export const CASE_SUBJECT_MATERIAL_BINDING_PROTOCOL = "jevyr.case-subject-material-binding/1" as const;

/** Private per-Case pointer set. It contains digests and no original locator. */
export interface CaseSubjectMaterialBindingEnvelope {
  readonly protocol: typeof CASE_SUBJECT_MATERIAL_BINDING_PROTOCOL;
  readonly caseId: string;
  readonly caseDigest: string;
  readonly runDigest: string;
  readonly captureDigest: string;
  readonly bindings: readonly SubjectMaterialBinding[];
}

const TERMINAL_LIFECYCLES = new Set<CaseStatus["lifecycle"]>(["terminated", "invalid"]);
const STATUS_VALUES = new Set<CaseStatus["stageStatus"]>(["entered", "working", "completed", "failed", "skipped"]);

export interface RepositorySealProfile {
  /** Runtime-owned explicit policy upgrade; historical repositories default to v1. */
  readonly policyVersion?: "jevyr.bone/1" | typeof ORIGINAL_SUBJECT_POLICY_VERSION;
  readonly genomeVersion?: string;
  /** A factual strategy/configuration descriptor, not a claim of learned capabilities. */
  readonly genomeDescriptor?: JsonValue;
  readonly searchProfile?: SealedSearchProfile;
}

export const DEFAULT_SEARCH_PROFILE: SealedSearchProfile = Object.freeze({
  attemptSafetyCeiling: "1500000000000000000000",
  nursery: Object.freeze({
    minimumAttempts: 6,
    saturationWindow: 4,
    independentLineages: 4,
    challengeInterval: 3,
  }),
  resources: Object.freeze({
    maxMindInvocations: 12,
    maxInputTokens: 262_144,
    maxOutputTokens: 131_072,
    maxWallMillis: 900_000,
    maxSingleInvocationMillis: 120_000,
    maxGeneratedBytes: 50_000_000,
    maxForgeCpuMillis: 120_000,
    maxForgeWallMillis: 180_000,
    maxMemorySeconds: 30,
    maxWritableBytes: 100_000_000,
    maxWritableInodes: 10_000,
    maxArtifactBytes: 20_000_000,
    maxNetworkBytes: 0,
    concurrentLineages: 4,
    maxTotalAssayCost: 1_000,
  }),
  seedDerivation: "sha256-case-seed-frontier-v2",
});

/**
 * This descriptor identifies only the built-in, immutable baseline contract.
 * It deliberately does not pretend that Jevyr has a learned or evolved genome.
 */
export const DEFAULT_GENOME_DESCRIPTOR: JsonValue = Object.freeze({
  protocol: "jevyr.genome-descriptor/1",
  version: "jevyr.genome/1",
  status: "baseline-static",
  provenance: "built-in-runtime-contract",
  mutationDuringSealedRun: "forbidden",
  capabilityClaim: "none",
});

export function validateCastSubmission(value: unknown): CastSubmission {
  const validation = validateCaseSubmission(value);
  if (!validation.ok || validation.value === undefined) {
    const detail = validation.problems.map((problem) => `${problem.path}: ${problem.message}`).join("; ");
    throw new TypeError(`Invalid Jevyr case submission: ${detail}`);
  }
  if ((validation.value.case.subjects?.length ?? 0) > 32) {
    throw new TypeError("case.subjects must contain at most 32 references");
  }
  return structuredClone(validation.value);
}

const localFileOperationTails = new Map<string, Promise<void>>();
const caseCommitTails = new Map<string, Promise<void>>();

/**
 * Node's Windows file handles can deny replacement while a reader is open.
 * Coordinate every in-process JSON read with atomic publication, including
 * across separate CaseRepository instances that share the same data root.
 */
async function withLocalFileOperation<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const absolute = resolve(path);
  const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  const previous = localFileOperationTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(async () => await gate);
  localFileOperationTails.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (localFileOperationTails.get(key) === tail) localFileOperationTails.delete(key);
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await withLocalFileOperation(path, async () => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomToken(6)}.tmp`;
    let temporaryCreated = false;
    let published = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      temporaryCreated = true;
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (let attempt = 0; ; attempt += 1) {
        try {
          await rename(temporary, path);
          published = true;
          break;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          const retryableWindowsReplacement = process.platform === "win32"
            && ["EACCES", "EBUSY", "EEXIST", "EPERM"].includes(code ?? "")
            && attempt < 19;
          if (!retryableWindowsReplacement) throw error;
          // External readers and on-access scanners are outside the local
          // operation queue and can still hold the old inode briefly.
          await delay(Math.min(100, 5 * (attempt + 1)));
        }
      }
    } finally {
      if (temporaryCreated && !published) {
        await unlink(temporary).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
    }
  });
}

async function writeJsonCreateOnce(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomToken(6)}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // A same-directory hard link atomically publishes the fully synced inode
    // and fails with EEXIST instead of replacing an existing commitment.
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
  }
}

export function toLiveCaseStatus(status: CaseStatus): LiveCaseStatus {
  return {
    protocol: "jevyr.status/1",
    caseDigest: status.sealed.caseDigest,
    runDigest: status.sealed.runDigest,
    lifecycle: status.lifecycle,
    stage: status.stage,
    stageStatus: status.stageStatus,
    lastSequence: status.lastSequence,
    headDigest: status.headDigest,
    updatedAt: status.updatedAt,
  };
}

export class CaseRepository {
  readonly policyDigest: string;
  readonly policyVersion: "jevyr.bone/1" | typeof ORIGINAL_SUBJECT_POLICY_VERSION;
  readonly genomeVersion: string;
  readonly genomeDigest: string;
  readonly searchEnvelope: SearchEnvelope;
  readonly subjectSnapshotPolicy: NormalizedSubjectSnapshotPolicy;
  readonly policyDescriptor: JsonValue;
  readonly genomeDescriptor: JsonValue;
  private readonly subjectMaterialStoreRoot: string;
  private keysPromise?: Promise<{ privatePem: string; publicPem: string; keyId: string }>;
  private metabolicKeysPromise?: Promise<{ privatePem: string; publicPem: string; keyId: string }>;
  private descriptorsPromise?: Promise<void>;
  private lastSealedAtMs = 0;
  private signingAssayFrontier?: AssayFrontier;

  constructor(
    readonly dataDir: string,
    policyDescriptor: unknown = { kernel: "jevyr.deterministic-policy/1", reflexLoops: 1, maxReflexLoops: 2 },
    subjectSnapshotPolicy: SubjectSnapshotPolicy = {},
    sealProfile: RepositorySealProfile = {},
  ) {
    this.subjectMaterialStoreRoot = join(this.dataDir, "subject-materials");
    this.policyVersion = sealProfile.policyVersion ?? "jevyr.bone/1";
    if (this.policyVersion !== "jevyr.bone/1" && this.policyVersion !== ORIGINAL_SUBJECT_POLICY_VERSION) throw new TypeError("Unsupported runtime Bone policy version");
    this.subjectSnapshotPolicy = normalizeSubjectSnapshotPolicy(subjectSnapshotPolicy);
    this.policyDescriptor = structuredClone({
      protocol: "jevyr.policy-descriptor/1",
      version: this.policyVersion,
      policy: policyDescriptor as JsonValue,
      subjectSnapshots: this.subjectSnapshotPolicy as unknown as JsonValue,
    } as JsonValue);
    if (this.policyVersion === ORIGINAL_SUBJECT_POLICY_VERSION && !originalSubjectKernelDigestFromPolicyDescriptor(this.policyDescriptor)) {
      throw new TypeError("Bone v2 requires the exact runtime-owned original-subject kernel and Genome startup selection");
    }
    this.genomeVersion = sealProfile.genomeVersion?.trim() || "jevyr.genome/1";
    if (this.genomeVersion !== "jevyr.genome/1" && sealProfile.genomeDescriptor === undefined) {
      throw new TypeError("A non-baseline genomeVersion requires its concrete genomeDescriptor; the repository will not fabricate one");
    }
    this.genomeDescriptor = structuredClone(sealProfile.genomeDescriptor ?? DEFAULT_GENOME_DESCRIPTOR);
    this.searchEnvelope = createSearchEnvelope(sealProfile.searchProfile ?? DEFAULT_SEARCH_PROFILE);
    this.policyDigest = digestJson(this.policyDescriptor);
    this.genomeDigest = digestJson(this.genomeDescriptor);
  }

  private caseDir(caseId: string): string {
    if (!/^(?:case|jvr)_[a-zA-Z0-9_-]{8,128}$/u.test(caseId)) throw new TypeError("Invalid Jevyr case identifier");
    return join(this.dataDir, "cases", caseId);
  }

  /** A separate key with no Seal, Record, or terminal authority. Bind before Cast. */
  static async metabolicSignerDescriptor(dataDir: string): Promise<{ keyId: string; publicKeyPem: string }> {
    const keys = await loadSigningPair(dataDir, "jevyr-metabolic-ed25519");
    return { keyId: keys.keyId, publicKeyPem: keys.publicPem };
  }

  /** Synchronous startup twin for the daemon's startup-bound policy constructor. */
  static metabolicSignerDescriptorSync(dataDir: string): { keyId: string; publicKeyPem: string } {
    const directory = join(dataDir, "keys");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const privatePath = join(directory, "jevyr-metabolic-ed25519-private.pem");
    const publicPath = join(directory, "jevyr-metabolic-ed25519-public.pem");
    const read = (path: string): string | undefined => {
      try { return readFileSync(path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    };
    let privatePem = read(privatePath);
    const existingPublic = read(publicPath);
    if (privatePem === undefined && existingPublic !== undefined) throw new Error("Metabolic public identity has no private counterpart");
    if (privatePem === undefined) {
      try { writeFileSync(privatePath, generateSigningKeyPair().privateKeyPem, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      privatePem = readFileSync(privatePath, "utf8");
    }
    const derived = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "pem" }).toString();
    if (existingPublic === undefined) {
      try { writeFileSync(publicPath, derived, { encoding: "utf8", mode: 0o644, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    const keys = checkedSigningPair(privatePem, readFileSync(publicPath, "utf8"));
    return { keyId: keys.keyId, publicKeyPem: keys.publicPem };
  }

  /** Only Bone may commit an exact additive grant; no arbitrary payload signing. */
  async writeMetabolicReceipt(caseId: string, input: MetabolicReceipt, authority: RecordCommitAuthority): Promise<MetabolicRedemption> {
    assertRecordCommitAuthority(this, authority);
    const receipt = structuredClone(input);
    assertMetabolicReceipt(receipt);
    return await withLocalFileOperation(join(this.caseDir(caseId), "metabolic-commit"), async () => {
      const status = await this.status(caseId);
      if (!status || status.sealed.intent.control !== "juggler" || ["terminated", "invalid"].includes(status.lifecycle)
        || ["sign", "memory_tribunal", "terminate"].includes(status.stage)) throw new Error("Metabolic admission is closed");
      const allowance = exactPolicyBody(this.policyDescriptor).metabolicAllowance;
      assertMetabolicAllowance(allowance);
      if (receipt.caseId !== caseId || receipt.caseDigest !== status.sealed.caseDigest
        || receipt.runDigest !== status.sealed.runDigest || receipt.policyDigest !== status.sealed.policyDigest
        || receipt.searchDigest !== status.sealed.searchEnvelope.digest) throw new Error("Metabolic receipt crosses the sealed Case boundary");
      const keys = await (this.metabolicKeysPromise ??= loadSigningPair(this.dataDir, "jevyr-metabolic-ed25519"));
      if (allowance.signer.keyId !== keys.keyId || allowance.signer.publicKeyPem !== keys.publicPem) throw new Error("Metabolic signer differs from the sealed allowance");
      const directory = join(this.caseDir(caseId), "metabolism");
      const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const published = names.filter((name) => /^\d{4}\.json$/u.test(name)).sort();
      if (published.length !== receipt.sequence - 1) throw new Error("Metabolic sequence has already committed or has a gap");
      let previous: MetabolicReceipt | undefined;
      // Replay the persisted chain before signing. A missing, tampered, or foreign
      // grant cannot silently become the predecessor of an authentic addition.
      for (let index = 0; index < published.length; index += 1) {
        if (published[index] !== `${String(index + 1).padStart(4, "0")}.json`) throw new Error("Metabolic sequence gap");
        const entry = parseJsonBytes(await readFile(join(directory, published[index]!)), "Metabolic receipt") as unknown as MetabolicRedemption;
        if (entry.protocol !== "jevyr.metabolism-redemption/1") throw new Error("Invalid persisted metabolic wrapper");
        assertDsseEnvelope(entry.envelope, METABOLISM_DSSE_PAYLOAD_TYPE, "Metabolic DSSE");
        if (!verifyDsse(entry.envelope, new Map([[keys.keyId, keys.publicPem]])) || entry.envelope.signatures[0]?.keyid !== keys.keyId
          || !canonicalEqual(decodeDsseJson(entry.envelope), entry.receipt)) throw new Error("Invalid persisted metabolic signature");
        assertMetabolicGrant(entry.receipt, allowance, previous);
        previous = entry.receipt;
      }
      assertMetabolicGrant(receipt, allowance, previous);
      const envelope = signDsse(METABOLISM_DSSE_PAYLOAD_TYPE, canonicalize(receipt as unknown as JsonValue), keys.privatePem, keys.keyId);
      const redemption: MetabolicRedemption = { protocol: "jevyr.metabolism-redemption/1", receipt, envelope };
      await writeJsonCreateOnce(join(directory, `${String(receipt.sequence).padStart(4, "0")}.json`), redemption);
      return redemption;
    });
  }

  /** Reuse original bytes only after authenticating their source Seal. */
  async reproductionSubmission(caseId: string): Promise<CastSubmission> {
    const status = await this.status(caseId);
    if (!status || !["terminated", "invalid"].includes(status.lifecycle)) throw new TypeError("Only a closed Case can be reproduced");
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    const envelope = await this.sealEnvelope(caseId);
    if (!envelope || envelope.payloadType !== SEAL_DSSE_PAYLOAD_TYPE || !verifyDsse(envelope, new Map([[keys.keyId, keys.publicPem]]))
      || !canonicalEqual(decodeDsseJson(envelope), status.receipt)) throw new Error("Reproduction source Seal is not authentic");
    const submission = validateCastSubmission(await this.readJson(join(this.caseDir(caseId), "submission.json")));
    if (digestJson(submission as unknown as JsonValue) !== status.receipt.submissionDigest) throw new Error("Reproduction source submission changed");
    await this.readAndVerifySubjectMaterialCapture(status);
    return structuredClone({ ...submission, case: { ...submission.case, seed: status.sealed.intent.seed } });
  }

  async create(submissionValue: unknown, capturedSubjectCaseId?: string): Promise<CaseStatus> {
    const submission = validateCastSubmission(submissionValue);
    await (this.descriptorsPromise ??= this.ensureProvenanceDescriptors());
    this.lastSealedAtMs = Math.max(Date.now(), this.lastSealedAtMs + 1);
    const now = new Date(this.lastSealedAtMs).toISOString();
    const reused = capturedSubjectCaseId === undefined ? undefined : await this.reproductionSubmission(capturedSubjectCaseId);
    if (reused && !canonicalEqual(reused.case.subjects ?? [], submission.case.subjects ?? [])) throw new TypeError("Reproduction cannot substitute captured subject references");
    const materialCapture = capturedSubjectCaseId === undefined ? await captureSubjectMaterials(
      this.subjectMaterialStoreRoot,
      submission.case.subjects ?? [],
      now,
      this.subjectSnapshotPolicy,
      {
        resolveArtifact: async (caseId, artifactId) => {
          const artifact = await this.artifact(caseId, artifactId);
          return artifact === undefined ? undefined : { ...artifact.meta, data: artifact.data };
        },
      },
    ) : await this.loadSubjectMaterialCapture(capturedSubjectCaseId);
    const canonicalSeal = sealCase(submission, {
      policyVersion: this.policyVersion,
      policyDigest: this.policyDigest,
      genomeVersion: this.genomeVersion,
      genomeDigest: this.genomeDigest,
      searchEnvelope: this.searchEnvelope,
      sealedAt: now,
      subjectMaterialCaptureDigest: materialCapture.captureDigest,
      subjectSnapshots: materialCapture.snapshots,
    });
    const sealed: SealedCaseContext = canonicalSeal;
    const repositoryEvaluationPlan = await this.deriveRepositoryEvaluationPlan(materialCapture, canonicalSeal.intentContract);
    const receipt = sealReceipt(canonicalSeal);
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    const envelope = signSealReceipt(receipt, keys.privatePem, keys.keyId);
    const status: CaseStatus = {
      protocol: "jevyr.runtime-status/1",
      caseId: sealed.caseId,
      lifecycle: "queued",
      stage: "seal",
      stageStatus: "completed",
      createdAt: now,
      updatedAt: now,
      lastSequence: 0,
      headDigest: null,
      sealed,
      receipt,
    };
    const materialEnvelope: CaseSubjectMaterialBindingEnvelope = {
      protocol: CASE_SUBJECT_MATERIAL_BINDING_PROTOCOL,
      caseId: sealed.caseId,
      caseDigest: sealed.caseDigest,
      runDigest: sealed.runDigest,
      captureDigest: materialCapture.captureDigest,
      bindings: materialCapture.bindings,
    };
    const directory = this.caseDir(sealed.caseId);
    await mkdir(join(this.dataDir, "cases"), { recursive: true });
    await mkdir(directory, { recursive: false });
    await writeJsonAtomic(join(directory, "submission.json"), submission);
    await writeJsonAtomic(join(directory, "sealed.json"), canonicalSeal);
    await writeJsonAtomic(join(directory, "seal.json"), receipt);
    await writeJsonAtomic(join(directory, "seal.dsse.json"), envelope);
    // status.json is the scheduling boundary. The immutable binding must be
    // durable first so no runnable Case can exist without its captured input.
    await writeJsonAtomic(join(directory, "subject-materials.json"), materialEnvelope);
    if (repositoryEvaluationPlan) await writeJsonAtomic(join(directory, "repository-evaluation-plan.json"), repositoryEvaluationPlan);
    await writeJsonAtomic(join(directory, "status.json"), status);
    return structuredClone(status);
  }

  async status(caseId: string): Promise<CaseStatus | undefined> {
    const status = await this.readJson<CaseStatus>(join(this.caseDir(caseId), "status.json"));
    if (status) this.assertStoredStatus(caseId, status);
    return status === undefined ? undefined : structuredClone(status);
  }

  /**
   * Discovers durable cases in a stable order. A malformed status is fatal: the
   * daemon must not start while an interrupted case has an ambiguous identity.
   */
  async statuses(): Promise<readonly CaseStatus[]> {
    const directory = join(this.dataDir, "cases");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const statuses: CaseStatus[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !/^(?:case|jvr)_[a-zA-Z0-9_-]{8,128}$/u.test(entry.name)) continue;
      const status = await this.readJson<CaseStatus>(join(directory, entry.name, "status.json"));
      if (!status) throw new Error(`Stored case ${entry.name} has no status.json`);
      this.assertStoredStatus(entry.name, status);
      await this.readAndVerifySubjectMaterialCapture(status);
      statuses.push(structuredClone(status));
    }
    return statuses;
  }

  async nonterminalStatuses(): Promise<readonly CaseStatus[]> {
    const discovered = await this.statuses();
    const selected: CaseStatus[] = [];
    for (const status of discovered) {
      if (!TERMINAL_LIFECYCLES.has(status.lifecycle)) {
        selected.push(status);
        continue;
      }
      // A crash between the durable INVALID transition and the create-once
      // recovery pair must be retryable on startup. A completed invalid Case
      // with a verified recovery Record remains terminal.
      if (status.lifecycle === "invalid") {
        let pair: VerifiedRecordPair | undefined;
        try {
          pair = await this.preferredRecordPair(status.caseId);
        } catch {
          // Corrupt terminal material is incomplete recovery, never success.
        }
        if (pair === undefined) selected.push(status);
      }
    }
    return selected;
  }

  async receipt(caseId: string): Promise<SealReceipt | undefined> {
    return await this.readJson<SealReceipt>(join(this.caseDir(caseId), "seal.json"));
  }

  /**
   * Returns the exact contract needed to replay Bone. Its content digest is
   * already bound by the signed SealReceipt and crystallized Record; mutable
   * submission or subject locators are never exposed through this surface.
   */
  async intentContract(caseId: string): Promise<IntentContract | undefined> {
    const status = await this.status(caseId);
    return status === undefined
      ? undefined
      : structuredClone(status.sealed.intentContract);
  }

  async sealEnvelope(caseId: string): Promise<DsseEnvelope | undefined> {
    return await this.readJson<DsseEnvelope>(join(this.caseDir(caseId), "seal.dsse.json"));
  }

  /**
   * Reloads the per-Case binding, checks it against the signed Seal identity,
   * then rehashes every manifest and referenced blob. Missing legacy bindings
   * are an explicit downgrade and fail closed.
   */
  async loadSubjectMaterialCapture(caseId: string): Promise<SubjectMaterialCaptureResult> {
    const status = await this.status(caseId);
    if (!status) throw new Error(`Unknown case ${caseId}`);
    return await this.readAndVerifySubjectMaterialCapture(status);
  }

  /** Initial bounded text view for minds; original locators never enter it. */
  async projectSubjectText(
    caseId: string,
    options: SubjectTextProjectionOptions = {},
  ): Promise<SubjectTextProjection> {
    const capture = await this.loadSubjectMaterialCapture(caseId);
    return await projectCapturedSubjectText(this.subjectMaterialStoreRoot, capture.bindings, options);
  }

  /** Reads only this Case's captured material and honors the sealed provider disclosure boundary. */
  async subjectContext(caseId: string, providerNetwork: CapabilityCard["network"]): Promise<SubjectContext | undefined> {
    const status = await this.status(caseId);
    if (!status) throw new Error(`Unknown case ${caseId}`);
    const privacy = status.sealed.intent.privacy;
    if ((providerNetwork === "provider" || providerNetwork === "unrestricted") && privacy !== "full_case") return undefined;
    const capture = await this.loadSubjectMaterialCapture(caseId);
    const context = await createSubjectContext({ captureDigest: capture.captureDigest, bindings: capture.bindings, privacy, providerNetwork, reader: capturedSubjectMaterialReader(this.subjectMaterialStoreRoot) });
    const plan = await this.repositoryEvaluationPlan(caseId);
    return context && plan ? Object.freeze({ ...context, repositoryEvaluationPlan: plan }) : context;
  }

  private async deriveRepositoryEvaluationPlan(capture: Pick<SubjectMaterialCaptureResult, "captureDigest" | "bindings">, contract: IntentContract): Promise<RepositoryEvaluationPlan | undefined> {
    if (!capture.bindings.some(binding => ["directory", "git"].includes(binding.subjectKind)) || capture.bindings.length > REPOSITORY_EVALUATION_LIMITS.maxSubjects) return undefined;
    // The fixed observer can run a supported suite for investigation context.
    // Its presence never makes the repository's own assertions a verdict oracle.
    const observer = repositoryEvaluationObserverPolicyFromDescriptor(this.policyDescriptor);
    return await planRepositoryEvaluation({ captureDigest: capture.captureDigest, bindings: capture.bindings,
      contract, reader: capturedSubjectMaterialReader(this.subjectMaterialStoreRoot),
      ...(observer ? { runner: observerPlannerRunner(observer) } : {}) });
  }

  /** Re-derive discovery from the original capture; a stored plan is not authority. */
  async repositoryEvaluationPlan(caseId: string): Promise<RepositoryEvaluationPlan | undefined> {
    const stored = await this.readJson<RepositoryEvaluationPlan>(join(this.caseDir(caseId), "repository-evaluation-plan.json"));
    if (!stored) return undefined;
    const status = await this.status(caseId);
    if (!status) throw new Error(`Unknown case ${caseId}`);
    const capture = await this.loadSubjectMaterialCapture(caseId);
    const expected = await this.deriveRepositoryEvaluationPlan(capture, status.sealed.intentContract);
    if (!expected || !canonicalEqual(stored, expected)) throw new Error("Stored repository discovery differs from its sealed source and contract");
    return expected;
  }

  /** Bone-only inputs for the fixed diagnostic observer. Never exposed by the daemon facade. */
  async repositoryEvaluationInputs(caseId: string) {
    const plan = await this.repositoryEvaluationPlan(caseId);
    if (!plan) return undefined;
    const capture = await this.loadSubjectMaterialCapture(caseId);
    return Object.freeze({ plan, bindings: capture.bindings, reader: capturedSubjectMaterialReader(this.subjectMaterialStoreRoot) });
  }

  /** Bone-only captured inputs, independent of optional diagnostic discovery. */
  async originalSubjectEvaluationInputs(caseId: string) {
    const capture = await this.loadSubjectMaterialCapture(caseId);
    return Object.freeze({ bindings: capture.bindings, reader: capturedSubjectMaterialReader(this.subjectMaterialStoreRoot) });
  }

  /** The verifier receives the full authenticated Seal and locally trusted keys. */
  async originalSubjectEvidenceContext(caseId: string): Promise<OriginalSubjectCertificateContext> {
    const status = await this.status(caseId);
    if (!status) throw new Error(`Unknown case ${caseId}`);
    await this.assertAuthenticatedSeal(status);
    const sealEnvelope = await this.sealEnvelope(caseId);
    if (!sealEnvelope) throw new Error("The original-subject verifier requires the signed Seal envelope");
    return { sealedCase: status.sealed, sealEnvelope, trustedCaseKeys: new Map((await this.publicTrustBundle()).keys.map(key => [key.keyId, key.publicKeyPem])) };
  }

  /** Reconstructs only verified captured bytes into a fresh Forge input root. */
  async materializeSubjectMaterials(
    caseId: string,
    destination: string,
  ): Promise<SubjectMaterializationResult> {
    const capture = await this.loadSubjectMaterialCapture(caseId);
    return await materializeCapturedSubjectMaterials(this.subjectMaterialStoreRoot, capture.bindings, destination);
  }

  async updateStatus(
    caseId: string,
    patch: {
      lifecycle: CaseStatus["lifecycle"];
      stage: LifecycleStage;
      stageStatus: CaseStatus["stageStatus"];
      lastSequence: number;
      headDigest: string | null;
      error?: string;
    },
  ): Promise<CaseStatus> {
    return await this.withRecordCommit(caseId, async () => await this.commitStatusUpdate(caseId, patch));
  }

  private async commitStatusUpdate(
    caseId: string,
    patch: {
      lifecycle: CaseStatus["lifecycle"];
      stage: LifecycleStage;
      stageStatus: CaseStatus["stageStatus"];
      lastSequence: number;
      headDigest: string | null;
      error?: string;
    },
  ): Promise<CaseStatus> {
    const directory = this.caseDir(caseId);
    const [hasTerminalReceipt, hasTerminalEnvelope] = await Promise.all([
      fileExists(join(directory, "terminal.json")),
      fileExists(join(directory, "terminal.dsse.json")),
    ]);
    if (hasTerminalReceipt || hasTerminalEnvelope) {
      throw new Error(`Status is closed for terminal case ${caseId}`);
    }
    const current = await this.status(caseId);
    if (!current) throw new Error(`Unknown case ${caseId}`);
    const next: CaseStatus = {
      ...current,
      lifecycle: patch.lifecycle,
      stage: patch.stage,
      stageStatus: patch.stageStatus,
      updatedAt: new Date().toISOString(),
      lastSequence: patch.lastSequence,
      headDigest: patch.headDigest,
      ...(patch.error === undefined ? {} : { error: patch.error }),
    };
    await writeJsonAtomic(join(directory, "status.json"), next);
    return structuredClone(next);
  }

  /** Internal signer input: the content must match the digest already bound by policy. */
  bindRecordAssayFrontier(frontier: AssayFrontier): void {
    const verified = verifyAssayFrontier(frontier, this.searchEnvelope.profile.resources);
    const policy = exactPolicyBody(this.policyDescriptor);
    const boundDigest = policy.assayFrontierDigest;
    // An intentionally unbound/mismatched runtime remains operable but gains
    // no signing-time assay authority. The run path will perform no Forge work.
    if (typeof boundDigest !== "string" || !isSha256Digest(boundDigest) || verified.digest !== boundDigest) return;
    if (this.signingAssayFrontier !== undefined && !canonicalEqual(this.signingAssayFrontier, verified)) {
      throw new Error("Record Assay Frontier is already bound and cannot be replaced");
    }
    this.signingAssayFrontier = verified;
  }

  async writeRecord(caseId: string, record: SignedRecord, authority: RecordCommitAuthority): Promise<DsseEnvelope> {
    assertRecordCommitAuthority(this, authority);
    return await this.withRecordCommit(caseId, async () => await this.commitDerivedRecord(caseId, record));
  }

  /**
   * Persists a recovery Record without destroying a partial or invalid Record
   * pair left by a crash. Readers use this explicitly named pair only when no
   * valid normal Record exists.
   */
  async writeRecoveryRecord(caseId: string, code: RecoveryRecordCode): Promise<DsseEnvelope> {
    return await this.withRecordCommit(caseId, async () => await this.commitRecoveryRecord(caseId, code));
  }

  async record(caseId: string): Promise<SignedRecord | undefined> {
    const preferred = await this.preferredRecordPair(caseId);
    return preferred === undefined ? undefined : structuredClone(preferred.record);
  }

  async recordEnvelope(caseId: string): Promise<DsseEnvelope | undefined> {
    const preferred = await this.preferredRecordPair(caseId);
    return preferred === undefined ? undefined : structuredClone(preferred.envelope);
  }

  /**
   * Bone's write-once commitment to the complete public ledger, final status,
   * selected Record, and artifact inventory. The authority token prevents
   * public repository consumers from signing an invented close.
   */
  async writeTerminalReceipt(caseId: string, authority: RecordCommitAuthority): Promise<DsseEnvelope> {
    assertRecordCommitAuthority(this, authority);
    return await this.withRecordCommit(caseId, async () => await this.commitTerminalReceipt(caseId));
  }

  /** Recover the exact already-attested closure after a crash before its
   * terminal pair/cache became durable. Never append to or replace that root. */
  async restoreAttestedTerminal(caseId: string, authority: RecordCommitAuthority): Promise<"terminated" | "invalid" | undefined> {
    assertRecordCommitAuthority(this, authority);
    return await this.withRecordCommit(caseId, async () => {
      const raw = await this.readJson<unknown>(join(this.caseDir(caseId), "run-attestations.json"));
      if (raw === undefined) return undefined;
      assertRunAttestations(raw);
      const status = await this.status(caseId), preferred = await this.preferredRecordPair(caseId);
      const events = await new FileEventHub(this.dataDir).read(caseId), tail = events.at(-1);
      const advisory = decodeCanonicalDsseJson<{ predicate?: { lifecycle?: unknown } }>(raw.advisory, "Recovery advisory statement");
      const lifecycle = advisory.predicate?.lifecycle;
      if (!status || !preferred || !["terminated", "invalid"].includes(String(lifecycle)) || tail?.kind !== "stage.status"
        || tail.stage !== "terminate" || !["completed", "failed"].includes(tail.payload.status)) throw new Error("Attested recovery has no complete terminal ledger or authenticated Record");
      const restored: CaseStatus = { ...status, lifecycle: lifecycle as "terminated" | "invalid", stage: tail.stage,
        stageStatus: tail.payload.status, lastSequence: tail.sequence, headDigest: tail.eventDigest, updatedAt: tail.observedAt };
      const receipt = await this.deriveTerminalReceipt(restored);
      // Includes signature, fixed predicate, complete inventory, ledger, and
      // exact original terminal-receipt digest. No cache write precedes this.
      await this.#verifyRunAttestations(raw, restored, preferred.record, receipt);
      await this.commitStatusUpdate(caseId, { lifecycle: restored.lifecycle, stage: restored.stage, stageStatus: restored.stageStatus,
        lastSequence: restored.lastSequence, headDigest: restored.headDigest });
      await this.commitTerminalReceipt(caseId);
      return restored.lifecycle as "terminated" | "invalid";
    });
  }

  async terminalReceipt(caseId: string): Promise<TerminalReceipt | undefined> {
    const pair = await this.verifiedTerminalPair(caseId);
    return pair === undefined ? undefined : structuredClone(pair.receipt);
  }

  async terminalEnvelope(caseId: string): Promise<DsseEnvelope | undefined> {
    const pair = await this.verifiedTerminalPair(caseId);
    return pair === undefined ? undefined : structuredClone(pair.envelope);
  }

  /** Read-only fixed production/advisory sidecars; never mint missing historical evidence. */
  async runAttestations(caseId: string): Promise<RunAttestations | undefined> {
    const terminal = await this.verifiedTerminalPair(caseId);
    if (!terminal) return undefined;
    const status = await this.status(caseId), preferred = await this.preferredRecordPair(caseId);
    if (!status || !preferred) throw new Error("Run attestations require an authenticated closed Case");
    const raw = await this.readJson<unknown>(join(this.caseDir(caseId), "run-attestations.json"));
    if (raw === undefined) {
      const policy = await this.descriptor(status.receipt.policyDigest);
      if ((policy?.descriptor as {policy?:{runAttestations?:unknown}} | undefined)?.policy?.runAttestations === RUN_ATTESTATIONS_PROTOCOL) throw new Error("Required run attestation sidecars are missing");
      return undefined;
    }
    return await this.#verifyRunAttestations(raw, status, preferred.record, terminal.receipt);
  }

  private async withRecordCommit<T>(caseId: string, work: () => Promise<T>): Promise<T> {
    this.caseDir(caseId);
    const absolute = resolve(this.dataDir, "cases", caseId);
    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
    const previous = caseCommitTails.get(key) ?? Promise.resolve();
    let result: T | undefined;
    const operation = previous.catch(() => undefined).then(async () => {
      result = await work();
    });
    const tail = operation.then(() => undefined, () => undefined);
    caseCommitTails.set(key, tail);
    try {
      await operation;
      return result as T;
    } finally {
      if (caseCommitTails.get(key) === tail) caseCommitTails.delete(key);
    }
  }

  private async assertAuthenticatedSeal(status: CaseStatus): Promise<void> {
    const directory = this.caseDir(status.caseId);
    const [sealedValue, receiptValue, envelopeValue] = await Promise.all([
      this.readJson<unknown>(join(directory, "sealed.json")),
      this.readJson<unknown>(join(directory, "seal.json")),
      this.readJson<unknown>(join(directory, "seal.dsse.json")),
    ]);
    const sealed = validateSealedCase(sealedValue);
    const receipt = validateSealReceipt(receiptValue);
    if (!sealed.ok || sealed.value === undefined) {
      throw new Error(`Stored case ${status.caseId} has no valid immutable Seal`);
    }
    if (!receipt.ok || receipt.value === undefined) {
      throw new Error(`Stored case ${status.caseId} has no valid immutable Seal receipt`);
    }
    if (!canonicalEqual(sealed.value, status.sealed) || !canonicalEqual(receipt.value, status.receipt)) {
      throw new Error(`Stored case ${status.caseId} status does not equal its immutable Seal material`);
    }
    if (!canonicalEqual(sealReceipt(sealed.value), receipt.value)) {
      throw new Error(`Stored case ${status.caseId} Seal receipt does not derive from its immutable Seal`);
    }
    assertDsseEnvelope(envelopeValue, SEAL_DSSE_PAYLOAD_TYPE, `Stored case ${status.caseId} Seal envelope`);
    const signedReceipt = decodeCanonicalDsseJson<unknown>(envelopeValue, `Stored case ${status.caseId} Seal envelope`);
    if (!canonicalEqual(signedReceipt, receipt.value)) {
      throw new Error(`Stored case ${status.caseId} signed Seal payload does not equal its receipt`);
    }
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    if (!verifyDsse(envelopeValue, new Map([[keys.keyId, keys.publicPem]]))) {
      throw new Error(`Stored case ${status.caseId} Seal signature does not verify against the repository identity`);
    }
  }

  private async commitDerivedRecord(caseId: string, proposed: SignedRecord): Promise<DsseEnvelope> {
    const status = await this.status(caseId);
    if (!status) throw new Error(`Unknown case ${caseId}`);
    await this.assertAuthenticatedSeal(status);
    assertValidRecord(proposed, "Proposed Record");
    this.assertRecordIdentity(status, proposed);

    const existing = await this.verifiedRecordPair(caseId, "record", status);
    if (existing !== undefined) {
      if (!canonicalEqual(existing.record, proposed)) {
        throw new Error("The normal Record is write-once and cannot be superseded");
      }
      return structuredClone(existing.envelope);
    }
    if (await this.recordPairHasAnyFile(caseId, "recovery-record")) {
      throw new Error("A recovery Record already exists; normal crystallization cannot supersede it");
    }
    if (
      status.lifecycle !== "crystallized"
      || status.stage !== "sign"
      || status.stageStatus !== "working"
      || status.error !== undefined
    ) {
      throw new Error("A normal Record may be signed only at the active, non-failed SIGN boundary");
    }
    await this.readAndVerifySubjectMaterialCapture(status);
    await this.assertActiveProvenanceDescriptors(status);

    const events = await new FileEventHub(this.dataDir).read(caseId);
    const verification = verifyEventChain(events);
    if (!verification.valid || verification.headDigest === null) {
      throw new Error("A normal Record requires a complete verified event chain");
    }
    if (
      status.lastSequence !== events.length
      || status.headDigest !== verification.headDigest
      || events.at(-1)?.caseDigest !== status.sealed.caseDigest
      || events.at(-1)?.runDigest !== status.sealed.runDigest
    ) {
      throw new Error("The SIGN status cursor does not authenticate the exact current event head");
    }

    const anchor = events.findIndex((event) => event.eventDigest === proposed.eventHeadDigest);
    if (anchor < 0) throw new Error("The proposed Record head is absent from the verified ledger");
    this.assertCrystallizationTail(events, anchor, proposed);
    const prefix = events.slice(0, anchor + 1);
    const observationArtifacts = await this.verifyObservationArtifacts(caseId, prefix);
    const verifiedEvidence = await this.verifyTypedAssayEvidence(status, prefix, observationArtifacts);
    const replay = replayCase(prefix, {
      ...formalProofReplayOptions(this.policyDescriptor),
      policyVersion: status.sealed.policyVersion,
      intentContract: status.sealed.intentContract,
      ...verifiedEvidence,
    });
    if (!replay.crystallizable || replay.eventHeadDigest !== proposed.eventHeadDigest) {
      throw new Error("The exact proposed event prefix is not crystallizable");
    }
    const derived = crystallizeRecord({
      sealed: status.sealed,
      eventHeadDigest: replay.eventHeadDigest,
      verdict: replay.verdict,
      reflexReports: replay.reflexReports,
      memoryInfluences: replay.memoryInfluences,
      crystallizedAt: proposed.crystallizedAt,
    });
    if (!canonicalEqual(derived, proposed)) {
      throw new Error("The proposed Record is not the deterministic projection of its authenticated event prefix");
    }

    // Reopen the durable ledger and Seal after the potentially expensive CAS
    // replay. Signing is refused if either boundary moved in the meantime.
    const [latestStatus, latestEvents] = await Promise.all([
      this.status(caseId),
      new FileEventHub(this.dataDir).read(caseId),
    ]);
    if (!latestStatus) throw new Error(`Case ${caseId} disappeared before signing`);
    await this.assertAuthenticatedSeal(latestStatus);
    if (
      latestStatus.lifecycle !== "crystallized"
      || latestStatus.stage !== "sign"
      || latestStatus.stageStatus !== "working"
      || latestStatus.error !== undefined
      || latestStatus.lastSequence !== latestEvents.length
      || latestStatus.headDigest !== latestEvents.at(-1)?.eventDigest
      || digestJson(this.policyDescriptor) !== latestStatus.sealed.policyDigest
      || !sameEventDigests(events, latestEvents)
    ) {
      throw new Error("The authenticated signing boundary changed during just-in-time validation");
    }
    const latestObservations = await this.verifyObservationArtifacts(caseId, prefix);
    const latestVerifiedEdges = await this.verifyTypedAssayEvidence(latestStatus, prefix, latestObservations);
    if (!canonicalEqual(latestVerifiedEdges, verifiedEvidence)) {
      throw new Error("The verified evidence authority changed during just-in-time validation");
    }

    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    const envelope = signJevyrRecord(proposed, keys.privatePem, keys.keyId);
    return await this.writeRecordPairOnce(caseId, "record", proposed, envelope, latestStatus);
  }

  private async assertActiveProvenanceDescriptors(status: CaseStatus): Promise<void> {
    const [policy, genome, search] = await Promise.all([
      this.descriptor(status.sealed.policyDigest),
      this.descriptor(status.sealed.genomeDigest),
      this.descriptor(status.sealed.searchEnvelope.digest),
    ]);
    if (
      policy?.kind !== "policy"
      || genome?.kind !== "genome"
      || search?.kind !== "search"
      || !canonicalEqual(policy.descriptor, this.policyDescriptor)
      || !canonicalEqual(genome.descriptor, this.genomeDescriptor)
      || !canonicalEqual(search.descriptor, searchEnvelopeDescriptor(status.sealed.searchEnvelope))
    ) {
      throw new Error("The active policy, genome, or search descriptor does not equal the provenance bound by the Seal");
    }
  }

  private assertCrystallizationTail(events: readonly CaseEvent[], anchor: number, proposed: SignedRecord): void {
    const marker = events[anchor + 1];
    const crystallizeCompleted = events[anchor + 2];
    const signEntered = events[anchor + 3];
    if (events.length !== anchor + 4) {
      throw new Error("The Record head is not followed by the exact crystallize-to-SIGN transition");
    }
    if (
      marker?.kind !== "kernel.status"
      || marker.stage !== "crystallize"
      || marker.actor.id !== "jevyr.bone"
      || marker.actor.kind !== "kernel"
      || marker.payload.operation !== "record_crystallized"
      || marker.payload.artifactDigest !== digestJson(proposed as unknown as JsonValue)
    ) {
      throw new Error("The verified ledger has no Bone crystallization commitment for the proposed Record");
    }
    if (
      crystallizeCompleted?.kind !== "stage.status"
      || crystallizeCompleted.stage !== "crystallize"
      || crystallizeCompleted.actor.id !== "jevyr.bone"
      || crystallizeCompleted.actor.kind !== "kernel"
      || crystallizeCompleted.payload.stage !== "crystallize"
      || crystallizeCompleted.payload.status !== "completed"
    ) {
      throw new Error("The verified ledger does not close CRYSTALLIZE after its Record commitment");
    }
    if (
      signEntered?.kind !== "stage.status"
      || signEntered.stage !== "sign"
      || signEntered.actor.id !== "jevyr.bone"
      || signEntered.actor.kind !== "kernel"
      || signEntered.payload.stage !== "sign"
      || signEntered.payload.status !== "entered"
    ) {
      throw new Error("The verified ledger does not enter SIGN immediately after crystallization");
    }
  }

  private async verifyObservationArtifacts(
    caseId: string,
    events: readonly CaseEvent[],
  ): Promise<ReadonlyMap<string, Uint8Array>> {
    const evidenceEvents = events.filter((event): event is CaseEvent<"evidence.observed"> =>
      event.kind === "evidence.observed"
      && (event.payload.evidenceType === "sandbox_execution"
        || (event.payload.evidenceType === "tool_observation"
          && event.stage === "assay"
          && event.payload.candidateId !== undefined
          && event.payload.assayId !== undefined)));
    if (evidenceEvents.length === 0) return new Map();
    const indexed = new Map(
      (await this.artifacts(caseId))
        .filter((artifact) => artifact.mediaType === TOOL_OBSERVATION_MEDIA_TYPE)
        .map((artifact) => [artifact.digest, artifact] as const),
    );
    const resolved = new Map<string, Uint8Array>();
    for (const event of evidenceEvents) {
      const metadata = indexed.get(event.payload.contentDigest);
      if (!metadata) {
        throw new Error(`Evidence ${event.payload.evidenceId} has no persisted ToolObservation CAS object`);
      }
      let artifact;
      try {
        artifact = await this.artifact(caseId, metadata.id);
      } catch (error) {
        throw new Error(`Evidence ${event.payload.evidenceId} failed ToolObservation CAS verification`, { cause: error });
      }
      if (!artifact || artifact.meta.digest !== event.payload.contentDigest) {
        throw new Error(`Evidence ${event.payload.evidenceId} resolved to a different ToolObservation digest`);
      }
      decodeToolObservation(artifact.data);
      resolved.set(event.payload.contentDigest, artifact.data);
    }
    return resolved;
  }

  private async verifyTypedAssayEvidence(
    status: CaseStatus,
    events: readonly CaseEvent[],
    observations: ReadonlyMap<string, Uint8Array>,
  ): Promise<Pick<ReplayProjectionOptions, "verifiedEvidenceEdges" | "verifiedOriginalSubjectEdges" | "originalSubjectContext">> {
    const assayEvidenceCount = events.filter((event) =>
      event.kind === "evidence.observed"
      && (event.payload.evidenceType === "sandbox_execution"
        || (event.payload.evidenceType === "tool_observation"
          && event.stage === "assay"
          && event.payload.candidateId !== undefined
          && event.payload.assayId !== undefined))).length;
    const originalActivity = events.some(event => event.kind === "evidence.observed" && event.payload.evidenceType === "original_subject_assertions"
      || event.kind === "action.status" && event.payload.actionType === "repository-pure.evaluate");
    if (assayEvidenceCount === 0 && !originalActivity && status.sealed.policyVersion !== ORIGINAL_SUBJECT_POLICY_VERSION) return { verifiedEvidenceEdges: Object.freeze([]), verifiedOriginalSubjectEdges: Object.freeze([]) };
    if (digestJson(this.policyDescriptor) !== status.sealed.policyDigest) {
      throw new Error("Sandbox authority is unavailable because the exact local policy descriptor is not the signed policy");
    }
    const policy = exactPolicyBody(this.policyDescriptor);
    const frontierDigest = policy.assayFrontierDigest;
    const descriptorFrontier = policy.assayFrontier;
    const frontier = this.signingAssayFrontier
      ?? (recordObject(descriptorFrontier) ? descriptorFrontier as unknown as AssayFrontier : undefined);
    if (frontier === undefined || typeof frontierDigest !== "string" || !isSha256Digest(frontierDigest)) {
      throw new Error("Sandbox authority is unavailable because the sealed policy has no replayable Assay Frontier");
    }
    if (frontier.digest !== frontierDigest) {
      throw new Error("The replayable Assay Frontier does not match its sealed policy digest");
    }
    const artifactIndex = new Map(
      (await this.artifacts(status.caseId)).map((artifact) => [artifact.digest, artifact] as const),
    );
    const report = await verifyPersistedAssayEvidence(
      events,
      status.sealed.intentContract,
      frontier,
      this.policyDescriptor,
      async (digest) => {
        const observation = observations.get(digest);
        if (observation !== undefined) return observation;
        const metadata = artifactIndex.get(digest);
        if (metadata === undefined) return undefined;
        return (await this.artifact(status.caseId, metadata.id))?.data;
      },
      { trustedRecordKeys: new Map((await this.publicTrustBundle()).keys.map(key => [key.keyId, key.publicKeyPem])), originalSubject: await this.originalSubjectEvidenceContext(status.caseId) },
    );
    if (!report.replayComplete || report.eventHeadDigest !== events.at(-1)?.eventDigest) {
      throw new Error(
        `Persisted sandbox evidence failed just-in-time replay: ${report.problems.map((entry) => entry.code).join(", ")}`,
      );
    }
    return { verifiedEvidenceEdges: report.verifiedAuthorityEdges, verifiedOriginalSubjectEdges: report.verifiedOriginalSubjectEdges,
      ...(report.originalSubjectContext ? { originalSubjectContext: report.originalSubjectContext } : {}) };
  }

  private async commitRecoveryRecord(caseId: string, code: RecoveryRecordCode): Promise<DsseEnvelope> {
    const status = await this.status(caseId);
    if (!status) throw new Error(`Unknown case ${caseId}`);
    await this.assertAuthenticatedSeal(status);
    if (status.lifecycle !== "invalid" || status.stageStatus !== "failed" || !status.error) {
      throw new Error("A recovery Record is permitted only after the Case is durably invalid and failed");
    }
    await this.readAndVerifySubjectMaterialCapture(status);
    let normal: VerifiedRecordPair | undefined;
    try {
      normal = await this.verifiedRecordPair(caseId, "record", status);
    } catch {
      // Invalid normal material is preserved as forensic state. It has no
      // authority and does not prevent a separately named recovery pair.
    }
    if (normal !== undefined) {
      throw new Error("A valid normal Record exists and cannot be superseded by recovery");
    }

    // A transient ledger read failure must not be converted into a permanent
    // synthetic Record head. Without a readable chain Bone cannot honestly
    // commit a recovery Record that can later participate in signed closure.
    const events = await new FileEventHub(this.dataDir).read(caseId);
    const verification = verifyEventChain(events);
    if (!verification.valid) {
      throw new Error(`A recovery Record requires a valid event ledger: ${verification.problems.map((entry) => entry.code).join(", ")}`);
    }
    const projection = projectEvents(events, {
      ...formalProofReplayOptions(this.policyDescriptor),
      policyVersion: status.sealed.policyVersion,
      intentContract: status.sealed.intentContract,
    });
    const eventHeadDigest = verification.valid && verification.headDigest !== null
      ? verification.headDigest
      : digestJson({
          protocol: "jevyr.recovery-unavailable-ledger-prefix/1",
          caseDigest: status.sealed.caseDigest,
          runDigest: status.sealed.runDigest,
          reason: status.error,
        });
    const existingRecovery = await this.verifiedRecordPair(caseId, "recovery-record", status);
    const crystallizedAt = existingRecovery?.record.crystallizedAt
      ?? await this.recoveryFragmentTimestamp(caseId)
      ?? new Date().toISOString();
    const finding = Object.freeze({ code, summary: status.error, evidenceIds: Object.freeze([]) });
    const record: SignedRecord = {
      protocol: "jevyr.record/1",
      caseDigest: status.sealed.caseDigest,
      runDigest: status.sealed.runDigest,
      policyDigest: status.sealed.policyDigest,
      genomeDigest: status.sealed.genomeDigest,
      searchDigest: status.sealed.searchEnvelope.digest,
      intentContractDigest: status.sealed.intentContractDigest,
      eventHeadDigest,
      verdict: {
        policyVersion: status.sealed.policyVersion,
        intentContractDigest: status.sealed.intentContractDigest,
        evidenceDigest: projection.graph.digest(),
        integrity: "INVALID",
        creation: "FAILED",
        embodiment: "FAILED",
        judgment: "NOT_APPLICABLE",
        feasibilityByCandidate: {},
        basis: [finding],
      },
      reflex: {
        loop: 1,
        reviewedEvidenceDigest: projection.graph.digest(),
        intentContractDigest: status.sealed.intentContractDigest,
        challengedNodeIds: [],
        materialFindings: [finding],
        decision: "revise",
      },
      memoryInfluences: [],
      crystallizedAt,
    };
    assertValidRecord(record, "Derived recovery Record");
    if (existingRecovery !== undefined) {
      if (!canonicalEqual(existingRecovery.record, record)) {
        throw new Error("The recovery Record is write-once and does not match the current fixed recovery projection");
      }
      return structuredClone(existingRecovery.envelope);
    }
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    const envelope = signJevyrRecord(record, keys.privatePem, keys.keyId);
    return await this.writeRecordPairOnce(caseId, "recovery-record", record, envelope, status);
  }

  private async recoveryFragmentTimestamp(caseId: string): Promise<string | undefined> {
    const directory = this.caseDir(caseId);
    const record = await this.readJson<unknown>(join(directory, "recovery-record.json"));
    if (recordObject(record) && typeof record.crystallizedAt === "string" && !Number.isNaN(Date.parse(record.crystallizedAt))) {
      return record.crystallizedAt;
    }
    const envelope = await this.readJson<unknown>(join(directory, "recovery-record.dsse.json"));
    try {
      assertDsseEnvelope(envelope, RECORD_DSSE_PAYLOAD_TYPE, "Recovery Record envelope fragment");
      const payload = decodeCanonicalDsseJson<unknown>(envelope, "Recovery Record envelope fragment");
      if (recordObject(payload) && typeof payload.crystallizedAt === "string" && !Number.isNaN(Date.parse(payload.crystallizedAt))) {
        return payload.crystallizedAt;
      }
    } catch {
      // The create-once writer below will preserve and reject an invalid fragment.
    }
    return undefined;
  }

  private async preferredRecordPair(caseId: string): Promise<VerifiedRecordPair | undefined> {
    const status = await this.status(caseId);
    if (!status) return undefined;
    await this.assertAuthenticatedSeal(status);
    for (const base of ["record", "recovery-record"] as const) {
      try {
        const pair = await this.verifiedRecordPair(caseId, base, status);
        if (pair !== undefined) return pair;
      } catch {
        // A malformed/invalid normal fragment is forensic state, not authority;
        // an independently valid recovery pair may still be returned.
      }
    }
    return undefined;
  }

  private async verifiedRecordPair(
    caseId: string,
    base: "record" | "recovery-record",
    status: CaseStatus,
  ): Promise<VerifiedRecordPair | undefined> {
    const directory = this.caseDir(caseId);
    const recordPath = join(directory, `${base}.json`);
    const envelopePath = join(directory, `${base}.dsse.json`);
    const [hasRecord, hasEnvelope] = await Promise.all([fileExists(recordPath), fileExists(envelopePath)]);
    if (!hasRecord || !hasEnvelope) return undefined;
    const [record, envelope] = await Promise.all([
      this.readJson<unknown>(recordPath),
      this.readJson<unknown>(envelopePath),
    ]);
    assertValidRecord(record, `Stored ${base} Record`);
    this.assertRecordIdentity(status, record);
    if (base === "recovery-record") this.assertRecoveryRecordShape(status, record);
    assertDsseEnvelope(envelope, RECORD_DSSE_PAYLOAD_TYPE, `Stored ${base} Record envelope`);
    const signed = decodeCanonicalDsseJson<unknown>(envelope, `Stored ${base} Record envelope`);
    if (!canonicalEqual(signed, record)) throw new Error(`Stored ${base} Record does not equal its signed payload`);
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    if (!verifyDsse(envelope, new Map([[keys.keyId, keys.publicPem]]))) {
      throw new Error(`Stored ${base} Record signature does not verify against the repository identity`);
    }
    return { record: structuredClone(record), envelope: structuredClone(envelope), source: base };
  }

  private async deriveTerminalReceipt(status: CaseStatus): Promise<TerminalReceipt> {
    if (status.lifecycle !== "terminated" && status.lifecycle !== "invalid") {
      throw new Error("A terminal receipt requires a terminal Case status");
    }
    await this.assertAuthenticatedSeal(status);
    const preferred = await this.preferredRecordPair(status.caseId);
    if (preferred === undefined) throw new Error("A terminal receipt requires an authenticated Record");

    const events = await new FileEventHub(this.dataDir).read(status.caseId);
    const verification = verifyEventChain(events);
    if (!verification.valid) {
      throw new Error(`A terminal receipt requires a valid complete event chain: ${verification.problems.map((entry) => entry.code).join(", ")}`);
    }
    if (events.some((event) =>
      event.caseDigest !== status.sealed.caseDigest || event.runDigest !== status.sealed.runDigest)) {
      throw new Error("A terminal receipt cannot cross a sealed Case or run boundary");
    }
    const tail = events.at(-1);
    const lastSequence = tail?.sequence ?? 0;
    if (status.lastSequence !== lastSequence || status.headDigest !== verification.headDigest) {
      throw new Error("Terminal status does not equal the complete verified event ledger");
    }
    if (!events.some((event) => event.eventDigest === preferred.record.eventHeadDigest)) {
      throw new Error("The authenticated Record crystallization head is absent from the terminal ledger");
    }
    const artifactIndex = {
      protocol: "jevyr.artifacts/1",
      caseId: status.caseId,
      artifacts: await this.artifacts(status.caseId),
    } as const;

    const receipt: TerminalReceipt = {
      protocol: "jevyr.terminal/1",
      caseId: status.caseId,
      caseDigest: status.sealed.caseDigest,
      runDigest: status.sealed.runDigest,
      lifecycle: status.lifecycle,
      stage: status.stage,
      stageStatus: status.stageStatus,
      lastSequence,
      eventHeadDigest: verification.headDigest,
      recordDigest: digestJson(preferred.record as unknown as JsonValue),
      artifactIndexDigest: digestJson(artifactIndex as unknown as JsonValue),
      closedAt: tail?.observedAt ?? new Date(status.updatedAt).toISOString(),
    };
    assertValidTerminalReceipt(receipt, "Derived terminal receipt");
    return receipt;
  }

  private async commitTerminalReceipt(caseId: string): Promise<DsseEnvelope> {
    const status = await this.status(caseId);
    if (!status) throw new Error(`Unknown case ${caseId}`);
    const receipt = await this.deriveTerminalReceipt(status);
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    const envelope = signTerminalReceipt(receipt, keys.privatePem, keys.keyId);
    const directory = this.caseDir(caseId);
    // Sidecars are outside the immutable artifact inventory to avoid a circular
    // terminal root. Both signatures are durable before closure is published.
    const preferred = await this.preferredRecordPair(caseId);
    if (!preferred) throw new Error("Production provenance requires the authenticated Record");
    const statements = deriveRunStatements(status.receipt, preferred.record, receipt, keys.keyId);
    const attestations: RunAttestations = { protocol: RUN_ATTESTATIONS_PROTOCOL, caseId, runDigest: status.receipt.runDigest,
      production: signDsse(IN_TOTO_DSSE_PAYLOAD_TYPE, canonicalize(statements.production as unknown as JsonValue), keys.privatePem, keys.keyId),
      advisory: signDsse(IN_TOTO_DSSE_PAYLOAD_TYPE, canonicalize(statements.advisory as unknown as JsonValue), keys.privatePem, keys.keyId) };
    await this.#verifyRunAttestations(attestations, status, preferred.record, receipt);
    await this.ensureJsonCreateOnce(join(directory, "run-attestations.json"), attestations, "fixed production and advisory attestations");
    await this.ensureJsonCreateOnce(join(directory, "terminal.json"), receipt, "terminal receipt");
    await this.ensureJsonCreateOnce(join(directory, "terminal.dsse.json"), envelope, "terminal receipt envelope");
    const persisted = await this.verifiedTerminalPair(caseId);
    if (!persisted
      || !canonicalEqual(persisted.receipt, receipt)
      || !canonicalEqual(persisted.envelope, envelope)) {
      throw new Error("The persisted terminal receipt pair differs from the authorized closure");
    }
    return structuredClone(persisted.envelope);
  }

  async #verifyRunAttestations(raw: unknown, status: CaseStatus, record: SignedRecord, terminal: TerminalReceipt): Promise<RunAttestations> {
    assertRunAttestations(raw);
    if (raw.caseId !== status.caseId || raw.runDigest !== status.receipt.runDigest) throw new Error("Run attestations cross a Case boundary");
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    const expected = deriveRunStatements(status.receipt, record, terminal, keys.keyId);
    for (const name of ["production", "advisory"] as const) {
      const envelope = raw[name];
      if (envelope.signatures[0]?.keyid !== keys.keyId || !canonicalEqual(decodeCanonicalDsseJson<unknown>(envelope, `Run ${name} statement`), expected[name])
        || !verifyDsse(envelope, new Map([[keys.keyId, keys.publicPem]]))) throw new Error(`Run ${name} attestation differs from its fixed derived payload or repository signer`);
    }
    return structuredClone(raw);
  }

  private async verifiedTerminalPair(caseId: string): Promise<VerifiedTerminalPair | undefined> {
    const status = await this.status(caseId);
    if (!status || (status.lifecycle !== "terminated" && status.lifecycle !== "invalid")) return undefined;
    const directory = this.caseDir(caseId);
    const receiptPath = join(directory, "terminal.json");
    const envelopePath = join(directory, "terminal.dsse.json");
    const [hasReceipt, hasEnvelope] = await Promise.all([fileExists(receiptPath), fileExists(envelopePath)]);
    if (!hasReceipt || !hasEnvelope) return undefined;
    const [receipt, envelope, expected] = await Promise.all([
      this.readJson<unknown>(receiptPath),
      this.readJson<unknown>(envelopePath),
      this.deriveTerminalReceipt(status),
    ]);
    assertValidTerminalReceipt(receipt, "Stored terminal receipt");
    if (!canonicalEqual(receipt, expected)) {
      throw new Error("Stored terminal receipt does not equal the terminal Case, ledger, Record, and artifact index");
    }
    assertDsseEnvelope(envelope, TERMINAL_DSSE_PAYLOAD_TYPE, "Stored terminal receipt envelope");
    const signed = decodeCanonicalDsseJson<unknown>(envelope, "Stored terminal receipt envelope");
    if (!canonicalEqual(signed, receipt)) {
      throw new Error("Stored terminal receipt does not equal its signed payload");
    }
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    if (!verifyDsse(envelope, new Map([[keys.keyId, keys.publicPem]]))) {
      throw new Error("Stored terminal receipt signature does not verify against the repository identity");
    }
    return {
      receipt: structuredClone(receipt),
      envelope: structuredClone(envelope),
    };
  }

  private assertRecoveryRecordShape(status: CaseStatus, record: SignedRecord): void {
    const basis = record.verdict.basis;
    const finding = record.reflex.materialFindings;
    const code = basis[0]?.code;
    if (
      status.lifecycle !== "invalid"
      || status.stageStatus !== "failed"
      || !status.error
      || (code !== "RUNTIME_RESTART_INTERRUPTED_CASE" && code !== "RUNTIME_FAILURE")
      || basis.length !== 1
      || basis[0]?.summary !== status.error
      || basis[0]?.evidenceIds.length !== 0
      || basis[0]?.obligationIds !== undefined
      || basis[0]?.candidateIds !== undefined
      || record.verdict.integrity !== "INVALID"
      || record.verdict.creation !== "FAILED"
      || record.verdict.embodiment !== "FAILED"
      || record.verdict.judgment !== "NOT_APPLICABLE"
      || record.verdict.selectedCandidateId !== undefined
      || Object.keys(record.verdict.feasibilityByCandidate).length !== 0
      || record.reflex.loop !== 1
      || record.reflex.reviewedEvidenceDigest !== record.verdict.evidenceDigest
      || record.reflex.intentContractDigest !== status.sealed.intentContractDigest
      || record.reflex.challengedNodeIds.length !== 0
      || record.reflex.decision !== "revise"
      || finding.length !== 1
      || finding[0]?.code !== code
      || finding[0]?.summary !== status.error
      || finding[0]?.evidenceIds.length !== 0
      || record.memoryInfluences.length !== 0
    ) {
      throw new Error("Stored recovery Record is not the fixed fail-closed recovery shape");
    }
  }

  private async recordPairHasAnyFile(caseId: string, base: "record" | "recovery-record"): Promise<boolean> {
    const directory = this.caseDir(caseId);
    return (await Promise.all([
      fileExists(join(directory, `${base}.json`)),
      fileExists(join(directory, `${base}.dsse.json`)),
    ])).some(Boolean);
  }

  private async writeRecordPairOnce(
    caseId: string,
    base: "record" | "recovery-record",
    record: SignedRecord,
    envelope: DsseEnvelope,
    status: CaseStatus,
  ): Promise<DsseEnvelope> {
    const directory = this.caseDir(caseId);
    await this.ensureJsonCreateOnce(join(directory, `${base}.json`), record, `${base} Record`);
    await this.ensureJsonCreateOnce(join(directory, `${base}.dsse.json`), envelope, `${base} Record envelope`);
    const persisted = await this.verifiedRecordPair(caseId, base, status);
    if (!persisted || !canonicalEqual(persisted.record, record) || !canonicalEqual(persisted.envelope, envelope)) {
      throw new Error(`The persisted ${base} Record pair differs from the authorized commitment`);
    }
    return structuredClone(persisted.envelope);
  }

  private async ensureJsonCreateOnce(path: string, value: unknown, label: string): Promise<void> {
    try {
      await writeJsonCreateOnce(path, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stored = await this.readJson<unknown>(path);
    if (stored === undefined || !canonicalEqual(stored, value)) {
      throw new Error(`${label} is write-once and its existing bytes describe a different value`);
    }
  }

  /** Returns only public verification material; private key bytes and paths never cross this boundary. */
  async publicTrustBundle(): Promise<PublicTrustBundle> {
    const keys = await (this.keysPromise ??= this.loadOrCreateKeys());
    return structuredClone({
      protocol: "jevyr.trust-bundle/1",
      keys: [{
        keyId: keys.keyId,
        algorithm: "Ed25519",
        publicKeyPem: keys.publicPem,
        payloadTypes: [
          "application/vnd.jevyr.seal+json",
          "application/vnd.jevyr.record+json",
          "application/vnd.jevyr.terminal+json",
        ],
      }],
    });
  }

  /** Reloads and content-verifies a policy, genome, or search descriptor by digest. */
  async descriptor(digest: string): Promise<DescriptorArtifact | undefined> {
    if (!isSha256Digest(digest)) throw new TypeError("Descriptor identifier must be a SHA-256 digest");
    const path = join(this.dataDir, "descriptors", `${digest.slice("sha256:".length)}.json`);
    const artifact = await this.readJson<DescriptorArtifact>(path);
    if (!artifact) return undefined;
    if (artifact.protocol !== "jevyr.descriptor-artifact/1" || artifact.digest !== digest || digestJson(artifact.descriptor) !== digest) {
      throw new Error(`Descriptor artifact ${digest} failed content-address verification`);
    }
    return structuredClone(artifact);
  }

  async putArtifact(caseId: string, name: string, mediaType: string, data: Uint8Array): Promise<ArtifactMeta> {
    return await this.withRecordCommit(caseId, async () => await this.commitArtifact(caseId, name, mediaType, data));
  }

  private async commitArtifact(caseId: string, name: string, mediaType: string, data: Uint8Array): Promise<ArtifactMeta> {
    this.caseDir(caseId);
    const directory = this.caseDir(caseId);
    if (!name || name.length > 255) throw new TypeError("Artifact name must contain 1–255 characters");
    const digest = sha256Digest(data);
    const id = `artifact_${digest.slice("sha256:".length, "sha256:".length + 24)}`;
    const [hasTerminalReceipt, hasTerminalEnvelope, status] = await Promise.all([
      fileExists(join(directory, "terminal.json")),
      fileExists(join(directory, "terminal.dsse.json")),
      this.status(caseId),
    ]);
    if (status === undefined) throw new Error(`Unknown case ${caseId}`);
    if (hasTerminalReceipt || hasTerminalEnvelope || status.lifecycle === "terminated" || status.lifecycle === "invalid") {
      const existing = await this.artifact(caseId, id);
      if (existing !== undefined && existing.meta.digest === digest && existing.data.byteLength === data.byteLength) {
        return existing.meta;
      }
      throw new Error(`Artifacts are closed for terminal case ${caseId}`);
    }
    const meta: ArtifactMeta = {
      protocol: "jevyr.artifact/1",
      id,
      caseId,
      name: basenameOnly(name),
      mediaType: ARTIFACT_MEDIA_TYPE.test(mediaType)
        ? mediaType.slice(0, 200)
        : "application/octet-stream",
      size: data.byteLength,
      digest,
      createdAt: new Date().toISOString(),
    };
    const artifactDirectory = join(directory, "artifacts");
    await mkdir(artifactDirectory, { recursive: true });
    const blobPath = join(artifactDirectory, `${id}.blob`);
    const metaPath = join(artifactDirectory, `${id}.json`);
    await writeFile(blobPath, data, { flag: "wx", mode: 0o600 }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const persistedData = await readFile(blobPath);
    if (persistedData.byteLength !== data.byteLength || sha256Digest(persistedData) !== digest) {
      throw new Error(`Artifact identifier collision or corrupt pre-existing blob for ${id}`);
    }
    try {
      await writeJsonCreateOnce(metaPath, meta);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Reopen the winner instead of returning caller-local metadata. Concurrent
    // names for identical bytes must converge on one immutable index entry;
    // a truncated-id collision must fail rather than replace that entry.
    const storedMeta = await this.readJson<ArtifactMeta>(metaPath);
    if (storedMeta === undefined) throw new Error(`Artifact metadata disappeared while committing ${id}`);
    const stored = await this.readVerifiedArtifact(caseId, id, storedMeta, blobPath);
    if (stored.meta.digest !== digest) throw new Error(`Artifact identifier collision for ${id}`);
    return stored.meta;
  }

  async artifacts(caseId: string): Promise<ArtifactMeta[]> {
    const directory = join(this.caseDir(caseId), "artifacts");
    const { readdir } = await import("node:fs/promises");
    try {
      const entries = (await readdir(directory))
        .filter((entry) => /^artifact_[a-f0-9]{24}\.json$/u.test(entry))
        .sort(compareOrdinal);
      const artifacts = await Promise.all(entries.map(async (entry) => {
        const artifactId = entry.slice(0, -".json".length);
        const artifact = await this.artifact(caseId, artifactId);
        if (!artifact) throw new Error(`Artifact index ${entry} disappeared while it was being verified`);
        return artifact.meta;
      }));
      return artifacts;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async artifact(caseId: string, artifactId: string): Promise<{ meta: ArtifactMeta; data: Buffer } | undefined> {
    if (!/^artifact_[a-f0-9]{24}$/u.test(artifactId)) throw new TypeError("Invalid artifact identifier");
    const directory = join(this.caseDir(caseId), "artifacts");
    const meta = await this.readJson<ArtifactMeta>(join(directory, `${artifactId}.json`));
    if (!meta) return undefined;
    return await this.readVerifiedArtifact(caseId, artifactId, meta, join(directory, `${artifactId}.blob`));
  }

  private async readVerifiedArtifact(
    caseId: string,
    artifactId: string,
    meta: ArtifactMeta,
    blobPath: string,
  ): Promise<{ meta: ArtifactMeta; data: Buffer }> {
    assertStoredArtifactMeta(caseId, artifactId, meta);
    const data = await readFile(blobPath);
    if (data.byteLength !== meta.size || sha256Digest(data) !== meta.digest) {
      throw new Error(`Artifact ${artifactId} failed content-address verification`);
    }
    return { meta: structuredClone(meta), data };
  }

  private async readJson<T>(path: string): Promise<T | undefined> {
    return await withLocalFileOperation(path, async () => {
      try {
        return parseJsonBytes(await readFile(path), `Persisted JSON ${path}`) as T;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    });
  }

  private assertStoredStatus(directoryCaseId: string, status: CaseStatus): void {
    if (status.protocol !== "jevyr.runtime-status/1") throw new Error(`Stored case ${directoryCaseId} has an unsupported status protocol`);
    if (status.caseId !== directoryCaseId || status.sealed?.caseId !== directoryCaseId || status.receipt?.caseId !== directoryCaseId) {
      throw new Error(`Stored case ${directoryCaseId} has inconsistent case identity`);
    }
    if (!new Set(["queued", "running", "crystallized", "terminated", "invalid"]).has(status.lifecycle)) {
      throw new Error(`Stored case ${directoryCaseId} has an invalid lifecycle`);
    }
    if (!(LIFECYCLE_STAGES as readonly string[]).includes(status.stage) || !STATUS_VALUES.has(status.stageStatus)) {
      throw new Error(`Stored case ${directoryCaseId} has an invalid stage state`);
    }
    if (!Number.isSafeInteger(status.lastSequence) || status.lastSequence < 0) {
      throw new Error(`Stored case ${directoryCaseId} has an invalid event cursor`);
    }
    if (status.headDigest !== null && !isSha256Digest(status.headDigest)) {
      throw new Error(`Stored case ${directoryCaseId} has an invalid event head`);
    }
    if (Number.isNaN(Date.parse(status.createdAt)) || Number.isNaN(Date.parse(status.updatedAt))) {
      throw new Error(`Stored case ${directoryCaseId} has invalid timestamps`);
    }
    const sealed = validateSealedCase(status.sealed);
    const receipt = validateSealReceipt(status.receipt);
    if (!sealed.ok) throw new Error(`Stored case ${directoryCaseId} has an invalid seal: ${sealed.problems.map((entry) => entry.code).join(", ")}`);
    if (!receipt.ok) throw new Error(`Stored case ${directoryCaseId} has an invalid receipt: ${receipt.problems.map((entry) => entry.code).join(", ")}`);
    if (digestJson(sealReceipt(status.sealed) as unknown as JsonValue) !== digestJson(status.receipt as unknown as JsonValue)) {
      throw new Error(`Stored case ${directoryCaseId} receipt does not match its seal`);
    }
  }

  private assertRecordIdentity(status: CaseStatus, record: SignedRecord): void {
    if (record.caseDigest !== status.sealed.caseDigest || record.runDigest !== status.sealed.runDigest) {
      throw new TypeError("Record identity does not match the sealed case");
    }
    if (
      record.policyDigest !== status.sealed.policyDigest ||
      record.genomeDigest !== status.sealed.genomeDigest ||
      record.searchDigest !== status.sealed.searchEnvelope.digest ||
      record.intentContractDigest !== status.sealed.intentContractDigest ||
      record.verdict.intentContractDigest !== status.sealed.intentContractDigest
    ) {
      throw new TypeError("Record provenance does not match the sealed policy, genome, search envelope, and intent contract");
    }
  }

  private async readAndVerifySubjectMaterialCapture(status: CaseStatus): Promise<SubjectMaterialCaptureResult> {
    const path = join(this.caseDir(status.caseId), "subject-materials.json");
    const raw = await this.readJson<unknown>(path);
    if (!recordObject(raw)) {
      throw new Error(`Stored case ${status.caseId} has no valid subject material binding; refusing a pre-capture downgrade`);
    }
    assertExactKeys(
      raw,
      ["protocol", "caseId", "caseDigest", "runDigest", "captureDigest", "bindings"],
      `Stored case ${status.caseId} subject material binding`,
    );
    if (raw.protocol !== CASE_SUBJECT_MATERIAL_BINDING_PROTOCOL) {
      throw new Error(`Stored case ${status.caseId} has an unsupported subject material binding protocol`);
    }
    if (raw.caseId !== status.caseId || raw.caseDigest !== status.sealed.caseDigest || raw.runDigest !== status.sealed.runDigest) {
      throw new Error(`Stored case ${status.caseId} subject material binding has inconsistent Case identity`);
    }
    if (!isSha256Digest(raw.captureDigest)
      || raw.captureDigest !== status.sealed.subjectMaterialCaptureDigest
      || raw.captureDigest !== status.receipt.subjectMaterialCaptureDigest) {
      throw new Error(`Stored case ${status.caseId} subject material capture does not match its signed Seal`);
    }
    if (!Array.isArray(raw.bindings)) {
      throw new Error(`Stored case ${status.caseId} subject material bindings are malformed`);
    }

    const bindings: SubjectMaterialBinding[] = [];
    const seen = new Set<string>();
    let previousId: string | undefined;
    for (const [index, value] of raw.bindings.entries()) {
      if (!recordObject(value)) throw new Error(`Stored case ${status.caseId} subject material binding ${index} is malformed`);
      assertExactKeys(
        value,
        ["subjectId", "subjectKind", "subjectDigest", "availability", "manifestDigest", "byteLength"],
        `Stored case ${status.caseId} subject material binding ${index}`,
      );
      if (typeof value.subjectId !== "string" || !value.subjectId
        || !new Set(["git", "directory", "file", "url", "text", "artifact"]).has(value.subjectKind as string)
        || !isSha256Digest(value.subjectDigest) || !isSha256Digest(value.manifestDigest)
        || !new Set(["MATERIALIZED", "DECLARATION_ONLY"]).has(value.availability as string)
        || !Number.isSafeInteger(value.byteLength) || (value.byteLength as number) < 0) {
        throw new Error(`Stored case ${status.caseId} subject material binding ${index} is malformed`);
      }
      if (seen.has(value.subjectId) || (previousId !== undefined && compareOrdinal(previousId, value.subjectId) >= 0)) {
        throw new Error(`Stored case ${status.caseId} subject material bindings are not unique and strictly ordered`);
      }
      seen.add(value.subjectId);
      previousId = value.subjectId;
      bindings.push(value as unknown as SubjectMaterialBinding);
    }

    const recomputedCaptureDigest = digestJson({
      protocol: SUBJECT_MATERIAL_CAPTURE_PROTOCOL,
      bindings: bindings as unknown as JsonValue,
    });
    if (recomputedCaptureDigest !== raw.captureDigest) {
      throw new Error(`Stored case ${status.caseId} subject material capture digest is invalid`);
    }
    if (bindings.length !== status.sealed.subjects.length
      || bindings.length !== status.sealed.intent.subjects.length) {
      throw new Error(`Stored case ${status.caseId} subject material binding count does not match its Seal`);
    }
    const snapshots = new Map(status.sealed.subjects.map((snapshot) => [snapshot.subjectId, snapshot]));
    const references = new Map(status.sealed.intent.subjects.map((subject) => [subject.id, subject]));
    for (const binding of bindings) {
      const snapshot = snapshots.get(binding.subjectId);
      const reference = references.get(binding.subjectId);
      if (!snapshot || !reference || snapshot.digest !== binding.subjectDigest || reference.kind !== binding.subjectKind) {
        throw new Error(`Stored case ${status.caseId} subject material ${binding.subjectId} does not match its sealed snapshot`);
      }
      await verifySubjectMaterialBinding(this.subjectMaterialStoreRoot, binding);
    }

    return Object.freeze({
      protocol: SUBJECT_MATERIAL_CAPTURE_PROTOCOL,
      snapshots: Object.freeze(structuredClone(status.sealed.subjects)),
      bindings: Object.freeze(structuredClone(bindings)),
      captureDigest: raw.captureDigest,
    });
  }

  private async ensureProvenanceDescriptors(): Promise<void> {
    const entries: readonly DescriptorArtifact[] = [
      { protocol: "jevyr.descriptor-artifact/1", kind: "policy", digest: this.policyDigest, descriptor: this.policyDescriptor },
      { protocol: "jevyr.descriptor-artifact/1", kind: "genome", digest: this.genomeDigest, descriptor: this.genomeDescriptor },
      { protocol: "jevyr.descriptor-artifact/1", kind: "search", digest: this.searchEnvelope.digest, descriptor: searchEnvelopeDescriptor(this.searchEnvelope) },
    ];
    const directory = join(this.dataDir, "descriptors");
    await mkdir(directory, { recursive: true });
    await Promise.all(entries.map(async (entry) => {
      const path = join(directory, `${entry.digest.slice("sha256:".length)}.json`);
      await writeFile(path, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const stored = await this.descriptor(entry.digest);
      if (!stored || stored.kind !== entry.kind) throw new Error(`Descriptor artifact ${entry.digest} is unavailable or has the wrong kind`);
    }));
  }

  private async loadOrCreateKeys(): Promise<{ privatePem: string; publicPem: string; keyId: string }> {
    return await loadSigningPair(this.dataDir, "jevyr-ed25519");
  }
}

async function loadSigningPair(dataDir: string, stem: "jevyr-ed25519" | "jevyr-metabolic-ed25519"): Promise<{ privatePem: string; publicPem: string; keyId: string }> {
    const keyDir = join(dataDir, "keys");
    const privatePath = join(keyDir, `${stem}-private.pem`);
    const publicPath = join(keyDir, `${stem}-public.pem`);
    await mkdir(keyDir, { recursive: true });
    const [privatePem, publicPem] = await Promise.all([readOptional(privatePath), readOptional(publicPath)]);
    if (privatePem && publicPem) return checkedSigningPair(privatePem, publicPem);
    if (privatePem && !publicPem) {
      const derivedPublicPem = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "pem" }).toString();
      await writeFile(publicPath, derivedPublicPem, { encoding: "utf8", mode: 0o644, flag: "wx" }).catch(async (error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      return checkedSigningPair(privatePem, await readFile(publicPath, "utf8"));
    }
    if (!privatePem && publicPem) {
      throw new Error("Jevyr signing state contains a public key without its private counterpart; refusing to invent a replacement identity");
    }
    const pair = generateSigningKeyPair();
    // The exclusive private-key create elects the repository identity. A
    // concurrent initializer must derive the public half from that winner;
    // writing both random halves concurrently can permanently cross-pair two
    // otherwise valid keys.
    await writeFile(privatePath, pair.privateKeyPem, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    const electedPrivatePem = await readFile(privatePath, "utf8");
    const electedPublicPem = createPublicKey(createPrivateKey(electedPrivatePem))
      .export({ type: "spki", format: "pem" })
      .toString();
    await writeFile(publicPath, electedPublicPem, { encoding: "utf8", mode: 0o644, flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    });
    return checkedSigningPair(electedPrivatePem, await readFile(publicPath, "utf8"));
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  try {
    return canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
  } catch {
    return false;
  }
}

function exactPolicyBody(descriptor: unknown): Readonly<Record<string, unknown>> {
  if (!recordObject(descriptor) || descriptor.protocol !== "jevyr.policy-descriptor/1") {
    throw new TypeError("Repository policy descriptor is not a Jevyr policy envelope");
  }
  if (!recordObject(descriptor.policy)) {
    throw new TypeError("Repository policy envelope has no concrete policy body");
  }
  return descriptor.policy;
}

function assertValidRecord(value: unknown, label: string): asserts value is SignedRecord {
  const validation = validateSignedRecord(value);
  if (!validation.ok || validation.value === undefined) {
    throw new TypeError(
      `${label} failed protocol validation: ${validation.problems.map((entry) => `${entry.path}:${entry.code}`).join(", ")}`,
    );
  }
}

function assertValidTerminalReceipt(value: unknown, label: string): asserts value is TerminalReceipt {
  const validation = validateTerminalReceipt(value);
  if (!validation.ok || validation.value === undefined) {
    throw new TypeError(
      `${label} failed protocol validation: ${validation.problems.map((entry) => `${entry.path}:${entry.code}`).join(", ")}`,
    );
  }
}

function canonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  try {
    return Buffer.from(value, "base64").toString("base64") === value;
  } catch {
    return false;
  }
}

function assertDsseEnvelope(
  value: unknown,
  payloadType: string,
  label: string,
): asserts value is DsseEnvelope {
  if (!recordObject(value)) throw new Error(`${label} is not an object`);
  assertExactKeys(value, ["payloadType", "payload", "signatures"], label);
  if (value.payloadType !== payloadType || typeof value.payload !== "string" || !canonicalBase64(value.payload)) {
    throw new Error(`${label} has an invalid payload type or encoding`);
  }
  if (!Array.isArray(value.signatures) || value.signatures.length !== 1) {
    throw new Error(`${label} must carry exactly one repository signature`);
  }
  const signature = value.signatures[0];
  if (!recordObject(signature)) throw new Error(`${label} has a malformed signature`);
  assertExactKeys(signature, ["keyid", "sig"], `${label} signature`);
  if (!isSha256Digest(signature.keyid) || typeof signature.sig !== "string" || !canonicalBase64(signature.sig)) {
    throw new Error(`${label} has an invalid signature identity or encoding`);
  }
}

function decodeCanonicalDsseJson<T>(envelope: DsseEnvelope, label: string): T {
  const bytes = Buffer.from(envelope.payload, "base64");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} payload is not UTF-8`, { cause: error });
  }
  let decoded: T;
  try {
    decoded = decodeDsseJson<T>(envelope);
  } catch (error) {
    throw new Error(`${label} payload is not JSON`, { cause: error });
  }
  if (canonicalize(decoded as unknown as JsonValue) !== text) {
    throw new Error(`${label} payload is not canonical Jevyr JSON`);
  }
  return decoded;
}

function sameEventDigests(left: readonly CaseEvent[], right: readonly CaseEvent[]): boolean {
  return left.length === right.length
    && left.every((event, index) => event.eventDigest === right[index]?.eventDigest);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function checkedSigningPair(privatePem: string, publicPem: string): { privatePem: string; publicPem: string; keyId: string } {
  const derivedPublic = createPublicKey(createPrivateKey(privatePem));
  const derivedKeyId = keyIdFor(derivedPublic);
  const publicKeyId = keyIdFor(publicPem);
  if (derivedKeyId !== publicKeyId) throw new Error("Jevyr signing key files do not form one Ed25519 identity");
  return { privatePem, publicPem, keyId: publicKeyId };
}

function basenameOnly(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").at(-1) ?? "artifact";
  return base.replace(/[\u0000-\u001f\u007f"]/gu, "_") || "artifact";
}

function assertStoredArtifactMeta(caseId: string, artifactId: string, value: unknown): asserts value is ArtifactMeta {
  if (!recordObject(value)) throw new Error(`Artifact ${artifactId} has malformed metadata`);
  assertExactKeys(
    value,
    ["protocol", "id", "caseId", "name", "mediaType", "size", "digest", "createdAt"],
    `Artifact ${artifactId} metadata`,
  );
  if (
    value.protocol !== "jevyr.artifact/1"
    || value.id !== artifactId
    || value.caseId !== caseId
    || typeof value.name !== "string"
    || value.name.length < 1
    || value.name.length > 255
    || basenameOnly(value.name) !== value.name
    || typeof value.mediaType !== "string"
    || value.mediaType.length > 200
    || !ARTIFACT_MEDIA_TYPE.test(value.mediaType)
    || !Number.isSafeInteger(value.size)
    || (value.size as number) < 0
    || !isSha256Digest(value.digest)
    || artifactId !== `artifact_${value.digest.slice("sha256:".length, "sha256:".length + 24)}`
    || typeof value.createdAt !== "string"
    || Number.isNaN(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error(`Artifact ${artifactId} has invalid metadata`);
  }
}

function recordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const expected = new Set(allowed);
  const keys = Object.keys(value);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
