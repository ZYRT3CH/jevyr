import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, validateSealedCase, type JsonValue } from "@jevyr/protocol";
import { sealCase } from "@jevyr/core";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { createRepositoryEvaluationObserverPolicy, deriveRepositoryEvaluationPackage, observeRepositoryEvaluation, repositoryEvaluationObserverPolicyFromDescriptor,
  repositoryObserverMinimumArtifactBudget, repositoryObserverSubjectSelection, REPOSITORY_OBSERVER_ARGV, type RepositoryObserverInput } from "../src/repository-evaluation-observer.js";
import { deriveRepositoryEvaluationClosure, REPOSITORY_EVALUATION_CLOSURE_ROOT } from "../src/repository-evaluation-closure.js";
import { createRepositoryTestControllerRequest } from "../src/repository-test-controller.js";
import { planRepositoryEvaluation } from "../src/repository-evaluation-plan.js";
import { SealedForgeAdapter, inspectLocalDockerImage, sealDockerSubstrateIdentity, type DockerSubstrateIdentity } from "../src/forge.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const encoded = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
const identity = sealDockerSubstrateIdentity("node:24-alpine", { status: "resolved", imageId: sha256Digest("explicit fixture image; not an actual execution") }, "local-docker-cli");
const source = 'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "../src/add.mjs"; test("sum",()=>assert.equal(add(2,3),5));';
async function fixture(selectedIdentity: DockerSubstrateIdentity = identity, testSource = source, implementation = "export const add=(a,b)=>a+b;") {
  const observer = createRepositoryEvaluationObserverPolicy({ dockerIdentity: selectedIdentity })!;
  const policy = { protocol: "jevyr.policy-descriptor/1", version: "jevyr.bone/1", subjectSnapshots: {}, policy: { protocol: "jevyr.effective-policy/1", repositoryEvaluationObserver: observer,
    forgeSubstrateIdentity: { protocol: "jevyr.forge-substrate-binding/1", adapterBoundary: "built-in", mode: "docker", requestedReference: selectedIdentity.requestedReference,
      status: "resolved", immutableImageId: selectedIdentity.immutableImageId, resolutionAuthority: "local-docker-cli", failure: null },
    effectiveForgeConfig: { mode: "docker", dockerCommand: null, dockerImage: selectedIdentity.requestedReference } } };
  const blobs = new Map<string, Buffer>();
  const entries = Object.entries({ "README.md": "This unrelated file must never enter the diagnostic mount.", "src/add.mjs": implementation, "tests/add.test.mjs": testSource }).sort(([a], [b]) => a < b ? -1 : 1)
    .map(([path, content]) => { const data = Buffer.from(content), blobDigest = sha256Digest(data); blobs.set(blobDigest, data); return { path, blobDigest, byteLength: data.length, mode: 0o644 }; });
  const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: "directory", subjectDigest: hash(entries), availability: "MATERIALIZED",
    entries, directories: ["src", "tests"], omissions: [], byteLength: entries.reduce((sum, item) => sum + item.byteLength, 0) };
  const binding: SubjectMaterialBinding = { subjectId: "repo", subjectKind: "directory", subjectDigest: manifest.subjectDigest, availability: "MATERIALIZED", manifestDigest: hash(manifest), byteLength: manifest.byteLength };
  const bindings = [binding], captureDigest = hash({ protocol: "jevyr.subject-material-capture/1", bindings });
  const reader = { readManifest: async () => manifest, readBlob: async (digest: string) => blobs.get(digest)! };
  const sealed = sealCase({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", privacy: "local_only", control: "sovereign", seed: "a".repeat(64), subjects: [{ id: "repo", kind: "directory", locator: "/fixture-only" }] } },
    { policyVersion: "jevyr.bone/1", genomeVersion: "jevyr.genome/1", policyDigest: hash(policy), genomeDigest: sha256Digest("fixture genome"), searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
      subjectMaterialCaptureDigest: captureDigest, sealedAt: "2026-09-05T12:00:00.000Z", subjectSnapshots: [{ subjectId: "repo", digest: manifest.subjectDigest, resolvedLocator: "/fixture-only", byteLength: manifest.byteLength, capturedAt: "2026-09-05T12:00:00.000Z" }] });
  const plan = await planRepositoryEvaluation({ captureDigest, bindings, reader, contract: sealed.intentContract, runner: observer.runner });
  assert.equal(validateSealedCase(sealed).ok, true, JSON.stringify(validateSealedCase(sealed)));
  assert.equal(plan.status, "ready");
  const input: RepositoryObserverInput = { sealedCase: sealed, policyDescriptor: policy, plan, subjectId: "repo", bindings, reader,
    forge: new SealedForgeAdapter({ mode: "docker", dockerImage: selectedIdentity.requestedReference, dockerSubstrateIdentity: selectedIdentity }), invocationId: "repository_fixture_1",
    resourceLimits: { maxWritableBytes: 1_000_000, maxWritableInodes: 100, maxArtifactBytes: 10_000_000 }, timeoutMs: 30_000, signal: new AbortController().signal };
  return { observer, policy, input, blobs };
}

