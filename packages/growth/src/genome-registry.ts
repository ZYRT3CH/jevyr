import { randomUUID, type KeyObject } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  canonicalize,
  digestJson,
  isSha256Digest,
  type DsseEnvelope,
  type JsonValue,
} from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import { assertGenomeDigest, createGenome, promoteGenome } from "./genome.js";
import {
  GENOME_PROTOCOL,
  GROWTH_PROPOSAL_PROTOCOL,
  type BenchmarkObservation,
  type DamageTrial,
  type GrowthProposal,
  type PromotedGenome,
  type StoredGenome,
} from "./types.js";

export const STORED_PROMOTION_PROTOCOL = "jevyr.stored-genome-promotion/1" as const;
export const ACTIVE_GENOME_POINTER_PROTOCOL = "jevyr.active-genome-pointer/1" as const;

const MAX_REGISTRY_OBJECT_BYTES = 16 * 1024 * 1024;
const DIGEST_FILE_PATTERN = /^[a-f0-9]{64}\.json$/u;

export type GenomeRegistryObjectKind = "genome" | "proposal" | "promotion";

export interface RegistryWriteReceipt {
  readonly kind: GenomeRegistryObjectKind;
  readonly digest: string;
  /** ALREADY_PRESENT is an idempotent observation. Existing bytes are never replaced. */
  readonly status: "STORED" | "ALREADY_PRESENT";
}

export interface StoredPromotionBody {
  readonly protocol: typeof STORED_PROMOTION_PROTOCOL;
  readonly genome: StoredGenome;
  readonly proposalDigest: string;
  readonly attestation: DsseEnvelope;
  readonly promoted: true;
}

export interface StoredPromotion {
  readonly digest: string;
  readonly body: StoredPromotionBody;
}

export interface ActiveGenomePointerBody {
  readonly protocol: typeof ACTIVE_GENOME_POINTER_PROTOCOL;
  readonly genomeDigest: string;
  readonly proposalDigest: string;
  readonly promotionDigest: string;
}

export interface ActiveGenomePointer {
  readonly pointerDigest: string;
  readonly body: ActiveGenomePointerBody;
}

export interface ActiveGenome {
  readonly pointer: ActiveGenomePointer;
  readonly promotion: StoredPromotion;
  readonly genome: StoredGenome;
}

export class GenomeRegistryIntegrityError extends Error {
  override readonly name = "GenomeRegistryIntegrityError";
}

export class GenomeRegistryGovernanceError extends Error {
  override readonly name = "GenomeRegistryGovernanceError";
}

type GovernanceKeys = ReadonlyMap<string, KeyObject | string>;

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GenomeRegistryIntegrityError(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new GenomeRegistryIntegrityError(`${label} has unknown or missing fields.`);
  }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GenomeRegistryIntegrityError(`${label} must be a non-empty string.`);
  }
}

