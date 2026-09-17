import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { compileIntentContract, createCaseEvent } from "@jevyr/core";
import { canonicalize, digestJson, sha256Digest, type CaseEvent, type JsonValue } from "@jevyr/protocol";
import { createRepositoryEvaluationObserverPolicy, deriveRepositoryEvaluationPackage, repositoryObserverArtifactMediaType } from "../src/repository-evaluation-observer.js";
import { deriveRepositoryEvaluationClosure } from "../src/repository-evaluation-closure.js";
import { planRepositoryEvaluation } from "../src/repository-evaluation-plan.js";
import { createRepositoryTestControllerRequest } from "../src/repository-test-controller.js";
import { decodeRepositoryObserverReceipt, replayRepositoryObservers } from "../src/repository-observer-replay.js";
import { encodeToolObservation, exactByteCapture } from "../src/evidence-artifacts.js";
import type { ToolObservation } from "../src/contracts.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";

const hash = (value: unknown) => digestJson(value as JsonValue), encode = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
const CASE = sha256Digest("observer replay Case"), RUN = sha256Digest("observer replay run"), IMAGE = sha256Digest("observer replay image"), REFERENCE = "jevyr/observer:fixture";
const LIMITS = { maxForgeWallMillis: 60_000, maxForgeCpuMillis: 10_000, maxWritableBytes: 1_000_000, maxWritableInodes: 1000, maxArtifactBytes: 20_000_000, maxTotalAssayCost: 10 };
const identity = { protocol: "jevyr.docker-substrate-identity/1" as const, status: "resolved" as const, failure: null, requestedReference: REFERENCE, immutableImageId: IMAGE, resolutionAuthority: "local-docker-cli" as const };
function ledger(drafts: readonly any[]): CaseEvent[] {
  const events: CaseEvent[] = [];
  for (const draft of drafts) events.push(createCaseEvent({ caseDigest: CASE, runDigest: RUN, observedAt: "2026-09-05T00:00:00.000Z", stage: "self_scan", kind: "action.status", actor: { id: "jevyr.bone", kind: "kernel" }, ...draft }, events.length + 1, events.at(-1)?.eventDigest ?? null));
  return events;
}
async function fixture(adapterLimits: Record<string, number> = {}) {
  const factory = createRepositoryEvaluationObserverPolicy({ dockerIdentity: identity })!;
  const policy = { protocol: "jevyr.policy-descriptor/1", version: "observer-fixture", policy: { protocol: "jevyr.effective-policy/1", repositoryEvaluationObserver: factory,
    forgeSubstrateIdentity: { protocol: "jevyr.forge-substrate-binding/1", adapterBoundary: "built-in", mode: "docker", requestedReference: REFERENCE, immutableImageId: IMAGE, status: "resolved", failure: null, resolutionAuthority: "local-docker-cli" },
    effectiveForgeConfig: { mode: "docker", dockerImage: REFERENCE, dockerCommand: null, ...adapterLimits }, assayFrontier: { aggregateLimits: LIMITS } } };
  const source = Buffer.from('import test from "node:test";import assert from "node:assert/strict";test("sum",()=>assert.equal(2+3,5));');
  const manifests = new Map<string, SubjectMaterialManifest>(), bindings: SubjectMaterialBinding[] = [];
  for (const subjectId of ["repo-a", "repo-b"]) {
    const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId, subjectKind: "directory", subjectDigest: sha256Digest(subjectId), availability: "MATERIALIZED",
      entries: [{ path: "sum.test.mjs", blobDigest: sha256Digest(source), byteLength: source.length, mode: 0o644 }], directories: [], omissions: [], byteLength: source.length };
    manifests.set(subjectId, manifest); bindings.push({ subjectId, subjectKind: "directory", subjectDigest: manifest.subjectDigest, availability: "MATERIALIZED", manifestDigest: hash(manifest), byteLength: manifest.byteLength });
  }
  const captureDigest = hash({ protocol: "jevyr.subject-material-capture/1", bindings });
  const reader = { readManifest: async (binding: SubjectMaterialBinding) => manifests.get(binding.subjectId)!, readBlob: async () => source };
  const contract = compileIntentContract({ impulse: "Existing tests must pass.", subjectIds: bindings.map(binding => binding.subjectId) });
  const plan = await planRepositoryEvaluation({ captureDigest, bindings, reader, contract, runner: factory.runner, limits: factory.limits });
  assert.equal(plan.status, "ready");
  const controller = await readFile(new URL("../src/repository-test-controller-runner.mjs", import.meta.url));
  const bundle = async (subjectIndex = 0, previous: { wall: number; bytes: number; inodes: number; artifacts: number } = { wall: 0, bytes: 0, inodes: 0, artifacts: 0 }) => {
    const subject = plan.subjects[subjectIndex]!, closure = await deriveRepositoryEvaluationClosure({ captureDigest, bindings, reader, subject });
    const request = createRepositoryTestControllerRequest(subject, "/subject/repository-evaluation/closure", factory.controllerLimits), packaged = deriveRepositoryEvaluationPackage(closure, request, controller);
    const limits = { maxWritableBytes: LIMITS.maxWritableBytes - previous.bytes, maxWritableInodes: LIMITS.maxWritableInodes - previous.inodes,
      maxArtifactBytes: LIMITS.maxArtifactBytes - previous.artifacts, timeoutMs: Math.min(factory.timeoutMs, LIMITS.maxForgeWallMillis - previous.wall) };
    const stdout = exactByteCapture(Buffer.from("diagnostic fixture bytes\n")), stderr = exactByteCapture(Buffer.alloc(0));
    const observation: ToolObservation = { invocationId: `observe-${subject.subjectId}`, status: "succeeded", summary: "Unit accounting fixture; not an execution proof.", startedAt: "2026-09-05T00:00:00.000Z", finishedAt: "2026-09-05T00:00:00.100Z", exitCode: 0,
      oracle: { execution: { state: "exited", mode: "docker", command: "node", args: factory.argv, shell: false, exitCode: 0, stdoutCapture: stdout, stderrCapture: stderr, outputTruncated: false,
        substrate: { schema: "jevyr.docker-execution-substrate/1", requestedReference: REFERENCE, startupResolvedImageId: IMAGE, executionImageId: IMAGE, contentAddressed: true, inspectedBeforeExecution: true } },
        networkIsolation: { schema: "jevyr.docker-network-none/1", networkMode: "none", enforced: true, complete: true, externalAccessCount: 0 },
        subjectBoundary: { schema: "jevyr.sanitized-subject-boundary/2", sanitized: true, disposableWorkspace: true, sealedSubjectReadOnly: true, originalSubjectAccessible: false, complete: true,
          captureDigest: packaged.digest, materializationDigest: packaged.digest, beforeDigest: packaged.forgeTreeDigest, afterDigest: packaged.forgeTreeDigest } },
      metadata: { resourceAccounting: { protocol: "jevyr.forge-resource-accounting/1", workspace: { byteCeiling: Math.min(limits.maxWritableBytes, adapterLimits.maxWritableBytes ?? 100_000_000), inodeCeiling: Math.min(limits.maxWritableInodes, adapterLimits.maxWritableInodes ?? 10_000),
        after: { measurement: "MEASURED", complete: true, bytes: 73, inodes: 4 } }, cpu: { measurement: "DECLARED_ONLY", usedMillis: null }, wall: { measurement: "MEASURED", usedMillis: 81.5 },
        processOutput: { measurement: "MEASURED", complete: true, usedBytes: stdout.byteLength, stdoutBytes: stdout.byteLength, stderrBytes: 0, retainedBytes: stdout.byteLength, ceilingBytes: 1_000_000, exactCapturesComplete: true } } } };
    const body: Record<string, Uint8Array> = { planBytes: encode(plan), closureBytes: encode(closure), packageBytes: encode(packaged), controllerSourceBytes: controller, requestBytes: encode(request), outerForgeObservationBytes: encodeToolObservation(observation).bytes, controllerObservationBytes: Buffer.from("diagnostic fixture bytes\n") };
    const receipt: any = { protocol: "jevyr.repository-evaluation-observer-receipt/1", caseId: "case_observer", runDigest: RUN, policyDigest: hash(policy), invocationId: observation.invocationId,
      subjectId: subject.subjectId, planDigest: plan.digest, closureDigest: closure.materializationDigest, packageDigest: packaged.digest, controllerSourceDigest: sha256Digest(controller), requestDigest: hash(request),
      outerObservationDigest: sha256Digest(body.outerForgeObservationBytes!), controllerObservationDigest: sha256Digest(body.controllerObservationBytes!), target: "sealed-original-subject", scope: "selected-static-test-closure", workspaceRole: "empty-diagnostic-tooling",
      authority: "none", reportOutcome: "unproven", controllerConsistent: false, counts: null, problems: ["CONTROLLER_OUTPUT_INVALID", "DIAGNOSTIC_ONLY_NO_VERDICT_AUTHORITY"], resourceLimits: limits, artifacts: [],
      resources: { wallMillis: 105, elapsedMeasurement: "HOST_MONOTONIC", executionAttempted: true, cpuMillis: null, cpuMeasurement: "UNMEASURED", writableBytes: 73, writableInodes: 4, workspaceMeasurement: "MEASURED", artifactBytes: 0 } };
    const finalize = (mutateReceipt?: (value: any) => void, mutateObservation?: (value: any) => void, omitController = false) => {
      const values: Record<string, Uint8Array> = { ...body }, current = structuredClone(receipt);
      if (omitController) { delete values.controllerObservationBytes; current.controllerObservationDigest = null; }
      if (mutateObservation) { const changed = structuredClone(observation); mutateObservation(changed); values.outerForgeObservationBytes = encodeToolObservation(changed).bytes; current.outerObservationDigest = sha256Digest(values.outerForgeObservationBytes); }
      current.artifacts = Object.entries(values).map(([name, value]) => ({ name, digest: sha256Digest(value), byteLength: value.byteLength, mediaType: repositoryObserverArtifactMediaType(name) })).sort((a, b) => a.name < b.name ? -1 : 1);
      mutateReceipt?.(current);
      for (let i = 0; i < 8; i++) { values.observerReceiptBytes = encode(current); const length = [...new Map(Object.values(values).map(value => [sha256Digest(value), value.byteLength])).values()].reduce((a, b) => a + b, 0); if (length === current.resources.artifactBytes) break; current.resources.artifactBytes = length; }
      values.observerReceiptBytes = encode(current);
      const artifacts = new Map(Object.values(values).map(value => [sha256Digest(value), value]));
      const drafts = [ { payload: { actionId: observation.invocationId, actionType: "repository-evaluation.observe", status: "started", summary: "Diagnostic fixture started" } },
        { payload: { actionId: observation.invocationId, actionType: "repository-evaluation.observe", status: "completed", summary: "Diagnostic fixture completed", artifactDigests: [...artifacts.keys()].sort(), resource: { wallMillis: current.resources.wallMillis, bytesWritten: current.resources.writableBytes } } } ];
      return { receipt: current, artifacts, drafts, events: ledger(drafts), values };
    };
    return { finalize, ...finalize() };
  };
  return { policy, bundle };
}
const replay = (policy: unknown, trace: { events: readonly CaseEvent[]; artifacts: ReadonlyMap<string, Uint8Array> }) => replayRepositoryObservers(trace.events, policy, async digest => trace.artifacts.get(digest));

