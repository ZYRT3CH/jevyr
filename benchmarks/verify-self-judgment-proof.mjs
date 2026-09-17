import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The intake is an unsigned, quarantined request bound to an authenticated
 * source Record. A self-consistent rehash cannot change that source identity. */
export function assertBoundSelfJudgmentRequest(request, binding, digestJson) {
  const exact = (value, fields) => {
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    assert.deepEqual(Object.keys(value).sort(), [...fields].sort());
  };
  const sha = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
  exact(request, ["protocol", "source", "failures", "candidateGenomeDigest", "parentGenomeDigest", "growthProposalDigest", "decision", "proposedChange", "benchmarkEvidence", "damageEvidence", "governanceSignature", "activeGenomeChanged", "digest"]);
  exact(request.source, ["manifestDigest", "caseId", "runDigest", "recordDigest", "genomeDigest"]);
  assert.equal(request.protocol, "jevyr.self-judge-offspring-request/1");
  const { digest, ...body } = request;
  assert.equal(digestJson(body), digest); assert.ok(sha(digest) && sha(request.candidateGenomeDigest));
  assert.equal(request.source.caseId, binding.seal.caseId);
  assert.equal(request.source.runDigest, binding.seal.runDigest);
  assert.equal(request.source.genomeDigest, binding.seal.genomeDigest);
  assert.equal(request.source.recordDigest, binding.recordDigest);
  assert.equal(request.source.manifestDigest, binding.manifestDigest);
  assert.equal(request.activeGenomeChanged, false); assert.equal(request.governanceSignature, null);
  assert.deepEqual(request.benchmarkEvidence, []); assert.deepEqual(request.damageEvidence, []);
  assert.ok(typeof request.proposedChange === "string" && request.proposedChange.length > 0 && request.proposedChange.length <= 8192);
  assert.ok(["REQUESTED_NO_GOVERNED_PARENT", "REJECTED_PENDING_BENCHMARKS"].includes(request.decision));
  if (request.decision === "REQUESTED_NO_GOVERNED_PARENT") {
    assert.equal(request.parentGenomeDigest, null); assert.equal(request.growthProposalDigest, null);
  } else {
    assert.equal(request.parentGenomeDigest, binding.seal.genomeDigest); assert.ok(sha(request.growthProposalDigest));
  }
  assert.ok(Array.isArray(request.failures) && request.failures.length > 0 && request.failures.length <= 64);
  const seen = new Set();
  for (const failure of request.failures) {
    exact(failure, ["code", "evidenceDigest"]);
    assert.match(failure.code, /^[A-Z][A-Z0-9_]{1,127}$/u); assert.ok(sha(failure.evidenceDigest));
    const identity = `${failure.code}:${failure.evidenceDigest}`; assert.ok(!seen.has(identity)); seen.add(identity);
    const id = binding.observations.get(failure.evidenceDigest); assert.ok(id);
    assert.ok(binding.record.verdict.basis.some(basis => basis.code === failure.code && basis.evidenceIds.includes(id)));
  }
}

