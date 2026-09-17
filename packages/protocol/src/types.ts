import type { JsonValue } from "./canonical.js";

export const CASE_PROTOCOL = "jevyr.case/1" as const;
export const EVENT_PROTOCOL = "jevyr.event/1" as const;
export const RECORD_PROTOCOL = "jevyr.record/1" as const;
export const TERMINAL_PROTOCOL = "jevyr.terminal/1" as const;
export const LIVE_PROTOCOL = "jevyr.live/1" as const;
export const SEARCH_ENVELOPE_PROTOCOL = "jevyr.search-envelope/1" as const;
export const TRUST_BUNDLE_PROTOCOL = "jevyr.trust-bundle/1" as const;
export const INTENT_CONTRACT_PROTOCOL = "jevyr.intent-contract/1" as const;
export const INTENT_COMPILER_VERSION = "jevyr.intent-compiler/1" as const;

export type CaseMode = "auto" | "audit" | "design";
export type PrivacyMode = "full_case" | "provider_scoped" | "local_only";
export type SessionControl = "sovereign" | "juggler";

export interface SubjectReference {
  id: string;
  kind: "git" | "directory" | "file" | "url" | "text" | "artifact";
  locator: string;
  revision?: string;
  mediaType?: string;
}

export interface CaseIntent {
  impulse: string;
  mode?: CaseMode;
  subjects?: readonly SubjectReference[];
  constraints?: readonly string[];
  requestedAssays?: readonly string[];
  privacy?: PrivacyMode;
  control?: SessionControl;
  seed?: string;
}

export interface CaseSubmission {
  protocol: typeof CASE_PROTOCOL;
  case: CaseIntent;
}

export interface SubjectSnapshot {
  subjectId: string;
  digest: string;
  resolvedLocator: string;
  revision?: string;
  capturedAt: string;
  byteLength?: number;
  mediaType?: string;
}

export interface NormalizedCaseIntent {
  impulse: string;
  mode: CaseMode;
  subjects: readonly SubjectReference[];
  constraints: readonly string[];
  requestedAssays: readonly string[];
  privacy: PrivacyMode;
  control: SessionControl;
  seed: string;
}

export type IntentStatementOrigin = "impulse" | "declared_constraint" | "requested_assay";
export type IntentAssayability = "ASSAYABLE" | "UNASSAYABLE";

export interface IntentGoal {
  statement: string;
  source: "whole_impulse" | "impulse_prefix";
}

export interface IntentConstraint {
  id: string;
  statement: string;
  origin: "impulse" | "declared_constraint";
}

export interface IntentOracle {
  kind:
    | "command_exit_code"
    | "exact_output"
    | "network_access_count"
    | "output_parse"
    | "path_exists"
    | "sealed_subject_digest"
    | "sealed_test_suite"
    | "requested_assay";
  operand: string;
  operator: "equals" | "exists" | "passes" | "parses_as" | "unchanged";
  expected: string;
}

export interface IntentObligation {
  id: string;
  statement: string;
  origin: IntentStatementOrigin;
  critical: true;
  assayability: IntentAssayability;
  oracle?: IntentOracle;
  unassayableReason?: string;
}

export interface IntentOutcomeCondition {
  id: string;
  kind: "success" | "failure";
  statement: string;
  source: "kernel" | "impulse";
  obligationIds: readonly string[];
}

export interface IntentAmbiguity {
  id: string;
  code: "DEICTIC_REFERENCE" | "DISJUNCTION_SCOPE" | "MODAL_FORCE" | "OPEN_SCOPE" | "SUBJECTIVE_PREDICATE";
  sourceText: string;
  summary: string;
}

export interface AlternativeInterpretation {
  id: string;
  ambiguityId: string;
  statement: string;
  resolution: "UNRESOLVED";
}

/** `digest` covers every field except itself using canonical JSON. */
export interface IntentContract {
  protocol: typeof INTENT_CONTRACT_PROTOCOL;
  compilerVersion: typeof INTENT_COMPILER_VERSION;
  originalImpulse: string;
  originalImpulseDigest: string;
  goal: IntentGoal;
  subjectIds: readonly string[];
  explicitConstraints: readonly IntentConstraint[];
  requestedAssays: readonly string[];
  successConditions: readonly IntentOutcomeCondition[];
  failureConditions: readonly IntentOutcomeCondition[];
  ambiguities: readonly IntentAmbiguity[];
  alternativeInterpretations: readonly AlternativeInterpretation[];
  criticalObligations: readonly IntentObligation[];
  digest: string;
}

