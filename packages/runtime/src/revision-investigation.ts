import { canonicalize, digestJson, type JsonValue, type MetabolicResourceVector } from "@jevyr/protocol";
import type { ScentObservation } from "./inertia-scent.js";
import type { MindAdapter, MindInvocationResult, MindRequest, PublicContribution, ToolObservation } from "./contracts.js";
import { finiteBlueprintProblem } from "./adapters/prompt.js";
import { invokeMindMetered } from "./mind-metering.js";
import { investigationSeed } from "./phenotype.js";
import type { ForgeOracleEvaluation } from "./typed-oracles.js";
import { BASELINE_REVISION_POLICY, type BaselineRevisionVersion } from "./baseline-revision.js";
import { decodeExactByteCapture, encodeToolObservation } from "./evidence-artifacts.js";

export const LEGACY_REVISION_INVESTIGATION_POLICY = Object.freeze({ protocol: "jevyr.execution-revision-policy/1", maximumBaselineRounds: 2, maximumCandidatesPerInvocation: 1,
  population: "append-only-prior-wave-commitment", evaluators: "original-sealed-frontier-only", resources: "original-envelope-plus-authenticated-additions",
  verdictAuthority: "none", finalClosure: "one-union-assay-before-deterministic-reflex" } as const);
export const REVISION_OUTPUT_POLICY = Object.freeze({ source: "exact-byte-capture", maxBytesPerStream: 2_000, maxCells: 16 } as const);
export const REVISION_INVESTIGATION_POLICY = Object.freeze({ ...LEGACY_REVISION_INVESTIGATION_POLICY, protocol: "jevyr.execution-revision-policy/2",
  baselineEligibility: BASELINE_REVISION_POLICY, outputContext: REVISION_OUTPUT_POLICY } as const);
export const REVISION_FEEDBACK_MEDIA_TYPE = "application/vnd.jevyr.execution-feedback+json";
export const REVISION_POPULATION_MEDIA_TYPE = "application/vnd.jevyr.revision-population+json";

export function revisionInvestigationVersion(descriptor: unknown): BaselineRevisionVersion | undefined {
  const policy = (descriptor as { policy?: { executionRevisions?: unknown } } | undefined)?.policy;
  if (policy?.executionRevisions === undefined) return undefined;
  const value = canonicalize(policy.executionRevisions as JsonValue);
  if (value === canonicalize(REVISION_INVESTIGATION_POLICY)) return "observed-comparative-repair";
  if (value === canonicalize(LEGACY_REVISION_INVESTIGATION_POLICY)) return "legacy-critical-only";
  return undefined;
}
export function revisionInvestigationEnabled(descriptor: unknown): boolean {
  return revisionInvestigationVersion(descriptor) !== undefined;
}
export interface FeedbackInput {
  readonly candidateId: string;
  readonly assayId: string;
  readonly observationDigest: string;
  readonly observation: ToolObservation;
  readonly evaluation?: ForgeOracleEvaluation;
  readonly admissible: boolean;
  readonly costUnits: number;
}
export interface ExecutionFeedbackCell {
  readonly candidateId: string;
  readonly assayId: string;
  readonly obligationId: string | null;
  readonly executed: boolean;
  readonly exitCode: number | null;
  readonly status: "PASSED" | "FAILED" | "BLOCKED";
  readonly decisive: boolean;
  readonly costUnits: number;
}
export interface ExecutionFeedback {
  readonly protocol: "jevyr.execution-feedback/1";
  readonly cells: readonly ExecutionFeedbackCell[];
  readonly observationBindings: readonly { readonly candidateId: string; readonly assayId: string; readonly observationDigest: string }[];
  readonly contextDigest: string;
  readonly digest: string;
}
export interface RevisionInvocationContext {
  readonly round: number;
  readonly feedback: ExecutionFeedback;
  readonly inputs: readonly FeedbackInput[];
  readonly parentCandidateIds: readonly string[];
  readonly feedbackArtifactDigest: string;
  readonly receiptDigest?: string;
  readonly inertiaDecisionDigest?: string;
  readonly resourceCeiling?: MetabolicResourceVector;
  readonly receiptSequence?: number;
}

/** Shared production/calibration constructor. It grants only read access to
 * already committed parent bytes permitted by the provider disclosure scope. */
