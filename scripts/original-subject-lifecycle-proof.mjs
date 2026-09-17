import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digestJson, sha256Digest } from "../packages/protocol/dist/index.js";
import { JEVYR_BONE_V2_DIGEST } from "../packages/core/dist/index.js";
import { ORIGINAL_SUBJECT_CERTIFICATE_MEDIA, loadRepositoryPureProducerAssetsSync } from "../packages/runtime/dist/index.js";
import { createDaemonRuntime } from "../apps/daemon/dist/runtime.js";
import { loadProjectPolicy } from "../apps/daemon/dist/project-policy.js";
import { createJevyrHttpService } from "../apps/daemon/dist/server.js";
import { JevyrClient } from "../packages/sdk/dist/index.js";
import { exportLocalProof, verifyLocalProof } from "../apps/cli/dist/local-proof.js";

assert.equal([...process.execArgv, process.env.NODE_OPTIONS ?? ""].some(value => /conditions.*development/u.test(value)), false, "This proof measures the coherent installed build");
assert.equal(process.argv.length, 3, "Pass one fresh output directory inside repository artifacts");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), artifactRoot = join(repositoryRoot, "artifacts"), root = resolve(process.argv[2]);
const part = relative(artifactRoot, root); assert.ok(part && !part.startsWith("..") && !isAbsolute(part));
await mkdir(root);
const methodFiles = ["packages/core/dist/original-subject.js", "packages/core/dist/policy.js", "packages/core/policy/judgment-v2.rego", "packages/core/policy/judgment-v2.wasm",
  "packages/runtime/dist/original-subject-certificate.js", "packages/runtime/dist/repository-pure-execution.js", "packages/runtime/dist/repository-pure-producer.js",
  "packages/runtime/dist/repository-pure-assets-pin.js", "packages/runtime/dist/orchestrator.js", "packages/runtime/dist/repository.js", "packages/runtime/dist/evidence-replay.js",
  "apps/daemon/dist/runtime.js", "apps/cli/dist/local-proof.js", "apps/cli/dist/replay.js", "packages/sdk/dist/index.js"];
const snapshot = async () => Promise.all(methodFiles.map(async path => ({ path, digest: sha256Digest(await readFile(join(repositoryRoot, path))) })));
const before = await snapshot(), assets = loadRepositoryPureProducerAssetsSync();
const fixtures = [
  { id: "clean", expected: "ACCEPT", source: "export const add=(a,b)=>a+b;\n" },
  { id: "defect", expected: "REJECT", source: "export const add=(a,b)=>a-b;\n" },
  { id: "unsupported", expected: "UNPROVEN", source: "process.exit(0); export const add=(a,b)=>a+b;\n" },
];
const testSource = 'import test from "node:test";import assert from "node:assert/strict";import {add} from "../src/add.mjs";test("sum",()=>assert.equal(add(2,3),5));\n';
const manifest = { protocol: "jevyr.original-subject-installed-proof/1", createdAt: new Date().toISOString(),
  scope: "Actual installed daemon, ordinary HTTP Cast/export, fixed original-source OCI evaluator, signed closure and offline replay; synthetic silent Mind, no model qualification",
  source: sha256Digest(await readFile(fileURLToPath(import.meta.url))), boneDigest: JEVYR_BONE_V2_DIGEST, producer: assets.descriptor, implementation: before,
  fixtures: fixtures.map(fixture => ({ id: fixture.id, expected: fixture.expected, sourceDigest: sha256Digest(fixture.source), testsDigest: sha256Digest(testSource) })) };
await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
const attempts = [];
const mind = { capability: { id: "mind.original-fixture", kind: "mind", displayName: "Silent fixture; no language model", version: "1", transport: "in-process", trust: "quarantined",
  modalities: ["text"], network: "none", canExecuteTools: false, deterministic: true },
  async probe() { return { available: true, detail: "Empty test-only proposal stream", latencyMs: 0, observedAt: new Date().toISOString() }; }, async *run() {} };
