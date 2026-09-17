import {
  canonicalize,
  digestJson,
  isSha256Digest,
  sha256Digest,
  type JsonValue,
} from "@jevyr/protocol";
import {
  DEFAULT_MIN_INDEPENDENT_REPRODUCTIONS,
  MAX_MEMORY_CANDIDATE_BYTES,
  MEMORY_DECISION_PROTOCOL,
  MEMORY_PROTOCOL,
  type CalibrationEvidence,
  type EvidenceAttribution,
  type MemoryCandidate,
  type MemoryDecision,
  type StoredMemory,
  type TribunalEvidence,
} from "./types.js";
import { memoryReproducibilityFingerprint } from "./reproducibility.js";

const SELF_ARCHIVE_KINDS = new Set(["strategy", "calibration", "blind_spot", "descriptor"]);

const SELF_ARCHIVE_KEYS = new Set([
  "strategyFingerprint",
  "calibration",
  "blindSpotCodes",
  "descriptor",
  "conditions",
  "failureSignature",
  "version",
]);

const MEMORY_SCOPES = new Set(["CASE", "PROJECT", "SELF"]);
const MEMORY_KINDS = new Set([
  "hypothesis_seed",
  "strategy",
  "calibration",
  "blind_spot",
  "descriptor",
  "scar",
]);
const MAX_DIGESTS = 4_096;
const MEMORY_CANDIDATE_REQUIRED_KEYS = new Set([
  "protocol",
  "scope",
  "kind",
  "abstractSummary",
  "content",
  "sourceMemoryDigests",
  "evidenceDigests",
]);
const MEMORY_CANDIDATE_OPTIONAL_KEYS = new Set(["projectId", "caseDigest", "supersedes"]);
const TRIBUNAL_KEYS = new Set([
  "reproductionDigests",
  "counterexampleDigests",
  "unresolvedContradictions",
  "contaminationPassed",
  "contaminationEvidenceDigest",
  "privacyReviewPassed",
  "privacyEvidenceDigest",
  "calibration",
  "reproductionAttributions",
  "counterexampleAttributions",
  "contaminationAttribution",
  "privacyAttribution",
  "unresolvedContradictionDigests",
  "observationDigests",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function candidateCanonicalValue(candidate: Record<string, unknown>): JsonValue {
  return {
    protocol: candidate.protocol as JsonValue,
    scope: candidate.scope as JsonValue,
    kind: candidate.kind as JsonValue,
    abstractSummary: candidate.abstractSummary as JsonValue,
    content: candidate.content as JsonValue,
    sourceMemoryDigests: candidate.sourceMemoryDigests as JsonValue,
    evidenceDigests: candidate.evidenceDigests as JsonValue,
    ...(candidate.projectId === undefined ? {} : { projectId: candidate.projectId as JsonValue }),
    ...(candidate.caseDigest === undefined ? {} : { caseDigest: candidate.caseDigest as JsonValue }),
    ...(candidate.supersedes === undefined ? {} : { supersedes: candidate.supersedes as JsonValue }),
  };
}

function assertDataObject(value: Record<string, unknown>, label: string) {
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol"))
    throw new TypeError(`${label} cannot contain symbol fields.`);
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) throw new TypeError(`${label} cannot contain accessors.`);
  }
}

function assertDigestArray(value: unknown, label: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_DIGESTS)
    throw new TypeError(`${label} must be a bounded array.`);
  if (!value.every(isSha256Digest))
    throw new TypeError(`${label} must contain only SHA-256 digests.`);
  if (new Set(value).size !== value.length)
    throw new TypeError(`${label} cannot contain duplicates.`);
}

