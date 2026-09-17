import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { LiveJugglerBook, metabolicAllowanceFromPolicyDescriptor, type VerifiedMetabolicCalibration, type JugglerVoucherOffer, type JugglerReceipt } from "./juggler.js";
import {
  canonicalize,
  digestJson,
  isSha256Digest,
  validateSignedRecord,
  type CaseEvent,
  type EventKind,
  type EventPayloadByKind,
  type JsonValue,
  type PublicActor,
  type SearchResourceEnvelope,
  type SearchResourceName,
  type SearchResourceTelemetry,
  type SignedRecord,
  type MetabolicOffers,
  type MetabolicRedemption,
  type MetabolicReceipt,
} from "@jevyr/protocol";
import {
  compileVerdict,
  constructFormalCounterexamples,
  formalProofReplayOptions,
  originalSubjectKernelDigestFromPolicyDescriptor,
  crystallizeRecord,
  decodeDsseJson,
  evaluateReflex,
  EvidenceGraph,
  projectEvents,
  RECORD_DSSE_PAYLOAD_TYPE,
  verifyEventChain,
  verifyDsse,
  type PolicyInput,
  type VerifiedEvidenceEdge,
  type OriginalSubjectContext,
} from "@jevyr/core";
import {
  QualityDiversityArchive,
  selectArchiveFlagship,
  type BehaviorDescriptor,
  type CandidateEvaluation,
  type SearchCandidate,
} from "@jevyr/growth";
import {
  decodeMemoryCandidate,
  encodeMemoryCandidate,
  MEMORY_CANDIDATE_MEDIA_TYPE,
  memoryReproducibilityFingerprint,
  type MemoryCandidate,
  type ProjectMemoryState,
  type TemporalDeep,
} from "@jevyr/memory";
import { clamp, sha256, stableId } from "./canonical.js";
import { adapterCapabilitySnapshot, snapshotAdapterCapability } from "./capability-card.js";
import { makePublicMindPrompt } from "./adapters/prompt.js";
import { germinatePhenotype, investigationSeed, phenotypeOrder, type InvestigationPhenotype } from "./phenotype.js";
import { assayFamily, EvidenceValueScheduler } from "./evidence-scheduler.js";
import { routeCriticalChallenges } from "./challenge-routing.js";
import { lateMemoryInfluences, REPRODUCTION_MEMORY_MEDIA_TYPE, reproductionMemoryMatches, verifyReproductionMemoryGuard, type ReproductionMemoryGuard } from "./memory-reproduction.js";
import { buildExecutionRevisionRequest, invokeExecutionRevision, executionFeedback, executionFeedbackFacts, feedbackScentHistory, revisionInvestigationEnabled, revisionInvestigationVersion, REVISION_FEEDBACK_MEDIA_TYPE, REVISION_POPULATION_MEDIA_TYPE, type FeedbackInput, type RevisionInvocationContext } from "./revision-investigation.js";
import { maximumInertiaQuantity, planInertiaContinuation } from "./inertia-scent.js";
import { selectBaselineRevision } from "./baseline-revision.js";
import { createMetabolicCheckpoint, metabolicCheckpointMatches, metabolicCheckpointsEnabled, metabolicReproductionDoses, METABOLIC_CHECKPOINT_MEDIA_TYPE, METABOLIC_REPRODUCTION_MEDIA_TYPE, verifyMetabolicReproductionPlan, type MetabolicReproductionPlan } from "./metabolic-reproduction.js";
import { runAdaptiveSearch, type AdaptiveSearchOutcome } from "./adaptive-search.js";
import {
  ASSAY_ARCHIVE_V1,
  verifyAssayFrontier,
  type AssayFrontier,
  type ForgePlan,
  type SealedAssayPlan,
} from "./assay-frontier.js";
import {
  verifyRuntimeGrowthPolicy,
  type RuntimeGrowthPolicy,
} from "./growth-policy.js";
import {
  CandidateBlueprintError,
  candidateTreeDigest,
  compileCandidateBlueprint,
  materializeCandidateBlueprint,
  type CandidateMaterialization,
  type CompiledCandidateBlueprint,
} from "./candidate-blueprints.js";
import { SealedForgeAdapter } from "./forge.js";
import { forgeIntegrityFailure } from "./forge-integrity.js";
import {
  sealedDockerForgeAuthority,
  verifyForgeExecutionAuthority,
} from "./forge-authority.js";
import { invokeMindMetered, mindFailureInputUpperBound, mindFailureInvestigation, utf8Bytes, type ModelInvestigationFailure } from "./mind-metering.js";
import {
  MEMORY_RECONCILIATION_EVIDENCE_MEDIA_TYPE,
  bindVerifiedCommittedMemoryCase,
  compareCommittedMemoryCases,
  encodeMemoryReconciliationEvidence,
  projectMemoryCandidate,
  reconciliationObservations,
  type VerifiedCommittedMemoryCase,
} from "./memory-reconciliation.js";
import {
  mindInvocationOutputReservation,
  mindResourceEnvelopeForInvocations,
  SealedMindBudget,
} from "./search-budget.js";
import {
  JEVYR_STAGES,
  type JevyrStage,
  type MindAdapter,
  type MindRequest,
  type PublicContribution,
  type SealedCaseContext,
  type ToolAdapter,
  type ToolInvocation,
  type ToolObservation,
} from "./contracts.js";
import type { SubjectMaterializationResult, SubjectTextProjection } from "./subject-materials.js";
import type { SubjectContext } from "./subject-context.js";
import { observeRepositoryEvaluation, repositoryEvaluationObserverPolicyFromDescriptor, repositoryObserverMinimumArtifactBudget, repositoryObserverSubjectSelection } from "./repository-evaluation-observer.js";
import { deriveRepositoryPureAssertionContext } from "./repository-pure-assertions.js";
import { prepareRepositoryPureProducerPackage, type RepositoryPureProducerAssets } from "./repository-pure-producer.js";
import { executeRepositoryPureAssertions, replayRepositoryPureExecution } from "./repository-pure-execution.js";
import { createOriginalSubjectCertificate, originalSubjectExecutionLimits, originalSubjectProducerAssets, replayOriginalSubjectCertificates, ORIGINAL_SUBJECT_CERTIFICATE_ACTION, ORIGINAL_SUBJECT_CERTIFICATE_MEDIA } from "./original-subject-certificate.js";
import type { AppendOnlyEventHub } from "./events.js";
import {
  decodeToolObservation,
  encodeToolObservation,
  MAX_CASE_EVIDENCE_BYTES,
  TOOL_OBSERVATION_MEDIA_TYPE,
  toolObservationOutputBytes,
} from "./evidence-artifacts.js";
import { verifyPersistedAssayEvidence } from "./evidence-replay.js";
import { encodePublicIdea, PUBLIC_IDEA_MEDIA_TYPE } from "./public-ideas.js";
import {
  blockedComparativeExperiment,
  candidateExperimentReadiness,
  compileExperimentCapability,
  evaluateComparativeExperiment,
  experimentForPlan,
  type ExperimentCapability,
  type SealedCandidateExperiment,
} from "./experiment-capability.js";
import type { JevyrIgnorePolicy } from "./ignore-policy.js";
import {
  claimRecordCommitAuthority,
  type RecordCommitAuthority,
} from "./record-authority.js";
import type { CaseRepository, CaseStatus, CastSubmission } from "./repository.js";
import {
  evaluateForgeOracle,
  parseStrictOracleCommand,
  type ForgeOracleEvaluation,
  type RequestedAssayPlan,
  type SealedForgeOraclePlan,
  type SealedTestSuitePlan,
} from "./typed-oracles.js";