for (const fixture of fixtures) {
  const directory = join(root, fixture.id), project = join(directory, "project"), source = join(directory, "source"), dataDir = join(directory, "store");
  await mkdir(join(project, ".jevyr"), { recursive: true }); await mkdir(join(source, "src"), { recursive: true }); await mkdir(join(source, "tests"));
  await writeFile(join(source, "src/add.mjs"), fixture.source, { flag: "wx" }); await writeFile(join(source, "tests/add.test.mjs"), testSource, { flag: "wx" });
  const base = loadProjectPolicy(project).policy;
  const policy = { ...base, policyVersion: "bone-v2", search: { ...base.search, resources: { ...base.search.resources, maxWritableBytes: 1_000_000, maxWritableInodes: 100 } } };
  await writeFile(join(project, ".jevyr/policy.json"), JSON.stringify(policy), { flag: "wx" });
  await writeFile(join(project, ".jevyr/assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [] }), { flag: "wx" });
  const attempt = { fixture: fixture.id, expected: fixture.expected, startedAt: new Date().toISOString(), passed: false };
  attempts.push(attempt);
  let runtime, service, client;
  try {
    runtime = createDaemonRuntime({ projectRoot: project, dataDir, env: {}, minds: [mind] });
    service = createJevyrHttpService({ runtime, env: {} }); const address = await service.listen(0, "127.0.0.1"); client = new JevyrClient({ baseUrl: address.url });
    const receipt = await client.cast({ case: { impulse: "Existing tests must pass.", seed: "original-installed-held-fixture", privacy: "local_only", control: "sovereign", subjects: [{ id: "repo", kind: "directory", locator: source }] } });
    attempt.caseId = receipt.caseId;
    const authenticated = await client.waitForAuthenticatedRecord(receipt.caseId, { preferSse: false, signal: AbortSignal.timeout(180_000) });
    attempt.signerKeyId = authenticated.keyId; attempt.verdict = authenticated.payload.verdict;
    attempt.export = await exportLocalProof(client, receipt.caseId, join(directory, "proof"));
    attempt.offline = await verifyLocalProof(join(directory, "proof"), authenticated.keyId);
    const index = await client.artifactList(receipt.caseId), certificates = index.artifacts.filter(artifact => artifact.mediaType === ORIGINAL_SUBJECT_CERTIFICATE_MEDIA);
    attempt.certificates = certificates.map(({ id, digest, size }) => ({ id, digest, size }));
    assert.equal(authenticated.payload.verdict.integrity, "VALID"); assert.equal(authenticated.payload.verdict.judgment, fixture.expected);
    assert.equal(authenticated.payload.verdict.creation, "FAILED"); assert.equal(authenticated.payload.verdict.embodiment, "NOT_BUILT");
    assert.equal(certificates.length, 1); assert.equal(attempt.offline.valid, true, JSON.stringify(attempt.offline));
    assert.equal(sha256Digest(await readFile(join(source, "src/add.mjs"))), sha256Digest(fixture.source));
    attempt.passed = true;
  } catch (error) { attempt.error = error instanceof Error ? error.stack : String(error); }
  finally { if (service) await service.close(); else if (runtime) await runtime.close(); }
  await writeFile(join(root, "progress.json"), JSON.stringify({ manifestDigest: digestJson(manifest), attempts }, null, 2));
}
const after = await snapshot(), finalAssets = loadRepositoryPureProducerAssetsSync();
const unchanged = digestJson(before) === digestJson(after) && digestJson(finalAssets.descriptor) === digestJson(assets.descriptor);
const report = { protocol: "jevyr.original-subject-installed-proof-report/1", manifestDigest: digestJson(manifest), planned: fixtures.length, attempted: attempts.length,
  passed: attempts.filter(attempt => attempt.passed).length, implementationUnchanged: unchanged, implementationAfter: after, attempts };
await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
console.log(JSON.stringify({ root, passed: report.passed, planned: report.planned, implementationUnchanged: unchanged }));
assert.ok(unchanged && attempts.every(attempt => attempt.passed), "Inspect the retained report: installed original-subject lifecycle gate failed");
