import { randomBytes } from "node:crypto";
import { digestJson, sha256Digest, type JsonValue, type SealedCase, type SealedSearchProfile } from "@jevyr/protocol";
import type { NurseryProfile } from "@jevyr/growth";
export * from "./juggler-live.js";
export * from "./juggler-calibration.js";

export const JUGGLER_KINDS = Object.freeze(["Mass", "Refraction", "Polarity", "Fission", "Inertia"] as const);
export type JugglerKind = typeof JUGGLER_KINDS[number];
export const JUGGLER_POLICY_DESCRIPTOR = Object.freeze({
  protocol: "jevyr.juggler-policy/1", semanticInput: false, capabilitiesMutable: false,
  issuance: "server-opaque-case-run-bound", redemption: "one-use-before-scheduler-checkpoint",
  kinds: JUGGLER_KINDS,
  effects: Object.freeze({ Mass: "one-additional-nursery-call-within-sealed-remainder", Refraction: "rotate-permitted-investigator-order", Polarity: "increase-challenge-frequency", Fission: "one-additional-blind-lineage-within-sealed-ceiling", Inertia: "one-additional-saturation-observation-within-sealed-ceiling" }),
});

export interface JugglerSchedule {
  readonly nurseryCallCeiling: number;
  readonly independentLineages: number;
  readonly challengeInterval: number;
  readonly saturationWindow: number;
  readonly mindOffset: number;
}
export interface JugglerVoucherOffer { readonly token: string; readonly kind: JugglerKind }
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

function baseline(profile: SealedSearchProfile): JugglerSchedule {
  return Object.freeze({
    nurseryCallCeiling: Math.max(0, profile.resources.maxMindInvocations - 1),
    independentLineages: Math.max(1, Math.floor(profile.nursery.independentLineages / 2)),
    challengeInterval: profile.nursery.challengeInterval,
    saturationWindow: Math.max(1, Math.floor(profile.nursery.saturationWindow / 2)),
    mindOffset: 0,
  });
}

function changed(kind: JugglerKind, schedule: JugglerSchedule, ceiling: SealedSearchProfile, mindCount: number): JugglerSchedule {
  const next = { ...schedule };
  if (kind === "Mass") next.nurseryCallCeiling = Math.min(ceiling.resources.maxMindInvocations, next.nurseryCallCeiling + 1);
  if (kind === "Refraction") next.mindOffset = (next.mindOffset + 1) % mindCount;
  if (kind === "Polarity") next.challengeInterval = Math.max(1, next.challengeInterval - 1);
  if (kind === "Fission") next.independentLineages = Math.min(ceiling.nursery.independentLineages, next.independentLineages + 1);
  if (kind === "Inertia") next.saturationWindow = Math.min(ceiling.nursery.saturationWindow, next.saturationWindow + 1);
  return Object.freeze(next);
}

/** Resource-only state. No method accepts a prompt, candidate, tool, obligation or verdict. */
export class JugglerVoucherBook {
  readonly #tokens = new Map<string, JugglerKind>();
  readonly #receipts: JugglerReceipt[] = [];
  readonly #sealed: SealedCase;
  readonly #mindCount: number;
  #schedule: JugglerSchedule;
  #closed = false;