function sha256(value: unknown, label: string): asserts value is string {
  if (!isSha256Digest(value)) {
    throw new GenomeRegistryIntegrityError(`${label} must be a SHA-256 digest.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function proposalDigestBody(proposal: GrowthProposal): JsonValue {
  return {
    protocol: proposal.protocol,
    parentDigest: proposal.parentDigest,
    descendant: proposal.descendant as unknown as JsonValue,
    benchmarkEvidence: proposal.benchmarkEvidence as unknown as JsonValue,
    damageEvidence: proposal.damageEvidence as unknown as JsonValue,
    novelty: proposal.novelty,
    decision: proposal.decision,
    reasons: proposal.reasons,
  };
}

function assertObservation(value: unknown, index: number): asserts value is BenchmarkObservation {
  const entry = object(value, `benchmarkEvidence[${index}]`);
  exactKeys(
    entry,
    ["suite", "heldOut", "invariant", "passed", "score", "parentScore", "evidenceDigest"],
    `benchmarkEvidence[${index}]`,
  );
  nonEmptyString(entry.suite, `benchmarkEvidence[${index}].suite`);
  if (
    typeof entry.heldOut !== "boolean" ||
    typeof entry.invariant !== "boolean" ||
    typeof entry.passed !== "boolean" ||
    typeof entry.score !== "number" ||
    !Number.isFinite(entry.score) ||
    typeof entry.parentScore !== "number" ||
    !Number.isFinite(entry.parentScore)
  ) {
    throw new GenomeRegistryIntegrityError(`benchmarkEvidence[${index}] has invalid measurements.`);
  }
  sha256(entry.evidenceDigest, `benchmarkEvidence[${index}].evidenceDigest`);
}

function assertDamage(value: unknown, index: number): asserts value is DamageTrial {
  const entry = object(value, `damageEvidence[${index}]`);
  exactKeys(
    entry,
    ["id", "kind", "passed", "recoveredToBone", "evidenceDigest"],
    `damageEvidence[${index}]`,
  );
  nonEmptyString(entry.id, `damageEvidence[${index}].id`);
  if (!(["CORRUPTION", "RESOURCE_LOSS", "ADVERSARIAL_INPUT", "TOOL_LOSS"] as const).includes(entry.kind as DamageTrial["kind"])) {
    throw new GenomeRegistryIntegrityError(`damageEvidence[${index}].kind is invalid.`);
  }
  if (typeof entry.passed !== "boolean" || typeof entry.recoveredToBone !== "boolean") {
    throw new GenomeRegistryIntegrityError(`damageEvidence[${index}] has invalid outcomes.`);
  }
  sha256(entry.evidenceDigest, `damageEvidence[${index}].evidenceDigest`);
}

export function assertStoredGenome(value: unknown): asserts value is StoredGenome {
  const genome = object(value, "Genome");
  exactKeys(genome, ["digest", "body"], "Genome");
  sha256(genome.digest, "Genome digest");
  const body = object(genome.body, "Genome body");
  exactKeys(body, ["protocol", "generation", "boneDigest", "parentDigests", "modules", "parameters"], "Genome body");
  if (body.protocol !== GENOME_PROTOCOL) throw new GenomeRegistryIntegrityError("Genome protocol is unsupported.");
  if (!Number.isSafeInteger(body.generation) || (body.generation as number) < 0) {
    throw new GenomeRegistryIntegrityError("Genome generation must be a non-negative safe integer.");
  }
  sha256(body.boneDigest, "Genome Bone digest");
  if (!Array.isArray(body.parentDigests)) throw new GenomeRegistryIntegrityError("Genome parentDigests must be an array.");
  for (const [index, digest] of body.parentDigests.entries()) sha256(digest, `Genome parentDigests[${index}]`);
  if (!Array.isArray(body.modules)) throw new GenomeRegistryIntegrityError("Genome modules must be an array.");
  for (const [index, candidate] of body.modules.entries()) {
    const module = object(candidate, `Genome modules[${index}]`);
    exactKeys(module, ["id", "version", "artifactDigest", "permissions", "publicPurpose"], `Genome modules[${index}]`);
    nonEmptyString(module.id, `Genome modules[${index}].id`);
    nonEmptyString(module.version, `Genome modules[${index}].version`);
    sha256(module.artifactDigest, `Genome modules[${index}].artifactDigest`);
    nonEmptyString(module.publicPurpose, `Genome modules[${index}].publicPurpose`);
    if (!Array.isArray(module.permissions) || module.permissions.some((permission) => typeof permission !== "string")) {
      throw new GenomeRegistryIntegrityError(`Genome modules[${index}].permissions must contain strings.`);
    }
  }
  object(body.parameters, "Genome parameters");

  let rebuilt: StoredGenome;
  try {
    rebuilt = createGenome(body as unknown as StoredGenome["body"]);
    assertGenomeDigest(genome as unknown as StoredGenome);
  } catch (error) {
    throw new GenomeRegistryIntegrityError(`Genome is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (
    rebuilt.digest !== genome.digest ||
    canonicalize(rebuilt.body as unknown as JsonValue) !== canonicalize(body as unknown as JsonValue)
  ) {
    throw new GenomeRegistryIntegrityError("Genome body does not match its immutable content address.");
  }
}

export function assertGrowthProposal(value: unknown): asserts value is GrowthProposal {
  const proposal = object(value, "Growth proposal");
  exactKeys(
    proposal,
    ["protocol", "proposalDigest", "parentDigest", "descendant", "benchmarkEvidence", "damageEvidence", "novelty", "decision", "reasons"],
    "Growth proposal",
  );
  if (proposal.protocol !== GROWTH_PROPOSAL_PROTOCOL) throw new GenomeRegistryIntegrityError("Growth proposal protocol is unsupported.");
  sha256(proposal.proposalDigest, "Growth proposal digest");
  sha256(proposal.parentDigest, "Growth proposal parentDigest");
  assertStoredGenome(proposal.descendant);
  if (!Array.isArray(proposal.benchmarkEvidence)) throw new GenomeRegistryIntegrityError("Growth proposal benchmarkEvidence must be an array.");
  proposal.benchmarkEvidence.forEach(assertObservation);
  if (!Array.isArray(proposal.damageEvidence)) throw new GenomeRegistryIntegrityError("Growth proposal damageEvidence must be an array.");
  proposal.damageEvidence.forEach(assertDamage);
  if (typeof proposal.novelty !== "number" || !Number.isFinite(proposal.novelty)) {
    throw new GenomeRegistryIntegrityError("Growth proposal novelty must be finite.");
  }
  if (proposal.decision !== "STAGED" && proposal.decision !== "REJECTED") {
    throw new GenomeRegistryIntegrityError("Growth proposal decision is invalid.");
  }
  if (!Array.isArray(proposal.reasons) || proposal.reasons.some((reason) => typeof reason !== "string")) {
    throw new GenomeRegistryIntegrityError("Growth proposal reasons must contain strings.");
  }
  if (digestJson(proposalDigestBody(proposal as unknown as GrowthProposal)) !== proposal.proposalDigest) {
    throw new GenomeRegistryIntegrityError("Growth proposal does not match its immutable content address.");
  }
}

function assertDsse(value: unknown): asserts value is DsseEnvelope {
  const envelope = object(value, "Promotion attestation");
  exactKeys(envelope, ["payloadType", "payload", "signatures"], "Promotion attestation");
  nonEmptyString(envelope.payloadType, "Promotion attestation payloadType");
  nonEmptyString(envelope.payload, "Promotion attestation payload");
  if (!Array.isArray(envelope.signatures) || envelope.signatures.length === 0) {
    throw new GenomeRegistryIntegrityError("Promotion attestation requires at least one signature.");
  }
  for (const [index, candidate] of envelope.signatures.entries()) {
    const signature = object(candidate, `Promotion signature[${index}]`);
    exactKeys(signature, ["keyid", "sig"], `Promotion signature[${index}]`);
    nonEmptyString(signature.keyid, `Promotion signature[${index}].keyid`);
    nonEmptyString(signature.sig, `Promotion signature[${index}].sig`);
  }
}

function promotionBody(promoted: PromotedGenome): StoredPromotionBody {
  return {
    protocol: STORED_PROMOTION_PROTOCOL,
    genome: promoted.genome,
    proposalDigest: promoted.proposalDigest,
    attestation: promoted.attestation,
    promoted: true,
  };
}

function createStoredPromotion(promoted: PromotedGenome): StoredPromotion {
  const body = promotionBody(promoted);
  return { digest: digestJson(body as unknown as JsonValue), body };
}

function assertStoredPromotion(value: unknown): asserts value is StoredPromotion {
  const promotion = object(value, "Stored promotion");
  exactKeys(promotion, ["digest", "body"], "Stored promotion");
  sha256(promotion.digest, "Stored promotion digest");
  const body = object(promotion.body, "Stored promotion body");
  exactKeys(body, ["protocol", "genome", "proposalDigest", "attestation", "promoted"], "Stored promotion body");
  if (body.protocol !== STORED_PROMOTION_PROTOCOL || body.promoted !== true) {
    throw new GenomeRegistryIntegrityError("Stored promotion protocol or promoted marker is invalid.");
  }
  assertStoredGenome(body.genome);
  sha256(body.proposalDigest, "Stored promotion proposalDigest");
  assertDsse(body.attestation);
  if (digestJson(body as unknown as JsonValue) !== promotion.digest) {
    throw new GenomeRegistryIntegrityError("Stored promotion does not match its immutable content address.");
  }
}

function pointerBody(promotion: StoredPromotion): ActiveGenomePointerBody {
  return {
    protocol: ACTIVE_GENOME_POINTER_PROTOCOL,
    genomeDigest: promotion.body.genome.digest,
    proposalDigest: promotion.body.proposalDigest,
    promotionDigest: promotion.digest,
  };
}

function createPointer(promotion: StoredPromotion): ActiveGenomePointer {
  const body = pointerBody(promotion);
  return { pointerDigest: digestJson(body as unknown as JsonValue), body };
}

function assertPointer(value: unknown): asserts value is ActiveGenomePointer {
  const pointer = object(value, "Active genome pointer");
  exactKeys(pointer, ["pointerDigest", "body"], "Active genome pointer");
  sha256(pointer.pointerDigest, "Active genome pointer digest");
  const body = object(pointer.body, "Active genome pointer body");
  exactKeys(body, ["protocol", "genomeDigest", "proposalDigest", "promotionDigest"], "Active genome pointer body");
  if (body.protocol !== ACTIVE_GENOME_POINTER_PROTOCOL) throw new GenomeRegistryIntegrityError("Active genome pointer protocol is unsupported.");
  sha256(body.genomeDigest, "Active genome pointer genomeDigest");
  sha256(body.proposalDigest, "Active genome pointer proposalDigest");
  sha256(body.promotionDigest, "Active genome pointer promotionDigest");
  if (digestJson(body as unknown as JsonValue) !== pointer.pointerDigest) {
    throw new GenomeRegistryIntegrityError("Active genome pointer digest is invalid.");
  }
}

/**
 * Durable, local, content-addressed Genome storage. CAS objects are published
 * through an exclusive hard-link and can never be replaced. The mutable active
 * pointer is the sole exception, and can only be written after governance
 * verification of a stored promotion.
 */
export class GenomeRegistry {
  readonly root: string;
  readonly #genomes: string;
  readonly #proposals: string;
  readonly #promotions: string;
  readonly #temporary: string;
  readonly #pointers: string;
  #activationQueue: Promise<void> = Promise.resolve();

  constructor(root: string) {
    if (!root.trim()) throw new TypeError("Genome registry root cannot be empty.");
    this.root = resolve(root);
    this.#genomes = join(this.root, "genomes");
    this.#proposals = join(this.root, "proposals");
    this.#promotions = join(this.root, "promotions");
    this.#temporary = join(this.root, "tmp");
    this.#pointers = join(this.root, "pointers");
  }

  async initialize(): Promise<void> {
    await Promise.all(
      [this.root, this.#genomes, this.#proposals, this.#promotions, this.#temporary, this.#pointers]
        .map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
    );
  }

  async storeGenome(genome: StoredGenome): Promise<RegistryWriteReceipt> {
    assertStoredGenome(genome);
    return this.#writeImmutable("genome", this.#genomes, genome.digest, genome as unknown as JsonValue);
  }

  async storeProposal(proposal: GrowthProposal): Promise<RegistryWriteReceipt> {
    assertGrowthProposal(proposal);
    const [parent, descendant] = await Promise.all([
      this.readGenome(proposal.parentDigest),
      this.readGenome(proposal.descendant.digest),
    ]);
    if (canonicalize(descendant as unknown as JsonValue) !== canonicalize(proposal.descendant as unknown as JsonValue)) {
      throw new GenomeRegistryIntegrityError("Growth proposal embeds a descendant different from the stored Genome.");
    }
    if (!proposal.descendant.body.parentDigests.includes(parent.digest)) {
      throw new GenomeRegistryIntegrityError("Growth proposal descendant does not name its stored parent.");
    }
    return this.#writeImmutable("proposal", this.#proposals, proposal.proposalDigest, proposal as unknown as JsonValue);
  }

  async storePromotion(promoted: PromotedGenome, governanceKeys: GovernanceKeys): Promise<RegistryWriteReceipt> {
    const [proposal, storedGenome] = await Promise.all([
      this.readProposal(promoted.proposalDigest),
      this.readGenome(promoted.genome.digest),
    ]);
    this.#assertSameGenome(storedGenome, promoted.genome, "Promotion and Genome CAS object disagree.");
    this.#verifyPromotedValue(promoted, proposal, governanceKeys);
    const stored = createStoredPromotion(promoted);
    assertStoredPromotion(stored);
    return this.#writeImmutable("promotion", this.#promotions, stored.digest, stored as unknown as JsonValue);
  }

  async readGenome(digest: string): Promise<StoredGenome> {
    sha256(digest, "Genome digest");
    const value = await this.#readCanonical(this.#objectPath(this.#genomes, digest), "Genome");
    assertStoredGenome(value);
    if (value.digest !== digest) throw new GenomeRegistryIntegrityError("Genome filename and content digest disagree.");
    return deepFreeze(value);
  }

  async readProposal(digest: string): Promise<GrowthProposal> {
    sha256(digest, "Growth proposal digest");
    const value = await this.#readCanonical(this.#objectPath(this.#proposals, digest), "Growth proposal");
    assertGrowthProposal(value);
    if (value.proposalDigest !== digest) throw new GenomeRegistryIntegrityError("Growth proposal filename and content digest disagree.");
    return deepFreeze(value);
  }

  async readPromotion(digest: string): Promise<StoredPromotion> {
    sha256(digest, "Stored promotion digest");
    const value = await this.#readCanonical(this.#objectPath(this.#promotions, digest), "Stored promotion");
    assertStoredPromotion(value);
    if (value.digest !== digest) throw new GenomeRegistryIntegrityError("Stored promotion filename and content digest disagree.");
    return deepFreeze(value);
  }

  async listGenomes(): Promise<readonly string[]> {
    return this.#list(this.#genomes, (digest) => this.readGenome(digest));
  }

  async listProposals(): Promise<readonly string[]> {
    return this.#list(this.#proposals, (digest) => this.readProposal(digest));
  }

  async listPromotions(): Promise<readonly string[]> {
    return this.#list(this.#promotions, (digest) => this.readPromotion(digest));
  }

  /**
   * Atomically changes the active pointer only after re-verifying the stored
   * proposal and DSSE. A Genome digest alone is intentionally insufficient.
   */
  async activatePromotion(digest: string, governanceKeys: GovernanceKeys): Promise<ActiveGenomePointer> {
    return this.#serializeActivation(async () => {
      const promotion = await this.readPromotion(digest);
      const [proposal, genome] = await Promise.all([
        this.readProposal(promotion.body.proposalDigest),
        this.readGenome(promotion.body.genome.digest),
      ]);
      this.#assertSameGenome(genome, promotion.body.genome, "Promotion and Genome CAS object disagree.");
      this.#verifyPromotedValue(
        {
          genome: promotion.body.genome,
          proposalDigest: promotion.body.proposalDigest,
          attestation: promotion.body.attestation,
          promoted: true,
        },
        proposal,
        governanceKeys,
      );
      const pointer = createPointer(promotion);
      await this.#writeActivePointer(pointer);
      return deepFreeze(pointer);
    });
  }

  /** Re-establishes the complete governance chain; intended for daemon startup. */
  async readActive(governanceKeys: GovernanceKeys): Promise<ActiveGenome | undefined> {
    await this.initialize();
    const path = join(this.#pointers, "active.json");
    let value: unknown;
    try {
      value = await this.#readCanonical(path, "Active genome pointer");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    assertPointer(value);
    const pointer = deepFreeze(value);
    const promotion = await this.readPromotion(pointer.body.promotionDigest);
    if (
      promotion.body.genome.digest !== pointer.body.genomeDigest ||
      promotion.body.proposalDigest !== pointer.body.proposalDigest
    ) {
      throw new GenomeRegistryIntegrityError("Active pointer does not bind the referenced promotion.");
    }
    const proposal = await this.readProposal(promotion.body.proposalDigest);
    this.#verifyPromotedValue(
      {
        genome: promotion.body.genome,
        proposalDigest: promotion.body.proposalDigest,
        attestation: promotion.body.attestation,
        promoted: true,
      },
      proposal,
      governanceKeys,
    );
    const genome = await this.readGenome(pointer.body.genomeDigest);
    this.#assertSameGenome(genome, promotion.body.genome, "Active promotion and Genome CAS object disagree.");
    return deepFreeze({ pointer, promotion, genome });
  }

  /**
   * Synchronous startup snapshot of the active Genome. This exists for hosts
   * whose public construction boundary is synchronous. It performs the same
   * complete CAS, lineage, and governance verification as `readActive`, and
   * never retains or polls the mutable pointer after returning.
   */
  readActiveSync(governanceKeys: GovernanceKeys): ActiveGenome | undefined {
    for (const directory of [this.root, this.#genomes, this.#proposals, this.#promotions, this.#temporary, this.#pointers]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const path = join(this.#pointers, "active.json");
    let value: unknown;
    try {
      value = this.#readCanonicalSync(path, "Active genome pointer");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw error;
    }
    assertPointer(value);
    const pointer = deepFreeze(value);
    const promotion = this.#readPromotionSync(pointer.body.promotionDigest);
    if (
      promotion.body.genome.digest !== pointer.body.genomeDigest ||
      promotion.body.proposalDigest !== pointer.body.proposalDigest
    ) {
      throw new GenomeRegistryIntegrityError("Active pointer does not bind the referenced promotion.");
    }
    const proposal = this.#readProposalSync(promotion.body.proposalDigest);
    this.#verifyPromotedValue(
      {
        genome: promotion.body.genome,
        proposalDigest: promotion.body.proposalDigest,
        attestation: promotion.body.attestation,
        promoted: true,
      },
      proposal,
      governanceKeys,
    );
    const genome = this.#readGenomeSync(pointer.body.genomeDigest);
    this.#assertSameGenome(genome, promotion.body.genome, "Active promotion and Genome CAS object disagree.");
    return deepFreeze({ pointer, promotion, genome });
  }

  #assertSameGenome(left: StoredGenome, right: StoredGenome, message: string): void {
    if (
      left.digest !== right.digest ||
      canonicalize(left as unknown as JsonValue) !== canonicalize(right as unknown as JsonValue)
    ) {
      throw new GenomeRegistryIntegrityError(message);
    }
  }

  #verifyPromotedValue(promoted: PromotedGenome, proposal: GrowthProposal, governanceKeys: GovernanceKeys): void {
    if (promoted.promoted !== true || promoted.proposalDigest !== proposal.proposalDigest) {
      throw new GenomeRegistryGovernanceError("Promotion does not bind the stored growth proposal.");
    }
    if (
      promoted.genome.digest !== proposal.descendant.digest ||
      canonicalize(promoted.genome as unknown as JsonValue) !== canonicalize(proposal.descendant as unknown as JsonValue)
    ) {
      throw new GenomeRegistryGovernanceError("Promotion Genome differs from the staged descendant.");
    }
    try {
      const verified = promoteGenome(proposal, promoted.attestation, governanceKeys);
      if (
        verified.genome.digest !== promoted.genome.digest ||
        verified.proposalDigest !== promoted.proposalDigest
      ) {
        throw new Error("verified promotion value differs");
      }
    } catch (error) {
      throw new GenomeRegistryGovernanceError(
        `Promotion governance attestation is invalid: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  async #writeImmutable(
    kind: GenomeRegistryObjectKind,
    directory: string,
    digest: string,
    value: JsonValue,
  ): Promise<RegistryWriteReceipt> {
    await this.initialize();
    const bytes = canonicalize(value);
    if (Buffer.byteLength(bytes, "utf8") > MAX_REGISTRY_OBJECT_BYTES) {
      throw new GenomeRegistryIntegrityError(`${kind} exceeds the registry object size limit.`);
    }
    const destination = this.#objectPath(directory, digest);
    const temporary = join(this.#temporary, `${kind}-${digest.slice("sha256:".length)}-${process.pid}-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    let status: RegistryWriteReceipt["status"] = "STORED";
    try {
      try {
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // A same-filesystem hard link atomically publishes the fully-fsynced inode
      // and fails with EEXIST instead of ever replacing an immutable address.
      await link(temporary, destination);
      await this.#syncDirectory(directory);
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const existing = await this.#readRaw(destination, `${kind} at ${digest}`);
      if (!existing.equals(Buffer.from(bytes, "utf8"))) {
        throw new GenomeRegistryIntegrityError(`Immutable ${kind} address is occupied by different or corrupt bytes.`);
      }
      status = "ALREADY_PRESENT";
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
    return Object.freeze({ kind, digest, status });
  }

  async #writeActivePointer(pointer: ActiveGenomePointer): Promise<void> {
    await this.initialize();
    const bytes = canonicalize(pointer as unknown as JsonValue);
    const temporary = join(this.#pointers, `.active-${process.pid}-${randomUUID()}.tmp`);
    const destination = join(this.#pointers, "active.json");
    const handle = await open(temporary, "wx", 0o600);
    try {
      try {
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, destination);
      await this.#syncDirectory(this.#pointers);
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isErrno(error, "ENOENT")) throw error;
      });
    }
  }

  async #serializeActivation<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.#activationQueue;
    let release!: () => void;
    this.#activationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await prior;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #list<T>(directory: string, verify: (digest: string) => Promise<T>): Promise<readonly string[]> {
    await this.initialize();
    const entries = await readdir(directory, { withFileTypes: true });
    const digests: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !DIGEST_FILE_PATTERN.test(entry.name)) {
        throw new GenomeRegistryIntegrityError(`Unexpected entry in immutable registry directory: ${entry.name}`);
      }
      digests.push(`sha256:${entry.name.slice(0, -".json".length)}`);
    }
    digests.sort();
    for (const digest of digests) await verify(digest);
    return Object.freeze(digests);
  }

  #objectPath(directory: string, digest: string): string {
    sha256(digest, "Registry object digest");
    return join(directory, `${digest.slice("sha256:".length)}.json`);
  }

  async #readRaw(path: string, label: string): Promise<Buffer> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new GenomeRegistryIntegrityError(`${label} is not a regular immutable file.`);
    }
    if (info.size > MAX_REGISTRY_OBJECT_BYTES) {
      throw new GenomeRegistryIntegrityError(`${label} exceeds the registry object size limit.`);
    }
    return readFile(path);
  }

  async #readCanonical(path: string, label: string): Promise<unknown> {
    const bytes = await this.#readRaw(path, label);
    let value: unknown;
    try {
      value = parseJsonBytes(bytes, label);
    } catch (cause) {
      const detail = cause instanceof Error ? ` ${cause.message}` : "";
      throw new GenomeRegistryIntegrityError(`${label} contains malformed or ambiguous UTF-8 JSON.${detail}`, { cause });
    }
    let canonical: string;
    try {
      canonical = canonicalize(value as JsonValue);
    } catch (error) {
      throw new GenomeRegistryIntegrityError(`${label} is not canonical JSON: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!bytes.equals(Buffer.from(canonical, "utf8"))) throw new GenomeRegistryIntegrityError(`${label} has non-canonical or altered bytes.`);
    return value;
  }

  #readGenomeSync(digest: string): StoredGenome {
    sha256(digest, "Genome digest");
    const value = this.#readCanonicalSync(this.#objectPath(this.#genomes, digest), "Genome");
    assertStoredGenome(value);
    if (value.digest !== digest) throw new GenomeRegistryIntegrityError("Genome filename and content digest disagree.");
    return deepFreeze(value);
  }

  #readProposalSync(digest: string): GrowthProposal {
    sha256(digest, "Growth proposal digest");
    const value = this.#readCanonicalSync(this.#objectPath(this.#proposals, digest), "Growth proposal");
    assertGrowthProposal(value);
    if (value.proposalDigest !== digest) throw new GenomeRegistryIntegrityError("Growth proposal filename and content digest disagree.");
    return deepFreeze(value);
  }

  #readPromotionSync(digest: string): StoredPromotion {
    sha256(digest, "Stored promotion digest");
    const value = this.#readCanonicalSync(this.#objectPath(this.#promotions, digest), "Stored promotion");
    assertStoredPromotion(value);
    if (value.digest !== digest) throw new GenomeRegistryIntegrityError("Stored promotion filename and content digest disagree.");
    return deepFreeze(value);
  }

  #readCanonicalSync(path: string, label: string): unknown {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new GenomeRegistryIntegrityError(`${label} is not a regular immutable file.`);
    }
    if (info.size > MAX_REGISTRY_OBJECT_BYTES) {
      throw new GenomeRegistryIntegrityError(`${label} exceeds the registry object size limit.`);
    }
    const bytes = readFileSync(path);
    let value: unknown;
    try {
      value = parseJsonBytes(bytes, label);
    } catch (cause) {
      const detail = cause instanceof Error ? ` ${cause.message}` : "";
      throw new GenomeRegistryIntegrityError(`${label} contains malformed or ambiguous UTF-8 JSON.${detail}`, { cause });
    }
    let canonical: string;
    try {
      canonical = canonicalize(value as JsonValue);
    } catch (error) {
      throw new GenomeRegistryIntegrityError(`${label} is not canonical JSON: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    if (!bytes.equals(Buffer.from(canonical, "utf8"))) throw new GenomeRegistryIntegrityError(`${label} has non-canonical or altered bytes.`);
    return value;
  }

  async #syncDirectory(directory: string): Promise<void> {
    let handle;
    try {
      handle = await open(directory, "r");
      await handle.sync();
    } catch (error) {
      // Windows does not expose directory fsync. File fsync plus atomic link or
      // rename still supplies the strongest semantics available there.
      if (process.platform !== "win32") throw error;
    } finally {
      await handle?.close();
    }
  }
}
