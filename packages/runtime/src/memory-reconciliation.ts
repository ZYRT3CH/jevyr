import {
  canonicalize,
  digestJson,
  isSha256Digest,
  sha256Digest,
  type DsseEnvelope,
  type Feasibility,
  type JevyrVerdict,
  type JsonValue,
  type MemoryInfluencePayload,
  type SealedCase,
  type SignedRecord,
} from "@jevyr/protocol";
import {
  MEMORY_EVIDENCE_OBSERVATION_PROTOCOL,
  MEMORY_REPRODUCIBILITY_PROTOCOL,
  assertMemoryReproducibilityFingerprint,
  assertVerifiedMemoryLineage,
  memoryReproducibilityFingerprint,
  memoryReproducibilityFingerprintDigest,
  stageMemory,
  type MemoryCandidate,
  type MemoryEvidenceObservation,
  type MemoryReproducibilityFingerprint,
  type StoredMemory,
  type VerifiedMemoryLineage,
} from "@jevyr/memory";
import { stableId } from "./canonical.js";

export const MEMORY_RECONCILIATION_EVIDENCE_PROTOCOL = "jevyr.memory-reconciliation-evidence/1" as const;
export const MEMORY_RECONCILIATION_EVIDENCE_MEDIA_TYPE = "application/vnd.jevyr.memory-reconciliation+json" as const;
export const MAX_MEMORY_RECONCILIATION_EVIDENCE_BYTES = 262_144 as const;

export type MemoryReconciliationClassification =
  | "REPRODUCTION"
  | "COUNTEREXAMPLE"
  | "INCOMPARABLE_TASK"
  | "INCOMPARABLE_MECHANISM"
  | "CONTAMINATED_EXCLUDED"
  | "NON_LATER_EXCLUDED"
  | "SAME_ORIGIN_EXCLUDED"
  | "PROJECT_MISMATCH_EXCLUDED";

export interface MemoryCandidateProjectionInput {
  readonly projectId: string;
  readonly sealed: SealedCase;
  readonly verdict: JevyrVerdict;
  readonly memoryInfluences: readonly MemoryInfluencePayload[];
  /** Exact descriptor whose digest equals sealed.policyDigest. */
  readonly policyDescriptor: JsonValue;
}

export interface VerifiedCommittedMemoryCase {
  readonly memory: StoredMemory;
  readonly stagedAt: string;
  readonly projectId: string;
  readonly fingerprint: MemoryReproducibilityFingerprint;
  readonly fingerprintDigest: string;
  readonly chronology: {
    readonly sealedAt: string;
    readonly stagedAt: string;
    readonly crystallizedAt: string;
  };
  readonly recordBinding: {
    readonly caseDigest: string;
    readonly runDigest: string;
    readonly recordDigest: string;
    readonly recordEnvelopeDigest: string;
    readonly eventHeadDigest: string;
    readonly verdictEvidenceDigest: string;
  };
}

export interface MemoryReconciliationComparison {
  readonly protocol: "jevyr.memory-reconciliation-comparison/1";
  readonly target: VerifiedCommittedMemoryCase;
  readonly source: VerifiedCommittedMemoryCase;
  readonly classification: MemoryReconciliationClassification;
  readonly taskExact: boolean;
  readonly mechanismExact: boolean;
  readonly outcomeExact: boolean;
  readonly chronologyValid: boolean;
  readonly independentIdentity: boolean;
  readonly projectExact: boolean;
  readonly contaminationPassed: boolean;
  readonly targetAncestry: VerifiedMemoryLineage;
  readonly sourceInfluences: VerifiedMemoryLineage;
  /** Target candidate plus the fixed-point closure of everything that informed it. */
  readonly targetMemoryLineageDigests: readonly string[];
  /** Fixed-point closure of every memory that informed the later source Case. */
  readonly sourceMemoryLineageDigests: readonly string[];
  readonly sharedMemoryInfluenceDigests: readonly string[];
  readonly comparisonDigest: string;
}

export interface MemoryReconciliationLineages {
  readonly targetAncestry: VerifiedMemoryLineage;
  readonly sourceInfluences: VerifiedMemoryLineage;
}

