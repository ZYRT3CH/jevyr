import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { generateSigningKeyPair, sealCase, sealReceipt, signSealReceipt } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { SealedForgeAdapter, inspectLocalDockerImage, sealDockerSubstrateIdentity, type DockerSubstrateIdentity } from "../src/forge.js";
import { createRepositoryPureProducerAssets } from "../src/repository-pure-producer.js";
import { createRepositoryPureExecutionPolicy, executeRepositoryPureAssertions, replayRepositoryPureExecution, type RepositoryPureExecutionInput, type RepositoryPureExecutionReplayInput } from "../src/repository-pure-execution.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";
const hash = (value: unknown) => digestJson(value as JsonValue), bytes = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
const assetsPromise = createRepositoryPureProducerAssets();
const synthetic = sealDockerSubstrateIdentity("node:24-alpine", { status: "resolved", imageId: sha256Digest("explicit synthetic substrate; no Docker execution") }, "local-docker-cli");

async function fixture(identity: DockerSubstrateIdentity, failed = false) {
  const assets = await assetsPromise, factory = createRepositoryPureExecutionPolicy(assets, identity), keys = generateSigningKeyPair();
  const policyDescriptor = { protocol: "jevyr.policy-descriptor/1", version: "jevyr.bone/1", subjectSnapshots: {}, policy: {
    protocol: "jevyr.effective-policy/1", repositoryPureAssertions: factory,
    forgeSubstrateIdentity: { protocol: "jevyr.forge-substrate-binding/1", adapterBoundary: "built-in", mode: "docker", requestedReference: identity.requestedReference,
      status: "resolved", immutableImageId: identity.immutableImageId, resolutionAuthority: identity.resolutionAuthority, failure: null },
    effectiveForgeConfig: { mode: "docker", dockerCommand: null, dockerImage: identity.requestedReference },
  } };
  const files = { "src/add.mjs": `export const add = (a,b) => a ${failed ? "-" : "+"} b;\n`,
    "tests/add.test.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "../src/add.mjs"; test("sum",()=>assert.equal(add(2,3),5));\n' };
  const blobs = new Map<string, Uint8Array>();
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, text]) => {
    const data = Buffer.from(text), blobDigest = sha256Digest(data); blobs.set(blobDigest, data); return { path, blobDigest, byteLength: data.length, mode: 0o644 };
  });
  const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: "directory", subjectDigest: hash(entries), availability: "MATERIALIZED",
    entries, directories: ["src", "tests"], omissions: [], byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0) };
  const binding: SubjectMaterialBinding = { subjectId: "repo", subjectKind: "directory", subjectDigest: manifest.subjectDigest, availability: "MATERIALIZED", manifestDigest: hash(manifest), byteLength: manifest.byteLength };
  const bindings = [binding], reader = { readManifest: async () => manifest, readBlob: async (digest: string) => { const data = blobs.get(digest); if (!data) throw Error("missing captured bytes"); return Buffer.from(data); } };
  const time = "2026-09-05T12:00:00.000Z", locator = "C:/private-fixture-never-mounted/original-repository";
  const sealedCase = sealCase({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", privacy: "local_only", control: "sovereign", seed: "pure-physical-held-fixture", subjects: [{ id: "repo", kind: "directory", locator }] } },
    { policyVersion: "jevyr.bone/1", genomeVersion: "jevyr.genome/1", policyDigest: hash(policyDescriptor), genomeDigest: sha256Digest("fixture genome"), searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), sealedAt: time,
      subjectMaterialCaptureDigest: hash({ protocol: "jevyr.subject-material-capture/1", bindings }), subjectSnapshots: [{ subjectId: "repo", digest: manifest.subjectDigest, resolvedLocator: locator, capturedAt: time, byteLength: manifest.byteLength }] });
  const sealEnvelope = signSealReceipt(sealReceipt(sealedCase), keys.privateKeyPem), trustedCaseKeys = new Map([[keys.keyId, keys.publicKeyPem]]);
  const input: RepositoryPureExecutionInput = { sealedCase, policyDescriptor, assets, bindings, reader,
    forge: new SealedForgeAdapter({ mode: "docker", dockerImage: identity.requestedReference, dockerSubstrateIdentity: identity }),
    invocationId: `pure_execution_${failed ? "defect" : "clean"}`, resourceLimits: { maxWritableBytes: 1_000_000, maxWritableInodes: 100, maxArtifactBytes: 20_000_000 }, timeoutMs: 30_000, signal: new AbortController().signal };
  const replay = (artifacts: Readonly<Record<string, Uint8Array>>): RepositoryPureExecutionReplayInput => ({ sealedCase, policyDescriptor, assets, bindings, reader, sealEnvelope, trustedCaseKeys, artifacts });
  return { input, replay, factory, files, blobs, manifest, bindings, sealEnvelope, publicKey: keys.publicKeyPem };
}