test("diagnostic physical costs replay without minting candidate, assay, or verdict authority", async () => {
  const f = await fixture(), trace = await f.bundle(), result = await replay(f.policy, trace);
  assert.deepEqual(result.problems, []); assert.equal(result.verdictAuthority, "none"); assert.equal(result.observations.length, 1);
  assert.deepEqual(result.baseline, { forgeWallMillis: 105, measuredForgeCpuMillis: 0, cpuMeasurements: 0, cpuUnmeasured: true, workspaceUnmeasured: false,
    writableBytes: 73, writableInodes: 4, artifactBytes: trace.receipt.resources.artifactBytes, totalAssayCost: 0 });
});

test("two observers consume cumulative original ceilings while shared canonical bytes are charged once", async () => {
  const f = await fixture(), a = await f.bundle(), b = await f.bundle(1, { wall: 105, bytes: 73, inodes: 4, artifacts: a.receipt.resources.artifactBytes });
  const artifacts = new Map([...a.artifacts, ...b.artifacts]), result = await replay(f.policy, { events: ledger([...a.drafts, ...b.drafts]), artifacts });
  assert.deepEqual(result.problems, []); assert.equal(result.baseline.forgeWallMillis, 210); assert.equal(result.baseline.writableBytes, 146);
  assert.equal(result.baseline.artifactBytes, [...artifacts.values()].reduce((sum, value) => sum + value.byteLength, 0));
  assert.ok(result.baseline.artifactBytes < a.receipt.resources.artifactBytes + b.receipt.resources.artifactBytes);
  const forged = b.finalize(receipt => { receipt.resourceLimits.maxWritableBytes = LIMITS.maxWritableBytes; });
  assert.ok((await replay(f.policy, { events: ledger([...a.drafts, ...forged.drafts]), artifacts: new Map([...a.artifacts, ...forged.artifacts]) })).problems.some(problem => problem.message.includes("exact remaining")));
});