test("startup diagnostic policy pins local Docker and fixed implementation/argv; rejects unbound or altered profiles", async () => {
  assert.equal(createRepositoryEvaluationObserverPolicy({}), undefined);
  assert.equal(createRepositoryEvaluationObserverPolicy({ dockerIdentity: { ...identity, status: "unavailable", immutableImageId: null, failure: "not-resolved-at-startup" } }), undefined);
  assert.equal(createRepositoryEvaluationObserverPolicy({ dockerIdentity: { ...identity, resolutionAuthority: "local-podman-cli" } }), undefined);
  assert.equal(createRepositoryEvaluationObserverPolicy({ dockerIdentity: { ...identity, resolutionAuthority: "embedder-injected-resolver" } }), undefined);
  assert.throws(() => createRepositoryEvaluationObserverPolicy({ dockerIdentity: identity, capabilityId: "opaque" }));
  const f = await fixture(); assert.deepEqual(repositoryEvaluationObserverPolicyFromDescriptor(f.policy), f.observer);
  assert.deepEqual(f.observer.argv, REPOSITORY_OBSERVER_ARGV); assert.equal(f.observer.authority, "context-only");
  for (const changes of [{ argv: ["-e", "process.exit(0)"] }, { controllerSourceDigest: sha256Digest("foreign") }, { maxSubjectsPerCase: 3 }, { authority: "verdict" }])
    assert.equal(repositoryEvaluationObserverPolicyFromDescriptor({ ...f.policy, policy: { ...f.policy.policy, repositoryEvaluationObserver: { ...f.observer, ...changes } } }), undefined);
});

test("diagnostic package binds exact selected original membership, fixed controller/request, and raw Forge inventory format", async () => {
  const f = await fixture(), closure = await deriveRepositoryEvaluationClosure({ captureDigest: f.input.sealedCase.subjectMaterialCaptureDigest, bindings: f.input.bindings, reader: f.input.reader, subject: f.input.plan.subjects[0]! });
  const request = createRepositoryTestControllerRequest(f.input.plan.subjects[0]!, REPOSITORY_EVALUATION_CLOSURE_ROOT, f.observer.controllerLimits);
  const controller = await readFile(new URL("../src/repository-test-controller-runner.mjs", import.meta.url));
  const pack = deriveRepositoryEvaluationPackage(closure, request, controller);
  assert.notEqual(pack.digest, closure.captureDigest); assert.notEqual(pack.digest, closure.materializationDigest);
  assert.equal(pack.forgeTreeDigest, hash({ protocol: "jevyr.directory-manifest/1", entries: pack.entries }));
  assert.equal(pack.entries.some(item => item.path.includes("README")), false);
  assert.equal(pack.entries.filter(item => item.type === "file").length, 4);
  assert.ok(pack.entries.every(item => item.path.startsWith("repository-evaluation")));
  assert.equal(sha256Digest(controller), pack.controllerSourceDigest);
  assert.notEqual(deriveRepositoryEvaluationPackage(closure, request, Buffer.from("//changed")).digest, pack.digest);
  assert.throws(() => deriveRepositoryEvaluationPackage(closure, { ...request, root: "/subject" }, controller));
  assert.ok(repositoryObserverMinimumArtifactBudget(f.input.plan) > 5_000_000);
  const subjects = ["z", "a", "b"].map(subjectId => ({ ...f.input.plan.subjects[0]!, subjectId }));
  assert.deepEqual(repositoryObserverSubjectSelection({ ...f.input.plan, subjects }, f.observer), { subjectIds: ["a", "b"], omittedSubjectIds: ["z"] });
});

