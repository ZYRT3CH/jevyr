import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract, createCaseEvent, generateSigningKeyPair, sealCase, sealReceipt, signJevyrRecord, signSealReceipt } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, type CaseEvent, type JsonValue, type SignedRecord } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { encodeToolObservation, exactByteCapture } from "../src/evidence-artifacts.js";
import type { ToolObservation } from "../src/contracts.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";
import { planRepositoryEvaluation, REPOSITORY_EVALUATION_DISCOVERY, REPOSITORY_EVALUATION_LIMITS } from "../src/repository-evaluation-plan.js";
import { createRepositoryTestControllerRequest, REPOSITORY_TEST_CONTROLLER_LIMITS, summarizeRepositoryTestEvents } from "../src/repository-test-controller.js";
import { verifyRepositoryEvaluationEvidence, type RepositoryEvaluationEvidenceInput, type RepositoryEvaluatorFactory } from "../src/repository-evaluation-evidence.js";
import { deriveRepositoryEvaluationClosure, REPOSITORY_EVALUATION_CLOSURE_ROOT } from "../src/repository-evaluation-closure.js";
import { deriveRepositoryEvaluationPackage, REPOSITORY_OBSERVER_ARGV, REPOSITORY_OBSERVER_CONTROLLER_PATH, REPOSITORY_OBSERVER_REQUEST_PATH, REPOSITORY_OBSERVER_ARTIFACT_MEDIA } from "../src/repository-evaluation-observer.js";

