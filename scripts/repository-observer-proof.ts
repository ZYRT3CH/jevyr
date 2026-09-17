import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalize, digestJson, sha256Digest, type JsonValue } from "../packages/protocol/src/index.js";
import { DEFAULT_SEARCH_PROFILE, RuleMindAdapter } from "../packages/runtime/src/index.js";
import { decodeExactByteCapture, decodeToolObservation } from "../packages/runtime/src/evidence-artifacts.js";
import { createDaemonRuntime } from "../apps/daemon/src/runtime.js";
import { createJevyrHttpService } from "../apps/daemon/src/server.js";
import { JevyrClient } from "../packages/sdk/src/index.js";
import { replayAuthenticatedCase } from "../apps/cli/src/replay.js";
import { exportLocalProof } from "../apps/cli/src/local-proof.js";
import { verifyRepositoryEvaluationEvidence, type RepositoryEvaluationEvidenceInput } from "../packages/runtime/src/repository-evaluation-evidence.js";
import { REPOSITORY_OBSERVER_ARTIFACT_MEDIA, repositoryEvaluationObserverImplementationDigest } from "../packages/runtime/src/repository-evaluation-observer.js";
import { repositoryTestControllerSource } from "../packages/runtime/src/repository-test-controller.js";

const root = resolve(process.argv[2] ?? `artifacts/repository-observer-proof-${Date.now()}`);
await mkdir(root, { recursive: false });
const hash = (value: unknown) => digestJson(value as JsonValue);
const writeJson = async (path: string, value: unknown) => await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const planned = [
  { id: "clean", source: "export const add=(a,b)=>a+b;\n", expected: { executedTests: 1, passed: 1, failed: 0, complete: true } },
  { id: "failed", source: "export const add=(a,b)=>a-b;\n", expected: { executedTests: 1, passed: 0, failed: 1, complete: true } },
  { id: "empty", source: "export const add=(a,b)=>a+b;\n", expected: { executedTests: 0, passed: 0, failed: 0, complete: false } },
] as const;
const results: unknown[] = [];
const scope = "Three finite original-repository diagnostic fixtures using production Rule Minds and the startup-bound Docker Forge. Node controller results are diagnostic context only; no language model, general repository quality, immutable evaluator authority, or candidate acceptance is measured.";
await writeJson(join(root, "plan.json"), { protocol: "jevyr.repository-observer-proof-plan/1", planned, sourceLoader: "tsx --conditions=development", scope });