/**
 * Search physics fixed before Cast. The seed value itself is derived only after
 * the run identity exists; this field binds the deterministic derivation rule
 * without creating a runDigest/searchDigest cycle.
 */
export interface SearchNurseryProfile {
  minimumAttempts: number;
  saturationWindow: number;
  independentLineages: number;
  challengeInterval: number;
}

/** Hard resource permissions. Every field is mandatory; zero means denied. */
export interface SearchResourceEnvelope {
  maxMindInvocations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallMillis: number;
  maxSingleInvocationMillis: number;
  maxGeneratedBytes: number;
  maxForgeCpuMillis: number;
  maxForgeWallMillis: number;
  maxMemorySeconds: number;
  maxWritableBytes: number;
  maxWritableInodes: number;
  maxArtifactBytes: number;
  maxNetworkBytes: number;
  concurrentLineages: number;
  maxTotalAssayCost: number;
}

export interface SealedSearchProfile {
  /** Last-resort loop guard, never a target or an intelligence score. */
  attemptSafetyCeiling: string;
  nursery: SearchNurseryProfile;
  resources: SearchResourceEnvelope;
  seedDerivation: "sha256-run-digest-frontier-v1" | "sha256-case-seed-frontier-v2";
}

/** `digest` covers exactly `{ protocol, profile }`, never itself. */
export interface SearchEnvelope {
  protocol: typeof SEARCH_ENVELOPE_PROTOCOL;
  profile: SealedSearchProfile;
  digest: string;
}

export interface SealedCase {
  protocol: typeof CASE_PROTOCOL;
  caseId: string;
  submissionDigest: string;
  /** Digest of the immutable private-CAS binding set captured before Seal. */
  subjectMaterialCaptureDigest: string;
  caseDigest: string;
  runDigest: string;
  sealedAt: string;
  policyVersion: string;
  policyDigest: string;
  genomeVersion: string;
  genomeDigest: string;
  searchEnvelope: SearchEnvelope;
  intentContractDigest: string;
  intentContract: IntentContract;
  intent: NormalizedCaseIntent;
  subjects: readonly SubjectSnapshot[];
}

export interface SealReceipt {
  protocol: "jevyr.seal/1";
  caseId: string;
  submissionDigest: string;
  /** Signed commitment to materialized and declaration-only subject bindings. */
  subjectMaterialCaptureDigest: string;
  caseDigest: string;
  runDigest: string;
  sealedAt: string;
  policyVersion: string;
  policyDigest: string;
  genomeVersion: string;
  genomeDigest: string;
  searchDigest: string;
  intentContractDigest: string;
}

export const LIFECYCLE_STAGES = [
  "cast",
  "snapshot",
  "seal",
  "self_scan",
  "interpret",
  "diverge",
  "recombine",
  "embody",
  "challenge",
  "assay",
  "reflex",
  "crystallize",
  "sign",
  "memory_tribunal",
  "terminate",
] as const;

export type LifecycleStage = typeof LIFECYCLE_STAGES[number];

export type PublicActorKind = "kernel" | "mind" | "tool" | "peer" | "forge" | "archivist";

export interface PublicActor {
  id: string;
  kind: PublicActorKind;
  instance?: string;
}

export interface StageStatusPayload {
  stage: LifecycleStage;
  status: "entered" | "working" | "completed" | "failed" | "skipped";
  summary: string;
  progress?: number;
}

export interface ClaimPayload {
  claimId: string;
  statement: string;
  claimType: "interpretation" | "mechanism" | "risk" | "requirement" | "prediction";
  confidence?: number;
  candidateId?: string;
}

export interface ActionPayload {
  actionId: string;
  actionType: string;
  status: "requested" | "started" | "completed" | "failed" | "denied";
  summary: string;
  toolId?: string;
  artifactDigests?: readonly string[];
  resource?: { cpuMillis?: number; wallMillis?: number; bytesRead?: number; bytesWritten?: number };
}