const hash = (value: unknown) => digestJson(value as JsonValue), bytes = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
const time = "2026-09-05T12:00:00.000Z";
/** Signed protocol fixtures, not real Docker runs or valid evaluator authority. */
async function fixture(failed = false) {
  const keys = generateSigningKeyPair(), controllerSourceBytes = Buffer.from("// explicitly synthetic trusted-parameter fixture\n"), controllerSourceDigest = sha256Digest(controllerSourceBytes), plannerImplementationDigest = sha256Digest("fixture planner identity");
  const image = sha256Digest("fixture OCI image"), reference = "fixture/node24:sealed";
  const factory: RepositoryEvaluatorFactory = { protocol: "jevyr.repository-evaluator-factory/1", discovery: REPOSITORY_EVALUATION_DISCOVERY, plannerImplementationDigest, controllerSourceDigest,
    controllerPath: REPOSITORY_OBSERVER_CONTROLLER_PATH, requestPath: REPOSITORY_OBSERVER_REQUEST_PATH, argv: REPOSITORY_OBSERVER_ARGV, maxSubjectsPerCase: 2, timeoutMs: 30_000,
    runner: { id: "node-test-v1", evaluatorDigest: controllerSourceDigest, immutableImageId: image, capabilityId: "forge.oci" }, limits: REPOSITORY_EVALUATION_LIMITS, controllerLimits: REPOSITORY_TEST_CONTROLLER_LIMITS, authority: "context-only" };
  const policy = { protocol: "jevyr.policy-descriptor/1", version: "jevyr.bone/1", subjectSnapshots: {}, policy: { protocol: "jevyr.effective-policy/1", repositoryEvaluationObserver: factory,
    forgeSubstrateIdentity: { protocol: "jevyr.forge-substrate-binding/1", adapterBoundary: "built-in", mode: "docker", requestedReference: reference, status: "resolved", immutableImageId: image, resolutionAuthority: "embedder-injected-resolver", failure: null },
    effectiveForgeConfig: { mode: "docker", dockerCommand: null, dockerImage: reference } } };
  const source = 'import test from "node:test"; import assert from "node:assert/strict"; test("one",()=>assert.equal(1,1));\n';
  const entry = { path: "tests/one.test.mjs", blobDigest: sha256Digest(source), byteLength: Buffer.byteLength(source), mode: 0o644 };
  const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: "directory", subjectDigest: sha256Digest("fixture subject tree"), availability: "MATERIALIZED", byteLength: entry.byteLength, entries: [entry], directories: ["tests"], omissions: [] };
  const binding: SubjectMaterialBinding = { subjectId: "repo", subjectKind: "directory", subjectDigest: manifest.subjectDigest, availability: "MATERIALIZED", byteLength: entry.byteLength, manifestDigest: hash(manifest) };
  const bindings = [binding], captureDigest = hash({ protocol: "jevyr.subject-material-capture/1", bindings }), blobs = new Map([[entry.blobDigest, Buffer.from(source)]]);
  let readCount = 0;
  const reader = { readManifest: async () => { readCount++; return manifest; }, readBlob: async (digest: string) => { readCount++; return blobs.get(digest)!; } };
  const submission = { protocol: "jevyr.case/1" as const, case: { impulse: "Existing tests must pass.", privacy: "local_only" as const, control: "sovereign" as const, seed: "held-fixture", subjects: [{ id: "repo", kind: "directory" as const, locator: "/fixture/repository" }] } };
  const sealed = sealCase(submission, { policyVersion: "jevyr.bone/1", genomeVersion: "jevyr.genome/1", policyDigest: hash(policy), genomeDigest: sha256Digest("fixture genome"), searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), sealedAt: time, subjectMaterialCaptureDigest: captureDigest,
    subjectSnapshots: [{ subjectId: "repo", digest: manifest.subjectDigest, resolvedLocator: "/fixture/repository", capturedAt: time, byteLength: entry.byteLength }] });
  const contract = compileIntentContract({ impulse: submission.case.impulse, subjectIds: ["repo"] });
  assert.equal(contract.digest, sealed.intentContractDigest);
  const plan = await planRepositoryEvaluation({ captureDigest, bindings, reader, contract, runner: factory.runner, limits: factory.limits });
  const closure = await deriveRepositoryEvaluationClosure({ captureDigest, bindings, reader, subject: plan.subjects[0]! });
  const request = createRepositoryTestControllerRequest(plan.subjects[0]!, REPOSITORY_EVALUATION_CLOSURE_ROOT, factory.controllerLimits), path = `${REPOSITORY_EVALUATION_CLOSURE_ROOT}/tests/one.test.mjs`;
  const packaged = deriveRepositoryEvaluationPackage(closure, request, controllerSourceBytes);
  const counts = { tests: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, skipped: 0, cancelled: 0, todo: 0, suites: 0, topLevel: 1 };
  const events: unknown[] = [
    { type: failed ? "test:fail" : "test:pass", data: { name: "one", file: path, line: 1, column: 1, nesting: 0, details: { type: "test", duration_ms: 1, ...(failed ? { error: { name: "Error", message: "unit fixture failure", code: "ERR_TEST_FAILURE", failureType: "testCodeFailure", cause: { name: "AssertionError", message: "unit fixture", code: "ERR_ASSERTION" } } } : {}) } } },
    { type: "test:summary", data: { file: path, counts, success: !failed } }, { type: "test:summary", data: { counts, success: !failed } },
  ];
  const stream = { ended: true, observedEvents: events.length, retainedEvents: events.length, observedEventBytes: events.reduce((sum: number, event) => sum + bytes(event).length, 0), complete: true, timedOut: false, controllerError: false };
  const inventoryFiles = [...request.sourceFiles], inventory = { before: { files: inventoryFiles, digest: hash(inventoryFiles) }, after: { files: inventoryFiles, digest: hash(inventoryFiles) } };
  const summary = await summarizeRepositoryTestEvents(events, request, stream, inventory); assert.deepEqual(summary.problems, []);
  const controllerBody = { protocol: "jevyr.repository-suite-controller-observation/1", target: request.target, authority: "none", requestDigest: hash(request), nodeVersion: "v24.13.0", controllerPid: 42, runner: "node:test.run/process", inventory, stream, events, eventDigest: hash(events), ...summary, trustScope: "Synthetic protocol fixture. No execution or verdict authority." };
  let controller: any = { ...controllerBody, digest: hash(controllerBody) };
  const outer: ToolObservation = { invocationId: "repository-evaluator-fixture", status: "succeeded", summary: "Synthetic outer execution receipt", startedAt: time, finishedAt: time, exitCode: 0, oracle: {
    execution: { state: "exited", mode: "docker", command: "node", args: factory.argv, shell: false, exitCode: 0, outputTruncated: false, stdoutCapture: exactByteCapture(bytes(controller)), stderrCapture: exactByteCapture(Buffer.alloc(0)),
      substrate: { schema: "jevyr.docker-execution-substrate/1", requestedReference: reference, startupResolvedImageId: image, executionImageId: image, contentAddressed: true, inspectedBeforeExecution: true } },
    subjectBoundary: { schema: "jevyr.sanitized-subject-boundary/2", captureDigest: packaged.digest, materializationDigest: packaged.digest, beforeDigest: packaged.forgeTreeDigest, afterDigest: packaged.forgeTreeDigest,
      sanitized: true, disposableWorkspace: true, sealedSubjectReadOnly: true, originalSubjectAccessible: false, complete: true } } };
  const observerReceipt = { protocol: "jevyr.repository-evaluation-observer-receipt/1", caseId: sealed.caseId, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest,
    invocationId: outer.invocationId, subjectId: "repo", planDigest: plan.digest, closureDigest: closure.materializationDigest, packageDigest: packaged.digest, controllerSourceDigest, requestDigest: hash(request),
    outerObservationDigest: sha256Digest(encodeToolObservation(outer).bytes), controllerObservationDigest: sha256Digest(bytes(controller)), target: "sealed-original-subject", scope: closure.scope,
    workspaceRole: "empty-diagnostic-tooling", authority: "none", reportOutcome: failed ? "fail" : "pass", controllerConsistent: true,
    counts: { executedTests: 1, passed: failed ? 0 : 1, failed: failed ? 1 : 0, errors: 0, skipped: 0, cancelled: 0 }, problems: ["DIAGNOSTIC_ONLY_NO_VERDICT_AUTHORITY"],
    resourceLimits: { maxWritableBytes: 1_000_000, maxWritableInodes: 100, maxArtifactBytes: 2_000_000, timeoutMs: 30_000 }, resources: { wallMillis: 1, artifactBytes: 0 }, artifacts: [] as unknown[] };
  const input: RepositoryEvaluationEvidenceInput = { trusted: { caseKeys: new Map([[keys.keyId, keys.publicKeyPem]]), plannerImplementationDigest, controllerSourceDigest }, sealedCase: sealed, sealEnvelope: signSealReceipt(sealReceipt(sealed), keys.privateKeyPem), policyDescriptor: policy, subjectId: "repo", capture: { bindings, reader },
    planBytes: bytes(plan), closureBytes: bytes(closure), packageBytes: bytes(packaged), observerReceiptBytes: bytes(observerReceipt), requestBytes: bytes(request), controllerSourceBytes, controllerObservationBytes: bytes(controller), outerForgeObservationBytes: encodeToolObservation(outer).bytes };
  const attest = (current: RepositoryEvaluationEvidenceInput): RepositoryEvaluationEvidenceInput => {
    const receipt = JSON.parse(Buffer.from(current.observerReceiptBytes!).toString("utf8"));
    receipt.artifacts = (Object.keys(REPOSITORY_OBSERVER_ARTIFACT_MEDIA) as (keyof typeof REPOSITORY_OBSERVER_ARTIFACT_MEDIA)[]).filter(key => key !== "observerReceiptBytes")
      .map(name => ({ name, digest: sha256Digest(current[name]!), byteLength: current[name]!.byteLength, mediaType: REPOSITORY_OBSERVER_ARTIFACT_MEDIA[name] })).sort((a, b) => a.name < b.name ? -1 : 1);
    current = { ...current, observerReceiptBytes: bytes(receipt) };
    const obs = JSON.parse(Buffer.from(current.outerForgeObservationBytes!).toString("utf8")), ledger: CaseEvent[] = [];
    ledger.push(createCaseEvent({ caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, observedAt: time, stage: "self_scan", kind: "action.status", actor: { id: "jevyr.bone", kind: "kernel" }, payload: { actionId: obs.invocationId, actionType: "repository-evaluation.observe", status: "started", summary: "Unit fixture only" } }, 1, null));
    ledger.push(createCaseEvent({ caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, observedAt: time, stage: "self_scan", kind: "action.status", actor: { id: "jevyr.bone", kind: "kernel" }, payload: { actionId: obs.invocationId, actionType: "repository-evaluation.observe", status: "completed", summary: "Unit fixture only", artifactDigests: [sha256Digest(current.planBytes!), sha256Digest(current.closureBytes!), sha256Digest(current.packageBytes!), sha256Digest(current.observerReceiptBytes!), sha256Digest(current.requestBytes!), sha256Digest(current.controllerObservationBytes!), sha256Digest(current.outerForgeObservationBytes!), controllerSourceDigest] } }, 2, ledger[0]!.eventDigest));
    const evidenceDigest = sha256Digest("fixture empty evidence graph"), record: SignedRecord = { protocol: "jevyr.record/1", caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest, genomeDigest: sealed.genomeDigest, searchDigest: sealed.searchEnvelope.digest, intentContractDigest: contract.digest, eventHeadDigest: ledger.at(-1)!.eventDigest,
      verdict: { policyVersion: sealed.policyVersion, intentContractDigest: contract.digest, evidenceDigest, integrity: "VALID", creation: "FAILED", embodiment: "NOT_BUILT", judgment: "UNPROVEN", feasibilityByCandidate: {}, basis: [] }, reflex: { loop: 1, reviewedEvidenceDigest: evidenceDigest, intentContractDigest: contract.digest, challengedNodeIds: [], materialFindings: [], decision: "confirm" }, memoryInfluences: [], crystallizedAt: time };
    return { ...current, events: ledger, recordEnvelope: signJevyrRecord(record, keys.privateKeyPem) };
  };
  return { input: attest(input), attest, controller, outer, plan, request, factory, policy, reader, blobs, readCount: () => readCount };
}