function assertAttribution(value: unknown, label: string): asserts value is EvidenceAttribution {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object.`);
  assertDataObject(value, label);
  const keys = Object.getOwnPropertyNames(value).sort();
  const expected = value.sourceRunDigest === undefined
    ? ["evidenceDigest", "sourceCaseDigest"]
    : ["evidenceDigest", "sourceCaseDigest", "sourceRunDigest"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw new TypeError(`${label} contains unknown or missing fields.`);
  if (!isSha256Digest(value.sourceCaseDigest) || !isSha256Digest(value.evidenceDigest))
    throw new TypeError(`${label} requires source Case and evidence SHA-256 digests.`);
  if (value.sourceRunDigest !== undefined && !isSha256Digest(value.sourceRunDigest))
    throw new TypeError(`${label} sourceRunDigest must be a SHA-256 digest when present.`);
}

function assertAttributionArray(
  value: unknown,
  label: string,
): asserts value is readonly EvidenceAttribution[] {
  if (!Array.isArray(value) || value.length > MAX_DIGESTS)
    throw new TypeError(`${label} must be a bounded array.`);
  value.forEach((entry, index) => assertAttribution(entry, `${label}[${index}]`));
  const identities = value.map(
    (entry) => `${entry.sourceCaseDigest}:${entry.sourceRunDigest ?? "legacy"}:${entry.evidenceDigest}`,
  );
  if (new Set(identities).size !== identities.length)
    throw new TypeError(`${label} cannot contain duplicate attributions.`);
}

function assertCalibration(value: unknown): asserts value is CalibrationEvidence {
  if (!isPlainRecord(value)) throw new TypeError("calibration must be a plain object.");
  assertDataObject(value, "calibration");
  const keys = Object.getOwnPropertyNames(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "evidenceDigest" ||
    keys[1] !== "expected" ||
    keys[2] !== "observed" ||
    keys[3] !== "sampleSize"
  )
    throw new TypeError("calibration contains unknown or missing fields.");
  if (
    typeof value.sampleSize !== "number" ||
    !Number.isSafeInteger(value.sampleSize) ||
    value.sampleSize < 0 ||
    value.sampleSize > 1_000_000
  )
    throw new TypeError("calibration sampleSize is invalid.");
  if (
    typeof value.expected !== "number" ||
    !Number.isFinite(value.expected) ||
    typeof value.observed !== "number" ||
    !Number.isFinite(value.observed)
  )
    throw new TypeError("calibration values must be finite numbers.");
  if (!isSha256Digest(value.evidenceDigest))
    throw new TypeError("calibration evidenceDigest must be a SHA-256 digest.");
}

function sameDigests(digests: readonly string[], attributions: readonly EvidenceAttribution[]) {
  return (
    digests.length === attributions.length &&
    digests.every((digest, index) => digest === attributions[index]?.evidenceDigest)
  );
}

/** Strictly validate all supplied Tribunal evidence before adjudication. */
export function assertTribunalEvidence(value: unknown): asserts value is TribunalEvidence {
  if (!isPlainRecord(value)) throw new TypeError("Tribunal evidence must be a plain object.");
  assertDataObject(value, "Tribunal evidence");
  if (Object.getOwnPropertyNames(value).some((key) => !TRIBUNAL_KEYS.has(key)))
    throw new TypeError("Tribunal evidence contains an unknown field.");
  assertDigestArray(value.reproductionDigests, "reproductionDigests");
  assertDigestArray(value.counterexampleDigests, "counterexampleDigests");
  if (
    !Number.isSafeInteger(value.unresolvedContradictions) ||
    (value.unresolvedContradictions as number) < 0 ||
    (value.unresolvedContradictions as number) > MAX_DIGESTS
  )
    throw new TypeError("unresolvedContradictions is invalid.");
  if (
    typeof value.contaminationPassed !== "boolean" ||
    typeof value.privacyReviewPassed !== "boolean"
  )
    throw new TypeError("Tribunal review results must be boolean.");
  if (
    value.contaminationEvidenceDigest !== undefined &&
    !isSha256Digest(value.contaminationEvidenceDigest)
  )
    throw new TypeError("contaminationEvidenceDigest must be a SHA-256 digest.");
  if (value.privacyEvidenceDigest !== undefined && !isSha256Digest(value.privacyEvidenceDigest))
    throw new TypeError("privacyEvidenceDigest must be a SHA-256 digest.");
  if (value.calibration !== undefined) assertCalibration(value.calibration);
  if (value.reproductionAttributions !== undefined) {
    assertAttributionArray(value.reproductionAttributions, "reproductionAttributions");
    if (!sameDigests(value.reproductionDigests, value.reproductionAttributions))
      throw new TypeError("Reproduction digests and attributions do not match.");
  }
  if (value.counterexampleAttributions !== undefined) {
    assertAttributionArray(value.counterexampleAttributions, "counterexampleAttributions");
    if (!sameDigests(value.counterexampleDigests, value.counterexampleAttributions))
      throw new TypeError("Counterexample digests and attributions do not match.");
  }
  if (value.contaminationAttribution !== undefined) {
    assertAttribution(value.contaminationAttribution, "contaminationAttribution");
    if (value.contaminationEvidenceDigest !== value.contaminationAttribution.evidenceDigest)
      throw new TypeError("Contamination digest and attribution do not match.");
  }
  if (value.privacyAttribution !== undefined) {
    assertAttribution(value.privacyAttribution, "privacyAttribution");
    if (value.privacyEvidenceDigest !== value.privacyAttribution.evidenceDigest)
      throw new TypeError("Privacy digest and attribution do not match.");
  }
  if (value.unresolvedContradictionDigests !== undefined) {
    assertDigestArray(value.unresolvedContradictionDigests, "unresolvedContradictionDigests");
    if (value.unresolvedContradictionDigests.length !== value.unresolvedContradictions)
      throw new TypeError("Contradiction count and evidence digests do not match.");
  }
  if (value.observationDigests !== undefined)
    assertDigestArray(value.observationDigests, "observationDigests");
}

function assertIsoTimestamp(value: string) {
  if (Number.isNaN(Date.parse(value))) throw new TypeError("decidedAt must be an ISO timestamp.");
}

/** Validate the complete immutable memory-candidate wire shape before hashing or storage. */
export function assertMemoryCandidate(candidate: unknown): asserts candidate is MemoryCandidate {
  if (!isPlainRecord(candidate)) throw new TypeError("Memory candidate must be a plain object.");
  assertDataObject(candidate, "Memory candidate");
  const keys = Object.getOwnPropertyNames(candidate);
  if (
    [...MEMORY_CANDIDATE_REQUIRED_KEYS].some((key) => !keys.includes(key)) ||
    keys.some(
      (key) =>
        !MEMORY_CANDIDATE_REQUIRED_KEYS.has(key) && !MEMORY_CANDIDATE_OPTIONAL_KEYS.has(key),
    )
  ) {
    throw new TypeError("Memory candidate contains unknown or missing fields.");
  }
  let encoded: string;
  try {
    encoded = canonicalize(candidateCanonicalValue(candidate));
  } catch (error) {
    throw new TypeError(
      `Memory candidate must contain inert canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_MEMORY_CANDIDATE_BYTES) {
    throw new RangeError(
      `Memory candidate exceeds the ${MAX_MEMORY_CANDIDATE_BYTES}-byte canonical boundary.`,
    );
  }
  if (candidate.protocol !== MEMORY_PROTOCOL) throw new TypeError("Unsupported memory protocol.");
  if (typeof candidate.scope !== "string" || !MEMORY_SCOPES.has(candidate.scope))
    throw new TypeError("Memory scope is invalid.");
  if (typeof candidate.kind !== "string" || !MEMORY_KINDS.has(candidate.kind))
    throw new TypeError("Memory kind is invalid.");
  if (typeof candidate.abstractSummary !== "string" || !candidate.abstractSummary.trim())
    throw new TypeError("Memory abstractSummary cannot be empty.");
  if (candidate.abstractSummary.length > 1_000)
    throw new RangeError("Memory abstractSummary exceeds 1,000 characters.");
  if (!Array.isArray(candidate.evidenceDigests) || !candidate.evidenceDigests.every(isSha256Digest))
    throw new TypeError("Memory evidence digests must be SHA-256 digests.");
  if (
    !Array.isArray(candidate.sourceMemoryDigests) ||
    !candidate.sourceMemoryDigests.every(isSha256Digest)
  )
    throw new TypeError("Source memory digests must be SHA-256 digests.");
  if (candidate.supersedes !== undefined && !isSha256Digest(candidate.supersedes))
    throw new TypeError("supersedes must be a SHA-256 digest.");
  if (candidate.caseDigest !== undefined && !isSha256Digest(candidate.caseDigest))
    throw new TypeError("caseDigest must be a SHA-256 digest.");
  if (
    candidate.projectId !== undefined &&
    (typeof candidate.projectId !== "string" ||
      candidate.projectId.length < 1 ||
      candidate.projectId.length > 256)
  )
    throw new TypeError("projectId must contain 1-256 characters.");
  if (candidate.evidenceDigests.length > 256 || candidate.sourceMemoryDigests.length > 256)
    throw new RangeError("Memory lineage exceeds 256 digests.");
  if (
    new Set(candidate.evidenceDigests).size !== candidate.evidenceDigests.length ||
    new Set(candidate.sourceMemoryDigests).size !== candidate.sourceMemoryDigests.length
  )
    throw new TypeError("Memory lineage cannot contain duplicate digests.");

  if (candidate.scope === "CASE" && (!candidate.caseDigest || !candidate.projectId))
    throw new TypeError("CASE memory requires caseDigest and projectId.");
  if (candidate.scope === "PROJECT" && !candidate.projectId)
    throw new TypeError("PROJECT memory requires projectId.");
  if (candidate.scope === "SELF") {
    if (candidate.projectId || candidate.caseDigest)
      throw new TypeError("SELF archive entries cannot carry project or case identifiers.");
    if (!SELF_ARCHIVE_KINDS.has(candidate.kind))
      throw new TypeError(
        "SELF archive accepts only abstract strategies, calibration, blind spots, and descriptors.",
      );
  }
}