/** An operator-owned, exact tool call sealed before Cast. Its output is data, never proof. */
export interface QuarantinedWitnessCall {
  readonly id: string;
  readonly adapterId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface QuarantinedWitnessSet {
  readonly adapters: readonly ToolAdapter[];
  readonly calls: readonly QuarantinedWitnessCall[];
  /** Digest of the public, secret-free descriptor embedded in repository policy. */
  readonly descriptorDigest: string;
}

export interface OrchestratorConfig {
  /** Trusted fixed evaluator assets bound before Cast, never supplied by a Case. */
  readonly originalSubjectAssets?: RepositoryPureProducerAssets;
  readonly metabolicCalibrations?: readonly VerifiedMetabolicCalibration[];
  readonly repository: CaseRepository;
  readonly events: AppendOnlyEventHub;
  readonly minds: readonly MindAdapter[];
  readonly forge: ToolAdapter;
  /** Fixed MCP/A2A-style witnesses. Discovery cannot add calls after Cast. */
  readonly witnesses?: QuarantinedWitnessSet;
  /** Durable, admitted memory. It is unavailable to the first divergent wave by construction. */
  readonly memory?: TemporalDeep;
  readonly memoryProjectId?: string;
  readonly includeSelfMemory?: boolean;
  /** Comparison only; normal admitted retrieval still supplies every hint. */
  readonly reproductionMemoryGuard?: ReproductionMemoryGuard;
  readonly metabolicReproductionPlan?: MetabolicReproductionPlan;
  /** Output-path policy fixed before Cast; model blueprints have no authority without it. */
  readonly candidateIgnorePolicy?: JevyrIgnorePolicy;
  /** Complete policy-owned finite assay set, compiled and sealed before Cast. */
  readonly assayFrontier?: AssayFrontier;
  /** Canonical growth controls already bound into the repository policy. */
  readonly runtimeGrowthPolicy?: RuntimeGrowthPolicy;
  readonly reflexLoops?: number;
}

interface RunState {
  reflexMindRoundsUsed: number;
  revisionWaves: number;
  metabolicCheckpointOrdinal: number;
  preparedMetabolicCheckpoint?: number;
  readonly reproducedMetabolicSequences: Set<number>;
  populationHeadDigest?: string;
  revisionLastCandidateId?: string;
  readonly contributions: PublicContribution[];
  phenotype?: InvestigationPhenotype;
  readonly evidence: ToolObservation[];
  readonly evidenceArtifactDigests: Set<string>;
  evidenceArtifactBytes: number;
  currentStage?: JevyrStage;
  selectedCandidateId?: string;
  assayFrontier?: AssayFrontier;
  assayFrontierSealed: boolean;
  readonly experimentCapability: ExperimentCapability;
  readonly assayRuns: CandidateAssayRun[];
  readonly assayUsage: MutableAssayUsage;
  /** Diagnostic work is charged before the candidate matrix, never treated as an assay. */
  readonly observerUsage: MutableAssayUsage;
  readonly artifactDigests: Set<string>;
  readonly publicIdeaArtifacts: Map<string, string>;
  assayExhaustionReason?: string;
  nursery?: AdaptiveSearchOutcome;
  readonly assayArchive: QualityDiversityArchive;
  readonly mindBudget: SealedMindBudget;
  readonly subjectProjection: SubjectTextProjection;
  readonly subjectContexts: ReadonlyMap<string, SubjectContext>;
  readonly candidateBlueprints: Map<string, {
    readonly blueprint: CompiledCandidateBlueprint;
    readonly artifactDigest: string;
  }>;
  verifiedAuthorityEdges: readonly VerifiedEvidenceEdge[];
  verifiedOriginalSubjectEdges: readonly VerifiedEvidenceEdge[];
  originalSubjectContext?: OriginalSubjectContext;
  stagedMemoryDigest?: string;
  record?: SignedRecord;
}

interface CandidateAssayRun {
  readonly candidateId: string;
  readonly plan: SealedAssayPlan;
  readonly observation: ToolObservation;
  readonly evidenceId: string;
  readonly evaluation?: ForgeOracleEvaluation;
  readonly wallMillis: number;
  readonly cpuMillis?: number;
  readonly writableBytes?: number;
  readonly writableInodes?: number;
  readonly artifactBytes: number;
  readonly artifactStorageBytes: number;
  readonly costUnitsCharged: number;
  readonly admissible: boolean;
  readonly blockedReason?: string;
}

interface MutableAssayUsage {
  forgeWallMillis: number;
  measuredForgeCpuMillis: number;
  cpuMeasurements: number;
  cpuUnmeasured: boolean;
  workspaceUnmeasured: boolean;
  totalAssayCost: number;
  writableBytes: number;
  writableInodes: number;
  artifactBytes: number;
}

function emptyAssayUsage(): MutableAssayUsage {
  return { forgeWallMillis: 0, measuredForgeCpuMillis: 0, cpuMeasurements: 0, cpuUnmeasured: false,
    workspaceUnmeasured: false, totalAssayCost: 0, writableBytes: 0, writableInodes: 0, artifactBytes: 0 };
}

const KERNEL: PublicActor = Object.freeze({ id: "jevyr.bone", kind: "kernel" });
const ARCHIVIST: PublicActor = Object.freeze({ id: "jevyr.archivist", kind: "archivist" });
const NURSERY: PublicActor = Object.freeze({ id: "jevyr.nursery", kind: "tool" });
const CANDIDATE_POPULATION_MEDIA_TYPE = "application/vnd.jevyr.candidate-population+json" as const;

const SEARCH_RESOURCE_FIELDS: readonly [SearchResourceName, keyof SearchResourceEnvelope][] = Object.freeze([
  ["mindInvocations", "maxMindInvocations"],
  ["inputTokens", "maxInputTokens"],
  ["outputTokens", "maxOutputTokens"],
  ["wallMillis", "maxWallMillis"],
  ["singleInvocationMillis", "maxSingleInvocationMillis"],
  ["generatedBytes", "maxGeneratedBytes"],
  ["forgeCpuMillis", "maxForgeCpuMillis"],
  ["forgeWallMillis", "maxForgeWallMillis"],
  ["memorySeconds", "maxMemorySeconds"],
  ["writableBytes", "maxWritableBytes"],
  ["writableInodes", "maxWritableInodes"],
  ["artifactBytes", "maxArtifactBytes"],
  ["networkBytes", "maxNetworkBytes"],
  ["concurrentLineages", "concurrentLineages"],
  ["totalAssayCost", "maxTotalAssayCost"],
]);

type MeasuredSearchResources = Partial<Record<SearchResourceName, {
  readonly used: number;
  readonly measurement?: "MEASURED" | "UPPER_BOUND";
}>>;

function searchResourceTelemetry(
  envelope: SearchResourceEnvelope,
  measured: MeasuredSearchResources,
): readonly SearchResourceTelemetry[] {
  return Object.freeze(SEARCH_RESOURCE_FIELDS.map(([name, ceilingField]) => {
    const observation = measured[name];
    return Object.freeze({
      name,
      used: observation?.used ?? null,
      ceiling: envelope[ceilingField],
      measurement: observation === undefined ? "DECLARED_ONLY" : observation.measurement ?? "MEASURED",
    });
  }));
}

const MIND_STAGES = new Map<
  JevyrStage,
  { role: MindRequest["role"]; constraints: readonly string[] }
>([
  ["interpret", { role: "interpreter", constraints: ["Keep mutually incompatible readings alive.", "Do not ask for clarification."] }],
  ["diverge", { role: "divergent", constraints: ["Maximize mechanism diversity, not wording diversity.", "Label feasibility."] }],
  ["recombine", { role: "synthesist", constraints: ["Synthesize finite candidates without naming a winner before measurement."] }],
  ["challenge", { role: "challenger", constraints: ["Attack the critical mechanism.", "Propose a discriminating test."] }],
  ["reflex", { role: "reflex", constraints: ["Audit evidence coverage and evaluator leakage.", "Never author a verdict."] }],
]);

/** One real contribution opportunity for RECOMBINE, CHALLENGE, and each REFLEX loop. */
function postDivergeMindMinimum(reflexLoops: number, mindCount: number): number {
  return 1 + Math.max(1, Math.min(2, mindCount)) + reflexLoops;
}

function mindCallAllowance(remainingInvocations: number, futureMinimum: number): number {
  return Math.max(0, remainingInvocations - futureMinimum);
}

function publicError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(/(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 1_000);
}

function stageSummary(stage: JevyrStage, direction: "entered" | "completed"): string {
  const names: Record<JevyrStage, string> = {
    cast: "Receiving the case's only semantic input",
    snapshot: "Binding the declared subjects to immutable digests",
    seal: "Closing semantic input and signing the receipt",
    self_scan: "Probing available minds and the Forge boundary",
    interpret: "Holding competing readings without clarification",
    diverge: "Growing mechanism-diverse candidates",
    recombine: "Synthesizing finite candidates while retaining alternatives",
    embody: "Attempting a disposable embodiment",
    challenge: "Attacking provisional hypotheses with discriminating tests",
    assay: "Compiling axes from evidence",
    reflex: "Checking the judge for leakage and missing evidence",
    crystallize: "Freezing public evidence into a Record",
    sign: "Signing the immutable Record",
    memory_tribunal: "Quarantining what may enter long memory",
    terminate: "Ending the one-way case",
  };
  return `${names[stage]} ${direction === "entered" ? "began" : "completed"}.`;
}

function laterStage(left: JevyrStage, right: JevyrStage | undefined): JevyrStage {
  if (right === undefined) return left;
  return JEVYR_STAGES.indexOf(right) > JEVYR_STAGES.indexOf(left) ? right : left;
}

function actorFor(adapter: MindAdapter | ToolAdapter): PublicActor {
  const capability = adapterCapabilitySnapshot(adapter);
  return {
    id: capability.id,
    kind: capability.kind === "mind" ? "mind" : "forge",
    instance: capability.version,
  };
}

function actorForCapability(capability: MindAdapter["capability"]): PublicActor {
  return {
    id: capability.id,
    kind: capability.kind === "mind" ? "mind" : capability.kind === "peer" ? "peer" : "tool",
    instance: capability.version,
  };
}

function isBuiltInObserveOnlyForge(adapter: ToolAdapter): boolean {
  return SealedForgeAdapter.isBuiltIn(adapter) && adapter.mode === "observe-only";
}

function forgeCapabilityProblem(initial: CaseStatus, adapter: ToolAdapter): string | undefined {
  const capability = adapterCapabilitySnapshot(adapter);
  if (capability.kind !== "tool") return "The configured Forge capability is not a tool.";
  if (!capability.canExecuteTools && !isBuiltInObserveOnlyForge(adapter)) {
    return "The configured Forge capability declares that it cannot execute tools.";
  }
  if (initial.sealed.intent.privacy === "local_only"
    && capability.network !== "none" && capability.network !== "loopback") {
    return "The configured Forge network scope violates the sealed local-only privacy boundary.";
  }
  if (initial.sealed.searchEnvelope.profile.resources.maxNetworkBytes === 0 && capability.network !== "none") {
    return "The configured Forge network scope violates the sealed zero-byte network envelope.";
  }
  return undefined;
}

function liveForgeAuthorityProblem(
  initial: CaseStatus,
  repository: CaseRepository,
  adapter: ToolAdapter,
): string | undefined {
  if (digestJson(repository.policyDescriptor) !== initial.sealed.policyDigest) {
    return "The live policy descriptor no longer equals the policy sealed into this Case.";
  }
  const assessment = sealedDockerForgeAuthority(repository.policyDescriptor);
  if (!assessment.verified || assessment.authority === undefined) return assessment.reason;
  return SealedForgeAdapter.liveAuthorityProblem(adapter, assessment.authority);
}

function observationDigest(observation: ToolObservation): string {
  return encodeToolObservation(observation).digest;
}

function rejectedBoundaryObservation(
  invocationId: string,
  boundary: "Forge" | "Witness",
  reason: string,
  summary = `${boundary} returned an invalid observation; it was rejected at the evidence boundary.`,
): ToolObservation {
  const now = new Date().toISOString();
  return Object.freeze({
    invocationId,
    status: "failed" as const,
    summary,
    startedAt: now,
    finishedAt: now,
    metadata: Object.freeze({ admissible: false, reason }),
  });
}

/** Snapshot untrusted adapter output into the one canonical replay representation. */
function canonicalObservation(
  value: ToolObservation,
  invocationId: string,
  boundary: "Forge" | "Witness",
): ToolObservation {
  let snapshot: ToolObservation;
  try {
    snapshot = decodeToolObservation(encodeToolObservation(value).bytes);
  } catch {
    return rejectedBoundaryObservation(invocationId, boundary, `${boundary.toLowerCase()}-observation-invalid`);
  }
  if (snapshot.invocationId !== invocationId) {
    return rejectedBoundaryObservation(
      invocationId,
      boundary,
      `${boundary.toLowerCase()}-invocation-id-mismatch`,
      `${boundary} returned an observation for a different invocation; it was rejected at the evidence boundary.`,
    );
  }
  return Object.freeze(snapshot);
}

function observedStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function observationWallMillis(observation: ToolObservation): number {
  const started = Date.parse(observation.startedAt);
  const finished = Date.parse(observation.finishedAt);
  return Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundAssayFrontierDigest(initial: CaseStatus, repository: CaseRepository): string | undefined {
  if (digestJson(repository.policyDescriptor) !== initial.sealed.policyDigest) return undefined;
  const descriptor = objectValue(repository.policyDescriptor);
  const policy = objectValue(descriptor?.policy);
  return typeof policy?.assayFrontierDigest === "string" && isSha256Digest(policy.assayFrontierDigest)
    ? policy.assayFrontierDigest
    : undefined;
}

function policyBoundDigest(repository: CaseRepository, field: string): string | undefined {
  const descriptor = objectValue(repository.policyDescriptor);
  const policy = objectValue(descriptor?.policy);
  const value = policy?.[field];
  return typeof value === "string" && isSha256Digest(value) ? value : undefined;
}

function boundWitnessDescriptorDigest(initial: CaseStatus, repository: CaseRepository): string | undefined {
  if (digestJson(repository.policyDescriptor) !== initial.sealed.policyDigest) return undefined;
  const descriptor = objectValue(repository.policyDescriptor);
  const policy = objectValue(descriptor?.policy);
  return typeof policy?.mcpWitnessDigest === "string" && isSha256Digest(policy.mcpWitnessDigest)
    ? policy.mcpWitnessDigest
    : undefined;
}

function boundCandidateIgnorePolicyDigest(initial: CaseStatus, repository: CaseRepository): string | undefined {
  if (digestJson(repository.policyDescriptor) !== initial.sealed.policyDigest) return undefined;
  const descriptor = objectValue(repository.policyDescriptor);
  const policy = objectValue(descriptor?.policy);
  return typeof policy?.candidateIgnorePolicyDigest === "string" && isSha256Digest(policy.candidateIgnorePolicyDigest)
    ? policy.candidateIgnorePolicyDigest
    : undefined;
}

function publicObservationExcerpt(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const excerpt = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 500);
  return excerpt || undefined;
}

function forgeArgv(plan: ForgePlan): readonly string[] | undefined {
  const command = plan.args.command;
  const args = plan.args.args;
  if (typeof command !== "string" || !command.trim()) return undefined;
  if (args !== undefined && (!Array.isArray(args) || args.some((entry) => typeof entry !== "string"))) return undefined;
  return Object.freeze([command, ...((args ?? []) as readonly string[])]);
}

function resolveForgeObligation(initial: CaseStatus, plan: ForgePlan) {
  const obligations = initial.sealed.intentContract.criticalObligations;
  if (plan.obligationId) {
    const explicit = obligations.find((entry) => entry.id === plan.obligationId);
    return explicit?.assayability === "ASSAYABLE" && explicit.oracle !== undefined ? explicit : undefined;
  }
  const argv = forgeArgv(plan);
  if (!argv) return undefined;
  const matching = obligations.filter((entry) => {
    if (entry.assayability !== "ASSAYABLE" || entry.oracle?.kind !== "command_exit_code") return false;
    const expected = parseStrictOracleCommand(entry.oracle.operand);
    return expected?.length === argv.length && expected.every((part, index) => part === argv[index]);
  });
  return matching.length === 1 ? matching[0] : undefined;
}

function toSealedForgeOraclePlan(
  plan: ForgePlan,
  obligationId: string,
): SealedForgeOraclePlan | undefined {
  const argv = forgeArgv(plan);
  const command = argv?.[0];
  if (!argv || !command) return undefined;
  return Object.freeze({
    tool: "forge.command",
    obligationId,
    command,
    args: Object.freeze(argv.slice(1)),
    shell: false,
    ...(plan.sealedSubjectDigest === undefined ? {} : { sealedSubjectDigest: plan.sealedSubjectDigest }),
    ...(plan.sealedTestSuite === undefined ? {} : { sealedTestSuite: plan.sealedTestSuite }),
    ...(plan.requestedAssay === undefined ? {} : { requestedAssay: plan.requestedAssay }),
  });
}

function forgePlanBindingProblem(
  initial: CaseStatus,
  plan: SealedAssayPlan,
  experimentCapability?: ExperimentCapability,
): string | undefined {
  const obligation = resolveForgeObligation(initial, plan);
  if (!obligation?.oracle) {
    const experiment = experimentForPlan(experimentCapability, plan);
    return experiment?.authority === "comparative-only"
      ? undefined
      : "The assay is neither bound to exactly one sealed assayable obligation nor admitted by the narrow comparative experiment grammar.";
  }
  const oraclePlan = toSealedForgeOraclePlan(plan, obligation.id);
  if (!oraclePlan) return "The assay does not contain a finite no-shell argv binding.";
  if (obligation.oracle.kind === "command_exit_code") {
    const expected = parseStrictOracleCommand(obligation.oracle.operand);
    const actual = [oraclePlan.command, ...oraclePlan.args];
    if (expected === undefined || expected.length !== actual.length
      || expected.some((part, index) => part !== actual[index])) {
      return "The sealed command oracle and assay plan name different argv.";
    }
  }
  if (obligation.oracle.kind === "sealed_subject_digest" && !isSha256Digest(oraclePlan.sealedSubjectDigest ?? "")) {
    return "The sealed-subject assay has no policy-bound subject digest.";
  }
  if (plan.sealedSubjectDigest !== undefined
    && plan.sealedSubjectDigest !== initial.sealed.subjectMaterialCaptureDigest) {
    return "The assay's sealed subject digest does not equal the Case subject material capture digest.";
  }
  if (obligation.oracle.kind === "sealed_test_suite" && !isSha256Digest(oraclePlan.sealedTestSuite?.suiteDigest ?? "")) {
    return "The sealed-suite assay has no policy-bound suite digest.";
  }
  if (obligation.oracle.kind === "requested_assay"
    && (!isSha256Digest(oraclePlan.requestedAssay?.definitionDigest ?? "")
      || !isSha256Digest(oraclePlan.requestedAssay?.evaluatorDigest ?? ""))) {
    return "The requested assay has no policy-bound definition and evaluator digests.";
  }
  return undefined;
}

function unavailableEvaluatorProblem(plan: ForgePlan): string | undefined {
  if (plan.sealedTestSuite !== undefined) {
    return "The sealed test-suite binding has no Bone-owned immutable evaluator substrate; digest-shaped reports are non-adjudicative.";
  }
  if (plan.requestedAssay !== undefined) {
    return "The requested-assay binding has no Bone-owned immutable evaluator substrate; digest-shaped results are non-adjudicative.";
  }
  return undefined;
}

function blockedForgeEvaluation(
  obligation: ReturnType<typeof resolveForgeObligation>,
  reason: string,
): ForgeOracleEvaluation | undefined {
  if (!obligation) return undefined;
  return Object.freeze({
    obligationId: obligation.id,
    ...(obligation.oracle === undefined ? {} : { oracleKind: obligation.oracle.kind }),
    status: "BLOCKED",
    decisive: false,
    reason,
  });
}

function finiteReading(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function forgePhysicalReadings(observation: ToolObservation): {
  readonly cpuMillis?: number;
  readonly writableBytes?: number;
  readonly writableInodes?: number;
} {
  const accounting = objectValue(observation.metadata?.resourceAccounting);
  if (accounting?.protocol !== "jevyr.forge-resource-accounting/1") return Object.freeze({});
  const workspace = objectValue(accounting?.workspace);
  const after = objectValue(workspace?.after);
  const cpu = objectValue(accounting?.cpu);
  const writableBytes = finiteReading(after?.bytes);
  const writableInodes = finiteReading(after?.inodes);
  const byteCeiling = finiteReading(workspace?.byteCeiling);
  const inodeCeiling = finiteReading(workspace?.inodeCeiling);
  const workspaceComplete = after?.measurement === "MEASURED"
    && after.complete === true
    && Number.isSafeInteger(writableBytes)
    && Number.isSafeInteger(writableInodes)
    && Number.isSafeInteger(byteCeiling)
    && Number.isSafeInteger(inodeCeiling)
    && (writableBytes as number) <= (byteCeiling as number)
    && (writableInodes as number) <= (inodeCeiling as number);
  const measuredCpu = finiteReading(cpu?.usedMillis);
  const cpuMillis = cpu?.measurement === "MEASURED" && Number.isSafeInteger(measuredCpu)
    ? measuredCpu
    : undefined;
  return Object.freeze({
    ...(cpuMillis === undefined ? {} : { cpuMillis }),
    ...(workspaceComplete ? { writableBytes: writableBytes as number } : {}),
    ...(workspaceComplete ? { writableInodes: writableInodes as number } : {}),
  });
}

/** Every coordinate below comes from candidate-scoped executions, never model prose. */
function measuredBehaviorDescriptor(
  runsOrObservation: readonly CandidateAssayRun[] | ToolObservation,
  wallOrEvaluation: number | ForgeOracleEvaluation,
  legacyWallCeiling?: number,
): BehaviorDescriptor {
  if (!Array.isArray(runsOrObservation)) {
    const observation = runsOrObservation as ToolObservation;
    const evaluation = wallOrEvaluation as ForgeOracleEvaluation;
    const wallCeiling = legacyWallCeiling as number;
    const changed = observedStrings(observation.metadata?.changedFiles);
    const artifacts = observation.artifactRefs ?? [];
    const outputBytes = toolObservationOutputBytes(observation);
    return Object.freeze({
      semantic: Object.freeze([evaluation.status === "PASSED" ? 1 : 0, evaluation.status === "FAILED" ? 1 : 0]),
      mechanism: Object.freeze([clamp(changed.length / 100, 0, 1), clamp(artifacts.length / 32, 0, 1)]),
      causal: Object.freeze([evaluation.status === "PASSED" ? 1 : 0, evaluation.status === "FAILED" ? 1 : 0, evaluation.decisive ? 1 : 0]),
      implementation: Object.freeze([
        clamp(observationWallMillis(observation) / Math.max(1, wallCeiling), 0, 1),
        clamp(outputBytes / 2_000_000, 0, 1),
        observation.exitCode === undefined ? 0 : clamp(Math.abs(observation.exitCode) / 255, 0, 1),
      ]),
    });
  }
  const runs = runsOrObservation as readonly CandidateAssayRun[];
  const wallCeiling = wallOrEvaluation as number;
  const evaluations = runs.flatMap((run) => run.evaluation === undefined ? [] : [run.evaluation]);
  const changed = runs.reduce((sum, run) => sum + observedStrings(run.observation.metadata?.changedFiles).length, 0);
  const artifacts = runs.reduce((sum, run) => sum + (run.observation.artifactRefs?.length ?? 0), 0);
  const outputBytes = runs.reduce((sum, run) => sum + toolObservationOutputBytes(run.observation), 0);
  const passed = evaluations.filter((entry) => entry.status === "PASSED").length;
  const failed = evaluations.filter((entry) => entry.status === "FAILED").length;
  const decisive = evaluations.filter((entry) => entry.decisive).length;
  const denominator = Math.max(1, runs.length);
  return Object.freeze({
    semantic: Object.freeze([passed / denominator, failed / denominator]),
    mechanism: Object.freeze([clamp(changed / 100, 0, 1), clamp(artifacts / 32, 0, 1)]),
    causal: Object.freeze([passed / denominator, failed / denominator, decisive / denominator]),
    implementation: Object.freeze([
      clamp(runs.reduce((sum, run) => sum + run.wallMillis, 0) / Math.max(1, wallCeiling), 0, 1),
      clamp(outputBytes / 2_000_000, 0, 1),
      clamp(runs.filter((run) => run.observation.exitCode === 0).length / denominator, 0, 1),
    ]),
  });
}

function measuredEvaluation(
  runsOrObservation: readonly CandidateAssayRun[] | ToolObservation,
  wallOrEvaluation: number | ForgeOracleEvaluation,
  legacyWallCeiling?: number,
): CandidateEvaluation {
  if (!Array.isArray(runsOrObservation)) {
    const observation = runsOrObservation as ToolObservation;
    const evaluation = wallOrEvaluation as ForgeOracleEvaluation;
    const wallCeiling = legacyWallCeiling as number;
    const executed = observation.status === "succeeded" || observation.status === "failed";
    const passed = evaluation.status === "PASSED";
    const wallMillis = observationWallMillis(observation);
    const changed = observedStrings(observation.metadata?.changedFiles).length;
    const artifacts = observation.artifactRefs?.length ?? 0;
    return Object.freeze({
      integrity: executed && wallMillis <= wallCeiling,
      embodied: observation.status === "succeeded",
      criticalTestsExecuted: evaluation.decisive && executed,
      unresolvedCritical: passed ? 0 : 1,
      scores: Object.freeze({
        discrimination: evaluation.decisive ? 1 : 0,
        robustness: passed ? 0.25 : 0,
        parsimony: 1 / (1 + changed + artifacts),
        feasibility: observation.status === "succeeded" && passed ? 1 : 0,
        evidenceCoverage: evaluation.decisive && executed ? 1 : 0,
        resourceEfficiency: clamp(1 - wallMillis / Math.max(1, wallCeiling), 0, 1),
      }),
      evidenceDigests: executed ? Object.freeze([observationDigest(observation)]) : Object.freeze([]),
      failureReasons: Object.freeze(passed ? [] : [evaluation.reason]),
      effortUnits: Math.max(1, wallMillis),
    });
  }
  const runs = runsOrObservation as readonly CandidateAssayRun[];
  const wallCeiling = wallOrEvaluation as number;
  const evaluations = runs.flatMap((run) => run.evaluation === undefined ? [] : [run.evaluation]);
  const executed = runs.length > 0 && runs.every((run) =>
    run.admissible && run.observation.oracle?.execution.state === "exited");
  const decisive = runs.length > 0 && evaluations.length === runs.length && evaluations.every((entry) => entry.decisive);
  const passed = decisive && evaluations.every((entry) => entry.status === "PASSED");
  const wallMillis = runs.reduce((sum, run) => sum + run.wallMillis, 0);
  const measuredPhysicalUnits = runs.reduce(
    (sum, run) => sum + (run.writableBytes ?? 0) + (run.writableInodes ?? 0) + run.artifactBytes,
    0,
  );
  const changed = runs.reduce((sum, run) => sum + observedStrings(run.observation.metadata?.changedFiles).length, 0);
  const artifacts = runs.reduce((sum, run) => sum + (run.observation.artifactRefs?.length ?? 0), 0);
  const withinEnvelope = wallMillis <= wallCeiling;
  return Object.freeze({
    integrity: executed && withinEnvelope,
    embodied: executed,
    criticalTestsExecuted: decisive && executed,
    unresolvedCritical: runs.filter((run) => run.evaluation?.status !== "PASSED" || !run.admissible).length,
    scores: Object.freeze({
      discrimination: runs.length === 0 ? 0 : evaluations.filter((entry) => entry.decisive).length / runs.length,
      robustness: passed ? clamp(0.25 + Math.max(0, runs.length - 1) * 0.15, 0, 1) : 0,
      parsimony: 1 / (1 + changed + artifacts),
      feasibility: executed && passed ? 1 : 0,
      evidenceCoverage: runs.length === 0 ? 0 : evaluations.filter((entry) => entry.decisive).length / runs.length,
      // Selection uses replay-stable measured quantities. Host monotonic wall is
      // an aggregate safety stop, not a nondeterministic taste signal.
      resourceEfficiency: 1 / (1 + measuredPhysicalUnits),
    }),
    evidenceDigests: executed
      ? Object.freeze(runs.map((run) => observationDigest(run.observation)).sort())
      : Object.freeze([]),
    failureReasons: Object.freeze([
      ...(executed ? [] : ["Forge did not execute a terminal assay."]),
      ...(decisive ? [] : ["The typed sealed oracle was blocked."]),
      ...(withinEnvelope ? [] : ["Forge wall time crossed the sealed search envelope."]),
      ...(passed ? [] : evaluations.filter((entry) => entry.status !== "PASSED").map((entry) => entry.reason)),
      ...runs.flatMap((run) => run.blockedReason === undefined ? [] : [run.blockedReason]),
    ]),
    effortUnits: Math.max(1, runs.reduce((sum, run) => sum + run.plan.costUnits, 0)),
  });
}

const RECORD_COMMIT_AUTHORITIES = new WeakMap<JevyrOrchestrator, RecordCommitAuthority>();

export class JevyrOrchestrator {
  private readonly requestedStages = new Map<string, JevyrStage>();
  private readonly jugglerBooks = new Map<string, LiveJugglerBook>();
  private readonly liveBudgets = new Map<string, SealedMindBudget>();

  vouchers(caseId: string): readonly JugglerVoucherOffer[] {
    throw new Error(`Legacy uncalibrated vouchers are disabled for ${caseId}; use typed metabolism offers`);
  }

  redeemVoucher(caseId: string, value: unknown): JugglerReceipt {
    void value;
    throw new Error(`Legacy uncalibrated vouchers are disabled for ${caseId}; use typed metabolism offers`);
  }

  metabolismOffers(caseId: string): MetabolicOffers {
    const book = this.jugglerBooks.get(caseId);
    if (!book) throw new Error("No live calibrated metabolic admission channel exists for this Case");
    return this.metabolicReproductionPlan ? Object.freeze({ ...book.offers(), admission: "closed", offers: Object.freeze([]) }) : book.offers();
  }

  async redeemMetabolism(caseId: string, value: unknown): Promise<MetabolicRedemption> {
    if (this.metabolicReproductionPlan) throw new Error("Controlled Juggler reproduction admits only fresh receipts from its authenticated source checkpoint plan");
    const book = this.jugglerBooks.get(caseId);
    if (!book) throw new Error("No live calibrated metabolic admission channel exists for this Case");
    return await book.redeem(value);
  }

  /** Internal exporter accounting view; absent from the public daemon facade. */
  effectiveResourceEnvelope(caseId: string): SearchResourceEnvelope | undefined {
    return this.liveBudgets.get(caseId)?.effectiveEnvelope();
  }
  private readonly active = new Map<string, AbortController>();
  private readonly abortClosed = new Set<string>();
  private readonly activeRuns = new Map<string, Promise<void>>();
  private readonly admittedMinds: readonly MindAdapter[];
  private readonly admittedForge: ToolAdapter;
  private readonly admittedWitnesses: QuarantinedWitnessSet | undefined;
  private readonly reflexLoops: number;
  private readonly sealedAssayFrontier: AssayFrontier | undefined;
  private readonly runtimeGrowthPolicy: RuntimeGrowthPolicy | undefined;
  private readonly metabolicReproductionPlan: MetabolicReproductionPlan | undefined;
  private readiness: Promise<void> = Promise.resolve();
  private readinessBound = false;

  constructor(private readonly config: OrchestratorConfig) {
    this.metabolicReproductionPlan = config.metabolicReproductionPlan === undefined ? undefined : JSON.parse(canonicalize(config.metabolicReproductionPlan as unknown as JsonValue)) as MetabolicReproductionPlan;
    if (config.minds.length === 0) throw new TypeError("Jevyr requires at least one mind adapter");
    const mindCapabilities = config.minds.map((mind) => snapshotAdapterCapability(mind));
    const forgeCapability = snapshotAdapterCapability(config.forge);
    const witnessCapabilities = (config.witnesses?.adapters ?? [])
      .map((adapter) => snapshotAdapterCapability(adapter));
    if (mindCapabilities.some((capability) => capability.kind !== "mind")) {
      throw new TypeError("Every configured Mind adapter must declare kind mind");
    }
    // A structurally valid but contextually wrong Forge kind follows the
    // established in-Case denial path so the refusal remains auditable.
    if (witnessCapabilities.some((capability) => capability.kind !== "tool")) {
      throw new TypeError("Every configured witness adapter must declare kind tool");
    }
    const capabilityIds = [...mindCapabilities, forgeCapability, ...witnessCapabilities]
      .map((capability) => capability.id);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      throw new TypeError("Configured adapter capability ids must be unique");
    }
    this.admittedMinds = Object.freeze([...config.minds]);
    this.admittedForge = config.forge;
    this.admittedWitnesses = config.witnesses === undefined
      ? undefined
      : Object.freeze({
          ...config.witnesses,
          adapters: Object.freeze([...config.witnesses.adapters]),
          calls: Object.freeze([...config.witnesses.calls]),
        });
    if (config.memory && !config.memoryProjectId?.trim()) {
      throw new TypeError("A configured Temporal Deep requires a non-empty memoryProjectId");
    }
    this.sealedAssayFrontier = config.assayFrontier === undefined
      ? undefined
      : verifyAssayFrontier(config.assayFrontier, config.repository.searchEnvelope.profile.resources);
    if (this.sealedAssayFrontier !== undefined) {
      config.repository.bindRecordAssayFrontier(this.sealedAssayFrontier);
    }
    this.runtimeGrowthPolicy = config.runtimeGrowthPolicy === undefined
      ? undefined
      : verifyRuntimeGrowthPolicy(config.runtimeGrowthPolicy);
    if (this.runtimeGrowthPolicy !== undefined) {
      if (policyBoundDigest(config.repository, "runtimeGrowthPolicyDigest") !== this.runtimeGrowthPolicy.digest) {
        throw new TypeError("Runtime growth policy is not bound into the repository policy");
      }
      if (canonicalize(this.runtimeGrowthPolicy.nursery as unknown as JsonValue)
        !== canonicalize(config.repository.searchEnvelope.profile.nursery as unknown as JsonValue)) {
        throw new TypeError("Runtime growth nursery controls do not match the sealed search profile");
      }
      if (this.sealedAssayFrontier !== undefined
        && (this.sealedAssayFrontier.archive.capacity !== this.runtimeGrowthPolicy.archive.capacity
          || this.sealedAssayFrontier.archive.minimumNovelty !== this.runtimeGrowthPolicy.archive.minimumNovelty)) {
        throw new TypeError("Runtime growth archive controls do not match the sealed Assay Frontier");
      }
    }
    this.reflexLoops = Math.min(2, Math.max(1, Math.trunc(config.reflexLoops ?? 1)));
    RECORD_COMMIT_AUTHORITIES.set(this, claimRecordCommitAuthority(config.repository));
  }

  private async persistObservation(
    initial: CaseStatus,
    state: RunState,
    observation: ToolObservation,
  ): Promise<string> {
    const encoded = encodeToolObservation(observation);
    const additionalBytes = state.evidenceArtifactDigests.has(encoded.digest) ? 0 : encoded.size;
    if (additionalBytes > MAX_CASE_EVIDENCE_BYTES - state.evidenceArtifactBytes) {
      throw new Error(
        `Case evidence store would exceed Bone's ${MAX_CASE_EVIDENCE_BYTES}-byte boundary`,
      );
    }
    const artifact = await this.config.repository.putArtifact(
      initial.caseId,
      `tool-observation-${encoded.digest.slice("sha256:".length, "sha256:".length + 24)}.json`,
      TOOL_OBSERVATION_MEDIA_TYPE,
      encoded.bytes,
    );
    if (artifact.digest !== encoded.digest || artifact.size !== encoded.size) {
      throw new Error("Repository returned an observation artifact with inconsistent content identity");
    }
    state.evidenceArtifactDigests.add(encoded.digest);
    state.evidenceArtifactBytes += additionalBytes;
    return encoded.digest;
  }

  private async persistPublicIdea(
    initial: CaseStatus,
    state: RunState,
    candidateId: string,
    contribution: PublicContribution,
  ): Promise<string> {
    const encoded = encodePublicIdea(candidateId, contribution);
    const existing = state.publicIdeaArtifacts.get(candidateId);
    if (existing !== undefined) {
      if (existing !== encoded.digest) {
        throw new Error(`Candidate ${candidateId} is already bound to a different public idea`);
      }
      return existing;
    }
    const additionalBytes = state.artifactDigests.has(encoded.digest) ? 0 : encoded.size;
    const maximumBytes = state.mindBudget.effectiveEnvelope().maxArtifactBytes;
    if (additionalBytes > maximumBytes - state.assayUsage.artifactBytes) {
      throw new RangeError("The sealed Case artifact envelope cannot retain this public candidate idea");
    }
    const artifact = await this.config.repository.putArtifact(
      initial.caseId,
      `public-idea-${encoded.digest.slice("sha256:".length, "sha256:".length + 24)}.json`,
      PUBLIC_IDEA_MEDIA_TYPE,
      encoded.bytes,
    );
    if (artifact.digest !== encoded.digest
      || artifact.size !== encoded.size
      || artifact.mediaType !== PUBLIC_IDEA_MEDIA_TYPE) {
      throw new Error("Repository returned a public-idea artifact with inconsistent content identity");
    }
    state.publicIdeaArtifacts.set(candidateId, artifact.digest);
    state.artifactDigests.add(artifact.digest);
    state.assayUsage.artifactBytes += additionalBytes;
    return artifact.digest;
  }

  private persistedObservationDigest(state: RunState, observation: ToolObservation): string {
    const digest = observationDigest(observation);
    if (!state.evidenceArtifactDigests.has(digest)) {
      throw new Error(`Observation ${observation.invocationId} has no durable content-addressed evidence artifact`);
    }
    return digest;
  }

  async cast(submission: CastSubmission | unknown, capturedSubjectCaseId?: string): Promise<CaseStatus> {
    await this.readiness;
    const created = await this.config.repository.create(submission, capturedSubjectCaseId);
    let status = created;

    status = await this.enterAndComplete(status, "cast", async () => undefined, "queued");
    status = await this.enterAndComplete(status, "snapshot", async () => {
      for (const snapshot of status.sealed.subjects) {
        await this.emit(status, "snapshot", "evidence.observed", KERNEL, {
          evidenceId: `snapshot:${snapshot.subjectId}`,
          evidenceType: "subject_snapshot",
          summary: `Subject ${snapshot.subjectId} was bound to ${snapshot.digest}.`,
          contentDigest: snapshot.digest,
        });
      }
    }, "queued");
    status = await this.enterAndComplete(status, "seal", async () => {
      await this.emit(status, "seal", "kernel.status", KERNEL, {
        operation: "sealed",
        summary: "The airlock closed; later semantic input is structurally unavailable.",
        artifactDigest: status.receipt.caseDigest,
      });
    }, "queued");

    const allowance = metabolicAllowanceFromPolicyDescriptor(this.config.repository.policyDescriptor);
    const budget = new SealedMindBudget(status.sealed.searchEnvelope.profile.resources, allowance && status.sealed.intent.control === "juggler" ? { allowance, sealed: status.sealed } : undefined);
    this.liveBudgets.set(status.caseId, budget);
    if (status.sealed.intent.control === "juggler" && allowance) {
      this.jugglerBooks.set(status.caseId, new LiveJugglerBook(status.sealed, {
        policyDescriptor: this.config.repository.policyDescriptor,
        calibrations: this.config.metabolicCalibrations ?? [],
        initialEligibleKinds: ["Mass", "Fission"],
        commit: async (receipt) => {
          const signed = await this.config.repository.writeMetabolicReceipt(status.caseId, receipt, RECORD_COMMIT_AUTHORITIES.get(this)!);
          const artifact = await this.config.repository.putArtifact(status.caseId, `metabolism-${receipt.sequence}.json`, "application/vnd.jevyr.metabolism-redemption+json", Buffer.from(canonicalize(signed as unknown as JsonValue)));
          const current = await this.config.repository.status(status.caseId);
          if (!current) throw new Error("Metabolic Case vanished during durable publication");
          await this.emit(current, this.requestedStages.get(status.caseId) ?? current.stage ?? "seal", "action.status", KERNEL, { actionId: receipt.digest, actionType: "metabolism.grant", status: "completed", summary: `${receipt.kind} added ${receipt.quantity} calibrated work units under the separately sealed allowance. The original baseline and verdict authority remain unchanged.`, artifactDigests: [artifact.digest] });
          return signed;
        },
      }));
    }
    const controller = new AbortController();
    this.active.set(status.caseId, controller);
    const initial = status;
    const completion = Promise.resolve().then(async () => this.run(initial, controller.signal));
    this.activeRuns.set(status.caseId, completion);
    void completion.finally(() => {
      this.active.delete(initial.caseId);
      this.abortClosed.delete(initial.caseId);
      this.activeRuns.delete(initial.caseId);
      this.jugglerBooks.delete(initial.caseId);
      this.liveBudgets.delete(initial.caseId);
      this.requestedStages.delete(initial.caseId);
    }).catch(() => undefined);
    return status;
  }

  async waitForTerminal(caseId: string, timeoutMs = 30_000): Promise<CaseStatus> {
    await this.readiness;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const status = await this.config.repository.status(caseId);
      if (!status) throw new Error(`Unknown case ${caseId}`);
      if (status.lifecycle === "terminated" || status.lifecycle === "invalid") {
        if (await this.config.repository.terminalReceipt(caseId)) return status;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${caseId}`);
      const liveCursor = await this.config.events.lastSequence(caseId);
      await this.config.events.wait(caseId, liveCursor, Math.min(remaining, 1_000));
    }
  }

  abortAll(): void {
    for (const controller of this.active.values()) controller.abort("Jevyr runtime is shutting down");
  }

  /** Emergency stop only. No reason, message, target, or continuation is accepted. */
  abort(caseId: string): "accepted" | "closed" {
    const controller = this.active.get(caseId);
    if (controller === undefined || this.abortClosed.has(caseId)) return "closed";
    controller.abort(new Error("Operator requested emergency abort; the sealed Case cannot resume"));
    return "accepted";
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.activeRuns.values()]);
  }

  /** Bind once to daemon initialization so public orchestration cannot race recovery. */
  bindReadiness(readiness: Promise<unknown>): void {
    if (this.readinessBound) throw new Error("Jevyr orchestrator readiness is already bound");
    this.readinessBound = true;
    this.readiness = readiness.then(() => undefined);
  }

  /**
   * Reconciles persisted nonterminal cases after exclusive ownership is acquired.
   * It never resumes a semantic, model, Forge, assay, or memory stage.
   */
  async recoverInterruptedCases(): Promise<{ recovered: number; terminated: number; invalidated: number }> {
    if (this.active.size > 0) throw new Error("Cannot reconcile stored cases while cases are active");
    const authority = RECORD_COMMIT_AUTHORITIES.get(this);
    if (authority === undefined) throw new Error("Bone has no terminal signing authority");
    for (const status of await this.config.repository.statuses()) {
      if (status.lifecycle === "terminated") {
        await this.config.repository.writeTerminalReceipt(status.caseId, authority);
        await this.restoreSignedMemoryCandidate(status);
      } else if (status.lifecycle === "invalid") {
        let record: SignedRecord | undefined;
        try {
          record = await this.config.repository.record(status.caseId);
        } catch {
          // Invalid or partial Record material is handled by recovery below.
        }
        if (record !== undefined) {
          await this.config.repository.writeTerminalReceipt(status.caseId, authority);
        }
      }
    }
    const interrupted = await this.config.repository.nonterminalStatuses();
    let terminated = 0;
    let invalidated = 0;
    for (const status of interrupted) {
      const attested = await this.config.repository.restoreAttestedTerminal(status.caseId, authority);
      if (attested !== undefined) {
        if (attested === "terminated") await this.restoreSignedMemoryCandidate(status);
        if (attested === "terminated") terminated += 1; else invalidated += 1;
        continue;
      }
      const disposition = await this.recoverInterruptedCase(status);
      if (disposition === "terminated") terminated += 1;
      else invalidated += 1;
    }
    return { recovered: interrupted.length, terminated, invalidated };
  }

  /** Restore only the exact signed candidate's idempotent SQLite staging.
   * A closed attestation already covers the Tribunal's completed public work;
   * rerunning comparisons against today's memory could change its frozen root. */
  private async restoreSignedMemoryCandidate(status: CaseStatus): Promise<void> {
    if (!this.config.memory || !this.config.memoryProjectId) return;
    const events = await this.config.events.read(status.caseId);
    const authenticated = await this.inspectStoredRecord(status, events);
    if (!authenticated.record) throw new Error(`Memory recovery requires an authenticated Record: ${authenticated.reason}`);
    await this.stageCommittedMemoryCandidate(status, authenticated.record, events);
  }

  private async recoverInterruptedCase(initial: CaseStatus): Promise<"terminated" | "invalidated"> {
    let events: readonly CaseEvent[];
    try {
      events = await this.config.events.read(initial.caseId);
    } catch (error) {
      const detail = `Runtime restart found an unreadable event ledger: ${publicError(error)}`;
      await this.persistRestartFailure(initial, [], detail, false);
      return "invalidated";
    }

    const existing = await this.inspectStoredRecord(initial, events);
    if (existing.record) {
      let memoryRecovery = "No signed memory commitment was staged during recovery.";
      let stagedDigest: string | undefined;
      try {
        stagedDigest = await this.stageCommittedMemoryCandidate(
          initial,
          existing.record,
          events,
        );
        if (stagedDigest !== undefined) {
          memoryRecovery = `The signed memory commitment ${stagedDigest} was reconciled idempotently into Temporal Deep.`;
        }
      } catch (error) {
        memoryRecovery = `Memory reconciliation failed closed: ${publicError(error)}`;
      }
      const actionId = stableId("recovery", {
        runDigest: initial.sealed.runDigest,
        disposition: "terminate-existing-signed-record",
        recordDigest: digestJson(existing.record as unknown as JsonValue),
      });
      let recovery = events.find((event): event is CaseEvent<"action.status"> =>
        event.kind === "action.status" && event.payload.actionId === actionId,
      );
      if (!recovery) {
        recovery = await this.emit(initial, "terminate", "action.status", KERNEL, {
          actionId,
          actionType: "runtime.recovery.terminate-existing-record",
          status: "completed",
          summary: `Runtime restart found a valid signed Record; Jevyr terminated the interrupted case without resuming or rewriting any semantic stage. ${memoryRecovery}`,
          artifactDigests: [digestJson(existing.record as unknown as JsonValue)],
        });
      }
      if (stagedDigest !== undefined) {
        await this.reconcileTerminatingMemoryCase(
          initial,
          existing.record,
          stagedDigest,
          true,
        );
      }
      const current = await this.config.events.read(initial.caseId);
      const tail = current.at(-1) ?? recovery;
      await this.config.repository.updateStatus(initial.caseId, {
        lifecycle: "terminated",
        stage: "terminate",
        stageStatus: "completed",
        lastSequence: tail.sequence,
        headDigest: tail.eventDigest,
      });
      const authority = RECORD_COMMIT_AUTHORITIES.get(this);
      if (authority === undefined) throw new Error("Bone has no terminal signing authority");
      await this.config.repository.writeTerminalReceipt(initial.caseId, authority);
      return "terminated";
    }

    const detail = `Runtime restart interrupted a nonterminal case before a valid signed Record existed: ${existing.reason}`;
    await this.persistRestartFailure(initial, events, detail, true);
    return "invalidated";
  }

  private async inspectStoredRecord(
    initial: CaseStatus,
    events: readonly CaseEvent[],
  ): Promise<{ record?: SignedRecord; reason: string }> {
    let record: SignedRecord | undefined;
    let envelope;
    try {
      [record, envelope] = await Promise.all([
        this.config.repository.record(initial.caseId),
        this.config.repository.recordEnvelope(initial.caseId),
      ]);
    } catch (error) {
      return { reason: `stored Record material could not be decoded (${publicError(error)})` };
    }
    if (!record && !envelope) return { reason: "no Record or Record envelope was present" };
    if (!record || !envelope) return { reason: "the Record and its signature envelope were not both present" };
    const validation = validateSignedRecord(record);
    if (!validation.ok) return { reason: `the Record failed protocol validation (${validation.problems.map((entry) => entry.code).join(", ")})` };
    if (envelope.payloadType !== RECORD_DSSE_PAYLOAD_TYPE || typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures)) {
      return { reason: "the Record signature envelope had an invalid shape or payload type" };
    }
    let decoded: unknown;
    let payloadText: string;
    try {
      payloadText = Buffer.from(envelope.payload, "base64").toString("utf8");
      decoded = decodeDsseJson<unknown>(envelope);
    } catch (error) {
      return { reason: `the signed Record payload was not JSON (${publicError(error)})` };
    }
    try {
      if (payloadText !== canonicalize(decoded as JsonValue)) return { reason: "the signed Record payload was not canonical JSON" };
      if (canonicalize(decoded as JsonValue) !== canonicalize(record as unknown as JsonValue)) {
        return { reason: "the signed payload did not equal the stored Record" };
      }
    } catch (error) {
      return { reason: `the signed Record payload was not canonicalizable (${publicError(error)})` };
    }
    const trust = await this.config.repository.publicTrustBundle();
    const publicKeys = new Map(trust.keys.map((key) => [key.keyId, key.publicKeyPem] as const));
    if (!verifyDsse(envelope, publicKeys)) return { reason: "the Record signature did not verify against the repository trust root" };
    if (
      record.caseDigest !== initial.sealed.caseDigest ||
      record.runDigest !== initial.sealed.runDigest ||
      record.policyDigest !== initial.sealed.policyDigest ||
      record.genomeDigest !== initial.sealed.genomeDigest ||
      record.searchDigest !== initial.sealed.searchEnvelope.digest ||
      record.intentContractDigest !== initial.sealed.intentContractDigest ||
      record.verdict.intentContractDigest !== initial.sealed.intentContractDigest ||
      record.reflex.intentContractDigest !== initial.sealed.intentContractDigest
    ) {
      return { reason: "the signed Record did not bind the sealed case identity and provenance" };
    }
    const prefixIndex = events.findIndex((event) => event.eventDigest === record.eventHeadDigest);
    if (prefixIndex < 0) return { reason: "the Record crystallization head was not present in the verified event ledger" };
    if (events[prefixIndex]?.caseDigest !== record.caseDigest || events[prefixIndex]?.runDigest !== record.runDigest) {
      return { reason: "the Record crystallization head belonged to a different event identity" };
    }
    return { record, reason: "valid signed Record" };
  }

  private async persistRestartFailure(
    initial: CaseStatus,
    verifiedEvents: readonly CaseEvent[],
    detail: string,
    ledgerAppendable: boolean,
  ): Promise<void> {
    const actionId = stableId("recovery", {
      runDigest: initial.sealed.runDigest,
      disposition: "invalidate-interrupted-run",
    });
    let current = verifiedEvents;
    let recoveryEvent = current.find((event): event is CaseEvent<"action.status"> =>
      event.kind === "action.status" && event.payload.actionId === actionId,
    );
    if (!recoveryEvent && ledgerAppendable) {
      const stage = laterStage(initial.stage, current.at(-1)?.stage);
      recoveryEvent = await this.emit(initial, stage, "action.status", KERNEL, {
        actionId,
        actionType: "runtime.recovery.invalidate-interrupted-run",
        status: "failed",
        summary: detail,
      });
      current = await this.config.events.read(initial.caseId);
    }

    const fixedDetail = initial.lifecycle === "invalid" && initial.error ? initial.error : detail;
    const tail = current.at(-1) ?? recoveryEvent;
    await this.config.repository.updateStatus(initial.caseId, {
      lifecycle: "invalid",
      stage: laterStage(initial.stage, tail?.stage),
      stageStatus: "failed",
      lastSequence: tail?.sequence ?? initial.lastSequence,
      headDigest: tail?.eventDigest ?? initial.headDigest,
      error: fixedDetail,
    });
    try {
      await this.config.repository.writeRecoveryRecord(initial.caseId, "RUNTIME_RESTART_INTERRUPTED_CASE");
    } catch (error) {
      throw new Error(`Could not persist the restart emergency Record for ${initial.caseId}: ${publicError(error)}`);
    }
    const authority = RECORD_COMMIT_AUTHORITIES.get(this);
    if (authority === undefined) throw new Error("Bone has no terminal signing authority");
    await this.config.repository.writeTerminalReceipt(initial.caseId, authority);
  }

  private async run(initial: CaseStatus, signal: AbortSignal): Promise<void> {
    const projectionBytes = Math.max(1, Math.min(
      512 * 1024,
      Math.floor(
        (initial.sealed.searchEnvelope.profile.resources.maxInputTokens * 2)
        / Math.max(1, initial.sealed.searchEnvelope.profile.resources.maxMindInvocations),
      ),
    ));
    const subjectProjection = await this.config.repository.projectSubjectText(initial.caseId, {
      maxFileBytes: Math.min(96 * 1024, projectionBytes),
      maxTotalBytes: projectionBytes,
      maxFiles: 256,
    });
    const subjectContexts = new Map<string, SubjectContext>();
    for (const mind of this.permittedMinds(initial)) {
      const capability = adapterCapabilitySnapshot(mind);
      const context = await this.config.repository.subjectContext(initial.caseId, capability.network);
      if (context) subjectContexts.set(capability.id, context);
    }
    const assayFrontier = this.sealedAssayFrontier;
    const experimentCapability = compileExperimentCapability(
      assayFrontier,
      initial.sealed.intentContract,
    );
    const state: RunState = {
      reflexMindRoundsUsed: 0,
      revisionWaves: 0,
      metabolicCheckpointOrdinal: 0,
      reproducedMetabolicSequences: new Set(),
      contributions: [],
      evidence: [],
      evidenceArtifactDigests: new Set(),
      evidenceArtifactBytes: 0,
      ...(assayFrontier === undefined ? {} : { assayFrontier }),
      assayFrontierSealed: assayFrontier !== undefined
        && boundAssayFrontierDigest(initial, this.config.repository) === assayFrontier.digest,
      experimentCapability,
      assayRuns: [],
      artifactDigests: new Set(),
      publicIdeaArtifacts: new Map(),
      assayUsage: emptyAssayUsage(),
      observerUsage: emptyAssayUsage(),
      assayArchive: new QualityDiversityArchive(assayFrontier?.archive ?? ASSAY_ARCHIVE_V1),
      mindBudget: this.liveBudgets.get(initial.caseId) ?? new SealedMindBudget(initial.sealed.searchEnvelope.profile.resources),
      subjectProjection,
      subjectContexts,
      candidateBlueprints: new Map(),
      verifiedAuthorityEdges: Object.freeze([]),
      verifiedOriginalSubjectEdges: Object.freeze([]),
    };
    let recordSigned = false;
    try {
      const remaining = JEVYR_STAGES.slice(JEVYR_STAGES.indexOf("self_scan"));
      for (const stage of remaining) {
        // Cancellation before signing invalidates work; a signed Record is
        // immutable and must still finish its nonsemantic terminal closure.
        if (!recordSigned) signal.throwIfAborted();
        // Signing commits immutable output. Close abort admission synchronously
        // before its first await so an accepted stop cannot race that commit.
        if (stage === "sign") this.abortClosed.add(initial.caseId);
        state.currentStage = stage;
        const entered = await this.stageEvent(initial, stage, "entered");
        const enteredLifecycle = stage === "sign" || stage === "memory_tribunal" || stage === "terminate"
          ? "crystallized"
          : "running";
        await this.persist(initial.caseId, enteredLifecycle, stage, "working", entered);

        if (stage === "self_scan") {
          await this.selfScan(initial, state, signal);
        } else if (stage === "interpret") {
          await this.publishSealedObligations(initial);
          const futureMinimum = 1 + postDivergeMindMinimum(this.reflexLoops, this.permittedMinds(initial).length);
          await this.runMinds(
            initial,
            state,
            stage,
            signal,
            0,
            mindCallAllowance(state.mindBudget.remaining().maxMindInvocations, futureMinimum),
            "later invention, recombination, challenge, and Reflex stages",
          );
        } else if (stage === "diverge") {
          await this.diverge(initial, state, signal);
        } else if (stage === "challenge") {
          await this.runMinds(
            initial,
            state,
            stage,
            signal,
            0,
            mindCallAllowance(state.mindBudget.remaining().maxMindInvocations, this.reflexLoops),
            "Reflex",
          );
        } else if (stage === "recombine") {
          await this.recallForRecombination(initial, state);
          await this.runMinds(
            initial,
            state,
            stage,
            signal,
            0,
            mindCallAllowance(state.mindBudget.remaining().maxMindInvocations, Math.max(1, Math.min(2, this.permittedMinds(initial).length)) + this.reflexLoops),
            "challenge and Reflex",
          );
        } else if (stage === "embody") {
          await this.embodyFrontier(initial, state, signal);
        } else if (stage === "assay") {
          await this.closeMetabolicInvestigation(initial, state);
          await this.assayFrontier(initial, state);
        } else if (stage === "reflex") {
          for (let loop = state.reflexMindRoundsUsed; loop < this.reflexLoops; loop += 1) {
            const laterLoops = this.reflexLoops - loop - 1;
            await this.runMinds(
              initial,
              state,
              stage,
              signal,
              loop,
              mindCallAllowance(state.mindBudget.remaining().maxMindInvocations, laterLoops),
              "later Reflex loops",
            );
          }
          await this.reflex(initial, state);
        } else if (stage === "crystallize") {
          await this.commitMemoryCandidate(initial, state);
          state.record = await this.crystallize(initial, state);
          await this.emit(initial, stage, "kernel.status", KERNEL, {
            operation: "record_crystallized",
            summary: "The deterministic kernel crystallized a canonical Record.",
            artifactDigest: digestJson(state.record as unknown as JsonValue),
          });
        } else if (stage === "sign") {
          if (!state.record) throw new Error("Record was not crystallized before sign");
          const authority = RECORD_COMMIT_AUTHORITIES.get(this);
          if (authority === undefined) throw new Error("Bone has no Record signing authority");
          const envelope = await this.config.repository.writeRecord(initial.caseId, state.record, authority);
          recordSigned = true;
          await this.emit(initial, stage, "kernel.status", KERNEL, {
            operation: "signed",
            summary: "The canonical Record was signed with the local Jevyr key.",
            artifactDigest: digestJson(envelope as unknown as JsonValue),
          });
        } else if (stage === "memory_tribunal") {
          await this.memoryTribunal(initial, state);
        } else if (stage === "terminate") {
          await this.emit(initial, stage, "kernel.status", KERNEL, {
            operation: "terminated",
            summary: "The case terminated. Its sealed input and signed Record are immutable.",
            ...(state.record === undefined ? {} : { artifactDigest: digestJson(state.record as unknown as JsonValue) }),
          });
          if (state.record !== undefined && state.stagedMemoryDigest !== undefined) {
            await this.reconcileTerminatingMemoryCase(
              initial,
              state.record,
              state.stagedMemoryDigest,
              true,
            );
          }
        }

        if (!recordSigned) signal.throwIfAborted();
        const completed = await this.stageEvent(initial, stage, "completed");
        const lifecycle = stage === "terminate" ? "terminated" : stage === "crystallize" || stage === "sign" || stage === "memory_tribunal" ? "crystallized" : "running";
        await this.persist(initial.caseId, lifecycle, stage, "completed", completed);
      }
    } catch (error) {
      await this.fail(initial, state, error);
    }
    const authority = RECORD_COMMIT_AUTHORITIES.get(this);
    if (authority === undefined) throw new Error("Bone has no terminal signing authority");
    await this.config.repository.writeTerminalReceipt(initial.caseId, authority);
  }

  private async enterAndComplete(
    status: CaseStatus,
    stage: JevyrStage,
    work: () => Promise<void>,
    lifecycle: CaseStatus["lifecycle"],
  ): Promise<CaseStatus> {
    const entered = await this.stageEvent(status, stage, "entered");
    await this.persist(status.caseId, lifecycle, stage, "working", entered);
    await work();
    const completed = await this.stageEvent(status, stage, "completed");
    return await this.persist(status.caseId, lifecycle, stage, "completed", completed);
  }

  private async publishSealedObligations(initial: CaseStatus): Promise<void> {
    for (const obligation of initial.sealed.intentContract.criticalObligations) {
      await this.emit(initial, "interpret", "claim.published", KERNEL, {
        claimId: obligation.id,
        statement: obligation.statement,
        claimType: "requirement",
        confidence: 1,
      });
    }
    for (const ambiguity of initial.sealed.intentContract.ambiguities) {
      await this.emit(initial, "interpret", "claim.published", KERNEL, {
        claimId: ambiguity.id,
        statement: ambiguity.summary,
        claimType: "interpretation",
        confidence: 1,
      });
    }
    for (const alternative of initial.sealed.intentContract.alternativeInterpretations) {
      await this.emit(initial, "interpret", "claim.published", KERNEL, {
        claimId: alternative.id,
        statement: alternative.statement,
        claimType: "interpretation",
      });
    }
  }

  private async selfScan(initial: CaseStatus, state: RunState, signal: AbortSignal): Promise<void> {
    const repositoryPlan = await this.config.repository.repositoryEvaluationPlan(initial.caseId);
    if (repositoryPlan) {
      const artifact = await this.config.repository.putArtifact(initial.caseId, "repository-evaluation-plan.json", "application/vnd.jevyr.repository-evaluation-plan+json", Buffer.from(canonicalize(repositoryPlan as unknown as JsonValue)));
      await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: artifact.digest, actionType: "investigation.repository-test-discovery", status: "completed",
        summary: `Inspected the sealed repository's test inventory: ${repositoryPlan.coverage.discoveredTestFiles} discovered files, ${repositoryPlan.coverage.plannedTestFiles} within the bounded static plan. This is discovery only; evaluator and dependency refusals remain explicit. No test result or new oracle is admitted.`, artifactDigests: [artifact.digest] });
    }
    if (state.subjectContexts.size > 0) {
      const body = { protocol: "jevyr.subject-context-catalogs/1", captureDigest: initial.sealed.subjectMaterialCaptureDigest, authority: "context-only", contexts: [...state.subjectContexts].sort(([left], [right]) => left.localeCompare(right)).map(([adapterId, context]) => ({ adapterId, descriptor: context.descriptor })) };
      const artifact = await this.config.repository.putArtifact(initial.caseId, "sealed-subject-contexts.json", "application/vnd.jevyr.subject-context-catalogs+json", Buffer.from(canonicalize(body as unknown as JsonValue)));
      await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: artifact.digest, actionType: "investigation.subject-context", status: "completed", summary: "Committed provider-scoped catalogs for bounded reads of immutable captured source. Catalog and text-classification limits are explicit; this is context availability, not executed evidence.", artifactDigests: [artifact.digest] });
    }
    if (this.metabolicReproductionPlan) {
      const trust = await this.config.repository.publicTrustBundle();
      const plan = await verifyMetabolicReproductionPlan(this.metabolicReproductionPlan, new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem])));
      if (initial.sealed.intent.control !== "juggler" || digestJson(plan.sourcePolicyDescriptor) !== initial.sealed.policyDigest) throw new Error("METABOLIC_REPRODUCTION_POLICY_CHANGED");
      const artifact = await this.config.repository.putArtifact(initial.caseId, "metabolic-reproduction.json", METABOLIC_REPRODUCTION_MEDIA_TYPE, Buffer.from(canonicalize(plan as unknown as JsonValue)));
      await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: plan.digest, actionType: "investigation.metabolic-reproduction", status: "completed", summary: `Authenticated source Record ${plan.sourceRecordDigest} supplies ${plan.checkpoints.length} logical grant checkpoints. Fresh signatures retain Juggler control; ${plan.seedMode === "same" ? "every semantic checkpoint must match" : "new seed rebinds ordered additions to their first eligible checkpoint within the original source stage, without reproducing its trajectory or timing"}. External added doses are closed.`, artifactDigests: [artifact.digest] });
    }
    if (state.subjectProjection.files.length > 0) {
      const index = await indexSealedCode(state.subjectProjection);
      const artifact = await this.config.repository.putArtifact(initial.caseId, "sealed-code-index.json", "application/vnd.jevyr.code-index+json", Buffer.from(canonicalize(index as unknown as JsonValue)));
      await this.emit(initial, "self_scan", "evidence.observed", KERNEL, {
        evidenceId: stableId("code-index", { runDigest: initial.sealed.runDigest }),
        evidenceType: "tool_observation",
        summary: `Tree-sitter indexed ${index.nodes.length} source nodes and ${index.dependencies.length} syntactic dependencies from ${index.files.length} sealed files; ${index.omissions.length} omissions. Attribution is not causation.`,
        contentDigest: artifact.digest,
      });
    }
    const adapters = [...this.admittedMinds, this.admittedForge, ...(this.admittedWitnesses?.adapters ?? [])];
    await Promise.all(
      adapters.map(async (adapter) => {
        const probe = await adapter.probe(signal);
        const capability = adapterCapabilitySnapshot(adapter);
        const actor = actorForCapability(capability);
        if (probe.available) {
          await this.emit(initial, "self_scan", "evidence.observed", actor, {
            evidenceId: stableId("probe", { runDigest: initial.sealed.runDigest, adapter: capability.id }),
            evidenceType: "tool_observation",
            summary: `${capability.displayName}: ${probe.detail}`,
            contentDigest: digestJson(probe as unknown as JsonValue),
          });
        } else {
          await this.emit(initial, "self_scan", "action.status", actor, {
            actionId: stableId("probe", { runDigest: initial.sealed.runDigest, adapter: capability.id }),
            actionType: "adapter.probe",
            status: "failed",
            summary: `${capability.displayName}: ${probe.detail}`,
          });
          if (capability.kind === "mind" || adapter === this.admittedForge) {
            await this.emit(initial, "self_scan", "action.status", KERNEL, {
              actionId: stableId("capability-failure", { runDigest: initial.sealed.runDigest, adapter: capability.id }),
              actionType: capability.kind === "mind" ? "integrity.provider_failure" : "integrity.sandbox_failure",
              status: "failed",
              summary: `The sealed ${capability.kind === "mind" ? "provider" : "sandbox"} capability is unavailable.`,
            });
          }
        }
      }),
    );
    if (!await this.evaluateOriginalSubject(initial, state, signal)) await this.observeRepositoryTests(initial, state, signal);
    await this.runQuarantinedWitnesses(initial, state, signal);
  }

  private async evaluateOriginalSubject(initial: CaseStatus, state: RunState, signal: AbortSignal): Promise<boolean> {
    const descriptor = this.config.repository.policyDescriptor;
    const kernelDigest = originalSubjectKernelDigestFromPolicyDescriptor(descriptor);
    if (!kernelDigest || initial.sealed.policyVersion !== "jevyr.bone/2") return false;
    try { deriveRepositoryPureAssertionContext(initial.sealed); } catch { return false; }
    const body = descriptor as { policy?: { repositoryPureAssertions?: { runner: import("./repository-pure-assertions.js").RepositoryPureAssertionInput["runner"]; limits: import("./repository-pure-assertions.js").RepositoryPureAssertionLimits } } };
    const factory = body.policy?.repositoryPureAssertions;
    const invocationId = stableId("original-subject", { runDigest: initial.sealed.runDigest });
    const deny = async (summary: string): Promise<true> => {
      await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: invocationId, actionType: ORIGINAL_SUBJECT_CERTIFICATE_ACTION, status: "denied", summary });
      const replay = await replayOriginalSubjectCertificates(await this.config.events.read(initial.caseId), descriptor, async () => undefined,
        await this.config.repository.originalSubjectEvidenceContext(initial.caseId));
      if (replay.problems.length) throw new Error("Original subject purpose failed authenticated preflight replay");
      if (replay.originalSubjectContext) state.originalSubjectContext = replay.originalSubjectContext;
      return true;
    };
    if (!factory) return await deny("No fixed evaluator for the original subject is bound to this execution policy. Its critical test obligation remains unproven.");
    const assets = this.config.originalSubjectAssets ?? await originalSubjectProducerAssets();
    const inputs = await this.config.repository.originalSubjectEvaluationInputs(initial.caseId);
    let reservation: ReturnType<typeof originalSubjectExecutionLimits>;
    try {
      reservation = originalSubjectExecutionLimits(initial.sealed, descriptor);
      // Validate bounded package construction before admitting physical work.
      // Unsupported or oversized captures produce no claim about their tests.
      await prepareRepositoryPureProducerPackage({ ...inputs, sealedCase: initial.sealed, runner: factory.runner, limits: factory.limits }, assets);
    } catch {
      return await deny("The original capture cannot fit the sealed fixed evaluator and its resource envelope. Its critical test obligation remains unproven.");
    }
    signal.throwIfAborted();
    await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: invocationId, actionType: ORIGINAL_SUBJECT_CERTIFICATE_ACTION, status: "started",
      toolId: factory.runner.capabilityId, summary: "Checking the complete supported original assertion set with the fixed evaluator in a network-denied Forge." });
    const stopHeartbeat = this.startHeartbeat(initial, "self_scan", "The fixed evaluator is checking the original captured assertions inside its bounded Forge.", factory.runner.capabilityId);
    let execution: Awaited<ReturnType<typeof executeRepositoryPureAssertions>>;
    try {
      execution = await executeRepositoryPureAssertions({ ...inputs, ...reservation, sealedCase: initial.sealed, policyDescriptor: descriptor, assets, forge: this.admittedForge, invocationId, signal });
    } finally { stopHeartbeat(); }
    const certificate = createOriginalSubjectCertificate({ sealedCase: initial.sealed, kernelDigest, execution });
    if (certificate.bytes.byteLength > reservation.resourceLimits.maxArtifactBytes) throw new Error("The original assertion certificate exceeded its sealed artifact reservation");
    const artifact = await this.config.repository.putArtifact(initial.caseId, `${invocationId}-certificate.json`, ORIGINAL_SUBJECT_CERTIFICATE_MEDIA, Buffer.from(certificate.bytes));
    if (artifact.digest !== certificate.digest || artifact.size !== certificate.bytes.byteLength) throw new Error("The original assertion certificate changed during persistence");
    const r = certificate.resources;
    const additionalBytes = state.artifactDigests.has(artifact.digest) ? 0 : artifact.size;
    state.artifactDigests.add(artifact.digest);
    for (const usage of [state.observerUsage, state.assayUsage]) {
      usage.forgeWallMillis += r.wallMillis; usage.artifactBytes += additionalBytes;
      usage.writableBytes += r.writableBytes; usage.writableInodes += r.writableInodes;
      usage.workspaceUnmeasured ||= r.workspaceMeasurement === "CONSERVATIVE_CEILING";
      usage.cpuUnmeasured ||= r.cpuMeasurement === "UNMEASURED";
      if (r.cpuMeasurement === "MEASURED" && r.cpuMillis !== null) { usage.cpuMeasurements++; usage.measuredForgeCpuMillis += r.cpuMillis; }
    }
    await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: invocationId, actionType: ORIGINAL_SUBJECT_CERTIFICATE_ACTION,
      status: execution.observation.status === "succeeded" ? "completed" : "failed", toolId: factory.runner.capabilityId, artifactDigests: [artifact.digest],
      resource: { wallMillis: r.wallMillis, bytesWritten: r.writableBytes, ...(r.cpuMeasurement === "MEASURED" && r.cpuMillis !== null ? { cpuMillis: r.cpuMillis } : {}) },
      summary: "Retained the original capture, fixed evaluator package and exact Forge output for independent certificate replay." });
    const context = { ...await this.config.repository.originalSubjectEvidenceContext(initial.caseId), assets };
    const physical = await replayRepositoryPureExecution({ ...inputs, ...context, policyDescriptor: descriptor, artifacts: execution.artifacts });
    if (!physical.authenticatedCase || !physical.consistent) {
      await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: stableId("original-subject-integrity", { invocationId }),
        actionType: "integrity.sandbox_failure", status: "failed", summary: "The original assertion execution failed independent physical replay and has no judgment authority." });
      throw new Error("Original assertion physical replay failed closed");
    }
    if (physical.outcome !== "unavailable") {
      const c = certificate.certificate;
      await this.emit(initial, "self_scan", "evidence.observed", KERNEL, { evidenceId: stableId("original-assertions", { invocationId, certificateDigest: artifact.digest }),
        evidenceType: "original_subject_assertions", summary: physical.outcome === "match" ? "Every assertion in the complete supported original test set matched." : "The complete supported original test set contains a rederived assertion mismatch.",
        contentDigest: artifact.digest, [physical.outcome === "match" ? "supports" : "refutes"]: [c.obligationId],
        originalSubject: { protocol: "jevyr.original-subject-assertion-binding/1", subjectId: c.subjectId, obligationId: c.obligationId,
          captureDigest: c.captureDigest, certificateDigest: artifact.digest, executionReceiptDigest: c.executionReceiptDigest, kernelDigest } });
    }
    const replay = await replayOriginalSubjectCertificates(await this.config.events.read(initial.caseId), descriptor,
      async digest => digest === artifact.digest ? (await this.config.repository.artifact(initial.caseId, artifact.id))?.data : undefined, context);
    if (replay.problems.length) throw new Error("Original assertion certificate event binding failed independent replay");
    state.verifiedOriginalSubjectEdges = replay.verifiedOriginalSubjectEdges;
    if (replay.originalSubjectContext) state.originalSubjectContext = replay.originalSubjectContext;
    state.contributions.push(Object.freeze({ id: stableId("original-assertion-context", { invocationId }), kind: "observation", tags: ["original-assertions", "fixed-evaluator"],
      summary: `The fixed original assertion evaluator returned ${physical.outcome}. Its retained certificate will be independently replayed before judgment.`,
      body: canonicalize({ outcome: physical.outcome, certificateDigest: artifact.digest }), evidenceRefs: [artifact.digest] }));
    return true;
  }

  private async observeRepositoryTests(initial: CaseStatus, state: RunState, signal: AbortSignal): Promise<void> {
    const policy = repositoryEvaluationObserverPolicyFromDescriptor(this.config.repository.policyDescriptor);
    const limits = this.effectiveAssayLimits(state);
    if (!policy || !limits) return;
    const inputs = await this.config.repository.repositoryEvaluationInputs(initial.caseId);
    if (!inputs) return;
    const selection = repositoryObserverSubjectSelection(inputs.plan, policy);
    if (selection.omittedSubjectIds.length) {
      await this.emit(initial, "self_scan", "action.status", KERNEL, {
        actionId: stableId("repository-observer-cap", { runDigest: initial.sealed.runDigest }), actionType: "repository-evaluation.selection", status: "denied",
        summary: `${selection.omittedSubjectIds.length} additional supported repositories exceed the sealed ${policy.maxSubjectsPerCase}-subject diagnostic limit. Their tests remain unobserved.`,
      });
    }
    for (const subjectId of selection.subjectIds) {
      signal.throwIfAborted();
      const invocationId = stableId("repository-observer", { runDigest: initial.sealed.runDigest, subjectId });
      const timeoutMs = Math.min(policy.timeoutMs, Math.max(0, limits.maxForgeWallMillis - state.assayUsage.forgeWallMillis));
      const resourceLimits = { maxWritableBytes: Math.max(0, limits.maxWritableBytes - state.assayUsage.writableBytes),
        maxWritableInodes: Math.max(0, limits.maxWritableInodes - state.assayUsage.writableInodes),
        maxArtifactBytes: Math.max(0, limits.maxArtifactBytes - state.assayUsage.artifactBytes) };
      if (timeoutMs < 100 || resourceLimits.maxWritableBytes < 1 || resourceLimits.maxWritableInodes < 1
        || resourceLimits.maxArtifactBytes < repositoryObserverMinimumArtifactBudget(inputs.plan)
        || limits.maxForgeCpuMillis === 0 || (state.assayUsage.cpuMeasurements > 0 && state.assayUsage.measuredForgeCpuMillis >= limits.maxForgeCpuMillis)) {
        await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: invocationId, actionType: "repository-evaluation.observe", status: "denied",
          summary: "The remaining sealed Forge resources cannot fit this repository diagnostic and its retained output. No suite was run or test result inferred." });
        continue;
      }
      await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: invocationId, actionType: "repository-evaluation.observe", status: "started",
        toolId: policy.runner.capabilityId, summary: "Running the supported original test closure in a disposable, network-denied Forge. Its report will be diagnostic context only." });
      const stopHeartbeat = this.startHeartbeat(initial, "self_scan", "The original repository test diagnostic is running inside its bounded Forge.", policy.runner.capabilityId);
      let result: Awaited<ReturnType<typeof observeRepositoryEvaluation>>;
      try {
        result = await observeRepositoryEvaluation({ ...inputs, sealedCase: initial.sealed, policyDescriptor: this.config.repository.policyDescriptor,
          subjectId, forge: this.admittedForge, invocationId, resourceLimits, timeoutMs, signal });
      } finally { stopHeartbeat(); }
      let additionalArtifactBytes = 0;
      const digests: string[] = [];
      for (const entry of result.artifacts) {
        const artifact = await this.config.repository.putArtifact(initial.caseId, `${invocationId}-${entry.name}`, entry.mediaType, Buffer.from(entry.bytes));
        if (artifact.digest !== entry.digest || artifact.size !== entry.bytes.byteLength || artifact.mediaType !== entry.mediaType) throw new Error("Repository observer artifact identity changed while retaining its receipt");
        digests.push(artifact.digest);
        if (!state.artifactDigests.has(artifact.digest)) { additionalArtifactBytes += artifact.size; state.artifactDigests.add(artifact.digest); }
      }
      const readings = result.resources;
      for (const usage of [state.observerUsage, state.assayUsage]) {
        usage.forgeWallMillis += readings.wallMillis;
        usage.artifactBytes += additionalArtifactBytes;
        usage.writableBytes += readings.writableBytes; usage.writableInodes += readings.writableInodes;
        usage.workspaceUnmeasured ||= readings.workspaceMeasurement === "CONSERVATIVE_CEILING";
        usage.cpuUnmeasured ||= readings.cpuMeasurement === "UNMEASURED";
        if (readings.cpuMeasurement === "MEASURED" && readings.cpuMillis !== null) { usage.cpuMeasurements++; usage.measuredForgeCpuMillis += readings.cpuMillis; }
      }
      await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: invocationId, actionType: "repository-evaluation.observe", status: result.observation.status === "succeeded" ? "completed" : "failed",
        toolId: policy.runner.capabilityId, artifactDigests: [...new Set(digests)].sort(), resource: { wallMillis: readings.wallMillis, bytesWritten: readings.writableBytes },
        summary: `Original test diagnostic: ${result.reportOutcome}; ${result.receipt.counts?.executedTests ?? 0} reported tests. The captured report has no verdict authority.` });
      const authority = result.observation.oracle ? verifyForgeExecutionAuthority(this.config.repository.policyDescriptor, result.observation.oracle) : undefined;
      const integrityFailure = forgeIntegrityFailure(result.observation, { builtInSandbox: true, adapterThrew: false, interrupted: signal.aborted,
        ...(authority?.verified === false ? { authorityProblem: authority.reason } : {}) });
      if (integrityFailure) await this.emit(initial, "self_scan", "action.status", KERNEL, { actionId: stableId("repository-observer-integrity", { invocationId }),
        actionType: integrityFailure, status: "failed", summary: "The admitted repository diagnostic lost its sealed execution boundary. Its report cannot establish source correctness." });
      // Counts and codes disclose no captured source or test names to a remote mind.
      // They are ordinary shared observations, never obligation support/refutation.
      state.contributions.push(Object.freeze({ id: stableId("repository-context", { invocationId }), kind: "observation", tags: ["repository-suite", "diagnostic-only"],
        summary: `An original repository suite diagnostic reported ${result.reportOutcome}. Independently investigate any apparent failure; this report does not prove correctness or a binding defect.`,
        body: canonicalize({ authority: "none", outcome: result.reportOutcome, counts: result.receipt.counts, problems: result.receipt.problems, planDigest: inputs.plan.digest } as unknown as JsonValue),
        evidenceRefs: [result.receipt.outerObservationDigest] }));
    }
  }

  private async runQuarantinedWitnesses(
    initial: CaseStatus,
    state: RunState,
    signal: AbortSignal,
  ): Promise<void> {
    const witnesses = this.admittedWitnesses;
    if (!witnesses || witnesses.calls.length === 0) return;
    const boundDigest = boundWitnessDescriptorDigest(initial, this.config.repository);
    if (boundDigest !== witnesses.descriptorDigest) {
      await this.emit(initial, "self_scan", "action.status", KERNEL, {
        actionId: stableId("witness-set", { runDigest: initial.sealed.runDigest, descriptorDigest: witnesses.descriptorDigest }),
        actionType: "quarantined-witness.execute",
        status: "denied",
        summary: "The witness set was not exactly bound into policy at Cast; no external call was executed.",
      });
      return;
    }
    const adapters = new Map(witnesses.adapters.map((adapter) => [adapterCapabilitySnapshot(adapter).id, adapter]));
    for (const call of [...witnesses.calls].sort((left, right) => left.id.localeCompare(right.id))) {
      const adapter = adapters.get(call.adapterId);
      if (!adapter) {
        await this.emit(initial, "self_scan", "action.status", KERNEL, {
          actionId: stableId("witness", { runDigest: initial.sealed.runDigest, callId: call.id }),
          actionType: "quarantined-witness.execute",
          status: "denied",
          summary: `Sealed witness call ${call.id} names an unavailable adapter; it was not executed.`,
        });
        continue;
      }
      const capability = adapterCapabilitySnapshot(adapter);
      if (initial.sealed.intent.privacy === "local_only" && !["none", "loopback"].includes(capability.network)) {
        await this.emit(initial, "self_scan", "action.status", actorForCapability(capability), {
          actionId: stableId("witness", { runDigest: initial.sealed.runDigest, callId: call.id }),
          actionType: call.tool,
          status: "denied",
          summary: `Sealed witness call ${call.id} was denied by the local-only privacy boundary.`,
          toolId: capability.id,
        });
        continue;
      }
      const invocation: ToolInvocation = {
        invocationId: stableId("witness", { runDigest: initial.sealed.runDigest, callId: call.id }),
        caseId: initial.caseId,
        tool: call.tool,
        args: call.args,
        timeoutMs: call.timeoutMs,
        signal,
      };
      await this.emit(initial, "self_scan", "action.status", actorForCapability(capability), {
        actionId: invocation.invocationId,
        actionType: invocation.tool,
        status: "started",
        summary: `Executing sealed quarantined witness call ${call.id}.`,
        toolId: capability.id,
      });
      const returnedObservation = await adapter.execute(invocation);
      const observation = canonicalObservation(returnedObservation, invocation.invocationId, "Witness");
      const observationContentDigest = await this.persistObservation(initial, state, observation);
      state.evidence.push(observation);
      const evidenceId = stableId("evidence", {
        runDigest: initial.sealed.runDigest,
        invocationId: observation.invocationId,
      });
      const excerpt = publicObservationExcerpt(observation.stdout ?? observation.stderr);
      const publicSummary = `${observation.summary}${excerpt === undefined ? "" : ` Public excerpt: ${excerpt}`}`;
      await this.emit(initial, "self_scan", "evidence.observed", actorForCapability(capability), {
        evidenceId,
        evidenceType: "tool_observation",
        summary: publicSummary,
        contentDigest: observationContentDigest,
      });
      await this.emit(initial, "self_scan", "action.status", actorForCapability(capability), {
        actionId: invocation.invocationId,
        actionType: invocation.tool,
        status: observation.status === "observed" || observation.status === "succeeded"
          ? "completed"
          : observation.status === "not-executed"
            ? "denied"
            : "failed",
        summary: observation.summary,
        toolId: capability.id,
      });
      state.contributions.push(Object.freeze({
        id: stableId("contrib", { runDigest: initial.sealed.runDigest, witnessCall: call.id, evidenceId }),
        kind: "observation",
        summary: `Quarantined witness ${call.id}: ${publicSummary}`,
        ...(observation.stdout === undefined ? {} : { body: observation.stdout.slice(0, 12_000) }),
        tags: Object.freeze([
          "quarantined-witness",
          "observation-only",
          "not-proof",
          capability.id,
        ]),
        evidenceRefs: Object.freeze([evidenceId]),
      }));
    }
  }

  private permittedMinds(initial: CaseStatus): readonly MindAdapter[] {
    return this.admittedMinds.filter((mind) => {
      if (initial.sealed.intent.privacy !== "local_only") return true;
      const network = adapterCapabilitySnapshot(mind).network;
      return network === "none" || network === "loopback";
    });
  }

  private async diverge(initial: CaseStatus, state: RunState, signal: AbortSignal): Promise<void> {
    const juggler = this.jugglerBooks.get(initial.caseId);
    const minds = this.permittedMinds(initial);
    if (minds.length === 0) throw new Error("No mind is permitted by the sealed privacy boundary");
    const fixedFacts = Object.freeze([...state.contributions]);
    const declaredMechanismLabels = new Set<string>();
    let scarCount = 0;
    const beforeNursery = state.mindBudget.snapshot();
    // Baseline nursery allocation is independent of when live additions arrive.
    const baselineMeter = new SealedMindBudget(state.mindBudget.envelope);
    baselineMeter.absorbNursery(beforeNursery);
    const remainingBeforeNursery = baselineMeter.remaining();
    const desiredDownstreamReserve = postDivergeMindMinimum(this.reflexLoops, minds.length);
    const downstreamCallReserve = Math.min(
      desiredDownstreamReserve,
      Math.max(0, remainingBeforeNursery.maxMindInvocations - 1),
    );
    const nurseryCallLimit = Math.max(
      0,
      remainingBeforeNursery.maxMindInvocations - downstreamCallReserve,
    );
    const nurseryResources = mindResourceEnvelopeForInvocations(
      remainingBeforeNursery,
      nurseryCallLimit,
    );
    const outcome = await runAdaptiveSearch({
      onInvestigation: async (adapterId, investigation) => {
        const body = { ...investigation, adapterId, runDigest: initial.sealed.runDigest };
        const artifact = await this.config.repository.putArtifact(initial.caseId, `model-investigation-${digestJson(body as unknown as JsonValue).slice(-24)}.json`, "application/vnd.jevyr.model-investigation+json", Buffer.from(canonicalize(body as unknown as JsonValue)));
        await this.emit(initial, "diverge", "action.status", KERNEL, { actionId: artifact.digest, actionType: "investigation.model-tool-loop", status: "completed", summary: `${adapterId} used ${investigation.providerRounds} metered provider rounds and ${investigation.tools.length} sealed-context inspections. Tool results grant no verdict authority.`, artifactDigests: [artifact.digest] });
      },
      ...(juggler ? { takePendingGrants: () => this.admitPendingMetabolic(initial, state, "diverge"),
        deferMetabolicClosure: revisionInvestigationEnabled(this.config.repository.policyDescriptor),
        onMetabolicEligibility: async (kinds: Parameters<LiveJugglerBook["setEligibleKinds"]>[0], quantities?: Parameters<LiveJugglerBook["setEligibleKinds"]>[1]) => { if (kinds.length === 0) await this.prepareMetabolicReproduction(initial, state, "diverge"); juggler.setEligibleKinds(kinds, quantities); },
        closeMetabolicAdmission: async () => { await this.prepareMetabolicReproduction(initial, state, "diverge"); await juggler.closeAdmission(); } } : {}),
      sealed: initial.sealed,
      ...(state.phenotype ? { phenotype: state.phenotype } : {}),
      minds,
      publicFacts: fixedFacts,
      experimentCapability: state.experimentCapability,
      signal,
      resources: nurseryResources,
      sealedForMind: () => this.sanitizedSeal(initial.sealed),
      subjectProjectionForMind: (mind) => this.subjectProjectionForMind(initial, state, mind),
      subjectContextForMind: (mind) => state.subjectContexts.get(adapterCapabilitySnapshot(mind).id),
      onProviderFailure: async (adapterId, investigation) => {
        await this.persistInvestigationFailure(initial, "diverge", adapterId, investigation);
        await this.emit(initial, "diverge", "action.status", KERNEL, {
          actionId: stableId("provider-failure", { runDigest: initial.sealed.runDigest, adapterId }),
          actionType: "integrity.provider_failure", status: "failed", summary: `Sealed investigator ${adapterId} failed to supply an admissible contribution.`,
        });
      },
      observe: async (observation) => {
        if (observation.audit) {
          await this.emit(initial, "diverge", "evidence.observed", KERNEL, {
            evidenceId: stableId("lineage-audit", { runDigest: initial.sealed.runDigest, ordinal: observation.ordinal, specimen: observation.specimenId ?? null }),
            evidenceType: "tool_observation", summary: "Runtime observed a lineage commitment and its exact information exposure; provider seed enforcement remains explicitly classified.",
            contentDigest: digestJson(observation.audit as unknown as JsonValue), audit: observation.audit,
          });
        }
        if (observation.type === "hypothesis.scarred") scarCount += 1;
        for (const label of observation.contribution?.tags ?? []) declaredMechanismLabels.add(label);
        if (observation.type === "hypothesis.admitted" && observation.specimenId && observation.admittedContribution) {
          const publicIdeaDigest = await this.persistPublicIdea(
            initial,
            state,
            observation.specimenId,
            observation.admittedContribution,
          );
          await this.emit(initial, "diverge", "candidate.status", observation.source ? actorForCapability(observation.source) : NURSERY, {
            candidateId: observation.specimenId,
            status: "proposed",
            summary: `${observation.admittedContribution.summary} [untrusted nursery hypothesis; not assayed]`,
            artifactDigests: [publicIdeaDigest],
          });
        }
        const status = observation.type === "nursery.completed"
          ? "completed"
          : observation.type === "hypothesis.admitted"
            ? "hypothesis_admitted"
            : observation.type === "attempt.started" && observation.attempted === 0
              ? "started"
              : "exploring";
        await this.emit(initial, "diverge", "search.status", NURSERY, {
          layer: "HYPOTHESIS_NURSERY",
          status,
          attempted: observation.attempted,
          attemptSafetyCeiling: initial.sealed.searchEnvelope.profile.attemptSafetyCeiling,
          resources: searchResourceTelemetry(state.mindBudget.effectiveEnvelope(), {
            mindInvocations: { used: beforeNursery.mindInvocations + observation.resources.mindInvocations },
            inputTokens: {
              used: beforeNursery.inputTokens + observation.resources.inputTokens,
              measurement: beforeNursery.inputTokenMeasurement === "UPPER_BOUND"
                || observation.resources.inputTokenMeasurement === "UPPER_BOUND" ? "UPPER_BOUND" : "MEASURED",
            },
            outputTokens: {
              used: beforeNursery.outputTokens + observation.resources.outputTokens,
              measurement: beforeNursery.outputTokenMeasurement === "UPPER_BOUND"
                || observation.resources.outputTokenMeasurement === "UPPER_BOUND" ? "UPPER_BOUND" : "MEASURED",
            },
            wallMillis: { used: beforeNursery.wallMillis + observation.resources.wallMillis },
            generatedBytes: { used: beforeNursery.generatedBytes + observation.resources.generatedBytes },
            concurrentLineages: { used: 1 },
          }),
          hypothesisNursery: {
            exactDistinctHypotheses: observation.nurserySize,
            scars: scarCount,
            declaredMechanismLabels: [...declaredMechanismLabels].sort(),
            exactYieldAge: observation.exactYieldAge,
          },
          ...(observation.termination === undefined ? {} : { termination: observation.termination }),
          summary: `${observation.publicSummary} DIVERGE received ${nurseryCallLimit} Mind call${nurseryCallLimit === 1 ? "" : "s"}; ${downstreamCallReserve} remain reserved for recombination, challenge, and Reflex. Case-wide calls ${beforeNursery.mindInvocations + observation.resources.mindInvocations}; wall ${beforeNursery.wallMillis + observation.resources.wallMillis} ms; public bytes ${beforeNursery.generatedBytes + observation.resources.generatedBytes}. Nursery admission grants zero evidentiary authority.`,
        });
      },
    });
    state.mindBudget.absorbNursery(outcome.nursery.resources);
    state.nursery = outcome;
    for (const hypothesis of outcome.hypotheses) {
      const admitted = await this.admitCandidateBlueprint(initial, state, "diverge", hypothesis);
      const publicIdeaDigest = state.publicIdeaArtifacts.get(admitted.id);
      if (publicIdeaDigest === undefined) {
        throw new Error(`Nursery candidate ${admitted.id} has no persisted public idea`);
      }
      const blueprint = state.candidateBlueprints.get(admitted.id);
      await this.emit(initial, "diverge", "candidate.status", NURSERY, {
        candidateId: admitted.id,
        status: "proposed",
        summary: blueprint === undefined
          ? `${admitted.summary} [genealogy disclosed; still unassayed]`
          : `${admitted.summary} [finite blueprint ${blueprint.blueprint.blueprintDigest}; still unassayed]`,
        ...(admitted.feasibility === undefined ? {} : { feasibility: admitted.feasibility }),
        parentIds: admitted.parentIds ?? [],
        artifactDigests: [
          publicIdeaDigest,
          ...(blueprint === undefined ? [] : [blueprint.blueprint.blueprintDigest, blueprint.artifactDigest]),
        ].sort(),
      });
      state.contributions.push(admitted);
    }
  }

  private async runMinds(
    initial: CaseStatus,
    state: RunState,
    stage: MindRequest["stage"],
    signal: AbortSignal,
    loop: number,
    maxInvocations?: number,
    reservationReason = "later Mind stages",
    revision?: RevisionInvocationContext,
  ): Promise<void> {
    const definition = MIND_STAGES.get(stage);
    if (!definition) return;
    const frozenFacts = [...state.contributions];
    const eventStage: JevyrStage = revision ? "embody" : stage;
    if (!state.phenotype) {
      state.phenotype = germinatePhenotype(initial.sealed, this.permittedMinds(initial).map(adapterCapabilitySnapshot), state.assayFrontier?.assays.map(assayFamily) ?? []);
      const artifact = await this.config.repository.putArtifact(initial.caseId, "phenotype.json", "application/vnd.jevyr.phenotype+json", Buffer.from(canonicalize(state.phenotype as unknown as JsonValue)));
      await this.emit(initial, eventStage, "action.status", KERNEL, { actionId: state.phenotype.digest, actionType: "investigation.phenotype", status: "completed", summary: `Committed ${state.phenotype.temperament} temperament, ${state.phenotype.roster.length} investigators, ${state.phenotype.isolation.blindLineages} blind lanes and the evidence-value scheduler configuration. These choices govern methods only.`, artifactDigests: [artifact.digest] });
    }
    let permitted = phenotypeOrder(this.permittedMinds(initial), state.phenotype.roster, mind => adapterCapabilitySnapshot(mind).id);
    const invocationLimit = maxInvocations === undefined
      ? permitted.length
      : Math.max(0, Math.min(permitted.length, Math.trunc(maxInvocations)));
    const candidateOrigins = new Map<string, string>();
    if (stage === "challenge") {
      for (const event of await this.config.events.read(initial.caseId)) {
        if (event.kind === "candidate.status" && event.actor.kind === "mind" && !candidateOrigins.has(event.payload.candidateId)) candidateOrigins.set(event.payload.candidateId, event.actor.id);
      }
    }
    const challenge = stage === "challenge" ? routeCriticalChallenges(initial.sealed.intentContract, permitted.map(adapterCapabilitySnapshot), candidateOrigins, invocationLimit) : undefined;
    if (challenge) {
      permitted = phenotypeOrder(permitted, challenge.assignments.map(assignment => assignment.adapterId), mind => adapterCapabilitySnapshot(mind).id);
      const artifact = await this.config.repository.putArtifact(initial.caseId, `critical-challenge-${loop}.json`, "application/vnd.jevyr.critical-challenge+json", Buffer.from(canonicalize(challenge as unknown as JsonValue)));
      await this.emit(initial, eventStage, "action.status", KERNEL, { actionId: challenge.digest, actionType: "investigation.critical-challenge", status: "completed", summary: `Allocated ${challenge.coverage.length} critical obligations across ${challenge.assignments.length} investigators. ${challenge.limitations.join(" ")}`, artifactDigests: [artifact.digest] });
    }
    let invoked = 0;
    for (const mind of permitted) {
      const capability = adapterCapabilitySnapshot(mind);
      const actionId = stableId("mind", { runDigest: initial.sealed.runDigest, stage, loop, adapter: capability.id, ...(revision?.receiptDigest ? { receiptDigest: revision.receiptDigest, parent: revision.parentCandidateIds[0] } : {}) });
      if (invoked >= invocationLimit) {
        await this.emit(initial, eventStage, "action.status", actorFor(mind), {
          actionId,
          actionType: "mind.contribute",
          status: "denied",
          summary: `${capability.displayName} was not invoked: the remaining sealed Mind calls are reserved for ${reservationReason}.`,
        });
        continue;
      }
      const sealed = this.sanitizedSeal(initial.sealed);
      const totalRemaining = state.mindBudget.remaining();
      const remaining = revision?.resourceCeiling ? Object.freeze({ ...totalRemaining, ...Object.fromEntries(Object.entries(totalRemaining).map(([key, value]) => [key, Math.min(value, revision.resourceCeiling?.[key as keyof typeof revision.resourceCeiling] ?? value)])) }) : totalRemaining;
      const outputTokenUpperBound = mindInvocationOutputReservation(remaining);
      const timeoutMs = Math.max(1, Math.min(remaining.maxSingleInvocationMillis, remaining.maxWallMillis));
      const invocationSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const subjectProjection = this.subjectProjectionForMind(initial, state, mind);
      const baseDraft: MindRequest = {
        ...(revision ? { revision: { round: revision.round, contextDigest: revision.feedback.contextDigest, parentCandidateIds: revision.parentCandidateIds } } : {}),
        ...(revision && !(initial.sealed.intent.privacy === "provider_scoped" && ["provider", "unrestricted"].includes(capability.network)) ? { revisionSources: revision.parentCandidateIds.map(candidateId => ({ candidateId, blueprintDigest: state.candidateBlueprints.get(candidateId)!.blueprint.blueprintDigest, files: state.candidateBlueprints.get(candidateId)!.blueprint.files })) } : {}),
        ...(capability.limits?.adapterClass === "model" ? { investigationTools: true } : {}),
        stage,
        role: definition.role,
        sealed,
        publicFacts: [...frozenFacts, ...((revision || stage === "reflex") ? executionFeedbackFacts(revision?.feedback ?? executionFeedback(this.feedbackInputs(state)), revision?.inputs ?? this.feedbackInputs(state), !(initial.sealed.intent.privacy === "provider_scoped" && ["provider", "unrestricted"].includes(capability.network))) : [])],
        experimentCapability: state.experimentCapability,
        seed: initial.sealed.searchEnvelope.profile.seedDerivation === "sha256-case-seed-frontier-v2"
          ? investigationSeed(initial.sealed, "mind", [stage, loop, capability.id])
          : sha256(`${initial.sealed.runDigest}:${stage}:${loop}:${capability.id}`),
        constraints: [...initial.sealed.intent.constraints, ...definition.constraints, ...(challenge ? [`Inspect every assigned critical obligation and actively seek a counterexample. Assignment: ${JSON.stringify(challenge.assignments.find(assignment => assignment.adapterId === capability.id))}. Each result must cite the obligation ID, the inspected candidate IDs and a discriminating test from the sealed experiment templates. Report missing access or evidence; do not invent a reproduction.`] : [])],
        ...(subjectProjection === undefined ? {} : { subjectProjection }),
        ...(state.subjectContexts.has(capability.id) ? { subjectContext: state.subjectContexts.get(capability.id)! } : {}),
        maxInputTokens: remaining.maxInputTokens,
        maxOutputTokens: outputTokenUpperBound,
        signal: invocationSignal,
      };
      const draft = revision ? buildExecutionRevisionRequest(baseDraft, revision, revision.parentCandidateIds.map(candidateId => ({ candidateId, blueprintDigest: state.candidateBlueprints.get(candidateId)!.blueprint.blueprintDigest, files: state.candidateBlueprints.get(candidateId)!.blueprint.files })), capability.network) : baseDraft;
      const prompt = makePublicMindPrompt(draft);
      const inputUpperBound = utf8Bytes(prompt);
      const refusal = state.mindBudget.refusal(inputUpperBound) ?? (inputUpperBound > remaining.maxInputTokens ? "the signed additive input allowance cannot fit this context" : undefined);
      if (refusal) {
        await this.emit(initial, eventStage, "action.status", actorFor(mind), {
          actionId,
          actionType: "mind.contribute",
          status: "denied",
          summary: `${capability.displayName} was not invoked: ${refusal}.`,
        });
        continue;
      }
      invoked += 1;
      const request = Object.freeze({ ...draft, preparedPublicPrompt: prompt });
      await this.emit(initial, eventStage, "action.status", actorFor(mind), {
        actionId,
        actionType: "mind.contribute",
        status: "started",
        summary: `${capability.displayName} entered the remaining sealed Mind envelope.`,
      });
      const stopHeartbeat = this.startHeartbeat(
        initial,
        eventStage,
        `${capability.displayName} is still producing a sealed public contribution.`,
        capability.id,
      );
      const started = performance.now();
      try {
        const revisionResult = revision ? await invokeExecutionRevision(mind, request) : undefined;
        const result = revisionResult?.result ?? await invokeMindMetered(mind, request);
        const wallMillis = Math.max(0, Math.ceil(performance.now() - started));
        const admitted = state.mindBudget.charge(result, wallMillis, outputTokenUpperBound)
          && result.receivedOutputBytes <= remaining.maxGeneratedBytes && result.tokenUsage.input.tokens <= remaining.maxInputTokens && wallMillis <= remaining.maxWallMillis;
        if (!admitted) {
          await this.emit(initial, eventStage, "action.status", actorFor(mind), {
            actionId,
            actionType: "mind.contribute",
            status: "denied",
            summary: `${capability.displayName} crossed the sealed Case-wide Mind envelope; its contributions were not admitted.`,
            resource: { wallMillis, bytesRead: result.transmittedInputBytes, bytesWritten: result.receivedOutputBytes },
          });
          continue;
        }
        if (revisionResult?.admissionProblem) await this.emit(initial, eventStage, "action.status", KERNEL, { actionId: stableId("revision-admission", { actionId }), actionType: "candidate.revision.admission", status: "denied", summary: revisionResult.admissionProblem });
        if (result.investigation) {
          const body = { ...result.investigation, adapterId: capability.id, runDigest: initial.sealed.runDigest, stage, loop };
          const artifact = await this.config.repository.putArtifact(initial.caseId, `model-investigation-${digestJson(body as unknown as JsonValue).slice(-24)}.json`, "application/vnd.jevyr.model-investigation+json", Buffer.from(canonicalize(body as unknown as JsonValue)));
          await this.emit(initial, eventStage, "action.status", KERNEL, { actionId: artifact.digest, actionType: "investigation.model-tool-loop", status: "completed", summary: `${capability.id} used ${result.investigation.providerRounds} metered provider rounds and ${result.investigation.tools.length} sealed-context inspections. Tool results grant no verdict authority.`, artifactDigests: [artifact.digest] });
        }
        let revisionCandidateSeen = false;
        for (const item of result.contributions) {
          if (revision && item.kind === "candidate") {
            if (revisionCandidateSeen || item.parentIds?.length !== 1 || !revision.parentCandidateIds.includes(item.parentIds[0]!) || state.candidateBlueprints.has(item.id)) {
              await this.emit(initial, eventStage, "action.status", KERNEL, { actionId: stableId("revision-denied", { runDigest: initial.sealed.runDigest, loop, candidateId: item.id }), actionType: "candidate.revision.admission", status: "denied", summary: "Revision exceeded one new candidate or did not name its permitted committed parent." });
              continue;
            }
            revisionCandidateSeen = true;
          }
          if (item.kind === "candidate") {
            await this.persistPublicIdea(initial, state, item.id, item);
          }
          const admitted = await this.admitCandidateBlueprint(initial, state, eventStage, item);
          await this.emitContribution(initial, state, eventStage, mind, admitted);
          state.contributions.push(admitted);
        }
        await this.emit(initial, eventStage, "action.status", actorFor(mind), {
          actionId,
          actionType: "mind.contribute",
          status: "completed",
          summary: `${capability.displayName} produced ${result.contributions.length} public contribution${result.contributions.length === 1 ? "" : "s"} inside the sealed Case-wide budget.`,
          resource: { wallMillis, bytesRead: result.transmittedInputBytes, bytesWritten: result.receivedOutputBytes },
        });
      } catch (error) {
        const wallMillis = Math.max(0, Math.ceil(performance.now() - started));
        await this.persistInvestigationFailure(initial, eventStage, capability.id, mindFailureInvestigation(error));
        await this.emit(initial, eventStage, "action.status", KERNEL, {
          actionId: `${actionId}_integrity`, actionType: "integrity.provider_failure", status: "failed",
          summary: `Sealed investigator ${capability.id} failed to supply an admissible contribution.`,
        });
        state.mindBudget.chargeFailure(
          mindFailureInputUpperBound(error, inputUpperBound),
          outputTokenUpperBound,
          wallMillis,
        );
        await this.emit(initial, eventStage, "action.status", actorFor(mind), {
          actionId,
          actionType: "mind.contribute",
          status: "failed",
          summary: `${capability.displayName} produced no admissible contribution: ${publicError(error)}`,
          resource: { wallMillis, bytesRead: mindFailureInputUpperBound(error, inputUpperBound) },
        });
        if (signal.aborted) throw error;
      } finally {
        await stopHeartbeat();
      }
    }
  }

  private async persistInvestigationFailure(initial: CaseStatus, stage: JevyrStage, adapterId: string, investigation: ModelInvestigationFailure | undefined): Promise<void> {
    if (!investigation) return;
    const body = { ...investigation, adapterId, runDigest: initial.sealed.runDigest, stage };
    const artifact = await this.config.repository.putArtifact(initial.caseId, `model-investigation-failure-${digestJson(body as unknown as JsonValue).slice(-24)}.json`, "application/vnd.jevyr.model-investigation-failure+json", Buffer.from(canonicalize(body as unknown as JsonValue)));
    await this.emit(initial, stage, "action.status", KERNEL, { actionId: artifact.digest, actionType: "investigation.model-tool-loop", status: "failed", summary: `${adapterId} stopped at ${investigation.boundary} after ${investigation.providerRounds} provider rounds and ${investigation.tools.length} recorded context calls. Digest-only receipts retain diagnostic context; they grant no verdict authority.`, artifactDigests: [artifact.digest] });
  }

  private sanitizedSeal(sealed: SealedCaseContext): SealedCaseContext {
    const snapshots = new Map(sealed.subjects.map((snapshot) => [snapshot.subjectId, snapshot.digest]));
    return {
      ...sealed,
      intent: {
        ...sealed.intent,
        subjects: sealed.intent.subjects.map((subject) => ({
          ...subject,
          locator: `jevyr:sealed-subject:${subject.id}@${snapshots.get(subject.id) ?? "unavailable"}`,
        })),
      },
      subjects: sealed.subjects.map((snapshot) => ({
        ...snapshot,
        resolvedLocator: `jevyr:sealed-subject:${snapshot.subjectId}`,
      })),
    };
  }

  private subjectProjectionForMind(
    initial: CaseStatus,
    state: RunState,
    mind: MindAdapter,
  ): SubjectTextProjection | undefined {
    const network = adapterCapabilitySnapshot(mind).network;
    const remote = network === "provider" || network === "unrestricted";
    return initial.sealed.intent.privacy === "provider_scoped" && remote
      ? undefined
      : state.subjectProjection;
  }

  private async admitCandidateBlueprint(
    initial: CaseStatus,
    state: RunState,
    stage: JevyrStage,
    contribution: PublicContribution,
  ): Promise<PublicContribution> {
    if (contribution.candidateBlueprintSource === undefined) return contribution;
    const { candidateBlueprintSource, ...withoutSource } = contribution;
    const actionId = stableId("blueprint", {
      runDigest: initial.sealed.runDigest,
      candidateId: contribution.id,
      source: candidateBlueprintSource,
    });
    const reject = async (reason: string, code = "policy"): Promise<PublicContribution> => {
      await this.emit(initial, stage, "action.status", KERNEL, {
        actionId,
        actionType: "candidate.blueprint.compile",
        status: "denied",
        summary: `Candidate ${contribution.id} retained only as an abstract hypothesis; its blueprint was refused: ${reason}`,
      });
      return Object.freeze({
        ...withoutSource,
        tags: Object.freeze([...new Set([...(contribution.tags ?? []), "blueprint-refused", `blueprint-refusal:${code}`])]),
      });
    };

    if (stage !== "diverge" && !(stage === "embody" && revisionInvestigationEnabled(this.config.repository.policyDescriptor))) {
      return await reject("the finite assay population closed when DIVERGE completed", "late-population-mutation");
    }

    const ignorePolicy = this.config.candidateIgnorePolicy;
    if (!ignorePolicy
      || boundCandidateIgnorePolicyDigest(initial, this.config.repository) !== ignorePolicy.sourceDigest) {
      return await reject("no exact output-path policy was bound into this Case at Seal", "unbound-policy");
    }
    const resources = state.mindBudget.effectiveEnvelope();
    const physicalBytes = Math.min(
      resources.maxGeneratedBytes,
      resources.maxWritableBytes,
      resources.maxArtifactBytes,
    );
    if (resources.maxWritableInodes < 1 || physicalBytes < 1) {
      return await reject("the sealed writable resource envelope grants no files or bytes", "resource-denied");
    }
    try {
      const blueprint = compileCandidateBlueprint(candidateBlueprintSource, ignorePolicy, {
        maxFiles: Math.min(256, resources.maxWritableInodes),
        maxFileBytes: Math.min(1_000_000, physicalBytes),
        maxTotalBytes: Math.min(8_000_000, physicalBytes),
      });
      if (stage === "embody") {
        const parent = contribution.parentIds?.length === 1 ? state.candidateBlueprints.get(contribution.parentIds[0]!) : undefined;
        if (!parent || parent.blueprint.blueprintDigest === blueprint.blueprintDigest) return await reject("a revision must change one existing parent blueprint", "invalid-revision-parent");
      }
      const experimentReadiness = candidateExperimentReadiness(blueprint, state.experimentCapability);
      const experimentTags = experimentReadiness.ready
        ? ["experiment-ready", ...experimentReadiness.experimentIds.map((assayId) => `experiment:${assayId}`)]
        : ["experiment-unready", ...experimentReadiness.problems.map((problem) => `experiment-readiness:${problem}`)];
      const bytes = Buffer.from(canonicalize(blueprint as unknown as JsonValue), "utf8");
      if (bytes.byteLength > physicalBytes) {
        return await reject("the canonical blueprint artifact exceeds the sealed byte envelope", "resource-denied");
      }
      const existing = state.candidateBlueprints.get(contribution.id);
      if (existing !== undefined) {
        if (existing.blueprint.blueprintDigest !== blueprint.blueprintDigest) {
          return await reject("the candidate id is already bound to a different finite blueprint", "candidate-id-conflict");
        }
        return Object.freeze({
          ...withoutSource,
          blueprintDigest: existing.blueprint.blueprintDigest,
          tags: Object.freeze([...new Set([
            ...(contribution.tags ?? []),
            "finite-blueprint",
            "proposal-only",
            ...experimentTags,
          ])]),
        });
      }
      const blueprintArtifactDigest = `sha256:${sha256(bytes)}`;
      const additionalArtifactBytes = state.artifactDigests.has(blueprintArtifactDigest) ? 0 : bytes.byteLength;
      if (state.assayUsage.artifactBytes + additionalArtifactBytes > resources.maxArtifactBytes) {
        return await reject("the case-wide sealed artifact envelope is exhausted", "resource-denied");
      }
      const artifact = await this.config.repository.putArtifact(
        initial.caseId,
        `candidate-blueprint-${contribution.id}.json`,
        "application/vnd.jevyr.candidate-blueprint+json",
        bytes,
      );
      state.candidateBlueprints.set(contribution.id, Object.freeze({
        blueprint,
        artifactDigest: artifact.digest,
      }));
      state.artifactDigests.add(artifact.digest);
      state.assayUsage.artifactBytes += additionalArtifactBytes;
      await this.emit(initial, stage, "action.status", KERNEL, {
        actionId,
        actionType: "candidate.blueprint.compile",
        status: "completed",
        summary: `Candidate ${contribution.id} was reduced to a finite authority-free blueprint; it remains an untested proposal.`,
        artifactDigests: [blueprint.blueprintDigest, artifact.digest].sort(),
        resource: { bytesWritten: bytes.byteLength },
      });
      return Object.freeze({
        ...withoutSource,
        blueprintDigest: blueprint.blueprintDigest,
        tags: Object.freeze([...new Set([
          ...(contribution.tags ?? []),
          "finite-blueprint",
          "proposal-only",
          ...experimentTags,
        ])]),
      });
    } catch (error) {
      const code = error instanceof CandidateBlueprintError ? error.code : "invalid";
      return await reject(publicError(error), code);
    }
  }

  private async emitContribution(
    initial: CaseStatus,
    state: RunState,
    stage: JevyrStage,
    mind: MindAdapter,
    contribution: PublicContribution,
  ): Promise<void> {
    const actor = actorFor(mind);
    if (contribution.kind === "candidate") {
      const publicIdeaDigest = state.publicIdeaArtifacts.get(contribution.id);
      if (publicIdeaDigest === undefined) {
        throw new Error(`Candidate ${contribution.id} has no persisted public idea`);
      }
      const blueprint = state.candidateBlueprints.get(contribution.id);
      await this.emit(initial, stage, "candidate.status", actor, {
        candidateId: contribution.id,
        status: "proposed",
        summary: contribution.summary,
        ...(contribution.feasibility === undefined ? {} : { feasibility: contribution.feasibility }),
        ...(contribution.parentIds === undefined ? {} : { parentIds: contribution.parentIds }),
        artifactDigests: [
          publicIdeaDigest,
          ...(blueprint === undefined ? [] : [blueprint.blueprint.blueprintDigest, blueprint.artifactDigest]),
        ].sort(),
      });
      return;
    }
    if (contribution.kind === "observation") {
      await this.emit(initial, stage, "evidence.observed", actor, {
        evidenceId: contribution.id,
        evidenceType: "model_report",
        summary: contribution.summary,
        contentDigest: digestJson(contribution as unknown as JsonValue),
      });
      return;
    }
    const claimType = contribution.kind === "interpretation"
      ? "interpretation"
      : contribution.kind === "challenge" || contribution.kind === "reflex"
        ? "risk"
        : contribution.kind === "test-plan"
          ? "prediction"
          : "mechanism";
    await this.emit(initial, stage, "claim.published", actor, {
      claimId: contribution.id,
      statement: contribution.summary,
      claimType,
      ...(contribution.confidence === undefined ? {} : { confidence: contribution.confidence }),
      ...(contribution.parentIds?.length === 1 ? { candidateId: contribution.parentIds[0] } : {}),
    });
  }

  private async recallForRecombination(initial: CaseStatus, state: RunState): Promise<void> {
    const memory = this.config.memory;
    const projectId = this.config.memoryProjectId;
    const memorySeconds = initial.sealed.searchEnvelope.profile.resources.maxMemorySeconds;
    const recallLimit = this.runtimeGrowthPolicy?.lateMemory.recallLimit ?? 12;
    const maximumWeight = this.runtimeGrowthPolicy?.lateMemory.maximumWeight ?? 0.2;
    const started = performance.now();
    const recalled = !memory || !projectId || memorySeconds <= 0 || recallLimit === 0 || maximumWeight === 0 ? [] : memory.retrieve({
      projectId,
      caseDigest: initial.sealed.caseDigest,
      stage: "recombine",
      intentContractDigest: initial.sealed.intentContractDigest,
      subjectMaterialCaptureDigest: initial.sealed.subjectMaterialCaptureDigest,
      limit: recallLimit,
      includeSelfArchive: this.config.includeSelfMemory === true,
    });
    const influences = lateMemoryInfluences(recalled, maximumWeight);
    const guard = this.config.reproductionMemoryGuard;
    if (guard) {
      const trust = await this.config.repository.publicTrustBundle();
      const verified = verifyReproductionMemoryGuard(guard, new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem])));
      const matches = reproductionMemoryMatches(verified, influences);
      const comparison = { protocol: "jevyr.reproduction-memory/1", runDigest: initial.sealed.runDigest,
        source: verified, observedInfluences: influences, matches, authority: "comparison-only" };
      const artifact = await this.config.repository.putArtifact(initial.caseId, "reproduction-memory.json", REPRODUCTION_MEMORY_MEDIA_TYPE, Buffer.from(canonicalize(comparison as unknown as JsonValue)));
      await this.emit(initial, "recombine", "action.status", KERNEL, { actionId: artifact.digest, actionType: "investigation.reproduction-memory", status: matches ? "completed" : "failed",
        summary: matches ? `Current admitted memory exactly matches source signed Record ${verified.sourceRecordDigest}.` : `Current admitted memory differs from source signed Record ${verified.sourceRecordDigest}; the controlled rerun is invalid.`, artifactDigests: [artifact.digest] });
      if (!matches) throw new Error("REPRODUCTION_MEMORY_CHANGED: current admitted hints differ from the source signed Record");
    }
    for (const item of influences) {
      if (performance.now() - started > memorySeconds * 1_000) {
        if (guard) throw new Error("REPRODUCTION_MEMORY_INCOMPLETE: the sealed memory deadline prevented the complete matching recall");
        break;
      }
      const { weight, summary } = item;
      state.contributions.push({
        id: stableId("memory-hint", { caseDigest: initial.sealed.caseDigest, memoryDigest: item.memoryDigest }),
        kind: "observation",
        summary,
        tags: ["admitted-memory", "not-evidence", `memory:${item.memoryDigest}`],
      });
      const observedAt = new Date().toISOString();
      memory!.recordInfluence({
        caseDigest: initial.sealed.caseDigest,
        memoryDigest: item.memoryDigest,
        stage: "recombine",
        weight,
        influence: item.influence,
        summary,
        observedAt,
      });
      await this.emit(initial, "recombine", "memory.influence", ARCHIVIST, {
        memoryDigest: item.memoryDigest,
        influence: item.influence,
        summary,
        weight,
      });
    }
  }

  private async commitMemoryCandidate(initial: CaseStatus, state: RunState): Promise<void> {
    if (!this.config.memory || !this.config.memoryProjectId) return;
    const events = await this.config.events.read(initial.caseId);
    const projection = projectEvents(events, {
      policyVersion: initial.sealed.policyVersion,
      ...formalProofReplayOptions(this.config.repository.policyDescriptor),
      intentContract: initial.sealed.intentContract,
      verifiedEvidenceEdges: state.verifiedAuthorityEdges,
      verifiedOriginalSubjectEdges: state.verifiedOriginalSubjectEdges,
      ...(state.originalSubjectContext ? { originalSubjectContext: state.originalSubjectContext } : {}),
    });
    const verdict = compileVerdict(projection.input);
    const encoded = encodeMemoryCandidate(this.memoryCandidate(
      initial,
      verdict,
      projection.memoryInfluences,
    ));
    const artifact = await this.config.repository.putArtifact(
      initial.caseId,
      `memory-${encoded.digest.slice("sha256:".length, "sha256:".length + 24)}.json`,
      encoded.mediaType,
      encoded.bytes,
    );
    if (
      artifact.digest !== encoded.digest ||
      artifact.size !== encoded.size ||
      artifact.mediaType !== MEMORY_CANDIDATE_MEDIA_TYPE
    ) {
      throw new Error("Repository returned a memory-candidate artifact with inconsistent identity");
    }
    await this.emit(initial, "crystallize", "action.status", KERNEL, {
      actionId: stableId("memory-commitment", { runDigest: initial.sealed.runDigest }),
      actionType: "memory.candidate.commitment",
      status: "completed",
      summary: "Bone committed one canonical quarantined memory candidate into the Record prefix; it is not admitted memory.",
      artifactDigests: [encoded.digest],
    });
  }

  private memoryCandidate(
    initial: CaseStatus,
    verdict: SignedRecord["verdict"],
    memoryInfluences: SignedRecord["memoryInfluences"],
    policyDescriptor: JsonValue = this.config.repository.policyDescriptor,
  ): MemoryCandidate {
    return projectMemoryCandidate({
      projectId: this.config.memoryProjectId as string,
      sealed: initial.sealed,
      verdict,
      memoryInfluences,
      policyDescriptor,
    });
  }

  private async stageCommittedMemoryCandidate(
    initial: CaseStatus,
    record: SignedRecord,
    events: readonly CaseEvent[],
  ): Promise<string | undefined> {
    const memory = this.config.memory;
    const projectId = this.config.memoryProjectId;
    if (!memory || !projectId) return undefined;
    const headIndex = events.findIndex((event) => event.eventDigest === record.eventHeadDigest);
    if (headIndex < 0) throw new Error("Signed Record head is absent from the memory commitment ledger");
    const expectedActionId = stableId("memory-commitment", {
      runDigest: initial.sealed.runDigest,
    });
    const commitments = events.slice(0, headIndex + 1).filter(
      (event): event is CaseEvent<"action.status"> =>
        event.kind === "action.status" &&
        event.payload.actionType === "memory.candidate.commitment",
    );
    if (commitments.length === 0) return undefined;
    if (commitments.length !== 1) throw new Error("Signed Record contains ambiguous memory commitments");
    const commitment = commitments[0];
    if (
      !commitment ||
      commitment.stage !== "crystallize" ||
      commitment.actor.kind !== "kernel" ||
      commitment.actor.id !== KERNEL.id ||
      commitment.payload.actionId !== expectedActionId ||
      commitment.payload.status !== "completed" ||
      commitment.payload.artifactDigests?.length !== 1 ||
      Date.parse(commitment.observedAt) < Date.parse(initial.sealed.sealedAt) ||
      Date.parse(commitment.observedAt) > Date.parse(record.crystallizedAt)
    ) {
      throw new Error("Signed memory commitment has invalid Bone, lifecycle, or chronology binding");
    }
    const descriptorArtifact = await this.config.repository.descriptor(record.policyDigest);
    if (!descriptorArtifact || descriptorArtifact.kind !== "policy") {
      throw new Error("Signed memory commitment has no exact policy descriptor artifact");
    }
    const expected = encodeMemoryCandidate(
      this.memoryCandidate(initial, record.verdict, record.memoryInfluences, descriptorArtifact.descriptor),
    );
    const committedDigest = commitment.payload.artifactDigests[0];
    if (committedDigest !== expected.digest) {
      throw new Error("Signed memory commitment does not match the deterministic Record projection");
    }
    const artifactId = `artifact_${expected.digest.slice("sha256:".length, "sha256:".length + 24)}`;
    const artifact = await this.config.repository.artifact(initial.caseId, artifactId);
    if (
      !artifact ||
      artifact.meta.digest !== expected.digest ||
      artifact.meta.mediaType !== MEMORY_CANDIDATE_MEDIA_TYPE
    ) {
      throw new Error("Committed memory candidate artifact is unavailable or has the wrong identity");
    }
    const committedMemory = decodeMemoryCandidate(artifact.data, expected.digest);
    if (committedMemory.candidate.projectId !== projectId) {
      throw new Error("Committed memory candidate belongs to another project");
    }
    const staged = memory.stage(committedMemory.candidate, commitment.observedAt);
    if (staged.digest !== expected.digest) {
      throw new Error("Temporal Deep changed the committed memory candidate identity");
    }
    return staged.digest;
  }

  private async memoryTribunal(initial: CaseStatus, state: RunState): Promise<void> {
    const actionId = stableId("memory", { runDigest: initial.sealed.runDigest });
    const memory = this.config.memory;
    const projectId = this.config.memoryProjectId;
    if (!memory || !projectId) {
      await this.emit(initial, "memory_tribunal", "action.status", ARCHIVIST, {
        actionId,
        actionType: "memory.promotion",
        status: "denied",
        summary: "No Temporal Deep is configured; no cross-case memory was staged.",
      });
      return;
    }
    if (!state.record) throw new Error("Memory Tribunal requires a crystallized Record");
    const stagedDigest = await this.stageCommittedMemoryCandidate(
      initial,
      state.record,
      await this.config.events.read(initial.caseId),
    );
    if (stagedDigest === undefined) {
      throw new Error("Memory Tribunal requires a memory candidate committed by the signed Record prefix");
    }
    state.stagedMemoryDigest = stagedDigest;
    await this.emit(initial, "memory_tribunal", "action.status", ARCHIVIST, {
      actionId,
      actionType: "memory.staging",
      status: "completed",
      summary: "The Case left one quarantined exact-outcome descriptor. It is not a generalized strategy and is not admitted memory; two distinct, clean, later signed Cases with the exact same task, material, and mechanism must reproduce it before admission.",
      artifactDigests: [stagedDigest],
    });
  }

  private async authenticatedCommittedMemoryCase(
    statusInput: CaseStatus,
    expectedMemoryDigest: string,
    expectedRecord: SignedRecord | undefined,
    terminating: boolean,
  ): Promise<VerifiedCommittedMemoryCase> {
    const memory = this.config.memory;
    const projectId = this.config.memoryProjectId;
    if (!memory || !projectId) throw new Error("Temporal Deep is not configured");
    const status = await this.config.repository.status(statusInput.caseId);
    if (!status) throw new Error("Committed memory origin Case is unavailable");
    const events = await this.config.events.read(status.caseId);
    const verification = verifyEventChain(events);
    if (!verification.valid || verification.headDigest === null) {
      throw new Error("Committed memory origin has an invalid public event chain");
    }
    if (!terminating && (
      status.lifecycle !== "terminated"
      || status.stage !== "terminate"
      || status.stageStatus !== "completed"
      || status.lastSequence !== events.length
      || status.headDigest !== verification.headDigest
    )) {
      throw new Error("Committed memory origin is not an exact terminal Case");
    }
    if (!terminating) {
      const terminal = await this.config.repository.terminalReceipt(status.caseId);
      if (terminal === undefined
        || terminal.caseDigest !== status.sealed.caseDigest
        || terminal.runDigest !== status.sealed.runDigest
        || terminal.lifecycle !== status.lifecycle
        || terminal.stage !== status.stage
        || terminal.stageStatus !== status.stageStatus
        || terminal.lastSequence !== status.lastSequence
        || terminal.eventHeadDigest !== status.headDigest) {
        throw new Error("Committed memory origin has no authenticated terminal closure");
      }
    }
    const authenticated = await this.inspectStoredRecord(status, events);
    if (!authenticated.record) {
      throw new Error(`Committed memory origin has no authenticated Record: ${authenticated.reason}`);
    }
    if (
      expectedRecord !== undefined
      && canonicalize(expectedRecord as unknown as JsonValue)
        !== canonicalize(authenticated.record as unknown as JsonValue)
    ) {
      throw new Error("Terminating Case Record changed before memory reconciliation");
    }
    const recordHeadIndex = events.findIndex(
      (event) => event.eventDigest === authenticated.record?.eventHeadDigest,
    );
    const terminalEvents = events.slice(recordHeadIndex + 1);
    const kernelTerminated = terminalEvents.some((event) =>
      event.stage === "terminate"
      && event.kind === "kernel.status"
      && event.actor.kind === "kernel"
      && event.actor.id === KERNEL.id
      && event.payload.operation === "terminated",
    );
    const normalCompleted = terminalEvents.some((event) =>
      event.stage === "terminate"
      && event.kind === "stage.status"
      && event.actor.kind === "kernel"
      && event.actor.id === KERNEL.id
      && event.payload.stage === "terminate"
      && event.payload.status === "completed",
    );
    const recoveryTerminated = terminalEvents.some((event) =>
      event.stage === "terminate"
      && event.kind === "action.status"
      && event.actor.kind === "kernel"
      && event.actor.id === KERNEL.id
      && event.payload.actionType === "runtime.recovery.terminate-existing-record"
      && event.payload.status === "completed",
    );
    if (terminating ? !kernelTerminated && !recoveryTerminated : !(kernelTerminated && normalCompleted) && !recoveryTerminated) {
      throw new Error("Committed memory origin has no Bone-authored terminal closure after its signed Record");
    }
    const stagedDigest = await this.stageCommittedMemoryCandidate(
      status,
      authenticated.record,
      events,
    );
    if (stagedDigest !== expectedMemoryDigest) {
      throw new Error("Authenticated memory commitment does not equal the expected Temporal Deep entry");
    }
    const state = memory.projectMemoryStates(projectId).find(
      (entry) => entry.memory.digest === expectedMemoryDigest,
    );
    if (!state) throw new Error("Authenticated memory commitment is absent from Temporal Deep");
    const [recordEnvelope, descriptor] = await Promise.all([
      this.config.repository.recordEnvelope(status.caseId),
      this.config.repository.descriptor(authenticated.record.policyDigest),
    ]);
    if (!recordEnvelope) throw new Error("Authenticated memory origin Record envelope is unavailable");
    if (!descriptor || descriptor.kind !== "policy") {
      throw new Error("Authenticated memory origin policy descriptor is unavailable");
    }
    return bindVerifiedCommittedMemoryCase({
      memory: state.memory,
      stagedAt: state.stagedAt,
      sealed: status.sealed,
      record: authenticated.record,
      recordEnvelope,
      policyDescriptor: descriptor.descriptor,
      projectId,
    });
  }

  private async persistMemoryReconciliationEvidence(
    caseId: string,
    name: string,
    encoded: ReturnType<typeof encodeMemoryReconciliationEvidence>,
  ): Promise<string> {
    const artifact = await this.config.repository.putArtifact(
      caseId,
      name,
      encoded.mediaType,
      encoded.bytes,
    );
    if (
      artifact.digest !== encoded.digest
      || artifact.size !== encoded.size
      || artifact.mediaType !== MEMORY_RECONCILIATION_EVIDENCE_MEDIA_TYPE
    ) {
      throw new Error("Repository returned inconsistent memory reconciliation evidence identity");
    }
    return artifact.digest;
  }

  /**
   * Run only after Bone has authored terminal closure. Exclusions remain public
   * diagnostics; only exact, clean comparisons enter the Tribunal ledger.
   */
  private async reconcileTerminatingMemoryCase(
    initial: CaseStatus,
    record: SignedRecord,
    sourceMemoryDigest: string,
    terminating: boolean,
  ): Promise<void> {
    const memory = this.config.memory;
    const projectId = this.config.memoryProjectId;
    if (!memory || !projectId) return;
    const actionId = stableId("memory-reconciliation-run", {
      runDigest: record.runDigest,
      sourceMemoryDigest,
    });
    try {
      const source = await this.authenticatedCommittedMemoryCase(
        initial,
        sourceMemoryDigest,
        record,
        terminating,
      );
      const statuses = await this.config.repository.statuses();
      const statusByRunDigest = new Map<string, CaseStatus[]>();
      for (const status of statuses) {
        const existing = statusByRunDigest.get(status.sealed.runDigest) ?? [];
        existing.push(status);
        statusByRunDigest.set(status.sealed.runDigest, existing);
      }
      const results: Array<{
        targetMemoryDigest: string;
        classification: string;
        evidenceArtifactDigests: readonly string[];
        tribunalDecision?: "PENDING" | "ADMIT" | "REJECT";
        tribunalDecisionDigest?: string;
        problem?: string;
      }> = [];
      const states = memory.projectMemoryStates(projectId);
      for (const targetState of states) {
        if (targetState.memory.digest === sourceMemoryDigest) continue;
        let fingerprint;
        try {
          fingerprint = memoryReproducibilityFingerprint(targetState.memory.candidate);
        } catch {
          results.push({
            targetMemoryDigest: targetState.memory.digest,
            classification: "MALFORMED_CONTRACT_EXCLUDED",
            evidenceArtifactDigests: Object.freeze([]),
          });
          continue;
        }
        if (!fingerprint) {
          results.push({
            targetMemoryDigest: targetState.memory.digest,
            classification: "NO_EXACT_CONTRACT_EXCLUDED",
            evidenceArtifactDigests: Object.freeze([]),
          });
          continue;
        }
        const existingSourceEvidence = memory.evidenceHistory(targetState.memory.digest)
          .filter(
            (entry) => entry.observation.sourceRunDigest === source.recordBinding.runDigest,
          );
        if (targetState.decision !== undefined && existingSourceEvidence.length === 0) {
          results.push({
            targetMemoryDigest: targetState.memory.digest,
            classification: "ALREADY_ADJUDICATED_EXCLUDED",
            evidenceArtifactDigests: Object.freeze([]),
          });
          continue;
        }
        try {
          const originStatuses = statusByRunDigest.get(fingerprint.origin.runDigest) ?? [];
          if (originStatuses.length !== 1) {
            throw new Error("Memory origin does not resolve to exactly one stored run");
          }
          const targetStatus = originStatuses[0] as CaseStatus;
          if (targetStatus.sealed.caseDigest !== fingerprint.origin.caseDigest) {
            throw new Error("Memory origin run resolves to a different Case content digest");
          }
          const target = await this.authenticatedCommittedMemoryCase(
            targetStatus,
            targetState.memory.digest,
            undefined,
            false,
          );
          const targetAncestry = memory.verifiedMemoryLineage(
            projectId,
            target.memory.candidate.sourceMemoryDigests,
          );
          const sourceInfluences = memory.verifiedMemoryLineage(
            projectId,
            source.memory.candidate.sourceMemoryDigests,
          );
          const comparison = compareCommittedMemoryCases(target, source, {
            targetAncestry,
            sourceInfluences,
          });
          const evidenceArtifactDigests: string[] = [];
          let decision: "PENDING" | "ADMIT" | "REJECT" | undefined;
          let decisionDigest: string | undefined;
          if (
            comparison.classification === "REPRODUCTION"
            || comparison.classification === "COUNTEREXAMPLE"
          ) {
            const outcome = encodeMemoryReconciliationEvidence(comparison, "OUTCOME");
            const contamination = encodeMemoryReconciliationEvidence(comparison, "CONTAMINATION");
            const outcomeDigest = await this.persistMemoryReconciliationEvidence(
              initial.caseId,
              `memory-${target.memory.digest.slice(-16)}-${source.recordBinding.caseDigest.slice(-16)}-outcome.json`,
              outcome,
            );
            const contaminationDigest = await this.persistMemoryReconciliationEvidence(
              initial.caseId,
              `memory-${target.memory.digest.slice(-16)}-${source.recordBinding.caseDigest.slice(-16)}-contamination.json`,
              contamination,
            );
            evidenceArtifactDigests.push(outcomeDigest, contaminationDigest);
            const adjudication = memory.reconcileEvidenceBatch(
              target.memory.digest,
              reconciliationObservations(
                comparison,
                outcomeDigest,
                contaminationDigest,
                source.chronology.crystallizedAt,
              ),
              source.chronology.crystallizedAt,
            );
            decision = adjudication.decision.decision;
            decisionDigest = adjudication.decision.decisionDigest;
          } else {
            const exclusion = encodeMemoryReconciliationEvidence(comparison, "EXCLUSION");
            evidenceArtifactDigests.push(await this.persistMemoryReconciliationEvidence(
              initial.caseId,
              `memory-${target.memory.digest.slice(-16)}-${source.recordBinding.caseDigest.slice(-16)}-exclusion.json`,
              exclusion,
            ));
          }
          results.push({
            targetMemoryDigest: target.memory.digest,
            classification: comparison.classification,
            evidenceArtifactDigests: Object.freeze(evidenceArtifactDigests.sort()),
            ...(decision === undefined ? {} : { tribunalDecision: decision }),
            ...(decisionDigest === undefined ? {} : { tribunalDecisionDigest: decisionDigest }),
          });
        } catch (error) {
          results.push({
            targetMemoryDigest: targetState.memory.digest,
            classification: "UNVERIFIABLE_EXCLUDED",
            evidenceArtifactDigests: Object.freeze([]),
            problem: publicError(error),
          });
        }
      }

      const counts = results.reduce<Record<string, number>>((total, result) => {
        total[result.classification] = (total[result.classification] ?? 0) + 1;
        if (result.tribunalDecision !== undefined) {
          const key = `TRIBUNAL_${result.tribunalDecision}`;
          total[key] = (total[key] ?? 0) + 1;
        }
        return total;
      }, {});
      const summaryValue = {
        protocol: "jevyr.memory-reconciliation-run/1",
        projectId,
        sourceMemoryDigest,
        sourceCaseDigest: source.recordBinding.caseDigest,
        sourceRunDigest: source.recordBinding.runDigest,
        sourceRecordDigest: source.recordBinding.recordDigest,
        observedAt: source.chronology.crystallizedAt,
        results,
        counts,
      } as unknown as JsonValue;
      const summaryBytes = new TextEncoder().encode(canonicalize(summaryValue));
      const summaryArtifact = await this.config.repository.putArtifact(
        initial.caseId,
        `memory-reconciliation-${source.recordBinding.caseDigest.slice(-24)}.json`,
        "application/vnd.jevyr.memory-reconciliation-summary+json",
        summaryBytes,
      );
      if (summaryArtifact.digest !== `sha256:${sha256(Buffer.from(summaryBytes))}`) {
        throw new Error("Memory reconciliation summary artifact changed identity");
      }
      const reproductions = counts.REPRODUCTION ?? 0;
      const counterexamples = counts.COUNTEREXAMPLE ?? 0;
      const admitted = counts.TRIBUNAL_ADMIT ?? 0;
      const rejected = counts.TRIBUNAL_REJECT ?? 0;
      const pending = counts.TRIBUNAL_PENDING ?? 0;
      const exclusions = results.length - reproductions - counterexamples;
      const summary = `Authenticated later-Case reconciliation examined ${results.length} prior staged memor${results.length === 1 ? "y" : "ies"}: ${reproductions} exact reproduction${reproductions === 1 ? "" : "s"}, ${counterexamples} counterexample${counterexamples === 1 ? "" : "s"}, ${exclusions} excluded comparison${exclusions === 1 ? "" : "s"}. Tribunal outcomes after durable updates: ${admitted} admitted, ${rejected} rejected, ${pending} pending.`;
      const existing = (await this.config.events.read(initial.caseId)).filter(
        (event): event is CaseEvent<"action.status"> =>
          event.kind === "action.status" && event.payload.actionId === actionId,
      );
      if (existing.length > 1) throw new Error("Memory reconciliation action identity is ambiguous");
      if (existing.length === 1) {
        const event = existing[0] as CaseEvent<"action.status">;
        if (
          event.actor.kind !== "archivist"
          || event.actor.id !== ARCHIVIST.id
          || event.payload.actionType !== "memory.reconciliation"
          || event.payload.status !== "completed"
          || event.payload.artifactDigests?.length !== 1
        ) {
          throw new Error("Existing memory reconciliation action has conflicting authority or shape");
        }
        const artifactDigest = event.payload.artifactDigests[0] as string;
        if (artifactDigest !== summaryArtifact.digest) {
          throw new Error("Existing memory reconciliation action names a different derived summary");
        }
        const artifact = await this.config.repository.artifact(
          initial.caseId,
          `artifact_${artifactDigest.slice("sha256:".length, "sha256:".length + 24)}`,
        );
        if (
          !artifact
          || artifact.meta.digest !== artifactDigest
          || artifact.meta.mediaType !== "application/vnd.jevyr.memory-reconciliation-summary+json"
          || artifact.meta.size !== summaryBytes.byteLength
          || !artifact.data.equals(Buffer.from(summaryBytes))
        ) {
          throw new Error("Existing memory reconciliation summary artifact is unavailable or changed");
        }
        return;
      }
      await this.emit(initial, "terminate", "action.status", ARCHIVIST, {
        actionId,
        actionType: "memory.reconciliation",
        status: "completed",
        summary,
        artifactDigests: [summaryArtifact.digest],
      });
    } catch (error) {
      const existing = (await this.config.events.read(initial.caseId)).some(
        (event) => event.kind === "action.status" && event.payload.actionId === actionId,
      );
      // An existing action can be accepted only by the exact verification path
      // above. Reaching this catch means its authority or artifact did not
      // rederive; swallowing that conflict would turn a corrupt recovery into
      // a successful no-op.
      if (existing) throw error;
      await this.emit(initial, "terminate", "action.status", ARCHIVIST, {
        actionId,
        actionType: "memory.reconciliation",
        status: "failed",
        summary: `Authenticated later-Case memory reconciliation failed closed; no unverifiable comparison gained Tribunal authority. ${publicError(error)}`,
      });
    }
  }

  private assayResourceRefusal(state: RunState, plan: SealedAssayPlan, scopedLimits?: AssayFrontier["aggregateLimits"]): string | undefined {
    const limits = scopedLimits ?? this.effectiveAssayLimits(state);
    if (!limits) return "No finite Assay Frontier was sealed before Cast.";
    if (state.assayExhaustionReason) return state.assayExhaustionReason;
    if (plan.costUnits > limits.maxTotalAssayCost - state.assayUsage.totalAssayCost) {
      return `Case-wide assay cost would exceed ${limits.maxTotalAssayCost}.`;
    }
    if (state.assayUsage.forgeWallMillis >= limits.maxForgeWallMillis
      || limits.maxForgeWallMillis - state.assayUsage.forgeWallMillis < 1_000) {
      return `Case-wide Forge wall budget ${limits.maxForgeWallMillis} ms is exhausted.`;
    }
    if (state.assayUsage.writableBytes >= limits.maxWritableBytes) {
      return `Case-wide writable-byte budget ${limits.maxWritableBytes} is exhausted.`;
    }
    if (state.assayUsage.writableInodes >= limits.maxWritableInodes) {
      return `Case-wide writable-inode budget ${limits.maxWritableInodes} is exhausted.`;
    }
    if (limits.maxForgeCpuMillis === 0) {
      return "Case-wide Forge CPU budget is zero; execution is prohibited.";
    }
    if (state.assayUsage.cpuMeasurements > 0
      && state.assayUsage.measuredForgeCpuMillis >= limits.maxForgeCpuMillis) {
      return `Measured case-wide Forge CPU budget ${limits.maxForgeCpuMillis} ms is exhausted.`;
    }
    return undefined;
  }

  private effectiveAssayLimits(state: RunState): AssayFrontier["aggregateLimits"] | undefined {
    const original = state.assayFrontier?.aggregateLimits;
    if (!original) return undefined;
    const effective = state.mindBudget.effectiveEnvelope();
    const keys = ["maxForgeWallMillis", "maxForgeCpuMillis", "maxTotalAssayCost", "maxWritableBytes", "maxWritableInodes", "maxArtifactBytes"] as const;
    return Object.freeze(Object.fromEntries(keys.map((key) => [key, original[key] + effective[key] - state.mindBudget.envelope[key]])) as unknown as AssayFrontier["aggregateLimits"]);
  }

  private async recordBlockedAssayRun(
    initial: CaseStatus,
    state: RunState,
    candidateId: string,
    plan: SealedAssayPlan,
    reason: string,
  ): Promise<void> {
    const obligation = resolveForgeObligation(initial, plan);
    const experiment = experimentForPlan(state.experimentCapability, plan);
    const comparativeExperiment: SealedCandidateExperiment | undefined = experiment?.authority === "comparative-only"
      ? experiment
      : undefined;
    const now = new Date().toISOString();
    const invocationId = stableId("invocation", {
      runDigest: initial.sealed.runDigest,
      candidateId,
      assayId: plan.assayId,
      blocked: reason,
    });
    const observation: ToolObservation = Object.freeze({
      invocationId,
      status: "not-executed",
      summary: reason,
      startedAt: now,
      finishedAt: now,
      metadata: Object.freeze({
        reason: "assay-frontier-blocked",
        assayFrontierDigest: state.assayFrontier?.digest ?? null,
        candidateId,
        assayId: plan.assayId,
        planDigest: digestJson(plan as unknown as JsonValue),
        typedOracleStatus: "BLOCKED",
        executionAuthorityStatus: "BLOCKED",
        aggregateAdmissible: false,
        boneAccounting: Object.freeze({
          protocol: "jevyr.bone-assay-accounting/1",
          wallMillis: 0,
          costUnitsCharged: 0,
          artifactOutputBytes: 0,
          artifactStorageBytes: 0,
          cpuMillis: null,
          writableBytes: null,
          writableInodes: null,
          aggregateAfter: Object.freeze({
            forgeWallMillis: state.assayUsage.forgeWallMillis,
            measuredForgeCpuMillis: state.assayUsage.measuredForgeCpuMillis,
            cpuMeasurements: state.assayUsage.cpuMeasurements,
            cpuUnmeasured: state.assayUsage.cpuUnmeasured,
            workspaceUnmeasured: state.assayUsage.workspaceUnmeasured,
            totalAssayCost: state.assayUsage.totalAssayCost,
            writableBytes: state.assayUsage.writableBytes,
            writableInodes: state.assayUsage.writableInodes,
            artifactStorageBytes: state.assayUsage.artifactBytes,
          }),
        }),
      }),
    });
    await this.persistObservation(initial, state, observation);
    const evaluation = obligation === undefined && comparativeExperiment !== undefined
      ? blockedComparativeExperiment(comparativeExperiment, reason)
      : blockedForgeEvaluation(obligation, reason);
    const run: CandidateAssayRun = Object.freeze({
      candidateId,
      plan,
      observation,
      evidenceId: stableId("evidence", { runDigest: initial.sealed.runDigest, candidateId, assayId: plan.assayId }),
      ...(evaluation === undefined ? {} : { evaluation }),
      wallMillis: 0,
      artifactBytes: 0,
      artifactStorageBytes: 0,
      costUnitsCharged: 0,
      admissible: false,
      blockedReason: reason,
    });
    state.evidence.push(observation);
    state.assayRuns.push(run);
    await this.emit(initial, "embody", "action.status", KERNEL, {
      actionId: invocationId,
      actionType: plan.tool,
      status: "denied",
      summary: `Candidate ${candidateId}, assay ${plan.assayId}: ${reason}`,
      toolId: adapterCapabilitySnapshot(this.admittedForge).id,
    });
  }

  private async commitCandidatePopulation(
    initial: CaseStatus,
    state: RunState,
    candidates: readonly [string, {
      readonly blueprint: CompiledCandidateBlueprint;
      readonly artifactDigest: string;
    }][],
  ): Promise<void> {
    const population = Object.freeze({
      protocol: "jevyr.candidate-population/1" as const,
      caseId: initial.caseId,
      runDigest: initial.sealed.runDigest,
      assayFrontierDigest: state.assayFrontier?.digest ?? null,
      candidates: Object.freeze(candidates.map(([candidateId, entry]) => Object.freeze({
        candidateId,
        blueprintDigest: entry.blueprint.blueprintDigest,
        blueprintArtifactDigest: entry.artifactDigest,
      }))),
    });
    const digest = digestJson(population as unknown as JsonValue);
    const artifact = await this.config.repository.putArtifact(
      initial.caseId,
      `candidate-population-${digest.slice("sha256:".length, "sha256:".length + 24)}.json`,
      CANDIDATE_POPULATION_MEDIA_TYPE,
      Buffer.from(canonicalize(population as unknown as JsonValue), "utf8"),
    );
    if (artifact.digest !== digest || artifact.mediaType !== CANDIDATE_POPULATION_MEDIA_TYPE) {
      throw new Error("Repository returned a candidate-population artifact with inconsistent identity");
    }
    state.populationHeadDigest = artifact.digest;
    await this.emit(initial, "embody", "action.status", KERNEL, {
      actionId: stableId("population", { runDigest: initial.sealed.runDigest }),
      actionType: "candidate.population.close",
      status: "completed",
      summary: `Bone closed a finite population of ${candidates.length} candidate${candidates.length === 1 ? "" : "s"} before the first assay cell.`,
      artifactDigests: [artifact.digest],
    });
  }

  private async executeCandidateAssay(
    initial: CaseStatus,
    state: RunState,
    signal: AbortSignal,
    candidateId: string,
    candidateMaterialization: CandidateMaterialization,
    subjectRoot: string,
    subjectMaterialization: SubjectMaterializationResult,
    plan: SealedAssayPlan,
    scopedLimits?: AssayFrontier["aggregateLimits"],
  ): Promise<void> {
    const obligation = resolveForgeObligation(initial, plan);
    const experiment = experimentForPlan(state.experimentCapability, plan);
    const comparativeExperiment = experiment?.authority === "comparative-only" ? experiment : undefined;
    const bindingProblem = forgePlanBindingProblem(initial, plan, state.experimentCapability);
    if ((obligation === undefined && comparativeExperiment === undefined) || bindingProblem !== undefined) {
      await this.recordBlockedAssayRun(
        initial,
        state,
        candidateId,
        plan,
        bindingProblem ?? "The assay is not bound to exactly one sealed assayable obligation.",
      );
      return;
    }
    const capabilityProblem = forgeCapabilityProblem(initial, this.admittedForge);
    if (capabilityProblem !== undefined) {
      await this.recordBlockedAssayRun(initial, state, candidateId, plan, capabilityProblem);
      return;
    }
    // Opaque, trusted-host, observe-only, or policy-mismatched adapters may
    // still return diagnostic observations. They can never become verdict
    // evidence without the module-branded Docker boundary sealed at Cast.
    const liveAuthorityFailure = liveForgeAuthorityProblem(
      initial,
      this.config.repository,
      this.admittedForge,
    );
    const refusal = this.assayResourceRefusal(state, plan, scopedLimits);
    if (refusal !== undefined) {
      state.assayExhaustionReason ??= refusal;
      await this.recordBlockedAssayRun(initial, state, candidateId, plan, refusal);
      return;
    }
    if (isBuiltInObserveOnlyForge(this.admittedForge)) {
      await this.recordBlockedAssayRun(
        initial,
        state,
        candidateId,
        plan,
        `The configured Forge is in observe-only mode and cannot execute this assay${liveAuthorityFailure === undefined ? "." : `: ${liveAuthorityFailure}`}`,
      );
      return;
    }
    const subjectDependent = plan.sealedSubjectDigest !== undefined
      || plan.sealedTestSuite !== undefined
      || plan.requestedAssay !== undefined
      || ["sealed_subject_digest", "sealed_test_suite", "requested_assay"].includes(obligation?.oracle?.kind ?? "");
    const declarationOnly = subjectMaterialization.subjects.filter((subject) => subject.availability === "DECLARATION_ONLY");
    if (subjectDependent && declarationOnly.length > 0) {
      await this.recordBlockedAssayRun(
        initial,
        state,
        candidateId,
        plan,
        `The assay depends on declaration-only subject material: ${declarationOnly.map((entry) => entry.subjectId).join(", ")}.`,
      );
      return;
    }
    const evaluatorProblem = unavailableEvaluatorProblem(plan);
    if (evaluatorProblem !== undefined) {
      await this.recordBlockedAssayRun(initial, state, candidateId, plan, evaluatorProblem);
      return;
    }

    const limits = scopedLimits ?? this.effectiveAssayLimits(state);
    if (!limits) throw new Error("Assay execution lost its sealed aggregate limits");
    state.assayUsage.totalAssayCost += plan.costUnits;
    const remainingForgeWallMillis = Math.max(1, limits.maxForgeWallMillis - state.assayUsage.forgeWallMillis);
    const cellTimeoutMs = Math.min(600_000, remainingForgeWallMillis, plan.timeoutMs ?? 120_000);
    const deadlineController = new AbortController();
    const cellSignal = AbortSignal.any([signal, deadlineController.signal]);
    const invocation: ToolInvocation = Object.freeze({
      invocationId: stableId("invocation", {
        runDigest: initial.sealed.runDigest,
        candidateId,
        assayId: plan.assayId,
      }),
      caseId: initial.caseId,
      tool: plan.tool,
      args: plan.args,
      timeoutMs: cellTimeoutMs,
      resourceLimits: Object.freeze({
        maxWritableBytes: Math.min(state.mindBudget.envelope.maxWritableBytes, Math.max(0, limits.maxWritableBytes - state.assayUsage.writableBytes)),
        maxWritableInodes: Math.min(state.mindBudget.envelope.maxWritableInodes, Math.max(0, limits.maxWritableInodes - state.assayUsage.writableInodes)),
        maxArtifactBytes: Math.min(state.mindBudget.envelope.maxArtifactBytes, Math.max(0, limits.maxArtifactBytes - state.assayUsage.artifactBytes)),
      }),
      forgeMaterials: Object.freeze({
        protocol: "jevyr.forge-invocation-materials/1" as const,
        candidate: Object.freeze({
          sourceRoot: candidateMaterialization.root,
          blueprintDigest: candidateMaterialization.blueprintDigest,
          materializationDigest: candidateMaterialization.materializationDigest,
          treeDigest: candidateTreeDigest(candidateMaterialization.files),
        }),
        subjects: Object.freeze({
          subjectRoot,
          captureDigest: initial.sealed.subjectMaterialCaptureDigest,
          materializationDigest: subjectMaterialization.materializationDigest,
        }),
      }),
      signal: cellSignal,
    });
    await this.emit(initial, "embody", "action.status", actorFor(this.admittedForge), {
      actionId: invocation.invocationId,
      actionType: invocation.tool,
      status: "started",
      summary: `Candidate ${candidateId} entered isolated assay ${plan.assayId}.`,
      toolId: adapterCapabilitySnapshot(this.admittedForge).id,
    });
    const stopHeartbeat = this.startHeartbeat(
      initial,
      "embody",
      `Candidate ${candidateId} is still executing assay ${plan.assayId} inside its disposable Forge boundary.`,
      adapterCapabilitySnapshot(this.admittedForge).id,
    );
    let rawObservation: ToolObservation;
    let adapterThrew = false;
    const hostStarted = performance.now();
    const cellDeadlineAt = hostStarted + cellTimeoutMs;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const adapterPromise = Promise.resolve().then(async () => await this.admittedForge.execute(invocation));
      // Opaque adapters may complete or reject after Bone has closed the cell.
      // This handler prevents either late outcome from becoming process-global.
      void adapterPromise.catch(() => undefined);
      const settled = adapterPromise.then(
        (observation) => ({ kind: "observation" as const, observation }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const deadline = new Promise<{ readonly kind: "deadline" }>((resolveDeadline) => {
        deadlineTimer = setTimeout(() => {
          deadlineController.abort(`Bone closed Forge cell after ${cellTimeoutMs} ms`);
          resolveDeadline({ kind: "deadline" });
        }, cellTimeoutMs);
      });
      const outcome = await Promise.race([settled, deadline]);
      const settledAt = performance.now();
      if (outcome.kind === "deadline" || settledAt >= cellDeadlineAt) {
        const now = new Date().toISOString();
        rawObservation = Object.freeze({
          invocationId: invocation.invocationId,
          status: "failed" as const,
          summary: `Bone closed the Forge cell at its ${cellTimeoutMs} ms sealed deadline; no late adapter result is admissible.`,
          startedAt: now,
          finishedAt: now,
          metadata: Object.freeze({
            admissible: false,
            reason: "bone-cell-deadline",
            deadlineMillis: cellTimeoutMs,
            monotonicDeadlineEnforced: true,
          }),
        });
        if (outcome.kind === "deadline" && SealedForgeAdapter.isBuiltIn(this.admittedForge)) {
          // The built-in Forge propagates this signal into its bounded process
          // and Docker cleanup. Drain it before deleting the cell roots.
          await settled;
        }
      } else if (outcome.kind === "error") {
        adapterThrew = true;
        const now = new Date().toISOString();
        rawObservation = Object.freeze({
          invocationId: invocation.invocationId,
          status: "failed" as const,
          summary: `Forge adapter failed without a typed observation: ${publicError(outcome.error)}`,
          startedAt: now,
          finishedAt: now,
          metadata: Object.freeze({ admissible: false, reason: "forge-adapter-threw" }),
        });
      } else {
        rawObservation = outcome.observation;
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      await stopHeartbeat();
    }

    rawObservation = canonicalObservation(rawObservation, invocation.invocationId, "Forge");

    const physical = forgePhysicalReadings(rawObservation);
    // Aggregate physics is charged by Bone's own monotonic clock. Adapter
    // timestamps remain evidence, but cannot mint wall budget by lying or throwing.
    const wallMillis = Math.max(1, Math.ceil(performance.now() - hostStarted));
    const executed = rawObservation.oracle?.execution.state === "exited";
    const claimedArtifactRefs = rawObservation.artifactRefs ?? [];
    const artifactIds = new Set(claimedArtifactRefs);
    const artifactMetas = artifactIds.size === 0
      ? []
      : (await this.config.repository.artifacts(initial.caseId)).filter((artifact) => artifactIds.has(artifact.id));
    let artifactProblem: string | undefined;
    if (artifactIds.size !== claimedArtifactRefs.length) {
      artifactProblem = "Forge returned duplicate artifact references for one assay cell.";
    } else if (artifactMetas.length !== artifactIds.size) {
      artifactProblem = "Forge returned an artifact reference that does not exist in this Case.";
    } else if (artifactMetas.some((artifact) => artifact.mediaType.startsWith("application/vnd.jevyr."))) {
      artifactProblem = "Forge attempted to cite an internal Jevyr protocol artifact as candidate output.";
    }
    const artifactReceipt = objectValue(rawObservation.metadata?.artifactReceipt);
    const receiptRefs = artifactReceipt?.artifactRefs;
    const receiptOutputBytes = finiteReading(artifactReceipt?.outputBytes);
    const receiptExact = artifactReceipt?.protocol === "jevyr.forge-artifact-receipt/1"
      && artifactReceipt.invocationId === invocation.invocationId
      && Array.isArray(receiptRefs)
      && receiptRefs.every((entry) => typeof entry === "string")
      && receiptRefs.length === claimedArtifactRefs.length
      && [...receiptRefs].sort().every((entry, index) => entry === [...claimedArtifactRefs].sort()[index])
      && Number.isSafeInteger(receiptOutputBytes);
    if (artifactProblem === undefined && !receiptExact) {
      artifactProblem = "Forge returned no exact invocation-bound artifact receipt.";
    }
    const acceptedArtifactMetas = artifactProblem === undefined ? artifactMetas : [];
    const acceptedArtifactRefs = artifactProblem === undefined
      ? Object.freeze([...claimedArtifactRefs].sort())
      : Object.freeze([] as string[]);
    const artifactBytes = artifactProblem === undefined && receiptOutputBytes !== undefined
      ? receiptOutputBytes
      : 0;
    const normalizedArtifactReceipt = Object.freeze({
      protocol: "jevyr.forge-artifact-receipt/1" as const,
      invocationId: invocation.invocationId,
      artifactRefs: acceptedArtifactRefs,
      outputBytes: artifactBytes,
    });
    /* Invalid or foreign references never survive into the canonical
     * observation. The rejection remains explicit metadata, while the receipt
     * covers only the Case-local outputs Bone actually accepted. */
    const artifactStorageBytes = acceptedArtifactMetas.reduce(
      (sum, artifact) => sum + (state.artifactDigests.has(artifact.digest) ? 0 : artifact.size),
      0,
    );
    for (const artifact of acceptedArtifactMetas) state.artifactDigests.add(artifact.digest);
    state.assayUsage.forgeWallMillis += wallMillis;
    state.assayUsage.artifactBytes += artifactStorageBytes;
    if (executed && physical.cpuMillis === undefined) state.assayUsage.cpuUnmeasured = true;
    else if (physical.cpuMillis !== undefined) {
      state.assayUsage.cpuMeasurements += 1;
      state.assayUsage.measuredForgeCpuMillis += physical.cpuMillis;
    }
    if (executed && (physical.writableBytes === undefined || physical.writableInodes === undefined)) {
      state.assayUsage.workspaceUnmeasured = true;
    } else if (physical.writableBytes !== undefined && physical.writableInodes !== undefined) {
      state.assayUsage.writableBytes += physical.writableBytes;
      state.assayUsage.writableInodes += physical.writableInodes;
    }

    let resourceProblem: string | undefined;
    if (executed && (physical.writableBytes === undefined || physical.writableInodes === undefined)) {
      resourceProblem = "Forge did not return complete measured workspace accounting.";
    } else if (state.assayUsage.forgeWallMillis > limits.maxForgeWallMillis) {
      resourceProblem = `Case-wide Forge wall use exceeded ${limits.maxForgeWallMillis} ms.`;
    } else if (physical.cpuMillis !== undefined && state.assayUsage.measuredForgeCpuMillis > limits.maxForgeCpuMillis) {
      resourceProblem = `Measured case-wide Forge CPU use exceeded ${limits.maxForgeCpuMillis} ms.`;
    } else if (state.assayUsage.writableBytes > limits.maxWritableBytes) {
      resourceProblem = `Case-wide writable bytes exceeded ${limits.maxWritableBytes}.`;
    } else if (state.assayUsage.writableInodes > limits.maxWritableInodes) {
      resourceProblem = `Case-wide writable inodes exceeded ${limits.maxWritableInodes}.`;
    } else if (state.assayUsage.artifactBytes > limits.maxArtifactBytes) {
      resourceProblem = `Case-wide artifact bytes exceeded ${limits.maxArtifactBytes}.`;
    }
    if (resourceProblem !== undefined) state.assayExhaustionReason ??= resourceProblem;

    const oraclePlan = obligation === undefined ? undefined : toSealedForgeOraclePlan(plan, obligation.id);
    const rawEvaluation = obligation === undefined && comparativeExperiment !== undefined
      ? !rawObservation.oracle
        ? blockedComparativeExperiment(comparativeExperiment, "The Forge returned no typed execution observation.")
        : evaluateComparativeExperiment(comparativeExperiment, rawObservation.oracle)
      : !obligation || !oraclePlan
        ? undefined
        : !rawObservation.oracle
          ? blockedForgeEvaluation(obligation, "The Forge returned no typed oracle observation.")
          : evaluateForgeOracle(obligation, oraclePlan, rawObservation.oracle);
    const persistedAuthority = rawObservation.oracle === undefined
      ? undefined
      : verifyForgeExecutionAuthority(this.config.repository.policyDescriptor, rawObservation.oracle);
    const authorityProblem = liveAuthorityFailure
      ?? (persistedAuthority?.verified === false ? persistedAuthority.reason : undefined)
      ?? artifactProblem;
    const integrityFailure = forgeIntegrityFailure(rawObservation, {
      builtInSandbox: SealedForgeAdapter.isBuiltIn(this.admittedForge) && this.admittedForge.mode === "docker",
      adapterThrew,
      interrupted: cellSignal.aborted,
      ...(authorityProblem === undefined ? {} : { authorityProblem }),
    });
    if (integrityFailure !== undefined) {
      await this.emit(initial, "embody", "action.status", KERNEL, {
        actionId: stableId("forge-integrity", { invocationId: invocation.invocationId }),
        actionType: integrityFailure,
        status: "failed",
        summary: integrityFailure === "integrity.sandbox_failure"
          ? "The admitted Forge failed after its startup probe; this Case lost its promised sandbox capability."
          : "The admitted Forge could not preserve its sealed execution or evidence boundary.",
        toolId: adapterCapabilitySnapshot(this.admittedForge).id,
      });
    }
    const blockedReason = resourceProblem ?? authorityProblem;
    const blockedEvaluation = (reason: string): ForgeOracleEvaluation | undefined =>
      comparativeExperiment === undefined
        ? blockedForgeEvaluation(obligation, reason)
        : blockedComparativeExperiment(comparativeExperiment, reason);
    const evaluation = resourceProblem !== undefined
      ? blockedEvaluation(resourceProblem)
      : authorityProblem !== undefined
        ? blockedEvaluation(authorityProblem)
        : rawEvaluation;
    const admissible = resourceProblem === undefined
      && authorityProblem === undefined
      && rawObservation.metadata?.admissible !== false
      && evaluation?.decisive === true;
    const observation: ToolObservation = Object.freeze({
      ...rawObservation,
      artifactRefs: acceptedArtifactRefs,
      metadata: Object.freeze({
        ...(rawObservation.metadata ?? {}),
        artifactReceipt: normalizedArtifactReceipt,
        ...(artifactProblem === undefined ? {} : { artifactBoundaryProblem: artifactProblem }),
        assayFrontierDigest: state.assayFrontier?.digest,
        assayId: plan.assayId,
        candidateId,
        candidateBlueprintDigest: candidateMaterialization.blueprintDigest,
        candidateMaterializationDigest: candidateMaterialization.materializationDigest,
        subjectMaterializationDigest: subjectMaterialization.materializationDigest,
        planDigest: digestJson(plan as unknown as JsonValue),
        planBoundAtSeal: state.assayFrontierSealed,
        typedOracleStatus: evaluation?.status ?? "NOT_APPLICABLE",
        executionAuthorityStatus: authorityProblem === undefined
          ? persistedAuthority?.verified === true ? "VERIFIED" : "NOT_APPLICABLE"
          : "BLOCKED",
        ...(authorityProblem === undefined && persistedAuthority?.authority !== undefined
          ? { executionAuthorityDigest: persistedAuthority.authority.digest }
          : {}),
        boneAccounting: Object.freeze({
          protocol: "jevyr.bone-assay-accounting/1",
          wallMillis,
          costUnitsCharged: plan.costUnits,
          artifactOutputBytes: artifactBytes,
          artifactStorageBytes,
          cpuMillis: physical.cpuMillis ?? null,
          writableBytes: physical.writableBytes ?? null,
          writableInodes: physical.writableInodes ?? null,
          aggregateAfter: Object.freeze({
            forgeWallMillis: state.assayUsage.forgeWallMillis,
            measuredForgeCpuMillis: state.assayUsage.measuredForgeCpuMillis,
            cpuMeasurements: state.assayUsage.cpuMeasurements,
            cpuUnmeasured: state.assayUsage.cpuUnmeasured,
            workspaceUnmeasured: state.assayUsage.workspaceUnmeasured,
            totalAssayCost: state.assayUsage.totalAssayCost,
            writableBytes: state.assayUsage.writableBytes,
            writableInodes: state.assayUsage.writableInodes,
            artifactStorageBytes: state.assayUsage.artifactBytes,
          }),
        }),
        aggregateAdmissible: admissible,
      }),
    });
    await this.persistObservation(initial, state, observation);
    const evidenceId = stableId("evidence", {
      runDigest: initial.sealed.runDigest,
      candidateId,
      assayId: plan.assayId,
    });
    state.evidence.push(observation);
    const previousEmbodiment = state.assayRuns.some((entry) =>
      entry.candidateId === candidateId && entry.observation.oracle?.execution.state === "exited");
    state.assayRuns.push(Object.freeze({
      candidateId,
      plan,
      observation,
      evidenceId,
      ...(evaluation === undefined ? {} : { evaluation }),
      wallMillis,
      ...(physical.cpuMillis === undefined ? {} : { cpuMillis: physical.cpuMillis }),
      ...(physical.writableBytes === undefined ? {} : { writableBytes: physical.writableBytes }),
      ...(physical.writableInodes === undefined ? {} : { writableInodes: physical.writableInodes }),
      artifactBytes,
      artifactStorageBytes,
      costUnitsCharged: plan.costUnits,
      admissible,
      ...(blockedReason === undefined ? {} : { blockedReason }),
    }));
    await this.emit(initial, "embody", "action.status", actorFor(this.admittedForge), {
      actionId: invocation.invocationId,
      actionType: invocation.tool,
      status: rawObservation.status === "not-executed" ? "denied" : executed ? "completed" : "failed",
      summary: `Candidate ${candidateId}, assay ${plan.assayId}: ${rawObservation.summary}`,
      toolId: adapterCapabilitySnapshot(this.admittedForge).id,
      ...(acceptedArtifactMetas.length === 0 ? {} : { artifactDigests: acceptedArtifactMetas.map((entry) => entry.digest).sort() }),
      resource: {
        wallMillis,
        ...(physical.writableBytes === undefined ? {} : { bytesWritten: physical.writableBytes }),
      },
    });
    if (executed && !previousEmbodiment) {
      const blueprintArtifactDigest = state.candidateBlueprints.get(candidateId)?.artifactDigest;
      await this.emit(initial, "embody", "candidate.status", actorFor(this.admittedForge), {
        candidateId,
        status: "embodied",
        summary: "The finite candidate was physically executed in its isolated Forge root; this is not yet survival or selection.",
        artifactDigests: [
          candidateMaterialization.blueprintDigest,
          ...(blueprintArtifactDigest === undefined ? [] : [blueprintArtifactDigest]),
          ...acceptedArtifactMetas.map((entry) => entry.digest),
        ].sort(),
      });
    }
  }

  private async embodyFrontier(initial: CaseStatus, state: RunState, signal: AbortSignal, revision?: RevisionInvocationContext, revisionIds?: readonly string[]): Promise<void> {
    const frontier = state.assayFrontier;
    const candidates = [...state.candidateBlueprints.entries()].filter(([id]) => !revisionIds || revisionIds.includes(id)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    if (revision) await this.commitRevisionPopulation(initial, state, candidates, revision);
    else await this.commitCandidatePopulation(initial, state, candidates);
    if (!frontier || frontier.assays.length === 0 || candidates.length === 0) {
      await this.emit(initial, "embody", "action.status", KERNEL, {
        actionId: stableId("frontier", { runDigest: initial.sealed.runDigest, stage: "embody" }),
        actionType: "assay-frontier.execute",
        status: "denied",
        summary: !frontier || frontier.assays.length === 0
          ? "The sealed Assay Frontier contains no finite assays; no candidate was selected by substitution."
          : "No admissible finite-blueprint candidate exists; nothing was embodied or selected.",
      });
      return;
    }
    if (!state.assayFrontierSealed) {
      for (const [candidateId] of candidates) {
        for (const plan of frontier.assays) {
          await this.recordBlockedAssayRun(
            initial,
            state,
            candidateId,
            plan,
            "The complete Assay Frontier digest was not bound into the policy sealed at Cast.",
          );
        }
      }
      return;
    }
    const ignorePolicy = this.config.candidateIgnorePolicy;
    if (!ignorePolicy || boundCandidateIgnorePolicyDigest(initial, this.config.repository) !== ignorePolicy.sourceDigest) {
      throw new Error("The finite candidate population lost its sealed output-path policy");
    }

    const phenotype = state.phenotype ?? germinatePhenotype(initial.sealed, this.permittedMinds(initial).map(adapterCapabilitySnapshot), frontier.assays.map(assayFamily));
    const aggregate = this.effectiveAssayLimits(state)!;
    const scopedLimits = revision?.resourceCeiling ? Object.freeze({
      maxForgeWallMillis: Math.min(aggregate.maxForgeWallMillis, state.assayUsage.forgeWallMillis + revision.resourceCeiling.maxForgeWallMillis),
      maxForgeCpuMillis: Math.min(aggregate.maxForgeCpuMillis, state.assayUsage.measuredForgeCpuMillis + revision.resourceCeiling.maxForgeCpuMillis),
      maxTotalAssayCost: Math.min(aggregate.maxTotalAssayCost, state.assayUsage.totalAssayCost + revision.resourceCeiling.maxTotalAssayCost),
      maxWritableBytes: Math.min(aggregate.maxWritableBytes, state.assayUsage.writableBytes + revision.resourceCeiling.maxWritableBytes),
      maxWritableInodes: Math.min(aggregate.maxWritableInodes, state.assayUsage.writableInodes + revision.resourceCeiling.maxWritableInodes),
      maxArtifactBytes: Math.min(aggregate.maxArtifactBytes, state.assayUsage.artifactBytes + revision.resourceCeiling.maxArtifactBytes),
    }) : undefined;
    const scheduler = new EvidenceValueScheduler(candidates.map(([id]) => id), frontier.assays, initial.sealed.intentContract, state.experimentCapability, phenotype);
    for (let next = scheduler.next(); next !== undefined; next = scheduler.next()) {
        const { candidateId, plan } = next.cell;
        const blueprint = state.candidateBlueprints.get(candidateId)!;
        const decisionArtifact = await this.config.repository.putArtifact(initial.caseId, `schedule-${next.decision.digest.slice(-24)}.json`, "application/vnd.jevyr.evidence-scheduling+json", Buffer.from(canonicalize(next.decision as unknown as JsonValue)));
        await this.emit(initial, "embody", "action.status", KERNEL, { actionId: next.decision.digest, actionType: "investigation.evidence-schedule", status: "completed", summary: `Selected sealed assay ${plan.assayId} for ${candidateId}: heuristic coverage value ${next.decision.predictedCoverageValue} / cost ${plan.costUnits}, after ${next.decision.observedDecisive} decisive observations. Every baseline cell remains scheduled within the resource envelope.`, artifactDigests: [decisionArtifact.digest] });
        const refusal = this.assayResourceRefusal(state, plan, scopedLimits);
        if (refusal !== undefined) {
          state.assayExhaustionReason ??= refusal;
          await this.recordBlockedAssayRun(initial, state, candidateId, plan, refusal);
          continue;
        }
        const experiment = experimentForPlan(state.experimentCapability, plan);
        if (experiment?.authority === "comparative-only") {
          const readiness = candidateExperimentReadiness(blueprint.blueprint, state.experimentCapability);
          if (!readiness.experimentIds.includes(plan.assayId)) {
            await this.recordBlockedAssayRun(
              initial,
              state,
              candidateId,
              plan,
              `Candidate ${candidateId} is not bound to sealed comparative experiment ${plan.assayId}: ${readiness.problems.join(", ") || "exact socket mismatch"}.`,
            );
            continue;
          }
        }
        const bindingProblem = forgePlanBindingProblem(initial, plan, state.experimentCapability);
        if (bindingProblem !== undefined) {
          await this.recordBlockedAssayRun(initial, state, candidateId, plan, bindingProblem);
          continue;
        }
        // ToolAdapter is intentionally generic and is not trusted to preserve an
        // input tree. Every candidate/assay cell therefore receives a separately
        // reconstructed root and sealed-subject mount.
        const parent = await mkdtemp(join(tmpdir(), "jevyr-frontier-cell-"));
        try {
          const candidateMaterialization = await materializeCandidateBlueprint(blueprint.blueprint, parent, ignorePolicy);
          const subjectRoot = join(parent, "jevyr-subjects");
          const subjectMaterialization = await this.config.repository.materializeSubjectMaterials(
            initial.caseId,
            subjectRoot,
          );
          await this.executeCandidateAssay(
            initial,
            state,
            signal,
            candidateId,
            candidateMaterialization,
            subjectRoot,
            subjectMaterialization,
            plan,
            scopedLimits,
          );
          const observed = state.assayRuns.at(-1);
          if (observed?.candidateId === candidateId && observed.plan.assayId === plan.assayId) scheduler.observe({ candidateId, assayId: plan.assayId, ...(observed.evaluation?.obligationId ? { obligationId: observed.evaluation.obligationId } : {}), decisive: observed.admissible && observed.evaluation?.decisive === true, outcome: observed.evaluation?.status ?? "BLOCKED", costUnits: observed.costUnitsCharged });
          if (!revision) this.refreshInertiaEligibility(initial, state);
        } finally {
          await rm(parent, { recursive: true, force: true });
        }
    }
    if (!revision && revisionInvestigationEnabled(this.config.repository.policyDescriptor)) await this.reviseAfterExecution(initial, state, signal);
  }

  private feedbackInputs(state: RunState): readonly FeedbackInput[] {
    return state.assayRuns.map(run => ({ candidateId: run.candidateId, assayId: run.plan.assayId, observationDigest: this.persistedObservationDigest(state, run.observation),
      observation: run.observation, ...(run.evaluation ? { evaluation: run.evaluation } : {}), admissible: run.admissible, costUnits: run.plan.costUnits }));
  }

  private async commitRevisionPopulation(initial: CaseStatus, state: RunState, candidates: readonly [string, { readonly blueprint: CompiledCandidateBlueprint; readonly artifactDigest: string }][], revision: RevisionInvocationContext): Promise<void> {
    if (!revisionInvestigationEnabled(this.config.repository.policyDescriptor) || candidates.length !== 1 || !state.populationHeadDigest) throw new Error("Revision population lacks its presealed bounded authority");
    const population = { protocol: "jevyr.revision-population/1", caseId: initial.caseId, runDigest: initial.sealed.runDigest,
      assayFrontierDigest: state.assayFrontier?.digest, previousPopulationDigest: state.populationHeadDigest, ordinal: state.revisionWaves + 1, round: revision.round,
      parentCandidateIds: revision.parentCandidateIds, feedbackArtifactDigest: revision.feedbackArtifactDigest, contextDigest: revision.feedback.contextDigest,
      ...(revision.receiptDigest ? { receiptDigest: revision.receiptDigest, inertiaDecisionDigest: revision.inertiaDecisionDigest } : {}), candidates: candidates.map(([candidateId, entry]) => ({ candidateId, blueprintDigest: entry.blueprint.blueprintDigest, blueprintArtifactDigest: entry.artifactDigest })) };
    const artifact = await this.config.repository.putArtifact(initial.caseId, `revision-population-${state.revisionWaves + 1}.json`, REVISION_POPULATION_MEDIA_TYPE, Buffer.from(canonicalize(population as unknown as JsonValue)));
    await this.emit(initial, "embody", "action.status", KERNEL, { actionId: artifact.digest, actionType: "candidate.revision.population.close", status: "completed",
      summary: `Committed one finite revision of ${revision.parentCandidateIds.join(", ")} before executing its original sealed frontier.`, artifactDigests: [artifact.digest] });
    state.populationHeadDigest = artifact.digest; state.revisionWaves++; state.revisionLastCandidateId = candidates[0]![0];
  }

  private async reviseAfterExecution(initial: CaseStatus, state: RunState, signal: AbortSignal): Promise<void> {
    const critical = initial.sealed.intentContract.criticalObligations.map(obligation => obligation.id);
    const juggler = this.jugglerBooks.get(initial.caseId);
    const runRevision = async (parent: string, loop: number, extra?: Pick<RevisionInvocationContext, "receiptDigest" | "receiptSequence" | "inertiaDecisionDigest" | "resourceCeiling">) => {
      const inputs = this.feedbackInputs(state), feedback = executionFeedback(inputs);
      const artifact = await this.config.repository.putArtifact(initial.caseId, `execution-feedback-${state.revisionWaves + 1}.json`, REVISION_FEEDBACK_MEDIA_TYPE, Buffer.from(canonicalize(feedback as unknown as JsonValue)));
      await this.emit(initial, "embody", "action.status", KERNEL, { actionId: artifact.digest, actionType: "investigation.execution-feedback", status: "completed", summary: `Bound ${inputs.length} actual assay observations for a finite inspect-and-revise round; this context grants no new evaluator authority.`, artifactDigests: [artifact.digest] });
      const revision: RevisionInvocationContext = { round: loop + 1, feedback, inputs, parentCandidateIds: [parent], feedbackArtifactDigest: artifact.digest, ...extra };
      const before = new Set(state.candidateBlueprints.keys());
      await this.runMinds(initial, state, "reflex", signal, loop, 1, "the remaining evidence feedback rounds", revision);
      const added = [...state.candidateBlueprints.keys()].filter(id => !before.has(id));
      if (added.length > 0) await this.embodyFrontier(initial, state, signal, revision, added);
      return added.length > 0;
    };
    try {
      for (let loop = 0; loop < this.reflexLoops; loop++) {
      if (state.mindBudget.remaining().maxMindInvocations < 1 || state.assayExhaustionReason || !state.assayFrontier) break;
      const inputs = this.feedbackInputs(state);
      const parent = selectBaselineRevision({ inputs, contract: initial.sealed.intentContract, frontier: state.assayFrontier,
        candidateIds: [...state.candidateBlueprints.keys()], ...(state.revisionLastCandidateId ? { lastRevisionCandidateId: state.revisionLastCandidateId } : {}),
        policyVersion: revisionInvestigationVersion(this.config.repository.policyDescriptor) })?.candidateId;
      if (!parent) break;
      state.reflexMindRoundsUsed++;
      if (!await runRevision(parent, loop)) break;
      }
      if (!juggler) return;
      // Close and await durable admission before the last drain. Every accepted
      // grant now has an explicit execution or failure, even at this boundary.
      await this.prepareMetabolicReproduction(initial, state, "embody");
      await juggler.closeAdmission();
      const grants = await this.admitPendingMetabolic(initial, state, "embody");
      const excluded: string[] = [];
      for (const receipt of grants) {
        try {
          if (receipt.kind !== "Inertia") throw new Error("A nursery-only grant arrived after its admission barrier");
          const decision = planInertiaContinuation(receipt, feedbackScentHistory(this.feedbackInputs(state)), critical, excluded);
          const artifact = await this.config.repository.putArtifact(initial.caseId, `inertia-continuation-${receipt.sequence}.json`, "application/vnd.jevyr.inertia-continuation+json", Buffer.from(canonicalize(decision as unknown as JsonValue)));
          await this.emit(initial, "embody", "action.status", KERNEL, { actionId: decision.digest, actionType: "investigation.inertia-continuation", status: "completed", summary: `Signed Inertia dose lowers the heuristic continuation cutoff from ${decision.baselineThreshold} to ${decision.loweredThreshold} for ${decision.selected.length} observed unresolved scents.`, artifactDigests: [artifact.digest] });
          const unit = Object.fromEntries(Object.entries(receipt.grant).map(([key, value]) => [key, Math.floor(value / receipt.quantity)])) as unknown as NonNullable<RevisionInvocationContext["resourceCeiling"]>;
          for (const scent of decision.selected) {
            excluded.push(scent.candidateId);
            if (state.assayExhaustionReason || state.mindBudget.remaining().maxMindInvocations < 1 || (state.assayFrontier?.assays.reduce((sum, assay) => sum + assay.costUnits, 0) ?? 0) > unit.maxTotalAssayCost) throw new Error("The signed added resource allowance cannot execute this complete sealed frontier");
            const produced = await runRevision(scent.candidateId, Math.min(this.reflexLoops - 1, state.reflexMindRoundsUsed), { receiptDigest: receipt.digest, receiptSequence: receipt.sequence, inertiaDecisionDigest: artifact.digest, resourceCeiling: unit });
            await this.emit(initial, "embody", "action.status", KERNEL, { actionId: stableId("inertia-work", { receipt: receipt.digest, parent: scent.candidateId }), actionType: "metabolism.execution", status: produced ? "completed" : "failed", summary: produced ? "The signed Inertia scent produced one finite revision and executed its original frontier." : "The signed Inertia invocation did not produce an admissible finite revision; no other effect was substituted." });
          }
        } catch (error) {
          await this.emit(initial, "embody", "action.status", KERNEL, { actionId: receipt.digest, actionType: "metabolism.execution", status: "failed", summary: `Signed ${receipt.kind} work could not be fulfilled: ${error instanceof Error ? error.message : "unavailable exact effect"}.` });
        }
      }
    } finally {
      if (juggler) await juggler.closeAdmission();
    }
  }

  private refreshInertiaEligibility(initial: CaseStatus, state: RunState): void {
    const juggler = this.jugglerBooks.get(initial.caseId);
    if (!juggler || !revisionInvestigationEnabled(this.config.repository.policyDescriptor) || this.reflexLoops < 1) return;
    const history = juggler.history(), priorDose = history.at(-1)?.receipt.cumulativeQuantities.Inertia ?? 0;
    const pendingInertia = history.filter(entry => entry.receipt.kind === "Inertia").reduce((sum, entry) => sum + entry.receipt.quantity, 0);
    const available = Math.max(0, maximumInertiaQuantity(feedbackScentHistory(this.feedbackInputs(state)), initial.sealed.intentContract.criticalObligations.map(obligation => obligation.id), priorDose) - pendingInertia);
    juggler.setEligibleKinds(available > 0 ? ["Inertia"] : [], { Inertia: available });
  }

  private async admitPendingMetabolic(initial: CaseStatus, state: RunState, stage: JevyrStage): Promise<readonly MetabolicReceipt[]> {
    const juggler = this.jugglerBooks.get(initial.caseId);
    if (!juggler) return [];
    await this.prepareMetabolicReproduction(initial, state, stage);
    const pending = await juggler.takePendingGrants(), signed = juggler.history();
    for (const receipt of pending) {
      state.mindBudget.admitMetabolicRedemption(signed.find(entry => entry.receipt.digest === receipt.digest)!);
      await this.emit(initial, stage, "action.status", KERNEL, { actionId: receipt.digest, actionType: "metabolism.admitted", status: "completed", summary: `${receipt.kind} signed grant ${receipt.sequence} entered the separate additive scheduler budget.` });
    }
    if (metabolicCheckpointsEnabled(this.config.repository.policyDescriptor)) {
      const cells = executionFeedback(this.feedbackInputs(state)).cells;
      const facts = state.contributions.map(fact => ({ id: fact.id, kind: fact.kind, summary: fact.summary, body: fact.body ?? null, blueprintDigest: fact.blueprintDigest ?? null }));
      const context = { candidates: [...state.candidateBlueprints].map(([id, entry]) => [id, entry.blueprint.blueprintDigest]).sort(), facts, cells } as unknown as JsonValue;
      const counts = new Map<string, number>();
      for (const cell of cells) { const key = canonicalize([cell.assayId, cell.obligationId, cell.status, cell.decisive, cell.costUnits]); counts.set(key, (counts.get(key) ?? 0) + 1); }
      const offers = juggler.offers();
      const structure = { candidateCount: state.candidateBlueprints.size, factKinds: facts.map(fact => fact.kind).sort(), observedCells: [...counts].sort(),
        cumulativeQuantities: offers.cumulativeQuantities, offers: offers.offers.map(offer => ({ kind: offer.kind, maxQuantity: offer.maxQuantity })).sort((a, b) => a.kind.localeCompare(b.kind)) } as unknown as JsonValue;
      const checkpoint = createMetabolicCheckpoint(++state.metabolicCheckpointOrdinal, stage, context, structure, pending);
      const expected = this.metabolicReproductionPlan?.checkpoints[checkpoint.ordinal - 1];
      const plan = this.metabolicReproductionPlan;
      const matches = !plan || (plan.seedMode === "same" ? expected !== undefined && metabolicCheckpointMatches(expected, checkpoint, "same") : pending.every(receipt => metabolicReproductionDoses(plan).some(dose => dose.sequence === receipt.sequence && dose.kind === receipt.kind && dose.quantity === receipt.quantity && dose.stage === stage)));
      const artifact = await this.config.repository.putArtifact(initial.caseId, `metabolic-checkpoint-${checkpoint.ordinal}.json`, METABOLIC_CHECKPOINT_MEDIA_TYPE, Buffer.from(canonicalize(checkpoint as unknown as JsonValue)));
      await this.emit(initial, stage, "action.status", KERNEL, { actionId: checkpoint.digest, actionType: "investigation.metabolic-checkpoint", status: matches ? "completed" : "failed", summary: matches ? `Committed scheduler grant checkpoint ${checkpoint.ordinal}: ${pending.length} fresh admitted receipts.` : "Controlled Juggler reproduction changed its authenticated logical checkpoint context.", artifactDigests: [artifact.digest] });
      if (!matches) throw new Error("METABOLIC_REPRODUCTION_CONTEXT_CHANGED");
    }
    return pending;
  }

  private async prepareMetabolicReproduction(initial: CaseStatus, state: RunState, stage: JevyrStage): Promise<void> {
    const plan = this.metabolicReproductionPlan, expected = plan?.checkpoints[state.metabolicCheckpointOrdinal];
    if (!plan) return;
    const book = this.jugglerBooks.get(initial.caseId);
    if (!book) throw new Error("METABOLIC_REPRODUCTION_CHANNEL_MISSING");
    if (plan.seedMode === "new") {
      for (const dose of metabolicReproductionDoses(plan).filter(dose => !state.reproducedMetabolicSequences.has(dose.sequence))) {
        if (JEVYR_STAGES.indexOf(dose.stage as JevyrStage) < JEVYR_STAGES.indexOf(stage)) throw new Error("METABOLIC_REPRODUCTION_SOURCE_STAGE_MISSED");
        if (dose.stage !== stage) return;
        const offer = book.offers().offers.find(offer => offer.kind === dose.kind && offer.maxQuantity >= dose.quantity);
        if (!offer) return;
        const fresh = await book.redeem({ ballId: offer.ballId, quantity: dose.quantity });
        if (fresh.receipt.sequence !== dose.sequence) throw new Error("METABOLIC_REPRODUCTION_RECEIPT_CHANGED");
        state.reproducedMetabolicSequences.add(dose.sequence);
      }
      return;
    }
    if (!expected || expected.stage !== stage || state.preparedMetabolicCheckpoint === expected.ordinal) return;
    for (const dose of expected.admitted) {
      const offer = book.offers().offers.find(offer => offer.kind === dose.kind && offer.maxQuantity >= dose.quantity);
      if (!offer) throw new Error("METABOLIC_REPRODUCTION_OFFER_CHANGED");
      const fresh = await book.redeem({ ballId: offer.ballId, quantity: dose.quantity });
      if (fresh.receipt.sequence !== dose.sequence || fresh.receipt.runDigest === decodeDsseJson<SignedRecord>(plan.sourceRecordEnvelope).runDigest) throw new Error("METABOLIC_REPRODUCTION_RECEIPT_CHANGED");
      state.reproducedMetabolicSequences.add(dose.sequence);
    }
    state.preparedMetabolicCheckpoint = expected.ordinal;
  }

  private async closeMetabolicInvestigation(initial: CaseStatus, state: RunState): Promise<void> {
    const book = this.jugglerBooks.get(initial.caseId);
    if (!book || !metabolicCheckpointsEnabled(this.config.repository.policyDescriptor)) return;
    await this.prepareMetabolicReproduction(initial, state, "assay"); await book.closeAdmission();
    const pending = await this.admitPendingMetabolic(initial, state, "assay");
    if (pending.length > 0) throw new Error("METABOLIC_UNFULFILLED_FINAL_GRANT");
    if (this.metabolicReproductionPlan && (this.metabolicReproductionPlan.seedMode === "same" && state.metabolicCheckpointOrdinal !== this.metabolicReproductionPlan.checkpoints.length || state.reproducedMetabolicSequences.size !== metabolicReproductionDoses(this.metabolicReproductionPlan).length)) throw new Error("METABOLIC_REPRODUCTION_CHECKPOINTS_INCOMPLETE");
  }

  private assayTelemetry(
    initial: CaseStatus,
    state: RunState,
    usage: MutableAssayUsage = state.assayUsage,
  ): readonly SearchResourceTelemetry[] {
    const mind = state.mindBudget.snapshot();
    return searchResourceTelemetry(state.mindBudget.effectiveEnvelope(), {
      mindInvocations: { used: mind.mindInvocations },
      inputTokens: { used: mind.inputTokens, measurement: mind.inputTokenMeasurement },
      outputTokens: { used: mind.outputTokens, measurement: mind.outputTokenMeasurement },
      wallMillis: { used: mind.wallMillis },
      generatedBytes: { used: mind.generatedBytes },
      forgeWallMillis: { used: usage.forgeWallMillis },
      ...(usage.cpuMeasurements > 0 && !usage.cpuUnmeasured
        ? { forgeCpuMillis: { used: usage.measuredForgeCpuMillis } }
        : {}),
      ...(usage.workspaceUnmeasured
        ? {}
        : {
            writableBytes: { used: usage.writableBytes },
            writableInodes: { used: usage.writableInodes },
          }),
      artifactBytes: { used: usage.artifactBytes },
      totalAssayCost: { used: usage.totalAssayCost },
      concurrentLineages: { used: state.assayRuns.length > 0 ? 1 : 0 },
    });
  }

  private async assayFrontier(initial: CaseStatus, state: RunState): Promise<void> {
    const formalCertificates = formalProofReplayOptions(this.config.repository.policyDescriptor).formalProofKernelDigest === undefined
      ? [] : constructFormalCounterexamples(initial.sealed.intentContract);
    for (const certificate of formalCertificates) {
      await this.emit(initial, "assay", "evidence.observed", KERNEL, {
        evidenceId: stableId("formal-proof", { runDigest: initial.sealed.runDigest, obligationId: certificate.obligationId }),
        evidenceType: "tool_observation",
        summary: "Bone verified the empty finite-sequence counterexample: the exact sealed requirement demands a negative output length. This is a mathematical refutation, not an executed candidate or model opinion.",
        contentDigest: digestJson(certificate as unknown as JsonValue),
        formalProof: certificate,
      });
    }
    const nursery = state.nursery?.nursery;
    const archiveTelemetry = () => ({
      measuredEntries: state.assayArchive.size,
      occupiedNiches: state.assayArchive.niches,
    });
    const prefix: MutableAssayUsage = {
      ...state.observerUsage,
      artifactBytes: Math.max(
        0,
        state.assayUsage.artifactBytes - state.assayRuns.reduce((sum, run) => sum + run.artifactStorageBytes, 0),
      ),
    };
    let executedAttempts = 0;
    for (const run of state.assayRuns) {
      prefix.forgeWallMillis += run.wallMillis;
      prefix.totalAssayCost += run.costUnitsCharged;
      prefix.artifactBytes += run.artifactStorageBytes;
      const executed = run.observation.oracle?.execution.state === "exited";
      if (executed && run.cpuMillis === undefined) prefix.cpuUnmeasured = true;
      else {
        if (run.cpuMillis !== undefined) {
          prefix.cpuMeasurements += 1;
          prefix.measuredForgeCpuMillis += run.cpuMillis;
        }
      }
      if (executed && (run.writableBytes === undefined || run.writableInodes === undefined)) prefix.workspaceUnmeasured = true;
      else {
        if (run.writableBytes !== undefined && run.writableInodes !== undefined) {
          prefix.writableBytes += run.writableBytes;
          prefix.writableInodes += run.writableInodes;
        }
      }
      if (run.costUnitsCharged > 0) executedAttempts += 1;
      const status = run.evaluation?.status === "PASSED" && run.admissible
        ? "passed"
        : run.evaluation?.status === "FAILED" && run.admissible
          ? "failed"
          : run.evaluation?.status === "BLOCKED" || run.observation.status === "not-executed" || !run.admissible
            ? "blocked"
            : "inconclusive";
      await this.emit(initial, "assay", "evidence.observed", actorFor(this.admittedForge), {
        evidenceId: run.evidenceId,
        evidenceType: run.observation.oracle?.execution.state === "exited"
          && run.observation.metadata?.executionAuthorityStatus === "VERIFIED"
          ? "sandbox_execution"
          : "tool_observation",
        summary: `Candidate ${run.candidateId}, assay ${run.plan.assayId}: ${run.evaluation?.reason ?? run.observation.summary}`,
        contentDigest: this.persistedObservationDigest(state, run.observation),
        candidateId: run.candidateId,
        assayId: run.plan.assayId,
      });
      const obligation = resolveForgeObligation(initial, run.plan);
      const assayEventId = stableId("assay", {
        runDigest: initial.sealed.runDigest,
        candidateId: run.candidateId,
        assayId: run.plan.assayId,
      });
      await this.emit(initial, "assay", "assay.status", KERNEL, {
        assayId: assayEventId,
        candidateId: run.candidateId,
        ...(obligation === undefined ? {} : { obligationId: obligation.id }),
        status,
        // Comparative assays cannot decide the Case until an archive survivor is selected.
        critical: false,
        summary: run.evaluation?.reason ?? run.blockedReason ?? run.observation.summary,
        evidenceIds: [run.evidenceId],
      });
      await this.emit(initial, "assay", "search.status", KERNEL, {
        layer: "ASSAY_ARCHIVE",
        status: "exploring",
        candidateId: run.candidateId,
        assayId: run.plan.assayId,
        attempted: executedAttempts,
        attemptSafetyCeiling: initial.sealed.searchEnvelope.profile.attemptSafetyCeiling,
        resources: this.assayTelemetry(initial, state, prefix),
        assayArchive: archiveTelemetry(),
        summary: `Candidate ${run.candidateId}, assay ${run.plan.assayId} closed with ${status}; resource use is cumulative across the sealed frontier.`,
      });
    }

    const candidates = [...state.candidateBlueprints.keys()].sort();
    const archiveOutcomes = new Map<string, {
      readonly reasons: readonly string[];
      readonly contradicted: boolean;
      readonly measurable: boolean;
    }>();
    for (const [ordinal, candidateId] of candidates.entries()) {
      const runs = state.assayRuns.filter((run) => run.candidateId === candidateId);
      const expectedAssays = state.assayFrontier?.assays.length ?? 0;
      const measurable = state.assayExhaustionReason === undefined
        && runs.length === expectedAssays
        && expectedAssays > 0
        && runs.every((run) => run.admissible
        && run.evaluation?.decisive === true
        && run.observation.oracle?.execution.state === "exited"
        && run.writableBytes !== undefined
        && run.writableInodes !== undefined);
      if (!measurable) {
        const reason = state.assayExhaustionReason === undefined
          ? "no complete admissible measured assay set"
          : `the Case-wide frontier was truncated by resource exhaustion: ${state.assayExhaustionReason}`;
        archiveOutcomes.set(candidateId, Object.freeze({
          reasons: Object.freeze([reason]),
          contradicted: false,
          measurable: false,
        }));
        await this.emit(initial, "assay", "search.status", KERNEL, {
          layer: "ASSAY_ARCHIVE",
          status: "completed",
          candidateId,
          attempted: executedAttempts,
          attemptSafetyCeiling: initial.sealed.searchEnvelope.profile.attemptSafetyCeiling,
          resources: this.assayTelemetry(initial, state),
          assayArchive: archiveTelemetry(),
          ...(state.assayExhaustionReason === undefined ? {} : { termination: "RESOURCE_EXHAUSTED" }),
          summary: `Candidate ${candidateId} produced ${reason} and could not enter the archive.`,
        });
        continue;
      }
      const contribution = state.contributions.find((entry) => entry.kind === "candidate" && entry.id === candidateId);
      const evaluation = measuredEvaluation(runs, initial.sealed.searchEnvelope.profile.resources.maxForgeWallMillis);
      const candidate: SearchCandidate = Object.freeze({
        id: candidateId,
        ordinal: ordinal + 1,
        lineage: `assay:${candidateId}`,
        phase: "COEVOLVE",
        parentIds: Object.freeze([...(contribution?.parentIds ?? [])]),
        publicSummary: `Finite candidate ${candidateId} under the sealed Assay Frontier.`,
        payload: {
          candidateId,
          assayFrontierDigest: state.assayFrontier?.digest ?? null,
          observations: runs.map((run) => ({
            assayId: run.plan.assayId,
            observationDigest: observationDigest(run.observation),
            oracleStatus: run.evaluation?.status ?? "NOT_APPLICABLE",
          })),
        },
        descriptor: measuredBehaviorDescriptor(runs, initial.sealed.searchEnvelope.profile.resources.maxForgeWallMillis),
      });
      const decision = state.assayArchive.consider(candidate, evaluation);
      archiveOutcomes.set(candidateId, Object.freeze({
        reasons: decision.reasons,
        contradicted: runs.some((run) => run.admissible && run.evaluation?.status === "FAILED"),
        measurable: true,
      }));
      for (const displaced of decision.displaced) {
        archiveOutcomes.set(displaced.candidate.id, Object.freeze({
          reasons: displaced.reasons,
          contradicted: state.assayRuns.some((run) =>
            run.candidateId === displaced.candidate.id
            && run.admissible
            && run.evaluation?.status === "FAILED"),
          measurable: true,
        }));
      }
      await this.emit(initial, "assay", "search.status", KERNEL, {
        layer: "ASSAY_ARCHIVE",
        status: decision.accepted ? "archive_changed" : "completed",
        candidateId,
        attempted: executedAttempts,
        attemptSafetyCeiling: initial.sealed.searchEnvelope.profile.attemptSafetyCeiling,
        resources: this.assayTelemetry(initial, state),
        assayArchive: {
          ...archiveTelemetry(),
          lastMeasuredNovelty: decision.entry.novelty,
        },
        ...(state.assayExhaustionReason === undefined ? {} : { termination: "RESOURCE_EXHAUSTED" }),
        summary: decision.accepted
          ? `Candidate ${candidateId} changed the measured archive.`
          : `Candidate ${candidateId} remained outside the measured archive.`,
      });
    }

    // Candidate survival is emitted only after the entire archive is closed.
    // A provisional elite displaced by a later candidate therefore never
    // remains a sticky replay survivor.
    const finalArchive = state.assayArchive.entries();
    const survivorIds = new Set(finalArchive.map((entry) => entry.candidate.id));
    for (const candidateId of candidates) {
      const outcome = archiveOutcomes.get(candidateId);
      if (survivorIds.has(candidateId)) {
        await this.emit(initial, "assay", "candidate.status", KERNEL, {
          candidateId,
          status: "survived",
          summary: "The closed measured quality-diversity archive retained this candidate.",
          feasibility: "BUILDABLE_NOW",
        });
      } else {
        await this.emit(initial, "assay", "candidate.status", KERNEL, {
          candidateId,
          status: "invalidated",
          summary: outcome?.measurable === false
            ? "The candidate produced no complete admissible measured assay set."
            : `The closed measured archive did not retain this candidate: ${outcome?.reasons.join("; ") || "no admissible archive entry"}.`,
          ...(outcome?.contradicted === true ? { feasibility: "CONTRADICTED" } : {}),
        });
      }
    }

    const flagship = selectArchiveFlagship(finalArchive);
    if (flagship !== undefined) {
      state.selectedCandidateId = flagship.candidate.id;
      await this.emit(initial, "assay", "candidate.status", KERNEL, {
        candidateId: flagship.candidate.id,
        status: "selected",
        summary: "The flagship was selected only after measured archive admission, by the sealed Pareto ordering.",
        feasibility: "BUILDABLE_NOW",
        parentIds: flagship.candidate.parentIds,
      });
      for (const run of state.assayRuns.filter((entry) => entry.candidateId === flagship.candidate.id)) {
        const obligation = resolveForgeObligation(initial, run.plan);
        if (!obligation || !run.admissible || run.evaluation?.decisive !== true) continue;
        const adjudicativeEvidenceId = stableId("evidence", {
          runDigest: initial.sealed.runDigest,
          candidateId: run.candidateId,
          assayId: run.plan.assayId,
          scope: "selected-candidate",
        });
        await this.emit(initial, "assay", "evidence.observed", actorFor(this.admittedForge), {
          evidenceId: adjudicativeEvidenceId,
          evidenceType: "sandbox_execution",
          summary: `Selected candidate ${run.candidateId}, assay ${run.plan.assayId}: ${run.evaluation.reason}`,
          contentDigest: this.persistedObservationDigest(state, run.observation),
          candidateId: run.candidateId,
          assayId: run.plan.assayId,
          ...(run.evaluation.status === "PASSED" ? { supports: [obligation.id] } : { refutes: [obligation.id] }),
        });
        await this.emit(initial, "assay", "assay.status", KERNEL, {
          assayId: stableId("assay", {
            runDigest: initial.sealed.runDigest,
            candidateId: run.candidateId,
            assayId: run.plan.assayId,
          }),
          candidateId: run.candidateId,
          obligationId: obligation.id,
          status: run.evaluation.status === "PASSED" ? "passed" : "failed",
          critical: true,
          summary: run.evaluation.reason,
          evidenceIds: [adjudicativeEvidenceId],
        });
      }
    }

    if (flagship === undefined && candidates.length > 0 && candidates.every((id) => archiveOutcomes.get(id)?.measurable === true)) {
      const failedRuns = candidates.map((candidateId) => state.assayRuns.find((run) =>
        run.candidateId === candidateId && run.admissible && run.evaluation?.decisive === true
        && run.evaluation.status === "FAILED" && resolveForgeObligation(initial, run.plan)?.critical === true));
      if (failedRuns.every((run) => run !== undefined)) {
        await this.emit(initial, "assay", "assay.status", KERNEL, {
          assayId: stableId("assay", { runDigest: initial.sealed.runDigest, scope: "closed-population" }),
          status: "failed", critical: true, scope: "closed_population", populationIds: candidates,
          summary: "Every finite admitted candidate failed a critical bound assay; the admitted population is exhausted, with no claim about unexamined solutions.",
          evidenceIds: failedRuns.map((run) => run!.evidenceId).sort(),
        });
      }
    }

    const requestedObligations = initial.sealed.intentContract.criticalObligations.filter(
      (obligation) => obligation.origin === "requested_assay",
    );
    for (const obligation of requestedObligations) {
      const covered = state.selectedCandidateId !== undefined && state.assayRuns.some((run) =>
        run.candidateId === state.selectedCandidateId
        && resolveForgeObligation(initial, run.plan)?.id === obligation.id
        && run.admissible
        && run.evaluation?.decisive === true);
      if (covered) continue;
      await this.emit(initial, "assay", "assay.status", KERNEL, {
        assayId: stableId("assay", {
          runDigest: initial.sealed.runDigest,
          candidateId: state.selectedCandidateId ?? null,
          obligationId: obligation.id,
          scope: "uncovered-request",
        }),
        ...(state.selectedCandidateId === undefined ? {} : { candidateId: state.selectedCandidateId }),
        obligationId: obligation.id,
        status: "blocked",
        critical: true,
        summary: `Requested assay remains blocked after the finite frontier: ${obligation.statement}`,
      });
    }

    let events = await this.config.events.read(initial.caseId);
    if (state.assayFrontier !== undefined) {
      const precompileReplay = await this.replayAssayEvidence(
        initial,
        state.assayFrontier,
        events,
        "precompile",
      );
      if (!precompileReplay.replayComplete) {
        throw new Error(
          `Cannot compile policy from unreplayable persisted assay evidence: ${precompileReplay.problems.map((entry) => entry.code).join(", ")}`,
        );
      }
      state.verifiedAuthorityEdges = precompileReplay.verifiedAuthorityEdges;
      state.verifiedOriginalSubjectEdges = precompileReplay.verifiedOriginalSubjectEdges;
      if (precompileReplay.originalSubjectContext) state.originalSubjectContext = precompileReplay.originalSubjectContext;
    }
    const input = this.policyInput(state, events, initial);
    const verdict = compileVerdict(input);
    await this.emit(initial, "assay", "kernel.status", KERNEL, {
      operation: "policy_compiled",
      summary: `The deterministic kernel compiled ${verdict.integrity}/${verdict.creation}/${verdict.embodiment}/${verdict.judgment}.`,
      artifactDigest: digestJson(verdict as unknown as JsonValue),
    });
    if (state.assayFrontier !== undefined) {
      events = await this.config.events.read(initial.caseId);
      const strictReplay = await this.replayAssayEvidence(
        initial,
        state.assayFrontier,
        events,
        "strict",
      );
      if (!strictReplay.replayComplete) {
        throw new Error(
          `Assay closure failed strict persisted-evidence replay: ${strictReplay.problems.map((entry) => entry.code).join(", ")}`,
        );
      }
      state.verifiedAuthorityEdges = strictReplay.verifiedAuthorityEdges;
      state.verifiedOriginalSubjectEdges = strictReplay.verifiedOriginalSubjectEdges;
      if (strictReplay.originalSubjectContext) state.originalSubjectContext = strictReplay.originalSubjectContext;
    }
  }

  private async reflex(initial: CaseStatus, state: RunState): Promise<void> {
    const emitAudit = async (audit: import("@jevyr/protocol").InvestigationAuditReceipt, label: string) => {
      await this.emit(initial, "reflex", "evidence.observed", KERNEL, {
        evidenceId: stableId("reflex-probe", { runDigest: initial.sealed.runDigest, audit: audit as unknown as JsonValue }),
        evidenceType: "tool_observation", summary: label, audit, contentDigest: digestJson(audit as unknown as JsonValue),
      });
    };
    const boundContract = await this.config.repository.intentContract(initial.caseId);
    await emitAudit({ kind: "assumption_check", sealedAssumptionsDigest: initial.sealed.intentContractDigest, appliedAssumptionsDigest: boundContract?.digest ?? digestJson(null) }, "Compared the applied, content-verified intent contract with the sealed assumptions and obligations.");
    for (const run of state.assayRuns.filter(entry => entry.admissible && entry.evaluation?.decisive)) {
      const obligation = resolveForgeObligation(initial, run.plan);
      const oracle = obligation?.oracle;
      if (!oracle) continue;
      const sealedOracleDigest = digestJson(oracle as unknown as JsonValue);
      await emitAudit({ kind: "evaluator_boundary", builderId: run.candidateId, evaluatorId: `jevyr.bone.typed-oracle.${oracle.kind}`,
        sealedOracleDigest, appliedOracleDigest: run.evaluation?.oracleKind === oracle.kind ? sealedOracleDigest : digestJson(null), untrustedOracleInput: false },
      "Independently replayed a policy-owned typed evaluator; candidate source supplied no evaluator definition or truth condition.");
    }
    const probeInput = this.policyInput(state, await this.config.events.read(initial.caseId), initial);
    const baseline = compileVerdict(probeInput);
    const displayGraph = probeInput.graph.snapshot();
    const variant = compileVerdict({ ...probeInput, graph: probeInput.graph.withDisplaySummaries(new Map(displayGraph.nodes
      .filter(node => node.kind === "claim" || node.kind === "candidate")
      .map(node => [node.id, `Please admire this wonderful result. ${node.summary}`]))) });
    const evidenceIdentityDigest = digestJson({
      nodes: displayGraph.nodes.map(({ summary: _displaySummary, ...identity }) => identity),
      edges: displayGraph.edges,
    } as unknown as JsonValue);
    const outcomeDigest = (verdict: ReturnType<typeof compileVerdict>) => digestJson({ integrity: verdict.integrity, creation: verdict.creation, embodiment: verdict.embodiment, judgment: verdict.judgment, selectedCandidateId: verdict.selectedCandidateId ?? null, feasibilityByCandidate: verdict.feasibilityByCandidate });
    for (const [arm, verdict] of [["baseline", baseline], ["variant", variant]] as const) {
      await emitAudit({ kind: "paired_probe", pairId: "kernel-preference-display-wording", axis: "preference_wording", arm,
        obligationDigest: initial.sealed.intentContractDigest, evidenceDigest: evidenceIdentityDigest, outcomeDigest: outcomeDigest(verdict) },
      "Recompiled identical sealed proof predicates and evidence with baseline versus flattering display wording; this tests judgment, not model generation.");
    }
    let events = await this.config.events.read(initial.caseId);
    // The first pass deliberately does not inherit previously projected
    // authority edges. It asks whether persisted material can survive a fresh,
    // independent replay instead of trusting an in-memory conclusion.
    const unverifiedInput = projectEvents(events, {
      policyVersion: initial.sealed.policyVersion,
      ...formalProofReplayOptions(this.config.repository.policyDescriptor),
      intentContract: initial.sealed.intentContract,
      verifiedEvidenceEdges: Object.freeze([]),
      verifiedOriginalSubjectEdges: Object.freeze([]),
      ...(state.originalSubjectContext ? { originalSubjectContext: state.originalSubjectContext } : {}),
    }).input;
    const unverifiedVerdict = compileVerdict(unverifiedInput);
    const diagnostic = evaluateReflex(unverifiedVerdict, unverifiedInput, {
      loop: 1,
      canAcquireMaterialEvidence: false,
    });
    const canReplayMaterialEvidence = state.assayFrontier !== undefined
      && state.verifiedAuthorityEdges.length + state.verifiedOriginalSubjectEdges.length > 0
      && diagnostic.materialFindings.some((finding) => finding.code === "EVIDENCE_AUTHORITY_GAP");
    const first = canReplayMaterialEvidence
      ? evaluateReflex(unverifiedVerdict, unverifiedInput, {
          loop: 1,
          canAcquireMaterialEvidence: true,
        })
      : diagnostic;
    await this.emit(initial, "reflex", "reflex.completed", KERNEL, first);

    if (first.decision === "repeat_once") {
      const actionId = stableId("reflex-evidence-replay", { runDigest: initial.sealed.runDigest, loop: 2 });
      await this.emit(initial, "reflex", "action.status", KERNEL, {
        actionId,
        actionType: "reflex.evidence-replay",
        status: "started",
        summary: "Reflex is independently resolving and replaying the selected candidate's persisted typed evidence once.",
      });
      events = await this.config.events.read(initial.caseId);
      const replay = await this.replayAssayEvidence(
        initial,
        state.assayFrontier as AssayFrontier,
        events,
        "strict",
      );
      if (!replay.replayComplete) {
        throw new Error(
          `Reflex evidence replay failed closed: ${replay.problems.map((entry) => entry.code).join(", ")}`,
        );
      }
      state.verifiedAuthorityEdges = replay.verifiedAuthorityEdges;
      state.verifiedOriginalSubjectEdges = replay.verifiedOriginalSubjectEdges;
      if (replay.originalSubjectContext) state.originalSubjectContext = replay.originalSubjectContext;
      await this.emit(initial, "reflex", "action.status", KERNEL, {
        actionId,
        actionType: "reflex.evidence-replay",
        status: "completed",
        summary: `Reflex independently replayed ${replay.frontierState.observedCellCount} persisted frontier cell${replay.frontierState.observedCellCount === 1 ? "" : "s"}; only verified typed authority edges remain admissible.`,
      });
      events = await this.config.events.read(initial.caseId);
      const finalInput = this.policyInput(state, events, initial);
      const finalVerdict = compileVerdict(finalInput);
      const second = evaluateReflex(finalVerdict, finalInput, {
        loop: 2,
        canAcquireMaterialEvidence: false,
      });
      await this.emit(initial, "reflex", "reflex.completed", KERNEL, second);
    }
    const nursery = state.nursery?.nursery;
    const totalMind = state.mindBudget.snapshot();
    await this.emit(initial, "reflex", "search.status", KERNEL, {
      layer: "ASSAY_ARCHIVE",
      status: "completed",
      attempted: nursery?.attempted ?? 0,
      attemptSafetyCeiling: initial.sealed.searchEnvelope.profile.attemptSafetyCeiling,
      resources: this.assayTelemetry(initial, state),
      hypothesisNursery: {
        exactDistinctHypotheses: nursery?.specimens.length ?? 0,
        scars: nursery?.scars.length ?? 0,
        declaredMechanismLabels: nursery?.declaredMechanisms ?? [],
        exactYieldAge: nursery?.exactYieldAge ?? 0,
      },
      assayArchive: {
        measuredEntries: state.assayArchive.size,
        occupiedNiches: state.assayArchive.niches,
      },
      ...(nursery?.termination === undefined ? {} : { termination: nursery.termination }),
      summary: `Case-wide physics closed at ${totalMind.mindInvocations} Mind invocation${totalMind.mindInvocations === 1 ? "" : "s"} and ${state.assayRuns.length} finite candidate-assay result${state.assayRuns.length === 1 ? "" : "s"}. Counts retain their measured, upper-bound, or declaration-only classification.`,
    });
  }

  private policyInput(state: RunState, events: readonly CaseEvent[], initial: CaseStatus): PolicyInput {
    return projectEvents(events, {
      policyVersion: initial.sealed.policyVersion,
      ...formalProofReplayOptions(this.config.repository.policyDescriptor),
      intentContract: initial.sealed.intentContract,
      verifiedEvidenceEdges: state.verifiedAuthorityEdges,
      verifiedOriginalSubjectEdges: state.verifiedOriginalSubjectEdges,
      ...(state.originalSubjectContext ? { originalSubjectContext: state.originalSubjectContext } : {}),
    }).input;
  }

  private async replayAssayEvidence(
    initial: CaseStatus,
    frontier: AssayFrontier,
    events: readonly CaseEvent[],
    mode: "strict" | "precompile",
  ) {
    const artifactIndex = new Map(
      (await this.config.repository.artifacts(initial.caseId))
        .map((artifact) => [artifact.digest, artifact] as const),
    );
    return await verifyPersistedAssayEvidence(
      events,
      initial.sealed.intentContract,
      frontier,
      this.config.repository.policyDescriptor,
      async (digest) => {
        const metadata = artifactIndex.get(digest);
        if (metadata === undefined) return undefined;
        return (await this.config.repository.artifact(initial.caseId, metadata.id))?.data;
      },
      { mode, trustedRecordKeys: new Map((await this.config.repository.publicTrustBundle()).keys.map(key => [key.keyId, key.publicKeyPem])),
        originalSubject: { ...await this.config.repository.originalSubjectEvidenceContext(initial.caseId),
          ...(this.config.originalSubjectAssets ? { assets: this.config.originalSubjectAssets } : {}) } },
    );
  }

  private async crystallize(initial: CaseStatus, state: RunState): Promise<SignedRecord> {
    const events = await this.config.events.read(initial.caseId);
    const verification = verifyEventChain(events);
    if (!verification.valid || verification.headDigest === null) {
      throw new Error(`Cannot crystallize an invalid event chain: ${verification.problems.map((problem) => problem.code).join(", ")}`);
    }
    if (state.assayFrontier !== undefined) {
      const replay = await this.replayAssayEvidence(
        initial,
        state.assayFrontier,
        events,
        "strict",
      );
      if (!replay.replayComplete) {
        throw new Error(
          `Cannot crystallize unreplayable persisted assay evidence: ${replay.problems.map((entry) => entry.code).join(", ")}`,
        );
      }
      state.verifiedAuthorityEdges = replay.verifiedAuthorityEdges;
      state.verifiedOriginalSubjectEdges = replay.verifiedOriginalSubjectEdges;
      if (replay.originalSubjectContext) state.originalSubjectContext = replay.originalSubjectContext;
    }
    const projection = projectEvents(events, {
      policyVersion: initial.sealed.policyVersion,
      ...formalProofReplayOptions(this.config.repository.policyDescriptor),
      intentContract: initial.sealed.intentContract,
      verifiedEvidenceEdges: state.verifiedAuthorityEdges,
      verifiedOriginalSubjectEdges: state.verifiedOriginalSubjectEdges,
      ...(state.originalSubjectContext ? { originalSubjectContext: state.originalSubjectContext } : {}),
    });
    const input = this.policyInput(state, events, initial);
    const verdict = compileVerdict(input);
    return crystallizeRecord({
      sealed: initial.sealed,
      eventHeadDigest: verification.headDigest,
      verdict,
      reflexReports: projection.reflexReports,
      memoryInfluences: projection.memoryInfluences,
      crystallizedAt: new Date().toISOString(),
    });
  }

  private async fail(initial: CaseStatus, state: RunState, error: unknown): Promise<void> {
    const stage = state.currentStage ?? "self_scan";
    const detail = publicError(error);
    const failed = await this.stageEvent(initial, stage, "failed", `The runtime invalidated the case: ${detail}`).catch(() => undefined);
    let lastSequence = failed?.sequence ?? initial.lastSequence;
    let headDigest = failed?.eventDigest ?? initial.headDigest;
    if (failed === undefined) {
      try {
        const currentSequence = await this.config.events.lastSequence(initial.caseId);
        const terminal = (await this.config.events.list(initial.caseId, Math.max(0, currentSequence - 1), 1)).events.at(-1);
        lastSequence = terminal?.sequence ?? currentSequence;
        headDigest = terminal?.eventDigest ?? headDigest;
      } catch {
        const stored = await this.config.repository.status(initial.caseId);
        lastSequence = stored?.lastSequence ?? lastSequence;
        headDigest = stored?.headDigest ?? headDigest;
      }
    }
    await this.config.repository.updateStatus(initial.caseId, {
      lifecycle: "invalid",
      stage,
      stageStatus: "failed",
      lastSequence,
      headDigest,
      error: detail,
    });
    try {
      await this.config.repository.writeRecoveryRecord(initial.caseId, "RUNTIME_FAILURE");
    } catch {
      // INVALID remains durable. Startup retries an incomplete create-once
      // recovery pair without ever resuming semantic work.
    }
  }

  private async stageEvent(
    initial: CaseStatus,
    stage: JevyrStage,
    status: "entered" | "completed" | "failed",
    summary = stageSummary(stage, status === "entered" ? "entered" : "completed"),
  ): Promise<CaseEvent<"stage.status">> {
    // Update synchronously when the ordered append is requested. A concurrent
    // signed quantity grant must not use a lagging persisted status cache.
    this.requestedStages.set(initial.caseId, stage);
    return await this.emit(initial, stage, "stage.status", KERNEL, {
      stage,
      status,
      summary,
      ...(status === "completed" ? { progress: 1 } : status === "entered" ? { progress: 0 } : {}),
    });
  }

  private async emit<K extends EventKind>(
    initial: CaseStatus,
    stage: JevyrStage,
    kind: K,
    actor: PublicActor,
    payload: EventPayloadByKind[K],
  ): Promise<CaseEvent<K>> {
    return await this.config.events.append({
      caseId: initial.caseId,
      caseDigest: initial.sealed.caseDigest,
      runDigest: initial.sealed.runDigest,
      stage,
      kind,
      actor,
      payload,
    });
  }

  private async persist(
    caseId: string,
    lifecycle: CaseStatus["lifecycle"],
    stage: JevyrStage,
    stageStatus: CaseStatus["stageStatus"],
    event: CaseEvent,
  ): Promise<CaseStatus> {
    return await this.config.repository.updateStatus(caseId, {
      lifecycle,
      stage,
      stageStatus,
      lastSequence: event.sequence,
      headDigest: event.eventDigest,
    });
  }

  private startHeartbeat(
    initial: CaseStatus,
    stage: JevyrStage,
    summary: string,
    adapterId: string,
  ): () => Promise<void> {
    const startedAt = Date.now();
    let tail = Promise.resolve();
    const timer = setInterval(() => {
      tail = tail
        .then(async () => {
          await this.emit(initial, stage, "action.status", { id: adapterId, kind: stage === "embody" ? "forge" : "mind" }, {
            actionId: stableId("heartbeat", { runDigest: initial.sealed.runDigest, stage, adapterId }),
            actionType: stage === "embody" ? "forge.execute" : "mind.contribute",
            status: "started",
            summary,
            resource: { wallMillis: Date.now() - startedAt },
          });
        })
        .catch(() => undefined);
    }, 5_000);
    timer.unref();
    return async () => {
      clearInterval(timer);
      await tail;
    };
  }
}
import { indexSealedCode } from "./code-index.js";