test("startup Mind availability probes do not count as investigation, and tighter sealed Forge ceilings remain exact", async () => {
  const f = await fixture({ maxWritableBytes: 512, maxWritableInodes: 8 }), trace = await f.bundle();
  const probe = { kind: "evidence.observed", actor: { id: "mind.rule", kind: "mind" }, payload: { evidenceId: "probe-fixture", evidenceType: "tool_observation", summary: "Availability only", contentDigest: sha256Digest("probe") } };
  const result = await replay(f.policy, { ...trace, events: ledger([probe, ...trace.drafts]) });
  assert.deepEqual(result.problems, []); assert.equal(trace.receipt.resourceLimits.maxWritableBytes, LIMITS.maxWritableBytes);
  const wrong = trace.finalize(undefined, o => { o.metadata.resourceAccounting.workspace.byteCeiling = LIMITS.maxWritableBytes; });
  assert.ok((await replay(f.policy, wrong)).problems.some(problem => problem.message.includes("sealed adapter")));
  const invoke = { payload: { actionId: "mind-start", actionType: "mind.contribute", status: "started", summary: "Investigation started" } };
  assert.ok((await replay(f.policy, { ...trace, events: ledger([invoke, ...trace.drafts]) })).problems.some(problem => problem.message.includes("pre-investigation")));
});