export function buildExecutionRevisionRequest(base: MindRequest, revision: RevisionInvocationContext,
  parentSources: NonNullable<MindRequest["revisionSources"]>, network: string): MindRequest {
  if (!Number.isSafeInteger(revision.round) || revision.round < 1 || revision.round > 2 || revision.parentCandidateIds.length !== 1
    || !revision.feedback.cells.some(cell => cell.candidateId === revision.parentCandidateIds[0] && cell.decisive && cell.status === "FAILED")) throw new TypeError("A revision requires one failed committed parent within the two-round policy");
  const disclose = !(base.sealed.intent.privacy === "provider_scoped" && ["provider", "unrestricted"].includes(network));
  const { preparedPublicPrompt: _prompt, revisionSources: _sources, ...request } = base;
  return Object.freeze({ ...request, stage: "reflex", role: "reflex", revision: { round: revision.round, contextDigest: revision.feedback.contextDigest, parentCandidateIds: revision.parentCandidateIds },
    ...(disclose ? { revisionSources: parentSources.filter(parent => revision.parentCandidateIds.includes(parent.candidateId)) } : {}),
    seed: base.sealed.searchEnvelope.profile.seedDerivation === "sha256-case-seed-frontier-v2" ? investigationSeed(base.sealed, "execution-revision", [revision.round, ...revision.parentCandidateIds, revision.receiptSequence ?? 0, base.seed]) : base.seed,
    publicFacts: [...base.publicFacts.filter(fact => !fact.tags?.includes("executed-assay-context")), ...executionFeedbackFacts(revision.feedback, revision.inputs, disclose)] });
}

/** Calibration and the live feedback loop share actual invocation, source
 * socket validation and exact single-parent admission. Rejected output still
 * returns its complete physical usage for the caller's monotonic meter. */
export async function invokeExecutionRevision(mind: MindAdapter, request: MindRequest): Promise<{ readonly result: MindInvocationResult; readonly admissionProblem?: string }> {
  if (!request.revision || request.stage !== "reflex") throw new TypeError("Execution revision invocation lacks its bounded context");
  const result = await invokeMindMetered(mind, request);
  let problem: string | undefined;
  if (result.contributions.length > 1 || result.contributions.some(value => !["candidate", "reflex"].includes(value.kind))) problem = "A feedback invocation may return at most one finite candidate or one Reflex assessment";
  const candidate = result.contributions.find(value => value.kind === "candidate");
  if (candidate) {
    if (candidate.parentIds?.length !== 1 || !request.revision.parentCandidateIds.includes(candidate.parentIds[0]!) || request.revision.parentCandidateIds.includes(candidate.id)) problem = "The revision did not name exactly its one committed parent";
    problem ??= finiteBlueprintProblem(candidate.candidateBlueprintSource, request.experimentCapability);
    const source = candidate.candidateBlueprintSource as { files?: readonly { path: string; content: string }[] } | undefined;
    const parent = request.revisionSources?.find(value => value.candidateId === candidate.parentIds?.[0]);
    if (parent && source?.files && canonicalize(source.files.map(file => [file.path, file.content]).sort()) === canonicalize(parent.files.map(file => [file.path, file.content]).sort())) problem = "The revision repeated unchanged committed source";
  }
  return Object.freeze({ result: problem ? Object.freeze({ ...result, contributions: Object.freeze([]) }) : result, ...(problem ? { admissionProblem: problem } : {}) });
}

export function feedbackScentHistory(inputs: readonly FeedbackInput[]): readonly ScentObservation[] {
  return inputs.map(input => ({ candidateId: input.candidateId, assayId: input.assayId, observationDigest: input.observationDigest,
    ...(input.evaluation?.obligationId ? { obligationId: input.evaluation.obligationId } : {}),
    status: input.admissible && input.evaluation?.decisive ? input.evaluation.status : "BLOCKED", decisive: input.admissible && input.evaluation?.decisive === true, costUnits: input.costUnits }));
}

export function executionFeedback(inputs: readonly FeedbackInput[]): ExecutionFeedback {
  const cells = inputs.map(input => ({ candidateId: input.candidateId, assayId: input.assayId, obligationId: input.evaluation?.obligationId ?? null,
    executed: input.observation.oracle?.execution.state === "exited", exitCode: input.observation.oracle?.execution.exitCode ?? null,
    status: input.admissible && input.evaluation?.decisive ? input.evaluation.status : "BLOCKED" as const,
    decisive: input.admissible && input.evaluation?.decisive === true, costUnits: input.costUnits }));
  const body = { protocol: "jevyr.execution-feedback/1" as const, cells,
    observationBindings: inputs.map(input => ({ candidateId: input.candidateId, assayId: input.assayId, observationDigest: input.observationDigest })), contextDigest: digestJson(cells) };
  return Object.freeze({ ...body, digest: digestJson(body) });
}