  constructor(sealed: SealedCase, permittedMindCount: number) {
    if (sealed.intent.control !== "juggler") throw new TypeError("Sovereign cases cannot offer or redeem vouchers");
    if (!Number.isSafeInteger(permittedMindCount) || permittedMindCount < 1 || permittedMindCount > 256) throw new RangeError("permittedMindCount must be 1-256");
    this.#sealed = structuredClone(sealed);
    this.#mindCount = permittedMindCount;
    this.#schedule = baseline(this.#sealed.searchEnvelope.profile);
    for (const kind of JUGGLER_KINDS) {
      const next = changed(kind, this.#schedule, this.#sealed.searchEnvelope.profile, permittedMindCount);
      if (JSON.stringify(next) !== JSON.stringify(this.#schedule)) this.#tokens.set(randomBytes(32).toString("base64url"), kind);
    }
  }

  offers(): readonly JugglerVoucherOffer[] {
    if (this.#closed) return Object.freeze([]);
    return Object.freeze([...this.#tokens].map(([token, kind]) => Object.freeze({ token, kind })));
  }

  snapshot(): JugglerSchedule { return Object.freeze({ ...this.#schedule }); }
  receipts(): readonly JugglerReceipt[] { return Object.freeze([...this.#receipts]); }

  /** Exact token-only object prevents a voucher channel becoming a semantic write. */
  redeem(value: unknown): JugglerReceipt {
    if (this.#closed) throw new Error("Juggler scheduler checkpoint has closed");
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).length !== 1 || !Object.hasOwn(value, "voucher")) throw new TypeError("Voucher redemption accepts exactly one opaque voucher field");
    const token = (value as { voucher: unknown }).voucher;
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new TypeError("Voucher must be a server-issued opaque token");
    const kind = this.#tokens.get(token);
    if (kind === undefined) throw new Error("Voucher is unknown, already used, or belongs to another case");
    const before = this.#schedule;
    const after = changed(kind, before, this.#sealed.searchEnvelope.profile, this.#mindCount);
    if (JSON.stringify(after) === JSON.stringify(before)) throw new Error("Voucher has no remaining effect inside the sealed resource ceiling");
    const body = {
      protocol: "jevyr.juggler-redemption/1" as const,
      caseId: this.#sealed.caseId, runDigest: this.#sealed.runDigest, searchDigest: this.#sealed.searchEnvelope.digest,
      kind, voucherDigest: sha256Digest(token), sequence: this.#receipts.length + 1,
      before, after, verdictAuthority: "none" as const,
    };
    const receipt = Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) });
    this.#tokens.delete(token);
    this.#schedule = after;
    this.#receipts.push(receipt);
    return receipt;
  }

  /** Drain at the DIVERGE scheduling checkpoint, then refuse late unused tokens. */
  close(): { readonly schedule: JugglerSchedule; readonly receipts: readonly JugglerReceipt[] } {
    this.#closed = true;
    this.#tokens.clear();
    return Object.freeze({ schedule: this.snapshot(), receipts: this.receipts() });
  }
}

/** Apply to a nursery's already-partitioned resource remainder; never increase its grant. */
export function applyJugglerSchedule(profile: NurseryProfile, schedule: JugglerSchedule, sealed: SealedCase): NurseryProfile {
  if (sealed.intent.control !== "juggler") throw new TypeError("Only a sealed Juggler case can redistribute scheduling");
  const ceiling = sealed.searchEnvelope.profile;
  const fields: (keyof JugglerSchedule)[] = ["nurseryCallCeiling", "independentLineages", "challengeInterval", "saturationWindow", "mindOffset"];
  if (fields.some((field) => !Number.isSafeInteger(schedule[field]) || schedule[field] < (field === "nurseryCallCeiling" || field === "mindOffset" ? 0 : 1))) throw new TypeError("Juggler schedule contains an invalid resource value");
  if (schedule.nurseryCallCeiling > ceiling.resources.maxMindInvocations
    || schedule.independentLineages > ceiling.nursery.independentLineages
    || schedule.challengeInterval > ceiling.nursery.challengeInterval
    || schedule.saturationWindow > ceiling.nursery.saturationWindow) throw new RangeError("Juggler schedule exceeds a sealed ceiling");
  return Object.freeze({
    ...profile,
    independentLineages: schedule.independentLineages,
    challengeInterval: schedule.challengeInterval,
    saturationWindow: schedule.saturationWindow,
    resources: Object.freeze({ ...profile.resources, maxMindInvocations: Math.max(0, profile.resources.maxMindInvocations - (ceiling.resources.maxMindInvocations - schedule.nurseryCallCeiling)) }),
  });
}

export function refractMinds<T>(minds: readonly T[], schedule: JugglerSchedule): readonly T[] {
  if (minds.length === 0) return minds;
  const offset = schedule.mindOffset % minds.length;
  return Object.freeze([...minds.slice(offset), ...minds.slice(0, offset)]);
}