test("measured CPU is accumulated exactly while host monotonic time survives a wall-clock correction", async () => {
  const f = await fixture(), base = await f.bundle();
  const trace = base.finalize(r => { r.resources.cpuMeasurement = "MEASURED"; r.resources.cpuMillis = 17; }, o => {
    o.finishedAt = "2026-09-04T23:59:59.999Z"; o.metadata.resourceAccounting.cpu = { measurement: "MEASURED", usedMillis: 17 };
  });
  const result = await replay(f.policy, trace); assert.deepEqual(result.problems, []);
  assert.equal(result.baseline.measuredForgeCpuMillis, 17); assert.equal(result.baseline.cpuMeasurements, 1); assert.equal(result.baseline.cpuUnmeasured, false); assert.equal(result.baseline.forgeWallMillis, 105);
});

test("rehashing zero costs, fake measurement flags, incorrect caps and sidecar lengths does not hide diagnostic work", async () => {
  const f = await fixture(), base = await f.bundle();
  for (const mutate of [
    (r: any) => { r.resources.wallMillis = 0; }, (r: any) => { r.resources.writableBytes = 0; },
    (r: any) => { r.resources.cpuMeasurement = "MEASURED"; r.resources.cpuMillis = 0; },
    (r: any) => { r.resources.executionAttempted = false; }, (r: any) => { r.resources.workspaceMeasurement = "NOT_ATTEMPTED"; },
    (r: any) => { r.resourceLimits.maxWritableBytes += 1; }, (r: any) => { r.resourceLimits.timeoutMs -= 1; },
    (r: any) => { r.artifacts[0].byteLength += 1; }, (r: any) => { r.authority = "verified"; },
    (r: any) => { r.resources.extra = "unrecognized"; },
  ]) assert.ok((await replay(f.policy, base.finalize(mutate))).problems.length > 0, mutate.toString());
});