test("pure evaluator refuses unbound, host and opaque execution before any physical invocation", async () => {
  const f = await fixture(synthetic);
  for (const forge of [new SealedForgeAdapter({ mode: "observe-only" }), new SealedForgeAdapter({ mode: "trusted-host", allowTrustedHost: true }),
    { capability: f.input.forge.capability, probe: async () => { throw Error("must not run"); }, execute: async () => { throw Error("must not run"); } }])
    await assert.rejects(executeRepositoryPureAssertions({ ...f.input, forge }), /PURE_EXECUTION_INPUT_REFUSED/);
  await assert.rejects(executeRepositoryPureAssertions({ ...f.input, policyDescriptor: { ...f.input.policyDescriptor as any, injected: true } }));
  await assert.rejects(executeRepositoryPureAssertions({ ...f.input, timeoutMs: 30_001 }));
  await assert.rejects(executeRepositoryPureAssertions({ ...f.input, resourceLimits: { ...f.input.resourceLimits, maxArtifactBytes: 1 } }));
  await assert.rejects(executeRepositoryPureAssertions({ ...f.input, resourceLimits: { ...f.input.resourceLimits, maxArtifactBytes: 20_000_001 } }), /PURE_SEALED_RESOURCE_ENVELOPE_EXCEEDED/);
  await assert.rejects(executeRepositoryPureAssertions({ ...f.input, signal: AbortSignal.abort() }));
});

test("independent pure replay authenticates the actual Seal before reading source and grants no Record authority", async () => {
  const f = await fixture(synthetic); let reads = 0;
  const reader = { readManifest: async () => { reads++; throw Error("must not read"); }, readBlob: async () => { reads++; throw Error("must not read"); } };
  for (const changed of [
    { trustedCaseKeys: new Map() }, { sealEnvelope: { ...f.sealEnvelope, payload: Buffer.from("{}").toString("base64") } },
    { sealedCase: { ...f.input.sealedCase, caseDigest: sha256Digest("foreign") } },
  ]) {
    const result = await replayRepositoryPureExecution({ ...f.replay({}), reader, ...changed });
    assert.equal(result.consistent, false); assert.equal(result.authenticatedCase, false); assert.equal(result.authority, "none");
  }
  assert.equal(reads, 0);
});

