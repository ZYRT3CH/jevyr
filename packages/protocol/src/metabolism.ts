import { digestJson, isSha256Digest, type JsonValue } from "./canonical.js";
import type { DsseEnvelope } from "./types.js";

export const METABOLIC_KINDS = ["Mass", "Refraction", "Polarity", "Fission", "Inertia"] as const;
export type MetabolicKind = typeof METABOLIC_KINDS[number];
export const METABOLIC_RESOURCE_KEYS = ["maxMindInvocations", "maxInputTokens", "maxOutputTokens", "maxWallMillis", "maxGeneratedBytes", "maxForgeCpuMillis", "maxForgeWallMillis", "maxMemorySeconds", "maxWritableBytes", "maxWritableInodes", "maxArtifactBytes", "maxTotalAssayCost"] as const;
export type MetabolicResourceVector = Readonly<Record<typeof METABOLIC_RESOURCE_KEYS[number], number>>;
export const METABOLIC_WORK_KEYS = ["general", "unfamiliarFamilies", "counterbelief", "isolatedLanes", "scentContinuation"] as const;
export const METABOLIC_WORK_FOR_KIND = Object.freeze({ Mass: "general", Refraction: "unfamiliarFamilies", Polarity: "counterbelief", Fission: "isolatedLanes", Inertia: "scentContinuation" } as const);
export type MetabolicWork = Readonly<Record<typeof METABOLIC_WORK_KEYS[number], number>>;
export const METABOLISM_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.metabolism-receipt+json";