test("raw invalid measurements, process byte mismatches and image substitution are refused even when rehashed", async () => {
  const f = await fixture(), base = await f.bundle();
  for (const mutate of [
    (o: any) => { o.metadata.resourceAccounting.workspace.after.bytes = -1; },
    (o: any) => { o.metadata.resourceAccounting.cpu.measurement = "MEASURED"; o.metadata.resourceAccounting.cpu.usedMillis = 0.1; },
    (o: any) => { o.metadata.resourceAccounting.processOutput.stdoutBytes = 0; },
    (o: any) => { o.oracle.execution.substrate.executionImageId = sha256Digest("different image"); },
    (o: any) => { o.oracle.subjectBoundary.captureDigest = sha256Digest("whole original capture"); },
    (o: any) => { o.oracle.networkIsolation.enforced = false; },
  ]) assert.ok((await replay(f.policy, base.finalize(undefined, mutate))).problems.length > 0, mutate.toString());
  const omitted = base.finalize(undefined, undefined, true);
  assert.ok(omitted.receipt.resources.artifactBytes < base.receipt.resources.artifactBytes);
  assert.ok((await replay(f.policy, omitted)).problems.some(problem => problem.message.includes("controller-output retention")));
});

test("attempted missing workspace uses conservative ceilings and marks it unavailable without inventing CPU", async () => {
  const f = await fixture(), base = await f.bundle();
  const trace = base.finalize(r => { r.resources.writableBytes = r.resourceLimits.maxWritableBytes; r.resources.writableInodes = r.resourceLimits.maxWritableInodes; r.resources.workspaceMeasurement = "CONSERVATIVE_CEILING"; },
    o => { o.metadata.resourceAccounting.workspace.after = { measurement: "UNAVAILABLE", complete: false, bytes: null, inodes: null }; });
  const result = await replay(f.policy, trace); assert.deepEqual(result.problems, []); assert.equal(result.baseline.workspaceUnmeasured, true);
  assert.equal(result.baseline.writableBytes, LIMITS.maxWritableBytes); assert.equal(result.baseline.cpuUnmeasured, true); assert.equal(result.baseline.measuredForgeCpuMillis, 0);
});

test("diagnostic action ordering, complete membership, same-Case scope and absence of authority edges are enforced", async () => {
  const f = await fixture(), trace = await f.bundle();
  const variants = [
    [trace.drafts[1]], [trace.drafts[0]], [...trace.drafts, trace.drafts[1]],
    [trace.drafts[0], { ...trace.drafts[1], stage: "assay" }],
    [trace.drafts[0], { ...trace.drafts[1], runDigest: sha256Digest("other run") }],
    [trace.drafts[0], { payload: { ...trace.drafts[1]!.payload, artifactDigests: trace.drafts[1]!.payload.artifactDigests!.slice(1) } }],
    [...trace.drafts, { kind: "evidence.observed", actor: { id: "tool.fixture", kind: "tool" }, payload: { evidenceId: "observed-fixture", evidenceType: "tool_observation", summary: "must remain action-only", contentDigest: trace.receipt.outerObservationDigest } }],
  ];
  for (const drafts of variants) assert.ok((await replay(f.policy, { events: ledger(drafts), artifacts: trace.artifacts })).problems.length > 0);
  const bytes = Buffer.from(trace.values.observerReceiptBytes!); bytes[0] = 0;
  const corrupt = new Map(trace.artifacts); corrupt.set(sha256Digest(trace.values.observerReceiptBytes!), bytes);
  assert.ok((await replay(f.policy, { ...trace, artifacts: corrupt })).problems.length > 0);
  assert.throws(() => decodeRepositoryObserverReceipt(encode({ ...trace.receipt, extra: true })));
});

test("historical no-observer traces are unchanged and a pre-execution zero-charge denial grants no work", async () => {
  let reads = 0;
  assert.deepEqual((await replayRepositoryObservers([], {}, async () => { reads++; return undefined; })).problems, []); assert.equal(reads, 0);
  const f = await fixture(), events = ledger([{ payload: { actionId: "observer-denied", actionType: "repository-evaluation.observe", status: "denied", summary: "No physical remainder" } }]);
  const result = await replay(f.policy, { events, artifacts: new Map() }); assert.deepEqual(result.problems, []); assert.equal(result.baseline.artifactBytes, 0); assert.equal(result.observations.length, 0);
});
