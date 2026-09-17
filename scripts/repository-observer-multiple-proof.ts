import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalize, digestJson, sha256Digest } from "../packages/protocol/dist/index.js";
import { DEFAULT_SEARCH_PROFILE, RuleMindAdapter } from "../packages/runtime/dist/index.js";
import { createDaemonRuntime } from "../apps/daemon/dist/runtime.js";
import { createJevyrHttpService } from "../apps/daemon/dist/server.js";
import { JevyrClient } from "../packages/sdk/dist/index.js";
import { replayAuthenticatedCase } from "../apps/cli/dist/replay.js";
import { exportLocalProof } from "../apps/cli/dist/local-proof.js";
import { replayRepositoryObservers } from "../packages/runtime/dist/repository-observer-replay.js";
import { verifyRepositoryEvaluationEvidence } from "../packages/runtime/dist/repository-evaluation-evidence.js";
import { REPOSITORY_OBSERVER_ARTIFACT_MEDIA, repositoryEvaluationObserverImplementationDigest } from "../packages/runtime/dist/repository-evaluation-observer.js";
import { repositoryTestControllerSource } from "../packages/runtime/dist/repository-test-controller.js";

// Run directly with Node's default conditions. Every application import above
// names installed dist output; this driver never builds or changes those files.
assert.ok(!process.execArgv.some(value => value.includes("conditions") || value.includes("loader")), "Default Node conditions are required");
assert.ok(!/conditions|loader/iu.test(process.env.NODE_OPTIONS ?? ""), "NODE_OPTIONS must not override package conditions");
const root = resolve(process.argv[2] ?? `artifacts/repository-observer-multiple-${Date.now()}`), project = join(root, "runtime"), dataDir = join(project, ".jevyr");
await mkdir(root, { recursive: false }); await mkdir(dataDir, { recursive: true });
const writeJson = async (path, value) => await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const compiledPaths = ["packages/runtime/dist/repository-evaluation-observer.js", "packages/runtime/dist/repository-evaluation-plan.js", "packages/runtime/dist/repository-evaluation-closure.js",
  "packages/runtime/dist/repository-test-controller.js", "packages/runtime/dist/repository-test-controller-runner.mjs", "packages/runtime/dist/repository-observer-replay.js",
  "packages/runtime/dist/orchestrator.js", "apps/daemon/dist/runtime.js", "apps/cli/dist/replay.js"];
const beforeModules = await Promise.all(compiledPaths.map(async path => ({ path, digest: sha256Digest(await readFile(resolve(path))) })));
const beforeImplementation = repositoryEvaluationObserverImplementationDigest();
const originals = { "arithmetic.mjs": "export const add=(a,b)=>a+b;\n", "tests/arithmetic.test.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "../arithmetic.mjs"; test("captured addition",()=>assert.equal(add(2,3),5));\n', "README.md": "Captured original content, outside the selected static test closure.\n" };
const subjectIds = ["repo-c", "repo-a", "repo-b"], subjects = [];
for (const id of subjectIds) {
  const locator = join(root, "subjects", id); await mkdir(join(locator, "tests"), { recursive: true });
  for (const [path, content] of Object.entries(originals)) await writeFile(join(locator, ...path.split("/")), content);
  subjects.push({ id, kind: "directory", locator });
}
const search = { ...DEFAULT_SEARCH_PROFILE, nursery: { ...DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 2, saturationWindow: 2, independentLineages: 2 }, resources: { ...DEFAULT_SEARCH_PROFILE.resources,
  concurrentLineages: 2, maxMindInvocations: 8, maxInputTokens: 3_000_000, maxOutputTokens: 80_000, maxGeneratedBytes: 2_000_000,
  maxWallMillis: 900_000, maxSingleInvocationMillis: 180_000, maxForgeWallMillis: 180_000, maxWritableBytes: 128_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 32 } };
await writeJson(join(dataDir, "policy.json"), { protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false, reflex: { required: true, maximumLoops: 2 },
  forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: "node:24-alpine", limits: { memoryMb: 1024, pidsLimit: 256 } },
  memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search });