export interface MemoryReconciliationEvidence {
  readonly protocol: typeof MEMORY_RECONCILIATION_EVIDENCE_PROTOCOL;
  readonly evidenceRole: "OUTCOME" | "CONTAMINATION" | "EXCLUSION";
  readonly classification: MemoryReconciliationClassification;
  readonly target: {
    readonly memoryDigest: string;
    readonly fingerprintDigest: string;
    readonly recordDigest: string;
    readonly recordEnvelopeDigest: string;
    readonly caseDigest: string;
    readonly runDigest: string;
    readonly eventHeadDigest: string;
    readonly verdictEvidenceDigest: string;
    readonly sealedAt: string;
    readonly stagedAt: string;
    readonly crystallizedAt: string;
  };
  readonly source: {
    readonly memoryDigest: string;
    readonly fingerprintDigest: string;
    readonly recordDigest: string;
    readonly recordEnvelopeDigest: string;
    readonly caseDigest: string;
    readonly runDigest: string;
    readonly eventHeadDigest: string;
    readonly verdictEvidenceDigest: string;
    readonly sealedAt: string;
    readonly stagedAt: string;
    readonly crystallizedAt: string;
  };
  readonly comparison: {
    readonly comparisonDigest: string;
    readonly taskExact: boolean;
    readonly mechanismExact: boolean;
    readonly outcomeExact: boolean;
    readonly chronologyValid: boolean;
    readonly independentIdentity: boolean;
    readonly projectExact: boolean;
    readonly contaminationPassed: boolean;
    readonly targetAncestryLineageDigest: string;
    readonly targetAncestryAdmissionBindingDigest: string;
    readonly sourceInfluenceLineageDigest: string;
    readonly sourceInfluenceAdmissionBindingDigest: string;
    readonly targetMemoryLineageDigests: readonly string[];
    readonly sourceMemoryLineageDigests: readonly string[];
    readonly sharedMemoryInfluenceDigests: readonly string[];
  };
}

export interface EncodedMemoryReconciliationEvidence {
  readonly evidence: MemoryReconciliationEvidence;
  readonly mediaType: typeof MEMORY_RECONCILIATION_EVIDENCE_MEDIA_TYPE;
  readonly digest: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function exactArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertTimestamp(value: string, label: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError(`${label} must be an exact UTC ISO timestamp.`);
  }
}

/** Extract only the exact policy-bound frontier identity; absence remains explicit null. */
export function policyAssayFrontierDigest(policyDescriptor: JsonValue): string | null {
  const descriptor = object(policyDescriptor);
  const policy = object(descriptor?.policy);
  const value = policy?.assayFrontierDigest;
  if (value === undefined || value === null) return null;
  if (!isSha256Digest(value)) {
    throw new TypeError("Policy assayFrontierDigest must be a SHA-256 digest when present.");
  }
  return value;
}

export function deriveMemoryReproducibilityFingerprint(
  sealed: SealedCase,
  verdict: JevyrVerdict,
  assayFrontierDigest: string | null,
): MemoryReproducibilityFingerprint {
  if (
    !isSha256Digest(sealed.caseDigest)
    || !isSha256Digest(sealed.runDigest)
    || !isSha256Digest(sealed.intentContractDigest)
    || !isSha256Digest(sealed.subjectMaterialCaptureDigest)
    || !isSha256Digest(sealed.policyDigest)
    || !isSha256Digest(sealed.genomeDigest)
    || !isSha256Digest(sealed.searchEnvelope.digest)
  ) {
    throw new TypeError("Sealed Case has an invalid reproducibility identity.");
  }
  if (assayFrontierDigest !== null && !isSha256Digest(assayFrontierDigest)) {
    throw new TypeError("Assay Frontier identity must be a SHA-256 digest or null.");
  }
  if (verdict.intentContractDigest !== sealed.intentContractDigest) {
    throw new Error("Verdict intent contract does not match the sealed reproducibility task.");
  }
  const feasibilityProfile = Object.values(verdict.feasibilityByCandidate)
    .sort((left, right) => left.localeCompare(right));
  const selectedFeasibility = verdict.selectedCandidateId === undefined
    ? null
    : verdict.feasibilityByCandidate[verdict.selectedCandidateId];
  if (verdict.selectedCandidateId !== undefined && selectedFeasibility === undefined) {
    throw new Error("Selected candidate has no feasibility in the signed verdict.");
  }
  const fingerprint: MemoryReproducibilityFingerprint = {
    protocol: MEMORY_REPRODUCIBILITY_PROTOCOL,
    origin: {
      caseDigest: sealed.caseDigest,
      runDigest: sealed.runDigest,
    },
    task: {
      intentContractDigest: sealed.intentContractDigest,
      subjectMaterialCaptureDigest: sealed.subjectMaterialCaptureDigest,
    },
    mechanism: {
      policyDigest: sealed.policyDigest,
      genomeDigest: sealed.genomeDigest,
      // SearchEnvelope.digest covers the profile and seed-derivation rule, not
      // the run-derived seed. Distinct Cases can therefore compare honestly.
      searchProfileDigest: sealed.searchEnvelope.digest,
      assayFrontierDigest,
    },
    outcome: {
      integrity: verdict.integrity,
      creation: verdict.creation,
      embodiment: verdict.embodiment,
      judgment: verdict.judgment,
      feasibilityProfile,
      selectedFeasibility: selectedFeasibility ?? null,
      basisCodes: verdict.basis.map((entry) => entry.code).sort((left, right) => left.localeCompare(right)),
    },
  };
  assertMemoryReproducibilityFingerprint(fingerprint);
  return structuredClone(fingerprint);
}