test("complete signed protocol provenance remains non-adjudicative without the specialized evaluator boundary", async () => {
  for (const failed of [false, true]) {
    const f = await fixture(failed), result = await verifyRepositoryEvaluationEvidence(f.input);
    assert.equal(result.authenticatedCase, true); assert.equal(result.authenticatedTranscript, true); assert.equal(result.derivationVerified, true); assert.equal(result.controllerConsistent, true); assert.equal(result.forgeProvenanceVerified, true);
    assert.equal(result.reportOutcome, failed ? "fail" : "pass"); assert.equal(result.verified, false); assert.equal(result.verdictAuthority, "none");
    assert.deepEqual(result.problems, ["TRUSTED_EVALUATOR_BOUNDARY_MISSING"]);
  }
});

test("missing sidecars or untrusted Case signatures refuse before using source or counts", async () => {
  const f = await fixture(), before = f.readCount();
  const untrusted = await verifyRepositoryEvaluationEvidence({ ...f.input, trusted: { ...f.input.trusted, caseKeys: new Map() } });
  assert.equal(untrusted.authenticatedCase, false); assert.equal(f.readCount(), before); assert.ok(untrusted.problems.includes("TRUSTED_CASE_KEYS_MISSING"));
  const missing = await verifyRepositoryEvaluationEvidence({ ...f.input, capture: undefined } as unknown as RepositoryEvaluationEvidenceInput);
  assert.equal(missing.derivationVerified, false); assert.ok(missing.problems.includes("SOURCE_SIDECARS_MISSING"));
  const changedSeal = structuredClone(f.input.sealEnvelope) as any; changedSeal.signatures[0].sig = Buffer.alloc(64).toString("base64");
  assert.equal((await verifyRepositoryEvaluationEvidence({ ...f.input, sealEnvelope: changedSeal })).authenticatedCase, false);
});