export interface EvidencePayload {
  evidenceId: string;
  evidenceType: "subject_snapshot" | "tool_observation" | "sandbox_execution" | "original_subject_assertions" | "artifact" | "model_report" | "peer_report" | "memory_hint";
  summary: string;
  contentDigest: string;
  /** Candidate/assay scope is factual provenance; it does not grant evidentiary authority. */
  candidateId?: string;
  assayId?: string;
  supports?: readonly string[];
  refutes?: readonly string[];
  /** Runtime-observed, digest-bound facts for Reflex; never a model-authored assessment. */
  audit?: InvestigationAuditReceipt;
  /** A bounded mathematical certificate, checked by Bone independently of prose. */
  formalProof?: FormalCounterexampleCertificate;
  /** Original captured source, independently replayed; never a candidate assay. */
  originalSubject?: OriginalSubjectAssertionBinding;
}

export interface OriginalSubjectAssertionBinding {
  protocol: "jevyr.original-subject-assertion-binding/1";
  subjectId: string;
  obligationId: string;
  captureDigest: string;
  certificateDigest: string;
  executionReceiptDigest: string;
  kernelDigest: string;
}

export interface FormalCounterexampleCertificate {
  protocol: "jevyr.formal-counterexample/1";
  rule: "finite-sequence-length-lower-bound";
  intentContractDigest: string;
  obligationId: string;
  statementDigest: string;
  source: { start: number; end: number; text: string };
  proposition: {
    domain: "all_finite_byte_strings" | "all_finite_bit_strings";
    minimumInputLength: 0;
    minimumOutputLength: 0;
    requiredSaving: number;
  };
  witness: { inputLength: 0; inputHex: ""; maximumOutputLength: number };
}

export type InvestigationAuditReceipt =
  | { kind: "lineage_commitment"; invocationId: string; providerId: string; modelId: string; lineageId: string; seedCommitment: string; seedEnforcement: "honored" | "unverified"; promptDigest: string; candidateIds: readonly string[]; visibleCandidateIds: readonly string[]; memoryDigests: readonly string[]; assumptionDigest: string }
  | { kind: "paired_probe"; pairId: string; axis: "preference_wording" | "initial_condition"; arm: "baseline" | "variant"; obligationDigest: string; evidenceDigest: string; outcomeDigest: string }
  | { kind: "evaluator_boundary"; builderId: string; evaluatorId: string; sealedOracleDigest: string; appliedOracleDigest: string; untrustedOracleInput: boolean }
  | { kind: "assumption_check"; sealedAssumptionsDigest: string; appliedAssumptionsDigest: string }
  | { kind: "memory_validation"; memoryDigest: string; contaminated: boolean; derivedFromDigests: readonly string[] }
  | { kind: "terminal_claim"; claimId: string; evidenceIds: readonly string[] };

export interface CandidatePayload {
  candidateId: string;
  status: "proposed" | "embodied" | "invalidated" | "survived" | "selected";
  summary: string;
  feasibility?: "BUILDABLE_NOW" | "BRIDGEABLE" | "LAWFUL_BUT_OPEN" | "CONTRADICTED";
  /** Explicit public genealogy. Omission means undisclosed, while [] declares a root. */
  parentIds?: readonly string[];
  artifactDigests?: readonly string[];
}

export interface AssayPayload {
  assayId: string;
  candidateId?: string;
  obligationId?: string;
  status: "planned" | "running" | "passed" | "failed" | "inconclusive" | "blocked";
  critical: boolean;
  summary: string;
  evidenceIds?: readonly string[];
  /** A finite population failure never asserts impossibility outside that population. */
  scope?: "closed_population";
  populationIds?: readonly string[];
}

export interface ReflexPayload {
  loop: 1 | 2;
  reviewedEvidenceDigest: string;
  intentContractDigest: string;
  challengedNodeIds: readonly string[];
  materialFindings: readonly { code: string; summary: string; evidenceIds: readonly string[] }[];
  decision: "confirm" | "revise" | "repeat_once";
  /** Coverage explicitly separates absent measurements from successful audits. */
  audits?: readonly { audit: string; status: "passed" | "failed" | "unmeasured"; summary: string; evidenceIds: readonly string[] }[];
}

export interface MemoryInfluencePayload {
  memoryDigest: string;
  influence: "seeded_hypothesis" | "strategy_selected" | "calibration_applied";
  summary: string;
  weight: number;
}

