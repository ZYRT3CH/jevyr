import {
  assertIntentContract,
  compileVerdict,
  formalProofReplayOptions,
  originalSubjectKernelDigestFromPolicyDescriptor,
  ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST,
  ORIGINAL_SUBJECT_POLICY_VERSION,
  parseJsonBytes,
  projectEvents,
  verifyEventChain,
  type VerifiedEvidenceEdge,
  type OriginalSubjectContext,
} from "@jevyr/core";
import {
  assertIntentContractShape,
  canonicalize,
  digestJson,
  isSha256Digest,
  sha256Digest,
  type CaseEvent,
  type IntentContract,
  type IntentObligation,
  type JsonValue,
  type SearchResourceTelemetry,
  type SearchResourceEnvelope,
  type MetabolicResourceVector,
} from "@jevyr/protocol";
import {
  QualityDiversityArchive,
  selectArchiveFlagship,
  type BehaviorDescriptor,
  type CandidateEvaluation,
  type SearchCandidate,
} from "@jevyr/growth";
import {
  verifyAssayFrontier,
  type AssayFrontier,
  type SealedAssayPlan,
} from "./assay-frontier.js";
import { verifyCandidateBlueprint, type CompiledCandidateBlueprint } from "./candidate-blueprints.js";
import { decodeToolObservation, toolObservationOutputBytes } from "./evidence-artifacts.js";
import type { ToolObservation } from "./contracts.js";
import { verifyForgeExecutionAuthority } from "./forge-authority.js";
import { decodePublicIdea } from "./public-ideas.js";
import { replayMetabolicGrants } from "./metabolism-replay.js";
import { replayRepositoryObservers } from "./repository-observer-replay.js";
import { replayOriginalSubjectCertificates, type OriginalSubjectCertificateContext, type OriginalSubjectCertificateReplay } from "./original-subject-certificate.js";
import { executionFeedback, feedbackScentHistory, revisionInvestigationEnabled, revisionInvestigationVersion, type FeedbackInput } from "./revision-investigation.js";
import { selectBaselineRevision } from "./baseline-revision.js";
import { assessEvidenceScents, assertInertiaContinuationDecision, INERTIA_SCENT_POLICY, type InertiaContinuationDecision } from "./inertia-scent.js";
import { createMetabolicCheckpoint, metabolicCheckpointMatches, metabolicCheckpointsEnabled, metabolicReproductionDoses, verifyMetabolicReproductionPlan, type MetabolicCheckpoint, type MetabolicReproductionPlan } from "./metabolic-reproduction.js";
import {
  compileJevyrIgnorePolicy,
  MAX_JEVYR_IGNORE_BYTES,
  type JevyrIgnorePolicy,
} from "./ignore-policy.js";
import {
  evaluateForgeOracle,
  parseStrictOracleCommand,
  type ForgeOracleEvaluation,
  type ForgeOracleObservation,
  type SealedForgeOraclePlan,
} from "./typed-oracles.js";
import { stableId } from "./canonical.js";
import {
  candidateExperimentReadiness,
  compileExperimentCapability,
  evaluateComparativeExperiment,
  experimentForPlan,
  type ExperimentCapability,
} from "./experiment-capability.js";

export const PERSISTED_ASSAY_EVIDENCE_REPLAY_PROTOCOL =
  "jevyr.persisted-assay-evidence-replay/1" as const;

export type PersistedAssayEvidenceReplayMode = "strict" | "precompile";

export interface PersistedAssayEvidenceReplayOptions {
  /**
   * `precompile` closes the bootstrapping cycle by requiring that no
   * policy_compiled marker exists yet. The default `strict` mode requires and
   * independently validates that marker.
   */
  readonly mode?: PersistedAssayEvidenceReplayMode;
  readonly trustedRecordKeys?: ReadonlyMap<string, string>;
  readonly originalSubject?: OriginalSubjectCertificateContext;
}

/** Resolves the exact canonical bytes addressed by an evidence content digest. */
export type AssayEvidenceArtifactResolver = (
  digest: string,
) => Promise<Uint8Array | undefined>;

export type PersistedAssayEvidenceProblemCode =
  | "INVALID_EVENT_CHAIN"
  | "INVALID_SANDBOX_EVENT"
  | "CELL_ARTIFACT_CONFLICT"
  | "ARTIFACT_RESOLUTION_FAILED"
  | "ARTIFACT_NOT_FOUND"
  | "ARTIFACT_DIGEST_MISMATCH"
  | "ARTIFACT_DECODE_FAILED"
  | "OBSERVATION_SCOPE_MISMATCH"
  | "FRONTIER_BINDING_MISMATCH"
  | "CANDIDATE_IGNORE_POLICY_MISMATCH"
  | "CANDIDATE_BLUEPRINT_POLICY_MISMATCH"
  | "PLAN_BINDING_MISMATCH"
  | "OBLIGATION_BINDING_MISMATCH"
  | "ORACLE_EVIDENCE_MISMATCH"
  | "ORACLE_EVALUATION_FAILED"
  | "PROCESS_OUTPUT_ACCOUNTING_MISMATCH"
  | "TYPED_STATUS_MISMATCH"
  | "AGGREGATE_ADMISSIBILITY_MISMATCH"
  | "EVIDENCE_EDGE_MISMATCH"
  | "MATRIX_INCOMPLETE"
  | "CELL_EVENT_MISMATCH"
  | "RESOURCE_ACCOUNTING_MISMATCH"
  | "METABOLIC_GRANT_INVALID"
  | "REPOSITORY_OBSERVER_INVALID"
  | "ORIGINAL_SUBJECT_CERTIFICATE_INVALID"
  | "UNSUPPORTED_ORIGINAL_SUBJECT_KERNEL"
  | "EXHAUSTION_MISMATCH"
  | "ARCHIVE_STATE_MISMATCH"
  | "STATUS_ORDER_MISMATCH"
  | "FLAGSHIP_MISMATCH";

export interface PersistedAssayEvidenceProblem {
  readonly code: PersistedAssayEvidenceProblemCode;
  readonly sequence: number;
  readonly evidenceId?: string;
  readonly contentDigest?: string;
  readonly message: string;
}

export interface ReplayedAssayEvidence {
  readonly sequence: number;
  readonly eventDigest: string;
  readonly evidenceId: string;
  readonly contentDigest: string;
  readonly candidateId?: string;
  readonly assayId?: string;
  readonly obligationId?: string;
  readonly status: "VERIFIED" | "REJECTED";
  readonly recordedTypedStatus?: "PASSED" | "FAILED" | "BLOCKED";
  readonly aggregateAdmissible?: boolean;
  readonly authorityEdge?: "NONE" | "SUPPORT" | "REFUTE";
  readonly evaluation?: ForgeOracleEvaluation;
  readonly problemCodes: readonly PersistedAssayEvidenceProblemCode[];
}

export interface ReplayedAssayCell {
  readonly candidateId: string;
  readonly assayId: string;
  readonly evidenceId?: string;
  readonly contentDigest?: string;
  readonly evidenceType?: "sandbox_execution" | "tool_observation";
  readonly status: "VERIFIED" | "REJECTED" | "MISSING";
  readonly expectedAssayStatus?: "passed" | "failed" | "inconclusive" | "blocked";
  readonly aggregateAdmissible?: boolean;
  readonly costUnitsCharged: number;
  readonly wallMillis: number;
  readonly artifactBytes: number;
  readonly problemCodes: readonly PersistedAssayEvidenceProblemCode[];
}

export interface ReplayedAssayFrontierState {
  readonly candidateIds: readonly string[];
  readonly assayIds: readonly string[];
  readonly expectedCellCount: number;
  readonly observedCellCount: number;
  readonly matrixComplete: boolean;
  readonly resourceExhausted: boolean;
  readonly attempted: number;
  readonly aggregateUsage: Readonly<{
    forgeWallMillis: number;
    forgeCpuMillis: number | null;
    writableBytes: number | null;
    writableInodes: number | null;
    artifactBytes: number;
    totalAssayCost: number;
  }>;
  readonly survivorCandidateIds: readonly string[];
  readonly selectedCandidateId?: string;
  readonly cells: readonly ReplayedAssayCell[];
}

/**
 * This is an integrity/replay report for persisted evidence, not a Case verdict.
 * `verifiedArtifactDigests` is a canonical sorted set represented as an array so
 * callers cannot mutate a nominally frozen JavaScript Set.
 */
export interface PersistedAssayEvidenceReplayReport {
  readonly protocol: typeof PERSISTED_ASSAY_EVIDENCE_REPLAY_PROTOCOL;
  readonly mode: PersistedAssayEvidenceReplayMode;
  readonly intentContractDigest: string;
  readonly assayFrontierDigest: string;
  readonly eventHeadDigest: string | null;
  readonly sandboxExecutionCount: number;
  readonly replayComplete: boolean;
  readonly verifiedArtifactDigests: readonly string[];
  /** Empty unless the entire persisted transcript independently replays cleanly. */
  readonly verifiedAuthorityEdges: readonly VerifiedEvidenceEdge[];
  /** Separate original-capture authority. Never merges into candidate edges. */
  readonly verifiedOriginalSubjectEdges: readonly VerifiedEvidenceEdge[];
  readonly originalSubjectContext?: OriginalSubjectContext;
  readonly evidence: readonly ReplayedAssayEvidence[];
  readonly frontierState: ReplayedAssayFrontierState;
  readonly problems: readonly PersistedAssayEvidenceProblem[];
  readonly digest: string;
}

interface ReplayContext {
  readonly contract: IntentContract;
  readonly frontier: AssayFrontier;
  readonly policyDescriptor: unknown;
  readonly plansById: ReadonlyMap<string, SealedAssayPlan>;
  readonly experimentCapability: ExperimentCapability;
  readonly conflictingCells: ReadonlySet<string>;
  readonly resolve: AssayEvidenceArtifactResolver;
}

interface EventReplayResult {
  readonly entry: ReplayedAssayEvidence;
  readonly problems: readonly PersistedAssayEvidenceProblem[];
  readonly observation?: ToolObservation;
  readonly obligation?: IntentObligation;
  readonly plan?: SealedAssayPlan;
  readonly cellKind?: "authoritative-execution" | "comparative-experiment" | "diagnostic-invocation" | "blocked-refusal";
}

type TypedOracleStatus = "PASSED" | "FAILED" | "BLOCKED";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function problem(
  event: CaseEvent<"evidence.observed">,
  code: PersistedAssayEvidenceProblemCode,
  message: string,
): PersistedAssayEvidenceProblem {
  return Object.freeze({
    code,
    sequence: event.sequence,
    evidenceId: event.payload.evidenceId,
    contentDigest: event.payload.contentDigest,
    message,
  });
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...new Set(values)].sort());
}

function processOutputAccountingProblem(observation: ToolObservation): string | undefined {
  const execution = observation.oracle?.execution;
  if (execution === undefined) return undefined;
  const stdout = execution.stdoutCapture;
  const stderr = execution.stderrCapture;
  if (stdout === undefined && stderr === undefined && execution.mode !== "docker") return undefined;
  if (stdout === undefined || stderr === undefined) {
    return "The persisted process execution does not preserve exact stdout and stderr byte captures.";
  }
  let observedBytes: number;
  try {
    observedBytes = toolObservationOutputBytes(observation);
  } catch {
    return "The persisted process execution contains invalid exact byte captures.";
  }
  const metadata = isRecord(observation.metadata) ? observation.metadata : undefined;
  const accounting = isRecord(metadata?.resourceAccounting) ? metadata.resourceAccounting : undefined;
  const processOutput = isRecord(accounting?.processOutput) ? accounting.processOutput : undefined;
  const retainedBytes = stdout.byteLength + stderr.byteLength;
  const capturesComplete = stdout.complete && stderr.complete;
  if (accounting?.protocol !== "jevyr.forge-resource-accounting/1"
    || processOutput?.measurement !== "MEASURED"
    || processOutput.complete !== true
    || processOutput.usedBytes !== observedBytes
    || processOutput.stdoutBytes !== stdout.observedByteLength
    || processOutput.stderrBytes !== stderr.observedByteLength
    || processOutput.retainedBytes !== retainedBytes
    || processOutput.exactCapturesComplete !== capturesComplete
    || !Number.isSafeInteger(processOutput.ceilingBytes)
    || (processOutput.ceilingBytes as number) < 0) {
    return "Forge resource accounting does not equal the actual observed and retained process bytes.";
  }
  return undefined;
}

function forgeArgv(plan: SealedAssayPlan): readonly string[] | undefined {
  const command = plan.args.command;
  const args = plan.args.args;
  if (typeof command !== "string" || command.length === 0) return undefined;
  if (args !== undefined && (!Array.isArray(args) || args.some((entry) => typeof entry !== "string"))) {
    return undefined;
  }
  return Object.freeze([command, ...((args ?? []) as readonly string[])]);
}

