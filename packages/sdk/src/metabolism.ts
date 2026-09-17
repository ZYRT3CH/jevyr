import { assertMetabolicAllowance, assertMetabolicGrant, assertMetabolicReceipt, assertMetabolicResourceVector, assertMetabolicWork, METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, METABOLIC_WORK_FOR_KIND, METABOLIC_WORK_KEYS, METABOLISM_DSSE_PAYLOAD_TYPE, type MetabolicAllowance, type MetabolicOffers, type MetabolicReceipt, type MetabolicRedemption, type SealReceipt } from "@jevyr/protocol";
import { canonicalJson, sha256BytesDigest, sha256Digest } from "./digest.js";
import { JevyrContinuityError } from "./errors.js";
import { parseUnambiguousJsonText } from "./json.js";
import { dssePae } from "./trust.js";
export type { MetabolicAllowance, MetabolicOffer, MetabolicOffers, MetabolicReceipt, MetabolicRedemption, MetabolicKind } from "@jevyr/protocol";

const check = (condition: boolean, message: string) => { if (!condition) throw new JevyrContinuityError(message); };
function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  check(!!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key)), `${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}
function base64(value: unknown): Uint8Array<ArrayBuffer> {
  check(typeof value === "string" && value.length <= 1_048_576 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value), "Invalid metabolic base64");
  const decoded = atob(value as string); check(btoa(decoded) === value, "Noncanonical metabolic base64");
  return Uint8Array.from(decoded, ch => ch.charCodeAt(0));
}
export function assertBallId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^ball_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(value)) throw new TypeError("Metabolism requires a canonical offered ballId");
}
export function assertMetabolismQuantity(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 64) throw new TypeError("Metabolism quantity must be an integer from 1 through 64");
}
export function metabolicAllowance(policyDescriptor: unknown, seal: SealReceipt): MetabolicAllowance {
  const root = policyDescriptor as {caseId?:string; policyDigest?:string; artifact?:{descriptor?:{policy?:{metabolicAllowance?:unknown}}}};
  check(root.caseId === seal.caseId && root.policyDigest === seal.policyDigest, "Metabolic policy crosses the authenticated Seal");
  const allowance = root.artifact?.descriptor?.policy?.metabolicAllowance;
  assertMetabolicAllowance(allowance);
  check(allowance.baselineSearchDigest === seal.searchDigest, "Metabolic allowance substitutes the baseline search");
  return allowance;
}
export async function verifyMetabolicRedemption(raw: unknown, allowance: MetabolicAllowance, seal: SealReceipt, previous?: MetabolicReceipt): Promise<MetabolicRedemption> {
  const value = exact(raw, ["protocol", "receipt", "envelope"], "Metabolic redemption");
  check(value.protocol === "jevyr.metabolism-redemption/1", "Invalid metabolic redemption protocol");
  assertMetabolicReceipt(value.receipt); assertMetabolicGrant(value.receipt, allowance, previous);
  const receipt = value.receipt;
  for (const key of ["caseId", "caseDigest", "runDigest", "policyDigest", "searchDigest"] as const) check(receipt[key] === seal[key], `Metabolic ${key} crosses the authenticated Seal`);
  const envelope = exact(value.envelope, ["payloadType", "payload", "signatures"], "Metabolic envelope");
  check(envelope.payloadType === METABOLISM_DSSE_PAYLOAD_TYPE && Array.isArray(envelope.signatures) && envelope.signatures.length === 1, "Metabolic envelope requires exactly its dedicated signer");
  const signature = exact((envelope.signatures as unknown[])[0], ["keyid", "sig"], "Metabolic signature");
  check(signature.keyid === allowance.signer.keyId, "Metabolic signer is not bound by sealed allowance");
  const pem = allowance.signer.publicKeyPem.trim().split(/\r?\n/u);
  check(pem.shift() === "-----BEGIN PUBLIC KEY-----" && pem.pop() === "-----END PUBLIC KEY-----", "Invalid metabolic public key");
  const spki = base64(pem.join("")), payload = base64(envelope.payload), sig = base64(signature.sig);
  check(await sha256BytesDigest(spki) === allowance.signer.keyId && sig.length === 64, "Metabolic SPKI or signature length mismatch");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  check(canonicalJson(parseUnambiguousJsonText(text, "Metabolic payload")) === text && canonicalJson(receipt) === text, "Metabolic signed payload differs from the receipt");
  const publicKey = await crypto.subtle.importKey("spki", spki, "Ed25519", false, ["verify"]);
  check(await crypto.subtle.verify("Ed25519", publicKey, sig, new Uint8Array(dssePae(METABOLISM_DSSE_PAYLOAD_TYPE, payload))), "Metabolic receipt signature failed");
  return structuredClone(value) as unknown as MetabolicRedemption;
}
export async function verifyMetabolicOffers(raw: unknown, allowance: MetabolicAllowance, seal: SealReceipt): Promise<MetabolicOffers> {
  const value = exact(raw, ["protocol", "caseId", "runDigest", "allowanceDigest", "baselineSearchDigest", "admission", "cumulativeGrant", "cumulativeQuantities", "offers", "receipts"], "Metabolic offers");
  check(value.protocol === "jevyr.metabolic-offers/1" && value.caseId === seal.caseId && value.runDigest === seal.runDigest && value.allowanceDigest === allowance.digest && value.baselineSearchDigest === seal.searchDigest && ["open", "closed"].includes(String(value.admission)), "Metabolic offers substitute a sealed identity");
  check(Array.isArray(value.receipts) && value.receipts.length <= Math.min(320, allowance.maximumReceipts), "Metabolic receipt history exceeds its bound");
  let previous: MetabolicReceipt | undefined;
  for (const rawReceipt of value.receipts as unknown[]) previous = (await verifyMetabolicRedemption(rawReceipt, allowance, seal, previous)).receipt;
  assertMetabolicResourceVector(value.cumulativeGrant);
  const quantities = exact(value.cumulativeQuantities, METABOLIC_KINDS, "Cumulative quantities");
  for (const key of METABOLIC_KINDS) check(quantities[key] === (previous?.cumulativeQuantities[key] ?? 0), "Offers omit or alter quantity history");
  for (const key of METABOLIC_RESOURCE_KEYS) check(value.cumulativeGrant[key] === (previous?.cumulativeGrant[key] ?? 0), "Offers omit or alter resource history");
  check(Array.isArray(value.offers) && value.offers.length <= 5 && (value.admission !== "closed" || value.offers.length === 0), "Metabolic offers exceed finite kinds or closed admission");
  const kinds = new Set(), balls = new Set();
  for (const rawOffer of value.offers as unknown[]) {
    const offer = exact(rawOffer, ["ballId", "kind", "minQuantity", "maxQuantity", "promisedEffect", "unitCostCeiling", "unitWork", "calibration"], "Metabolic offer");
    assertBallId(offer.ballId); assertMetabolismQuantity(offer.maxQuantity);
    check(METABOLIC_KINDS.includes(offer.kind as typeof METABOLIC_KINDS[number]) && !kinds.has(offer.kind) && !balls.has(offer.ballId) && offer.minQuantity === 1, "Invalid or duplicate metabolic kind/ball");
    kinds.add(offer.kind); balls.add(offer.ballId);
    const kind = offer.kind as typeof METABOLIC_KINDS[number];
    const calibration = exact(offer.calibration, ["digest", "scope", "pairedSeeds", "doses", "monotonic", "identicalEvidenceJudgment", "recallDifference", "reproducibilityDifference", "nonInferiorityMargin", "maximumObservedUnitResources"], "Metabolic calibration");
    assertMetabolicResourceVector(calibration.maximumObservedUnitResources);
    const measured = allowance.calibrations.find(entry => entry.kind === kind);
    check(!!measured && await sha256Digest(canonicalJson(calibration)) === measured.summaryDigest, "Offered calibration summary differs from its sealed digest");
    check(!!measured && calibration.digest === measured.digest && offer.maxQuantity <= Math.min(allowance.maximumQuantityPerBall, measured!.maximumDose - Number(quantities[kind])) && calibration.monotonic === true && calibration.identicalEvidenceJudgment === true && Number.isSafeInteger(calibration.pairedSeeds) && Number(calibration.pairedSeeds) > 0, "Metabolic offer exceeds its sealed measured calibration");
    check(typeof calibration.scope === "string" && calibration.scope.length >= 8 && calibration.scope.length <= 2048 && Array.isArray(calibration.doses) && calibration.doses.length <= 65 && calibration.doses.every(dose => Number.isSafeInteger(dose) && dose >= 0 && dose <= 64) && typeof calibration.nonInferiorityMargin === "number" && Number.isFinite(calibration.nonInferiorityMargin), "Invalid calibration sample summary");
    for (const field of ["recallDifference", "reproducibilityDifference"]) { const interval = exact(calibration[field], ["lower", "upper", "confidence"], "Calibration interval"); check(typeof interval.lower === "number" && typeof interval.upper === "number" && interval.lower >= -1 && interval.upper <= 1 && interval.lower <= interval.upper && interval.confidence === 0.95, "Invalid calibration interval"); }
    check(typeof offer.promisedEffect === "string" && offer.promisedEffect.length > 0 && offer.promisedEffect.length <= 1024, "Invalid bounded effect description");
    assertMetabolicResourceVector(offer.unitCostCeiling); assertMetabolicWork(offer.unitWork);
    for (const key of METABOLIC_RESOURCE_KEYS) check(calibration.maximumObservedUnitResources[key] <= offer.unitCostCeiling[key], "Offer understates measured unit resources");
    for (const key of METABOLIC_RESOURCE_KEYS) check(offer.unitCostCeiling[key] === allowance.unitCostCeilings[kind][key] && BigInt(offer.unitCostCeiling[key]) * BigInt(offer.maxQuantity) + BigInt(value.cumulativeGrant[key]) <= BigInt(allowance.maximumAddedResources[key]), "Offered quantity exceeds sealed additive resources");
    for (const key of METABOLIC_WORK_KEYS) check(offer.unitWork[key] === (key === METABOLIC_WORK_FOR_KIND[kind] ? 1 : 0), "Offer changes its promised finite work kind");
  }
  return structuredClone(value) as unknown as MetabolicOffers;
}