type StreamContext = { readonly text: string; readonly metadata: JsonValue };
function absentStream(status: "ABSENT" | "INVALID_CAPTURE" | "UNBOUND_OBSERVATION"): StreamContext {
  return { text: "", metadata: { status } };
}

/** Only validated, retained UTF-8 bytes can become text. Partial captures remain
 * explicitly incomplete; this context never supplies an expected oracle value. */
function capturedStream(value: unknown, outputTruncated: boolean): StreamContext {
  if (value === undefined) return absentStream("ABSENT");
  try {
    const decoded = decodeExactByteCapture(value);
    const capture = value as { digest: string; byteLength: number; observedByteLength: number; complete: boolean };
    const binding = { digest: capture.digest, retainedBytes: capture.byteLength, observedBytes: capture.observedByteLength, complete: capture.complete };
    if (decoded.text === undefined) return { text: "", metadata: { ...binding, status: "INVALID_UTF8", displayBytes: 0, truncated: capture.byteLength > 0 || !capture.complete || outputTruncated } };
    let length = Math.min(decoded.bytes.byteLength, REVISION_OUTPUT_POLICY.maxBytesPerStream);
    // Do not manufacture U+FFFD by splitting a valid multibyte code point.
    while (length > 0 && length < decoded.bytes.byteLength && (decoded.bytes[length]! & 0xc0) === 0x80) length--;
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(decoded.bytes.subarray(0, length));
    return { text, metadata: { ...binding, status: "CAPTURED", displayBytes: length, truncated: length < capture.byteLength || !capture.complete || outputTruncated } };
  } catch { return absentStream("INVALID_CAPTURE"); }
}

function observationOutput(feedback: ExecutionFeedback, inputs: readonly FeedbackInput[], index: number): { readonly [key: string]: JsonValue } {
  const cell = feedback.cells[index]!, binding = feedback.observationBindings[index];
  let stdout = absentStream("UNBOUND_OBSERVATION"), stderr = absentStream("UNBOUND_OBSERVATION");
  if (binding?.candidateId === cell.candidateId && binding.assayId === cell.assayId) {
    // Match the physical binding, not the oldest attempt at the same cell.
    const input = inputs.find(value => value.candidateId === binding.candidateId && value.assayId === binding.assayId && value.observationDigest === binding.observationDigest);
    if (input) {
      try {
        const encoded = encodeToolObservation(input.observation);
        if (encoded.digest === binding.observationDigest && canonicalize(executionFeedback([input]).cells[0] as unknown as JsonValue) === canonicalize(cell as unknown as JsonValue)) {
          const execution = input.observation.oracle?.execution;
          stdout = capturedStream(execution?.stdoutCapture, execution?.outputTruncated === true);
          stderr = capturedStream(execution?.stderrCapture, execution?.outputTruncated === true);
        }
      } catch { stdout = absentStream("INVALID_CAPTURE"); stderr = absentStream("INVALID_CAPTURE"); }
    }
  }
  return { stdout: stdout.text, stderr: stderr.text, outputCapture: { stdout: stdout.metadata, stderr: stderr.metadata } };
}

/** Public aliases depend on bounded outcome content, not incidental run times;
 * exact physical observation bindings remain in the feedback artifact. */
export function executionFeedbackFacts(feedback: ExecutionFeedback, inputs: readonly FeedbackInput[], discloseOutput: boolean): readonly PublicContribution[] {
  const start = Math.max(0, feedback.cells.length - REVISION_OUTPUT_POLICY.maxCells);
  return feedback.cells.slice(start).map((cell, offset) => {
    // Do not inspect inputs, decode captures, or expose their digests in a
    // disclosure scope that withholds process output.
    const output = discloseOutput ? observationOutput(feedback, inputs, start + offset) : { output: "WITHHELD_BY_PRIVACY_SCOPE" };
    return Object.freeze({ id: `feedback_${digestJson({ cell, output } as unknown as JsonValue).slice(-24)}`, kind: "observation" as const,
      summary: `Executed-assay context: candidate ${cell.candidateId}, sealed assay ${cell.assayId}, result ${cell.status}, exit ${cell.exitCode ?? "unavailable"}.`,
      body: canonicalize({ ...cell, ...output, authority: "context-only; consult bound Forge evidence" }), tags: ["executed-assay-context", "not-model-evidence"] });
  });
}