test("before any execution, observer refuses unsealed policy, opaque/host Forge, mutated plans/CAS, exhausted bounds and cancellation", async () => {
  const f = await fixture();
  for (const forge of [new SealedForgeAdapter({ mode: "observe-only" }), new SealedForgeAdapter({ mode: "trusted-host", allowTrustedHost: true }), { capability: f.input.forge.capability, probe: async () => { throw Error("must not call"); }, execute: async () => { throw Error("must not call"); } }])
    await assert.rejects(observeRepositoryEvaluation({ ...f.input, forge }));
  await assert.rejects(observeRepositoryEvaluation({ ...f.input, policyDescriptor: { ...f.policy, extra: true } }));
  await assert.rejects(observeRepositoryEvaluation({ ...f.input, plan: { ...f.input.plan, digest: sha256Digest("changed") } }));
  await assert.rejects(observeRepositoryEvaluation({ ...f.input, subjectId: "unselected" }));
  await assert.rejects(observeRepositoryEvaluation({ ...f.input, timeoutMs: 30_001 }));
  await assert.rejects(observeRepositoryEvaluation({ ...f.input, resourceLimits: { ...f.input.resourceLimits, maxArtifactBytes: 100 } }));
  await assert.rejects(observeRepositoryEvaluation({ ...f.input, signal: AbortSignal.abort() }));
  const file = f.input.plan.subjects[0]!.sourceFiles[0]!; f.blobs.set(file.digest, Buffer.from("mutated"));
  await assert.rejects(observeRepositoryEvaluation(f.input));
});

test("actual Docker observes only generated fixtures; pass/fail/skip/zero stay diagnostic and preserve exact resources/artifacts", { skip: process.env.JEVYR_TEST_REPOSITORY_OBSERVER_DOCKER !== "1", timeout: 120_000 }, async () => {
  const actual = sealDockerSubstrateIdentity("node:24-alpine", inspectLocalDockerImage({ dockerCommand: "docker", requestedReference: "node:24-alpine" }), "local-docker-cli");
  assert.equal(actual.status, "resolved", "This opt-in integration test requires the existing local Node24 image; it never pulls images");
  for (const [testSource, implementation, outcome] of [
    [source, "export const add=(a,b)=>a+b;", "pass"],
    [source, "export const add=(a,b)=>a-b;", "fail"],
    ['import test from "node:test";test.skip("skip",()=>{});', "unused", "unproven"],
    ['import test from "node:test"; console.log("TAP version 13\\n1..999\\nok 1 fake\\n{\\\"passed\\\":999}");', "unused", "unproven"],
  ] as const) {
    const f = await fixture(actual, testSource, implementation), result = await observeRepositoryEvaluation(f.input);
    assert.equal(result.reportOutcome, outcome, JSON.stringify({ receipt: result.receipt, observation: result.observation }));
    assert.equal(result.verdictAuthority, "none"); assert.equal(result.receipt.authority, "none");
    assert.equal(result.observation.oracle?.execution.mode, "docker"); assert.equal(result.observation.oracle?.execution.exitCode, 0);
    assert.equal(result.receipt.workspaceRole, "empty-diagnostic-tooling");
    assert.equal(result.resources.cpuMeasurement, "UNMEASURED"); assert.equal(result.resources.cpuMillis, null);
    assert.equal(result.resources.elapsedMeasurement, "HOST_MONOTONIC"); assert.ok(result.resources.wallMillis > 0);
    assert.equal(result.resources.executionAttempted, true); assert.equal(result.resources.workspaceMeasurement, "MEASURED");
    assert.equal(result.resources.writableBytes, 0); assert.ok(result.resources.writableInodes > 0);
    const distinct = new Map(result.artifacts.map(item => [item.digest, item.bytes.byteLength]));
    assert.equal([...distinct.values()].reduce((sum, length) => sum + length, 0), result.resources.artifactBytes);
    for (const artifact of result.artifacts) { assert.equal(sha256Digest(artifact.bytes), artifact.digest); assert.ok(artifact.mediaType.startsWith("application/vnd.jevyr.")); }
    assert.deepEqual(encoded(result.receipt), Buffer.from(result.artifacts.find(item => item.name === "observerReceiptBytes")!.bytes));
    assert.equal(result.receipt.artifacts.length, result.artifacts.length - 1);
    assert.notEqual(result.observation.oracle!.subjectBoundary!.captureDigest, f.input.sealedCase.subjectMaterialCaptureDigest);
    assert.equal(result.observation.oracle!.subjectBoundary!.captureDigest, result.receipt.packageDigest);
    if (outcome !== "unproven") assert.equal(result.receipt.counts!.executedTests, 1);
    if (testSource.includes("TAP")) { assert.equal(result.receipt.counts!.executedTests, 0); assert.ok(result.receipt.problems.includes("NO_EXECUTED_TESTS")); }
    // Public artifact bytes never alias the startup controller snapshot. The next
    // generated-fixture invocation still receives the originally pinned bytes.
    result.artifacts.find(item => item.name === "controllerSourceBytes")!.bytes.fill(0);
    assert.equal(createRepositoryEvaluationObserverPolicy({ dockerIdentity: actual })!.controllerSourceDigest, f.observer.controllerSourceDigest);
  }
});