export function stageMemory(candidate: MemoryCandidate): StoredMemory {
  assertMemoryCandidate(candidate);
  const canonical = canonicalize(candidateCanonicalValue(candidate as unknown as Record<string, unknown>));
  // This is an internal clone of text emitted by canonicalize after the complete
  // inert candidate shape was validated. It is not an ingestion boundary.
  const frozen = deepFreezeJson(JSON.parse(canonical) as MemoryCandidate);
  return Object.freeze({
    digest: sha256Digest(canonical),
    candidate: frozen,
  });
}

function deepFreezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function hasOnlySelfArchiveKeys(content: JsonValue): boolean {
  if (content === null || Array.isArray(content) || typeof content !== "object") return false;
  return Object.keys(content).every((key) => SELF_ARCHIVE_KEYS.has(key));
}

/**
 * Memory may seed later hypotheses. It cannot become evidence merely by passing
 * this tribunal, and it never participates in the first divergent wave.
 */
export function adjudicateMemory(
  memory: StoredMemory,
  evidence: TribunalEvidence,
  decidedAt: string,
): MemoryDecision {
  assertIsoTimestamp(decidedAt);
  assertTribunalEvidence(evidence);
  const expectedDigest = digestJson(memory.candidate as unknown as JsonValue);
  if (expectedDigest !== memory.digest)
    throw new Error("Stored memory digest does not match its candidate.");
  const reasons: string[] = [];
  let terminalFailure = false;
  const pending = (reason: string): void => {
    reasons.push(reason);
  };
  const reject = (reason: string): void => {
    terminalFailure = true;
    reasons.push(reason);
  };
  if (memory.candidate.evidenceDigests.length === 0)
    reject("candidate has no originating evidence");
  const reproductionAttributions = evidence.reproductionAttributions ?? [];
  const fingerprint = memoryReproducibilityFingerprint(memory.candidate);
  if (fingerprint && reproductionAttributions.some((entry) => !entry.sourceRunDigest)) {
    reject("fingerprint-bound reproduction lacks an authenticated source run identity");
  }
  const independentSources = new Set(
    reproductionAttributions.map((entry) => entry.sourceRunDigest ?? entry.sourceCaseDigest),
  );
  const independentEvidence = new Set(
    reproductionAttributions.map((entry) => entry.evidenceDigest),
  );
  if (
    independentSources.size < DEFAULT_MIN_INDEPENDENT_REPRODUCTIONS ||
    independentEvidence.size < DEFAULT_MIN_INDEPENDENT_REPRODUCTIONS
  )
    pending(
      `candidate requires at least ${DEFAULT_MIN_INDEPENDENT_REPRODUCTIONS} independently attributed reproductions`,
    );
  if (fingerprint) {
    if (
      reproductionAttributions.some(
        (entry) => entry.sourceRunDigest === fingerprint.origin.runDigest,
      )
    ) {
      reject("candidate origin run cannot count as a reproduction");
    }
  } else if (
    memory.candidate.caseDigest
    && reproductionAttributions.some(
      (entry) => entry.sourceCaseDigest === memory.candidate.caseDigest,
    )
  ) {
    reject("candidate origin Case cannot count as a reproduction");
  }
  if (evidence.counterexampleDigests.length > 0)
    reject("candidate has counterexample evidence");
  if (evidence.unresolvedContradictions > 0)
    pending("candidate has unresolved contradictions");
  if (!evidence.observationDigests || evidence.observationDigests.length === 0)
    pending("tribunal evidence is not derived from durable observations");
  if (!evidence.contaminationEvidenceDigest) pending("candidate lacks contamination evidence");
  if (!evidence.contaminationAttribution)
    pending("contamination result is not attributed to a stored observation");
  if (
    evidence.contaminationEvidenceDigest &&
    evidence.contaminationAttribution &&
    !evidence.contaminationPassed
  ) {
    reject("candidate failed contamination testing");
  }

  if (memory.candidate.scope === "SELF") {
    if (!evidence.privacyEvidenceDigest)
      pending("cross-project abstraction lacks privacy evidence");
    if (!evidence.privacyAttribution)
      pending("cross-project privacy result is not attributed to a stored observation");
    if (
      evidence.privacyEvidenceDigest &&
      evidence.privacyAttribution &&
      !evidence.privacyReviewPassed
    ) {
      reject("cross-project abstraction failed privacy review");
    }
    if (!hasOnlySelfArchiveKeys(memory.candidate.content))
      reject("cross-project content is not restricted to the abstract schema");
    if (memory.candidate.sourceMemoryDigests.length === 0)
      reject("cross-project abstraction has no source-memory lineage");
  }

  if (memory.candidate.kind === "calibration") {
    if (!evidence.calibration) pending("calibration memory lacks calibration evidence");
    else {
      if (evidence.calibration.sampleSize < 20) pending("calibration sample is too small");
      if (Math.abs(evidence.calibration.expected - evidence.calibration.observed) > 0.2)
        reject("calibration error exceeds tribunal tolerance");
    }
  }

  const decision = reasons.length === 0 ? "ADMIT" : terminalFailure ? "REJECT" : "PENDING";
  const tribunalEvidenceDigest = digestJson(evidence as unknown as JsonValue);
  const unsigned = {
    protocol: MEMORY_DECISION_PROTOCOL,
    memoryDigest: memory.digest,
    decision,
    reasons,
    decidedAt,
    tribunalEvidenceDigest,
  } as const;
  const decisionDigest = digestJson(unsigned as unknown as JsonValue);
  return Object.freeze({
    ...unsigned,
    decisionDigest,
    reasons: Object.freeze(reasons),
  });
}