function resolveObligation(
  contract: IntentContract,
  plan: SealedAssayPlan,
): IntentObligation | undefined {
  if (plan.obligationId !== undefined) {
    const explicit = contract.criticalObligations.find((entry) => entry.id === plan.obligationId);
    return explicit?.assayability === "ASSAYABLE" && explicit.oracle !== undefined
      ? explicit
      : undefined;
  }

  const argv = forgeArgv(plan);
  if (argv === undefined) return undefined;
  const matches = contract.criticalObligations.filter((entry) => {
    if (entry.assayability !== "ASSAYABLE" || entry.oracle?.kind !== "command_exit_code") return false;
    const expected = parseStrictOracleCommand(entry.oracle.operand);
    return expected?.length === argv.length
      && expected.every((part, index) => part === argv[index]);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function oraclePlan(
  plan: SealedAssayPlan,
  obligationId: string,
): SealedForgeOraclePlan | undefined {
  const argv = forgeArgv(plan);
  const command = argv?.[0];
  if (argv === undefined || command === undefined) return undefined;
  return Object.freeze({
    tool: "forge.command",
    obligationId,
    command,
    args: Object.freeze(argv.slice(1)),
    shell: false,
    ...(plan.sealedSubjectDigest === undefined
      ? {}
      : { sealedSubjectDigest: plan.sealedSubjectDigest }),
    ...(plan.sealedTestSuite === undefined ? {} : { sealedTestSuite: plan.sealedTestSuite }),
    ...(plan.requestedAssay === undefined ? {} : { requestedAssay: plan.requestedAssay }),
  });
}

function specializedEvidenceProblem(
  obligation: IntentObligation,
  plan: SealedAssayPlan,
  observation: ForgeOracleObservation,
): string | undefined {
  const kind = obligation.oracle?.kind;
  const testSuite = observation.testSuite;
  const requestedAssay = observation.requestedAssay;
  const subjectBoundary = observation.subjectBoundary;
  if (testSuite !== undefined && !isRecord(testSuite)) {
    return "The persisted test-suite evidence is not a structured typed report.";
  }
  if (requestedAssay !== undefined && !isRecord(requestedAssay)) {
    return "The persisted requested-assay evidence is not a structured typed result.";
  }
  if (subjectBoundary !== undefined && !isRecord(subjectBoundary)) {
    return "The persisted subject-boundary evidence is not a structured boundary report.";
  }
  if (kind !== "sealed_test_suite" && plan.sealedTestSuite !== undefined) {
    return "The frontier plan binds a sealed test suite to an unrelated oracle kind.";
  }
  if (kind !== "requested_assay" && plan.requestedAssay !== undefined) {
    return "The frontier plan binds a requested assay evaluator to an unrelated oracle kind.";
  }
  if (kind !== "sealed_test_suite" && testSuite !== undefined) {
    return "The persisted observation carries test-suite evidence for an unrelated oracle kind.";
  }
  if (kind !== "requested_assay" && requestedAssay !== undefined) {
    return "The persisted observation carries requested-assay evidence for an unrelated oracle kind.";
  }

  if (kind === "sealed_test_suite") {
    if (plan.sealedTestSuite === undefined || testSuite === undefined) {
      return "The sealed-test-suite oracle is missing its exact plan or persisted typed report.";
    }
    if (testSuite.suiteDigest !== plan.sealedTestSuite.suiteDigest) {
      return "The persisted test report names a different sealed suite digest.";
    }
  }

  if (kind === "requested_assay") {
    if (plan.requestedAssay === undefined || requestedAssay === undefined) {
      return "The requested-assay oracle is missing its exact evaluator plan or persisted typed result.";
    }
    if (
      requestedAssay.definitionDigest !== plan.requestedAssay.definitionDigest
      || requestedAssay.evaluatorDigest !== plan.requestedAssay.evaluatorDigest
    ) {
      return "The persisted requested-assay result names a different definition or evaluator digest.";
    }
  }

  if (kind === "sealed_subject_digest") {
    if (plan.sealedSubjectDigest === undefined || subjectBoundary === undefined) {
      return "The sealed-subject oracle is missing its plan digest or persisted boundary evidence.";
    }
    if (subjectBoundary.captureDigest !== plan.sealedSubjectDigest) {
      return "The persisted subject boundary names a different sealed capture digest.";
    }
  } else if (
    plan.sealedSubjectDigest !== undefined
    && subjectBoundary !== undefined
    && subjectBoundary.captureDigest !== plan.sealedSubjectDigest
  ) {
    return "Ambient subject-boundary evidence does not match the frontier's sealed subject digest.";
  }
  return undefined;
}

function authorityEdgeProblem(
  event: CaseEvent<"evidence.observed">,
  obligation: IntentObligation,
  evaluation: ForgeOracleEvaluation,
  typedStatus: TypedOracleStatus,
  aggregateAdmissible: boolean,
): { readonly edge: "NONE" | "SUPPORT" | "REFUTE"; readonly message?: string } {
  const supports = event.payload.supports ?? [];
  const refutes = event.payload.refutes ?? [];
  if (supports.length === 0 && refutes.length === 0) return { edge: "NONE" };
  if (supports.length > 0 && refutes.length > 0) {
    return { edge: "NONE", message: "One persisted observation cannot both support and refute." };
  }
  if (!aggregateAdmissible) {
    return { edge: "NONE", message: "Aggregate-inadmissible evidence cannot carry an authority edge." };
  }

  if (supports.length > 0) {
    if (
      supports.length !== 1
      || supports[0] !== obligation.id
      || typedStatus !== "PASSED"
      || evaluation.status !== "PASSED"
    ) {
      return {
        edge: "NONE",
        message: "Support must name only the exact obligation and is permitted only for a replayed PASSED oracle.",
      };
    }
    return { edge: "SUPPORT" };
  }

  if (
    refutes.length !== 1
    || refutes[0] !== obligation.id
    || typedStatus !== "FAILED"
    || evaluation.status !== "FAILED"
  ) {
    return {
      edge: "NONE",
      message: "Refutation must name only the exact obligation and is permitted only for a replayed FAILED oracle.",
    };
  }
  return { edge: "REFUTE" };
}

function rejectedEntry(
  event: CaseEvent<"evidence.observed">,
  problems: readonly PersistedAssayEvidenceProblem[],
  partial: Partial<Pick<
    ReplayedAssayEvidence,
    "obligationId" | "recordedTypedStatus" | "aggregateAdmissible" | "authorityEdge" | "evaluation"
  >> = {},
): ReplayedAssayEvidence {
  return Object.freeze({
    sequence: event.sequence,
    eventDigest: event.eventDigest,
    evidenceId: event.payload.evidenceId,
    contentDigest: event.payload.contentDigest,
    ...(event.payload.candidateId === undefined ? {} : { candidateId: event.payload.candidateId }),
    ...(event.payload.assayId === undefined ? {} : { assayId: event.payload.assayId }),
    ...partial,
    status: "REJECTED",
    problemCodes: sortedUnique(problems.map((entry) => entry.code)),
  });
}

async function replayEvent(
  event: CaseEvent<"evidence.observed">,
  context: ReplayContext,
  diagnostic = false,
): Promise<EventReplayResult> {
  const problems: PersistedAssayEvidenceProblem[] = [];
  const candidateId = event.payload.candidateId;
  const assayId = event.payload.assayId;
  if (
    event.stage !== "assay"
    || event.actor.kind !== "forge"
    || event.payload.evidenceType !== (diagnostic ? "tool_observation" : "sandbox_execution")
    || (diagnostic && hasAuthorityEdge(event))
    || typeof candidateId !== "string"
    || candidateId.length === 0
    || typeof assayId !== "string"
    || assayId.length === 0
    || !isSha256Digest(event.payload.contentDigest)
  ) {
    problems.push(problem(
      event,
      "INVALID_SANDBOX_EVENT",
      diagnostic
        ? "An executed diagnostic cell must be an edge-free assay-stage Forge tool_observation with candidate, assay, and SHA-256 scope."
        : "A sandbox_execution must be an assay-stage Forge event with candidate, assay, and SHA-256 scope.",
    ));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }

  if (context.conflictingCells.has(`${candidateId}\u0000${assayId}`)) {
    problems.push(problem(
      event,
      "CELL_ARTIFACT_CONFLICT",
      "The public ledger assigns more than one observation artifact to the same candidate-assay cell.",
    ));
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = await context.resolve(event.payload.contentDigest);
  } catch {
    problems.push(problem(
      event,
      "ARTIFACT_RESOLUTION_FAILED",
      "The evidence artifact resolver failed without yielding exact bytes.",
    ));
  }
  if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
    problems.push(problem(
      event,
      "ARTIFACT_RESOLUTION_FAILED",
      "The evidence artifact resolver returned a value other than Uint8Array bytes.",
    ));
    bytes = undefined;
  }
  if (bytes === undefined && !problems.some((entry) => entry.code === "ARTIFACT_RESOLUTION_FAILED")) {
    problems.push(problem(event, "ARTIFACT_NOT_FOUND", "The referenced evidence artifact is missing."));
  }
  if (bytes === undefined) {
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }
  if (sha256Digest(bytes) !== event.payload.contentDigest) {
    problems.push(problem(
      event,
      "ARTIFACT_DIGEST_MISMATCH",
      "Resolved evidence bytes do not match the event's content digest.",
    ));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }

  let observation;
  try {
    observation = decodeToolObservation(bytes);
  } catch {
    problems.push(problem(
      event,
      "ARTIFACT_DECODE_FAILED",
      "The referenced bytes are not one canonical, valid ToolObservation artifact.",
    ));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }

  const metadata = isRecord(observation.metadata) ? observation.metadata : undefined;
  const expectedInvocationId = stableId("invocation", {
    runDigest: event.runDigest,
    candidateId,
    assayId,
  });
  if (
    observation.invocationId !== expectedInvocationId
    || metadata?.candidateId !== candidateId
    || metadata?.assayId !== assayId
    || !isSha256Digest(metadata?.candidateBlueprintDigest)
    || !isSha256Digest(metadata?.candidateMaterializationDigest)
    || !isSha256Digest(metadata?.subjectMaterializationDigest)
  ) {
    problems.push(problem(
      event,
      "OBSERVATION_SCOPE_MISMATCH",
      "The persisted ToolObservation is not bound to the exact invocation, candidate, assay, blueprint, and materializations.",
    ));
  }
  if (metadata?.assayFrontierDigest !== context.frontier.digest) {
    problems.push(problem(
      event,
      "FRONTIER_BINDING_MISMATCH",
      "The persisted ToolObservation is not bound to the exact Assay Frontier.",
    ));
  }

  const plan = context.plansById.get(assayId);
  if (plan === undefined) {
    problems.push(problem(
      event,
      "PLAN_BINDING_MISMATCH",
      "The event assay does not exist in the exact Assay Frontier.",
    ));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }
  if (metadata?.planDigest !== digestJson(plan as unknown as JsonValue) || metadata?.planBoundAtSeal !== true) {
    problems.push(problem(
      event,
      "PLAN_BINDING_MISMATCH",
      "The persisted ToolObservation does not bind the exact pre-Cast frontier plan.",
    ));
  }

  const obligation = resolveObligation(context.contract, plan);
  const sealedOraclePlan = obligation === undefined ? undefined : oraclePlan(plan, obligation.id);
  const experiment = experimentForPlan(context.experimentCapability, plan);
  const comparativeExperiment = experiment?.authority === "comparative-only" ? experiment : undefined;
  if ((obligation === undefined && comparativeExperiment === undefined)
    || (obligation !== undefined && sealedOraclePlan === undefined)) {
    problems.push(problem(
      event,
      "OBLIGATION_BINDING_MISMATCH",
      "The frontier plan resolves to neither one assayable obligation nor a sealed comparative experiment socket.",
    ));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }

  const hasStructuredOracle = isRecord(observation.oracle) && isRecord(observation.oracle.execution);
  if (!hasStructuredOracle && !diagnostic) {
    problems.push(problem(
      event,
      "ORACLE_EVIDENCE_MISMATCH",
      "The persisted ToolObservation has no structured Forge oracle execution.",
    ));
    return {
      entry: rejectedEntry(event, problems, obligation === undefined ? {} : { obligationId: obligation.id }),
      problems: Object.freeze(problems),
    };
  }
  const oracleObservation = hasStructuredOracle
    ? observation.oracle as ForgeOracleObservation
    : undefined;
  const processOutputProblem = processOutputAccountingProblem(observation);
  if (processOutputProblem !== undefined) {
    problems.push(problem(
      event,
      "PROCESS_OUTPUT_ACCOUNTING_MISMATCH",
      processOutputProblem,
    ));
  }
  const executionAuthority = oracleObservation === undefined
    ? undefined
    : verifyForgeExecutionAuthority(context.policyDescriptor, oracleObservation);
  if (diagnostic) {
    const authorityDigestValid = executionAuthority?.verified === true
      ? metadata?.executionAuthorityDigest === executionAuthority.authority?.digest
      : metadata?.executionAuthorityDigest === undefined;
    if (metadata?.executionAuthorityStatus !== "BLOCKED" || !authorityDigestValid) {
      problems.push(problem(
        event,
        "ORACLE_EVIDENCE_MISMATCH",
        "A diagnostic invocation must remain BLOCKED and may bind only an independently reproduced Docker authority digest.",
      ));
    }
  } else {
    if (executionAuthority?.verified !== true) {
      problems.push(problem(
        event,
        "ORACLE_EVIDENCE_MISMATCH",
        `The persisted execution has no policy-bound Forge authority: ${executionAuthority?.reason ?? "no structured execution"}`,
      ));
    } else if (metadata?.executionAuthorityStatus !== "VERIFIED"
      || metadata?.executionAuthorityDigest !== executionAuthority.authority?.digest) {
      problems.push(problem(
        event,
        "ORACLE_EVIDENCE_MISMATCH",
        "The persisted observation does not bind the independently replayed Forge execution authority.",
      ));
    }
  }
  if (oracleObservation !== undefined) {
    const specializedProblem = obligation === undefined
      ? oracleObservation.testSuite !== undefined || oracleObservation.requestedAssay !== undefined
        ? "A comparative experiment carried specialized evaluator evidence despite having no Intent authority."
        : undefined
      : specializedEvidenceProblem(obligation, plan, oracleObservation);
    if (specializedProblem !== undefined) {
      problems.push(problem(event, "ORACLE_EVIDENCE_MISMATCH", specializedProblem));
    }
    if (
      oracleObservation.subjectBoundary !== undefined
      && oracleObservation.subjectBoundary.materializationDigest !== metadata?.subjectMaterializationDigest
    ) {
      problems.push(problem(
        event,
        "ORACLE_EVIDENCE_MISMATCH",
        "The subject-boundary report does not match the observation's reconstructed materialization digest.",
      ));
    }
  }

  let evaluation: ForgeOracleEvaluation | undefined;
  if (oracleObservation !== undefined) {
    try {
      evaluation = obligation === undefined && comparativeExperiment !== undefined
        ? evaluateComparativeExperiment(comparativeExperiment, oracleObservation)
        : obligation !== undefined && sealedOraclePlan !== undefined
          ? evaluateForgeOracle(obligation, sealedOraclePlan, oracleObservation)
          : undefined;
    } catch {
      if (!diagnostic) {
        problems.push(problem(
          event,
          "ORACLE_EVALUATION_FAILED",
          "The persisted oracle object could not be evaluated as finite typed evidence.",
        ));
        return {
          entry: rejectedEntry(event, problems, obligation === undefined ? {} : { obligationId: obligation.id }),
          problems: Object.freeze(problems),
        };
      }
    }
  }

  const typedStatusValue = metadata?.typedOracleStatus;
  const typedStatus: TypedOracleStatus | undefined =
    typedStatusValue === "PASSED" || typedStatusValue === "FAILED" || typedStatusValue === "BLOCKED"
      ? typedStatusValue
      : undefined;
  const aggregateAdmissible = metadata?.aggregateAdmissible;
  if (metadata?.admissible !== undefined && typeof metadata.admissible !== "boolean") {
    problems.push(problem(
      event,
      "AGGREGATE_ADMISSIBILITY_MISMATCH",
      "The adapter admissibility flag must be boolean when present.",
    ));
  }
  if (typedStatus === undefined) {
    problems.push(problem(
      event,
      "TYPED_STATUS_MISMATCH",
      "The persisted ToolObservation has no valid typed oracle status.",
    ));
  } else if (evaluation !== undefined && (
    typedStatus !== evaluation.status
    && !(typedStatus === "BLOCKED" && evaluation.decisive)
  )
  ) {
    problems.push(problem(
      event,
      "TYPED_STATUS_MISMATCH",
      "The recorded typed status does not match replay (except a conservative aggregate BLOCKED downgrade).",
    ));
  }

  if (typeof aggregateAdmissible !== "boolean" || typedStatus === undefined) {
    problems.push(problem(
      event,
      "AGGREGATE_ADMISSIBILITY_MISMATCH",
      "The persisted ToolObservation has no boolean aggregate-admissibility binding.",
    ));
  } else {
    const expectedAggregate = typedStatus !== "BLOCKED" && metadata?.admissible !== false;
    if (
      aggregateAdmissible !== expectedAggregate
      || (aggregateAdmissible && (evaluation === undefined || !evaluation.decisive || typedStatus !== evaluation.status))
    ) {
      problems.push(problem(
        event,
        "AGGREGATE_ADMISSIBILITY_MISMATCH",
        "Aggregate admissibility is inconsistent with typed replay or the adapter's explicit admissibility boundary.",
      ));
    }
  }
  if (diagnostic && (typedStatus !== "BLOCKED" || aggregateAdmissible !== false)) {
    problems.push(problem(
      event,
      "AGGREGATE_ADMISSIBILITY_MISMATCH",
      "An executed non-authoritative diagnostic must be forced to typed BLOCKED and aggregate-inadmissible.",
    ));
  }

  let authorityEdge: "NONE" | "SUPPORT" | "REFUTE" = "NONE";
  if (obligation !== undefined && typedStatus !== undefined && typeof aggregateAdmissible === "boolean" && evaluation !== undefined) {
    const edge = authorityEdgeProblem(
      event,
      obligation,
      evaluation,
      typedStatus,
      aggregateAdmissible,
    );

    authorityEdge = edge.edge;
    if (edge.message !== undefined) {
      problems.push(problem(event, "EVIDENCE_EDGE_MISMATCH", edge.message));
    }
  } else if ((event.payload.supports?.length ?? 0) > 0 || (event.payload.refutes?.length ?? 0) > 0) {
    problems.push(problem(
      event,
      "EVIDENCE_EDGE_MISMATCH",
      "Evidence without replayable typed status and aggregate admissibility cannot carry an authority edge.",
    ));
  }

  const shared = {
    ...(obligation === undefined ? {} : { obligationId: obligation.id }),
    ...(typedStatus === undefined ? {} : { recordedTypedStatus: typedStatus }),
    ...(typeof aggregateAdmissible !== "boolean" ? {} : { aggregateAdmissible }),
    authorityEdge,
    ...(evaluation === undefined ? {} : { evaluation }),
  } as const;
  if (problems.length > 0) {
    return {
      entry: rejectedEntry(event, problems, shared),
      problems: Object.freeze(problems),
    };
  }

  return {
    entry: Object.freeze({
      sequence: event.sequence,
      eventDigest: event.eventDigest,
      evidenceId: event.payload.evidenceId,
      contentDigest: event.payload.contentDigest,
      candidateId,
      assayId,
      ...shared,
      status: "VERIFIED" as const,
      problemCodes: Object.freeze([]),
    }),
    problems: Object.freeze([]),
    observation,
    ...(obligation === undefined ? {} : { obligation }),
    plan,
    cellKind: diagnostic
      ? "diagnostic-invocation"
      : comparativeExperiment === undefined ? "authoritative-execution" : "comparative-experiment",
  };
}

function conflictingCells(
  events: readonly CaseEvent<"evidence.observed">[],
): ReadonlySet<string> {
  const digests = new Map<string, Set<string>>();
  for (const event of events) {
    const { candidateId, assayId } = event.payload;
    if (candidateId === undefined || assayId === undefined) continue;
    const cell = `${candidateId}\u0000${assayId}`;
    const entries = digests.get(cell) ?? new Set<string>();
    entries.add(event.payload.contentDigest);
    digests.set(cell, entries);
  }
  return new Set([...digests].filter(([, values]) => values.size > 1).map(([cell]) => cell));
}

function replayProblem(
  code: PersistedAssayEvidenceProblemCode,
  message: string,
  event?: CaseEvent,
): PersistedAssayEvidenceProblem {
  const evidence = event?.kind === "evidence.observed" ? event : undefined;
  return Object.freeze({
    code,
    sequence: event?.sequence ?? 0,
    ...(evidence === undefined ? {} : { evidenceId: evidence.payload.evidenceId }),
    ...(evidence === undefined ? {} : { contentDigest: evidence.payload.contentDigest }),
    message,
  });
}

function cellKey(candidateId: string, assayId: string): string {
  return `${candidateId}\u0000${assayId}`;
}

function hasAuthorityEdge(event: CaseEvent<"evidence.observed">): boolean {
  return (event.payload.supports?.length ?? 0) > 0 || (event.payload.refutes?.length ?? 0) > 0;
}

async function replayBlockedCellEvent(
  event: CaseEvent<"evidence.observed">,
  context: ReplayContext,
): Promise<EventReplayResult> {
  const problems: PersistedAssayEvidenceProblem[] = [];
  const candidateId = event.payload.candidateId;
  const assayId = event.payload.assayId;
  if (
    event.stage !== "assay"
    || event.actor.kind !== "forge"
    || event.payload.evidenceType !== "tool_observation"
    || typeof candidateId !== "string"
    || typeof assayId !== "string"
    || !isSha256Digest(event.payload.contentDigest)
    || hasAuthorityEdge(event)
  ) {
    problems.push(problem(
      event,
      "INVALID_SANDBOX_EVENT",
      "A blocked assay cell must be an edge-free assay-stage Forge tool_observation with exact candidate and assay scope.",
    ));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }
  if (context.conflictingCells.has(cellKey(candidateId, assayId))) {
    problems.push(problem(
      event,
      "CELL_ARTIFACT_CONFLICT",
      "The public ledger assigns more than one observation artifact to the same candidate-assay cell.",
    ));
  }
  let bytes: Uint8Array | undefined;
  try {
    bytes = await context.resolve(event.payload.contentDigest);
  } catch {
    problems.push(problem(event, "ARTIFACT_RESOLUTION_FAILED", "The blocked-cell artifact resolver failed."));
  }
  if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
    problems.push(problem(event, "ARTIFACT_RESOLUTION_FAILED", "The blocked-cell resolver did not return Uint8Array bytes."));
    bytes = undefined;
  }
  if (bytes === undefined && problems.length === 0) {
    problems.push(problem(event, "ARTIFACT_NOT_FOUND", "The blocked-cell ToolObservation artifact is missing."));
  }
  if (bytes === undefined) return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  if (sha256Digest(bytes) !== event.payload.contentDigest) {
    problems.push(problem(event, "ARTIFACT_DIGEST_MISMATCH", "Blocked-cell bytes do not match their content digest."));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }
  let observation: ToolObservation;
  try {
    observation = decodeToolObservation(bytes);
  } catch {
    problems.push(problem(event, "ARTIFACT_DECODE_FAILED", "The blocked-cell bytes are not a canonical ToolObservation."));
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }
  const normalInvocationId = stableId("invocation", {
    runDigest: event.runDigest,
    candidateId,
    assayId,
  });
  if (observation.invocationId === normalInvocationId) {
    return await replayEvent(event, context, true);
  }
  const plan = context.plansById.get(assayId);
  if (plan === undefined) {
    problems.push(problem(event, "PLAN_BINDING_MISMATCH", "The blocked cell names an assay outside the sealed frontier."));
  }
  const metadata = isRecord(observation.metadata) ? observation.metadata : undefined;
  const expectedInvocationId = stableId("invocation", {
    runDigest: event.runDigest,
    candidateId,
    assayId,
    blocked: observation.summary,
  });
  if (
    observation.invocationId !== expectedInvocationId
    || observation.status !== "not-executed"
    || observation.oracle !== undefined
    || metadata?.reason !== "assay-frontier-blocked"
    || metadata?.assayFrontierDigest !== context.frontier.digest
    || metadata?.candidateId !== candidateId
    || metadata?.assayId !== assayId
    || metadata?.planDigest !== (plan === undefined ? undefined : digestJson(plan as unknown as JsonValue))
    || metadata?.typedOracleStatus !== "BLOCKED"
    || metadata?.executionAuthorityStatus !== "BLOCKED"
    || metadata?.aggregateAdmissible !== false
  ) {
    problems.push(problem(
      event,
      "OBSERVATION_SCOPE_MISMATCH",
      "The blocked ToolObservation is not the exact non-executed, non-authoritative frontier-cell record.",
    ));
  }
  const expectedEvidenceId = stableId("evidence", { runDigest: event.runDigest, candidateId, assayId });
  if (event.payload.evidenceId !== expectedEvidenceId) {
    problems.push(problem(event, "CELL_EVENT_MISMATCH", "The blocked cell has a non-canonical evidence identity."));
  }
  if (problems.length > 0 || plan === undefined) {
    return { entry: rejectedEntry(event, problems), problems: Object.freeze(problems) };
  }
  const obligation = resolveObligation(context.contract, plan);
  return {
    entry: Object.freeze({
      sequence: event.sequence,
      eventDigest: event.eventDigest,
      evidenceId: event.payload.evidenceId,
      contentDigest: event.payload.contentDigest,
      candidateId,
      assayId,
      ...(obligation === undefined ? {} : { obligationId: obligation.id }),
      recordedTypedStatus: "BLOCKED",
      aggregateAdmissible: false,
      status: "VERIFIED",
      authorityEdge: "NONE",
      problemCodes: Object.freeze([]),
    }),
    problems: Object.freeze([]),
    observation,
    ...(obligation === undefined ? {} : { obligation }),
    plan,
    cellKind: "blocked-refusal",
  };
}

interface PhysicalReadings {
  readonly cpuMillis?: number;
  readonly writableBytes?: number;
  readonly writableInodes?: number;
  readonly byteCeiling?: number;
  readonly inodeCeiling?: number;
}

interface BoneAssayAccounting {
  readonly wallMillis: number;
  readonly costUnitsCharged: number;
  readonly artifactOutputBytes: number;
  readonly artifactStorageBytes: number;
  readonly cpuMillis: number | null;
  readonly writableBytes: number | null;
  readonly writableInodes: number | null;
  readonly aggregateAfter: Readonly<{
    forgeWallMillis: number;
    measuredForgeCpuMillis: number;
    cpuMeasurements: number;
    cpuUnmeasured: boolean;
    workspaceUnmeasured: boolean;
    totalAssayCost: number;
    writableBytes: number;
    writableInodes: number;
    artifactStorageBytes: number;
  }>;
}

function boneAssayAccounting(observation: ToolObservation): BoneAssayAccounting | undefined {
  const metadata = isRecord(observation.metadata) ? observation.metadata : undefined;
  const accounting = isRecord(metadata?.boneAccounting) ? metadata.boneAccounting : undefined;
  const aggregate = isRecord(accounting?.aggregateAfter) ? accounting.aggregateAfter : undefined;
  if (accounting?.protocol !== "jevyr.bone-assay-accounting/1"
    || aggregate === undefined
    || !hasExactKeys(accounting, [
      "protocol",
      "wallMillis",
      "costUnitsCharged",
      "artifactOutputBytes",
      "artifactStorageBytes",
      "cpuMillis",
      "writableBytes",
      "writableInodes",
      "aggregateAfter",
    ])
    || !hasExactKeys(aggregate, [
      "forgeWallMillis",
      "measuredForgeCpuMillis",
      "cpuMeasurements",
      "cpuUnmeasured",
      "workspaceUnmeasured",
      "totalAssayCost",
      "writableBytes",
      "writableInodes",
      "artifactStorageBytes",
    ])) return undefined;
  const wallMillis = finiteSafeReading(accounting.wallMillis);
  const costUnitsCharged = finiteSafeReading(accounting.costUnitsCharged);
  const artifactOutputBytes = finiteSafeReading(accounting.artifactOutputBytes);
  const artifactStorageBytes = finiteSafeReading(accounting.artifactStorageBytes);
  const cpuMillis = accounting.cpuMillis === null ? null : finiteSafeReading(accounting.cpuMillis);
  const writableBytes = accounting.writableBytes === null ? null : finiteSafeReading(accounting.writableBytes);
  const writableInodes = accounting.writableInodes === null ? null : finiteSafeReading(accounting.writableInodes);
  const forgeWallMillis = finiteSafeReading(aggregate.forgeWallMillis);
  const measuredForgeCpuMillis = finiteSafeReading(aggregate.measuredForgeCpuMillis);
  const cpuMeasurements = finiteSafeReading(aggregate.cpuMeasurements);
  const totalAssayCost = finiteSafeReading(aggregate.totalAssayCost);
  const aggregateWritableBytes = finiteSafeReading(aggregate.writableBytes);
  const aggregateWritableInodes = finiteSafeReading(aggregate.writableInodes);
  const aggregateArtifactStorageBytes = finiteSafeReading(aggregate.artifactStorageBytes);
  if (wallMillis === undefined
    || costUnitsCharged === undefined
    || artifactOutputBytes === undefined
    || artifactStorageBytes === undefined
    || cpuMillis === undefined
    || writableBytes === undefined
    || writableInodes === undefined
    || forgeWallMillis === undefined
    || measuredForgeCpuMillis === undefined
    || cpuMeasurements === undefined
    || typeof aggregate.cpuUnmeasured !== "boolean"
    || typeof aggregate.workspaceUnmeasured !== "boolean"
    || totalAssayCost === undefined
    || aggregateWritableBytes === undefined
    || aggregateWritableInodes === undefined
    || aggregateArtifactStorageBytes === undefined) {
    return undefined;
  }
  return Object.freeze({
    wallMillis,
    costUnitsCharged,
    artifactOutputBytes,
    artifactStorageBytes,
    cpuMillis,
    writableBytes,
    writableInodes,
    aggregateAfter: Object.freeze({
      forgeWallMillis,
      measuredForgeCpuMillis,
      cpuMeasurements,
      cpuUnmeasured: aggregate.cpuUnmeasured,
      workspaceUnmeasured: aggregate.workspaceUnmeasured,
      totalAssayCost,
      writableBytes: aggregateWritableBytes,
      writableInodes: aggregateWritableInodes,
      artifactStorageBytes: aggregateArtifactStorageBytes,
    }),
  });
}

function finiteSafeReading(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function physicalReadings(observation: ToolObservation): PhysicalReadings {
  const metadata = isRecord(observation.metadata) ? observation.metadata : undefined;
  const accounting = isRecord(metadata?.resourceAccounting) ? metadata.resourceAccounting : undefined;
  if (accounting?.protocol !== "jevyr.forge-resource-accounting/1") return Object.freeze({});
  const workspace = isRecord(accounting.workspace) ? accounting.workspace : undefined;
  const after = isRecord(workspace?.after) ? workspace.after : undefined;
  const cpu = isRecord(accounting.cpu) ? accounting.cpu : undefined;
  const writableBytes = finiteSafeReading(after?.bytes);
  const writableInodes = finiteSafeReading(after?.inodes);
  const byteCeiling = finiteSafeReading(workspace?.byteCeiling);
  const inodeCeiling = finiteSafeReading(workspace?.inodeCeiling);
  const workspaceComplete = after?.measurement === "MEASURED"
    && after.complete === true
    && writableBytes !== undefined
    && writableInodes !== undefined
    && byteCeiling !== undefined
    && inodeCeiling !== undefined
    && writableBytes <= byteCeiling
    && writableInodes <= inodeCeiling;
  const measuredCpu = finiteSafeReading(cpu?.usedMillis);
  const cpuMillis = cpu?.measurement === "MEASURED" ? measuredCpu : undefined;
  return Object.freeze({
    ...(workspaceComplete ? { writableBytes, writableInodes, byteCeiling, inodeCeiling } : {}),
    ...(cpuMillis === undefined ? {} : { cpuMillis }),
  });
}

function observedStrings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

interface ReconstructedRun {
  readonly candidateId: string;
  readonly plan: SealedAssayPlan;
  readonly baseEvent: CaseEvent<"evidence.observed">;
  readonly result: EventReplayResult;
  readonly observation: ToolObservation;
  readonly obligation?: IntentObligation;
  readonly wallMillis: number;
  readonly cpuMillis?: number;
  readonly writableBytes?: number;
  readonly writableInodes?: number;
  readonly artifactBytes: number;
  readonly artifactStorageBytes: number;
  readonly costUnitsCharged: number;
  readonly admissible: boolean;
  readonly expectedStatus: "passed" | "failed" | "inconclusive" | "blocked";
  readonly blockedReason?: string;
}

function measuredBehaviorDescriptor(runs: readonly ReconstructedRun[], wallCeiling: number): BehaviorDescriptor {
  const evaluations = runs.flatMap((run) => run.result.entry.evaluation === undefined ? [] : [run.result.entry.evaluation]);
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

function measuredCandidateEvaluation(runs: readonly ReconstructedRun[], wallCeiling: number): CandidateEvaluation {
  const evaluations = runs.flatMap((run) => run.result.entry.evaluation === undefined ? [] : [run.result.entry.evaluation]);
  const executed = runs.length > 0 && runs.every((run) => run.admissible && run.observation.oracle?.execution.state === "exited");
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
    unresolvedCritical: runs.filter((run) => run.result.entry.evaluation?.status !== "PASSED" || !run.admissible).length,
    scores: Object.freeze({
      discrimination: runs.length === 0 ? 0 : evaluations.filter((entry) => entry.decisive).length / runs.length,
      robustness: passed ? clamp(0.25 + Math.max(0, runs.length - 1) * 0.15, 0, 1) : 0,
      parsimony: 1 / (1 + changed + artifacts),
      feasibility: executed && passed ? 1 : 0,
      evidenceCoverage: runs.length === 0 ? 0 : evaluations.filter((entry) => entry.decisive).length / runs.length,
      resourceEfficiency: 1 / (1 + measuredPhysicalUnits),
    }),
    evidenceDigests: executed ? Object.freeze(runs.map((run) => run.baseEvent.payload.contentDigest).sort()) : Object.freeze([]),
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

interface MutableAggregateUsage {
  forgeWallMillis: number;
  measuredForgeCpuMillis: number;
  cpuMeasurements: number;
  cpuUnmeasured: boolean;
  workspaceUnmeasured: boolean;
  writableBytes: number;
  writableInodes: number;
  artifactBytes: number;
  totalAssayCost: number;
  attempted: number;
}

function resourceRefusal(
  usage: MutableAggregateUsage,
  plan: SealedAssayPlan,
  frontier: AssayFrontier,
  previousReason: string | undefined,
): string | undefined {
  const limits = frontier.aggregateLimits;
  if (previousReason !== undefined) return previousReason;
  if (plan.costUnits > limits.maxTotalAssayCost - usage.totalAssayCost) {
    return `Case-wide assay cost would exceed ${limits.maxTotalAssayCost}.`;
  }
  if (usage.forgeWallMillis >= limits.maxForgeWallMillis
    || limits.maxForgeWallMillis - usage.forgeWallMillis < 1_000) {
    return `Case-wide Forge wall budget ${limits.maxForgeWallMillis} ms is exhausted.`;
  }
  if (usage.writableBytes >= limits.maxWritableBytes) {
    return `Case-wide writable-byte budget ${limits.maxWritableBytes} is exhausted.`;
  }
  if (usage.writableInodes >= limits.maxWritableInodes) {
    return `Case-wide writable-inode budget ${limits.maxWritableInodes} is exhausted.`;
  }
  if (limits.maxForgeCpuMillis === 0) {
    return "Case-wide Forge CPU budget is zero; execution is prohibited.";
  }
  if (usage.cpuMeasurements > 0 && usage.measuredForgeCpuMillis >= limits.maxForgeCpuMillis) {
    return `Measured case-wide Forge CPU budget ${limits.maxForgeCpuMillis} ms is exhausted.`;
  }
  return undefined;
}

function postExecutionResourceProblem(
  usage: MutableAggregateUsage,
  executed: boolean,
  physical: PhysicalReadings,
  frontier: AssayFrontier,
): string | undefined {
  const limits = frontier.aggregateLimits;
  if (executed && (physical.writableBytes === undefined || physical.writableInodes === undefined)) {
    return "Forge did not return complete measured workspace accounting.";
  }
  if (usage.forgeWallMillis > limits.maxForgeWallMillis) {
    return `Case-wide Forge wall use exceeded ${limits.maxForgeWallMillis} ms.`;
  }
  if (physical.cpuMillis !== undefined && usage.measuredForgeCpuMillis > limits.maxForgeCpuMillis) {
    return `Measured case-wide Forge CPU use exceeded ${limits.maxForgeCpuMillis} ms.`;
  }
  if (usage.writableBytes > limits.maxWritableBytes) {
    return `Case-wide writable bytes exceeded ${limits.maxWritableBytes}.`;
  }
  if (usage.writableInodes > limits.maxWritableInodes) {
    return `Case-wide writable inodes exceeded ${limits.maxWritableInodes}.`;
  }
  if (usage.artifactBytes > limits.maxArtifactBytes) {
    return `Case-wide artifact bytes exceeded ${limits.maxArtifactBytes}.`;
  }
  return undefined;
}

function telemetry(
  event: CaseEvent<"search.status">,
  name: SearchResourceTelemetry["name"],
): SearchResourceTelemetry | undefined {
  return event.payload.resources.find((entry) => entry.name === name);
}

function exactTelemetryProblem(
  event: CaseEvent<"search.status">,
  name: SearchResourceTelemetry["name"],
  used: number | null,
  ceiling: number,
): PersistedAssayEvidenceProblem | undefined {
  const entry = telemetry(event, name);
  const expectedMeasurement = used === null ? "DECLARED_ONLY" : "MEASURED";
  if (entry === undefined
    || entry.used !== used
    || entry.ceiling !== ceiling
    || entry.measurement !== expectedMeasurement) {
    return replayProblem(
      "RESOURCE_ACCOUNTING_MISMATCH",
      `Assay telemetry ${name} does not equal the independently reconstructed ${String(used)}/${ceiling} ${expectedMeasurement} reading.`,
      event,
    );
  }
  return undefined;
}

function validateAggregateTelemetry(
  event: CaseEvent<"search.status">,
  usage: MutableAggregateUsage,
  frontier: AssayFrontier,
): readonly PersistedAssayEvidenceProblem[] {
  const limits = frontier.aggregateLimits;
  const expected = [
    ["forgeWallMillis", usage.forgeWallMillis, limits.maxForgeWallMillis],
    ["forgeCpuMillis", usage.cpuMeasurements > 0 && !usage.cpuUnmeasured ? usage.measuredForgeCpuMillis : null, limits.maxForgeCpuMillis],
    ["writableBytes", usage.workspaceUnmeasured ? null : usage.writableBytes, limits.maxWritableBytes],
    ["writableInodes", usage.workspaceUnmeasured ? null : usage.writableInodes, limits.maxWritableInodes],
    ["artifactBytes", usage.artifactBytes, limits.maxArtifactBytes],
    ["totalAssayCost", usage.totalAssayCost, limits.maxTotalAssayCost],
  ] as const;
  return Object.freeze(expected.flatMap(([name, used, ceiling]) => {
    const found = exactTelemetryProblem(event, name, used, ceiling);
    return found === undefined ? [] : [found];
  }));
}

function assayStatusFor(entry: ReplayedAssayEvidence, observation: ToolObservation): ReconstructedRun["expectedStatus"] {
  if (entry.evaluation?.status === "PASSED" && entry.aggregateAdmissible === true) return "passed";
  if (entry.evaluation?.status === "FAILED" && entry.aggregateAdmissible === true) return "failed";
  if (entry.evaluation?.status === "BLOCKED" || observation.status === "not-executed" || entry.aggregateAdmissible !== true) {
    return "blocked";
  }
  return "inconclusive";
}

function emptyFrontierState(frontier: AssayFrontier): ReplayedAssayFrontierState {
  return Object.freeze({
    candidateIds: Object.freeze([]),
    assayIds: Object.freeze(frontier.assays.map((entry) => entry.assayId)),
    expectedCellCount: 0,
    observedCellCount: 0,
    matrixComplete: true,
    resourceExhausted: false,
    attempted: 0,
    aggregateUsage: Object.freeze({
      forgeWallMillis: 0,
      forgeCpuMillis: null,
      writableBytes: 0,
      writableInodes: 0,
      artifactBytes: 0,
      totalAssayCost: 0,
    }),
    survivorCandidateIds: Object.freeze([]),
    cells: Object.freeze([]),
  });
}

interface FrontierReconstruction {
  readonly state: ReplayedAssayFrontierState;
  readonly problems: readonly PersistedAssayEvidenceProblem[];
  readonly authorityEdges: readonly VerifiedEvidenceEdge[];
}

interface PopulationCandidate {
  readonly candidateId: string;
  readonly blueprintDigest: string;
  readonly blueprintArtifactDigest: string;
}

interface CandidatePopulation {
  readonly caseId: string;
  readonly runDigest: string;
  readonly assayFrontierDigest: string;
  readonly candidates: readonly PopulationCandidate[];
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function decodeCandidatePopulation(
  bytes: Uint8Array,
  digest: string,
  runDigest: string,
  frontierDigest: string,
): CandidatePopulation | undefined {
  let value: unknown;
  try {
    value = parseJsonBytes(bytes, "Candidate population artifact");
  } catch {
    return undefined;
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ["protocol", "caseId", "runDigest", "assayFrontierDigest", "candidates"])
    || value.protocol !== "jevyr.candidate-population/1"
    || typeof value.caseId !== "string"
    || value.caseId.length === 0
    || value.runDigest !== runDigest
    || value.assayFrontierDigest !== frontierDigest
    || !Array.isArray(value.candidates)
    || digestJson(value as JsonValue) !== digest) {
    return undefined;
  }
  const candidates: PopulationCandidate[] = [];
  for (const item of value.candidates) {
    if (!isRecord(item)
      || !hasExactKeys(item, ["candidateId", "blueprintDigest", "blueprintArtifactDigest"])
      || typeof item.candidateId !== "string"
      || item.candidateId.length === 0
      || !isSha256Digest(item.blueprintDigest)
      || !isSha256Digest(item.blueprintArtifactDigest)) {
      return undefined;
    }
    candidates.push(Object.freeze({
      candidateId: item.candidateId,
      blueprintDigest: item.blueprintDigest,
      blueprintArtifactDigest: item.blueprintArtifactDigest,
    }));
  }
  const ids = candidates.map((entry) => entry.candidateId);
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && id <= (ids[index - 1] as string))) {
    return undefined;
  }
  return Object.freeze({
    caseId: value.caseId,
    runDigest,
    assayFrontierDigest: frontierDigest,
    candidates: Object.freeze(candidates),
  });
}

function decodePopulationBlueprintArtifact(
  bytes: Uint8Array,
  artifactDigest: string,
  blueprintDigest: string,
): unknown | undefined {
  if (sha256Digest(bytes) !== artifactDigest) return undefined;
  let value: unknown;
  try {
    value = parseJsonBytes(bytes, "Candidate blueprint artifact");
  } catch {
    return undefined;
  }
  if (!isRecord(value)
    || value.protocol !== "jevyr.candidate-blueprint/1"
    || value.blueprintDigest !== blueprintDigest
    || digestJson(value as JsonValue) !== artifactDigest) {
    return undefined;
  }
  const { blueprintDigest: ignored, ...payload } = value;
  return digestJson(payload as JsonValue) === blueprintDigest && ignored === blueprintDigest
    ? value
    : undefined;
}

async function reconstructFrontierState(
  events: readonly CaseEvent[],
  contract: IntentContract,
  frontier: AssayFrontier,
  policyDescriptor: unknown,
  mode: PersistedAssayEvidenceReplayMode,
  results: ReadonlyMap<string, EventReplayResult>,
  resolve: AssayEvidenceArtifactResolver,
  candidateIgnorePolicy: JevyrIgnorePolicy | undefined,
  trustedRecordKeys?: ReadonlyMap<string, string>,
  originalSubject?: OriginalSubjectCertificateReplay,
): Promise<FrontierReconstruction> {
  const problems: PersistedAssayEvidenceProblem[] = [];
  const metabolism = await replayMetabolicGrants(events, policyDescriptor, resolve);
  problems.push(...metabolism.problems.map(problem => ({ code: "METABOLIC_GRANT_INVALID" as const, ...problem })));
  const observers = await replayRepositoryObservers(events, policyDescriptor, resolve, originalSubject ? {
    initialBaseline: originalSubject.baseline,
    initialArtifacts: originalSubject.artifactDigests.map(digest => ({digest,byteLength:originalSubject.baseline.artifactBytes})),
  } : undefined);
  problems.push(...observers.problems.map(problem => ({ code: "REPOSITORY_OBSERVER_INVALID" as const, ...problem })));
  const frontierAt = (sequence: number): AssayFrontier => {
    const added = metabolism.additionsAt(sequence);
    const limits = { ...frontier.aggregateLimits };
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      const value = limits[key] + added[key];
      if (!Number.isSafeInteger(value)) throw new RangeError("Metabolic aggregate exceeded safe precision");
      limits[key] = value;
    }
    return { ...frontier, aggregateLimits: limits };
  };
  const experimentCapability = compileExperimentCapability(frontier, contract);
  const evidenceEvents = events.filter(
    // Original-capture certificates have their own authenticated pre-investigation
    // join. They must not enter candidate population, winner or assay edge loops.
    (event): event is CaseEvent<"evidence.observed"> => event.kind === "evidence.observed" && event.payload.evidenceType !== "original_subject_assertions",
  );
  const actionEvents = events.filter(
    (event): event is CaseEvent<"action.status"> => event.kind === "action.status",
  );
  const assayEvents = events.filter(
    (event): event is CaseEvent<"assay.status"> => event.kind === "assay.status" && event.stage === "assay",
  );
  const candidateEvents = events.filter(
    (event): event is CaseEvent<"candidate.status"> => event.kind === "candidate.status",
  );
  const searchEvents = events.filter(
    (event): event is CaseEvent<"search.status"> => event.kind === "search.status"
      && event.stage === "assay"
      && event.payload.layer === "ASSAY_ARCHIVE",
  );
  const scopedEvidence = evidenceEvents.filter((event) =>
    event.stage === "assay"
    && event.payload.candidateId !== undefined
    && event.payload.assayId !== undefined);

  const observedCandidateIds = new Set<string>();
  for (const event of scopedEvidence) observedCandidateIds.add(event.payload.candidateId as string);
  for (const event of assayEvents) {
    if (event.payload.candidateId !== undefined) observedCandidateIds.add(event.payload.candidateId);
  }
  for (const event of candidateEvents) {
    if (["survived", "invalidated", "selected"].includes(event.payload.status)
      || (event.payload.status === "proposed" && (event.payload.artifactDigests?.length ?? 0) >= 2)) {
      observedCandidateIds.add(event.payload.candidateId);
    }
  }
  const runDigest = events[0]?.runDigest;
  const populationActions = actionEvents.filter((event) => event.payload.actionType === "candidate.population.close");
  const populationAction = populationActions[0];
  let population: CandidatePopulation | undefined;
  if (runDigest === undefined
    || populationActions.length !== 1
    || populationAction === undefined
    || populationAction.stage !== "embody"
    || populationAction.actor.kind !== "kernel"
    || populationAction.payload.status !== "completed"
    || populationAction.payload.actionId !== stableId("population", { runDigest })
    || populationAction.payload.artifactDigests?.length !== 1) {
    problems.push(replayProblem(
      "MATRIX_INCOMPLETE",
      "The ledger has no unique canonical Bone candidate-population closure before the frontier.",
      populationAction,
    ));
  } else {
    const populationDigest = populationAction.payload.artifactDigests[0] as string;
    let bytes: Uint8Array | undefined;
    try {
      bytes = await resolve(populationDigest);
    } catch {
      problems.push(replayProblem("ARTIFACT_RESOLUTION_FAILED", "The candidate-population artifact resolver failed.", populationAction));
    }
    if (bytes !== undefined && !(bytes instanceof Uint8Array)) {
      problems.push(replayProblem("ARTIFACT_RESOLUTION_FAILED", "The candidate-population resolver returned non-bytes.", populationAction));
      bytes = undefined;
    }
    if (bytes === undefined) {
      problems.push(replayProblem("ARTIFACT_NOT_FOUND", "The exact candidate-population artifact is missing.", populationAction));
    } else if (sha256Digest(bytes) !== populationDigest) {
      problems.push(replayProblem("ARTIFACT_DIGEST_MISMATCH", "Candidate-population bytes do not match the committed digest.", populationAction));
    } else {
      population = decodeCandidatePopulation(bytes, populationDigest, runDigest, frontier.digest);
      if (population === undefined) {
        problems.push(replayProblem("ARTIFACT_DECODE_FAILED", "The candidate-population artifact is non-canonical or not bound to this run/frontier.", populationAction));
      }
    }
  }
  const populationClosureByCandidate = new Map(population?.candidates.map(candidate => [candidate.candidateId, populationAction?.sequence ?? 0]) ?? []);
  const revisionParentByCandidate = new Map<string, string>();
  let lastRevisionCandidateId: string | undefined;
  const revisionActions = actionEvents.filter(event => event.payload.actionType === "candidate.revision.population.close");
  let populationHeadDigest = populationAction?.payload.artifactDigests?.[0];
  const baselineRevisionRounds = new Set<number>();
  const grantRevisionCounts = new Map<string, number>();
  const inertiaParents: string[] = [];
  const checkedInertiaDecisions = new Map<string, InertiaContinuationDecision>();
  const revisionResourceUnits = new Map<string, MetabolicResourceVector>();
  const revisionResourceOrigins = new Map<string, MutableAggregateUsage>();
  const inputsBefore = (sequence: number): readonly FeedbackInput[] => scopedEvidence.filter(event => !hasAuthorityEdge(event)).flatMap(event => {
    const result = results.get(event.eventDigest);
    if (!result?.observation || !result.plan) return [];
    const terminal = actionEvents.find(candidate => candidate.stage === "embody" && candidate.payload.actionId === result.observation!.invocationId && ["completed", "failed", "denied"].includes(candidate.payload.status));
    if (!terminal || terminal.sequence >= sequence) return [];
    return [{ sequence: terminal.sequence, input: { candidateId: event.payload.candidateId!, assayId: event.payload.assayId!, observationDigest: event.payload.contentDigest, observation: result.observation,
      ...(result.entry.evaluation ? { evaluation: result.entry.evaluation } : {}), admissible: result.observation.metadata?.aggregateAdmissible === true, costUnits: result.plan.costUnits } satisfies FeedbackInput }];
  }).sort((a, b) => a.sequence - b.sequence).map(entry => entry.input);
  const checkpointActions = actionEvents.filter(event => event.payload.actionType === "investigation.metabolic-checkpoint");
  const reproductionActions = actionEvents.filter(event => event.payload.actionType === "investigation.metabolic-reproduction");
  let reproductionPlan: MetabolicReproductionPlan | undefined;
  if (reproductionActions.length > 0) {
    try {
      const action = reproductionActions[0]!;
      if (reproductionActions.length !== 1 || action.stage !== "self_scan" || action.actor.kind !== "kernel" || action.actor.id !== "jevyr.bone" || action.payload.status !== "completed" || action.payload.artifactDigests?.length !== 1 || !trustedRecordKeys) throw new Error("Reproduction requires one early kernel plan and independently trusted source Record keys");
      const bytes = await resolve(action.payload.artifactDigests[0]!);
      if (!(bytes instanceof Uint8Array) || sha256Digest(bytes) !== action.payload.artifactDigests[0]) throw new Error("Reproduction plan bytes changed");
      const plan = parseJsonBytes(bytes, "metabolic reproduction") as unknown as MetabolicReproductionPlan;
      reproductionPlan = await verifyMetabolicReproductionPlan(plan, trustedRecordKeys);
      if (canonicalize(plan as unknown as JsonValue) !== Buffer.from(bytes).toString("utf8") || action.payload.actionId !== plan.digest || canonicalize(plan.sourcePolicyDescriptor) !== canonicalize(policyDescriptor as JsonValue)) throw new Error("Reproduction substituted its canonical plan or exact source policy");
    } catch (error) { problems.push(replayProblem("METABOLIC_GRANT_INVALID", `Metabolic reproduction source cannot authenticate: ${error instanceof Error ? error.message : "invalid source"}.`, reproductionActions[0])); }
  }
  let previousCheckpointSequence = 0;
  for (const [index, action] of checkpointActions.entries()) {
    try {
      if (!metabolicCheckpointsEnabled(policyDescriptor) || action.actor.kind !== "kernel" || action.actor.id !== "jevyr.bone" || action.payload.status !== "completed" || action.payload.artifactDigests?.length !== 1) throw new Error("Checkpoint lacks its presealed kernel authority");
      const bytes = await resolve(action.payload.artifactDigests[0]!);
      if (!(bytes instanceof Uint8Array) || sha256Digest(bytes) !== action.payload.artifactDigests[0]) throw new Error("Checkpoint bytes are absent or changed");
      const checkpoint = parseJsonBytes(bytes, "metabolic checkpoint") as unknown as MetabolicCheckpoint;
      const admitted = metabolism.admitted.filter(entry => entry.sequence > previousCheckpointSequence && entry.sequence < action.sequence).map(entry => entry.receipt);
      const reconstructed = createMetabolicCheckpoint(index + 1, action.stage, checkpoint.context, checkpoint.structuralContext, admitted);
      if (canonicalize(reconstructed as unknown as JsonValue) !== Buffer.from(bytes).toString("utf8") || checkpoint.digest !== action.payload.actionId) throw new Error("Checkpoint changed its exact admission prefix or ordinal");
      const context = checkpoint.context as { cells?: unknown; candidates?: unknown };
      if (canonicalize(context.cells as JsonValue) !== canonicalize(executionFeedback(inputsBefore(action.sequence)).cells as unknown as JsonValue)) throw new Error("Checkpoint invented prior physical feedback");
      if (!Array.isArray(context.candidates) || context.candidates.some(row => !Array.isArray(row) || row.length !== 2 || !candidateEvents.some(event => event.sequence < action.sequence && event.payload.status === "proposed" && event.payload.candidateId === row[0] && event.payload.artifactDigests?.includes(row[1])))) throw new Error("Checkpoint invented a preceding committed candidate");
      if (reproductionPlan?.seedMode === "same" && (!reproductionPlan.checkpoints[index] || !metabolicCheckpointMatches(reproductionPlan.checkpoints[index]!, checkpoint, "same"))) throw new Error("Reproduction changed its authenticated checkpoint context");
      if (reproductionPlan?.seedMode === "new") {
        const doses = metabolicReproductionDoses(reproductionPlan);
        if (admitted.some(receipt => !doses.some(dose => dose.sequence === receipt.sequence && dose.stage === action.stage && dose.kind === receipt.kind && dose.quantity === receipt.quantity))) throw new Error("New-seed additions changed their ordered source stage, kind or quantity");
        const admittedCount = metabolism.admitted.filter(entry => entry.sequence < action.sequence).length;
        const next = doses[admittedCount], structure = checkpoint.structuralContext as { offers?: { kind: string; maxQuantity: number }[] };
        if (next?.stage === action.stage && structure.offers?.some(offer => offer.kind === next.kind && offer.maxQuantity >= next.quantity)) throw new Error("New-seed reproduction skipped an earlier eligible checkpoint");
      }
      previousCheckpointSequence = action.sequence;
    } catch (error) { problems.push(replayProblem("METABOLIC_GRANT_INVALID", `Metabolic checkpoint cannot replay: ${error instanceof Error ? error.message : "invalid checkpoint"}.`, action)); }
  }
  if (reproductionPlan && (reproductionPlan.seedMode === "same" && checkpointActions.length !== reproductionPlan.checkpoints.length || checkpointActions.at(-1)?.stage !== "assay" || metabolism.admitted.length !== metabolicReproductionDoses(reproductionPlan).length || metabolism.admitted.some(entry => entry.sequence > previousCheckpointSequence))) problems.push(replayProblem("METABOLIC_GRANT_INVALID", "Controlled Juggler reproduction omitted a required checkpoint or admitted a later grant."));
  for (const [ordinal, action] of revisionActions.entries()) {
    try {
      if (!population || !revisionInvestigationEnabled(policyDescriptor) || action.stage !== "embody" || action.actor.kind !== "kernel" || action.actor.id !== "jevyr.bone" || action.payload.status !== "completed" || action.payload.artifactDigests?.length !== 1) throw new Error("Unsealed or malformed revision authority");
      const digest = action.payload.artifactDigests[0]!, bytes = await resolve(digest);
      if (!(bytes instanceof Uint8Array) || sha256Digest(bytes) !== digest || action.payload.actionId !== digest) throw new Error("Changed revision population bytes");
      const value = parseJsonBytes(bytes, "revision population");
      if (!isRecord(value) || !hasExactKeys(value, ["protocol", "caseId", "runDigest", "assayFrontierDigest", "previousPopulationDigest", "ordinal", "round", "parentCandidateIds", "feedbackArtifactDigest", "contextDigest", "candidates", ...(value.receiptDigest === undefined ? [] : ["receiptDigest", "inertiaDecisionDigest"])])
        || canonicalize(value as JsonValue) !== Buffer.from(bytes).toString("utf8") || value.protocol !== "jevyr.revision-population/1" || value.caseId !== population.caseId || value.runDigest !== runDigest || value.assayFrontierDigest !== frontier.digest || value.previousPopulationDigest !== populationHeadDigest || value.ordinal !== ordinal + 1
        || !Number.isSafeInteger(value.round) || (value.round as number) < 1 || (value.round as number) > 2 || !Array.isArray(value.parentCandidateIds) || value.parentCandidateIds.length !== 1 || typeof value.parentCandidateIds[0] !== "string"
        || !populationClosureByCandidate.has(value.parentCandidateIds[0]) || !Array.isArray(value.candidates) || value.candidates.length !== 1 || !isSha256Digest(value.feedbackArtifactDigest)) throw new Error("Revision population changed its bound ancestry, loop or frontier");
      if (value.receiptDigest === undefined) {
        if (baselineRevisionRounds.has(value.round as number)) throw new Error("A baseline feedback round admitted more than one revision");
        baselineRevisionRounds.add(value.round as number);
      } else {
        const admitted = metabolism.admitted.find(entry => entry.receipt.digest === value.receiptDigest);
        const count = (grantRevisionCounts.get(String(value.receiptDigest)) ?? 0) + 1;
        if (!admitted || admitted.receipt.kind !== "Inertia" || count > admitted.receipt.quantity || admitted.sequence >= action.sequence) throw new Error("Revision lacked a preceding bounded Inertia grant");
        if (!isSha256Digest(value.inertiaDecisionDigest)) throw new Error("Inertia revision omitted its exact observed threshold decision");
        const decisionAction = actionEvents.find(event => event.sequence > admitted.sequence && event.sequence < action.sequence && event.stage === "embody" && event.actor.kind === "kernel" && event.actor.id === "jevyr.bone" && event.payload.actionType === "investigation.inertia-continuation" && event.payload.status === "completed" && event.payload.artifactDigests?.length === 1 && event.payload.artifactDigests[0] === value.inertiaDecisionDigest);
        if (!decisionAction) throw new Error("Inertia decision was not committed before the revision");
        let decision = checkedInertiaDecisions.get(admitted.receipt.digest);
        if (!decision) {
          const decisionBytes = await resolve(value.inertiaDecisionDigest);
          if (!(decisionBytes instanceof Uint8Array) || sha256Digest(decisionBytes) !== value.inertiaDecisionDigest) throw new Error("Inertia decision bytes changed");
          decision = parseJsonBytes(decisionBytes, "Inertia continuation") as unknown as InertiaContinuationDecision;
          if (canonicalize(decision as unknown as JsonValue) !== Buffer.from(decisionBytes).toString("utf8") || decision.digest !== decisionAction.payload.actionId) throw new Error("Inertia decision is noncanonical or substituted");
          assertInertiaContinuationDecision(decision, admitted.receipt, feedbackScentHistory(inputsBefore(decisionAction.sequence)), contract.criticalObligations.map(obligation => obligation.id), inertiaParents);
          checkedInertiaDecisions.set(admitted.receipt.digest, decision);
        }
        if (decision.selected[count - 1]?.candidateId !== value.parentCandidateIds[0]) throw new Error("Inertia revision substituted or reordered the measured scent");
        inertiaParents.push(value.parentCandidateIds[0]);
        grantRevisionCounts.set(String(value.receiptDigest), count);
      }
      const parentId = value.parentCandidateIds[0] as string;
      const feedbackAction = actionEvents.find(event => event.stage === "embody" && event.actor.kind === "kernel" && event.actor.id === "jevyr.bone" && event.payload.actionType === "investigation.execution-feedback" && event.payload.status === "completed" && event.payload.actionId === value.feedbackArtifactDigest && event.payload.artifactDigests?.length === 1 && event.payload.artifactDigests[0] === value.feedbackArtifactDigest && event.sequence < action.sequence);
      if (!feedbackAction) throw new Error("Revision did not commit its prior executed feedback");
      const priorInputs = inputsBefore(feedbackAction.sequence);
      const expectedFeedback = executionFeedback(priorInputs), feedbackBytes = await resolve(value.feedbackArtifactDigest);
      if (!(feedbackBytes instanceof Uint8Array) || sha256Digest(feedbackBytes) !== value.feedbackArtifactDigest || Buffer.from(feedbackBytes).toString("utf8") !== canonicalize(expectedFeedback as unknown as JsonValue) || value.contextDigest !== expectedFeedback.contextDigest
        || !expectedFeedback.cells.some(cell => cell.candidateId === parentId && cell.decisive && cell.status === "FAILED")) throw new Error("Revision feedback differs from preceding physically bound observations");
      if (value.receiptDigest === undefined) {
        const version = revisionInvestigationVersion(policyDescriptor);
        if (version === "observed-comparative-repair") {
          const choice = selectBaselineRevision({ inputs: priorInputs, contract, frontier, candidateIds: [...populationClosureByCandidate.keys()],
            ...(lastRevisionCandidateId ? { lastRevisionCandidateId } : {}), policyVersion: version });
          if (!choice || choice.candidateId !== parentId) throw new Error("Baseline revision differs from its sealed critical or comparative execution eligibility");
        } else if (!assessEvidenceScents(feedbackScentHistory(priorInputs), contract.criticalObligations.map(obligation => obligation.id)).some(scent => scent.candidateId === parentId && scent.valuePerCost >= INERTIA_SCENT_POLICY.baselineThreshold)) {
          throw new Error("Baseline revision continued a scent below its sealed heuristic threshold");
        }
      }
      const candidate = value.candidates[0];
      if (!isRecord(candidate) || !hasExactKeys(candidate, ["candidateId", "blueprintDigest", "blueprintArtifactDigest"]) || typeof candidate.candidateId !== "string" || populationClosureByCandidate.has(candidate.candidateId) || !isSha256Digest(candidate.blueprintDigest) || !isSha256Digest(candidate.blueprintArtifactDigest)) throw new Error("Revision repeated or malformed a finite candidate identity");
      const proposal = candidateEvents.find(event => event.stage === "embody" && event.actor.kind === "mind" && event.payload.status === "proposed" && event.payload.candidateId === candidate.candidateId && event.sequence > feedbackAction.sequence && event.sequence < action.sequence && event.payload.parentIds?.length === 1 && event.payload.parentIds[0] === parentId && event.payload.artifactDigests?.includes(candidate.blueprintDigest as string) && event.payload.artifactDigests.includes(candidate.blueprintArtifactDigest as string));
      if (!proposal) throw new Error("Revision lacks its matching prior parent-bound proposal");
      populationClosureByCandidate.set(candidate.candidateId, action.sequence);
      if (typeof value.receiptDigest === "string") {
        const receipt = metabolism.admitted.find(entry => entry.receipt.digest === value.receiptDigest)!.receipt;
        revisionResourceUnits.set(candidate.candidateId, Object.fromEntries(Object.entries(receipt.grant).map(([key, amount]) => [key, Math.floor(amount / receipt.quantity)])) as unknown as MetabolicResourceVector);
      }
      revisionParentByCandidate.set(candidate.candidateId, value.parentCandidateIds[0]);
      lastRevisionCandidateId = candidate.candidateId;
      population = { ...population, candidates: [...population.candidates, candidate as unknown as PopulationCandidate].sort((a, b) => a.candidateId.localeCompare(b.candidateId)) };
      populationHeadDigest = digest;
    } catch (error) {
      problems.push(replayProblem("MATRIX_INCOMPLETE", `Invalid appended revision population: ${error instanceof Error ? error.message : "unverifiable revision"}.`, action));
    }
  }
  const candidateIds = population?.candidates.map((entry) => entry.candidateId)
    ?? [...observedCandidateIds].sort();
  const populationByCandidate = new Map(population?.candidates.map((entry) => [entry.candidateId, entry]) ?? []);
  if (population && metabolism.admitted.some(entry => entry.receipt.caseId !== population.caseId)) problems.push(replayProblem("METABOLIC_GRANT_INVALID", "Metabolic admission names a different population Case."));
  if (population !== undefined) {
    for (const candidateId of observedCandidateIds) {
      if (!populationByCandidate.has(candidateId)) {
        problems.push(replayProblem("MATRIX_INCOMPLETE", `Candidate ${candidateId} is absent from the closed population.`));
      }
    }
    for (const candidate of population.candidates) {
      const proposal = candidateEvents.find((event) =>
        event.payload.candidateId === candidate.candidateId
        && event.payload.status === "proposed"
        && event.stage === (revisionParentByCandidate.has(candidate.candidateId) ? "embody" : "diverge")
        && event.sequence < (populationClosureByCandidate.get(candidate.candidateId) ?? Number.MAX_SAFE_INTEGER)
        && event.payload.artifactDigests?.includes(candidate.blueprintDigest)
        && event.payload.artifactDigests.includes(candidate.blueprintArtifactDigest));
      if (proposal === undefined) {
        problems.push(replayProblem(
          "MATRIX_INCOMPLETE",
          `Population candidate ${candidate.candidateId} has no preceding blueprint-bound proposal event.`,
          populationAction,
        ));
      }
    }
  }
  const assayIds = frontier.assays.map((entry) => entry.assayId);
  let expectedKeys = candidateIds.flatMap((candidateId) => assayIds.map((assayId) => cellKey(candidateId, assayId)));
  // Method choice may adapt to preceding evidence. Its signed schedule cannot
  // add/remove a sealed cell or confer truth, but resource replay must use the
  // actual committed order instead of pretending all cells ran alphabetically.
  const schedulingEvents = actionEvents.filter(event => event.stage === "embody" && event.actor.kind === "kernel" && event.actor.id === "jevyr.bone" && event.payload.actionType === "investigation.evidence-schedule" && event.payload.status === "completed");
  const scheduledCells = new Map<string, number>();
  if (schedulingEvents.length > 0) {
    const scheduleKeys: string[] = [];
    for (const event of schedulingEvents) {
      try {
        const artifactDigest = event.payload.artifactDigests?.length === 1 ? event.payload.artifactDigests[0] : undefined;
        if (!artifactDigest) throw new Error("Missing schedule artifact");
        const bytes = await resolve(artifactDigest);
        if (!(bytes instanceof Uint8Array) || sha256Digest(bytes) !== artifactDigest) throw new Error("Mismatched schedule bytes");
        const decision = parseJsonBytes(bytes, "adaptive scheduling decision") as Record<string, JsonValue>;
        if (canonicalize(decision) !== Buffer.from(bytes).toString("utf8")) throw new Error("Noncanonical schedule");
        const { digest, ...body } = decision;
        if (decision.protocol !== "jevyr.evidence-scheduling-decision/1" || digest !== digestJson(body) || digest !== event.payload.actionId || typeof decision.candidateId !== "string" || typeof decision.assayId !== "string" || decision.measurement !== "HEURISTIC") throw new Error("Invalid schedule identity");
        const key = cellKey(decision.candidateId, decision.assayId);
        if (!expectedKeys.includes(key) || scheduledCells.has(key)) throw new Error("Schedule changed the sealed population");
        const plan = frontier.assays.find(plan => plan.assayId === decision.assayId);
        if (plan?.costUnits !== decision.costUnits) throw new Error("Schedule changed the sealed cost");
        scheduledCells.set(key, event.sequence);
        scheduleKeys.push(key);
      } catch {
        problems.push(replayProblem("STATUS_ORDER_MISMATCH", "An adaptive schedule decision is missing, corrupt, duplicated, or outside the sealed candidate-assay population.", event));
      }
    }
    if (scheduleKeys.length !== expectedKeys.length) problems.push(replayProblem("MATRIX_INCOMPLETE", "Adaptive scheduling did not commit every sealed baseline cell exactly once."));
    else expectedKeys = scheduleKeys;
  }
  const baseByCell = new Map<string, CaseEvent<"evidence.observed">[]>();
  for (const event of scopedEvidence) {
    const candidateId = event.payload.candidateId as string;
    const assayId = event.payload.assayId as string;
    if (!assayIds.includes(assayId)) {
      problems.push(replayProblem("PLAN_BINDING_MISMATCH", `Candidate ${candidateId} names unknown frontier assay ${assayId}.`, event));
      continue;
    }
    if (hasAuthorityEdge(event)) continue;
    if (event.payload.evidenceType !== "sandbox_execution" && event.payload.evidenceType !== "tool_observation") {
      problems.push(replayProblem(
        "CELL_EVENT_MISMATCH",
        `Candidate ${candidateId}, assay ${assayId} uses ${event.payload.evidenceType} instead of a persisted Forge cell observation.`,
        event,
      ));
      continue;
    }
    const key = cellKey(candidateId, assayId);
    const entries = baseByCell.get(key) ?? [];
    entries.push(event);
    baseByCell.set(key, entries);
  }

  const cellProblems = new Map<string, PersistedAssayEvidenceProblemCode[]>();
  const addCellProblem = (
    key: string,
    code: PersistedAssayEvidenceProblemCode,
    message: string,
    event?: CaseEvent,
  ) => {
    const entry = replayProblem(code, message, event);
    problems.push(entry);
    const codes = cellProblems.get(key) ?? [];
    codes.push(code);
    cellProblems.set(key, codes);
  };
  for (const key of expectedKeys) {
    const base = baseByCell.get(key) ?? [];
    if (base.length === 0) {
      addCellProblem(key, "MATRIX_INCOMPLETE", `The sealed candidate-assay matrix is missing cell ${key.replace("\u0000", "/")}.`);
    } else if (base.length !== 1) {
      addCellProblem(key, "CELL_ARTIFACT_CONFLICT", "A candidate-assay cell has more than one base observation event.", base[1]);
    } else if (scheduledCells.has(key) && scheduledCells.get(key)! >= base[0]!.sequence) {
      addCellProblem(key, "STATUS_ORDER_MISMATCH", "An adaptive schedule decision was committed after its cell result.", base[0]);
    }
  }
  for (const key of baseByCell.keys()) {
    if (!expectedKeys.includes(key)) addCellProblem(key, "MATRIX_INCOMPLETE", "The ledger contains a cell outside the reconstructed matrix.");
  }

  const orderedBaseEvents = expectedKeys.flatMap((key) => baseByCell.get(key)?.slice(0, 1) ?? []);
  for (let index = 1; index < orderedBaseEvents.length; index += 1) {
    const previous = orderedBaseEvents[index - 1];
    const current = orderedBaseEvents[index];
    if (previous !== undefined && current !== undefined && current.sequence <= previous.sequence) {
      problems.push(replayProblem(
        "STATUS_ORDER_MISMATCH",
        "Candidate-assay base observations do not follow their committed scheduling order.",
        current,
      ));
    }
  }

  let initialArtifactBytes = 0;
  const blueprintCharges: { sequence: number; bytes: number }[] = [];
  const blueprintArtifactDigests = new Set<string>();
  const verifiedBlueprints = new Map<string, CompiledCandidateBlueprint>();
  for (const candidate of population?.candidates ?? []) {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await resolve(candidate.blueprintArtifactDigest);
    } catch {
      problems.push(replayProblem("ARTIFACT_RESOLUTION_FAILED", `Blueprint artifact resolution failed for ${candidate.candidateId}.`, populationAction));
    }
    if (bytes !== undefined && !(bytes instanceof Uint8Array)) bytes = undefined;
    if (bytes === undefined) {
      problems.push(replayProblem("ARTIFACT_NOT_FOUND", `Population blueprint artifact is missing for ${candidate.candidateId}.`, populationAction));
    } else {
      const blueprintValue = decodePopulationBlueprintArtifact(
        bytes,
        candidate.blueprintArtifactDigest,
        candidate.blueprintDigest,
      );
      if (blueprintValue === undefined) {
        problems.push(replayProblem("ARTIFACT_DECODE_FAILED", `Population blueprint artifact is invalid for ${candidate.candidateId}.`, populationAction));
      } else {
        if (candidateIgnorePolicy !== undefined) {
          try {
            const verified = verifyCandidateBlueprint(blueprintValue, candidateIgnorePolicy);
            if (verified.blueprintDigest !== candidate.blueprintDigest) {
              throw new TypeError("Verified candidate blueprint digest disagrees with the closed population");
            }
            verifiedBlueprints.set(candidate.candidateId, verified);
          } catch {
            problems.push(replayProblem(
              "CANDIDATE_BLUEPRINT_POLICY_MISMATCH",
              `Population blueprint ${candidate.candidateId} is not valid under the exact candidate ignore policy embedded in the Case policy.`,
              populationAction,
            ));
          }
        }
        // Storage accounting remains physical even when policy validation
        // rejects authority for these otherwise content-addressed bytes.
        if (!blueprintArtifactDigests.has(candidate.blueprintArtifactDigest)) {
          blueprintArtifactDigests.add(candidate.blueprintArtifactDigest);
          initialArtifactBytes += bytes.byteLength;
          blueprintCharges.push({ sequence: populationClosureByCandidate.get(candidate.candidateId) ?? 0, bytes: bytes.byteLength });
        }
      }
    }
  }
  for (const [candidateId, parentId] of revisionParentByCandidate) {
    if (verifiedBlueprints.get(candidateId)?.blueprintDigest === verifiedBlueprints.get(parentId)?.blueprintDigest) problems.push(replayProblem("CANDIDATE_BLUEPRINT_POLICY_MISMATCH", "An appended revision did not change its committed parent blueprint."));
  }
  const blueprintDigests = new Set((population?.candidates ?? []).map((candidate) => candidate.blueprintDigest));
  const publicIdeas = new Map<string, ReturnType<typeof decodePublicIdea>>();
  const publicIdeaCharges: { sequence: number; bytes: number }[] = [];
  for (const event of candidateEvents.filter((candidate) => candidate.payload.status === "proposed")) {
    for (const digest of event.payload.artifactDigests ?? []) {
      if (blueprintDigests.has(digest) || blueprintArtifactDigests.has(digest)) continue;
      let idea = publicIdeas.get(digest);
      if (idea === undefined) {
        let bytes: Uint8Array | undefined;
        try {
          bytes = await resolve(digest);
        } catch {
          problems.push(replayProblem("ARTIFACT_RESOLUTION_FAILED", `Public-idea artifact resolution failed for ${event.payload.candidateId}.`, event));
        }
        if (bytes !== undefined && !(bytes instanceof Uint8Array)) bytes = undefined;
        if (bytes === undefined) {
          problems.push(replayProblem("ARTIFACT_NOT_FOUND", `Public-idea artifact is missing for ${event.payload.candidateId}.`, event));
          continue;
        }
        if (sha256Digest(bytes) !== digest) {
          problems.push(replayProblem("ARTIFACT_DIGEST_MISMATCH", `Public-idea bytes do not match the committed digest for ${event.payload.candidateId}.`, event));
          continue;
        }
        try {
          idea = decodePublicIdea(bytes);
        } catch {
          problems.push(replayProblem("ARTIFACT_DECODE_FAILED", `Public-idea artifact is invalid for ${event.payload.candidateId}.`, event));
          continue;
        }
        publicIdeas.set(digest, idea);
        initialArtifactBytes += bytes.byteLength;
        publicIdeaCharges.push({ sequence: event.sequence, bytes: bytes.byteLength });
      }
      if (idea.candidateId !== event.payload.candidateId) {
        problems.push(replayProblem("ARTIFACT_DECODE_FAILED", "Public-idea candidate identity does not match its proposal event.", event));
      }
    }
  }
  // EMBODY executes before CHALLENGE can publish more abstract ideas. Those
  // later bytes belong in archive telemetry, but not in an older Forge receipt.
  const candidateArtifactBytesAt = (sequence: number): number => initialArtifactBytes
    - publicIdeaCharges.filter((charge) => charge.sequence > sequence).reduce((sum, charge) => sum + charge.bytes, 0)
    - blueprintCharges.filter(charge => charge.sequence > sequence).reduce((sum, charge) => sum + charge.bytes, 0);
  const artifactUsageAt = (sequence: number, current: MutableAggregateUsage): MutableAggregateUsage => ({
    ...current,
    artifactBytes: current.artifactBytes - initialArtifactBytes + candidateArtifactBytesAt(sequence),
  });
  const firstAccountedObservation = orderedBaseEvents
    .map((event) => results.get(event.eventDigest)?.observation)
    .find((observation) => observation !== undefined && boneAssayAccounting(observation) !== undefined);
  const firstAccounting = firstAccountedObservation === undefined ? undefined : boneAssayAccounting(firstAccountedObservation);
  if (firstAccounting !== undefined) {
    const impliedInitialArtifactBytes = firstAccounting.aggregateAfter.artifactStorageBytes
      - firstAccounting.artifactStorageBytes;
    if (!Number.isSafeInteger(impliedInitialArtifactBytes) || impliedInitialArtifactBytes < 0
      || impliedInitialArtifactBytes !== observers.baseline.artifactBytes + candidateArtifactBytesAt(actionEvents.find((event) =>
        event.stage === "embody" && event.payload.actionId === firstAccountedObservation?.invocationId
        && ["completed", "failed", "denied"].includes(event.payload.status))?.sequence ?? 0)) {
      problems.push(replayProblem(
        "RESOURCE_ACCOUNTING_MISMATCH",
        "The first Bone accounting receipt disagrees with the exact pre-execution candidate and diagnostic artifact bytes.",
      ));
    }
  } else {
    const firstExploring = searchEvents
      .filter((event) => event.payload.status === "exploring")
      .sort((left, right) => left.sequence - right.sequence)[0];
    const artifactReading = firstExploring === undefined ? undefined : telemetry(firstExploring, "artifactBytes");
    if (artifactReading?.measurement === "MEASURED"
      && artifactReading.used !== observers.baseline.artifactBytes + candidateArtifactBytesAt(firstExploring?.sequence ?? 0)) {
      problems.push(replayProblem(
        "RESOURCE_ACCOUNTING_MISMATCH",
        "Archive telemetry disagrees with the exact pre-assay candidate artifact bytes.",
        firstExploring,
      ));
    }
  }

  const usage: MutableAggregateUsage = {
    ...observers.baseline,
    artifactBytes: initialArtifactBytes + observers.baseline.artifactBytes,
    attempted: 0,
  };
  let exhaustionReason: string | undefined;
  const runs: ReconstructedRun[] = [];
  const cells: ReplayedAssayCell[] = [];
  const usedAssayEventDigests = new Set<string>();
  const usedSearchEventDigests = new Set<string>();
  const materializationByCandidate = new Map<string, string>();
  let subjectMaterializationDigest: string | undefined;

  for (const key of expectedKeys) {
    const separator = key.indexOf("\u0000");
    const candidateId = key.slice(0, separator);
    const assayId = key.slice(separator + 1);
    const plan = frontier.assays.find((entry) => entry.assayId === assayId);
    const baseEvent = baseByCell.get(key)?.[0];
    if (plan === undefined || baseEvent === undefined) {
      cells.push(Object.freeze({
        candidateId,
        assayId,
        status: "MISSING",
        costUnitsCharged: 0,
        wallMillis: 0,
        artifactBytes: 0,
        problemCodes: sortedUnique(cellProblems.get(key) ?? ["MATRIX_INCOMPLETE"]),
      }));
      continue;
    }
    const result = results.get(baseEvent.eventDigest);
    if (result === undefined || result.entry.status !== "VERIFIED" || result.observation === undefined) {
      const codes = result?.entry.problemCodes ?? ["CELL_EVENT_MISMATCH" as const];
      for (const code of codes) {
        const list = cellProblems.get(key) ?? [];
        list.push(code);
        cellProblems.set(key, list);
      }
      cells.push(Object.freeze({
        candidateId,
        assayId,
        evidenceId: baseEvent.payload.evidenceId,
        contentDigest: baseEvent.payload.contentDigest,
        evidenceType: baseEvent.payload.evidenceType as "sandbox_execution" | "tool_observation",
        status: "REJECTED",
        costUnitsCharged: 0,
        wallMillis: 0,
        artifactBytes: 0,
        problemCodes: sortedUnique(cellProblems.get(key) ?? []),
      }));
      continue;
    }
    const observation = result.observation;
    const normalInvocation = result.cellKind === "authoritative-execution"
      || result.cellKind === "comparative-experiment"
      || result.cellKind === "diagnostic-invocation";
    const observationMetadata = isRecord(observation.metadata) ? observation.metadata : undefined;
    const populationCandidate = populationByCandidate.get(candidateId);
    if (normalInvocation) {
      if (populationCandidate === undefined
        || observationMetadata?.candidateBlueprintDigest !== populationCandidate.blueprintDigest) {
        addCellProblem(key, "OBSERVATION_SCOPE_MISMATCH", "Executed cell blueprint identity disagrees with the closed population.", baseEvent);
      }
      const candidateMaterialization = observationMetadata?.candidateMaterializationDigest;
      const priorCandidateMaterialization = materializationByCandidate.get(candidateId);
      if (!isSha256Digest(candidateMaterialization)
        || (priorCandidateMaterialization !== undefined && priorCandidateMaterialization !== candidateMaterialization)) {
        addCellProblem(key, "OBSERVATION_SCOPE_MISMATCH", "Candidate materialization identity is absent or inconsistent across its assay row.", baseEvent);
      } else {
        materializationByCandidate.set(candidateId, candidateMaterialization);
      }
      const subjectMaterialization = observationMetadata?.subjectMaterializationDigest;
      if (!isSha256Digest(subjectMaterialization)
        || (subjectMaterializationDigest !== undefined && subjectMaterializationDigest !== subjectMaterialization)) {
        addCellProblem(key, "OBSERVATION_SCOPE_MISMATCH", "Subject materialization identity is absent or inconsistent across the frontier.", baseEvent);
      } else {
        subjectMaterializationDigest = subjectMaterialization;
      }
    }
    const expectedEvidenceId = stableId("evidence", { runDigest: baseEvent.runDigest, candidateId, assayId });
    if (baseEvent.payload.evidenceId !== expectedEvidenceId) {
      addCellProblem(key, "CELL_EVENT_MISMATCH", "The base cell evidence identity is not canonical.", baseEvent);
    }
    const executed = observation.oracle?.execution.state === "exited";
    const sealedExperiment = experimentForPlan(experimentCapability, plan);
    if (executed && sealedExperiment?.authority === "comparative-only") {
      const verifiedBlueprint = verifiedBlueprints.get(candidateId);
      const ready = verifiedBlueprint === undefined
        ? false
        : candidateExperimentReadiness(verifiedBlueprint, experimentCapability).experimentIds.includes(assayId);
      if (!ready) {
        addCellProblem(
          key,
          "CANDIDATE_BLUEPRINT_POLICY_MISMATCH",
          "A comparative experiment executed a candidate that did not contain and propose its exact sealed experiment socket.",
          baseEvent,
        );
      }
    }
    if (((result.cellKind === "authoritative-execution" || result.cellKind === "comparative-experiment")
        && (baseEvent.payload.evidenceType !== "sandbox_execution" || !executed))
      || (result.cellKind === "diagnostic-invocation" && baseEvent.payload.evidenceType !== "tool_observation")
      || (result.cellKind === "blocked-refusal"
        && (baseEvent.payload.evidenceType !== "tool_observation" || executed))) {
      addCellProblem(
        key,
        "CELL_EVENT_MISMATCH",
        "The public evidence type does not match the independently replayed authoritative, diagnostic, or pre-execution cell class.",
        baseEvent,
      );
    }
    const matchingActions = actionEvents.filter((event) =>
      event.stage === "embody" && event.payload.actionId === observation.invocationId);
    const startedActions = matchingActions.filter((event) => event.payload.status === "started");
    const terminalActions = matchingActions.filter((event) => ["completed", "failed", "denied"].includes(event.payload.status));
    const terminalAction = terminalActions[0];
    const executionSequence = terminalAction?.sequence ?? 0;
    if ((populationClosureByCandidate.get(candidateId) ?? Number.MAX_SAFE_INTEGER) >= (startedActions[0]?.sequence ?? executionSequence)) addCellProblem(key, "STATUS_ORDER_MISMATCH", "A candidate's own population wave was not committed before its cell began.", terminalAction ?? baseEvent);
    let cellFrontier = frontierAt(executionSequence);
    const unit = revisionResourceUnits.get(candidateId);
    if (unit) {
      if (!revisionResourceOrigins.has(candidateId)) revisionResourceOrigins.set(candidateId, { ...artifactUsageAt(executionSequence, usage) });
      const origin = revisionResourceOrigins.get(candidateId)!;
      const aggregate = cellFrontier.aggregateLimits;
      cellFrontier = { ...cellFrontier, aggregateLimits: {
        maxForgeWallMillis: Math.min(aggregate.maxForgeWallMillis, origin.forgeWallMillis + unit.maxForgeWallMillis),
        maxForgeCpuMillis: Math.min(aggregate.maxForgeCpuMillis, origin.measuredForgeCpuMillis + unit.maxForgeCpuMillis),
        maxTotalAssayCost: Math.min(aggregate.maxTotalAssayCost, origin.totalAssayCost + unit.maxTotalAssayCost),
        maxWritableBytes: Math.min(aggregate.maxWritableBytes, origin.writableBytes + unit.maxWritableBytes),
        maxWritableInodes: Math.min(aggregate.maxWritableInodes, origin.writableInodes + unit.maxWritableInodes),
        maxArtifactBytes: Math.min(aggregate.maxArtifactBytes, origin.artifactBytes + unit.maxArtifactBytes),
      } };
    }
    const priorRefusal = resourceRefusal(artifactUsageAt(executionSequence, usage), plan, cellFrontier, exhaustionReason);
    if (terminalActions.length !== 1
      || terminalAction === undefined
      || terminalAction.sequence >= baseEvent.sequence
      || terminalAction.payload.actionType !== plan.tool) {
      addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "The cell has no unique preceding terminal action accounting event.", terminalAction ?? baseEvent);
    }
    if (normalInvocation) {
      const expectedTerminalStatus = observation.status === "not-executed"
        ? "denied"
        : executed ? "completed" : "failed";
      if (startedActions.length !== 1
        || startedActions[0]?.sequence === undefined
        || startedActions[0].sequence >= (terminalAction?.sequence ?? Number.MAX_SAFE_INTEGER)
        || terminalAction?.payload.status !== expectedTerminalStatus
        || terminalAction.actor.kind !== "forge") {
        addCellProblem(key, "STATUS_ORDER_MISMATCH", "A normal Forge invocation lacks its unique start and observation-derived terminal ordering.", terminalAction ?? baseEvent);
      }
    } else if (startedActions.length !== 0 || terminalAction?.payload.status !== "denied") {
      addCellProblem(key, "STATUS_ORDER_MISMATCH", "A non-executed cell must have exactly one denial and no execution start.", terminalAction ?? baseEvent);
    }

    const physical = physicalReadings(observation);
    const bone = boneAssayAccounting(observation);
    let wallMillis = 0;
    let artifactBytes = 0;
    let artifactStorageBytes = 0;
    let costUnitsCharged = 0;
    if (normalInvocation) {
      if (bone === undefined) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "Executed cell has no canonical Bone accounting receipt.", baseEvent);
      } else {
        wallMillis = bone.wallMillis;
        artifactBytes = bone.artifactOutputBytes;
        artifactStorageBytes = bone.artifactStorageBytes;
        costUnitsCharged = bone.costUnitsCharged;
      }
      if (wallMillis < 1
        || terminalAction?.payload.resource?.wallMillis !== wallMillis
        || costUnitsCharged !== plan.costUnits) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "Bone cell wall/cost accounting disagrees with its action or sealed plan.", terminalAction ?? baseEvent);
      }
      if (terminalAction?.payload.resource?.bytesWritten !== physical.writableBytes
        || bone?.writableBytes !== (physical.writableBytes ?? null)
        || bone?.writableInodes !== (physical.writableInodes ?? null)
        || bone?.cpuMillis !== (physical.cpuMillis ?? null)) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "Action byte accounting disagrees with the persisted measured workspace.", terminalAction ?? baseEvent);
      }
      const metadata = isRecord(observation.metadata) ? observation.metadata : undefined;
      const receipt = isRecord(metadata?.artifactReceipt) ? metadata.artifactReceipt : undefined;
      const receiptRefs = Array.isArray(receipt?.artifactRefs) ? receipt.artifactRefs : undefined;
      const observationRefs = observation.artifactRefs ?? [];
      if (receipt?.protocol !== "jevyr.forge-artifact-receipt/1"
        || receipt.invocationId !== observation.invocationId
        || receiptRefs === undefined
        || receiptRefs.some((entry) => typeof entry !== "string")
        || [...receiptRefs].sort().some((entry, index) => entry !== [...observationRefs].sort()[index])
        || receiptRefs.length !== observationRefs.length
        || receipt.outputBytes !== artifactBytes) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "The persisted artifact receipt does not bind exact output bytes and refs to this invocation.", baseEvent);
      }
      if (physical.byteCeiling !== undefined
        && physical.byteCeiling !== Math.min(frontier.aggregateLimits.maxWritableBytes, Math.max(0, cellFrontier.aggregateLimits.maxWritableBytes - usage.writableBytes))) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "The cell writable-byte ceiling is not the exact aggregate remainder.", baseEvent);
      }
      if (physical.inodeCeiling !== undefined
        && physical.inodeCeiling > Math.min(frontier.aggregateLimits.maxWritableInodes, Math.max(0, cellFrontier.aggregateLimits.maxWritableInodes - usage.writableInodes))) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "The cell writable-inode ceiling exceeds the aggregate remainder.", baseEvent);
      }
      if (priorRefusal !== undefined) {
        addCellProblem(
          key,
          "EXHAUSTION_MISMATCH",
          `The cell executed after the sealed aggregate envelope required refusal: ${priorRefusal}`,
          baseEvent,
        );
      }
      usage.forgeWallMillis += wallMillis;
      usage.totalAssayCost += costUnitsCharged;
      usage.artifactBytes += artifactStorageBytes;
      usage.attempted += 1;
      if (executed && physical.cpuMillis === undefined) usage.cpuUnmeasured = true;
      else if (physical.cpuMillis !== undefined) {
        usage.cpuMeasurements += 1;
        usage.measuredForgeCpuMillis += physical.cpuMillis;
      }
      if (executed && (physical.writableBytes === undefined || physical.writableInodes === undefined)) {
        usage.workspaceUnmeasured = true;
      } else if (physical.writableBytes !== undefined && physical.writableInodes !== undefined) {
        usage.writableBytes += physical.writableBytes;
        usage.writableInodes += physical.writableInodes;
      }
      if (bone !== undefined) {
        const aggregate = bone.aggregateAfter;
        if (aggregate.forgeWallMillis !== usage.forgeWallMillis
          || aggregate.measuredForgeCpuMillis !== usage.measuredForgeCpuMillis
          || aggregate.cpuMeasurements !== usage.cpuMeasurements
          || aggregate.cpuUnmeasured !== usage.cpuUnmeasured
          || aggregate.workspaceUnmeasured !== usage.workspaceUnmeasured
          || aggregate.totalAssayCost !== usage.totalAssayCost
          || aggregate.writableBytes !== usage.writableBytes
          || aggregate.writableInodes !== usage.writableInodes
          || aggregate.artifactStorageBytes !== artifactUsageAt(executionSequence, usage).artifactBytes) {
          addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "Bone aggregate-after accounting does not equal the reconstructed running sum.", baseEvent);
        }
      }
      const postProblem = postExecutionResourceProblem(artifactUsageAt(executionSequence, usage), executed, physical, cellFrontier);
      if (postProblem !== undefined) exhaustionReason ??= postProblem;
      if (postProblem !== undefined
        && (result.entry.aggregateAdmissible !== false || result.entry.recordedTypedStatus !== "BLOCKED")) {
        addCellProblem(
          key,
          "AGGREGATE_ADMISSIBILITY_MISMATCH",
          "A cell that crossed aggregate physics was not conservatively persisted as BLOCKED and inadmissible.",
          baseEvent,
        );
      }
    } else {
      if (priorRefusal !== undefined) {
        exhaustionReason ??= priorRefusal;
        if (observation.summary !== exhaustionReason) {
          addCellProblem(key, "EXHAUSTION_MISMATCH", "The blocked cell does not name the exact sticky aggregate-exhaustion reason.", baseEvent);
        }
      }
      if (bone === undefined
        || bone.wallMillis !== 0
        || bone.costUnitsCharged !== 0
        || bone.artifactOutputBytes !== 0
        || bone.artifactStorageBytes !== 0
        || bone.cpuMillis !== null
        || bone.writableBytes !== null
        || bone.writableInodes !== null
        || bone.aggregateAfter.forgeWallMillis !== usage.forgeWallMillis
        || bone.aggregateAfter.measuredForgeCpuMillis !== usage.measuredForgeCpuMillis
        || bone.aggregateAfter.cpuMeasurements !== usage.cpuMeasurements
        || bone.aggregateAfter.cpuUnmeasured !== usage.cpuUnmeasured
        || bone.aggregateAfter.workspaceUnmeasured !== usage.workspaceUnmeasured
        || bone.aggregateAfter.totalAssayCost !== usage.totalAssayCost
        || bone.aggregateAfter.writableBytes !== usage.writableBytes
        || bone.aggregateAfter.writableInodes !== usage.writableInodes
        || bone.aggregateAfter.artifactStorageBytes !== artifactUsageAt(executionSequence, usage).artifactBytes) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "Blocked cell does not carry the exact zero-charge aggregate snapshot.", baseEvent);
      }
    }

    const effectiveAdmissible = (result.cellKind === "authoritative-execution"
      || result.cellKind === "comparative-experiment")
      && executed
      && result.entry.aggregateAdmissible === true
      && postExecutionResourceProblem(artifactUsageAt(executionSequence, usage), executed, physical, cellFrontier) === undefined;
    const expectedStatus = normalInvocation
      ? assayStatusFor({ ...result.entry, aggregateAdmissible: effectiveAdmissible }, observation)
      : "blocked";
    const run: ReconstructedRun = Object.freeze({
      candidateId,
      plan,
      baseEvent,
      result,
      observation,
      ...(result.obligation === undefined ? {} : { obligation: result.obligation }),
      wallMillis,
      ...(physical.cpuMillis === undefined ? {} : { cpuMillis: physical.cpuMillis }),
      ...(physical.writableBytes === undefined ? {} : { writableBytes: physical.writableBytes }),
      ...(physical.writableInodes === undefined ? {} : { writableInodes: physical.writableInodes }),
      artifactBytes,
      artifactStorageBytes,
      costUnitsCharged,
      admissible: effectiveAdmissible,
      expectedStatus,
      ...(!executed && observation.summary ? { blockedReason: observation.summary } : {}),
    });
    runs.push(run);

    const comparativeId = stableId("assay", { runDigest: baseEvent.runDigest, candidateId, assayId });
    const comparative = assayEvents.filter((event) =>
      event.payload.assayId === comparativeId && event.payload.critical === false);
    if (comparative.length !== 1) {
      addCellProblem(key, "CELL_EVENT_MISMATCH", "The cell lacks exactly one comparative assay-status event.", comparative[1] ?? comparative[0] ?? baseEvent);
    } else {
      const event = comparative[0] as CaseEvent<"assay.status">;
      usedAssayEventDigests.add(event.eventDigest);
      if (event.actor.kind !== "kernel"
        || event.payload.candidateId !== candidateId
        || event.payload.status !== expectedStatus
        || event.payload.obligationId !== result.obligation?.id
        || event.payload.evidenceIds?.length !== 1
        || event.payload.evidenceIds[0] !== baseEvent.payload.evidenceId
        || event.sequence <= baseEvent.sequence) {
        addCellProblem(key, "CELL_EVENT_MISMATCH", "Comparative assay status disagrees with replayed typed evidence.", event);
      }
    }
    const exploring = searchEvents.filter((event) =>
      event.payload.status === "exploring"
      && event.payload.candidateId === candidateId
      && event.payload.assayId === assayId);
    if (exploring.length !== 1) {
      addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "The cell lacks exactly one cumulative archive telemetry event.", exploring[1] ?? exploring[0] ?? baseEvent);
    } else {
      const event = exploring[0] as CaseEvent<"search.status">;
      usedSearchEventDigests.add(event.eventDigest);
      const comparativeSequence = comparative[0]?.sequence ?? baseEvent.sequence;
      if (event.actor.kind !== "kernel"
        || event.sequence <= comparativeSequence
        || event.payload.attempted !== usage.attempted
        || event.payload.termination !== undefined
        || event.payload.assayArchive?.measuredEntries !== 0
        || event.payload.assayArchive.occupiedNiches !== 0
        || event.payload.assayArchive.lastMeasuredNovelty !== undefined) {
        addCellProblem(key, "RESOURCE_ACCOUNTING_MISMATCH", "Per-cell search telemetry has fabricated counters, archive state, or ordering.", event);
      }
      const telemetryProblems = validateAggregateTelemetry(event, artifactUsageAt(event.sequence, usage), frontierAt(event.sequence));
      problems.push(...telemetryProblems);
      if (telemetryProblems.length > 0) {
        const codes = cellProblems.get(key) ?? [];
        codes.push("RESOURCE_ACCOUNTING_MISMATCH");
        cellProblems.set(key, codes);
      }
    }

    cells.push(Object.freeze({
      candidateId,
      assayId,
      evidenceId: baseEvent.payload.evidenceId,
      contentDigest: baseEvent.payload.contentDigest,
      evidenceType: baseEvent.payload.evidenceType as "sandbox_execution" | "tool_observation",
      status: (cellProblems.get(key)?.length ?? 0) === 0 ? "VERIFIED" : "REJECTED",
      expectedAssayStatus: expectedStatus,
      aggregateAdmissible: effectiveAdmissible,
      costUnitsCharged,
      wallMillis,
      artifactBytes,
      problemCodes: sortedUnique(cellProblems.get(key) ?? []),
    }));
  }

  const firstCellSequence = Math.min(
    ...orderedBaseEvents.map((event) => event.sequence),
    ...actionEvents
      .filter((event) => event.stage === "embody" && event.payload.actionType === "forge.command")
      .map((event) => event.sequence),
  );
  if (populationAction !== undefined
    && Number.isFinite(firstCellSequence)
    && populationAction.sequence >= firstCellSequence) {
    problems.push(replayProblem(
      "STATUS_ORDER_MISMATCH",
      "The candidate population was not closed before the first frontier cell action.",
      populationAction,
    ));
  }

  const archive = new QualityDiversityArchive(frontier.archive);
  const measuredCandidateIds = new Set<string>();
  const contradictedByCandidate = new Map<string, boolean>();
  const archiveOutcomeSequences: number[] = [];
  let previousArchiveOutcomeSequence = orderedBaseEvents.at(-1)?.sequence ?? populationAction?.sequence ?? 0;
  for (const [ordinal, candidateId] of candidateIds.entries()) {
    const candidateRuns = runs.filter((run) => run.candidateId === candidateId);
    const measurable = exhaustionReason === undefined
      && candidateRuns.length === frontier.assays.length
      && frontier.assays.length > 0
      && candidateRuns.every((run) => run.admissible
        && run.result.entry.evaluation?.decisive === true
        && run.observation.oracle?.execution.state === "exited"
        && run.writableBytes !== undefined
        && run.writableInodes !== undefined);
    let expectedSearchStatus: "archive_changed" | "completed" = "completed";
    let expectedNovelty: number | undefined;
    if (measurable) {
      measuredCandidateIds.add(candidateId);
      const proposal = candidateEvents.find((event) =>
        event.payload.candidateId === candidateId && event.payload.status === "proposed");
      const evaluation = measuredCandidateEvaluation(candidateRuns, frontier.aggregateLimits.maxForgeWallMillis);
      const candidate: SearchCandidate = Object.freeze({
        id: candidateId,
        ordinal: ordinal + 1,
        lineage: `assay:${candidateId}`,
        phase: "COEVOLVE",
        parentIds: Object.freeze([...(proposal?.payload.parentIds ?? [])]),
        publicSummary: `Finite candidate ${candidateId} under the sealed Assay Frontier.`,
        payload: {
          candidateId,
          assayFrontierDigest: frontier.digest,
          observations: candidateRuns.map((run) => ({
            assayId: run.plan.assayId,
            observationDigest: run.baseEvent.payload.contentDigest,
            oracleStatus: run.result.entry.evaluation?.status ?? "NOT_APPLICABLE",
          })),
        },
        descriptor: measuredBehaviorDescriptor(candidateRuns, frontier.aggregateLimits.maxForgeWallMillis),
      });
      const decision = archive.consider(candidate, evaluation);
      expectedSearchStatus = decision.accepted ? "archive_changed" : "completed";
      expectedNovelty = decision.entry.novelty;
    }
    contradictedByCandidate.set(candidateId, candidateRuns.some((run) =>
      run.admissible && run.result.entry.evaluation?.status === "FAILED"));
    const outcomeEvents = searchEvents.filter((event) =>
      event.payload.candidateId === candidateId
      && event.payload.assayId === undefined
      && event.payload.status !== "exploring");
    if (outcomeEvents.length !== 1) {
      problems.push(replayProblem(
        "ARCHIVE_STATE_MISMATCH",
        `Candidate ${candidateId} lacks exactly one archive-admission result.`,
        outcomeEvents[1] ?? outcomeEvents[0],
      ));
      continue;
    }
    const outcome = outcomeEvents[0] as CaseEvent<"search.status">;
    usedSearchEventDigests.add(outcome.eventDigest);
    archiveOutcomeSequences.push(outcome.sequence);
    if (outcome.actor.kind !== "kernel"
      || outcome.sequence <= previousArchiveOutcomeSequence
      || outcome.payload.status !== expectedSearchStatus
      || outcome.payload.attempted !== usage.attempted
      || outcome.payload.termination !== (exhaustionReason === undefined ? undefined : "RESOURCE_EXHAUSTED")
      || outcome.payload.assayArchive?.measuredEntries !== archive.size
      || outcome.payload.assayArchive.occupiedNiches !== archive.niches
      || outcome.payload.assayArchive.lastMeasuredNovelty !== expectedNovelty) {
      problems.push(replayProblem(
        "ARCHIVE_STATE_MISMATCH",
        `Candidate ${candidateId} archive telemetry disagrees with deterministic admission replay.`,
        outcome,
      ));
    }
    problems.push(...validateAggregateTelemetry(outcome, artifactUsageAt(outcome.sequence, usage), frontierAt(outcome.sequence)));
    previousArchiveOutcomeSequence = outcome.sequence;
  }

  const finalArchive = archive.entries();
  const survivorCandidateIds = finalArchive.map((entry) => entry.candidate.id).sort();
  const survivorSet = new Set(survivorCandidateIds);
  const usedCandidateEventDigests = new Set<string>();
  const closureSequences: number[] = [];
  let previousClosureSequence = archiveOutcomeSequences.at(-1) ?? previousArchiveOutcomeSequence;
  for (const candidateId of candidateIds) {
    const closures = candidateEvents.filter((event) =>
      event.payload.candidateId === candidateId
      && (event.payload.status === "survived" || event.payload.status === "invalidated"));
    if (closures.length !== 1) {
      problems.push(replayProblem(
        "ARCHIVE_STATE_MISMATCH",
        `Candidate ${candidateId} lacks exactly one post-archive survivor closure.`,
        closures[1] ?? closures[0],
      ));
      continue;
    }
    const closure = closures[0] as CaseEvent<"candidate.status">;
    usedCandidateEventDigests.add(closure.eventDigest);
    closureSequences.push(closure.sequence);
    const expectedStatus = survivorSet.has(candidateId) ? "survived" : "invalidated";
    const expectedFeasibility = expectedStatus === "survived"
      ? "BUILDABLE_NOW"
      : contradictedByCandidate.get(candidateId) === true ? "CONTRADICTED" : undefined;
    if (closure.stage !== "assay"
      || closure.actor.kind !== "kernel"
      || closure.sequence <= previousClosureSequence
      || closure.payload.status !== expectedStatus
      || closure.payload.feasibility !== expectedFeasibility) {
      problems.push(replayProblem(
        "ARCHIVE_STATE_MISMATCH",
        `Candidate ${candidateId} survivor status was not derived from the closed deterministic archive.`,
        closure,
      ));
    }
    previousClosureSequence = closure.sequence;
  }

  const flagship = selectArchiveFlagship(finalArchive);
  const selectedEvents = candidateEvents.filter((event) => event.payload.status === "selected");
  const selected = selectedEvents[0];
  if (flagship === undefined) {
    if (selectedEvents.length > 0) {
      problems.push(replayProblem("FLAGSHIP_MISMATCH", "The ledger selected a flagship from an empty replayed archive.", selected));
    }
  } else if (selectedEvents.length !== 1
    || selected === undefined
    || selected.stage !== "assay"
    || selected.actor.kind !== "kernel"
    || selected.payload.candidateId !== flagship.candidate.id
    || selected.payload.feasibility !== "BUILDABLE_NOW"
    || selected.sequence <= previousClosureSequence) {
    problems.push(replayProblem(
      "FLAGSHIP_MISMATCH",
      `The selected status does not name the replayed flagship ${flagship.candidate.id} after survivor closure.`,
      selected,
    ));
  } else {
    usedCandidateEventDigests.add(selected.eventDigest);
  }

  const usedAuthorityEventDigests = new Set<string>();
  const authorityEdges: VerifiedEvidenceEdge[] = [];
  let previousAdjudicativeSequence = selected?.sequence ?? previousClosureSequence;
  if (flagship !== undefined && selectedEvents.length === 1 && selected?.payload.candidateId === flagship.candidate.id) {
    for (const run of runs.filter((entry) => entry.candidateId === flagship.candidate.id)) {
      const evaluation = run.result.entry.evaluation;
      if (run.obligation === undefined || !run.admissible || evaluation?.decisive !== true) continue;
      const evidenceId = stableId("evidence", {
        runDigest: run.baseEvent.runDigest,
        candidateId: run.candidateId,
        assayId: run.plan.assayId,
        scope: "selected-candidate",
      });
      const authorityEvents = evidenceEvents.filter((event) =>
        event.payload.evidenceId === evidenceId && hasAuthorityEdge(event));
      if (authorityEvents.length !== 1) {
        problems.push(replayProblem(
          "FLAGSHIP_MISMATCH",
          `Selected cell ${run.candidateId}/${run.plan.assayId} lacks exactly one winner-scoped authority event.`,
          authorityEvents[1] ?? authorityEvents[0] ?? selected,
        ));
        continue;
      }
      const authorityEvent = authorityEvents[0] as CaseEvent<"evidence.observed">;
      usedAuthorityEventDigests.add(authorityEvent.eventDigest);
      const authorityResult = results.get(authorityEvent.eventDigest);
      const expectedEdge = evaluation.status === "PASSED" ? "SUPPORT" : "REFUTE";
      const authorityEventValid = authorityEvent.stage === "assay"
        && authorityEvent.actor.kind === "forge"
        && authorityEvent.payload.evidenceType === "sandbox_execution"
        && authorityEvent.payload.candidateId === run.candidateId
        && authorityEvent.payload.assayId === run.plan.assayId
        && authorityEvent.payload.contentDigest === run.baseEvent.payload.contentDigest
        && authorityEvent.sequence > previousAdjudicativeSequence
        && authorityResult?.entry.status === "VERIFIED"
        && authorityResult.entry.authorityEdge === expectedEdge;
      if (!authorityEventValid) {
        problems.push(replayProblem(
          "FLAGSHIP_MISMATCH",
          "Winner-scoped authority does not follow selection or match the replayed cell and typed oracle.",
          authorityEvent,
        ));
      } else {
        authorityEdges.push(Object.freeze({
          eventDigest: authorityEvent.eventDigest,
          evidenceId: authorityEvent.payload.evidenceId,
          contentDigest: authorityEvent.payload.contentDigest,
          targetId: run.obligation.id,
          kind: expectedEdge === "SUPPORT" ? "supports" : "refutes",
        }));
      }
      previousAdjudicativeSequence = authorityEvent.sequence;
      const criticalId = stableId("assay", {
        runDigest: run.baseEvent.runDigest,
        candidateId: run.candidateId,
        assayId: run.plan.assayId,
      });
      const criticalEvents = assayEvents.filter((event) =>
        event.payload.assayId === criticalId
        && event.payload.critical === true
        && event.payload.evidenceIds?.includes(evidenceId));
      if (criticalEvents.length !== 1) {
        problems.push(replayProblem(
          "CELL_EVENT_MISMATCH",
          `Selected cell ${run.candidateId}/${run.plan.assayId} lacks its unique critical status.`,
          criticalEvents[1] ?? criticalEvents[0] ?? authorityEvent,
        ));
      } else {
        const critical = criticalEvents[0] as CaseEvent<"assay.status">;
        usedAssayEventDigests.add(critical.eventDigest);
        if (critical.actor.kind !== "kernel"
          || critical.payload.candidateId !== run.candidateId
          || critical.payload.obligationId !== run.obligation.id
          || critical.payload.status !== (evaluation.status === "PASSED" ? "passed" : "failed")
          || critical.payload.evidenceIds?.length !== 1
          || critical.sequence <= authorityEvent.sequence) {
          problems.push(replayProblem("CELL_EVENT_MISMATCH", "Critical assay status disagrees with winner-scoped typed evidence.", critical));
        }
        previousAdjudicativeSequence = critical.sequence;
      }
    }
  }

  for (const event of evidenceEvents.filter(hasAuthorityEdge)) {
    if (!usedAuthorityEventDigests.has(event.eventDigest)) {
      problems.push(replayProblem(
        "FLAGSHIP_MISMATCH",
        "An authority edge was emitted outside the selected flagship's post-closure adjudication.",
        event,
      ));
    }
  }

  // A closed population rejection is a finite assay result, never an edge
  // refuting a universal goal. Reconstruct every member's failed bound oracle
  // independently before allowing this aggregate critical failure.
  if (flagship === undefined && candidateIds.length > 0 && candidateIds.every((id) => measuredCandidateIds.has(id))) {
    const failedRuns = candidateIds.map((candidateId) => runs.find((run) =>
      run.candidateId === candidateId && run.admissible && run.result.entry.evaluation?.decisive === true
      && run.result.entry.evaluation.status === "FAILED" && run.obligation?.critical === true));
    if (failedRuns.every((run) => run !== undefined)) {
      const expectedId = stableId("assay", { runDigest: events[0]?.runDigest, scope: "closed-population" });
      const closures = assayEvents.filter((event) => event.payload.assayId === expectedId);
      const expectedEvidenceIds = failedRuns.map((run) => run!.baseEvent.payload.evidenceId).sort();
      if (closures.length !== 1) {
        problems.push(replayProblem("CELL_EVENT_MISMATCH", "A decisively exhausted admitted population lacks its unique aggregate failed assay closure.", closures[1] ?? closures[0]));
      } else {
        const closure = closures[0]!;
        usedAssayEventDigests.add(closure.eventDigest);
        if (closure.actor.kind !== "kernel" || closure.stage !== "assay" || closure.payload.scope !== "closed_population"
          || closure.payload.critical !== true || closure.payload.status !== "failed" || closure.payload.candidateId !== undefined || closure.payload.obligationId !== undefined
          || JSON.stringify(closure.payload.populationIds) !== JSON.stringify(candidateIds)
          || JSON.stringify(closure.payload.evidenceIds) !== JSON.stringify(expectedEvidenceIds)
          || closure.sequence <= previousAdjudicativeSequence) {
          problems.push(replayProblem("CELL_EVENT_MISMATCH", "Closed population rejection disagrees with the exact independently replayed failed observations, population, or ordering.", closure));
        }
        previousAdjudicativeSequence = closure.sequence;
      }
    }
  }

  const requestedObligations = contract.criticalObligations.filter((obligation) => obligation.origin === "requested_assay");
  for (const obligation of requestedObligations) {
    const covered = flagship !== undefined && runs.some((run) =>
      run.candidateId === flagship.candidate.id
      && run.obligation?.id === obligation.id
      && run.admissible
      && run.result.entry.evaluation?.decisive === true);
    if (covered) continue;
    const expectedId = stableId("assay", {
      runDigest: events[0]?.runDigest,
      candidateId: flagship?.candidate.id ?? null,
      obligationId: obligation.id,
      scope: "uncovered-request",
    });
    const blocked = assayEvents.filter((event) => event.payload.assayId === expectedId);
    if (blocked.length !== 1) {
      problems.push(replayProblem("CELL_EVENT_MISMATCH", `Requested obligation ${obligation.id} lacks deterministic blocked closure.`, blocked[1] ?? blocked[0]));
    } else {
      const event = blocked[0] as CaseEvent<"assay.status">;
      usedAssayEventDigests.add(event.eventDigest);
      if (event.actor.kind !== "kernel"
        || event.payload.critical !== true
        || event.payload.status !== "blocked"
        || event.payload.obligationId !== obligation.id
        || event.payload.candidateId !== flagship?.candidate.id
        || event.payload.evidenceIds !== undefined
        || event.sequence <= previousAdjudicativeSequence) {
        problems.push(replayProblem("CELL_EVENT_MISMATCH", "Requested-assay blocked closure has fabricated scope, status, or ordering.", event));
      }
      previousAdjudicativeSequence = event.sequence;
    }
  }

  for (const event of assayEvents) {
    if (!usedAssayEventDigests.has(event.eventDigest)) {
      problems.push(replayProblem("CELL_EVENT_MISMATCH", "An assay status is not derivable from a replayed matrix cell or uncovered requested obligation.", event));
    }
  }
  for (const event of candidateEvents.filter((entry) =>
    entry.payload.status === "survived" || entry.payload.status === "invalidated" || entry.payload.status === "selected")) {
    if (!usedCandidateEventDigests.has(event.eventDigest)) {
      problems.push(replayProblem("ARCHIVE_STATE_MISMATCH", "A candidate outcome status is not derivable from final archive closure.", event));
    }
  }
  for (const event of searchEvents.filter((entry) => entry.payload.candidateId !== undefined)) {
    if (!usedSearchEventDigests.has(event.eventDigest)) {
      problems.push(replayProblem("ARCHIVE_STATE_MISMATCH", "Candidate-scoped archive telemetry is duplicated or not derivable from replay.", event));
    }
  }

  const policyCompiledEvents = events.filter(
    (event): event is CaseEvent<"kernel.status"> => event.kind === "kernel.status"
      && event.payload.operation === "policy_compiled",
  );
  if (mode === "precompile") {
    if (policyCompiledEvents.length !== 0) {
      problems.push(replayProblem(
        "STATUS_ORDER_MISMATCH",
        "Pre-compilation replay requires exactly zero policy_compiled markers.",
        policyCompiledEvents[0],
      ));
    }
  } else if (policyCompiledEvents.length !== 1) {
    problems.push(replayProblem(
      "STATUS_ORDER_MISMATCH",
      "Strict replay requires exactly one assay policy_compiled marker.",
      policyCompiledEvents[1] ?? policyCompiledEvents[0],
    ));
  } else {
    const policyCompiled = policyCompiledEvents[0] as CaseEvent<"kernel.status">;
    const descriptor = isRecord(policyDescriptor) ? policyDescriptor : undefined;
    const policyVersion = typeof descriptor?.version === "string" && descriptor.version.length > 0
      ? descriptor.version
      : undefined;
    // The marker commits the deterministic policy state that existed at its
    // ledger position. Later Reflex/Mind events are part of the final Record,
    // but cannot retroactively change the digest Bone emitted at Assay
    // closure. Authority-bearing assay events are still required above to
    // precede the marker, so taking this prefix cannot hide a late authority
    // edge.
    const committedPrefix = events.filter((event) => event.sequence < policyCompiled.sequence);
    const committedEventDigests = new Set(committedPrefix.map(event => event.eventDigest));
    const projection = projectEvents(committedPrefix, {
      ...(policyVersion === undefined ? {} : { policyVersion }),
      ...formalProofReplayOptions(policyDescriptor),
      intentContract: contract,
      verifiedEvidenceEdges: authorityEdges,
      verifiedOriginalSubjectEdges: (originalSubject?.verifiedOriginalSubjectEdges ?? []).filter(edge => committedEventDigests.has(edge.eventDigest)),
      ...(originalSubject?.originalSubjectContext ? {originalSubjectContext:originalSubject.originalSubjectContext} : {}),
    });
    const expectedVerdictDigest = digestJson(compileVerdict(projection.input) as unknown as JsonValue);
    if (policyCompiled.stage !== "assay"
      || policyCompiled.sequence <= previousAdjudicativeSequence
      || policyCompiled.actor.kind !== "kernel"
      || policyCompiled.actor.id !== "jevyr.bone"
      || policyCompiled.payload.artifactDigest !== expectedVerdictDigest) {
      problems.push(replayProblem(
        "STATUS_ORDER_MISMATCH",
        "The policy_compiled marker is not a post-closure Bone commitment to the independently projected verdict.",
        policyCompiled,
      ));
    }
  }

  const matrixComplete = expectedKeys.length === cells.length
    && expectedKeys.every((key) => (baseByCell.get(key)?.length ?? 0) === 1)
    && cells.every((cell) => cell.status === "VERIFIED");
  const archiveArtifactBytes = artifactUsageAt(
    Math.max(populationAction?.sequence ?? 0, ...events.filter((event) => event.stage === "assay").map((event) => event.sequence)),
    usage,
  ).artifactBytes;
  const state: ReplayedAssayFrontierState = Object.freeze({
    candidateIds: Object.freeze([...candidateIds]),
    assayIds: Object.freeze([...assayIds]),
    expectedCellCount: expectedKeys.length,
    observedCellCount: [...baseByCell.values()].reduce((sum, entries) => sum + entries.length, 0),
    matrixComplete,
    resourceExhausted: exhaustionReason !== undefined,
    attempted: usage.attempted,
    aggregateUsage: Object.freeze({
      forgeWallMillis: usage.forgeWallMillis,
      forgeCpuMillis: usage.cpuMeasurements > 0 && !usage.cpuUnmeasured ? usage.measuredForgeCpuMillis : null,
      writableBytes: usage.workspaceUnmeasured ? null : usage.writableBytes,
      writableInodes: usage.workspaceUnmeasured ? null : usage.writableInodes,
      artifactBytes: archiveArtifactBytes,
      totalAssayCost: usage.totalAssayCost,
    }),
    survivorCandidateIds: Object.freeze([...survivorCandidateIds]),
    ...(flagship === undefined ? {} : { selectedCandidateId: flagship.candidate.id }),
    cells: Object.freeze(cells),
  });
  return Object.freeze({
    state,
    problems: Object.freeze(problems),
    authorityEdges: Object.freeze(authorityEdges),
  });
}