test("rehashed plan, foreign target and byte substitution cannot change the captured suite", async () => {
  const f = await fixture();
  const plan: any = structuredClone(f.plan); plan.subjects[0].testFiles[0].digest = sha256Digest("candidate passing test"); const { digest: _, ...body } = plan; plan.digest = hash(body);
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, planBytes: bytes(plan) })).problems.includes("PLAN_DERIVATION_MISMATCH"));
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, requestBytes: bytes({ ...f.request, target: "revision-overlay" }) })).problems.includes("CONTROLLER_REQUEST_MISMATCH"));
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, requestBytes: bytes({ ...f.request, root: "/jevyr-writable/work" }) })).problems.includes("CONTROLLER_REQUEST_MISMATCH"));
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, requestBytes: bytes({ ...f.request, root: "/subject/subject-0000" }) })).problems.includes("CONTROLLER_REQUEST_MISMATCH"));
  const closure = JSON.parse(Buffer.from(f.input.closureBytes!).toString("utf8")); closure.files[0].original.entryIndex = 42;
  const { materializationDigest: _materialization, ...closureBody } = closure; closure.materializationDigest = hash(closureBody);
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, closureBytes: bytes(closure) })).problems.includes("CLOSURE_DERIVATION_MISMATCH"));
  f.blobs.set(f.plan.subjects[0]!.testFiles[0]!.digest, Buffer.from("process.exit(0)"));
  assert.equal((await verifyRepositoryEvaluationEvidence(f.input)).derivationVerified, false);
});