const report = { protocol: "jevyr.repository-observer-multiple-proof/1", root, loader: "node/default-conditions; explicit dist imports", passed: false,
  scope: "One compiled production Rule-Mind Case with three supported finite repositories: two diagnostic invocations, one explicit cap omission, globally distinct artifact accounting, and exact second remaining budget. No language models or adjudicative test authority.",
  plan: { submittedOrder: subjectIds, expectedObserved: ["repo-a", "repo-b"], expectedUnobserved: ["repo-c"], originalFiles: Object.entries(originals).map(([path, content]) => ({ path, digest: sha256Digest(content), bytes: Buffer.byteLength(content) })) },
  implementationDigest: beforeImplementation, compiledModules: beforeModules };
await writeJson(join(root, "report.json"), report);
let runtime, service;
try {
  runtime = createDaemonRuntime({ projectRoot: project, dataDir, env: {}, minds: [new RuleMindAdapter()] }); await runtime.ready();
  service = createJevyrHttpService({ runtime }); const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
  const accepted = await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", privacy: "local_only", control: "sovereign",
    seed: sha256Digest("compiled-three-repository-observer-proof").slice(7), subjects } });
  report.caseId = accepted.caseId; await writeJson(join(root, "report.json"), report); process.stdout.write(`${JSON.stringify({ root, caseId: accepted.caseId, phase: "sealed" })}\n`);
  report.status = await runtime.orchestrator.waitForTerminal(accepted.caseId, 900_000);
  const authenticated = await client.waitForAuthenticatedRecord(accepted.caseId, { preferSse: false }), events = await runtime.events.read(accepted.caseId);
  report.verdict = authenticated.payload.verdict; report.recordDigest = digestJson(authenticated.payload);
  const proofDirectory = join(root, "proof"); report.proofDirectory = proofDirectory;
  report.offlineReplay = await exportLocalProof(client, accepted.caseId, proofDirectory);
  report.httpReplay = await replayAuthenticatedCase(client, accepted.caseId, authenticated.payload);
  const artifactIndex = await client.artifactList(accepted.caseId), policy = await client.policyDescriptor(accepted.caseId), seal = await client.sealReceipt(accepted.caseId);
  report.policyDigest = seal.policyDigest; report.runDigest = seal.runDigest;
  const artifacts = await Promise.all(artifactIndex.artifacts.map(async meta => {
    const bytes = await readFile(join(proofDirectory, "artifacts", `${meta.id}.blob`)); assert.equal(sha256Digest(bytes), meta.digest); assert.equal(bytes.length, meta.size);
    let value; try { value = JSON.parse(bytes.toString("utf8")); } catch { /* source artifact */ } return { meta, bytes, value };
  }));
  const byDigest = new Map(artifacts.map(item => [item.meta.digest, item]));
  const observers = await replayRepositoryObservers(events, policy.artifact.descriptor, async digest => byDigest.get(digest)?.bytes); report.observerReplay = observers;
  const receipts = observers.observations.map(item => item.receipt);
  assert.deepEqual(observers.problems, []); assert.equal(observers.observations.length, 2); assert.deepEqual(receipts.map(item => item.subjectId), ["repo-a", "repo-b"]);
  const selection = events.filter(event => event.kind === "action.status" && event.payload.actionType === "repository-evaluation.selection"); report.selection = selection;
  assert.equal(selection.length, 1); assert.equal(selection[0].payload.status, "denied"); assert.ok(selection[0].payload.summary.includes("1 additional supported repositories"));
  assert.ok(selection[0].sequence < observers.observations[0].sequence);
  const actions = events.filter(event => event.kind === "action.status" && event.payload.actionType === "repository-evaluation.observe");
  assert.equal(actions.filter(event => event.payload.status === "started").length, 2); assert.equal(actions.filter(event => event.payload.status === "completed").length, 2);
  const limits = policy.artifact.descriptor.policy.assayFrontier.aggregateLimits, first = receipts[0], second = receipts[1];
  const firstDigests = new Set([...first.artifacts.map(item => item.digest), observers.observations[0].receiptDigest]);
  const firstDistinctBytes = [...firstDigests].reduce((sum, digest) => sum + byDigest.get(digest).bytes.length, 0);
  assert.equal(firstDistinctBytes, first.resources.artifactBytes);
  const expectedSecond = { maxWritableBytes: limits.maxWritableBytes - first.resources.writableBytes, maxWritableInodes: limits.maxWritableInodes - first.resources.writableInodes,
    maxArtifactBytes: limits.maxArtifactBytes - firstDistinctBytes, timeoutMs: Math.min(policy.artifact.descriptor.policy.repositoryEvaluationObserver.timeoutMs, limits.maxForgeWallMillis - first.resources.wallMillis) };
  assert.deepEqual(second.resourceLimits, expectedSecond); report.secondRemainingBudget = { expected: expectedSecond, observed: second.resourceLimits };
  const shared = first.artifacts.filter(item => second.artifacts.some(other => other.digest === item.digest));
  assert.ok(shared.some(item => item.name === "planBytes")); assert.ok(shared.some(item => item.name === "controllerSourceBytes"));
  const allDigests = new Set([...firstDigests, ...second.artifacts.map(item => item.digest), observers.observations[1].receiptDigest]);
  const uniqueBytes = [...allDigests].reduce((sum, digest) => sum + byDigest.get(digest).bytes.length, 0);
  assert.equal(observers.baseline.artifactBytes, uniqueBytes); assert.ok(uniqueBytes < first.resources.artifactBytes + second.resources.artifactBytes);
  report.artifactDeduplication = { shared: shared.map(item => ({ name: item.name, digest: item.digest, bytes: item.byteLength })), globallyDistinctBytes: uniqueBytes,
    naivePerInvocationBytes: first.resources.artifactBytes + second.resources.artifactBytes, chargedBytes: observers.baseline.artifactBytes };
  assert.ok(!events.some(event => event.kind === "evidence.observed" && allDigests.has(event.payload.contentDigest)));
  assert.ok(!events.some(event => event.kind === "candidate.status" && event.payload.artifactDigests?.some(digest => allDigests.has(digest))));
  const capture = JSON.parse(await readFile(join(dataDir, "cases", accepted.caseId, "subject-materials.json"), "utf8"));
  assert.equal(capture.captureDigest, seal.subjectMaterialCaptureDigest); assert.equal(capture.captureDigest, digestJson({ protocol: "jevyr.subject-material-capture/1", bindings: capture.bindings }));
  const materialRoot = join(proofDirectory, "subject-materials"); await mkdir(join(materialRoot, "manifests"), { recursive: true }); await mkdir(join(materialRoot, "blobs"));
  await writeJson(join(materialRoot, "capture.json"), { protocol: "jevyr.subject-material-capture/1", bindings: capture.bindings, captureDigest: capture.captureDigest });
  for (const binding of capture.bindings) {
    const bytes = await readFile(join(dataDir, "subject-materials", "manifests", binding.manifestDigest.slice(7))); assert.equal(sha256Digest(bytes), binding.manifestDigest);
    await writeFile(join(materialRoot, "manifests", binding.manifestDigest.slice(7)), bytes);
    const manifest = JSON.parse(bytes.toString("utf8")); assert.ok(manifest.entries.some(item => item.path === "README.md"));
    for (const entry of manifest.entries) {
      const blob = await readFile(join(dataDir, "subject-materials", "blobs", entry.blobDigest.slice(7))); assert.equal(sha256Digest(blob), entry.blobDigest);
      await writeFile(join(materialRoot, "blobs", entry.blobDigest.slice(7)), blob);
    }
  }
  const trust = await client.trustBundle(), signedCase = await client.verifiedSealedCase(accepted.caseId), sourceVerifications = [];
  for (const entry of observers.observations) {
    const receipt = entry.receipt, named = Object.fromEntries(receipt.artifacts.map(item => [item.name, byDigest.get(item.digest).bytes]));
    assert.equal(receipt.authority, "none"); assert.equal(receipt.controllerConsistent, true); assert.equal(receipt.reportOutcome, "pass");
    assert.deepEqual(receipt.counts, { executedTests: 1, passed: 1, failed: 0, errors: 0, skipped: 0, cancelled: 0 });
    const closure = JSON.parse(named.closureBytes.toString("utf8")); assert.ok(!closure.files.some(file => file.path === "README.md"));
    const result = await verifyRepositoryEvaluationEvidence({ trusted: { caseKeys: new Map(trust.keys.filter(key => key.keyId === authenticated.keyId).map(key => [key.keyId, key.publicKeyPem])),
      plannerImplementationDigest: beforeImplementation, controllerSourceDigest: (await repositoryTestControllerSource()).digest }, sealedCase: signedCase, sealEnvelope: await client.sealEnvelope(accepted.caseId), recordEnvelope: await client.recordEnvelope(accepted.caseId),
      events, policyDescriptor: policy.artifact.descriptor, subjectId: receipt.subjectId, capture: { bindings: capture.bindings, reader: {
        readManifest: async binding => JSON.parse((await readFile(join(materialRoot, "manifests", binding.manifestDigest.slice(7)))).toString("utf8")),
        readBlob: async (digest, size) => { const value = await readFile(join(materialRoot, "blobs", digest.slice(7))); assert.equal(value.length, size); return value; },
      } }, ...named, observerReceiptBytes: byDigest.get(entry.receiptDigest).bytes });
    sourceVerifications.push({ subjectId: receipt.subjectId, ...result }); assert.equal(result.authenticatedTranscript, true, JSON.stringify(result.problems)); assert.equal(result.derivationVerified, true);
    assert.equal(result.forgeProvenanceVerified, true); assert.equal(result.controllerConsistent, true); assert.equal(result.verified, false); assert.equal(result.verdictAuthority, "none");
  }
  report.sourceVerifications = sourceVerifications;
  const plan = JSON.parse(byDigest.get(first.artifacts.find(item => item.name === "planBytes").digest).bytes.toString("utf8"));
  assert.equal(plan.subjects.length, 3); assert.ok(plan.subjects.every(subject => subject.status === "ready"));
  assert.ok(!receipts.some(receipt => receipt.subjectId === "repo-c")); report.unobservedSupportedSubjects = ["repo-c"];
  assert.equal(authenticated.payload.verdict.integrity, "VALID"); assert.equal(authenticated.payload.verdict.judgment, "UNPROVEN");
  assert.equal(report.offlineReplay.valid, true, JSON.stringify(report.offlineReplay.problems)); assert.equal(report.httpReplay.valid, true, JSON.stringify(report.httpReplay.problems));
  report.passed = true;
} catch (error) { report.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error); process.exitCode = 1; }
finally {
  try { if (service) await service.close(); else if (runtime) await runtime.close(); } catch (error) { report.closeError = String(error); report.passed = false; process.exitCode = 1; }
  report.sourceUnchanged = true;
  for (const subject of subjects) for (const [path, expected] of Object.entries(originals)) if (await readFile(join(subject.locator, ...path.split("/")), "utf8") !== expected) report.sourceUnchanged = false;
  report.compiledModules = await Promise.all(beforeModules.map(async before => ({ ...before, unchanged: sha256Digest(await readFile(resolve(before.path))) === before.digest })));
  report.compiledImplementationUnchanged = beforeImplementation === repositoryEvaluationObserverImplementationDigest();
  if (!report.sourceUnchanged || !report.compiledImplementationUnchanged || !report.compiledModules.every(item => item.unchanged)) { report.passed = false; process.exitCode = 1; }
  await writeJson(join(root, "report.json"), report); process.stdout.write(`${JSON.stringify({ root, caseId: report.caseId, passed: report.passed, error: report.error ?? null })}\n`);
}