function assertExactFrontier(frontier: AssayFrontier): AssayFrontier {
  // Frontier verification only reads the six aggregate fields represented by
  // AssayAggregateLimits. No external resource policy is guessed during replay.
  return verifyAssayFrontier(
    frontier,
    frontier.aggregateLimits as unknown as SearchResourceEnvelope,
  );
}

function policyBindsExactFrontier(
  policyDescriptor: unknown,
  frontier: AssayFrontier,
): boolean {
  const descriptor = isRecord(policyDescriptor) ? policyDescriptor : undefined;
  const effective = isRecord(descriptor?.policy) ? descriptor.policy : undefined;
  if (descriptor?.protocol !== "jevyr.policy-descriptor/1"
    || typeof descriptor.version !== "string"
    || descriptor.version.length === 0
    || effective?.protocol !== "jevyr.effective-policy/1"
    || effective.assayFrontierDigest !== frontier.digest
    || effective.assayFrontier === undefined) {
    return false;
  }
  try {
    const embedded = verifyAssayFrontier(
      effective.assayFrontier as AssayFrontier,
      frontier.aggregateLimits as unknown as SearchResourceEnvelope,
    );
    return embedded.digest === frontier.digest
      && digestJson(embedded as unknown as JsonValue) === digestJson(frontier as unknown as JsonValue);
  } catch {
    return false;
  }
}

