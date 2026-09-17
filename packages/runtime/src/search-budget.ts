import type { NurseryInvocationUsage, NurseryResourceEnvelope, NurseryResourceUsage } from "@jevyr/growth";
import { METABOLIC_RESOURCE_KEYS, type SearchResourceEnvelope, type MetabolicAllowance, type MetabolicReceipt, type MetabolicRedemption, type SealedCase } from "@jevyr/protocol";
import { assertSignedMetabolicRedemption } from "./juggler-live.js";
import type { MindInvocationResult } from "./contracts.js";

function nonNegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  return value;
}

function aggregateMeasurement(
  current: NurseryResourceUsage["inputTokenMeasurement"],
  next: NurseryResourceUsage["inputTokenMeasurement"],
): NurseryResourceUsage["inputTokenMeasurement"] {
  return current === "UPPER_BOUND" || next === "UPPER_BOUND" ? "UPPER_BOUND" : "MEASURED";
}

function frozenUsage(value: NurseryResourceUsage): NurseryResourceUsage {
  return Object.freeze({ ...value });
}

/**
 * Gives the next call an equal share of output permission still available per
 * remaining call. Unspent permission stays in the Case-wide envelope, while an
 * opaque failure can consume at most this call's share.
 */
export function mindInvocationOutputReservation(
  remaining: Pick<NurseryResourceEnvelope, "maxMindInvocations" | "maxOutputTokens">,
): number {
  const invocations = nonNegative(remaining.maxMindInvocations, "remaining.maxMindInvocations");
  const outputTokens = nonNegative(remaining.maxOutputTokens, "remaining.maxOutputTokens");
  if (invocations === 0 || outputTokens === 0) return 0;
  return Math.ceil(outputTokens / invocations);
}

function proportionalResourceShare(value: number, invocations: number, totalInvocations: number): number {
  nonNegative(value, "resource value");
  if (invocations === 0 || totalInvocations === 0 || value === 0) return 0;
  return Number((BigInt(value) * BigInt(invocations)) / BigInt(totalInvocations));
}

/**
 * Partitions a remaining Mind envelope for a fixed number of its remaining
 * invocation slots. The complement stays in the Case-wide meter for later
 * stages; no resource is copied or enlarged.
 */
export function mindResourceEnvelopeForInvocations(
  remaining: NurseryResourceEnvelope,
  invocations: number,
): NurseryResourceEnvelope {
  const totalInvocations = nonNegative(remaining.maxMindInvocations, "remaining.maxMindInvocations");
  const admittedInvocations = nonNegative(invocations, "invocations");
  if (admittedInvocations > totalInvocations) {
    throw new RangeError("invocations cannot exceed remaining.maxMindInvocations");
  }
  const share = (value: number): number => proportionalResourceShare(
    nonNegative(value, "remaining resource"),
    admittedInvocations,
    totalInvocations,
  );
  const maxWallMillis = share(remaining.maxWallMillis);
  return Object.freeze({
    maxMindInvocations: admittedInvocations,
    maxInputTokens: share(remaining.maxInputTokens),
    maxOutputTokens: share(remaining.maxOutputTokens),
    maxWallMillis,
    maxGeneratedBytes: share(remaining.maxGeneratedBytes),
    maxSingleInvocationMillis: Math.min(
      nonNegative(remaining.maxSingleInvocationMillis, "remaining.maxSingleInvocationMillis"),
      maxWallMillis,
    ),
  });
}

/**
 * One monotonic meter for every Mind call in a Case. The adaptive nursery may
 * receive a remaining sub-envelope, but it never receives a fresh budget.
 */