/** Deterministic projection committed before the Record, then bound by its eventHeadDigest. */
export function projectMemoryCandidate(input: MemoryCandidateProjectionInput): MemoryCandidate {
  if (!input.projectId.trim() || input.projectId.length > 256) {
    throw new TypeError("Memory project id must contain 1-256 characters.");
  }
  if (digestJson(input.policyDescriptor) !== input.sealed.policyDigest) {
    throw new Error("Memory projection policy descriptor does not match the sealed policy digest.");
  }
  const sourceMemoryDigests = input.memoryInfluences.map((entry) => entry.memoryDigest);
  if (new Set(sourceMemoryDigests).size !== sourceMemoryDigests.length) {
    throw new Error("Memory projection contains duplicate source-memory influences.");
  }
  const fingerprint = deriveMemoryReproducibilityFingerprint(
    input.sealed,
    input.verdict,
    policyAssayFrontierDigest(input.policyDescriptor),
  );
  return stageMemory({
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: input.verdict.judgment === "ACCEPT" ? "descriptor" : "scar",
    abstractSummary: `Exact ${input.verdict.judgment} outcome trace; quarantined pending independent same-task reproduction.`,
    content: {
      conditions: {
        integrity: input.verdict.integrity,
        creation: input.verdict.creation,
        embodiment: input.verdict.embodiment,
        judgment: input.verdict.judgment,
      },
      failureSignature: input.verdict.basis.map((entry) => entry.code).sort((left, right) => left.localeCompare(right)),
      reproducibility: fingerprint as unknown as JsonValue,
      version: input.sealed.genomeVersion,
    },
    sourceMemoryDigests,
    evidenceDigests: [input.verdict.evidenceDigest],
    projectId: input.projectId,
    caseDigest: input.sealed.caseDigest,
  }).candidate;
}

/**
 * Bind a committed candidate to the exact signed Record projection. Signature,
 * Seal, event-chain, and commitment-event verification are caller prerequisites.
 */
