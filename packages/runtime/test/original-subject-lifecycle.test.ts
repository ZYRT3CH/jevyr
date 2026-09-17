import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { canonicalize, digestJson, LIFECYCLE_STAGES, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { JEVYR_BONE_V2_DESCRIPTOR, ORIGINAL_SUBJECT_POLICY_VERSION, replayCase, verifyDsse } from "@jevyr/core";
import { CaseRepository, DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { FileEventHub } from "../src/events.js";
import { JevyrOrchestrator } from "../src/orchestrator.js";
import { compileAssayFrontier } from "../src/assay-frontier.js";
import { createRepositoryPureProducerAssets } from "../src/repository-pure-producer.js";
import { createRepositoryPureExecutionPolicy } from "../src/repository-pure-execution.js";
import { inspectLocalDockerImage, SealedForgeAdapter, sealDockerSubstrateIdentity } from "../src/forge.js";
import { verifyPersistedAssayEvidence } from "../src/evidence-replay.js";
import { ORIGINAL_SUBJECT_CERTIFICATE_MEDIA, ORIGINAL_SUBJECT_CERTIFICATE_CHECKER } from "../src/original-subject-certificate.js";
import type { MindAdapter } from "../src/contracts.js";
import { compileJevyrIgnorePolicy } from "../src/ignore-policy.js";
const json = (value: unknown) => value as JsonValue;
const hash = (value: unknown) => digestJson(json(value));
const encoded = (value: unknown) => Buffer.from(canonicalize(json(value)));

test("v2 original-subject authority cannot be enabled by a policy label alone", () => {
  assert.throws(() => new CaseRepository("unused-v2-fixture", {}, {}, { policyVersion: ORIGINAL_SUBJECT_POLICY_VERSION }), /runtime-owned/);
  assert.throws(() => new CaseRepository("unused-v3-fixture", {}, {}, { policyVersion: "jevyr.bone/3" as any }), /Unsupported/);
  assert.equal(new CaseRepository("unused-v1-fixture").policyVersion, "jevyr.bone/1");
});

test("fixed original assertion evidence reaches signed lifecycle closure with truthful independent axes", {
  skip: process.env.JEVYR_TEST_ORIGINAL_LIFECYCLE_DOCKER !== "1", timeout: 240_000,
}, async () => {
  const output = process.env.JEVYR_ORIGINAL_LIFECYCLE_PROOF_DIR;
  assert.ok(output && isAbsolute(output), "Explicit retained proof directory required; every physical attempt remains inspectable");
  const root = resolve(output); await mkdir(root, { recursive: true });
  const identity = sealDockerSubstrateIdentity("node:24-alpine", inspectLocalDockerImage({ dockerCommand: "docker", requestedReference: "node:24-alpine" }), "local-docker-cli");
  assert.equal(identity.status, "resolved");
  const assets = await createRepositoryPureProducerAssets();
  const searchProfile = { ...DEFAULT_SEARCH_PROFILE, resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxWritableBytes: 1_000_000, maxWritableInodes: 100 } };
  const frontier = compileAssayFrontier([], searchProfile.resources);
  const ignorePolicy = compileJevyrIgnorePolicy(root, Buffer.alloc(0));
  const selection = { runtimeCompilation: { bone: JEVYR_BONE_V2_DESCRIPTOR, boneDigest: hash(JEVYR_BONE_V2_DESCRIPTOR) } };
  const policy = { protocol: "jevyr.effective-policy/1", genomeSelection: selection, genomeSelectionDigest: hash(selection),
    originalSubjectCertificateChecker: ORIGINAL_SUBJECT_CERTIFICATE_CHECKER,
    candidateIgnorePolicyDigest: ignorePolicy.sourceDigest, candidateIgnorePolicy: { protocol: "jevyr.ignore-policy/1", source: "", sourceDigest: ignorePolicy.sourceDigest, sourceBytes: 0 },
    repositoryPureAssertions: createRepositoryPureExecutionPolicy(assets, identity), assayFrontier: frontier, assayFrontierDigest: frontier.digest,
    forgeSubstrateIdentity: { protocol: "jevyr.forge-substrate-binding/1", adapterBoundary: "built-in", mode: "docker", requestedReference: identity.requestedReference,
      status: "resolved", immutableImageId: identity.immutableImageId, resolutionAuthority: "local-docker-cli", failure: null },
    effectiveForgeConfig: { mode: "docker", dockerImage: identity.requestedReference, dockerCommand: null } };
  const mind: MindAdapter = { capability: { id: "mind.original-fixture", kind: "mind", displayName: "Silent lifecycle fixture; no language model", version: "1", transport: "in-process",
    trust: "quarantined", modalities: ["text"], network: "none", canExecuteTools: false, deterministic: true },
    async probe() { return { available: true, detail: "Explicit test-only empty proposal source", latencyMs: 0, observedAt: new Date().toISOString() }; }, async *run() {} };
  const proofs = [];
  for (const fixture of ["clean", "defect", "unsupported"] as const) {
    const directory = join(root, fixture), source = join(directory, "source"), dataDir = join(directory, "store");
    await mkdir(join(source, "src"), { recursive: true }); await mkdir(join(source, "tests"));
    const sourceText = fixture === "unsupported" ? 'process.exit(0); export const add=(a,b)=>a+b;\n' : `export const add=(a,b)=>a${fixture === "defect" ? "-" : "+"}b;\n`;
    const testText = 'import test from "node:test";import assert from "node:assert/strict";import {add} from "../src/add.mjs";test("sum",()=>assert.equal(add(2,3),5));\n';
    await writeFile(join(source, "src/add.mjs"), sourceText, { flag: "wx" }); await writeFile(join(source, "tests/add.test.mjs"), testText, { flag: "wx" });
    const repository = new CaseRepository(dataDir, policy, {}, { policyVersion: ORIGINAL_SUBJECT_POLICY_VERSION, searchProfile });
    const events = new FileEventHub(dataDir), forge = new SealedForgeAdapter({ mode: "docker", dockerImage: identity.requestedReference, dockerSubstrateIdentity: identity });
    const orchestrator = new JevyrOrchestrator({ repository, events, forge, minds: [mind], assayFrontier: frontier, originalSubjectAssets: assets, candidateIgnorePolicy: ignorePolicy });
    const created = await orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", subjects: [{ id: "repo", kind: "directory", locator: source }], privacy: "local_only", control: "sovereign", seed: "original-lifecycle-held-fixture" } });
    await orchestrator.drain();
    const status = await repository.status(created.caseId), record = await repository.record(created.caseId), envelope = await repository.recordEnvelope(created.caseId), trace = await events.read(created.caseId);
    await writeFile(join(directory, "initial-observation.json"), encoded({ caseId: created.caseId, status, record, envelope, events: trace }), { flag: "wx" });
    assert.equal(status?.lifecycle, "terminated", JSON.stringify({ status, record })); assert.ok(record && envelope);
    const trust = new Map((await repository.publicTrustBundle()).keys.map(key => [key.keyId, key.publicKeyPem])); assert.equal(verifyDsse(envelope, trust), true);
    const entered = trace.filter(event => event.kind === "stage.status" && event.payload.status === "entered").map(event => event.stage);
    assert.deepEqual(entered, LIFECYCLE_STAGES);
    assert.equal(record.verdict.integrity, "VALID", JSON.stringify(record));
    assert.equal(record.verdict.judgment, fixture === "clean" ? "ACCEPT" : fixture === "defect" ? "REJECT" : "UNPROVEN", JSON.stringify(record));
    assert.equal(record.verdict.creation, "FAILED"); assert.equal(record.verdict.embodiment, "NOT_BUILT");
    assert.equal(trace.some(event => event.kind === "candidate.status"), false);
    assert.equal(trace.filter(event => event.kind === "action.status" && event.payload.actionType === "repository-pure.evaluate" && event.payload.status === "completed").length, 1);
    const artifacts = await repository.artifacts(created.caseId), certs = artifacts.filter(artifact => artifact.mediaType === ORIGINAL_SUBJECT_CERTIFICATE_MEDIA); assert.equal(certs.length, 1);
    const prefix = trace.slice(0, trace.findIndex(event => event.eventDigest === record.eventHeadDigest) + 1);
    const replay = await verifyPersistedAssayEvidence(prefix, status.sealed.intentContract, frontier, repository.policyDescriptor,
      async digest => { const meta = artifacts.find(artifact => artifact.digest === digest); return meta ? (await repository.artifact(created.caseId, meta.id))?.data : undefined; },
      { trustedRecordKeys: trust, originalSubject: { ...await repository.originalSubjectEvidenceContext(created.caseId), assets } });
    assert.equal(replay.replayComplete, true, JSON.stringify(replay.problems));
    const derived = replayCase(prefix, { policyVersion: ORIGINAL_SUBJECT_POLICY_VERSION, intentContract: status.sealed.intentContract,
      verifiedEvidenceEdges: replay.verifiedAuthorityEdges, verifiedOriginalSubjectEdges: replay.verifiedOriginalSubjectEdges,
      ...(replay.originalSubjectContext ? { originalSubjectContext: replay.originalSubjectContext } : {}) });
    assert.equal(derived.crystallizable, true); assert.deepEqual(derived.verdict, record.verdict);
    assert.equal(sha256Digest(await readFile(join(source, "src/add.mjs"))), sha256Digest(sourceText));
    proofs.push({ fixture, caseId: created.caseId, recordDigest: hash(record), verdict: record.verdict, certificateDigest: certs[0]!.digest, certificateBytes: certs[0]!.size,
      verifiedOriginalSubjectEdges: replay.verifiedOriginalSubjectEdges, replayComplete: replay.replayComplete });
    await writeFile(join(root, "report.json"), JSON.stringify({ protocol: "jevyr.original-subject-lifecycle-proof/1", scope: "Source-mode actual Docker, signed full lifecycle, separate original-subject authority; silent synthetic Mind, no model qualification", identity, proofs }, null, 2));
  }
});
