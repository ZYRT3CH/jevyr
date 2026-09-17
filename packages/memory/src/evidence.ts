import { digestJson, isSha256Digest, type JsonValue } from "@jevyr/protocol";
import {
  MAX_MEMORY_EVIDENCE_OBSERVATIONS,
  MEMORY_EVIDENCE_OBSERVATION_PROTOCOL,
  TRIBUNAL_EVIDENCE_SNAPSHOT_PROTOCOL,
  type DerivedTribunalEvidence,
  type EvidenceAttribution,
  type MemoryEvidenceObservation,
  type StoredMemory,
  type StoredMemoryEvidenceObservation,
} from "./types.js";
import { memoryReproducibilityFingerprint } from "./reproducibility.js";

const OBSERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SIMPLE_KINDS = new Set(["REPRODUCTION", "COUNTEREXAMPLE", "UNRESOLVED_CONTRADICTION"]);
const REVIEW_KINDS = new Set(["CONTAMINATION", "PRIVACY_REVIEW"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function assertDataProperties(value: Record<string, unknown>) {
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
    throw new TypeError("Evidence observations cannot contain symbol fields.");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor))
      throw new TypeError("Evidence observations cannot contain accessors.");
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  const actual = Object.getOwnPropertyNames(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index]))
    throw new TypeError("Evidence observation contains unknown or missing fields.");
}

