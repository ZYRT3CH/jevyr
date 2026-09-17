import { digestJson, type JsonValue } from "@jevyr/protocol";
import {
  QualityDiversityArchive,
  descriptorDistance,
  paretoFront,
} from "./archive.js";
import type {
  CoevolvedChallenge,
  EvaluatedCandidate,
  FarFrontierResult,
  SearchCandidate,
  SearchContext,
  SearchObservation,
  SearchOperator,
  SearchPhase,
  SearchProfile,
} from "./types.js";

export type SearchObserver = (
  observation: SearchObservation,
) => void | Promise<void>;

function assertProfile(profile: SearchProfile) {
  for (const [field, value] of [
    ["minimumAttempts", profile.minimumAttempts],
    ["saturationWindow", profile.saturationWindow],
    ["minimumNiches", profile.minimumNiches],
    ["independentLineages", profile.independentLineages],
    ["challengeInterval", profile.challengeInterval],
    ["binsPerDimension", profile.binsPerDimension],
    ["elitesPerNiche", profile.elitesPerNiche],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(field + " must be a positive integer.");
  }
  if (profile.binsPerDimension < 2)
    throw new RangeError("binsPerDimension must be at least 2.");
  if (!Number.isSafeInteger(profile.effortCeiling) || profile.effortCeiling <= 0)
    throw new RangeError("effortCeiling must be a positive safe integer.");
  if (
    profile.attemptSafetyCeiling.length > 128 ||
    !/^[1-9][0-9]*$/u.test(profile.attemptSafetyCeiling)
  ) {
    throw new RangeError("attemptSafetyCeiling must be a positive decimal string of at most 128 digits.");
  }
  const attemptSafetyCeiling = BigInt(profile.attemptSafetyCeiling);
  if (BigInt(profile.minimumAttempts) > attemptSafetyCeiling)
    throw new RangeError("minimumAttempts cannot exceed attemptSafetyCeiling.");
  if (
    !Number.isFinite(profile.minimumNovelty) ||
    profile.minimumNovelty < 0 ||
    profile.minimumNovelty > 1
  )
    throw new RangeError("minimumNovelty must be in [0, 1].");
  if (!Number.isInteger(profile.seed) || profile.seed < 0)
    throw new RangeError("seed must be a non-negative integer.");
}

export function searchPhase(
  ordinal: number,
  profile: SearchProfile,
  occupiedNiches = 0,
): SearchPhase {
  if (ordinal < 1 || BigInt(ordinal) > BigInt(profile.attemptSafetyCeiling))
    throw new RangeError("ordinal is outside the sealed search horizon.");
  if (ordinal <= profile.independentLineages) return "EXILE";
  if (occupiedNiches < profile.minimumNiches) return "DIVERSIFY";
  const ecologicalTurn =
    (ordinal - profile.independentLineages - 1) % 10;
  if (ecologicalTurn < 4) return "COEVOLVE";
  if (ecologicalTurn < 8) return "RECOMBINE";
  return "INVERT";
}

function mixSeed(seed: number, ordinal: number) {
  let value = (seed ^ Math.imul(ordinal, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

function mostDistantPair<TPayload extends JsonValue>(
  entries: readonly EvaluatedCandidate<TPayload>[],
): readonly EvaluatedCandidate<TPayload>[] {
  if (entries.length < 2) return entries.slice(0, 1);
  let best: readonly [
    EvaluatedCandidate<TPayload>,
    EvaluatedCandidate<TPayload>,
  ] = [entries[0] as EvaluatedCandidate<TPayload>, entries[1] as EvaluatedCandidate<TPayload>];
  let distance = -1;
  for (let left = 0; left < entries.length - 1; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left] as EvaluatedCandidate<TPayload>;
      const b = entries[right] as EvaluatedCandidate<TPayload>;
      const next = descriptorDistance(
        a.candidate.descriptor,
        b.candidate.descriptor,
      );
      if (
        next > distance ||
        (next === distance &&
          (a.candidate.id + b.candidate.id).localeCompare(
            best[0].candidate.id + best[1].candidate.id,
          ) < 0)
      ) {
        best = [a, b];
        distance = next;
      }
    }
  }
  return best;
}

function selectParents<TPayload extends JsonValue>(
  phase: SearchPhase,
  entries: readonly EvaluatedCandidate<TPayload>[],
  seed: number,
): readonly SearchCandidate<TPayload>[] {
  if (phase === "EXILE" || entries.length === 0) return Object.freeze([]);
  if (phase === "RECOMBINE")
    return Object.freeze(
      mostDistantPair(entries).map((entry) => entry.candidate),
    );
  const index = seed % entries.length;
  if (phase === "INVERT" && entries.length > 1) {
    const first = entries[index] as EvaluatedCandidate<TPayload>;
    const farthest = [...entries].sort(
      (left, right) =>
        descriptorDistance(
          first.candidate.descriptor,
          right.candidate.descriptor,
        ) -
        descriptorDistance(
          first.candidate.descriptor,
          left.candidate.descriptor,
        ),
    )[0] as EvaluatedCandidate<TPayload>;
    return Object.freeze([first.candidate, farthest.candidate]);
  }
  return Object.freeze([
    (entries[index] as EvaluatedCandidate<TPayload>).candidate,
  ]);
}

function flagshipOrder<TPayload extends JsonValue>(
  left: EvaluatedCandidate<TPayload>,
  right: EvaluatedCandidate<TPayload>,
) {
  for (const key of [
    "robustness",
    "discrimination",
    "evidenceCoverage",
    "feasibility",
    "resourceEfficiency",
    "parsimony",
  ] as const) {
    const delta = right.evaluation.scores[key] - left.evaluation.scores[key];
    if (delta !== 0) return delta;
  }
  if (left.novelty !== right.novelty) return right.novelty - left.novelty;
  return left.candidate.id.localeCompare(right.candidate.id);
}

function chooseAlternatives<TPayload extends JsonValue>(
  flagship: EvaluatedCandidate<TPayload> | undefined,
  entries: readonly EvaluatedCandidate<TPayload>[],
  maximum = 5,
) {
  if (!flagship) return Object.freeze([]);
  const remaining = entries.filter(
    (entry) =>
      entry.candidate.id !== flagship.candidate.id &&
      entry.niche !== flagship.niche,
  );
  const selected: EvaluatedCandidate<TPayload>[] = [];
  while (remaining.length > 0 && selected.length < maximum) {
    const anchors = [flagship, ...selected];
    remaining.sort((left, right) => {
      const leftDistance = Math.min(
        ...anchors.map((anchor) =>
          descriptorDistance(
            left.candidate.descriptor,
            anchor.candidate.descriptor,
          ),
        ),
      );
      const rightDistance = Math.min(
        ...anchors.map((anchor) =>
          descriptorDistance(
            right.candidate.descriptor,
            anchor.candidate.descriptor,
          ),
        ),
      );
      if (leftDistance !== rightDistance) return rightDistance - leftDistance;
      return flagshipOrder(left, right);
    });
    selected.push(remaining.shift() as EvaluatedCandidate<TPayload>);
  }
  return Object.freeze(selected);
}

/**
 * Searches an open horizon until measured discovery saturates or the sealed
 * physical envelope is consumed. Candidate count is telemetry, never a proxy
 * for depth or intelligence.
 */
export async function runFarFrontierSearch<
  TPayload extends JsonValue = JsonValue,
>(
  operator: SearchOperator<TPayload>,
  requestedProfile: SearchProfile,
  observe?: SearchObserver,
): Promise<FarFrontierResult<TPayload>> {
  const profile: SearchProfile = Object.freeze({ ...requestedProfile });
  assertProfile(profile);
  const archive = new QualityDiversityArchive<TPayload>({
    binsPerDimension: profile.binsPerDimension,
    elitesPerNiche: profile.elitesPerNiche,
    minimumNovelty: profile.minimumNovelty,
  });
  const challenges: CoevolvedChallenge[] = [];
  let effortUsed = 0;
  let attempted = 0;
  let lastFrontierChange = 0;
  let termination: FarFrontierResult<TPayload>["termination"] =
    "ATTEMPT_CEILING";
  const attemptSafetyCeiling = BigInt(profile.attemptSafetyCeiling);

  for (let ordinal = 1; BigInt(ordinal) <= attemptSafetyCeiling; ordinal += 1) {
    if (!Number.isSafeInteger(ordinal))
      throw new RangeError(
        "The physical effort meter failed to stop search before numeric ordinal exhaustion.",
      );
    const phase = searchPhase(ordinal, profile, archive.niches);
    const seed = mixSeed(profile.seed, ordinal);
    const entriesBefore = archive.entries();
    const parents = selectParents(phase, entriesBefore, seed);
    const challenge =
      challenges.length === 0
        ? undefined
        : challenges[seed % challenges.length];
    const context: SearchContext<TPayload> = {
      ordinal,
      attemptSafetyCeiling: profile.attemptSafetyCeiling,
      effortRemaining: Math.max(0, profile.effortCeiling - effortUsed),
      phase,
      lineage:
        "lineage-" +
        String(((ordinal - 1) % profile.independentLineages) + 1).padStart(
          2,
          "0",
        ),
      seed,
      parents,
      archiveSize: phase === "EXILE" ? 0 : entriesBefore.length,
      ...(challenge ? { challenge } : {}),
    };

    if (
      operator.inventChallenge &&
      (phase === "COEVOLVE" || phase === "RECOMBINE") &&
      ordinal % profile.challengeInterval === 0 &&
      entriesBefore.length > 0
    ) {
      const invented = await operator.inventChallenge(context, entriesBefore);
      const generation = challenges.length + 1;
      const id = digestJson({
        protocol: "jevyr.challenge/1",
        generation,
        publicSummary: invented.publicSummary,
        payload: invented.payload,
        ...(invented.evidenceDigest
          ? { evidenceDigest: invented.evidenceDigest }
          : {}),
      } as JsonValue);
      const nextChallenge: CoevolvedChallenge = Object.freeze({
        id,
        generation,
        publicSummary: invented.publicSummary,
        payload: invented.payload,
        ...(invented.evidenceDigest
          ? { evidenceDigest: invented.evidenceDigest }
          : {}),
      });
      challenges.push(nextChallenge);
      lastFrontierChange = ordinal;
      await observe?.({
        type: "challenge.invented",
        ordinal,
        attempted,
        effortUsed,
        effortCeiling: profile.effortCeiling,
        archiveSize: archive.size,
        occupiedNiches: archive.niches,
        saturationAge: Math.max(0, attempted - lastFrontierChange),
        publicSummary: invented.publicSummary,
      });
    }

    const proposed = await operator.propose(context);
    if (proposed.publicSummary.trim().length === 0)
      throw new TypeError("A proposal requires a non-empty public summary.");
    const candidateId = digestJson({
      protocol: "jevyr.candidate/1",
      ordinal,
      lineage: context.lineage,
      phase,
      parentIds: parents.map((parent) => parent.id),
      publicSummary: proposed.publicSummary,
      payload: proposed.payload,
      descriptor: proposed.descriptor as unknown as JsonValue,
    } as JsonValue);
    const candidate: SearchCandidate<TPayload> = Object.freeze({
      id: candidateId,
      ordinal,
      lineage: context.lineage,
      phase,
      parentIds: Object.freeze(parents.map((parent) => parent.id)),
      publicSummary: proposed.publicSummary,
      payload: proposed.payload,
      descriptor: proposed.descriptor,
    });
    await observe?.({
      type: "candidate.proposed",
      ordinal,
      attempted,
      effortUsed,
      effortCeiling: profile.effortCeiling,
      archiveSize: archive.size,
      occupiedNiches: archive.niches,
      saturationAge: Math.max(0, attempted - lastFrontierChange),
      candidateId,
      publicSummary: proposed.publicSummary,
    });

    const evaluation = await operator.evaluate(
      candidate,
      Object.freeze(challenges.slice(-8)),
    );
    if (!Number.isSafeInteger(evaluation.effortUnits) || evaluation.effortUnits <= 0)
      throw new RangeError("The search operator returned an invalid effort measurement.");
    const effortRemaining = profile.effortCeiling - effortUsed;
    if (evaluation.effortUnits > effortRemaining)
      throw new RangeError(
        "The search operator exceeded its sealed effort authorization; the candidate cannot enter the archive.",
      );
    effortUsed += evaluation.effortUnits;
    const decision = archive.consider(candidate, evaluation);
    attempted = ordinal;
    if (decision.accepted) lastFrontierChange = ordinal;
    await observe?.({
      type: decision.accepted ? "candidate.archived" : "candidate.scarred",
      ordinal,
      attempted,
      effortUsed,
      effortCeiling: profile.effortCeiling,
      archiveSize: archive.size,
      occupiedNiches: archive.niches,
      saturationAge: Math.max(0, attempted - lastFrontierChange),
      candidateId,
      niche: decision.entry.niche,
      novelty: decision.entry.novelty,
      publicSummary: decision.accepted
        ? "Candidate survived in behavioral niche " + decision.entry.niche + "."
        : decision.reasons.join("; "),
    });

    if (effortUsed >= profile.effortCeiling) {
      termination = "EFFORT_EXHAUSTED";
      break;
    }
    if (
      ordinal >= profile.minimumAttempts &&
      archive.niches >= profile.minimumNiches &&
      ordinal - lastFrontierChange >= profile.saturationWindow
    ) {
      termination = "SATURATED";
      break;
    }
  }

  const entries = archive.entries();
  // A creative flagship may legitimately precede physical embodiment. The
  // ordering still prefers embodied entries, but embodiment is judged later by
  // Bone and is not forged here merely to make search produce a winner.
  const front = [...paretoFront<TPayload>(entries)].sort(flagshipOrder);
  const flagship = front[0];
  const alternatives = chooseAlternatives<TPayload>(flagship, front.slice(1));
  await observe?.({
    type: "search.completed",
    ordinal: attempted,
    attempted,
    effortUsed,
    effortCeiling: profile.effortCeiling,
    archiveSize: archive.size,
    occupiedNiches: archive.niches,
    saturationAge: Math.max(0, attempted - lastFrontierChange),
    termination,
    publicSummary:
      "The sealed horizon closed by " +
      termination.toLowerCase().replaceAll("_", " ") +
      " with " +
      entries.length +
      " survivors across " +
      archive.niches +
      " niches.",
    ...(flagship ? { candidateId: flagship.candidate.id } : {}),
  });

  return Object.freeze({
    profile,
    attempted,
    effortUsed,
    termination,
    ...(flagship ? { flagship } : {}),
    alternatives,
    archive: entries,
    graveyard: archive.graveyard(),
    challenges: Object.freeze([...challenges]),
  });
}
