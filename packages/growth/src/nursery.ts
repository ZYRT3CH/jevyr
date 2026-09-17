import { canonicalize, digestJson, type JsonValue } from "@jevyr/protocol";
import type {
  HypothesisSpecimen,
  NurseryContext,
  NurseryInvocationUsage,
  NurseryObservation,
  NurseryOperator,
  NurseryProfile,
  NurseryProposalBatch,
  NurseryProposal,
  NurseryResourceEnvelope,
  NurseryResourceUsage,
  NurseryResult,
  NurseryScar,
  NurseryTokenMeasurement,
  NurseryTokenReading,
  SearchPhase,
} from "./types.js";

export type NurseryObserver = (observation: NurseryObservation) => void | Promise<void>;

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive safe integer.`);
}

function nonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer.`);
}

function assertProfile(profile: NurseryProfile): void {
  if (
    profile.attemptSafetyCeiling.length > 128 ||
    !/^[1-9][0-9]*$/u.test(profile.attemptSafetyCeiling)
  ) {
    throw new RangeError("attemptSafetyCeiling must be a positive decimal string of at most 128 digits.");
  }
  for (const [field, value] of [
    ["minimumAttempts", profile.minimumAttempts],
    ["saturationWindow", profile.saturationWindow],
    ["independentLineages", profile.independentLineages],
    ["challengeInterval", profile.challengeInterval],
  ] as const) positiveInteger(value, field);
  for (const [field, value] of [
    ["resources.maxMindInvocations", profile.resources.maxMindInvocations],
    ["resources.maxInputTokens", profile.resources.maxInputTokens],
    ["resources.maxOutputTokens", profile.resources.maxOutputTokens],
    ["resources.maxWallMillis", profile.resources.maxWallMillis],
    ["resources.maxGeneratedBytes", profile.resources.maxGeneratedBytes],
    ["resources.maxSingleInvocationMillis", profile.resources.maxSingleInvocationMillis],
  ] as const) nonNegativeInteger(value, field);
  if (BigInt(profile.minimumAttempts) > BigInt(profile.attemptSafetyCeiling)) {
    throw new RangeError("minimumAttempts cannot exceed attemptSafetyCeiling.");
  }
  if (profile.resources.maxSingleInvocationMillis > profile.resources.maxWallMillis) {
    throw new RangeError("maxSingleInvocationMillis cannot exceed maxWallMillis.");
  }
  if (!Number.isSafeInteger(profile.seed) || profile.seed < 0) {
    throw new RangeError("seed must be a non-negative safe integer.");
  }
}

function phaseFor(ordinal: number, profile: NurseryProfile): SearchPhase {
  if (ordinal <= profile.independentLineages) return "EXILE";
  const ecologicalOrdinal = ordinal - profile.independentLineages;
  if (ecologicalOrdinal % profile.challengeInterval === 0) return "COEVOLVE";
  const nonChallengeOrdinal = ecologicalOrdinal - Math.floor(ecologicalOrdinal / profile.challengeInterval);
  return (["DIVERSIFY", "RECOMBINE", "INVERT"] as const)[
    (nonChallengeOrdinal - 1) % 3
  ] as SearchPhase;
}

