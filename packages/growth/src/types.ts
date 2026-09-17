import type {
  DsseEnvelope,
  JsonValue,
  MechanismIntakeRecord as ProtocolMechanismIntakeRecord,
} from "@jevyr/protocol";

export const GENOME_PROTOCOL = "jevyr.genome/1" as const;
export const GROWTH_PROPOSAL_PROTOCOL = "jevyr.growth-proposal/1" as const;
export const GENOME_PROMOTION_PAYLOAD_TYPE =
  "application/vnd.jevyr.genome-promotion+json";

export type SearchPhase =
  | "EXILE"
  | "DIVERSIFY"
  | "COEVOLVE"
  | "RECOMBINE"
  | "INVERT";

export interface BehaviorDescriptor {
  semantic: readonly number[];
  mechanism: readonly number[];
  causal: readonly number[];
  implementation: readonly number[];
}

export interface CandidateScores {
  discrimination: number;
  robustness: number;
  parsimony: number;
  feasibility: number;
  evidenceCoverage: number;
  resourceEfficiency: number;
}

export interface CandidateEvaluation {
  integrity: boolean;
  embodied: boolean;
  criticalTestsExecuted: boolean;
  unresolvedCritical: number;
  scores: CandidateScores;
  evidenceDigests: readonly string[];
  failureReasons: readonly string[];
  /** Metered evaluator/Forge work, defined by the sealed runtime capability card. */
  effortUnits: number;
}

export interface SearchCandidate<TPayload extends JsonValue = JsonValue> {
  id: string;
  ordinal: number;
  lineage: string;
  phase: SearchPhase;
  parentIds: readonly string[];
  publicSummary: string;
  payload: TPayload;
  descriptor: BehaviorDescriptor;
}

export interface CoevolvedChallenge<TPayload extends JsonValue = JsonValue> {
  id: string;
  generation: number;
  publicSummary: string;
  payload: TPayload;
  evidenceDigest?: string;
}

export interface SearchContext<TPayload extends JsonValue = JsonValue> {
  ordinal: number;
  attemptSafetyCeiling: string;
  effortRemaining: number;
  phase: SearchPhase;
  lineage: string;
  seed: number;
  parents: readonly SearchCandidate<TPayload>[];
  challenge?: CoevolvedChallenge;
  archiveSize: number;
}

export interface SearchOperator<TPayload extends JsonValue = JsonValue> {
  propose(context: SearchContext<TPayload>): Promise<{
    publicSummary: string;
    payload: TPayload;
    descriptor: BehaviorDescriptor;
  }>;
  evaluate(
    candidate: SearchCandidate<TPayload>,
    challenges: readonly CoevolvedChallenge[],
  ): Promise<CandidateEvaluation>;
  inventChallenge?(
    context: SearchContext<TPayload>,
    survivors: readonly EvaluatedCandidate<TPayload>[],
  ): Promise<{
    publicSummary: string;
    payload: JsonValue;
    evidenceDigest?: string;
  }>;
}

export interface EvaluatedCandidate<TPayload extends JsonValue = JsonValue> {
  candidate: SearchCandidate<TPayload>;
  evaluation: CandidateEvaluation;
  niche: string;
  novelty: number;
}

export interface GraveyardEntry<TPayload extends JsonValue = JsonValue>
  extends EvaluatedCandidate<TPayload> {
  reasons: readonly string[];
}

export interface SearchProfile {
  /** Safety ceiling, not a target or claim about intellectual depth. */
  attemptSafetyCeiling: string;
  /** Physical work available to this sealed Case. */
  effortCeiling: number;
  minimumAttempts: number;
  saturationWindow: number;
  minimumNiches: number;
  independentLineages: number;
  challengeInterval: number;
  binsPerDimension: number;
  elitesPerNiche: number;
  minimumNovelty: number;
  seed: number;
}

