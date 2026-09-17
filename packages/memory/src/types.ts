import type { JsonValue, LifecycleStage, MemoryInfluencePayload } from "@jevyr/protocol";

export const MEMORY_PROTOCOL = "jevyr.memory/1" as const;
export const MEMORY_CANDIDATE_MEDIA_TYPE = "application/vnd.jevyr.memory+json" as const;
export const MAX_MEMORY_CANDIDATE_BYTES = 262_144 as const;
export const MEMORY_DECISION_PROTOCOL = "jevyr.memory-decision/1" as const;
export const MEMORY_EVIDENCE_OBSERVATION_PROTOCOL = "jevyr.memory-evidence-observation/1" as const;
export const TRIBUNAL_EVIDENCE_SNAPSHOT_PROTOCOL = "jevyr.tribunal-evidence-snapshot/1" as const;
export const MEMORY_LINEAGE_PROTOCOL = "jevyr.memory-lineage/1" as const;

export const DEFAULT_MIN_INDEPENDENT_REPRODUCTIONS = 2 as const;
export const MAX_MEMORY_EVIDENCE_OBSERVATIONS = 4_096 as const;
export const MAX_VERIFIED_MEMORY_LINEAGE = 1_024 as const;

export type MemoryScope = "CASE" | "PROJECT" | "SELF";
export type MemoryKind =
  | "hypothesis_seed"
  | "strategy"
  | "calibration"
  | "blind_spot"
  | "descriptor"
  | "scar";

export interface MemoryCandidate {
  protocol: typeof MEMORY_PROTOCOL;
  scope: MemoryScope;
  kind: MemoryKind;
  abstractSummary: string;
  content: JsonValue;
  sourceMemoryDigests: readonly string[];
  evidenceDigests: readonly string[];
  projectId?: string;
  caseDigest?: string;
  supersedes?: string;
}

export interface StoredMemory {
  digest: string;
  candidate: MemoryCandidate;
}

export interface CalibrationEvidence {
  sampleSize: number;
  expected: number;
  observed: number;
  evidenceDigest: string;
}

export interface EvidenceAttribution {
  sourceCaseDigest: string;
  /**
   * Identity of the particular execution that supplied this evidence. Exact
   * repeat submissions intentionally share a caseDigest, so authenticated
   * reproducibility evidence always carries this field. It remains optional
   * only for legacy/manual memory observations.
   */
  sourceRunDigest?: string;
  evidenceDigest: string;
}

export interface TribunalEvidence {
  reproductionDigests: readonly string[];
  counterexampleDigests: readonly string[];
  unresolvedContradictions: number;
  contaminationPassed: boolean;
  contaminationEvidenceDigest?: string;
  privacyReviewPassed: boolean;
  privacyEvidenceDigest?: string;
  calibration?: CalibrationEvidence;
  reproductionAttributions?: readonly EvidenceAttribution[];
  counterexampleAttributions?: readonly EvidenceAttribution[];
  contaminationAttribution?: EvidenceAttribution;
  privacyAttribution?: EvidenceAttribution;
  unresolvedContradictionDigests?: readonly string[];
  observationDigests?: readonly string[];
}

export interface MemoryDecision {
  protocol: typeof MEMORY_DECISION_PROTOCOL;
  decisionDigest: string;
  memoryDigest: string;
  /** PENDING is computed but never persisted as a terminal ledger decision. */
  decision: "PENDING" | "ADMIT" | "REJECT";
  reasons: readonly string[];
  decidedAt: string;
  tribunalEvidenceDigest?: string;
}

interface MemoryEvidenceObservationBase {
  protocol: typeof MEMORY_EVIDENCE_OBSERVATION_PROTOCOL;
  observationId: string;
  sourceCaseDigest: string;
  /** Distinguishes independent executions of identical Case content. */
  sourceRunDigest?: string;
  evidenceDigest: string;
  observedAt: string;
}

export type MemoryEvidenceObservation =
  | (MemoryEvidenceObservationBase & {
      kind: "REPRODUCTION" | "COUNTEREXAMPLE" | "UNRESOLVED_CONTRADICTION";
    })
  | (MemoryEvidenceObservationBase & {
      kind: "CONTAMINATION" | "PRIVACY_REVIEW";
      passed: boolean;
    });

export interface StoredMemoryEvidenceObservation {
  sequence: number;
  observationDigest: string;
  memoryDigest: string;
  observation: MemoryEvidenceObservation;
}

export interface DerivedTribunalEvidence {
  protocol: typeof TRIBUNAL_EVIDENCE_SNAPSHOT_PROTOCOL;
  memoryDigest: string;
  evidenceDigest: string;
  observationDigests: readonly string[];
  evidence: TribunalEvidence;
}

export interface EvidenceAdjudication {
  memory: StoredMemory;
  evidence: DerivedTribunalEvidence;
  decision: MemoryDecision;
}

export interface ReconciledMemoryEvidence extends EvidenceAdjudication {
  /** Exact observations requested by this reconciliation, in caller order. */
  observations: readonly StoredMemoryEvidenceObservation[];
  /** Zero on an exact recovery/idempotent replay. */
  insertedObservations: number;
}

export interface ProjectMemoryState {
  memory: StoredMemory;
  stagedAt: string;
  decision?: MemoryDecision;
}

/**
 * A closure over admitted memory that was reconstructed from the durable
 * candidate, observation, snapshot, and decision rows. Instances are issued
 * by TemporalDeep and carry an in-process authenticity brand in addition to
 * these public, canonical bindings.
 */
export interface VerifiedMemoryLineage {
  protocol: typeof MEMORY_LINEAGE_PROTOCOL;
  projectId: string;
  /** Exact roots supplied by the signed Record/candidate, in source order. */
  rootMemoryDigests: readonly string[];
  /** Complete fixed point, canonically sorted and duplicate-free. */
  memoryDigests: readonly string[];
  /** Commits every member's re-derived ADMIT decision and evidence snapshot. */
  admissionBindingDigest: string;
  /** Commits this complete public lineage descriptor. */
  lineageDigest: string;
}

export interface RetrievalRequest {
  projectId: string;
  caseDigest: string;
  stage: LifecycleStage;
  /** Both fields are required to expose an exact-task reproducibility memory. */
  intentContractDigest?: string;
  subjectMaterialCaptureDigest?: string;
  descriptor?: readonly number[];
  limit?: number;
  includeSelfArchive?: boolean;
}

export interface RetrievedMemory {
  memoryDigest: string;
  scope: MemoryScope;
  kind: MemoryKind;
  abstractSummary: string;
  content: JsonValue;
  weight: number;
  influence: MemoryInfluencePayload["influence"];
}

export interface RecordedInfluence {
  caseDigest: string;
  memoryDigest: string;
  stage: LifecycleStage;
  weight: number;
  influence: MemoryInfluencePayload["influence"];
  summary: string;
  observedAt: string;
}

export interface MemoryExport {
  records: readonly StoredMemory[];
  decisions: readonly MemoryDecision[];
  observations: readonly StoredMemoryEvidenceObservation[];
  evidenceSnapshots: readonly DerivedTribunalEvidence[];
  influences: readonly RecordedInfluence[];
  tombstones: readonly {
    targetDigest: string;
    evidenceDigest: string;
    tombstonedAt: string;
  }[];
}
