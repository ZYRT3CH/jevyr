import { decodeDsseJson, parseJsonBytes, RECORD_DSSE_PAYLOAD_TYPE, SEAL_DSSE_PAYLOAD_TYPE, sealReceipt, verifyDsse, verifyEventChain } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, sha256Digest, validateSealedCase, validateSignedRecord, type CaseEvent, type DsseEnvelope, type JsonValue } from "@jevyr/protocol";
import { decodeExactByteCapture, decodeToolObservation } from "./evidence-artifacts.js";
import { verifyForgeExecutionAuthority } from "./forge-authority.js";
import { checkRepositorySuiteReportConsistency, planRepositoryEvaluation, REPOSITORY_EVALUATION_DISCOVERY, type RepositoryEvaluationLimits, type RepositoryEvaluationPlan, type RepositoryEvaluatorRunner } from "./repository-evaluation-plan.js";
import { createRepositoryTestControllerRequest, summarizeRepositoryTestEvents, type RepositoryTestControllerLimits, type RepositoryTestControllerRequest } from "./repository-test-controller.js";
import { deriveRepositoryEvaluationClosure, REPOSITORY_EVALUATION_CLOSURE_ROOT } from "./repository-evaluation-closure.js";
import { deriveRepositoryEvaluationPackage, REPOSITORY_OBSERVER_ARGV, REPOSITORY_OBSERVER_CONTROLLER_PATH, REPOSITORY_OBSERVER_REQUEST_PATH, REPOSITORY_OBSERVER_ARTIFACT_MEDIA } from "./repository-evaluation-observer.js";
import type { SubjectContextReader } from "./subject-context.js";
import type { SubjectMaterialBinding } from "./subject-materials.js";

export const REPOSITORY_EVALUATION_EVIDENCE_PROTOCOL = "jevyr.repository-evaluation-evidence-replay/1" as const;
/** Future startup policy slot. This only permits the recorded context experiment;
 * a specialized adjudicative boundary has deliberately not been implemented. */
