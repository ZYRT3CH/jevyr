import { randomBytes } from "node:crypto";
import { canonicalize, digestJson, METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, METABOLIC_WORK_KEYS, METABOLIC_WORK_FOR_KIND, METABOLISM_DSSE_PAYLOAD_TYPE,
  assertMetabolicAllowance, assertMetabolicGrant, type MetabolicAllowance, type MetabolicKind, type MetabolicOffer, type MetabolicOffers, type MetabolicReceipt,
  type MetabolicRedemption, type MetabolicResourceVector, type MetabolicWork, type SearchEnvelope, type SealedCase, type JsonValue } from "@jevyr/protocol";
import { keyIdFor, verifyDsse } from "@jevyr/core";
import { assertVerifiedMetabolicCalibration, metabolicCalibrationSetDigest, metabolicImplementationDigest, type VerifiedMetabolicCalibration } from "./juggler-calibration.js";
import { INERTIA_SCENT_POLICY } from "./inertia-scent.js";

export const LIVE_JUGGLER_POLICY_DESCRIPTOR = Object.freeze({ protocol: "jevyr.juggler-policy/3", semanticInput: false, baselineMutable: false, capabilitiesMutable: false,
  issuance: "calibrated-offered-kind-and-bounded-quantity", redemption: "signed-sequenced-additions-before-work-admission-closes", allowance: "separate-presealed-additive-resource-vector", kinds: METABOLIC_KINDS,
  perCallLimitsMutable: false, networkAuthorityMutable: false, obligationsMutable: false, confidence: 0.95, maximumNonInferiorityMargin: 0.1, inertia: INERTIA_SCENT_POLICY });
const PROMISES: Readonly<Record<MetabolicKind, string>> = Object.freeze({
  Mass: "Add investigation effort without removing baseline work.",
  Refraction: "Add exploration of an unfamiliar permitted test family.",
  Polarity: "Add an attempt to overturn the currently leading belief.",
  Fission: "Add an isolated investigative lane that commits before sharing.",
  Inertia: "Add a continuation of a scent below the ordinary evidence-value threshold.",
});
const ZERO = Object.freeze(Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => [key, 0])) as unknown as MetabolicResourceVector);
function freeze<T>(value: T): T { if (value !== null && typeof value === "object") { Object.freeze(value); for (const child of Object.values(value as object)) freeze(child); } return value; }
function hash(value: unknown): string { return digestJson(value as JsonValue); }
function multiply(vector: MetabolicResourceVector, quantity: number): MetabolicResourceVector {
  return Object.freeze(Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => {
    const value = BigInt(vector[key]) * BigInt(quantity);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Metabolic resource addition exceeds integer precision");
    return [key, Number(value)];
  })) as unknown as MetabolicResourceVector);
}
function add(first: MetabolicResourceVector, second: MetabolicResourceVector): MetabolicResourceVector {
  return Object.freeze(Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => {
    const value = BigInt(first[key]) + BigInt(second[key]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Metabolic resource total exceeds integer precision");
    return [key, Number(value)];
  })) as unknown as MetabolicResourceVector);
}
function work(kind: MetabolicKind, quantity: number): MetabolicWork {
  return Object.freeze(Object.fromEntries(METABOLIC_WORK_KEYS.map((key) => [key, key === METABOLIC_WORK_FOR_KIND[kind] ? quantity : 0])) as unknown as MetabolicWork);
}