/** Independently bind immutable captured fixture bytes, signed execution and quarantined intake. */
export async function verifySelfJudgmentProof(directory, options = {}) {
  const root = resolve(directory), source = options.development ? "src" : "dist";
  const P = await import(`../packages/protocol/${source}/index.js`);
  const { verifyLocalProof } = await import(`../apps/cli/${source}/local-proof.js`);
  async function bytes(path, maximum = 8 * 1024 * 1024) { const stat = await lstat(path); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum); const value = await readFile(path); assert.equal(value.length, stat.size); return value; }
  const json = async path => JSON.parse((await bytes(path)).toString("utf8"));
  const report = await json(join(root, "report.json")), proof = join(root, "proof");
  const signature = await verifyLocalProof(proof); assert.equal(signature.valid, true, JSON.stringify(signature.problems));
  const seal = await json(join(proof, "seal-receipt.json")), record = await json(join(proof, "record.json")), events = await json(join(proof, "events.json"));
  // These are fresh reads after the replay; bind them to that exact result too.
  assert.equal(P.digestJson(record), signature.recordDigest);
  assert.equal(seal.caseId, signature.caseId); assert.equal(seal.caseDigest, signature.caseDigest); assert.equal(seal.runDigest, signature.runDigest); assert.equal(seal.policyDigest, signature.policyDigest);
  assert.equal(seal.genomeDigest, record.genomeDigest); assert.equal(seal.intentContractDigest, signature.intentContractDigest);
  const { verifyEventChain } = await import(`../packages/core/${source}/index.js`);
  const chain = verifyEventChain(events); assert.equal(chain.valid, true); assert.equal(chain.headDigest, signature.eventHeadDigest);
  assert.equal(record.verdict.integrity, "VALID"); assert.equal(record.verdict.judgment, "REJECT"); assert.equal(report.caseId, seal.caseId);
  const materials = join(proof, "subject-materials"), capture = await json(join(materials, "capture.json"));
  assert.equal(capture.protocol, "jevyr.subject-material-capture/1"); assert.equal(capture.captureDigest, seal.subjectMaterialCaptureDigest);
  assert.equal(capture.captureDigest, P.digestJson({ protocol: capture.protocol, bindings: capture.bindings }));
  assert.deepEqual(capture.bindings.map(value => value.subjectId), ["own-repository", "self-judge-manifest"]);
  const decoded = new Map(), materialized = [];
  for (const [index, binding] of capture.bindings.entries()) {
    assert.match(binding.manifestDigest, /^sha256:[a-f0-9]{64}$/u);
    const raw = await bytes(join(materials, "manifests", binding.manifestDigest.slice(7))); assert.equal(P.sha256Digest(raw), binding.manifestDigest);
    const manifest = JSON.parse(raw.toString("utf8")); assert.equal(manifest.subjectId, binding.subjectId); assert.equal(manifest.subjectDigest, binding.subjectDigest); assert.equal(manifest.availability, "MATERIALIZED");
    assert.ok(manifest.entries.length > 0 && manifest.entries.length < 16); let totalBytes = 0;
    for (const entry of manifest.entries) {
      assert.match(entry.blobDigest, /^sha256:[a-f0-9]{64}$/u);
      const blob = await bytes(join(materials, "blobs", entry.blobDigest.slice(7))); assert.equal(blob.length, entry.byteLength); assert.equal(P.sha256Digest(blob), entry.blobDigest); totalBytes += blob.length;
      decoded.set(`${binding.subjectId}/${entry.path}`, blob);
    }
    assert.equal(totalBytes, manifest.byteLength); assert.equal(totalBytes, binding.byteLength);
    materialized.push({ subjectId: binding.subjectId, availability: "MATERIALIZED", relativeRoot: `subject-${String(index).padStart(4, "0")}`, manifestDigest: binding.manifestDigest, files: manifest.entries.length, byteLength: manifest.byteLength });
  }
  const materializationDigest = P.digestJson({ protocol: "jevyr.subject-materialization/1", subjects: materialized });
  const implementation = decoded.get("own-repository/arithmetic.mjs"), test = decoded.get("own-repository/repository.test.mjs"); assert.ok(implementation && test);
  assert.equal(implementation.toString("utf8"), "export function add(left, right) { return left - right; }\n");
  assert.equal(test.toString("utf8"), 'import { add } from "./arithmetic.mjs";\nconst actual = add(2, 3);\nprocess.stdout.write(JSON.stringify({protocol:"self-repository-test/1",test:"add-two-positive",actual,expected:5}));\nprocess.exit(actual === 5 ? 0 : 9);\n');
  assert.equal(P.sha256Digest(implementation), report.source.implementationDigest); assert.equal(P.sha256Digest(test), report.source.testDigest);
  const selfManifestEntry = [...decoded].find(([name]) => name.startsWith("self-judge-manifest/")); assert.ok(selfManifestEntry);
  const manifest = JSON.parse(selfManifestEntry[1].toString("utf8")), { digest: manifestDigest, ...manifestBody } = manifest;
  assert.equal(P.digestJson(manifestBody), manifestDigest); assert.equal(manifestDigest, report.result.manifestDigest);
  for (const file of manifest.files) { const fileBytes = decoded.get(`own-repository/${file.path}`); assert.ok(fileBytes); assert.equal(P.sha256Digest(fileBytes), file.digest); assert.equal(fileBytes.length, file.size); }
  const index = await json(join(proof, "artifact-index.json")); assert.equal(P.digestJson(index), signature.artifactIndexDigest); const observations = new Map();
  for (const meta of index.artifacts.filter(value => value.mediaType === "application/vnd.jevyr.tool-observation+json")) {
    const observedBytes = await bytes(join(proof, "artifacts", `${meta.id}.blob`));
    assert.equal(observedBytes.length, meta.size); assert.equal(P.sha256Digest(observedBytes), meta.digest);
    const observation = JSON.parse(observedBytes.toString("utf8")), execution = observation.oracle.execution;
    assert.equal(execution.mode, "docker"); assert.equal(execution.command, "node"); assert.deepEqual(execution.args, ["/subject/subject-0000/repository.test.mjs"]); assert.equal(execution.exitCode, 9);
    const output = Buffer.from(execution.stdoutCapture.data, "base64"); assert.equal(execution.stdoutCapture.complete, true); assert.equal(P.sha256Digest(output), execution.stdoutCapture.digest); assert.equal(output.length, execution.stdoutCapture.byteLength);
    assert.deepEqual(JSON.parse(output.toString("utf8")), { protocol: "self-repository-test/1", test: "add-two-positive", actual: -1, expected: 5 });
    const boundary = observation.oracle.subjectBoundary;
    assert.equal(boundary.captureDigest, seal.subjectMaterialCaptureDigest); assert.equal(boundary.materializationDigest, materializationDigest); assert.equal(boundary.sealedSubjectReadOnly, true); assert.equal(boundary.originalSubjectAccessible, false); assert.equal(boundary.beforeDigest, boundary.afterDigest);
    assert.equal(observation.metadata.planBoundAtSeal, true); assert.equal(observation.metadata.executionAuthorityStatus, "VERIFIED"); assert.equal(observation.metadata.aggregateAdmissible, true);
    const evidence = events.find(event => event.kind === "evidence.observed" && event.payload.contentDigest === meta.digest); assert.ok(evidence); observations.set(meta.digest, evidence.payload.evidenceId);
  }
  assert.ok(observations.size > 0); assert.equal(report.offspringRequests.length, 1);
  const request = report.offspringRequests[0], requestDigest = request.digest;
  assertBoundSelfJudgmentRequest(request, { seal, recordDigest: signature.recordDigest, manifestDigest, record, observations }, P.digestJson);
  return { protocol: "jevyr.self-judgment-defect-verification/1", valid: true, caseId: seal.caseId, recordDigest: signature.recordDigest, manifestDigest, immutableSourceCaptureDigest: seal.subjectMaterialCaptureDigest, physicalFailures: observations.size, quarantinedRequestDigest: requestDigest, scope: "Controlled planted immutable repository defect; exact signed evidence and quarantined intake, no governance promotion or general self-audit claim." };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2]), result = await verifySelfJudgmentProof(root, { development: process.argv.includes("--development") });
  await writeFile(join(root, "self-proof-verification.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
}