export interface RepositoryEvaluatorFactory {
  readonly protocol: "jevyr.repository-evaluator-factory/1";
  readonly discovery: typeof REPOSITORY_EVALUATION_DISCOVERY;
  readonly plannerImplementationDigest: string;
  readonly controllerSourceDigest: string;
  readonly controllerPath: typeof REPOSITORY_OBSERVER_CONTROLLER_PATH;
  readonly requestPath: typeof REPOSITORY_OBSERVER_REQUEST_PATH;
  readonly argv: readonly string[];
  readonly maxSubjectsPerCase: number;
  readonly timeoutMs: number;
  readonly runner: RepositoryEvaluatorRunner;
  readonly limits: RepositoryEvaluationLimits;
  readonly controllerLimits: RepositoryTestControllerLimits;
  readonly authority: "context-only";
}
export interface RepositoryEvaluationEvidenceInput {
  /** Trust is provided by the verifier host; never derive these keys from proof data. */
  readonly trusted: Readonly<{ caseKeys: ReadonlyMap<string, string>; plannerImplementationDigest: string; controllerSourceDigest: string }>;
  readonly sealedCase: unknown;
  readonly sealEnvelope: unknown;
  readonly recordEnvelope?: unknown;
  readonly events?: readonly CaseEvent[];
  readonly policyDescriptor: unknown;
  readonly subjectId: string;
  readonly capture?: Readonly<{ bindings: readonly SubjectMaterialBinding[]; reader: SubjectContextReader }>;
  readonly planBytes?: Uint8Array;
  readonly closureBytes?: Uint8Array;
  readonly packageBytes?: Uint8Array;
  readonly observerReceiptBytes?: Uint8Array;
  readonly requestBytes?: Uint8Array;
  readonly controllerSourceBytes?: Uint8Array;
  readonly controllerObservationBytes?: Uint8Array;
  readonly outerForgeObservationBytes?: Uint8Array;
}
export interface RepositoryEvaluationEvidenceReplay {
  readonly protocol: typeof REPOSITORY_EVALUATION_EVIDENCE_PROTOCOL;
  /** Always false until a separately enforced evaluator boundary is implemented.
   * Neither signatures nor consistent child messages establish that boundary. */
  readonly verified: false;
  readonly authenticatedCase: boolean;
  readonly authenticatedTranscript: boolean;
  readonly derivationVerified: boolean;
  readonly controllerConsistent: boolean;
  /** Authenticated recorded image/argv/capture bindings, not an attestation that
   * spoofable child messages have become independent truth measurements. */
  readonly forgeProvenanceVerified: boolean;
  readonly reportOutcome: "pass" | "fail" | "unproven";
  readonly verdictAuthority: "none";
  readonly planDigest?: string;
  readonly suiteDigest?: string;
  readonly outerObservationDigest?: string;
  readonly problems: readonly string[];
}
const json = (value: unknown) => value as JsonValue;
const hash = (value: unknown) => digestJson(json(value));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
const same = (left: unknown, right: unknown) => canonicalize(json(left)) === canonicalize(json(right));
function canonicalBytes(bytes: Uint8Array | undefined, allowLf = false): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 2_000_000) throw new Error("BOUNDED_ARTIFACT_MISSING");
  const value = parseJsonBytes(bytes, "repository evaluator evidence");
  const encoded = Buffer.from(canonicalize(json(value))), raw = Buffer.from(bytes);
  if (!raw.equals(encoded) && !(allowLf && raw.equals(Buffer.concat([encoded, Buffer.from("\n")])))) throw new Error("NONCANONICAL_ARTIFACT");
  return value;
}
function signedPayload(envelope: unknown, payloadType: string, keys: ReadonlyMap<string, string>): unknown {
  if (!object(envelope) || envelope.payloadType !== payloadType || typeof envelope.payload !== "string" || envelope.payload.length > 4_000_000
    || !verifyDsse(envelope as unknown as DsseEnvelope, keys)) throw new Error("UNTRUSTED_SIGNATURE");
  const payload = decodeDsseJson(envelope as unknown as DsseEnvelope);
  if (Buffer.from(String(envelope.payload), "base64").toString("utf8") !== canonicalize(json(payload))) throw new Error("NONCANONICAL_SIGNED_PAYLOAD");
  return payload;
}
function factoryFromPolicy(policy: unknown, expectedPolicyDigest: string, trusted: RepositoryEvaluationEvidenceInput["trusted"]): RepositoryEvaluatorFactory {
  if (!object(policy) || policy.protocol !== "jevyr.policy-descriptor/1" || !object(policy.policy) || hash(policy) !== expectedPolicyDigest) throw new Error("POLICY_IDENTITY_MISMATCH");
  const factory = policy.policy.repositoryEvaluationObserver;
  if (!exact(factory, ["protocol", "discovery", "plannerImplementationDigest", "controllerSourceDigest", "controllerPath", "requestPath", "argv", "maxSubjectsPerCase", "timeoutMs", "runner", "limits", "controllerLimits", "authority"])
    || factory.protocol !== "jevyr.repository-evaluator-factory/1" || factory.discovery !== REPOSITORY_EVALUATION_DISCOVERY
    || factory.authority !== "context-only" || factory.controllerPath !== REPOSITORY_OBSERVER_CONTROLLER_PATH || factory.requestPath !== REPOSITORY_OBSERVER_REQUEST_PATH
    || !same(factory.argv, REPOSITORY_OBSERVER_ARGV) || factory.maxSubjectsPerCase !== 2 || factory.timeoutMs !== 30_000
    || !isSha256Digest(factory.plannerImplementationDigest) || factory.plannerImplementationDigest !== trusted.plannerImplementationDigest
    || !isSha256Digest(factory.controllerSourceDigest) || factory.controllerSourceDigest !== trusted.controllerSourceDigest
    || !object(factory.runner) || factory.runner.evaluatorDigest !== factory.controllerSourceDigest) throw new Error("FACTORY_IMPLEMENTATION_UNSUPPORTED");
  return factory as unknown as RepositoryEvaluatorFactory;
}

/** Independently verifies recorded provenance and consistency, without executing
 * source, trusting supplied counts, or issuing a verdict edge. In particular,
 * an authentic Bone signature cannot turn spoofable child IPC into a trusted
 * evaluator. Production must supply a real specialized boundary before this
 * protocol can ever be extended to return verified:true. */