/** A separate presealed permission. The original SearchEnvelope is never changed. */
export function createMetabolicAllowance(search: SearchEnvelope, signer: MetabolicAllowance["signer"], calibrations: readonly VerifiedMetabolicCalibration[], options: { maximumQuantityPerBall?: number; maximumReceipts?: number } = {}): MetabolicAllowance {
  if (keyIdFor(signer.publicKeyPem) !== signer.keyId) throw new TypeError("Metabolic signer fingerprint differs from public key");
  const baseline = search.profile.resources;
  const maximumAddedResources = Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => [key, baseline[key]])) as unknown as MetabolicResourceVector;
  for (const key of METABOLIC_RESOURCE_KEYS) if (BigInt(baseline[key]) * 2n > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Baseline plus additive allowance exceeds safe accounting precision");
  const unit = Object.freeze(Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => [key, baseline.maxMindInvocations === 0 ? 0 : key === "maxMindInvocations" ? 1 : Math.ceil(baseline[key] / baseline.maxMindInvocations)])) as unknown as MetabolicResourceVector);
  const body = { protocol: "jevyr.metabolic-allowance/1" as const, baselineSearchDigest: search.digest, maximumAddedResources,
    maximumQuantityPerBall: options.maximumQuantityPerBall ?? 8, maximumReceipts: options.maximumReceipts ?? 128,
    unitCostCeilings: Object.fromEntries(METABOLIC_KINDS.map((kind) => [kind, unit])) as unknown as MetabolicAllowance["unitCostCeilings"],
    calibrationSetDigest: metabolicCalibrationSetDigest(calibrations), calibrations: calibrations.map((entry) => ({ kind: entry.kind, digest: entry.summary.digest, summaryDigest: hash(entry.summary), maximumDose: entry.maximumDose })).sort((a, b) => a.kind.localeCompare(b.kind)), signer: { keyId: signer.keyId, publicKeyPem: signer.publicKeyPem } };
  const value = freeze({ ...body, digest: hash(body) });
  assertMetabolicAllowance(value);
  return value;
}

export function metabolicAllowanceFromPolicyDescriptor(value: unknown): MetabolicAllowance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const policy = (value as { policy?: unknown }).policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const allowance = (policy as { metabolicAllowance?: unknown }).metabolicAllowance;
  if (allowance === undefined) return undefined;
  assertMetabolicAllowance(allowance);
  return allowance;
}

/** Verify the separate metabolic signature without extending Seal/Record/terminal trust. */
export function assertSignedMetabolicRedemption(value: MetabolicRedemption, allowance: MetabolicAllowance, previous?: MetabolicReceipt): void {
  if (!value || Object.keys(value).sort().join(",") !== "envelope,protocol,receipt" || value.protocol !== "jevyr.metabolism-redemption/1") throw new TypeError("Unknown metabolic redemption wrapper");
  assertMetabolicGrant(value.receipt, allowance, previous);
  if (keyIdFor(allowance.signer.publicKeyPem) !== allowance.signer.keyId || value.envelope.payloadType !== METABOLISM_DSSE_PAYLOAD_TYPE
    || value.envelope.signatures.length !== 1 || value.envelope.signatures[0]!.keyid !== allowance.signer.keyId
    || !verifyDsse(value.envelope, new Map([[allowance.signer.keyId, allowance.signer.publicKeyPem]]))
    || Buffer.from(value.envelope.payload, "base64").toString("utf8") !== canonicalize(value.receipt as unknown as JsonValue)) throw new TypeError("Metabolic receipt does not verify under the exact sealed signer");
}

export interface LiveJugglerOptions {
  readonly policyDescriptor: JsonValue;
  readonly calibrations: readonly VerifiedMetabolicCalibration[];
  /** Must persist signature, artifact inventory and public action before returning. */
  readonly commit: (receipt: MetabolicReceipt) => Promise<MetabolicRedemption>;
  readonly now?: () => string;
  readonly initialEligibleKinds?: readonly MetabolicKind[];
}

/** Live additive channel. No input can name a file, candidate, tool, obligation or conclusion. */
export class LiveJugglerBook {
  readonly #sealed: SealedCase;
  readonly #allowance: MetabolicAllowance;
  readonly #calibrations = new Map<MetabolicKind, VerifiedMetabolicCalibration>();
  readonly #balls = new Map<string, MetabolicKind>();
  readonly #dosed = new Map<MetabolicKind, number>();
  readonly #receipts: MetabolicRedemption[] = [];
  readonly #pending: MetabolicReceipt[] = [];
  #eligible = new Set<MetabolicKind>(METABOLIC_KINDS);
  #contextQuantities: Partial<Record<MetabolicKind, number>> = {};
  #contextDoseBaseline = new Map<MetabolicKind, number>();
  readonly #options: LiveJugglerOptions;
  #cumulative = ZERO;
  #closed = false;
  #closing = false;
  #failure: Error | undefined;
  #serial: Promise<unknown> = Promise.resolve();