function mixSeed(seed: number, ordinal: number): number {
  let value = (seed ^ Math.imul(ordinal, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

function contentDistance(left: string, right: string): number {
  const a = left.slice("sha256:".length);
  const b = right.slice("sha256:".length);
  let differingBits = 0;
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const xor = Number.parseInt(a[index] as string, 16) ^ Number.parseInt(b[index] as string, 16);
    differingBits += xor.toString(2).replaceAll("0", "").length;
  }
  return differingBits;
}

/** Hash distance is used only to traverse unlike texts; it never claims semantic or behavioral novelty. */
function parentsFor<TPayload extends JsonValue>(
  phase: SearchPhase,
  seed: number,
  specimens: readonly HypothesisSpecimen<TPayload>[],
): readonly HypothesisSpecimen<TPayload>[] {
  if (phase === "EXILE" || specimens.length === 0) return Object.freeze([]);
  const first = specimens[seed % specimens.length] as HypothesisSpecimen<TPayload>;
  if (phase !== "RECOMBINE" && phase !== "INVERT" || specimens.length === 1) return Object.freeze([first]);
  const farthest = [...specimens]
    .filter((entry) => entry.id !== first.id)
    .sort((left, right) => contentDistance(first.contentDigest, right.contentDigest) - contentDistance(first.contentDigest, left.contentDigest) || left.id.localeCompare(right.id))[0];
  return Object.freeze(farthest ? [first, farthest] : [first]);
}

function remaining(envelope: NurseryResourceEnvelope, usage: NurseryResourceUsage): NurseryResourceEnvelope {
  return Object.freeze({
    maxMindInvocations: Math.max(0, envelope.maxMindInvocations - usage.mindInvocations),
    maxInputTokens: Math.max(0, envelope.maxInputTokens - usage.inputTokens),
    maxOutputTokens: Math.max(0, envelope.maxOutputTokens - usage.outputTokens),
    maxWallMillis: Math.max(0, envelope.maxWallMillis - usage.wallMillis),
    maxGeneratedBytes: Math.max(0, envelope.maxGeneratedBytes - usage.generatedBytes),
    maxSingleInvocationMillis: Math.min(
      envelope.maxSingleInvocationMillis,
      Math.max(0, envelope.maxWallMillis - usage.wallMillis),
    ),
  });
}

function exhausted(envelope: NurseryResourceEnvelope, usage: NurseryResourceUsage): boolean {
  return usage.mindInvocations >= envelope.maxMindInvocations ||
    usage.inputTokens >= envelope.maxInputTokens ||
    usage.outputTokens >= envelope.maxOutputTokens ||
    usage.wallMillis >= envelope.maxWallMillis ||
    usage.generatedBytes >= envelope.maxGeneratedBytes;
}

function proposalBytes<TPayload extends JsonValue>(proposal: NurseryProposal<TPayload>): number {
  return Buffer.byteLength(canonicalize({
    publicSummary: proposal.publicSummary,
    payload: proposal.payload,
    declaredMechanisms: proposal.declaredMechanisms ?? [],
  }), "utf8");
}


function defaultInvocationInputBytes<TPayload extends JsonValue>(context: NurseryContext<TPayload>): number {
  return Buffer.byteLength(canonicalize({
    ordinal: context.ordinal,
    phase: context.phase,
    lineage: context.lineage,
    seed: context.seed,
    parents: context.parents,
    attemptSafetyCeiling: context.attemptSafetyCeiling,
    resourcesRemaining: context.resourcesRemaining,
  } as unknown as JsonValue), "utf8");
}

function defaultInvocationOutputBytes<TPayload extends JsonValue>(proposals: readonly NurseryProposal<TPayload>[]): number {
  return Buffer.byteLength(canonicalize(proposals as unknown as JsonValue), "utf8");
}

function isProposalBatch<TPayload extends JsonValue>(
  value: readonly NurseryProposal<TPayload>[] | NurseryProposalBatch<TPayload>,
): value is NurseryProposalBatch<TPayload> {
  return !Array.isArray(value);
}

function assertTokenReading(reading: NurseryTokenReading, field: string): void {
  nonNegativeInteger(reading.tokens, `${field}.tokens`);
  if (reading.measurement !== "MEASURED" && reading.measurement !== "UPPER_BOUND") {
    throw new TypeError(`${field}.measurement must be MEASURED or UPPER_BOUND.`);
  }
}

function aggregateMeasurement(
  current: NurseryTokenMeasurement,
  reading: NurseryTokenReading,
): NurseryTokenMeasurement {
  return current === "UPPER_BOUND" || reading.measurement === "UPPER_BOUND" ? "UPPER_BOUND" : "MEASURED";
}

function chargeTokens(usage: NurseryResourceUsage, invocation: NurseryInvocationUsage): void {
  assertTokenReading(invocation.input, "tokenUsage.input");
  assertTokenReading(invocation.output, "tokenUsage.output");
  const nextInput = usage.inputTokens + invocation.input.tokens;
  const nextOutput = usage.outputTokens + invocation.output.tokens;
  if (!Number.isSafeInteger(nextInput) || !Number.isSafeInteger(nextOutput)) {
    throw new RangeError("Aggregate token usage exceeded safe-integer accounting.");
  }
  usage.inputTokens = nextInput;
  usage.outputTokens = nextOutput;
  usage.inputTokenMeasurement = aggregateMeasurement(usage.inputTokenMeasurement, invocation.input);
  usage.outputTokenMeasurement = aggregateMeasurement(usage.outputTokenMeasurement, invocation.output);
}

export function hypothesisContentDigest<TPayload extends JsonValue>(proposal: NurseryProposal<TPayload>): string {
  return digestJson({
    protocol: "jevyr.hypothesis-content/1",
    publicSummary: proposal.publicSummary.trim(),
    payload: proposal.payload,
    declaredMechanisms: [...new Set(proposal.declaredMechanisms ?? [])].map((entry) => entry.trim().toLowerCase()).filter(Boolean).sort(),
  });
}

function validProposal<TPayload extends JsonValue>(proposal: NurseryProposal<TPayload>): boolean {
  return proposal.publicSummary.trim().length > 0 && proposal.publicSummary.length <= 4_000;
}

function usageSnapshot(usage: NurseryResourceUsage): NurseryResourceUsage {
  return Object.freeze({ ...usage });
}

/**
 * Generates an untrusted hypothesis nursery under classified physical bounds.
 * Admission means only "well-formed and not byte-for-byte equivalent". It does
 * not mean useful, behaviorally novel, embodied, supported, or true.
 */
export async function runHypothesisNursery<TPayload extends JsonValue = JsonValue>(
  operator: NurseryOperator<TPayload>,
  requestedProfile: NurseryProfile,
  signal: AbortSignal,
  observe?: NurseryObserver,
): Promise<NurseryResult<TPayload>> {
  const profile: NurseryProfile = Object.freeze({
    ...requestedProfile,
    resources: Object.freeze({ ...requestedProfile.resources }),
  });
  assertProfile(profile);
  const specimens: HypothesisSpecimen<TPayload>[] = [];
  const scars: NurseryScar[] = [];
  const seen = new Set<string>();
  const mechanisms = new Set<string>();
  const usage: NurseryResourceUsage = {
    mindInvocations: 0,
    inputTokens: 0,
    outputTokens: 0,
    inputTokenMeasurement: "MEASURED",
    outputTokenMeasurement: "MEASURED",
    wallMillis: 0,
    generatedBytes: 0,
  };
  let attempted = 0;
  let lastExactYield = 0;
  let termination: NurseryResult<TPayload>["termination"] = "ATTEMPT_CEILING";
  const ceiling = BigInt(profile.attemptSafetyCeiling);

  for (let ordinal = 1; BigInt(ordinal) <= ceiling; ordinal += 1) {
    if (!Number.isSafeInteger(ordinal)) throw new RangeError("Physical limits failed before ordinal precision was exhausted.");
    if (signal.aborted) throw signal.reason ?? new Error("Hypothesis nursery aborted");
    if (exhausted(profile.resources, usage)) {
      termination = "RESOURCE_EXHAUSTED";
      break;
    }
    const defaultPhase = phaseFor(ordinal, profile);
    const phase = operator.phaseForAttempt?.(ordinal, defaultPhase) ?? defaultPhase;
    if (!["EXILE", "DIVERSIFY", "COEVOLVE", "RECOMBINE", "INVERT"].includes(phase)) throw new TypeError("Nursery method scheduler returned an unknown phase");
    const seed = mixSeed(profile.seed, ordinal);
    const parents = parentsFor(phase, seed, specimens);
    const resourcesRemaining = remaining(profile.resources, usage);
    await observe?.({
      type: "attempt.started",
      ordinal,
      attempted,
      nurserySize: specimens.length,
      exactYieldAge: Math.max(0, attempted - lastExactYield),
      resources: usageSnapshot(usage),
      publicSummary: `Lineage ${String(((ordinal - 1) % profile.independentLineages) + 1).padStart(2, "0")} entered ${phase}.`,
    });

    const timeout = AbortSignal.timeout(Math.max(1, resourcesRemaining.maxSingleInvocationMillis));
    const invocationSignal = AbortSignal.any([signal, timeout]);
    const context: NurseryContext<TPayload> = Object.freeze({
      ordinal,
      phase,
      lineage: `lineage-${String(((ordinal - 1) % profile.independentLineages) + 1).padStart(2, "0")}`,
      seed,
      parents,
      attemptSafetyCeiling: profile.attemptSafetyCeiling,
      resourcesRemaining,
      signal: invocationSignal,
    });
    const inputTokenUpperBound = operator.inputTokenUpperBound?.(context) ?? defaultInvocationInputBytes(context);
    nonNegativeInteger(inputTokenUpperBound, "inputTokenUpperBound");
    if (inputTokenUpperBound > resourcesRemaining.maxInputTokens) {
      attempted = ordinal;
      const scar: NurseryScar = Object.freeze({
        ordinal,
        code: "RESOURCE_OVERRUN",
        summary: `The next invocation requires an input upper bound of ${inputTokenUpperBound} tokens, beyond the ${resourcesRemaining.maxInputTokens} tokens remaining; the Mind was not invoked.`,
      });
      scars.push(scar);
      await observe?.({
        type: "hypothesis.scarred", ordinal, attempted, nurserySize: specimens.length,
        exactYieldAge: Math.max(0, attempted - lastExactYield), resources: usageSnapshot(usage), publicSummary: scar.summary,
      });
      termination = "RESOURCE_EXHAUSTED";
      break;
    }
    const outputTokenUpperBound = operator.outputTokenUpperBound?.(context)
      ?? resourcesRemaining.maxOutputTokens;
    nonNegativeInteger(outputTokenUpperBound, "outputTokenUpperBound");
    if (outputTokenUpperBound > resourcesRemaining.maxOutputTokens) {
      attempted = ordinal;
      const scar: NurseryScar = Object.freeze({
        ordinal,
        code: "RESOURCE_OVERRUN",
        summary: `The next invocation reserves ${outputTokenUpperBound} output tokens, beyond the ${resourcesRemaining.maxOutputTokens} tokens remaining; the Mind was not invoked.`,
      });
      scars.push(scar);
      await observe?.({
        type: "hypothesis.scarred", ordinal, attempted, nurserySize: specimens.length,
        exactYieldAge: Math.max(0, attempted - lastExactYield), resources: usageSnapshot(usage), publicSummary: scar.summary,
      });
      termination = "RESOURCE_EXHAUSTED";
      break;
    }
    const started = performance.now();
    let proposals: readonly NurseryProposal<TPayload>[] = [];
    let invocationUsage: NurseryInvocationUsage | undefined;
    let failure: string | undefined;
    try {
      const proposed = await operator.propose(context);
      if (isProposalBatch(proposed)) {
        proposals = proposed.proposals;
        invocationUsage = proposed.tokenUsage;
        if (proposed.failure !== undefined) {
          if (typeof proposed.failure !== "string" || proposed.failure.trim().length === 0) {
            throw new TypeError("Nursery operator failure must be a non-empty public string.");
          }
          if (proposals.length > 0) {
            throw new TypeError("A failed nursery invocation cannot return proposals.");
          }
          assertTokenReading(invocationUsage.input, "tokenUsage.input");
          assertTokenReading(invocationUsage.output, "tokenUsage.output");
          if (
            invocationUsage.input.measurement !== "UPPER_BOUND"
            || invocationUsage.input.tokens < inputTokenUpperBound
          ) {
            throw new TypeError("A failed nursery invocation must conservatively upper-bound its reserved input.");
          }
          if (
            invocationUsage.output.measurement !== "UPPER_BOUND"
            || invocationUsage.output.tokens !== outputTokenUpperBound
          ) {
            throw new TypeError("A failed nursery invocation must charge its complete reserved output permission.");
          }
          failure = proposed.failure.slice(0, 500);
        }
      } else {
        proposals = proposed;
        invocationUsage = {
          input: { tokens: inputTokenUpperBound, measurement: "UPPER_BOUND" },
          output: { tokens: defaultInvocationOutputBytes(proposals), measurement: "UPPER_BOUND" },
        };
      }
      if (!Array.isArray(proposals)) throw new TypeError("Nursery operator must return public proposals.");
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      proposals = [];
      invocationUsage = undefined;
      failure = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    }
    const elapsed = Math.max(0, Math.ceil(performance.now() - started));
    const generated = proposals.reduce((total, proposal) => total + proposalBytes(proposal), 0);
    usage.mindInvocations += 1;
    usage.wallMillis += elapsed;
    usage.generatedBytes += generated;
    if (invocationUsage) {
      chargeTokens(usage, invocationUsage);
    } else {
      // A failed operator supplied no receipt. Charge the reserved input and
      // output permission so an opaque failure cannot reopen an unmetered lane
      // on the next iteration.
      chargeTokens(usage, {
        input: { tokens: inputTokenUpperBound, measurement: "UPPER_BOUND" },
        output: { tokens: outputTokenUpperBound, measurement: "UPPER_BOUND" },
      });
    }
    attempted = ordinal;

    if (failure) {
      const scar: NurseryScar = Object.freeze({ ordinal, code: "OPERATOR_FAILURE", summary: failure });
      scars.push(scar);
      await observe?.({
        type: "hypothesis.scarred", ordinal, attempted, nurserySize: specimens.length,
        exactYieldAge: Math.max(0, attempted - lastExactYield), resources: usageSnapshot(usage), publicSummary: scar.summary,
      });
    } else if (
      (invocationUsage !== undefined && invocationUsage.output.tokens > outputTokenUpperBound) ||
      usage.inputTokens > profile.resources.maxInputTokens ||
      usage.outputTokens > profile.resources.maxOutputTokens ||
      usage.wallMillis > profile.resources.maxWallMillis ||
      usage.generatedBytes > profile.resources.maxGeneratedBytes
    ) {
      const scar: NurseryScar = Object.freeze({
        ordinal,
        code: "RESOURCE_OVERRUN",
        summary: "The response crossed a sealed token, wall-time, or generated-byte boundary and was not admitted.",
      });
      scars.push(scar);
      await observe?.({
        type: "hypothesis.scarred", ordinal, attempted, nurserySize: specimens.length,
        exactYieldAge: Math.max(0, attempted - lastExactYield), resources: usageSnapshot(usage), publicSummary: scar.summary,
      });
    } else if (proposals.length === 0) {
      const scar: NurseryScar = Object.freeze({
        ordinal,
        code: "OPERATOR_FAILURE",
        summary: "The Mind returned no public hypothesis proposal.",
      });
      scars.push(scar);
      await observe?.({
        type: "hypothesis.scarred", ordinal, attempted, nurserySize: specimens.length,
        exactYieldAge: Math.max(0, attempted - lastExactYield), resources: usageSnapshot(usage), publicSummary: scar.summary,
      });
    } else {
      let yielded = false;
      for (const proposal of proposals) {
        if (!validProposal(proposal)) {
          const scar: NurseryScar = Object.freeze({ ordinal, code: "INVALID", summary: "A proposal violated the public nursery shape." });
          scars.push(scar);
          await observe?.({
            type: "hypothesis.scarred", ordinal, attempted, nurserySize: specimens.length,
            exactYieldAge: Math.max(0, attempted - lastExactYield), resources: usageSnapshot(usage), publicSummary: scar.summary,
          });
          continue;
        }
        const contentDigest = hypothesisContentDigest(proposal);
        if (seen.has(contentDigest)) {
          const scar: NurseryScar = Object.freeze({ ordinal, code: "DUPLICATE", contentDigest, summary: "Exact public hypothesis content already exists in the nursery." });
          scars.push(scar);
          await observe?.({
            type: "hypothesis.scarred", ordinal, attempted, nurserySize: specimens.length,
            exactYieldAge: Math.max(0, attempted - lastExactYield), resources: usageSnapshot(usage), publicSummary: scar.summary, contentDigest,
          });
          continue;
        }
        seen.add(contentDigest);
        const declaredMechanisms = [...new Set<string>(proposal.declaredMechanisms ?? [])]
          .map((entry) => entry.trim().toLowerCase()).filter(Boolean).sort();
        for (const mechanism of declaredMechanisms) mechanisms.add(mechanism);
        const specimen: HypothesisSpecimen<TPayload> = Object.freeze({
          id: digestJson({
            protocol: "jevyr.hypothesis-specimen/1",
            contentDigest,
            ordinal,
            lineage: context.lineage,
            phase,
            parentIds: parents.map((parent) => parent.id),
          }),
          contentDigest,
          ordinal,
          lineage: context.lineage,
          phase,
          parentIds: Object.freeze(parents.map((parent) => parent.id)),
          publicSummary: proposal.publicSummary.trim(),
          payload: structuredClone(proposal.payload),
          declaredMechanisms: Object.freeze(declaredMechanisms),
        });
        specimens.push(specimen);
        yielded = true;
        await observe?.({
          type: "hypothesis.admitted", ordinal, attempted, nurserySize: specimens.length,
          exactYieldAge: 0, resources: usageSnapshot(usage), publicSummary: specimen.publicSummary,
          specimenId: specimen.id, contentDigest,
        });
      }
      if (yielded) lastExactYield = ordinal;
    }

    if (exhausted(profile.resources, usage)) {
      termination = "RESOURCE_EXHAUSTED";
      break;
    }
    if (ordinal >= profile.minimumAttempts && ordinal - lastExactYield >= profile.saturationWindow) {
      termination = "HYPOTHESIS_SATURATED";
      break;
    }
  }

  const exactYieldAge = Math.max(0, attempted - lastExactYield);
  await observe?.({
    type: "nursery.completed",
    ordinal: attempted,
    attempted,
    nurserySize: specimens.length,
    exactYieldAge,
    resources: usageSnapshot(usage),
    termination,
    publicSummary: `The untrusted nursery closed by ${termination.toLowerCase().replaceAll("_", " ")}; ${specimens.length} exact-distinct hypotheses remain untested.`,
  });
  return Object.freeze({
    profile,
    attempted,
    specimens: Object.freeze([...specimens]),
    scars: Object.freeze([...scars]),
    declaredMechanisms: Object.freeze([...mechanisms].sort()),
    exactYieldAge,
    resources: usageSnapshot(usage),
    termination,
  });
}