export class SealedMindBudget {
  #previousGrant: MetabolicReceipt | undefined;
  readonly #usage: NurseryResourceUsage = {
    mindInvocations: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputTokenMeasurement: "MEASURED",
    outputTokenMeasurement: "MEASURED",
    wallMillis: 0,
    generatedBytes: 0,
  };

  constructor(readonly envelope: SearchResourceEnvelope, private readonly metabolic?: { readonly allowance: MetabolicAllowance; readonly sealed: SealedCase }) {}

  /** Called only after the signed wrapper and its ledger reference are durable. */
  admitMetabolicRedemption(value: MetabolicRedemption): void {
    if (!this.metabolic) throw new TypeError("This meter has no sealed additive allowance");
    assertSignedMetabolicRedemption(value, this.metabolic.allowance, this.#previousGrant);
    const sealed = this.metabolic.sealed;
    if (value.receipt.caseId !== sealed.caseId || value.receipt.caseDigest !== sealed.caseDigest || value.receipt.runDigest !== sealed.runDigest || value.receipt.policyDigest !== sealed.policyDigest || value.receipt.searchDigest !== sealed.searchEnvelope.digest) throw new TypeError("Metabolic receipt belongs to another sealed Case");
    for (const key of METABOLIC_RESOURCE_KEYS) if (BigInt(this.envelope[key]) + BigInt(value.receipt.cumulativeGrant[key]) > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("Metabolic budget exceeds safe precision");
    this.#previousGrant = Object.freeze(structuredClone(value.receipt));
  }

  /** A derived accounting view; envelope remains the original sealed baseline. */
  effectiveEnvelope(): SearchResourceEnvelope {
    return Object.freeze({ ...this.envelope, ...Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => [key, this.envelope[key] + (this.#previousGrant?.cumulativeGrant[key] ?? 0)])) });
  }

  snapshot(): NurseryResourceUsage {
    return frozenUsage(this.#usage);
  }

  remaining(): NurseryResourceEnvelope {
    const authorized = this.effectiveEnvelope();
    return Object.freeze({
      maxMindInvocations: Math.max(0, authorized.maxMindInvocations - this.#usage.mindInvocations),
      maxInputTokens: Math.max(0, authorized.maxInputTokens - this.#usage.inputTokens),
      maxOutputTokens: Math.max(0, authorized.maxOutputTokens - this.#usage.outputTokens),
      maxWallMillis: Math.max(0, authorized.maxWallMillis - this.#usage.wallMillis),
      maxGeneratedBytes: Math.max(0, authorized.maxGeneratedBytes - this.#usage.generatedBytes),
      maxSingleInvocationMillis: Math.min(
        this.envelope.maxSingleInvocationMillis,
        Math.max(0, authorized.maxWallMillis - this.#usage.wallMillis),
      ),
    });
  }

  refusal(inputTokenUpperBound: number): string | undefined {
    nonNegative(inputTokenUpperBound, "inputTokenUpperBound");
    const remaining = this.remaining();
    if (remaining.maxMindInvocations < 1) return "sealed Mind invocation budget is exhausted";
    if (remaining.maxWallMillis < 1 || remaining.maxSingleInvocationMillis < 1) return "sealed Mind wall-time budget is exhausted";
    if (inputTokenUpperBound > remaining.maxInputTokens) {
      return `input upper bound ${inputTokenUpperBound} exceeds ${remaining.maxInputTokens} sealed tokens remaining`;
    }
    if (remaining.maxOutputTokens < 1) return "sealed Mind output-token budget is exhausted";
    if (remaining.maxGeneratedBytes < 1) return "sealed generated-byte budget is exhausted";
    return undefined;
  }

  charge(result: MindInvocationResult, wallMillis: number, outputTokenUpperBound?: number): boolean {
    const withinInvocation = outputTokenUpperBound === undefined
      || result.tokenUsage.output.tokens <= nonNegative(outputTokenUpperBound, "outputTokenUpperBound");
    this.chargeUsage(result.tokenUsage, result.receivedOutputBytes, wallMillis, 1);
    return withinInvocation && !this.exceeded();
  }

  chargeFailure(inputTokenUpperBound: number, reservedOutputTokens: number, wallMillis: number): void {
    this.chargeUsage({
      input: { tokens: nonNegative(inputTokenUpperBound, "inputTokenUpperBound"), measurement: "UPPER_BOUND" },
      output: { tokens: nonNegative(reservedOutputTokens, "reservedOutputTokens"), measurement: "UPPER_BOUND" },
    }, 0, wallMillis, 1);
  }

  absorbNursery(usage: NurseryResourceUsage): void {
    nonNegative(usage.mindInvocations, "nursery.mindInvocations");
    nonNegative(usage.inputTokens, "nursery.inputTokens");
    nonNegative(usage.outputTokens, "nursery.outputTokens");
    nonNegative(usage.wallMillis, "nursery.wallMillis");
    nonNegative(usage.generatedBytes, "nursery.generatedBytes");
    this.#usage.mindInvocations += usage.mindInvocations;
    this.#usage.inputTokens += usage.inputTokens;
    this.#usage.outputTokens += usage.outputTokens;
    this.#usage.wallMillis += usage.wallMillis;
    this.#usage.generatedBytes += usage.generatedBytes;
    this.#usage.inputTokenMeasurement = aggregateMeasurement(
      this.#usage.inputTokenMeasurement,
      usage.inputTokenMeasurement,
    );
    this.#usage.outputTokenMeasurement = aggregateMeasurement(
      this.#usage.outputTokenMeasurement,
      usage.outputTokenMeasurement,
    );
  }

  private chargeUsage(
    usage: NurseryInvocationUsage,
    generatedBytes: number,
    wallMillis: number,
    invocations: number,
  ): void {
    nonNegative(usage.input.tokens, "tokenUsage.input.tokens");
    nonNegative(usage.output.tokens, "tokenUsage.output.tokens");
    nonNegative(generatedBytes, "generatedBytes");
    nonNegative(wallMillis, "wallMillis");
    this.#usage.mindInvocations += nonNegative(invocations, "mindInvocations");
    this.#usage.inputTokens += usage.input.tokens;
    this.#usage.outputTokens += usage.output.tokens;
    this.#usage.generatedBytes += generatedBytes;
    this.#usage.wallMillis += wallMillis;
    this.#usage.inputTokenMeasurement = aggregateMeasurement(this.#usage.inputTokenMeasurement, usage.input.measurement);
    this.#usage.outputTokenMeasurement = aggregateMeasurement(this.#usage.outputTokenMeasurement, usage.output.measurement);
  }

  private exceeded(): boolean {
    const authorized = this.effectiveEnvelope();
    return this.#usage.mindInvocations > authorized.maxMindInvocations
      || this.#usage.inputTokens > authorized.maxInputTokens
      || this.#usage.outputTokens > authorized.maxOutputTokens
      || this.#usage.wallMillis > authorized.maxWallMillis
      || this.#usage.generatedBytes > authorized.maxGeneratedBytes;
  }
}