  constructor(sealed: SealedCase, options: LiveJugglerOptions) {
    if (sealed.intent.control !== "juggler") throw new TypeError("Sovereign runs have no metabolic admission channel");
    if (hash(options.policyDescriptor) !== sealed.policyDigest) throw new TypeError("Metabolic policy descriptor does not match the sealed Case");
    const allowance = metabolicAllowanceFromPolicyDescriptor(options.policyDescriptor);
    if (!allowance || allowance.baselineSearchDigest !== sealed.searchEnvelope.digest) throw new TypeError("The Case has no separately sealed additive allowance");
    if (metabolicCalibrationSetDigest(options.calibrations) !== allowance.calibrationSetDigest) throw new TypeError("Metabolic calibration set differs from sealed policy");
    this.#allowance = freeze(structuredClone(allowance)); this.#sealed = freeze(structuredClone(sealed)); this.#options = options;
    if (options.initialEligibleKinds) this.#eligible = new Set(options.initialEligibleKinds);
    const implementationDigest = metabolicImplementationDigest();
    for (const calibration of options.calibrations) {
      assertVerifiedMetabolicCalibration(calibration);
      if (calibration.implementationDigest !== implementationDigest) throw new TypeError("Metabolic scheduler changed since calibration");
      const binding = allowance.calibrations.find((entry) => entry.kind === calibration.kind);
      if (binding?.summaryDigest !== hash(calibration.summary) || binding.maximumDose !== calibration.maximumDose) throw new TypeError("Metabolic calibration summary differs from the sealed policy");
      this.#calibrations.set(calibration.kind, calibration);
      this.#balls.set(`ball_${randomBytes(32).toString("base64url")}`, calibration.kind);
    }
  }
  #quantity(kind: MetabolicKind): number {
    if (!this.#eligible.has(kind)) return 0;
    const calibration = this.#calibrations.get(kind)!;
    const unit = this.#allowance.unitCostCeilings[kind];
    if (METABOLIC_RESOURCE_KEYS.some((key) => unit[key] < calibration.summary.maximumObservedUnitResources[key])) return 0;
    if (unit.maxMindInvocations < 1 || unit.maxInputTokens < 1 || unit.maxOutputTokens < 1 || unit.maxWallMillis < 1 || unit.maxGeneratedBytes < 1) return 0;
    const contextQuantity = this.#contextQuantities[kind];
    const available = contextQuantity === undefined ? 64 : contextQuantity - ((this.#dosed.get(kind) ?? 0) - (this.#contextDoseBaseline.get(kind) ?? 0));
    let maximum = Math.min(this.#allowance.maximumQuantityPerBall, calibration.maximumDose - (this.#dosed.get(kind) ?? 0), available);
    for (const key of METABOLIC_RESOURCE_KEYS) if (unit[key] > 0) maximum = Math.min(maximum, Math.floor((this.#allowance.maximumAddedResources[key] - this.#cumulative[key]) / unit[key]));
    return Math.max(0, maximum);
  }
  offers(): MetabolicOffers {
    const closed = this.#closed || this.#closing || this.#failure !== undefined || this.#receipts.length >= this.#allowance.maximumReceipts;
    const offers: MetabolicOffer[] = [];
    if (!closed) for (const [ballId, kind] of this.#balls) {
      const maxQuantity = this.#quantity(kind);
      if (maxQuantity > 0) offers.push(freeze({ ballId, kind, minQuantity: 1 as const, maxQuantity, promisedEffect: PROMISES[kind], unitCostCeiling: this.#allowance.unitCostCeilings[kind], unitWork: work(kind, 1), calibration: this.#calibrations.get(kind)!.summary }));
    }
    return freeze({ protocol: "jevyr.metabolic-offers/1", caseId: this.#sealed.caseId, runDigest: this.#sealed.runDigest,
      allowanceDigest: this.#allowance.digest, baselineSearchDigest: this.#sealed.searchEnvelope.digest, admission: closed ? "closed" : "open", cumulativeGrant: { ...this.#cumulative }, cumulativeQuantities: Object.fromEntries(METABOLIC_KINDS.map((kind) => [kind, this.#dosed.get(kind) ?? 0])) as Record<MetabolicKind, number>, offers, receipts: this.history() });
  }
  /** Promise serialization provides unique receipt order under concurrent HTTP requests. */
  redeem(value: unknown): Promise<MetabolicRedemption> {
    if (this.#closed || this.#closing || this.#failure) return Promise.reject(new Error("Metabolic work admission has closed"));
    if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, "ballId") || !Object.hasOwn(value, "quantity") || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !Object.hasOwn(entry, "value"))) return Promise.reject(new TypeError("Metabolism accepts exactly an offered ballId and quantity"));
    const request = value as { ballId: unknown; quantity: unknown };
    if (typeof request.ballId !== "string" || !/^ball_[A-Za-z0-9_-]{43}$/u.test(request.ballId) || !Number.isSafeInteger(request.quantity) || Number(request.quantity) < 1 || Number(request.quantity) > 64) return Promise.reject(new TypeError("Invalid offered ball identity or bounded quantity"));
    const ballId = request.ballId, quantity = Number(request.quantity);
    const operation = this.#serial.then(async () => {
      if (this.#closed || this.#failure) throw new Error("Metabolic work admission has closed");
      const kind = this.#balls.get(ballId);
      if (!kind || this.#receipts.length >= this.#allowance.maximumReceipts || quantity > this.#quantity(kind)) throw new Error("Ball is foreign, spent, uncalibrated, or beyond its remaining offered quantity");
      const grant = multiply(this.#allowance.unitCostCeilings[kind], quantity);
      const previous = this.#receipts.at(-1)?.receipt;
      const body = { protocol: "jevyr.metabolism-receipt/1" as const, caseId: this.#sealed.caseId, caseDigest: this.#sealed.caseDigest, runDigest: this.#sealed.runDigest,
        policyDigest: this.#sealed.policyDigest, searchDigest: this.#sealed.searchEnvelope.digest, allowanceDigest: this.#allowance.digest,
        calibrationDigest: this.#calibrations.get(kind)!.summary.digest, ballId, kind, quantity, sequence: this.#receipts.length + 1, previousReceiptDigest: previous?.digest ?? null,
        issuedAt: this.#options.now?.() ?? new Date().toISOString(), grant, cumulativeGrant: add(this.#cumulative, grant), cumulativeQuantities: Object.fromEntries(METABOLIC_KINDS.map((entry) => [entry, (this.#dosed.get(entry) ?? 0) + (entry === kind ? quantity : 0)])) as Record<MetabolicKind, number>, work: work(kind, quantity), baselineUnchanged: true as const, verdictAuthority: "none" as const };
      const receipt: MetabolicReceipt = freeze({ ...body, digest: hash(body) });
      assertMetabolicGrant(receipt, this.#allowance, previous);
      let committed: MetabolicRedemption;
      try {
        committed = await this.#options.commit(receipt);
        assertSignedMetabolicRedemption(committed, this.#allowance, previous);
        if (hash(committed.receipt) !== hash(receipt)) throw new Error("Signer substituted a metabolic receipt");
      } catch (error) { this.#failure = new Error("Metabolic signing or durable publication failed", { cause: error }); throw this.#failure; }
      this.#receipts.push(freeze(structuredClone(committed))); this.#cumulative = receipt.cumulativeGrant;
      this.#dosed.set(kind, (this.#dosed.get(kind) ?? 0) + quantity); this.#pending.push(receipt);
      return freeze(structuredClone(committed));
    });
    this.#serial = operation.catch(() => undefined);
    return operation;
  }
  async takePendingGrants(): Promise<readonly MetabolicReceipt[]> {
    await this.#serial;
    if (this.#failure) throw this.#failure;
    return Object.freeze(this.#pending.splice(0));
  }
  history(): readonly MetabolicRedemption[] { return freeze(structuredClone(this.#receipts)); }
  /** Scheduler-owned context eligibility, never a user-controlled target or priority. */
  setEligibleKinds(kinds: readonly MetabolicKind[], availableQuantities: Partial<Record<MetabolicKind, number>> = {}): void {
    if (kinds.some((kind) => !METABOLIC_KINDS.includes(kind))) throw new TypeError("Unknown metabolic kind");
    if (Object.entries(availableQuantities).some(([kind, quantity]) => !METABOLIC_KINDS.includes(kind as MetabolicKind) || !Number.isSafeInteger(quantity) || quantity! < 0 || quantity! > 256)) throw new TypeError("Invalid metabolic context availability");
    this.#eligible = new Set(kinds);
    this.#contextQuantities = { ...availableQuantities };
    this.#contextDoseBaseline = new Map(this.#dosed);
  }
  /** Close before population/assay commitment; already signed queued work remains drainable. */
  async closeAdmission(): Promise<void> { this.#closing = true; await this.#serial; this.#closed = true; }
}
