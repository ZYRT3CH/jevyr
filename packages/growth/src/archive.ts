import type { JsonValue } from "@jevyr/protocol";
import type {
  BehaviorDescriptor,
  CandidateEvaluation,
  EvaluatedCandidate,
  GraveyardEntry,
  SearchCandidate,
} from "./types.js";

export interface ArchiveOptions {
  binsPerDimension: number;
  elitesPerNiche: number;
  minimumNovelty: number;
  /** Hard global survivor ceiling after niche-local Pareto admission. */
  capacity?: number;
}

export interface ArchiveDecision<TPayload extends JsonValue = JsonValue> {
  accepted: boolean;
  entry: EvaluatedCandidate<TPayload>;
  displaced: readonly GraveyardEntry<TPayload>[];
  reasons: readonly string[];
}

const SCORE_KEYS = [
  "discrimination",
  "robustness",
  "parsimony",
  "feasibility",
  "evidenceCoverage",
  "resourceEfficiency",
] as const;

function descriptorSpaces(descriptor: BehaviorDescriptor) {
  return [
    descriptor.semantic,
    descriptor.mechanism,
    descriptor.causal,
    descriptor.implementation,
  ] as const;
}

export function descriptorVector(descriptor: BehaviorDescriptor): readonly number[] {
  const spaces = descriptorSpaces(descriptor);
  for (const space of spaces) {
    if (space.length === 0) {
      throw new TypeError("Each behavior descriptor space must contain at least one coordinate.");
    }
    for (const coordinate of space) {
      if (!Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1) {
        throw new RangeError("Behavior descriptor coordinates must be finite values in [0, 1].");
      }
    }
  }
  return spaces.flat();
}

export function descriptorDistance(
  left: BehaviorDescriptor,
  right: BehaviorDescriptor,
): number {
  const a = descriptorVector(left);
  const b = descriptorVector(right);
  if (a.length !== b.length) {
    throw new TypeError("Behavior descriptors must have the same dimensionality.");
  }
  let squareSum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const delta = (a[index] as number) - (b[index] as number);
    squareSum += delta * delta;
  }
  return Math.sqrt(squareSum / a.length);
}

export function nicheFor(
  descriptor: BehaviorDescriptor,
  binsPerDimension: number,
): string {
  if (!Number.isInteger(binsPerDimension) || binsPerDimension < 2) {
    throw new RangeError("binsPerDimension must be an integer of at least 2.");
  }
  return descriptorSpaces(descriptor)
    .map((space, spaceIndex) => {
      const prefix = ["s", "m", "c", "i"][spaceIndex] as string;
      const cells = space.map((coordinate) =>
        Math.min(
          binsPerDimension - 1,
          Math.floor(coordinate * binsPerDimension),
        ),
      );
      return prefix + cells.join(".");
    })
    .join("|");
}

export function minimumCriterionReasons(
  evaluation: CandidateEvaluation,
): readonly string[] {
  const reasons: string[] = [];
  if (!evaluation.integrity) reasons.push("integrity failed");
  if (!evaluation.criticalTestsExecuted)
    reasons.push("critical tests were not executed");
  if (evaluation.unresolvedCritical > 0)
    reasons.push("critical observations remain unresolved");
  if (evaluation.evidenceDigests.length === 0)
    reasons.push("no evidence digest supports the candidate");
  if (evaluation.scores.feasibility <= 0)
    reasons.push("candidate is not feasible in any declared regime");
  if (!Number.isFinite(evaluation.effortUnits) || evaluation.effortUnits <= 0)
    reasons.push("candidate effortUnits must be a positive finite value");
  for (const key of SCORE_KEYS) {
    const value = evaluation.scores[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      reasons.push(key + " must be in [0, 1]");
    }
  }
  return Object.freeze(reasons);
}

/** Pareto dominance only; Jevyr deliberately has no universal taste scalar. */
export function dominates(
  left: CandidateEvaluation,
  right: CandidateEvaluation,
): boolean {
  if (minimumCriterionReasons(left).length > 0) return false;
  if (minimumCriterionReasons(right).length > 0) return true;
  let strictlyBetter = false;
  for (const key of SCORE_KEYS) {
    if (left.scores[key] < right.scores[key]) return false;
    if (left.scores[key] > right.scores[key]) strictlyBetter = true;
  }
  if (left.embodied && !right.embodied) strictlyBetter = true;
  if (!left.embodied && right.embodied) return false;
  return strictlyBetter;
}

export function compareArchiveEntries<TPayload extends JsonValue>(
  left: EvaluatedCandidate<TPayload>,
  right: EvaluatedCandidate<TPayload>,
): number {
  if (left.evaluation.embodied !== right.evaluation.embodied)
    return left.evaluation.embodied ? -1 : 1;
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
  return left.candidate.id < right.candidate.id ? -1 : left.candidate.id > right.candidate.id ? 1 : 0;
}

export class QualityDiversityArchive<
  TPayload extends JsonValue = JsonValue,