test("forged report counts fail raw event rederivation even after all public hashes are recomputed", async () => {
  const f = await fixture(true), controller = structuredClone(f.controller);
  controller.report.failed = 0; controller.report.passed = 1; const { digest: _, ...body } = controller; controller.digest = hash(body);
  const result = await verifyRepositoryEvaluationEvidence({ ...f.input, controllerObservationBytes: bytes(controller) });
  assert.equal(result.controllerConsistent, false); assert.ok(result.problems.includes("CONTROLLER_EVENT_REPLAY_MISMATCH"));
});

test("factory and controller implementation substitutions cannot authorize a matching report", async () => {
  const f = await fixture();
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, trusted: { ...f.input.trusted, plannerImplementationDigest: sha256Digest("other planner") } })).problems.includes("FACTORY_IMPLEMENTATION_UNSUPPORTED"));
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, controllerSourceBytes: Buffer.from("other controller") })).problems.includes("CONTROLLER_IMPLEMENTATION_MISMATCH"));
  const policy = structuredClone(f.policy); (policy.policy.repositoryEvaluationObserver as any).authority = "verified";
  assert.ok((await verifyRepositoryEvaluationEvidence({ ...f.input, policyDescriptor: policy })).problems.includes("POLICY_IDENTITY_MISMATCH"));
});

test("outer image, command, source boundary and invocation context require exact recorded bindings", async () => {
  const f = await fixture();
  for (const mutate of [
    (o: any) => { o.oracle.execution.substrate.executionImageId = sha256Digest("foreign image"); },
    (o: any) => { o.oracle.execution.args = ["candidate-generated-controller.mjs"]; },
    (o: any) => { o.oracle.subjectBoundary.afterDigest = sha256Digest("changed subject"); },
    (o: any) => { o.oracle.subjectBoundary.captureDigest = (f.input.sealedCase as any).subjectMaterialCaptureDigest; },
    (o: any) => { o.oracle.subjectBoundary.materializationDigest = sha256Digest("foreign package"); },
    (o: any) => { o.oracle.subjectBoundary.originalSubjectAccessible = true; },
  ]) {
    const outer = structuredClone(f.outer); mutate(outer);
    const result = await verifyRepositoryEvaluationEvidence(f.attest({ ...f.input, outerForgeObservationBytes: encodeToolObservation(outer).bytes }));
    assert.equal(result.forgeProvenanceVerified, false); assert.ok(result.problems.some(problem => /OUTER_FORGE|SELECTED_CLOSURE|INVOCATION_BINDING/u.test(problem)));
  }
});

test("metadata and signatures cannot impersonate an authenticated recorded invocation or grant authority", async () => {
  const f = await fixture();
  const missing = await verifyRepositoryEvaluationEvidence({ ...f.input, recordEnvelope: undefined } as unknown as RepositoryEvaluationEvidenceInput);
  assert.ok(missing.problems.includes("AUTHENTICATED_TRANSCRIPT_MISSING")); assert.equal(missing.forgeProvenanceVerified, false);
  const events = structuredClone(f.input.events!); (events[1]!.payload as any).contentDigest = sha256Digest("replacement");
  const altered = await verifyRepositoryEvaluationEvidence({ ...f.input, events }); assert.ok(altered.problems.includes("AUTHENTICATED_CHAIN_INVALID"));
  const forged = await verifyRepositoryEvaluationEvidence({ ...f.input, trustedBoundary: { verified: true }, verified: true } as unknown as RepositoryEvaluationEvidenceInput);
  assert.equal(forged.verified, false); assert.deepEqual(forged.problems, ["TRUSTED_EVALUATOR_BOUNDARY_MISSING"]);
});