export interface MetabolicInterval { readonly lower: number; readonly upper: number; readonly confidence: 0.95 }
export interface MetabolicCalibrationSummary {
  readonly digest: string;
  readonly scope: string;
  readonly pairedSeeds: number;
  readonly doses: readonly number[];
  readonly monotonic: true;
  readonly identicalEvidenceJudgment: true;
  readonly recallDifference: MetabolicInterval;
  readonly reproducibilityDifference: MetabolicInterval;
  readonly nonInferiorityMargin: number;
  readonly maximumObservedUnitResources: MetabolicResourceVector;
}
export interface MetabolicAllowance {
  readonly protocol: "jevyr.metabolic-allowance/1";
  readonly baselineSearchDigest: string;
  readonly maximumAddedResources: MetabolicResourceVector;
  readonly maximumQuantityPerBall: number;
  readonly maximumReceipts: number;
  readonly unitCostCeilings: Readonly<Record<MetabolicKind, MetabolicResourceVector>>;
  readonly calibrationSetDigest: string;
  readonly calibrations: readonly { readonly kind: MetabolicKind; readonly digest: string; readonly summaryDigest: string; readonly maximumDose: number }[];
  readonly signer: { readonly keyId: string; readonly publicKeyPem: string };
  readonly digest: string;
}
export interface MetabolicOffer {
  readonly ballId: string;
  readonly kind: MetabolicKind;
  readonly minQuantity: 1;
  readonly maxQuantity: number;
  readonly promisedEffect: string;
  readonly unitCostCeiling: MetabolicResourceVector;
  readonly unitWork: MetabolicWork;
  readonly calibration: MetabolicCalibrationSummary;
}
export interface MetabolicOffers {
  readonly protocol: "jevyr.metabolic-offers/1";
  readonly caseId: string;
  readonly runDigest: string;
  readonly allowanceDigest: string;
  readonly baselineSearchDigest: string;
  readonly admission: "open" | "closed";
  readonly cumulativeGrant: MetabolicResourceVector;
  readonly cumulativeQuantities: Readonly<Record<MetabolicKind, number>>;
  readonly offers: readonly MetabolicOffer[];
  readonly receipts: readonly MetabolicRedemption[];
}
export interface MetabolicReceipt {
  readonly protocol: "jevyr.metabolism-receipt/1";
  readonly caseId: string;
  readonly caseDigest: string;
  readonly runDigest: string;
  readonly policyDigest: string;
  readonly searchDigest: string;
  readonly allowanceDigest: string;
  readonly calibrationDigest: string;
  readonly ballId: string;
  readonly kind: MetabolicKind;
  readonly quantity: number;
  readonly sequence: number;
  readonly previousReceiptDigest: string | null;
  readonly issuedAt: string;
  readonly grant: MetabolicResourceVector;
  readonly cumulativeGrant: MetabolicResourceVector;
  readonly cumulativeQuantities: Readonly<Record<MetabolicKind, number>>;
  readonly work: MetabolicWork;
  readonly baselineUnchanged: true;
  readonly verdictAuthority: "none";
  readonly digest: string;
}
export interface MetabolicRedemption {
  readonly protocol: "jevyr.metabolism-redemption/1";
  readonly receipt: MetabolicReceipt;
  readonly envelope: DsseEnvelope;
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be an ordinary object`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(descriptors, key)) || Object.values(descriptors).some((entry) => !entry.enumerable || !Object.hasOwn(entry, "value"))) throw new TypeError(`${label} has an unknown, missing, or accessor field`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new TypeError(`${label} must be an integer from ${min} through ${max}`);
}
function text(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} must be bounded text`);
}
export function assertMetabolicResourceVector(value: unknown): asserts value is MetabolicResourceVector {
  const vector = object(value, METABOLIC_RESOURCE_KEYS, "Metabolic resources");
  for (const key of METABOLIC_RESOURCE_KEYS) integer(vector[key], 0, Number.MAX_SAFE_INTEGER, key);
}
export function assertMetabolicWork(value: unknown): asserts value is MetabolicWork {
  const work = object(value, METABOLIC_WORK_KEYS, "Metabolic work");
  for (const key of METABOLIC_WORK_KEYS) integer(work[key], 0, 1_000_000, key);
}
export function assertMetabolicAllowance(value: unknown): asserts value is MetabolicAllowance {
  const allowance = object(value, ["protocol", "baselineSearchDigest", "maximumAddedResources", "maximumQuantityPerBall", "maximumReceipts", "unitCostCeilings", "calibrationSetDigest", "calibrations", "signer", "digest"], "Metabolic allowance");
  if (allowance.protocol !== "jevyr.metabolic-allowance/1") throw new TypeError("Unknown metabolic allowance protocol");
  for (const key of ["baselineSearchDigest", "calibrationSetDigest", "digest"]) if (!isSha256Digest(allowance[key])) throw new TypeError(`Invalid metabolic ${key}`);
  integer(allowance.maximumQuantityPerBall, 1, 64, "maximumQuantityPerBall");
  integer(allowance.maximumReceipts, 1, 4096, "maximumReceipts");
  assertMetabolicResourceVector(allowance.maximumAddedResources);
  if (!Array.isArray(allowance.calibrations) || allowance.calibrations.length > METABOLIC_KINDS.length) throw new TypeError("Metabolic calibration set is unbounded");
  const kinds = new Set<string>();
  for (const calibration of allowance.calibrations) {
    const item = object(calibration, ["kind", "digest", "summaryDigest", "maximumDose"], "Metabolic calibration binding");
    if (!METABOLIC_KINDS.includes(item.kind as MetabolicKind) || kinds.has(String(item.kind)) || !isSha256Digest(item.digest) || !isSha256Digest(item.summaryDigest)) throw new TypeError("Metabolic calibration kind is repeated or invalid");
    integer(item.maximumDose, 2, 64, "maximumDose"); kinds.add(String(item.kind));
  }
  const reports = allowance.calibrations.map((item: { kind: string; digest: string }) => ({ kind: item.kind, digest: item.digest })).sort((a: {kind: string}, b: {kind: string}) => a.kind.localeCompare(b.kind));
  if (digestJson({ protocol: "jevyr.metabolic-calibration-set/1", reports }) !== allowance.calibrationSetDigest) throw new TypeError("Metabolic calibration set digest mismatch");
  const doses = object(allowance.unitCostCeilings, METABOLIC_KINDS, "Metabolic dose ceilings");
  for (const kind of METABOLIC_KINDS) {
    assertMetabolicResourceVector(doses[kind]);
    for (const key of METABOLIC_RESOURCE_KEYS) if (doses[kind][key] > allowance.maximumAddedResources[key]) throw new TypeError("A dose exceeds the sealed additive allowance");
  }
  const signer = object(allowance.signer, ["keyId", "publicKeyPem"], "Metabolic signer");
  if (!isSha256Digest(signer.keyId) || typeof signer.publicKeyPem !== "string" || signer.publicKeyPem.length > 1024 || !signer.publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----\n")) throw new TypeError("Invalid metabolic public signer");
  const { digest, ...body } = allowance;
  if (digestJson(body as JsonValue) !== digest) throw new TypeError("Metabolic allowance digest mismatch");
}
export function assertMetabolicReceipt(value: unknown): asserts value is MetabolicReceipt {
  const receipt = object(value, ["protocol", "caseId", "caseDigest", "runDigest", "policyDigest", "searchDigest", "allowanceDigest", "calibrationDigest", "ballId", "kind", "quantity", "sequence", "previousReceiptDigest", "issuedAt", "grant", "cumulativeGrant", "cumulativeQuantities", "work", "baselineUnchanged", "verdictAuthority", "digest"], "Metabolic receipt");
  if (receipt.protocol !== "jevyr.metabolism-receipt/1" || receipt.baselineUnchanged !== true || receipt.verdictAuthority !== "none" || !METABOLIC_KINDS.includes(receipt.kind as MetabolicKind)) throw new TypeError("Metabolic receipt changes semantic authority or has an unknown kind");
  text(receipt.caseId, 256, "caseId");
  if (typeof receipt.ballId !== "string" || !/^ball_[A-Za-z0-9_-]{43}$/u.test(receipt.ballId)) throw new TypeError("ballId must be a server-issued opaque identity");
  for (const key of ["caseDigest", "runDigest", "policyDigest", "searchDigest", "allowanceDigest", "calibrationDigest", "digest"]) if (!isSha256Digest(receipt[key])) throw new TypeError(`Invalid metabolic ${key}`);
  integer(receipt.quantity, 1, 64, "quantity"); integer(receipt.sequence, 1, 4096, "sequence");
  if (receipt.sequence === 1 ? receipt.previousReceiptDigest !== null : !isSha256Digest(receipt.previousReceiptDigest)) throw new TypeError("Metabolic receipt has an invalid prior link");
  if (typeof receipt.issuedAt !== "string" || !Number.isFinite(Date.parse(receipt.issuedAt)) || new Date(receipt.issuedAt).toISOString() !== receipt.issuedAt) throw new TypeError("Metabolic issuedAt must be canonical UTC time");
  assertMetabolicResourceVector(receipt.grant); assertMetabolicResourceVector(receipt.cumulativeGrant); assertMetabolicWork(receipt.work);
  const quantities = object(receipt.cumulativeQuantities, METABOLIC_KINDS, "Metabolic cumulative doses");
  for (const kind of METABOLIC_KINDS) integer(quantities[kind], 0, 64, `cumulativeQuantities.${kind}`);
  for (const key of METABOLIC_WORK_KEYS) if (receipt.work[key] !== (key === METABOLIC_WORK_FOR_KIND[receipt.kind as MetabolicKind] ? receipt.quantity : 0)) throw new TypeError("Metabolic work differs from its exact offered kind and quantity");
  for (const key of METABOLIC_RESOURCE_KEYS) if (receipt.grant[key] > receipt.cumulativeGrant[key]) throw new TypeError("Metabolic cumulative grant is smaller than its addition");
  const { digest, ...body } = receipt;
  if (digestJson(body as JsonValue) !== digest) throw new TypeError("Metabolic receipt digest mismatch");
}

/** Independently check every addition against the presealed allowance and prior link. */
export function assertMetabolicGrant(receipt: MetabolicReceipt, allowance: MetabolicAllowance, previous?: MetabolicReceipt): void {
  assertMetabolicReceipt(receipt); assertMetabolicAllowance(allowance);
  if (receipt.allowanceDigest !== allowance.digest || receipt.searchDigest !== allowance.baselineSearchDigest || receipt.quantity > allowance.maximumQuantityPerBall || receipt.sequence > allowance.maximumReceipts) throw new TypeError("Metabolic receipt exceeds or substitutes its sealed allowance");
  if (receipt.sequence !== (previous?.sequence ?? 0) + 1 || receipt.previousReceiptDigest !== (previous?.digest ?? null)) throw new TypeError("Metabolic receipt sequence has a gap or invalid predecessor");
  if (previous && ["caseId", "caseDigest", "runDigest", "policyDigest", "searchDigest", "allowanceDigest"].some((key) => receipt[key as keyof MetabolicReceipt] !== previous[key as keyof MetabolicReceipt])) throw new TypeError("Metabolic receipts cross a sealed identity boundary");
  const calibration = allowance.calibrations.find((entry) => entry.kind === receipt.kind);
  if (!calibration || calibration.digest !== receipt.calibrationDigest) throw new TypeError("Metabolic receipt uses an uncalibrated kind or substituted evidence");
  for (const kind of METABOLIC_KINDS) {
    const expected = (previous?.cumulativeQuantities[kind] ?? 0) + (kind === receipt.kind ? receipt.quantity : 0);
    if (receipt.cumulativeQuantities[kind] !== expected || expected > (allowance.calibrations.find((entry) => entry.kind === kind)?.maximumDose ?? 0)) throw new TypeError("Metabolic cumulative dose exceeds its measured calibration");
  }
  for (const key of METABOLIC_RESOURCE_KEYS) {
    if (BigInt(receipt.grant[key]) !== BigInt(allowance.unitCostCeilings[receipt.kind][key]) * BigInt(receipt.quantity)
      || receipt.cumulativeGrant[key] !== (previous?.cumulativeGrant[key] ?? 0) + receipt.grant[key]
      || receipt.cumulativeGrant[key] > allowance.maximumAddedResources[key]) throw new TypeError(`Metabolic ${key} exceeds its exact additive grant`);
  }
}
