import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256Digest, digestJson, type JsonValue } from "../packages/protocol/src/index.js";
import { DEFAULT_SEARCH_PROFILE, RuleMindAdapter, type MindRequest, type PublicContribution } from "../packages/runtime/src/index.js";
import { createDaemonRuntime } from "../apps/daemon/src/runtime.js";
import { createJevyrHttpService } from "../apps/daemon/src/server.js";
import { createRuntimeSelfJudge } from "../apps/daemon/src/self-judge-runtime.js";
import { readSelfJudgeRequests } from "../apps/daemon/src/self-judge-inspection.js";
import { JevyrClient } from "../packages/sdk/src/index.js";
import { replayAuthenticatedCase } from "../apps/cli/src/replay.js";
import { exportLocalProof } from "../apps/cli/src/local-proof.js";

const root = resolve(process.argv[2] ?? `artifacts/self-judgment-defect-${Date.now()}`);
const project = join(root, "copied-project"); await mkdir(join(project, ".jevyr"), { recursive: true });
const source = "export function add(left, right) { return left - right; }\n";
const testSource = 'import { add } from "./arithmetic.mjs";\nconst actual = add(2, 3);\nprocess.stdout.write(JSON.stringify({protocol:"self-repository-test/1",test:"add-two-positive",actual,expected:5}));\nprocess.exit(actual === 5 ? 0 : 9);\n';
await writeFile(join(project, "arithmetic.mjs"), source); await writeFile(join(project, "repository.test.mjs"), testSource);
const command = "node /subject/subject-0000/repository.test.mjs";
const mission = { protocol: "jevyr.self-judge-mission/1", impulse: `\`${command}\` exits with code 0.`, constraints: ["Execute only the immutable captured repository test; candidate-generated test replacements cannot satisfy this command."], requestedAssays: [] };
await writeFile(join(project, ".jevyr", "self-judge-case.json"), JSON.stringify(mission));
const search = { ...DEFAULT_SEARCH_PROFILE, nursery: { ...DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 2, saturationWindow: 2, independentLineages: 2 }, resources: { ...DEFAULT_SEARCH_PROFILE.resources, concurrentLineages: 2, maxMindInvocations: 8, maxInputTokens: 3_000_000, maxOutputTokens: 100_000, maxGeneratedBytes: 2_000_000, maxWallMillis: 900_000, maxSingleInvocationMillis: 180_000, maxForgeWallMillis: 180_000, maxWritableBytes: 128_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 32 } };
await writeFile(join(project, ".jevyr", "policy.json"), JSON.stringify({ protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false, reflex: { required: true, maximumLoops: 2 }, forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: "node:24-alpine", limits: { memoryMb: 1024, pidsLimit: 256 } }, memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search }));
await writeFile(join(project, ".jevyr", "assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [{ assayId: "self.immutable.repository", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["/subject/subject-0000/repository.test.mjs"] }, timeoutMs: 30_000 }] }));
class RepositoryFixture extends RuleMindAdapter {
  override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage !== "diverge") return;
    yield { id: `candidate_${request.seed.slice(0, 20)}`, kind: "candidate", summary: `Inspect the captured arithmetic implementation ${request.seed.slice(0, 8)}`, feasibility: "BUILDABLE_NOW", candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: "repository.test.mjs", content: `// Candidate replacement must have no oracle authority: ${request.seed}\nprocess.exit(0);\n` }], command: { executable: "node", args: ["repository.test.mjs"] } } };
  }
}
const runtime = createDaemonRuntime({ projectRoot: project, dataDir: join(project, ".jevyr"), env: {}, minds: [new RepositoryFixture()] });
await runtime.ready();
const driver = createRuntimeSelfJudge(runtime, { JEVYR_SELF_JUDGE: "1", JEVYR_SELF_JUDGE_CASE_FILE: ".jevyr/self-judge-case.json" });
const service = createJevyrHttpService({ runtime }); const { url } = await service.listen(0);
const client = new JevyrClient({ baseUrl: url });
try {
  const result = await driver.tick(); assert.equal(result.status, "judged");
  if (result.status !== "judged") throw new Error("Self-judgment did not produce an ordinary Case");
  const caseId = result.caseId, authenticated = await client.waitForAuthenticatedRecord(caseId);
  const events = await runtime.events.read(caseId), replay = await replayAuthenticatedCase(client, caseId, authenticated.payload);
  const requests = (await readSelfJudgeRequests(runtime.genome.registryRoot)).requests;
  const proof = join(root, "proof"), independent = await exportLocalProof(client, caseId, proof);
  await writeFile(join(root, "independent-verification.json"), JSON.stringify(independent, null, 2));
  const capture = JSON.parse(await readFile(join(project, ".jevyr", "cases", caseId, "subject-materials.json"), "utf8"));
  assert.equal(capture.captureDigest, (await client.sealReceipt(caseId)).subjectMaterialCaptureDigest);
  assert.equal(capture.captureDigest, digestJson({ protocol: "jevyr.subject-material-capture/1", bindings: capture.bindings }));
  const materials = join(proof, "subject-materials"); await mkdir(join(materials, "manifests"), { recursive: true }); await mkdir(join(materials, "blobs"));
  await writeFile(join(materials, "capture.json"), JSON.stringify({ protocol: "jevyr.subject-material-capture/1", bindings: capture.bindings, captureDigest: capture.captureDigest }, null, 2));
  for (const binding of capture.bindings) {
    const bytes = await readFile(join(project, ".jevyr", "subject-materials", "manifests", binding.manifestDigest.slice(7)));
    assert.equal(sha256Digest(bytes), binding.manifestDigest); await writeFile(join(materials, "manifests", binding.manifestDigest.slice(7)), bytes);
    const manifest = JSON.parse(bytes.toString("utf8"));
    for (const entry of manifest.entries) {
      const blob = await readFile(join(project, ".jevyr", "subject-materials", "blobs", entry.blobDigest.slice(7)));
      assert.equal(sha256Digest(blob), entry.blobDigest); assert.equal(blob.length, entry.byteLength); await writeFile(join(materials, "blobs", entry.blobDigest.slice(7)), blob);
    }
  }
  const physical = [];
  for (const meta of (await client.artifactList(caseId)).artifacts) {
    const data = await readFile(join(proof, "artifacts", `${meta.id}.blob`));
    if (meta.mediaType === "application/vnd.jevyr.tool-observation+json") physical.push({ digest: meta.digest, observation: JSON.parse(Buffer.from(data).toString("utf8")) });
  }
  const unchanged = await driver.tick();
  const report = { protocol: "jevyr.self-judgment-defect-proof/1", root, caseId, result, verdict: authenticated.payload.verdict, replay, independent, authenticated: { keyId: authenticated.keyId, traceVerification: authenticated.traceVerification }, proofDirectory: proof, source: { implementationDigest: sha256Digest(source), testDigest: sha256Digest(testSource), command, immutableMount: "/subject/subject-0000", candidateReplacementExit: 0, plantedExpected: 5, plantedActual: -1 }, offspringRequests: requests, unchanged, physicalObservations: physical, scope: "Controlled planted repository bug; actual immutable read-only subject execution in Docker, ordinary signed self-Case, independent replay and quarantined failure intake. This is not a complete audit of the Jevyr repository or a language-model quality measurement." };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(authenticated.payload.verdict.integrity, "VALID"); assert.equal(authenticated.payload.verdict.judgment, "REJECT"); assert.equal(replay.valid, true, JSON.stringify(replay.problems));
  assert.equal(independent.valid, true, JSON.stringify(independent.problems));
  assert.equal(result.proposalRecorded, true); assert.equal(requests.length, 1); assert.equal(requests[0]!.source.caseId, caseId); assert.equal(requests[0]!.source.recordDigest, digestJson(authenticated.payload as unknown as JsonValue)); assert.equal(requests[0]!.activeGenomeChanged, false); assert.equal(unchanged.status, "unchanged");
  assert.equal(await readFile(join(project, "arithmetic.mjs"), "utf8"), source); assert.equal(await readFile(join(project, "repository.test.mjs"), "utf8"), testSource);
  assert.ok(physical.length > 0);
  const seal = await client.sealReceipt(caseId);
  for (const { observation } of physical) {
    assert.equal(observation.oracle.execution.mode, "docker"); assert.equal(observation.oracle.execution.command, "node"); assert.deepEqual(observation.oracle.execution.args, ["/subject/subject-0000/repository.test.mjs"]); assert.equal(observation.oracle.execution.exitCode, 9);
    const stdout = observation.oracle.execution.stdoutCapture, output = Buffer.from(stdout.data, "base64"); assert.equal(stdout.complete, true); assert.equal(output.length, stdout.byteLength); assert.equal(sha256Digest(output), stdout.digest);
    const measured = JSON.parse(output.toString("utf8")); assert.equal(measured.actual, -1); assert.equal(measured.expected, 5);
    const boundary = observation.oracle.subjectBoundary; assert.equal(boundary.captureDigest, seal.subjectMaterialCaptureDigest); assert.equal(boundary.sealedSubjectReadOnly, true); assert.equal(boundary.beforeDigest, boundary.afterDigest); assert.equal(boundary.originalSubjectAccessible, false);
  }
  console.log(JSON.stringify({ root, caseId, verdict: authenticated.payload.verdict, replay: replay.valid, proposalRecorded: result.proposalRecorded, physicalObservations: physical.length }));
} finally { await driver.stop(); await service.close(); }