export async function verifyRepositoryEvaluationEvidence(input: RepositoryEvaluationEvidenceInput): Promise<RepositoryEvaluationEvidenceReplay> {
  const problems = new Set<string>();
  let authenticatedCase = false, authenticatedTranscript = false, derivationVerified = false, controllerConsistent = false, forgeProvenanceVerified = false;
  let reportOutcome: RepositoryEvaluationEvidenceReplay["reportOutcome"] = "unproven";
  let planDigest: string | undefined, suiteDigest: string | undefined, outerObservationDigest: string | undefined;
  try {
    if (!input.trusted?.caseKeys || input.trusted.caseKeys.size === 0) throw new Error("TRUSTED_CASE_KEYS_MISSING");
    const checkedCase = validateSealedCase(input.sealedCase);
    if (!checkedCase.ok || !checkedCase.value) throw new Error("SEALED_CASE_INVALID");
    const sealed = checkedCase.value;
    if (!same(signedPayload(input.sealEnvelope, SEAL_DSSE_PAYLOAD_TYPE, input.trusted.caseKeys), sealReceipt(sealed))) throw new Error("SEAL_IDENTITY_MISMATCH");
    authenticatedCase = true;
    const factory = factoryFromPolicy(input.policyDescriptor, sealed.policyDigest, input.trusted);
    if (!input.capture) throw new Error("SOURCE_SIDECARS_MISSING");
    if (hash({ protocol: "jevyr.subject-material-capture/1", bindings: input.capture.bindings }) !== sealed.subjectMaterialCaptureDigest) throw new Error("CAPTURE_IDENTITY_MISMATCH");
    if (input.capture.bindings.some(binding => !sealed.subjects.some(subject => subject.subjectId === binding.subjectId && subject.digest === binding.subjectDigest))) throw new Error("CAPTURE_SUBJECT_MISMATCH");
    const expectedPlan = await planRepositoryEvaluation({ captureDigest: sealed.subjectMaterialCaptureDigest, bindings: input.capture.bindings, reader: input.capture.reader, contract: sealed.intentContract, runner: factory.runner, limits: factory.limits });
    const storedPlan = canonicalBytes(input.planBytes) as RepositoryEvaluationPlan;
    if (!same(storedPlan, expectedPlan)) throw new Error("PLAN_DERIVATION_MISMATCH");
    const subject = expectedPlan.subjects.find(subject => subject.subjectId === input.subjectId);
    const eligible = expectedPlan.subjects.filter(item => item.status === "ready" && item.refusals.length === 0).sort((a, b) => a.subjectId < b.subjectId ? -1 : 1).slice(0, factory.maxSubjectsPerCase);
    if (!subject || !eligible.some(item => item.subjectId === subject.subjectId)) throw new Error("SUBJECT_PLAN_UNAVAILABLE");
    planDigest = expectedPlan.digest; suiteDigest = subject.suiteDigest;
    const closure = await deriveRepositoryEvaluationClosure({ captureDigest: sealed.subjectMaterialCaptureDigest, bindings: input.capture.bindings, reader: input.capture.reader, subject });
    if (!same(canonicalBytes(input.closureBytes), closure)) throw new Error("CLOSURE_DERIVATION_MISMATCH");
    const root = REPOSITORY_EVALUATION_CLOSURE_ROOT;
    const expectedRequest = createRepositoryTestControllerRequest(subject, root, factory.controllerLimits), storedRequest = canonicalBytes(input.requestBytes);
    if (!same(storedRequest, expectedRequest)) throw new Error("CONTROLLER_REQUEST_MISMATCH");
    if (!(input.controllerSourceBytes instanceof Uint8Array) || sha256Digest(input.controllerSourceBytes) !== factory.controllerSourceDigest) throw new Error("CONTROLLER_IMPLEMENTATION_MISMATCH");
    const packaged = deriveRepositoryEvaluationPackage(closure, expectedRequest, input.controllerSourceBytes);
    if (!same(canonicalBytes(input.packageBytes), packaged)) throw new Error("PACKAGE_DERIVATION_MISMATCH");
    derivationVerified = true;

    const controller = canonicalBytes(input.controllerObservationBytes, true);
    if (!exact(controller, ["protocol", "target", "authority", "requestDigest", "nodeVersion", "controllerPid", "runner", "inventory", "stream", "events", "eventDigest", "report", "problems", "trustScope", "digest"])
      || controller.protocol !== "jevyr.repository-suite-controller-observation/1" || controller.target !== "sealed-original-subject" || controller.authority !== "none"
      || controller.requestDigest !== hash(expectedRequest) || controller.runner !== "node:test.run/process"
      || typeof controller.nodeVersion !== "string" || !/^v24\.[0-9]+\.[0-9]+$/u.test(controller.nodeVersion)
      || !Number.isSafeInteger(controller.controllerPid) || Number(controller.controllerPid) < 1 || typeof controller.trustScope !== "string"
      || !Array.isArray(controller.events) || controller.eventDigest !== hash(controller.events)) throw new Error("CONTROLLER_OBSERVATION_IDENTITY_MISMATCH");
    const { digest: _digest, ...controllerBody } = controller;
    if (controller.digest !== hash(controllerBody)) throw new Error("CONTROLLER_OBSERVATION_DIGEST_MISMATCH");
    if (!exact(controller.stream, ["ended", "observedEvents", "retainedEvents", "observedEventBytes", "complete", "timedOut", "controllerError"])
      || !exact(controller.inventory, ["before", "after"])) throw new Error("CONTROLLER_CAPTURE_SHAPE");
    const rederived = await summarizeRepositoryTestEvents(controller.events, expectedRequest, controller.stream, controller.inventory);
    if (!same(controller.report, rederived.report) || !same(controller.problems, rederived.problems)) throw new Error("CONTROLLER_EVENT_REPLAY_MISMATCH");
    const consistency = checkRepositorySuiteReportConsistency(rederived.report, subject.suiteDigest);
    controllerConsistent = consistency.consistent && rederived.problems.length === 0;
    reportOutcome = controllerConsistent ? consistency.outcome : "unproven";
    if (!controllerConsistent) problems.add("CONTROLLER_EVENTS_INCOMPLETE");

    if (!(input.outerForgeObservationBytes instanceof Uint8Array)) throw new Error("OUTER_FORGE_OBSERVATION_MISSING");
    const outer = decodeToolObservation(input.outerForgeObservationBytes); outerObservationDigest = sha256Digest(input.outerForgeObservationBytes);
    const authority = outer.oracle ? verifyForgeExecutionAuthority(input.policyDescriptor, outer.oracle) : undefined;
    if (authority?.verified !== true || authority.authority?.immutableImageId !== factory.runner.immutableImageId) throw new Error("OUTER_FORGE_AUTHORITY_MISSING");
    const execution = outer.oracle!.execution, stdout = decodeExactByteCapture(execution.stdoutCapture), stderr = decodeExactByteCapture(execution.stderrCapture);
    if (execution.state !== "exited" || execution.exitCode !== 0 || execution.mode !== "docker" || execution.shell !== false || execution.command !== "node"
      || !same(execution.args, factory.argv) || execution.outputTruncated !== false || execution.stdoutCapture?.complete !== true || execution.stderrCapture?.complete !== true
      || !Buffer.from(stdout.bytes).equals(Buffer.from(input.controllerObservationBytes!)) || stderr.bytes.length !== 0) throw new Error("OUTER_FORGE_PROCESS_MISMATCH");
    const boundary = outer.oracle!.subjectBoundary;
    if (!same(boundary, { schema: "jevyr.sanitized-subject-boundary/2", sanitized: true, disposableWorkspace: true, sealedSubjectReadOnly: true,
      originalSubjectAccessible: false, complete: true, captureDigest: packaged.digest, materializationDigest: packaged.digest,
      beforeDigest: packaged.forgeTreeDigest, afterDigest: packaged.forgeTreeDigest })) throw new Error("SELECTED_CLOSURE_BOUNDARY_MISSING");
    const receipt = canonicalBytes(input.observerReceiptBytes);
    if (!exact(receipt, ["protocol", "caseId", "runDigest", "policyDigest", "invocationId", "subjectId", "planDigest", "closureDigest", "packageDigest", "controllerSourceDigest", "requestDigest", "outerObservationDigest", "controllerObservationDigest", "target", "scope", "workspaceRole", "authority", "reportOutcome", "controllerConsistent", "counts", "problems", "resourceLimits", "resources", "artifacts"])) throw new Error("INVOCATION_BINDING_MISMATCH");
    const expectedBinding = { protocol: "jevyr.repository-evaluation-observer-receipt/1", caseId: sealed.caseId, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest,
      invocationId: outer.invocationId, subjectId: input.subjectId, planDigest, closureDigest: closure.materializationDigest, packageDigest: packaged.digest,
      controllerSourceDigest: factory.controllerSourceDigest, requestDigest: hash(expectedRequest), outerObservationDigest,
      controllerObservationDigest: sha256Digest(input.controllerObservationBytes!), target: "sealed-original-subject", scope: closure.scope, workspaceRole: "empty-diagnostic-tooling", authority: "none", reportOutcome, controllerConsistent };
    for (const [key, expected] of Object.entries(expectedBinding)) if (!same(receipt[key], expected)) throw new Error("INVOCATION_BINDING_MISMATCH");
    const { executedTests, passed, failed, errors, skipped, cancelled } = rederived.report;
    if (!same(receipt.counts, { executedTests, passed, failed, errors, skipped, cancelled })
      || !same(receipt.problems, [...new Set([...rederived.problems, "DIAGNOSTIC_ONLY_NO_VERDICT_AUTHORITY"])].sort())) throw new Error("DIAGNOSTIC_SUMMARY_MISMATCH");
    // Resource admission is separately checked by repository-observer-replay.
    // This component authenticates its exact artifact, never infers costs from counts.
    if (!object(receipt.resourceLimits) || !object(receipt.resources)) throw new Error("INVOCATION_BINDING_MISMATCH");
    const sidecars = (Object.keys(REPOSITORY_OBSERVER_ARTIFACT_MEDIA) as (keyof typeof REPOSITORY_OBSERVER_ARTIFACT_MEDIA)[]).filter(key => key !== "observerReceiptBytes")
      .map(name => { const value = input[name]!; return { name, digest: sha256Digest(value), byteLength: value.byteLength, mediaType: REPOSITORY_OBSERVER_ARTIFACT_MEDIA[name] }; }).sort((a, b) => a.name < b.name ? -1 : 1);
    if (!same(receipt.artifacts, sidecars)) throw new Error("INVOCATION_ARTIFACT_MEMBERSHIP_MISMATCH");

    if (!input.recordEnvelope || !input.events) throw new Error("AUTHENTICATED_TRANSCRIPT_MISSING");
    if (!Array.isArray(input.events) || input.events.length > 100_000) throw new Error("AUTHENTICATED_TRANSCRIPT_OVERSIZED");
    const record = validateSignedRecord(signedPayload(input.recordEnvelope, RECORD_DSSE_PAYLOAD_TYPE, input.trusted.caseKeys));
    if (!record.ok || !record.value) throw new Error("SIGNED_RECORD_INVALID");
    for (const key of ["caseDigest", "runDigest", "policyDigest", "genomeDigest", "intentContractDigest"] as const) if (record.value[key] !== sealed[key]) throw new Error("SIGNED_RECORD_SCOPE_MISMATCH");
    if (record.value.searchDigest !== sealed.searchEnvelope.digest) throw new Error("SIGNED_RECORD_SCOPE_MISMATCH");
    const anchor = input.events.findIndex(event => event.eventDigest === record.value!.eventHeadDigest);
    const prefix = anchor < 0 ? [] : input.events.slice(0, anchor + 1);
    if (!prefix.length || !verifyEventChain(prefix).valid || prefix.some(event => event.caseDigest !== sealed.caseDigest || event.runDigest !== sealed.runDigest)) throw new Error("AUTHENTICATED_CHAIN_INVALID");
    if (prefix.some(event => event.kind === "evidence.observed" && event.payload.contentDigest === outerObservationDigest)) throw new Error("DIAGNOSTIC_DECISION_EDGE_FORBIDDEN");
    const requiredArtifacts = [sha256Digest(input.planBytes!), sha256Digest(input.closureBytes!), sha256Digest(input.packageBytes!), sha256Digest(input.requestBytes!), sha256Digest(input.controllerObservationBytes!), factory.controllerSourceDigest, outerObservationDigest, sha256Digest(input.observerReceiptBytes!)];
    const receipts = prefix.filter(event => event.kind === "action.status" && event.actor.kind === "kernel" && event.actor.id === "jevyr.bone" && event.payload.actionId === outer.invocationId
      && event.payload.actionType === "repository-evaluation.observe" && event.payload.status === "completed" && requiredArtifacts.every(digest => event.payload.artifactDigests?.includes(digest)));
    if (receipts.length !== 1) throw new Error("INVOCATION_NOT_BOUND_BY_AUTHENTICATED_RECORD");
    authenticatedTranscript = true; forgeProvenanceVerified = true;
  } catch (error) {
    // Implementation errors, provider source and reader exceptions remain bounded.
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{2,80}$/u.test(error.message) ? error.message : "EVIDENCE_REPLAY_REFUSED";
    problems.add(code);
  }
  // No constructor, input object, signature, or count can claim this capability.
  problems.add("TRUSTED_EVALUATOR_BOUNDARY_MISSING");
  return Object.freeze({ protocol: REPOSITORY_EVALUATION_EVIDENCE_PROTOCOL, verified: false, authenticatedCase, authenticatedTranscript, derivationVerified, controllerConsistent, forgeProvenanceVerified,
    reportOutcome, verdictAuthority: "none", ...(planDigest ? { planDigest } : {}), ...(suiteDigest ? { suiteDigest } : {}), ...(outerObservationDigest ? { outerObservationDigest } : {}), problems: Object.freeze([...problems].sort()) });
}