for (const fixture of planned) {
  const directory = join(root, fixture.id), project = join(directory, "runtime"), subjectRoot = join(directory, "subject"), dataDir = join(project, ".jevyr");
  await mkdir(dataDir, { recursive: true }); await mkdir(join(subjectRoot, "tests"), { recursive: true });
  const suite = fixture.id === "empty"
    ? 'import "node:test"; import { add } from "../arithmetic.mjs"; void add;\n'
    : 'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "../arithmetic.mjs"; test("captured addition",()=>assert.equal(add(2,3),5));\n';
  const originals = { "arithmetic.mjs": fixture.source, "tests/arithmetic.test.mjs": suite, "README.md": "Captured but intentionally irrelevant to the selected static dependency closure.\n" };
  for (const [path, bytes] of Object.entries(originals)) await writeFile(join(subjectRoot, ...path.split("/")), bytes);
  const search = { ...DEFAULT_SEARCH_PROFILE, nursery: { ...DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 2, saturationWindow: 2, independentLineages: 2 },
    resources: { ...DEFAULT_SEARCH_PROFILE.resources, concurrentLineages: 2, maxMindInvocations: 8, maxInputTokens: 3_000_000, maxOutputTokens: 80_000, maxGeneratedBytes: 2_000_000,
      maxWallMillis: 900_000, maxSingleInvocationMillis: 180_000, maxForgeWallMillis: 180_000, maxWritableBytes: 128_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 32 } };
  await writeJson(join(dataDir, "policy.json"), { protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false, reflex: { required: true, maximumLoops: 2 },
    forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: "node:24-alpine", limits: { memoryMb: 1024, pidsLimit: 256 } },
    memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search });
  const report: Record<string, unknown> = { protocol: "jevyr.repository-observer-proof-attempt/1", fixture: fixture.id, expected: fixture.expected, scope, directory, sourceLoader: "tsx --conditions=development",
    originalFiles: Object.entries(originals).map(([path, content]) => ({ path, bytes: Buffer.byteLength(content), digest: sha256Digest(content) })), passed: false };
  await writeJson(join(directory, "report.json"), report);
  let runtime: ReturnType<typeof createDaemonRuntime> | undefined, service: ReturnType<typeof createJevyrHttpService> | undefined;
  try {
    runtime = createDaemonRuntime({ projectRoot: project, dataDir, env: {}, minds: [new RuleMindAdapter()] }); await runtime.ready();
    service = createJevyrHttpService({ runtime }); const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const receipt = await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", privacy: "local_only", control: "sovereign",
      seed: sha256Digest(`repository-observer-proof:${fixture.id}`).slice(7), subjects: [{ id: "repository", kind: "directory", locator: subjectRoot }] } });
    report.caseId = receipt.caseId; await writeJson(join(directory, "report.json"), report);
    process.stdout.write(`${JSON.stringify({ fixture: fixture.id, caseId: receipt.caseId, phase: "sealed" })}\n`);
    report.status = await runtime.orchestrator.waitForTerminal(receipt.caseId, 900_000);
    const authenticated = await client.waitForAuthenticatedRecord(receipt.caseId, { preferSse: false }), events = await runtime.events.read(receipt.caseId);
    report.verdict = authenticated.payload.verdict; report.recordDigest = hash(authenticated.payload);
    const proofDirectory = join(directory, "proof"); report.proofDirectory = proofDirectory;
    // Save proofs before expectations so unsuccessful attempts remain reviewable.
    report.independent = await exportLocalProof(client, receipt.caseId, proofDirectory);
    report.httpReplay = await replayAuthenticatedCase(client, receipt.caseId, authenticated.payload);
    const seal = await client.sealReceipt(receipt.caseId), policy = await client.policyDescriptor(receipt.caseId), artifactIndex = await client.artifactList(receipt.caseId);
    report.policyDigest = seal.policyDigest; report.runDigest = seal.runDigest;
    const capture = JSON.parse(await readFile(join(dataDir, "cases", receipt.caseId, "subject-materials.json"), "utf8"));
    assert.equal(capture.captureDigest, seal.subjectMaterialCaptureDigest); assert.equal(capture.captureDigest, hash({ protocol: "jevyr.subject-material-capture/1", bindings: capture.bindings }));
    const materialRoot = join(proofDirectory, "subject-materials"); await mkdir(join(materialRoot, "manifests"), { recursive: true }); await mkdir(join(materialRoot, "blobs"));
    await writeJson(join(materialRoot, "capture.json"), { protocol: "jevyr.subject-material-capture/1", bindings: capture.bindings, captureDigest: capture.captureDigest });
    for (const binding of capture.bindings) {
      const bytes = await readFile(join(dataDir, "subject-materials", "manifests", binding.manifestDigest.slice(7))); assert.equal(sha256Digest(bytes), binding.manifestDigest);
      await writeFile(join(materialRoot, "manifests", binding.manifestDigest.slice(7)), bytes);
      const manifest = JSON.parse(bytes.toString("utf8")); assert.ok(manifest.entries.some((entry: any) => entry.path === "README.md"));
      for (const entry of manifest.entries) {
        const blob = await readFile(join(dataDir, "subject-materials", "blobs", entry.blobDigest.slice(7))); assert.equal(sha256Digest(blob), entry.blobDigest); assert.equal(blob.length, entry.byteLength);
        await writeFile(join(materialRoot, "blobs", entry.blobDigest.slice(7)), blob);
      }
    }
    const artifacts = await Promise.all(artifactIndex.artifacts.map(async meta => {
      const bytes = await readFile(join(proofDirectory, "artifacts", `${meta.id}.blob`)); assert.equal(sha256Digest(bytes), meta.digest);
      let value: any; try { value = JSON.parse(bytes.toString("utf8")); } catch { /* executable source is retained exactly, not JSON */ }
      return { meta, bytes, value };
    }));
    const actions = events.filter(event => event.kind === "action.status" && event.payload.actionType === "repository-evaluation.observe");
    report.observerActions = actions;
    const terminal = actions.filter(event => event.kind === "action.status" && event.payload.status !== "started"); assert.equal(terminal.length, 1, "One diagnostic observer terminal receipt is required");
    const closure = artifacts.find(item => item.value?.protocol === "jevyr.repository-evaluation-closure/1"); assert.ok(closure, "Closure membership artifact missing");
    assert.equal(closure.value.captureDigest, capture.captureDigest); assert.equal(closure.value.scope, "selected-static-test-closure");
    assert.ok(!closure.value.files.some((file: any) => file.path === "README.md")); assert.ok(closure.value.files.some((file: any) => file.path === "arithmetic.mjs"));
    const observations = artifacts.filter(item => item.value?.oracle?.execution?.mode === "docker" && canonicalize(item.value.oracle.execution.args as JsonValue).includes("/subject/repository-evaluation/controller.mjs"));
    assert.equal(observations.length, 1, "Exactly one real diagnostic OCI observation is required");
    const raw = observations[0]!, observation = decodeToolObservation(raw.bytes), execution = observation.oracle!.execution;
    const stdout = decodeExactByteCapture(execution.stdoutCapture), controller = JSON.parse(Buffer.from(stdout.bytes).toString("utf8"));
    assert.equal(execution.state, "exited"); assert.equal(execution.exitCode, 0); assert.equal(execution.outputTruncated, false); assert.equal(execution.stdoutCapture!.complete, true);
    assert.equal(controller.protocol, "jevyr.repository-suite-controller-observation/1"); assert.equal(controller.authority, "none");
    for (const [key, value] of Object.entries(fixture.expected)) assert.equal(controller.report[key], value, `${fixture.id} ${key}`);
    const boundary = observation.oracle!.subjectBoundary!; assert.equal(boundary.sealedSubjectReadOnly, true); assert.equal(boundary.originalSubjectAccessible, false); assert.equal(boundary.beforeDigest, boundary.afterDigest);
    assert.notEqual(boundary.captureDigest, seal.subjectMaterialCaptureDigest, "Diagnostic package identity must not pretend to be the full original capture");
    assert.ok(!events.some(event => event.kind === "evidence.observed" && event.payload.contentDigest === raw.meta.digest), "Diagnostic observation must not enter the decision-evidence graph");
    assert.ok(!events.some(event => event.kind === "assay.status" && event.payload.evidenceIds?.includes(raw.meta.digest)), "No observer assay result is permitted");
    report.controller = { report: controller.report, problems: controller.problems, observationDigest: raw.meta.digest, stdoutDigest: execution.stdoutCapture!.digest, imageId: execution.substrate?.executionImageId };
    report.closureDigest = closure.value.materializationDigest; report.factory = (policy.artifact.descriptor as any).policy.repositoryEvaluationObserver;
    assert.equal(authenticated.payload.verdict.integrity, "VALID"); assert.equal(authenticated.payload.verdict.judgment, "UNPROVEN");
    assert.equal((report.independent as any).valid, true, JSON.stringify((report.independent as any).problems)); assert.equal((report.httpReplay as any).valid, true, JSON.stringify((report.httpReplay as any).problems));
    const trust = await client.trustBundle();
    const sourceVerificationInput: RepositoryEvaluationEvidenceInput = {
      trusted: { caseKeys: new Map(trust.keys.filter(key => key.keyId === authenticated.keyId).map(key => [key.keyId, key.publicKeyPem])),
        plannerImplementationDigest: repositoryEvaluationObserverImplementationDigest(), controllerSourceDigest: (await repositoryTestControllerSource()).digest },
      sealedCase: await client.verifiedSealedCase(receipt.caseId), sealEnvelope: await client.sealEnvelope(receipt.caseId), recordEnvelope: await client.recordEnvelope(receipt.caseId),
      events: events as RepositoryEvaluationEvidenceInput["events"], policyDescriptor: policy.artifact.descriptor, subjectId: "repository",
      capture: { bindings: capture.bindings, reader: {
        readManifest: async binding => JSON.parse((await readFile(join(materialRoot, "manifests", binding.manifestDigest.slice(7)))).toString("utf8")),
        readBlob: async (digest, size) => { const bytes = await readFile(join(materialRoot, "blobs", digest.slice(7))); assert.equal(bytes.length, size); return bytes; },
      } },
      ...Object.fromEntries(Object.entries(REPOSITORY_OBSERVER_ARTIFACT_MEDIA).map(([name, mediaType]) => {
        const matching = artifacts.filter(item => item.meta.mediaType === mediaType);
        const selected = name === "outerForgeObservationBytes" ? raw : matching[0];
        assert.ok(selected, `Missing ${name} source verification sidecar`); return [name, selected.bytes];
      })),
    };
    const sourceVerification = await verifyRepositoryEvaluationEvidence(sourceVerificationInput); report.sourceVerification = sourceVerification;
    assert.equal(sourceVerification.authenticatedCase, true); assert.equal(sourceVerification.authenticatedTranscript, true, JSON.stringify(sourceVerification.problems));
    assert.equal(sourceVerification.derivationVerified, true); assert.equal(sourceVerification.forgeProvenanceVerified, true, JSON.stringify(sourceVerification.problems));
    assert.equal(sourceVerification.controllerConsistent, fixture.id !== "empty"); assert.equal(sourceVerification.verified, false); assert.equal(sourceVerification.verdictAuthority, "none");
    const tamperedRequest = JSON.parse(Buffer.from(sourceVerificationInput.requestBytes!).toString("utf8")); tamperedRequest.root = "/subject/subject-0000";
    const tamper = await verifyRepositoryEvaluationEvidence({ ...sourceVerificationInput, requestBytes: Buffer.from(canonicalize(tamperedRequest)) });
    report.tamperVerification = tamper; assert.equal(tamper.derivationVerified, false); assert.ok(tamper.problems.includes("CONTROLLER_REQUEST_MISMATCH"));
    report.passed = true;
  } catch (error) { report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); process.exitCode = 1; }
  finally {
    try { if (service) await service.close(); else if (runtime) await runtime.close(); } catch (error) { report.closeError = String(error); report.passed = false; process.exitCode = 1; }
    report.sourceUnchanged = true;
    for (const [path, expected] of Object.entries(originals)) if (await readFile(join(subjectRoot, ...path.split("/")), "utf8") !== expected) report.sourceUnchanged = false;
    if (!report.sourceUnchanged) { report.passed = false; process.exitCode = 1; }
    await writeJson(join(directory, "report.json"), report); results.push(report);
    await writeJson(join(root, "report.json"), { protocol: "jevyr.repository-observer-proof/1", root, scope, planned: planned.length, completed: results.length, passed: results.filter((item: any) => item.passed).length, results });
    process.stdout.write(`${JSON.stringify({ fixture: fixture.id, passed: report.passed, error: report.error ?? null, directory })}\n`);
  }
}