export function bindVerifiedCommittedMemoryCase(input: {
  readonly memory: StoredMemory;
  readonly stagedAt: string;
  readonly sealed: SealedCase;
  readonly record: SignedRecord;
  readonly recordEnvelope: DsseEnvelope;
  readonly policyDescriptor: JsonValue;
  readonly projectId: string;
}): VerifiedCommittedMemoryCase {
  assertTimestamp(input.stagedAt, "stagedAt");
  assertTimestamp(input.sealed.sealedAt, "sealed.sealedAt");
  assertTimestamp(input.record.crystallizedAt, "record.crystallizedAt");
  const canonical = stageMemory(input.memory.candidate);
  if (canonical.digest !== input.memory.digest) {
    throw new Error("Committed memory digest does not match its candidate.");
  }
  const expected = stageMemory(projectMemoryCandidate({
    projectId: input.projectId,
    sealed: input.sealed,
    verdict: input.record.verdict,
    memoryInfluences: input.record.memoryInfluences,
    policyDescriptor: input.policyDescriptor,
  }));
  if (
    expected.digest !== input.memory.digest
    || canonicalize(expected.candidate as unknown as JsonValue)
      !== canonicalize(input.memory.candidate as unknown as JsonValue)
  ) {
    throw new Error("Committed memory is not the deterministic signed Record projection.");
  }
  if (
    input.record.caseDigest !== input.sealed.caseDigest
    || input.record.runDigest !== input.sealed.runDigest
    || input.record.policyDigest !== input.sealed.policyDigest
    || input.record.genomeDigest !== input.sealed.genomeDigest
    || input.record.searchDigest !== input.sealed.searchEnvelope.digest
    || input.record.intentContractDigest !== input.sealed.intentContractDigest
    || input.record.verdict.intentContractDigest !== input.sealed.intentContractDigest
    || input.memory.candidate.projectId !== input.projectId
    || input.memory.candidate.caseDigest !== input.record.caseDigest
    || !exactArray(
      input.memory.candidate.sourceMemoryDigests,
      input.record.memoryInfluences.map((entry) => entry.memoryDigest),
    )
    || input.memory.candidate.evidenceDigests.length !== 1
    || input.memory.candidate.evidenceDigests[0] !== input.record.verdict.evidenceDigest
    || Date.parse(input.sealed.sealedAt) > Date.parse(input.stagedAt)
    || Date.parse(input.stagedAt) > Date.parse(input.record.crystallizedAt)
  ) {
    throw new Error("Committed memory does not bind the signed Case identity, chronology, or evidence.");
  }
  const fingerprint = memoryReproducibilityFingerprint(input.memory.candidate);
  if (!fingerprint) throw new Error("Committed memory has no reproducibility fingerprint.");
  const recordDigest = digestJson(input.record as unknown as JsonValue);
  const recordEnvelopeDigest = digestJson(input.recordEnvelope as unknown as JsonValue);
  return Object.freeze({
    memory: canonical,
    stagedAt: input.stagedAt,
    projectId: input.projectId,
    fingerprint: Object.freeze(fingerprint),
    fingerprintDigest: memoryReproducibilityFingerprintDigest(fingerprint),
    chronology: Object.freeze({
      sealedAt: input.sealed.sealedAt,
      stagedAt: input.stagedAt,
      crystallizedAt: input.record.crystallizedAt,
    }),
    recordBinding: Object.freeze({
      caseDigest: input.record.caseDigest,
      runDigest: input.record.runDigest,
      recordDigest,
      recordEnvelopeDigest,
      eventHeadDigest: input.record.eventHeadDigest,
      verdictEvidenceDigest: input.record.verdict.evidenceDigest,
    }),
  });
}

function equalValue(left: JsonValue, right: JsonValue): boolean {
  return canonicalize(left) === canonicalize(right);
}

