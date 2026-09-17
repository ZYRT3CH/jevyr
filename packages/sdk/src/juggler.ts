import { canonicalJson, sha256Digest } from "./digest.js";
import { JevyrContinuityError } from "./errors.js";
import type { SealReceipt } from "./types.js";

export const JUGGLER_VOUCHER_KINDS = Object.freeze(["Mass", "Refraction", "Polarity", "Fission", "Inertia"] as const);
export type JugglerKind = typeof JUGGLER_VOUCHER_KINDS[number];
export interface JugglerOffer { readonly kind: JugglerKind; readonly token: string }
export interface JugglerOffers {
  readonly protocol: "jevyr.juggler-offers/1";
  readonly caseId: string;
  readonly runDigest: string;
  readonly offers: readonly JugglerOffer[];
}
export interface JugglerSchedule {
  readonly nurseryCallCeiling: number;
  readonly independentLineages: number;
  readonly challengeInterval: number;
  readonly saturationWindow: number;
  readonly mindOffset: number;
}
export interface JugglerReceipt {
  readonly protocol: "jevyr.juggler-redemption/1";
  readonly caseId: string;
  readonly runDigest: string;
  readonly searchDigest: string;
  readonly kind: JugglerKind;
  readonly voucherDigest: string;
  readonly sequence: number;
  readonly before: JugglerSchedule;
  readonly after: JugglerSchedule;
  readonly verdictAuthority: "none";
  readonly digest: string;
}

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SCHEDULE_FIELDS = ["nurseryCallCeiling", "independentLineages", "challengeInterval", "saturationWindow", "mindOffset"] as const;
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new JevyrContinuityError(`${label} must have exactly its closed protocol fields`);
  }
  return value as Record<string, unknown>;
}
function check(condition: boolean, message: string): void {
  if (!condition) throw new JevyrContinuityError(message);
}
export function assertJugglerCaseId(caseId: unknown): asserts caseId is string {
  if (typeof caseId !== "string" || !/^case_[a-f0-9]{16}$/u.test(caseId)) throw new TypeError("Juggler requires a canonical CASE_ID");
}
export function assertJugglerToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(token)) throw new TypeError("Voucher must be a canonical server-issued opaque token");
}
export function assertJugglerOffers(raw: unknown, seal: SealReceipt): JugglerOffers {
  const value = exact(raw, ["protocol", "caseId", "runDigest", "offers"], "Juggler offers");
  check(value.protocol === "jevyr.juggler-offers/1" && value.caseId === seal.caseId && value.runDigest === seal.runDigest,
    "Juggler offers cross the authenticated Case/run boundary");
  check(Array.isArray(value.offers) && value.offers.length <= 5, "Juggler offers exceed the finite voucher set");
  const tokens = new Set(), kinds = new Set();
  for (const item of value.offers as unknown[]) {
    const offer = exact(item, ["kind", "token"], "Juggler offer");
    check(JUGGLER_VOUCHER_KINDS.includes(offer.kind as JugglerKind), "Unsupported Juggler voucher kind");
    try { assertJugglerToken(offer.token); } catch { throw new JevyrContinuityError("Malformed Juggler voucher token"); }
    check(!tokens.has(offer.token) && !kinds.has(offer.kind), "Duplicate Juggler token or kind");
    tokens.add(offer.token); kinds.add(offer.kind); Object.freeze(item);
  }
  Object.freeze(value.offers);
  return Object.freeze(value) as unknown as JugglerOffers;
}
function schedule(raw: unknown): JugglerSchedule {
  const value = exact(raw, SCHEDULE_FIELDS, "Juggler schedule");
  for (const key of SCHEDULE_FIELDS) check(typeof value[key] === "number" && Number.isSafeInteger(value[key])
    && (value[key] as number) >= (key === "nurseryCallCeiling" || key === "mindOffset" ? 0 : 1), "Juggler schedule contains an invalid bounded integer");
  check((value.mindOffset as number) < 256, "Juggler investigator offset is outside its finite domain");
  return Object.freeze(value) as unknown as JugglerSchedule;
}

/** The receipt is content-verified and Seal-bound; its eventual public ledger still needs terminal authentication. */
export async function verifyJugglerReceipt(raw: unknown, seal: SealReceipt, offered: JugglerOffer): Promise<JugglerReceipt> {
  const value = exact(raw, ["protocol", "caseId", "runDigest", "searchDigest", "kind", "voucherDigest", "sequence", "before", "after", "verdictAuthority", "digest"], "Juggler receipt");
  check(value.protocol === "jevyr.juggler-redemption/1" && value.verdictAuthority === "none", "Juggler receipt claimed unsupported authority");
  check(value.caseId === seal.caseId && value.runDigest === seal.runDigest && value.searchDigest === seal.searchDigest,
    "Juggler receipt crosses the authenticated Case/run/search boundary");
  check(value.kind === offered.kind && value.voucherDigest === await sha256Digest(offered.token), "Juggler receipt does not bind the offered token and kind");
  check(typeof value.sequence === "number" && Number.isSafeInteger(value.sequence) && value.sequence >= 1 && value.sequence <= 5, "Juggler receipt sequence is outside its finite domain");
  const before = schedule(value.before), after = schedule(value.after);
  const changedField = ({ Mass: "nurseryCallCeiling", Refraction: "mindOffset", Polarity: "challengeInterval", Fission: "independentLineages", Inertia: "saturationWindow" } as const)[offered.kind];
  check(SCHEDULE_FIELDS.every(key => key === changedField || before[key] === after[key]), "Juggler receipt changed an unrelated schedule field");
  check(offered.kind === "Refraction" ? after.mindOffset === before.mindOffset + 1 || before.mindOffset > 0 && after.mindOffset === 0
    : after[changedField] === before[changedField] + (offered.kind === "Polarity" ? -1 : 1), "Juggler receipt has no exact finite voucher effect");
  const { digest, ...body } = value;
  check(typeof digest === "string" && DIGEST.test(digest) && digest === await sha256Digest(canonicalJson(body)), "Juggler receipt digest mismatch");
  return Object.freeze(value) as unknown as JugglerReceipt;
}