test("actual fixed OCI evaluator reconstructs clean and defective captured source; rehashed substitutions fail", {
  skip: process.env.JEVYR_TEST_PURE_EXECUTION_DOCKER !== "1", timeout: 180_000,
}, async () => {
  const identity = sealDockerSubstrateIdentity("node:24-alpine", inspectLocalDockerImage({ dockerCommand: "docker", requestedReference: "node:24-alpine" }), "local-docker-cli");
  assert.equal(identity.status, "resolved", "Requires existing local Node24 image; does not pull or install anything");
  const proofs = [];
  for (const failed of [false, true]) {
    const f = await fixture(identity, failed), execution = await executeRepositoryPureAssertions(f.input), replay = await replayRepositoryPureExecution(f.replay(execution.artifacts));
    // Retain unsuccessful physical attempts before making any passing assertion.
    if (process.env.JEVYR_PURE_EXECUTION_PROOF_DIR) {
      const base = process.env.JEVYR_PURE_EXECUTION_PROOF_DIR; assert.ok(isAbsolute(base)); const target = resolve(base, failed ? "defect" : "clean");
      assert.equal(target, join(resolve(base), failed ? "defect" : "clean")); await mkdir(target, { recursive: true });
      for (const data of new Map(Object.values(execution.artifacts).map(data => [sha256Digest(data), data])).values())
        await writeFile(join(target, `${sha256Digest(data).slice(7)}.artifact`), data, { flag: "wx" });
      await writeFile(join(target, "sealed-case.json"), bytes(f.input.sealedCase), { flag: "wx" }); await writeFile(join(target, "seal.dsse.json"), bytes(f.sealEnvelope), { flag: "wx" });
      await writeFile(join(target, "policy.json"), bytes(f.input.policyDescriptor), { flag: "wx" }); await writeFile(join(target, "public-key.pem"), f.publicKey, { flag: "wx" });
      await writeFile(join(target, "artifact-index.json"), bytes(Object.entries(execution.artifacts).map(([name,data])=>({name,file:`${sha256Digest(data).slice(7)}.artifact`,digest:sha256Digest(data),byteLength:data.length}))), { flag: "wx" });
      await writeFile(join(target, "capture.json"), bytes({bindings:f.bindings,manifests:[f.manifest],blobs:[...f.blobs].map(([digest,data])=>({digest,data:Buffer.from(data).toString("base64")}))}), { flag: "wx" });
      await writeFile(join(target, "initial-replay.json"), bytes(replay), { flag: "wx" });
    }
    assert.equal(replay.consistent, true, JSON.stringify({ replay, observation: execution.observation }));
    assert.equal(replay.outcome, failed ? "mismatch" : "match"); assert.equal(replay.authority, "none");
    const result = JSON.parse(Buffer.from(execution.artifacts["result.json"]!).toString("utf8"));
    assert.deepEqual(result.analysis.assertions[0].actual, { kind: "integer", value: failed ? -1 : 5 });
    assert.deepEqual(result.analysis.assertions[0].expected.value, { kind: "integer", value: 5 });
    assert.equal(execution.receipt.resources.cpuMillis, null); assert.equal(execution.receipt.resources.cpuMeasurement, "UNMEASURED");
    assert.equal(execution.receipt.resources.writableBytes, 0); assert.equal(execution.observation.oracle?.execution.mode, "docker");
    const mount = Object.entries(execution.artifacts).filter(([name]) => name.startsWith("mount/"));
    assert.ok(mount.length > 4); assert.ok(mount.every(([, data]) => !Buffer.from(data).includes(Buffer.from("C:/private-fixture-never-mounted"))));
    const tamper = async (mutate: (artifacts: Record<string, Uint8Array>) => void) => {
      const artifacts = Object.fromEntries(Object.entries(execution.artifacts).map(([name, data]) => [name, Buffer.from(data)])); mutate(artifacts);
      // Rehash the public receipt inventory, lengths and references. Independent
      // source reconstruction must reject the substitution, not just a stale hash.
      const receipt = JSON.parse(Buffer.from(artifacts["receipt.json"]!).toString("utf8"));
      receipt.outerObservationDigest = sha256Digest(artifacts["observation.json"]!); receipt.resultDigest = sha256Digest(artifacts["result.json"]!);
      receipt.artifacts = Object.entries(artifacts).filter(([name]) => name !== "receipt.json").map(([name, data]) => ({ name, digest: sha256Digest(data), byteLength: data.length })).sort((a,b)=>a.name<b.name?-1:1);
      for (let i=0;i<8;i++) { artifacts["receipt.json"] = bytes(receipt); const count = [...new Map(Object.values(artifacts).map(data=>[sha256Digest(data),data.length])).values()].reduce((a,b)=>a+b,0); if(count===receipt.resources.artifactBytes)break;receipt.resources.artifactBytes=count; }
      const checked = await replayRepositoryPureExecution(f.replay(artifacts)); assert.equal(checked.consistent, false, JSON.stringify(checked)); return checked.problems;
    };
    const rejected: unknown[] = [];
    rejected.push(await tamper(artifacts => { const value = JSON.parse(Buffer.from(artifacts["result.json"]!).toString("utf8")); value.analysis.assertions[0].expected.value.value = 99; const { digest: _, ...body } = value; value.digest = hash(body); artifacts["result.json"] = Buffer.concat([bytes(value),Buffer.from("\n")]); }));
    for (const change of [
      (value: any) => { value.exitCode = 9; },
      (value: any) => { value.oracle.execution.substrate.executionImageId = sha256Digest("other image"); },
      (value: any) => { value.oracle.execution.args = ["/subject/subject-generated-controller.mjs"]; },
      (value: any) => { value.oracle.subjectBoundary.afterDigest = sha256Digest("changed package"); },
      (value: any) => { delete value.oracle.toolingWorkspace; },
      (value: any) => { value.metadata.resourceAccounting.workspace.after.inodes = 0; },
      (value: any) => { value.metadata.resourceAccounting.cpu.usedMillis = 0; },
    ]) rejected.push(await tamper(artifacts => { const value = JSON.parse(Buffer.from(artifacts["observation.json"]!).toString("utf8")); change(value); artifacts["observation.json"] = bytes(value); }));
    const mountedFile = mount.find(([name]) => name.endsWith("producer.mjs"))![0];
    rejected.push(await tamper(artifacts => { artifacts[mountedFile] = Buffer.from("process.exit(0);\n"); }));
    const before = [...f.blobs].map(([digest, data]) => [digest, sha256Digest(data)]); assert.ok(before.every(([digest, observed]) => digest === observed));
    proofs.push({ fixture: failed ? "defect" : "clean", caseId: f.input.sealedCase.caseId, receipt: execution.receipt, replay, rejected, unchangedSource: true });
  }
  if (process.env.JEVYR_PURE_EXECUTION_PROOF_DIR) await writeFile(join(process.env.JEVYR_PURE_EXECUTION_PROOF_DIR, "report.json"), JSON.stringify({protocol:"jevyr.repository-pure-physical-preparation/1",observedAt:new Date().toISOString(),authority:"none",scope:"Source-mode fixed OCI execution and authenticated Seal replay; no signed Record or verdict edges.",identity,proofs},null,2));
});