/** No model judgment or semantic similarity enters this classifier. */
export function compareCommittedMemoryCases(
  target: VerifiedCommittedMemoryCase,
  source: VerifiedCommittedMemoryCase,
  lineages: MemoryReconciliationLineages,
): MemoryReconciliationComparison {
  assertVerifiedMemoryLineage(lineages.targetAncestry);
  assertVerifiedMemoryLineage(lineages.sourceInfluences);
  if (
    lineages.targetAncestry.projectId !== target.projectId
    || !exactArray(
      lineages.targetAncestry.rootMemoryDigests,
      target.memory.candidate.sourceMemoryDigests,
    )
  ) {
    throw new Error("Target memory ancestry does not match its exact committed candidate roots.");
  }
  if (
    lineages.sourceInfluences.projectId !== source.projectId
    || !exactArray(
      lineages.sourceInfluences.rootMemoryDigests,
      source.memory.candidate.sourceMemoryDigests,
    )
  ) {
    throw new Error("Source memory lineage does not match its exact signed Record influences.");
  }
  if (lineages.targetAncestry.memoryDigests.includes(target.memory.digest)) {
    throw new Error("Target memory cannot appear in its own verified ancestry.");
  }
  if (lineages.sourceInfluences.memoryDigests.includes(source.memory.digest)) {
    throw new Error("Source memory cannot appear in its own verified influence closure.");
  }
  const projectExact = target.projectId === source.projectId;
  const chronologyValid = Date.parse(source.chronology.sealedAt) > Date.parse(target.chronology.stagedAt)
    && Date.parse(source.chronology.stagedAt) > Date.parse(target.chronology.stagedAt)
    && Date.parse(source.chronology.crystallizedAt) > Date.parse(target.chronology.stagedAt);
  // Equal task/material submissions deliberately share a content caseDigest.
  // Independence is therefore an execution property: a distinct authenticated
  // run that produced a distinct committed memory instance.
  const independentIdentity = target.recordBinding.runDigest !== source.recordBinding.runDigest
    && target.memory.digest !== source.memory.digest;
  const taskExact = target.recordBinding.caseDigest === source.recordBinding.caseDigest
    && equalValue(
      target.fingerprint.task as unknown as JsonValue,
      source.fingerprint.task as unknown as JsonValue,
    );
  const mechanismExact = equalValue(
    target.fingerprint.mechanism as unknown as JsonValue,
    source.fingerprint.mechanism as unknown as JsonValue,
  );
  const outcomeExact = equalValue(
    target.fingerprint.outcome as unknown as JsonValue,
    source.fingerprint.outcome as unknown as JsonValue,
  );
  const targetMemoryLineageDigests = [
    target.memory.digest,
    ...lineages.targetAncestry.memoryDigests,
  ].sort((left, right) => left.localeCompare(right));
  const sourceMemoryLineageDigests = [...lineages.sourceInfluences.memoryDigests];
  const targetLineage = new Set(targetMemoryLineageDigests);
  const sharedMemoryInfluenceDigests = sourceMemoryLineageDigests
    .filter((digest) => targetLineage.has(digest))
    .sort((left, right) => left.localeCompare(right));
  const contaminationPassed = sharedMemoryInfluenceDigests.length === 0;

  let classification: MemoryReconciliationClassification;
  if (!projectExact) classification = "PROJECT_MISMATCH_EXCLUDED";
  else if (!independentIdentity) classification = "SAME_ORIGIN_EXCLUDED";
  else if (!chronologyValid) classification = "NON_LATER_EXCLUDED";
  else if (!contaminationPassed) classification = "CONTAMINATED_EXCLUDED";
  else if (!taskExact) classification = "INCOMPARABLE_TASK";
  else if (!mechanismExact) classification = "INCOMPARABLE_MECHANISM";
  else classification = outcomeExact ? "REPRODUCTION" : "COUNTEREXAMPLE";

  const unsigned = {
    protocol: "jevyr.memory-reconciliation-comparison/1" as const,
    target,
    source,
    classification,
    taskExact,
    mechanismExact,
    outcomeExact,
    chronologyValid,
    independentIdentity,
    projectExact,
    contaminationPassed,
    targetAncestry: lineages.targetAncestry,
    sourceInfluences: lineages.sourceInfluences,
    targetMemoryLineageDigests,
    sourceMemoryLineageDigests,
    sharedMemoryInfluenceDigests,
  };
  const comparisonDigest = digestJson(unsigned as unknown as JsonValue);
  return Object.freeze({
    ...unsigned,
    targetMemoryLineageDigests: Object.freeze(targetMemoryLineageDigests),
    sourceMemoryLineageDigests: Object.freeze(sourceMemoryLineageDigests),
    sharedMemoryInfluenceDigests: Object.freeze(sharedMemoryInfluenceDigests),
    comparisonDigest,
  });
}

function publicBinding(value: VerifiedCommittedMemoryCase) {
  return Object.freeze({
    memoryDigest: value.memory.digest,
    fingerprintDigest: value.fingerprintDigest,
    recordDigest: value.recordBinding.recordDigest,
    recordEnvelopeDigest: value.recordBinding.recordEnvelopeDigest,
    caseDigest: value.recordBinding.caseDigest,
    runDigest: value.recordBinding.runDigest,
    eventHeadDigest: value.recordBinding.eventHeadDigest,
    verdictEvidenceDigest: value.recordBinding.verdictEvidenceDigest,
    sealedAt: value.chronology.sealedAt,
    stagedAt: value.chronology.stagedAt,
    crystallizedAt: value.chronology.crystallizedAt,
  });
}