function assertExactIsoTimestamp(value: unknown) {
  if (
    typeof value !== "string" ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new TypeError("observedAt must be an exact UTC ISO timestamp.");
}

/** Validate the complete, closed observation schema without coercion. */
export function assertMemoryEvidenceObservation(
  value: unknown,
): asserts value is MemoryEvidenceObservation {
  if (!isRecord(value)) throw new TypeError("Evidence observation must be a plain object.");
  assertDataProperties(value);
  if (value.protocol !== MEMORY_EVIDENCE_OBSERVATION_PROTOCOL)
    throw new TypeError("Unsupported memory evidence observation protocol.");
  if (typeof value.observationId !== "string" || !OBSERVATION_ID.test(value.observationId))
    throw new TypeError(
      "observationId must be 1-128 identifier characters (A-Z, a-z, 0-9, ., _, :, -).",
    );
  if (!isSha256Digest(value.sourceCaseDigest))
    throw new TypeError("sourceCaseDigest must be a SHA-256 digest.");
  if (value.sourceRunDigest !== undefined && !isSha256Digest(value.sourceRunDigest))
    throw new TypeError("sourceRunDigest must be a SHA-256 digest when present.");
  if (!isSha256Digest(value.evidenceDigest))
    throw new TypeError("evidenceDigest must be a SHA-256 digest.");
  assertExactIsoTimestamp(value.observedAt);

  if (typeof value.kind !== "string") throw new TypeError("Evidence observation kind is invalid.");
  if (SIMPLE_KINDS.has(value.kind)) {
    assertExactKeys(value, [
      "protocol",
      "observationId",
      "kind",
      "sourceCaseDigest",
      ...(value.sourceRunDigest === undefined ? [] : ["sourceRunDigest"]),
      "evidenceDigest",
      "observedAt",
    ]);
    return;
  }
  if (REVIEW_KINDS.has(value.kind)) {
    assertExactKeys(value, [
      "protocol",
      "observationId",
      "kind",
      "sourceCaseDigest",
      ...(value.sourceRunDigest === undefined ? [] : ["sourceRunDigest"]),
      "evidenceDigest",
      "observedAt",
      "passed",
    ]);
    if (typeof value.passed !== "boolean")
      throw new TypeError("Review evidence passed must be boolean.");
    return;
  }
  throw new TypeError("Evidence observation kind is invalid.");
}

export function memoryEvidenceObservationDigest(
  memoryDigest: string,
  observation: MemoryEvidenceObservation,
): string {
  if (!isSha256Digest(memoryDigest)) throw new TypeError("memoryDigest must be a SHA-256 digest.");
  assertMemoryEvidenceObservation(observation);
  return digestJson({
    protocol: MEMORY_EVIDENCE_OBSERVATION_PROTOCOL,
    memoryDigest,
    observation,
  } as unknown as JsonValue);
}

function compareObservations(
  left: StoredMemoryEvidenceObservation,
  right: StoredMemoryEvidenceObservation,
) {
  return (
    left.observation.sourceCaseDigest.localeCompare(right.observation.sourceCaseDigest) ||
    (left.observation.sourceRunDigest ?? "").localeCompare(
      right.observation.sourceRunDigest ?? "",
    ) ||
    left.observation.evidenceDigest.localeCompare(right.observation.evidenceDigest) ||
    left.observation.kind.localeCompare(right.observation.kind) ||
    left.observation.observationId.localeCompare(right.observation.observationId) ||
    left.observationDigest.localeCompare(right.observationDigest)
  );
}

function attribution(item: StoredMemoryEvidenceObservation): EvidenceAttribution {
  return Object.freeze({
    sourceCaseDigest: item.observation.sourceCaseDigest,
    ...(item.observation.sourceRunDigest === undefined
      ? {}
      : { sourceRunDigest: item.observation.sourceRunDigest }),
    evidenceDigest: item.observation.evidenceDigest,
  });
}

function sourceIdentity(value: StoredMemoryEvidenceObservation): string {
  return value.observation.sourceRunDigest ?? value.observation.sourceCaseDigest;
}

function onePerSource(
  values: readonly StoredMemoryEvidenceObservation[],
): readonly StoredMemoryEvidenceObservation[] {
  const result: StoredMemoryEvidenceObservation[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const identity = sourceIdentity(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
  }
  return result;
}

function reviewSelection(
  values: readonly StoredMemoryEvidenceObservation[],
): StoredMemoryEvidenceObservation | undefined {
  const failed = values.find(
    (value) =>
      (value.observation.kind === "CONTAMINATION" || value.observation.kind === "PRIVACY_REVIEW") &&
      !value.observation.passed,
  );
  return failed ?? values[0];
}

/**
 * Aggregate only durable observations. Ordering is canonical rather than append
 * order, so reopening a database or receiving observations in another order
 * yields the same TribunalEvidence digest.
 */
export function deriveTribunalEvidence(
  memory: StoredMemory,
  history: readonly StoredMemoryEvidenceObservation[],
): DerivedTribunalEvidence {
  if (!isSha256Digest(memory.digest))
    throw new TypeError("Stored memory digest must be a SHA-256 digest.");
  if (history.length > MAX_MEMORY_EVIDENCE_OBSERVATIONS)
    throw new RangeError("Memory evidence observation limit exceeded.");

  const observationDigests = new Set<string>();
  const sequences = new Set<number>();
  const fingerprint = memoryReproducibilityFingerprint(memory.candidate);
  for (const stored of history) {
    if (stored.memoryDigest !== memory.digest)
      throw new Error("Evidence observation belongs to another memory.");
    if (!Number.isSafeInteger(stored.sequence) || stored.sequence < 1)
      throw new TypeError("Evidence observation sequence must be a positive integer.");
    if (sequences.has(stored.sequence))
      throw new Error("Evidence history contains a duplicate sequence.");
    sequences.add(stored.sequence);
    assertMemoryEvidenceObservation(stored.observation);
    const expected = memoryEvidenceObservationDigest(memory.digest, stored.observation);
    if (stored.observationDigest !== expected)
      throw new Error("Evidence observation digest does not match its payload.");
    if (observationDigests.has(expected))
      throw new Error("Evidence history contains a duplicate observation.");
    observationDigests.add(expected);
    if (fingerprint) {
      if (!stored.observation.sourceRunDigest) {
        throw new Error(
          "Fingerprint-bound memory evidence requires an authenticated source run digest.",
        );
      }
      if (stored.observation.sourceRunDigest === fingerprint.origin.runDigest) {
        throw new Error("A memory's origin run cannot supply Tribunal evidence.");
      }
    } else if (
      memory.candidate.caseDigest
      && stored.observation.sourceCaseDigest === memory.candidate.caseDigest
    ) {
      throw new Error("A memory's origin Case cannot supply Tribunal evidence.");
    }
  }

  const ordered = [...history].sort(compareObservations);
  const reproductions = onePerSource(
    ordered.filter((item) => item.observation.kind === "REPRODUCTION"),
  );
  const counterexamples = ordered.filter((item) => item.observation.kind === "COUNTEREXAMPLE");
  const contradictions = ordered.filter(
    (item) => item.observation.kind === "UNRESOLVED_CONTRADICTION",
  );
  const contaminations = ordered.filter((item) => item.observation.kind === "CONTAMINATION");
  const privacyReviews = ordered.filter((item) => item.observation.kind === "PRIVACY_REVIEW");
  const contamination = reviewSelection(contaminations);
  const privacy = reviewSelection(privacyReviews);
  const contaminationPassed =
    contaminations.length > 0 &&
    contaminations.every(
      (item) => item.observation.kind === "CONTAMINATION" && item.observation.passed,
    );
  const privacyReviewPassed =
    privacyReviews.length > 0 &&
    privacyReviews.every(
      (item) => item.observation.kind === "PRIVACY_REVIEW" && item.observation.passed,
    );
  const sortedObservationDigests = Object.freeze(
    [...observationDigests].sort((left, right) => left.localeCompare(right)),
  );
  const evidence = Object.freeze({
    reproductionDigests: Object.freeze(
      reproductions.map((item) => item.observation.evidenceDigest),
    ),
    counterexampleDigests: Object.freeze(
      counterexamples.map((item) => item.observation.evidenceDigest),
    ),
    unresolvedContradictions: contradictions.length,
    contaminationPassed,
    ...(contamination
      ? { contaminationEvidenceDigest: contamination.observation.evidenceDigest }
      : {}),
    privacyReviewPassed,
    ...(privacy ? { privacyEvidenceDigest: privacy.observation.evidenceDigest } : {}),
    reproductionAttributions: Object.freeze(reproductions.map(attribution)),
    counterexampleAttributions: Object.freeze(counterexamples.map(attribution)),
    ...(contamination ? { contaminationAttribution: attribution(contamination) } : {}),
    ...(privacy ? { privacyAttribution: attribution(privacy) } : {}),
    unresolvedContradictionDigests: Object.freeze(
      contradictions.map((item) => item.observation.evidenceDigest),
    ),
    observationDigests: sortedObservationDigests,
  });
  const evidenceDigest = digestJson(evidence as unknown as JsonValue);
  return Object.freeze({
    protocol: TRIBUNAL_EVIDENCE_SNAPSHOT_PROTOCOL,
    memoryDigest: memory.digest,
    evidenceDigest,
    observationDigests: sortedObservationDigests,
    evidence,
  });
}