export interface SearchObservation {
  type:
    | "candidate.proposed"
    | "candidate.archived"
    | "candidate.scarred"
    | "challenge.invented"
    | "search.completed";
  ordinal: number;
  /** Completed proposal/evaluation attempts at the moment of observation. */
  attempted: number;
  /** Metered physical work, never an intelligence or quality score. */
  effortUsed: number;
  effortCeiling: number;
  archiveSize: number;
  occupiedNiches: number;
  /** Attempts since the archive or its coevolved challenge frontier last changed. */
  saturationAge: number;
  publicSummary: string;
  candidateId?: string;
  niche?: string;
  novelty?: number;
  termination?: FarFrontierResult["termination"];
}

export interface FarFrontierResult<TPayload extends JsonValue = JsonValue> {
  profile: SearchProfile;
  attempted: number;
  effortUsed: number;
  termination: "SATURATED" | "EFFORT_EXHAUSTED" | "ATTEMPT_CEILING";
  flagship?: EvaluatedCandidate<TPayload>;
  alternatives: readonly EvaluatedCandidate<TPayload>[];
  archive: readonly EvaluatedCandidate<TPayload>[];
  graveyard: readonly GraveyardEntry<TPayload>[];
  challenges: readonly CoevolvedChallenge[];
}

/**
 * A hard, pre-sealed physical envelope for untrusted hypothesis generation.
 * None of these counters is a quality score.
 */
export interface NurseryResourceEnvelope {
  maxMindInvocations: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallMillis: number;
  maxGeneratedBytes: number;
  maxSingleInvocationMillis: number;
}

export type NurseryTokenMeasurement = "MEASURED" | "UPPER_BOUND";

export interface NurseryResourceUsage {
  mindInvocations: number;
  inputTokens: number;
  outputTokens: number;
  inputTokenMeasurement: NurseryTokenMeasurement;
  outputTokenMeasurement: NurseryTokenMeasurement;
  wallMillis: number;
  generatedBytes: number;
}

export interface NurseryProfile {
  /** Remote loop guard only; never a target or a proxy for depth. */
  attemptSafetyCeiling: string;
  minimumAttempts: number;
  saturationWindow: number;
  independentLineages: number;
  challengeInterval: number;
  resources: NurseryResourceEnvelope;
  seed: number;
}

export interface HypothesisSpecimen<TPayload extends JsonValue = JsonValue> {
  id: string;
  contentDigest: string;
  ordinal: number;
  lineage: string;
  phase: SearchPhase;
  parentIds: readonly string[];
  publicSummary: string;
  payload: TPayload;
  /** Untrusted, proposer-declared vocabulary. It is not a measured niche. */
  declaredMechanisms: readonly string[];
}

export interface NurseryContext<TPayload extends JsonValue = JsonValue> {
  ordinal: number;
  phase: SearchPhase;
  lineage: string;
  seed: number;
  parents: readonly HypothesisSpecimen<TPayload>[];
  attemptSafetyCeiling: string;
  resourcesRemaining: NurseryResourceEnvelope;
  signal: AbortSignal;
}

export interface NurseryProposal<TPayload extends JsonValue = JsonValue> {
  publicSummary: string;
  payload: TPayload;
  declaredMechanisms?: readonly string[];
}

/** A count plus the epistemic status of that count. Estimates are never MEASURED. */
export interface NurseryTokenReading {
  tokens: number;
  measurement: NurseryTokenMeasurement;
}

/**
 * The complete charge for one operator invocation. A provider-backed operator
 * may report measured token counts; otherwise the counts are conservative
 * UTF-8 byte upper bounds over the exact input and complete raw output.
 */
export interface NurseryInvocationUsage {
  input: NurseryTokenReading;
  output: NurseryTokenReading;
}

export interface NurseryProposalBatch<TPayload extends JsonValue = JsonValue> {
  proposals: readonly NurseryProposal<TPayload>[];
  tokenUsage: NurseryInvocationUsage;
  /**
   * A metered operator failure. Failed batches must contain no proposals and
   * must conservatively upper-bound input while charging the complete reserved
   * output permission.
   */
  failure?: string;
}

