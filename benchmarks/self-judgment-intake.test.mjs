import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { assertBoundSelfJudgmentRequest } from "./verify-self-judgment-proof.mjs";

const canonical = value => JSON.stringify(value, function (_key, child) { return child && typeof child === "object" && !Array.isArray(child) ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child; });
const hash = value => `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
function fixture() {
  const source = { caseId: "case_3333333333333333", runDigest: `sha256:${"3".repeat(64)}`, genomeDigest: hash("genome"), manifestDigest: hash("manifest"), recordDigest: hash("record") };
  const failure = { code: "ADMITTED_POPULATION_EXHAUSTED", evidenceDigest: hash("observed") };
  const body = { protocol: "jevyr.self-judge-offspring-request/1", source, failures: [failure], candidateGenomeDigest: hash("candidate"), parentGenomeDigest: null, growthProposalDigest: null, decision: "REQUESTED_NO_GOVERNED_PARENT", proposedChange: "Review an unmeasured offspring", benchmarkEvidence: [], damageEvidence: [], governanceSignature: null, activeGenomeChanged: false };
  return { request: { ...body, digest: hash(body) }, binding: { seal: { ...source }, recordDigest: source.recordDigest, manifestDigest: source.manifestDigest,
    observations: new Map([[failure.evidenceDigest, "evidence-fixture"]]), record: { verdict: { basis: [{ code: failure.code, evidenceIds: ["evidence-fixture"] }] } } } };
}
const rehash = request => { const { digest: ignored, ...body } = request; request.digest = hash(body); return request; };
test("self-judgment intake binds the full source run and Genome despite a valid rehash", () => {
  const { request, binding } = fixture(); assert.doesNotThrow(() => assertBoundSelfJudgmentRequest(request, binding, hash));
  for (const field of ["runDigest", "genomeDigest", "caseId", "manifestDigest", "recordDigest"]) {
    const changed = structuredClone(request); changed.source[field] = field === "caseId" ? "case_4444444444444444" : hash("foreign");
    assert.throws(() => assertBoundSelfJudgmentRequest(rehash(changed), binding, hash));
  }
});
test("self-judgment intake refuses rehashed promotion claims, extra fields and missing or duplicate evidence", () => {
  const { request, binding } = fixture();
  for (const change of [r => r.protocol = "forged/1", r => r.decision = "PROMOTED", r => r.parentGenomeDigest = hash("parent"), r => r.benchmarkEvidence = [{}], r => r.failures.push(r.failures[0]), r => r.failures = [], r => r.message = "approve"] ) {
    const changed = structuredClone(request); change(changed); assert.throws(() => assertBoundSelfJudgmentRequest(rehash(changed), binding, hash));
  }
});