type CandidateIgnorePolicyBinding = Readonly<
  | { verified: true; policy: JevyrIgnorePolicy }
  | { verified: false; reason: string }
>;

/** Reconstructs the executable path policy from only its signed descriptor. */
function candidateIgnorePolicyBinding(policyDescriptor: unknown): CandidateIgnorePolicyBinding {
  const descriptor = isRecord(policyDescriptor) ? policyDescriptor : undefined;
  const effective = isRecord(descriptor?.policy) ? descriptor.policy : undefined;
  const embedded = isRecord(effective?.candidateIgnorePolicy)
    ? effective.candidateIgnorePolicy
    : undefined;
  if (descriptor?.protocol !== "jevyr.policy-descriptor/1"
    || effective?.protocol !== "jevyr.effective-policy/1"
    || embedded === undefined
    || !hasExactKeys(embedded, ["protocol", "source", "sourceDigest", "sourceBytes"])
    || embedded.protocol !== "jevyr.ignore-policy/1"
    || typeof embedded.source !== "string"
    || embedded.source.length > MAX_JEVYR_IGNORE_BYTES
    || !isSha256Digest(embedded.sourceDigest)
    || !Number.isSafeInteger(embedded.sourceBytes)
    || (embedded.sourceBytes as number) < 0
    || effective.candidateIgnorePolicyDigest !== embedded.sourceDigest) {
    return Object.freeze({
      verified: false,
      reason: "The Case policy does not contain one exact digest-bound candidate ignore-policy descriptor.",
    });
  }
  const source = embedded.source;
  const sourceBytes = new TextEncoder().encode(source);
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
  } catch {
    return Object.freeze({ verified: false, reason: "The embedded candidate ignore policy is not valid UTF-8." });
  }
  if (decoded !== source
    || sourceBytes.byteLength !== embedded.sourceBytes
    || sourceBytes.byteLength > MAX_JEVYR_IGNORE_BYTES
    || sha256Digest(sourceBytes) !== embedded.sourceDigest) {
    return Object.freeze({
      verified: false,
      reason: "The embedded candidate ignore-policy source, byte length, and digest do not agree.",
    });
  }
  try {
    const policy = compileJevyrIgnorePolicy(".", sourceBytes, MAX_JEVYR_IGNORE_BYTES);
    if (policy.sourceDigest !== embedded.sourceDigest || policy.sourceBytes !== embedded.sourceBytes) {
      return Object.freeze({
        verified: false,
        reason: "The compiled candidate ignore policy does not reproduce its embedded descriptor.",
      });
    }
    return Object.freeze({ verified: true, policy });
  } catch {
    return Object.freeze({
      verified: false,
      reason: "The embedded candidate ignore-policy source cannot be compiled exactly.",
    });
  }
}