export interface KernelPayload {
  operation: "sealed" | "policy_compiled" | "record_crystallized" | "signed" | "terminated";
  summary: string;
  artifactDigest?: string;
}

export type SearchResourceName =
  | "mindInvocations"
  | "inputTokens"
  | "outputTokens"
  | "wallMillis"
  | "singleInvocationMillis"
  | "generatedBytes"
  | "forgeCpuMillis"
  | "forgeWallMillis"
  | "memorySeconds"
  | "writableBytes"
  | "writableInodes"
  | "artifactBytes"
  | "networkBytes"
  | "concurrentLineages"
  | "totalAssayCost";

export interface SearchResourceTelemetry {
  name: SearchResourceName;
  /** Null means Jevyr has a bound but no trustworthy meter for this resource yet. */
  used: number | null;
  ceiling: number;
  measurement: "MEASURED" | "UPPER_BOUND" | "DECLARED_ONLY";
}

export interface HypothesisNurseryTelemetry {
  /** Exact canonical-content distinctions only; this is not semantic novelty. */
  exactDistinctHypotheses: number;
  scars: number;
  declaredMechanismLabels: readonly string[];
  exactYieldAge: number;
}

export interface AssayArchiveTelemetry {
  /** Entries admitted from executed observations under a sealed oracle. */
  measuredEntries: number;
  occupiedNiches: number;
  lastMeasuredNovelty?: number;
}

export interface SearchStatusPayload {
  layer: "HYPOTHESIS_NURSERY" | "ASSAY_ARCHIVE";
  status: "started" | "exploring" | "hypothesis_admitted" | "archive_changed" | "completed" | "failed";
  /** Telemetry only. Attempt count is never treated as a quality or depth score. */
  attempted: number;
  /** Decimal string so the safety ceiling is not constrained by JavaScript integer precision. */
  attemptSafetyCeiling: string;
  resources: readonly SearchResourceTelemetry[];
  /** Optional local scope for per-candidate assay resource accounting. */
  candidateId?: string;
  assayId?: string;
  hypothesisNursery?: HypothesisNurseryTelemetry;
  assayArchive?: AssayArchiveTelemetry;
  termination?: "HYPOTHESIS_SATURATED" | "RESOURCE_EXHAUSTED" | "ATTEMPT_CEILING";
  summary: string;
}

export type EventPayloadByKind = {
  "stage.status": StageStatusPayload;
  "claim.published": ClaimPayload;
  "action.status": ActionPayload;
  "evidence.observed": EvidencePayload;
  "candidate.status": CandidatePayload;
  "assay.status": AssayPayload;
  "reflex.completed": ReflexPayload;
  "memory.influence": MemoryInfluencePayload;
  "search.status": SearchStatusPayload;
  "kernel.status": KernelPayload;
};

export type EventKind = keyof EventPayloadByKind;

export type CaseEvent<K extends EventKind = EventKind> = {
  [P in K]: {
    protocol: typeof EVENT_PROTOCOL;
    caseDigest: string;
    runDigest: string;
    sequence: number;
    priorDigest: string | null;
    eventDigest: string;
    observedAt: string;
    stage: LifecycleStage;
    kind: P;
    actor: PublicActor;
    payload: EventPayloadByKind[P];
  }
}[K];

/** Resumable polling/SSE envelope. `afterSequence` maps directly to SSE Last-Event-ID. */
export interface LiveEventBatch {
  protocol: typeof LIVE_PROTOCOL;
  caseDigest: string;
  runDigest: string;
  afterSequence: number;
  throughSequence: number;
  headDigest: string | null;
  caughtUp: boolean;
  events: readonly CaseEvent[];
  polledAt: string;
}

export interface LiveCaseStatus {
  protocol: "jevyr.status/1";
  caseDigest: string;
  runDigest: string;
  lifecycle: "queued" | "running" | "crystallized" | "terminated" | "invalid";
  stage: LifecycleStage;
  stageStatus: StageStatusPayload["status"];
  lastSequence: number;
  headDigest: string | null;
  updatedAt: string;
}