export interface NurseryOperator<TPayload extends JsonValue = JsonValue> {
  /** Explicit method scheduling, still subject to the same resource and admission kernel. */
  phaseForAttempt?(ordinal: number, defaultPhase: SearchPhase): SearchPhase;
  /**
   * Conservative input-token reservation calculated before propose is called.
   * When absent, the nursery uses a deterministic UTF-8 encoding of the public
   * invocation context. The hook must not invoke the underlying Mind.
   */
  inputTokenUpperBound?(context: NurseryContext<TPayload>): number;
  /**
   * Maximum output-token permission reserved for this invocation. An opaque
   * operator failure is charged this full amount as an upper bound. When the
   * hook is absent, the nursery conservatively reserves every output token
   * remaining in its envelope.
   */
  outputTokenUpperBound?(context: NurseryContext<TPayload>): number;
  propose(
    context: NurseryContext<TPayload>,
  ): Promise<readonly NurseryProposal<TPayload>[] | NurseryProposalBatch<TPayload>>;
}

export interface NurseryScar {
  ordinal: number;
  code: "DUPLICATE" | "INVALID" | "OPERATOR_FAILURE" | "RESOURCE_OVERRUN";
  summary: string;
  contentDigest?: string;
}

export interface NurseryObservation {
  type: "attempt.started" | "hypothesis.admitted" | "hypothesis.scarred" | "nursery.completed";
  ordinal: number;
  attempted: number;
  nurserySize: number;
  exactYieldAge: number;
  resources: NurseryResourceUsage;
  publicSummary: string;
  specimenId?: string;
  contentDigest?: string;
  termination?: NurseryResult["termination"];
}

export interface NurseryResult<TPayload extends JsonValue = JsonValue> {
  profile: NurseryProfile;
  attempted: number;
  specimens: readonly HypothesisSpecimen<TPayload>[];
  scars: readonly NurseryScar[];
  declaredMechanisms: readonly string[];
  exactYieldAge: number;
  resources: NurseryResourceUsage;
  termination: "HYPOTHESIS_SATURATED" | "RESOURCE_EXHAUSTED" | "ATTEMPT_CEILING";
}

export interface GenomeModule {
  id: string;
  version: string;
  artifactDigest: string;
  permissions: readonly string[];
  publicPurpose: string;
}

export interface GenomeBody {
  protocol: typeof GENOME_PROTOCOL;
  generation: number;
  boneDigest: string;
  parentDigests: readonly string[];
  modules: readonly GenomeModule[];
  parameters: Readonly<Record<string, JsonValue>>;
}

export interface StoredGenome {
  digest: string;
  body: GenomeBody;
}

export interface BenchmarkObservation {
  suite: string;
  heldOut: boolean;
  invariant: boolean;
  passed: boolean;
  score: number;
  parentScore: number;
  evidenceDigest: string;
}

export interface DamageTrial {
  id: string;
  kind: "CORRUPTION" | "RESOURCE_LOSS" | "ADVERSARIAL_INPUT" | "TOOL_LOSS";
  passed: boolean;
  recoveredToBone: boolean;
  evidenceDigest: string;
}

export interface GenomeAdmissionPolicy {
  requiredSuites: readonly string[];
  maximumHeldOutRegression: number;
  minimumMaterialGain: number;
  minimumDamageTrials: number;
  minimumNovelty: number;
}

export interface GrowthProposal {
  protocol: typeof GROWTH_PROPOSAL_PROTOCOL;
  proposalDigest: string;
  parentDigest: string;
  descendant: StoredGenome;
  benchmarkEvidence: readonly BenchmarkObservation[];
  damageEvidence: readonly DamageTrial[];
  novelty: number;
  decision: "STAGED" | "REJECTED";
  reasons: readonly string[];
}

export interface GenomePromotionPayload {
  protocol: "jevyr.genome-promotion/1";
  proposalDigest: string;
  descendantDigest: string;
  scope: "GOVERNANCE_ONLY";
}

export interface PromotedGenome {
  genome: StoredGenome;
  proposalDigest: string;
  attestation: DsseEnvelope;
  promoted: true;
}

export type MechanismIntakeRecord = ProtocolMechanismIntakeRecord;
