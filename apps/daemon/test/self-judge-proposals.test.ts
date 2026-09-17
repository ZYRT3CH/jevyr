import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { GenomeRegistry, compileGenomeRuntimeProfile, genomePromotionPayload } from "@jevyr/growth";
import { canonicalize, digestJson, type JsonValue } from "@jevyr/protocol";
import { createSelfJudgeProposalRecorder } from "../src/self-judge-proposals.js";
import { readSelfJudgeRequests } from "../src/self-judge-inspection.js";

const hash = (value: string) => digestJson(value);
const source = { manifestDigest: hash("snapshot"), caseId: "case_0123456789abcdef", runDigest: hash("run"), recordDigest: hash("record"), failures: [{ code: "VERIFIED_DEFECT", evidenceDigest: hash("executed-observation") }] };
async function fixture(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-self-proposal-test-"));
  try { await body(root); }
  finally { const rel = relative(resolve(tmpdir()), resolve(root)); assert.ok(rel.startsWith("jevyr-self-proposal-test-") && !rel.includes(sep)); await rm(root, { recursive: true, force: true }); }
}

test("static baseline failure creates an explicit ungoverned request without inventing a parent or promotion", async () => fixture(async root => {
  const record = createSelfJudgeProposalRecorder({ registryRoot: root, boneDigest: hash("bone"), sourceGenomeDigest: hash("static-startup-descriptor") });
  const request = await record(source), registry = new GenomeRegistry(root);
  assert.equal(request.decision, "REQUESTED_NO_GOVERNED_PARENT"); assert.equal(request.parentGenomeDigest, null); assert.equal(request.growthProposalDigest, null);
  assert.equal(request.governanceSignature, null); assert.equal(request.activeGenomeChanged, false); assert.deepEqual(request.benchmarkEvidence, []);
  const candidate = await registry.readGenome(request.candidateGenomeDigest);
  assert.equal(candidate.body.generation, 0); assert.deepEqual(candidate.body.parentDigests, []); assert.equal(candidate.body.modules.length, 3);
  assert.equal(compileGenomeRuntimeProfile(candidate, { expectedBoneDigest: hash("bone") }).boneDigest, hash("bone"));
  assert.deepEqual(await registry.listProposals(), []); assert.deepEqual(await readdir(join(root, "promotions")), []); assert.deepEqual(await readdir(join(root, "pointers")), []);
  const { digest, ...body } = request; assert.equal(digestJson(body as unknown as JsonValue), digest);
  assert.equal(await readFile(join(root, "self-judge-requests", `${digest.slice(7)}.json`), "utf8"), canonicalize(request as unknown as JsonValue));
  assert.equal(request.source.recordDigest, source.recordDigest);
  assert.deepEqual(await readSelfJudgeRequests(root), { requests: [request], truncated: false });
}));

test("a governed parent produces an immutable rejected descendant with a real source intake and no fabricated benchmarks", async () => fixture(async root => {
  const baseline = await createSelfJudgeProposalRecorder({ registryRoot: root, boneDigest: hash("bone"), sourceGenomeDigest: hash("static") })(source);
  const registry = new GenomeRegistry(root), parent = await registry.readGenome(baseline.candidateGenomeDigest), original = canonicalize(parent as unknown as JsonValue);
  const record = createSelfJudgeProposalRecorder({ registryRoot: root, boneDigest: hash("bone"), sourceGenomeDigest: parent.digest, activeGenome: parent });
  const [request, repeated] = await Promise.all([record(source), record(source)]);
  assert.equal(request.digest, repeated.digest); assert.equal(request.decision, "REJECTED_PENDING_BENCHMARKS");
  const proposal = await registry.readProposal(request.growthProposalDigest!);
  assert.equal(proposal.decision, "REJECTED"); assert.equal(proposal.novelty, 0); assert.deepEqual(proposal.benchmarkEvidence, []); assert.deepEqual(proposal.damageEvidence, []);
  assert.ok(proposal.reasons.some(reason => reason.includes("benchmark"))); assert.throws(() => genomePromotionPayload(proposal), /rejected/);
  assert.equal(compileGenomeRuntimeProfile(proposal.descendant, { expectedBoneDigest: hash("bone") }).nursery.challengeInterval, 7);
  assert.equal(canonicalize(parent as unknown as JsonValue), original); assert.equal(canonicalize(await registry.readGenome(parent.digest) as unknown as JsonValue), original);
  assert.deepEqual(await readdir(join(root, "promotions")), []); assert.deepEqual(await readdir(join(root, "pointers")), []);
}));

test("proposal intake validates source identity and refuses content-address collisions", async () => fixture(async root => {
  const record = createSelfJudgeProposalRecorder({ registryRoot: root, boneDigest: hash("bone"), sourceGenomeDigest: hash("static") });
  assert.throws(() => record({ ...source, recordDigest: "unverified" }), /bounded verified/);
  assert.throws(() => record({ ...source, failures: [] }), /bounded verified/);
  assert.throws(() => record({ ...source, failures: [...source.failures, ...source.failures] }), /unique/);
  const request = await record(source);
  await writeFile(join(root, "self-judge-requests", `${request.digest.slice(7)}.json`), "{}");
  await assert.rejects(record(source), /content address/);
  await assert.rejects(readSelfJudgeRequests(root), /content-address/);
  assert.equal(await readFile(join(root, "self-judge-requests", `${request.digest.slice(7)}.json`), "utf8"), "{}");
}));