/**
 * Replays the complete persisted candidate-assay topology against its exact
 * policy, population, ToolObservation bytes, resource receipts, and archive
 * rules. Rejections remain data in the report; this function never turns the
 * evidence into an ACCEPT/REJECT judgment for the Case.
 */
export async function verifyPersistedAssayEvidence(
  events: readonly CaseEvent[],
  intentContract: IntentContract,
  assayFrontier: AssayFrontier,
  policyDescriptor: unknown,
  resolveArtifact: AssayEvidenceArtifactResolver,
  options: PersistedAssayEvidenceReplayOptions = {},
): Promise<PersistedAssayEvidenceReplayReport> {
  assertIntentContractShape(intentContract);
  assertIntentContract(intentContract);
  const frontier = assertExactFrontier(assayFrontier);
  const mode = options.mode ?? "strict";
  if (mode !== "strict" && mode !== "precompile") {
    throw new TypeError("Persisted assay evidence replay mode must be strict or precompile");
  }
  const chain = verifyEventChain(events);
  const sandboxEvents = events.filter(
    (event): event is CaseEvent<"evidence.observed"> =>
      event.kind === "evidence.observed" && event.payload.evidenceType === "sandbox_execution",
  );
  const scopedBlockedEvents = events.filter(
    (event): event is CaseEvent<"evidence.observed"> =>
      event.kind === "evidence.observed"
      && event.payload.evidenceType === "tool_observation"
      && event.stage === "assay"
      && event.payload.candidateId !== undefined
      && event.payload.assayId !== undefined,
  );
  const replayEvents = [...sandboxEvents, ...scopedBlockedEvents]
    .sort((left, right) => left.sequence - right.sequence);

  const globalProblems: PersistedAssayEvidenceProblem[] = chain.problems.map((entry) => Object.freeze({
    code: "INVALID_EVENT_CHAIN" as const,
    sequence: entry.sequence,
    message: `${entry.code}: ${entry.message}`,
  }));
  if(isRecord(policyDescriptor)&&policyDescriptor.version===ORIGINAL_SUBJECT_POLICY_VERSION
    &&originalSubjectKernelDigestFromPolicyDescriptor(policyDescriptor)!==ORIGINAL_SUBJECT_ASSERTION_KERNEL_DIGEST){
    globalProblems.push(Object.freeze({code:"UNSUPPORTED_ORIGINAL_SUBJECT_KERNEL",sequence:0,message:"This Bone v2 policy does not bind the exact supported original-subject kernel. Replay cannot substitute current policy behavior, even when no original certificate is present."}));
  }
  if (!policyBindsExactFrontier(policyDescriptor, frontier)) {
    globalProblems.push(Object.freeze({
      code: "FRONTIER_BINDING_MISMATCH",
      sequence: 0,
      message: "The exact Case policy descriptor does not embed and digest-bind the supplied Assay Frontier.",
    }));
  }
  const candidatePolicyBinding = candidateIgnorePolicyBinding(policyDescriptor);
  if (!candidatePolicyBinding.verified) {
    globalProblems.push(Object.freeze({
      code: "CANDIDATE_IGNORE_POLICY_MISMATCH",
      sequence: 0,
      message: candidatePolicyBinding.reason,
    }));
  }

  let evidence: readonly ReplayedAssayEvidence[] = Object.freeze([]);
  let eventProblems: readonly PersistedAssayEvidenceProblem[] = Object.freeze([]);
  let frontierState = emptyFrontierState(frontier);
  let candidateAuthorityEdges: readonly VerifiedEvidenceEdge[] = Object.freeze([]);
  let originalSubject: OriginalSubjectCertificateReplay | undefined;
  if (chain.valid) {
    const cache = new Map<string, Promise<Uint8Array | undefined>>();
    const cachedResolver: AssayEvidenceArtifactResolver = async (digest) => {
      let pending = cache.get(digest);
      if (pending === undefined) {
        pending = Promise.resolve().then(async () => await resolveArtifact(digest));
        cache.set(digest, pending);
      }
      return await pending;
    };
    const plansById = new Map(frontier.assays.map((plan) => [plan.assayId, plan]));
    originalSubject = await replayOriginalSubjectCertificates(events,policyDescriptor,cachedResolver,options.originalSubject);
    globalProblems.push(...originalSubject.problems.map(entry=>Object.freeze({code:"ORIGINAL_SUBJECT_CERTIFICATE_INVALID" as const,...entry})));
    const conflicts = conflictingCells(replayEvents);
    const context: ReplayContext = {
      contract: intentContract,
      frontier,
      policyDescriptor,
      plansById,
      experimentCapability: compileExperimentCapability(frontier, intentContract),
      conflictingCells: conflicts,
      resolve: cachedResolver,
    };
    const results = await Promise.all(replayEvents.map(async (event) =>
      event.payload.evidenceType === "sandbox_execution"
        ? await replayEvent(event, context)
        : await replayBlockedCellEvent(event, context)));
    evidence = Object.freeze(results.map((entry) => entry.entry));
    const byEventDigest = new Map(replayEvents.map((event, index) => [event.eventDigest, results[index] as EventReplayResult]));
    const reconstruction = await reconstructFrontierState(
      events,
      intentContract,
      frontier,
      policyDescriptor,
      mode,
      byEventDigest,
      cachedResolver,
      candidatePolicyBinding.verified ? candidatePolicyBinding.policy : undefined,
      options.trustedRecordKeys,
      originalSubject,
    );
    frontierState = reconstruction.state;
    candidateAuthorityEdges = reconstruction.authorityEdges;
    eventProblems = Object.freeze([
      ...results.flatMap((entry) => entry.problems),
      ...reconstruction.problems,
    ]);
  }

  const problems = Object.freeze([...globalProblems, ...eventProblems]);
  const digestStatuses = new Map<string, ("VERIFIED" | "REJECTED")[]>();
  for (const entry of evidence) {
    const statuses = digestStatuses.get(entry.contentDigest) ?? [];
    statuses.push(entry.status);
    digestStatuses.set(entry.contentDigest, statuses);
  }
  const verifiedArtifactDigests = sortedUnique([...([...digestStatuses]
    .filter(([, statuses]) => statuses.every((status) => status === "VERIFIED"))
    .map(([digest]) => digest)), ...(problems.length === 0 ? originalSubject?.artifactDigests ?? [] : [])]);
  const verifiedAuthorityEdges = problems.length === 0
    ? Object.freeze([...candidateAuthorityEdges])
    : Object.freeze([]);
  const unsigned = Object.freeze({
    protocol: PERSISTED_ASSAY_EVIDENCE_REPLAY_PROTOCOL,
    mode,
    intentContractDigest: intentContract.digest,
    assayFrontierDigest: frontier.digest,
    eventHeadDigest: chain.headDigest,
    sandboxExecutionCount: sandboxEvents.length,
    replayComplete: problems.length === 0,
    verifiedArtifactDigests,
    verifiedAuthorityEdges,
    verifiedOriginalSubjectEdges: problems.length === 0 ? originalSubject?.verifiedOriginalSubjectEdges ?? Object.freeze([]) : Object.freeze([]),
    ...(problems.length === 0 && originalSubject?.originalSubjectContext ? {originalSubjectContext:originalSubject.originalSubjectContext} : {}),
    evidence,
    frontierState,
    problems,
  });
  return Object.freeze({
    ...unsigned,
    digest: digestJson(unsigned as unknown as JsonValue),
  });
}