export function encodeMemoryReconciliationEvidence(
  comparison: MemoryReconciliationComparison,
  evidenceRole: MemoryReconciliationEvidence["evidenceRole"],
): EncodedMemoryReconciliationEvidence {
  const decisive = comparison.classification === "REPRODUCTION"
    || comparison.classification === "COUNTEREXAMPLE";
  if ((evidenceRole === "OUTCOME" || evidenceRole === "CONTAMINATION") && !decisive) {
    throw new Error("Excluded comparison cannot create a Tribunal evidence artifact.");
  }
  if (evidenceRole === "EXCLUSION" && decisive) {
    throw new Error("Decisive comparison must use outcome and contamination evidence artifacts.");
  }
  const evidence: MemoryReconciliationEvidence = {
    protocol: MEMORY_RECONCILIATION_EVIDENCE_PROTOCOL,
    evidenceRole,
    classification: comparison.classification,
    target: publicBinding(comparison.target),
    source: publicBinding(comparison.source),
    comparison: {
      comparisonDigest: comparison.comparisonDigest,
      taskExact: comparison.taskExact,
      mechanismExact: comparison.mechanismExact,
      outcomeExact: comparison.outcomeExact,
      chronologyValid: comparison.chronologyValid,
      independentIdentity: comparison.independentIdentity,
      projectExact: comparison.projectExact,
      contaminationPassed: comparison.contaminationPassed,
      targetAncestryLineageDigest: comparison.targetAncestry.lineageDigest,
      targetAncestryAdmissionBindingDigest:
        comparison.targetAncestry.admissionBindingDigest,
      sourceInfluenceLineageDigest: comparison.sourceInfluences.lineageDigest,
      sourceInfluenceAdmissionBindingDigest:
        comparison.sourceInfluences.admissionBindingDigest,
      targetMemoryLineageDigests: comparison.targetMemoryLineageDigests,
      sourceMemoryLineageDigests: comparison.sourceMemoryLineageDigests,
      sharedMemoryInfluenceDigests: comparison.sharedMemoryInfluenceDigests,
    },
  };
  const text = canonicalize(evidence as unknown as JsonValue);
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_MEMORY_RECONCILIATION_EVIDENCE_BYTES) {
    throw new RangeError("Memory reconciliation evidence exceeds its canonical byte boundary.");
  }
  return Object.freeze({
    evidence: Object.freeze(evidence),
    mediaType: MEMORY_RECONCILIATION_EVIDENCE_MEDIA_TYPE,
    digest: sha256Digest(bytes),
    size: bytes.byteLength,
    bytes,
  });
}

export function reconciliationObservations(
  comparison: MemoryReconciliationComparison,
  outcomeEvidenceDigest: string,
  contaminationEvidenceDigest: string,
  observedAt: string,
): readonly MemoryEvidenceObservation[] {
  if (
    comparison.classification !== "REPRODUCTION"
    && comparison.classification !== "COUNTEREXAMPLE"
  ) {
    throw new Error("Excluded comparison cannot create Tribunal observations.");
  }
  if (!isSha256Digest(outcomeEvidenceDigest) || !isSha256Digest(contaminationEvidenceDigest)) {
    throw new TypeError("Reconciliation observations require evidence artifact digests.");
  }
  if (outcomeEvidenceDigest === contaminationEvidenceDigest) {
    throw new Error("Outcome and contamination evidence must have distinct artifacts.");
  }
  assertTimestamp(observedAt, "observedAt");
  const sourceCaseDigest = comparison.source.recordBinding.caseDigest;
  const sourceRunDigest = comparison.source.recordBinding.runDigest;
  const identity = {
    targetMemoryDigest: comparison.target.memory.digest,
    sourceCaseDigest,
    sourceRunDigest,
  };
  return Object.freeze([
    Object.freeze({
      protocol: MEMORY_EVIDENCE_OBSERVATION_PROTOCOL,
      observationId: stableId("memory-reconciliation", { ...identity, kind: comparison.classification }),
      kind: comparison.classification,
      sourceCaseDigest,
      sourceRunDigest,
      evidenceDigest: outcomeEvidenceDigest,
      observedAt,
    }),
    Object.freeze({
      protocol: MEMORY_EVIDENCE_OBSERVATION_PROTOCOL,
      observationId: stableId("memory-reconciliation", { ...identity, kind: "CONTAMINATION" }),
      kind: "CONTAMINATION",
      sourceCaseDigest,
      sourceRunDigest,
      evidenceDigest: contaminationEvidenceDigest,
      observedAt,
      passed: true,
    }),
  ]);
}

export function feasibilityProfile(verdict: JevyrVerdict): readonly Feasibility[] {
  return Object.freeze(Object.values(verdict.feasibilityByCandidate).sort((left, right) => left.localeCompare(right)));
}