> {
  readonly #options: Required<ArchiveOptions>;
  readonly #cells = new Map<string, EvaluatedCandidate<TPayload>[]>();
  readonly #graveyard: GraveyardEntry<TPayload>[] = [];

  constructor(options: ArchiveOptions) {
    if (!Number.isInteger(options.elitesPerNiche) || options.elitesPerNiche < 1)
      throw new RangeError("elitesPerNiche must be a positive integer.");
    if (
      !Number.isFinite(options.minimumNovelty) ||
      options.minimumNovelty < 0 ||
      options.minimumNovelty > 1
    )
      throw new RangeError("minimumNovelty must be in [0, 1].");
    if (!Number.isInteger(options.binsPerDimension) || options.binsPerDimension < 2)
      throw new RangeError("binsPerDimension must be an integer of at least 2.");
    const capacity = options.capacity ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(capacity) || capacity < 1)
      throw new RangeError("capacity must be a positive safe integer.");
    this.#options = Object.freeze({ ...options, capacity });
  }

  get size() {
    let count = 0;
    for (const entries of this.#cells.values()) count += entries.length;
    return count;
  }

  get niches() {
    return this.#cells.size;
  }

  entries(): readonly EvaluatedCandidate<TPayload>[] {
    return Object.freeze(
      [...this.#cells.values()]
        .flat()
        .sort((left, right) => left.candidate.ordinal - right.candidate.ordinal),
    );
  }

  graveyard(): readonly GraveyardEntry<TPayload>[] {
    return Object.freeze([...this.#graveyard]);
  }

  noveltyOf(descriptor: BehaviorDescriptor): number {
    const entries = this.entries();
    if (entries.length === 0) return 1;
    return Math.min(
      ...entries.map((entry) =>
        descriptorDistance(descriptor, entry.candidate.descriptor),
      ),
    );
  }

  consider(
    candidate: SearchCandidate<TPayload>,
    evaluation: CandidateEvaluation,
  ): ArchiveDecision<TPayload> {
    descriptorVector(candidate.descriptor);
    const niche = nicheFor(candidate.descriptor, this.#options.binsPerDimension);
    const novelty = this.noveltyOf(candidate.descriptor);
    const entry: EvaluatedCandidate<TPayload> = Object.freeze({
      candidate,
      evaluation,
      niche,
      novelty,
    });
    const criterionReasons = [...minimumCriterionReasons(evaluation)];
    const existing = this.#cells.get(niche) ?? [];

    if (
      criterionReasons.length === 0 &&
      existing.length > 0 &&
      novelty < this.#options.minimumNovelty
    ) {
      criterionReasons.push(
        "candidate does not add the required behavioral novelty",
      );
    }
    if (criterionReasons.length > 0) {
      const grave = Object.freeze({
        ...entry,
        reasons: Object.freeze(criterionReasons),
      });
      this.#graveyard.push(grave);
      return {
        accepted: false,
        entry,
        displaced: Object.freeze([]),
        reasons: grave.reasons,
      };
    }

    if (existing.some((elite) => dominates(elite.evaluation, evaluation))) {
      const reasons = Object.freeze(["dominated by an existing niche survivor"]);
      this.#graveyard.push(Object.freeze({ ...entry, reasons }));
      return {
        accepted: false,
        entry,
        displaced: Object.freeze([]),
        reasons,
      };
    }

    const displaced: GraveyardEntry<TPayload>[] = existing
      .filter((elite) => dominates(evaluation, elite.evaluation))
      .map((elite) =>
        Object.freeze({
          ...elite,
          reasons: Object.freeze(["displaced by a dominating niche survivor"]),
        }),
      );
    const survivors = existing.filter(
      (elite) => !displaced.some((item) => item.candidate.id === elite.candidate.id),
    );
    survivors.push(entry);
    survivors.sort(compareArchiveEntries);

    if (survivors.length > this.#options.elitesPerNiche) {
      const removed = survivors.splice(this.#options.elitesPerNiche);
      for (const elite of removed) {
        displaced.push(
          Object.freeze({
            ...elite,
            reasons: Object.freeze(["niche capacity retained a stronger Pareto set"]),
          }),
        );
      }
    }
    this.#cells.set(niche, survivors);

    while (this.size > this.#options.capacity) {
      const rankedWorstFirst = [...this.entries()].sort((left, right) =>
        compareArchiveEntries(right, left));
      // Preserve occupied behavioral territory whenever a crowded niche can
      // yield an elite first. Only then may global capacity erase a singleton.
      const elite = rankedWorstFirst.find((item) => (this.#cells.get(item.niche)?.length ?? 0) > 1)
        ?? rankedWorstFirst[0];
      if (elite === undefined) throw new Error("Archive capacity eviction found no survivor");
        const cell = this.#cells.get(elite.niche) ?? [];
        const retained = cell.filter((item) => item.candidate.id !== elite.candidate.id);
        if (retained.length === 0) this.#cells.delete(elite.niche);
        else this.#cells.set(elite.niche, retained);
        displaced.push(Object.freeze({
          ...elite,
          reasons: Object.freeze(["global archive capacity retained a stronger measured set"]),
        }));
    }
    this.#graveyard.push(...displaced);

    const accepted = this.entries().some(
      (survivor) => survivor.candidate.id === candidate.id,
    );
    if (!accepted) {
      return {
        accepted: false,
        entry,
        displaced: Object.freeze(displaced),
        reasons: Object.freeze(["candidate fell outside the sealed archive capacity"]),
      };
    }
    return {
      accepted: true,
      entry,
      displaced: Object.freeze(displaced),
      reasons: Object.freeze([]),
    };
  }
}

export function paretoFront<TPayload extends JsonValue>(
  entries: readonly EvaluatedCandidate<TPayload>[],
): readonly EvaluatedCandidate<TPayload>[] {
  return Object.freeze(
    entries.filter(
      (candidate, index) =>
        !entries.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            dominates(other.evaluation, candidate.evaluation),
        ),
    ),
  );
}

/** Selects only from measured archive survivors; ids break exact evidentiary ties last. */
export function selectArchiveFlagship<TPayload extends JsonValue>(
  entries: readonly EvaluatedCandidate<TPayload>[],
): EvaluatedCandidate<TPayload> | undefined {
  return [...paretoFront(entries)].sort(compareArchiveEntries)[0];
}