/**
 * Write-once, signed proof of the complete public ledger, final status, exact
 * Record, and complete artifact inventory selected when a Case closed. Unlike
 * SignedRecord.eventHeadDigest, this head is the terminal tail rather than the
 * earlier crystallization prefix.
 */
export interface TerminalReceipt {
  protocol: typeof TERMINAL_PROTOCOL;
  caseId: string;
  caseDigest: string;
  runDigest: string;
  lifecycle: "terminated" | "invalid";
  stage: LifecycleStage;
  stageStatus: StageStatusPayload["status"];
  lastSequence: number;
  eventHeadDigest: string | null;
  recordDigest: string;
  artifactIndexDigest: string;
  closedAt: string;
}

export interface UnsignedEvent<K extends EventKind = EventKind> {
  protocol: typeof EVENT_PROTOCOL;
  caseDigest: string;
  runDigest: string;
  sequence: number;
  priorDigest: string | null;
  observedAt: string;
  stage: LifecycleStage;
  kind: K;
  actor: PublicActor;
  payload: EventPayloadByKind[K];
}

export type IntegrityOutcome = "VALID" | "INVALID";
export type CreationOutcome = "CONCEIVED" | "NO_SURVIVOR" | "FAILED";
export type EmbodimentOutcome = "BUILT" | "NOT_BUILT" | "FAILED";
export type JudgmentOutcome = "ACCEPT" | "REJECT" | "UNPROVEN" | "NOT_APPLICABLE";
export type Feasibility = "BUILDABLE_NOW" | "BRIDGEABLE" | "LAWFUL_BUT_OPEN" | "CONTRADICTED";

export interface VerdictBasis {
  code: string;
  summary: string;
  evidenceIds: readonly string[];
  obligationIds?: readonly string[];
  candidateIds?: readonly string[];
}

export interface JevyrVerdict {
  policyVersion: string;
  intentContractDigest: string;
  evidenceDigest: string;
  integrity: IntegrityOutcome;
  creation: CreationOutcome;
  embodiment: EmbodimentOutcome;
  judgment: JudgmentOutcome;
  selectedCandidateId?: string;
  feasibilityByCandidate: Readonly<Record<string, Feasibility>>;
  basis: readonly VerdictBasis[];
}

export interface DsseSignature {
  keyid: string;
  sig: string;
}

export interface DsseEnvelope {
  payloadType: string;
  payload: string;
  signatures: readonly DsseSignature[];
}

/** Public verification material. Private signing material is never part of this contract. */
export interface PublicTrustKey {
  keyId: string;
  algorithm: "Ed25519";
  publicKeyPem: string;
  payloadTypes: readonly [
    "application/vnd.jevyr.seal+json",
    "application/vnd.jevyr.record+json",
    "application/vnd.jevyr.terminal+json",
  ];
}

/** Versioned trust document served by the loopback daemon. */
export interface PublicTrustBundle {
  protocol: typeof TRUST_BUNDLE_PROTOCOL;
  keys: readonly PublicTrustKey[];
}

export interface SignedRecord {
  protocol: typeof RECORD_PROTOCOL;
  /** Transitively commits to subjectMaterialCaptureDigest through the sealed caseDigest. */
  caseDigest: string;
  runDigest: string;
  policyDigest: string;
  genomeDigest: string;
  searchDigest: string;
  intentContractDigest: string;
  /** Head of the verified public-ledger prefix used at crystallization. Later sign/tribunal/terminate events extend this chain. */
  eventHeadDigest: string;
  verdict: JevyrVerdict;
  reflex: ReflexPayload;
  memoryInfluences: readonly MemoryInfluencePayload[];
  crystallizedAt: string;
}

export interface ProtocolProblem {
  path: string;
  code: string;
  message: string;
}

export interface MechanismIntakeRecord {
  protocol: "jevyr.mechanism-intake/1";
  id: string;
  source: { uri: string; version?: string; digest?: string };
  domainAssumptions: readonly string[];
  proposedTransfer: string;
  reproduction: { status: "not_run" | "passed" | "failed" | "inconclusive"; evidenceDigests: readonly string[] };
  benchmark: { corpusDigest?: string; resultDigests: readonly string[] };
  status: "ADOPTED" | "EXPERIMENTAL" | "REJECTED";
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  problems: readonly ProtocolProblem[];
}

export type JsonObject = { readonly [key: string]: JsonValue };
