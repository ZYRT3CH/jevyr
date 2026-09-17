import assert from "node:assert/strict";
import { test } from "node:test";
import { createCaseEvent, generateSigningKeyPair, signDsse } from "@jevyr/core";
import { canonicalize, digestJson, sha256Digest, METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, METABOLISM_DSSE_PAYLOAD_TYPE, assertMetabolicAllowance, type CaseEvent, type JsonValue, type MetabolicAllowance, type MetabolicReceipt, type MetabolicRedemption, type MetabolicResourceVector } from "@jevyr/protocol";
import { replayMetabolicGrants } from "../src/metabolism-replay.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const caseDigest = hash("case"), runDigest = hash("run");
const resources = (factor: number): MetabolicResourceVector => Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key => [key, factor * (key === "maxMindInvocations" ? 1 : 100)])) as unknown as MetabolicResourceVector;

/** Cryptographic replay fixtures only; these are not empirical calibration reports. */
function fixture() {
  const keys = generateSigningKeyPair();
  const calibrationDigest = hash("explicit unit calibration fixture");
  const allowanceBody = {
    protocol: "jevyr.metabolic-allowance/1", baselineSearchDigest: hash("baseline"), maximumAddedResources: resources(2), maximumQuantityPerBall: 2, maximumReceipts: 2,
    unitCostCeilings: Object.fromEntries(METABOLIC_KINDS.map(kind => [kind, resources(1)])),
    calibrationSetDigest: hash({ protocol: "jevyr.metabolic-calibration-set/1", reports: [{ kind: "Mass", digest: calibrationDigest }] }),
    calibrations: [{ kind: "Mass", digest: calibrationDigest, summaryDigest: hash("unit summary"), maximumDose: 2 }],
    signer: { keyId: keys.keyId, publicKeyPem: keys.publicKeyPem },
  };
  const allowance = { ...allowanceBody, digest: hash(allowanceBody) } as MetabolicAllowance;
  assertMetabolicAllowance(allowance);
  const descriptor = { protocol: "jevyr.policy-descriptor/1", policy: { metabolicAllowance: allowance } };
  const sign = (receipt: MetabolicReceipt): MetabolicRedemption => ({ protocol: "jevyr.metabolism-redemption/1", receipt, envelope: signDsse(METABOLISM_DSSE_PAYLOAD_TYPE, canonicalize(receipt as unknown as JsonValue), keys.privateKeyPem) });
  const receipt = (sequence: number, previous?: MetabolicReceipt): MetabolicReceipt => {
    const body = { protocol: "jevyr.metabolism-receipt/1", caseId: "case_metabolic_replay", caseDigest, runDigest, policyDigest: hash(descriptor), searchDigest: allowance.baselineSearchDigest, allowanceDigest: allowance.digest, calibrationDigest, ballId: `ball_${"a".repeat(43)}`, kind: "Mass", quantity: 1, sequence, previousReceiptDigest: previous?.digest ?? null, issuedAt: "2026-09-05T00:00:00.000Z", grant: resources(1), cumulativeGrant: resources(sequence), cumulativeQuantities: { Mass: sequence, Refraction: 0, Polarity: 0, Fission: 0, Inertia: 0 }, work: { general: 1, unfamiliarFamilies: 0, counterbelief: 0, isolatedLanes: 0, scentContinuation: 0 }, baselineUnchanged: true, verdictAuthority: "none" };
    return { ...body, digest: hash(body) } as MetabolicReceipt;
  };
  const first = receipt(1), second = receipt(2, first);
  const artifacts = new Map<string, Uint8Array>();
  const retain = (value: MetabolicRedemption) => { const bytes = Buffer.from(canonicalize(value as unknown as JsonValue)); const digest = sha256Digest(bytes); artifacts.set(digest, bytes); return digest; };
  const firstArtifact = retain(sign(first)), secondArtifact = retain(sign(second));
  const events: CaseEvent[] = [];
  const append = (kind: "grant" | "admitted", value = first, artifact = firstArtifact, identity: { caseDigest?: string; runDigest?: string } = {}) => {
    events.push(createCaseEvent({ caseDigest: identity.caseDigest ?? caseDigest, runDigest: identity.runDigest ?? runDigest, observedAt: "2026-09-05T00:00:00.000Z", stage: "diverge", actor: { id: "jevyr.bone", kind: "kernel" }, kind: "action.status", payload: { actionId: value.digest, actionType: `metabolism.${kind}`, status: "completed", summary: "Unit replay fixture", ...(kind === "grant" ? { artifactDigests: [artifact] } : {}) } }, events.length + 1, events.at(-1)?.eventDigest ?? null));
  };
  const resolve = async (digest: string) => artifacts.get(digest);
  return { allowance, descriptor, first, second, firstArtifact, secondArtifact, artifacts, events, append, resolve, retain, sign };
}

test("signed additions become available only strictly after their ordered scheduler admission", async () => {
  const f = fixture();
  f.append("grant"); f.append("grant", f.second, f.secondArtifact);
  f.append("admitted"); f.append("admitted", f.second);
  const result = await replayMetabolicGrants(f.events, f.descriptor, f.resolve);
  assert.deepEqual(result.problems, []);
  assert.equal(result.additionsAt(1).maxMindInvocations, 0);
  assert.equal(result.additionsAt(3).maxMindInvocations, 0);
  assert.equal(result.additionsAt(4).maxMindInvocations, 1);
  assert.equal(result.additionsAt(5).maxMindInvocations, 2);
  assert.deepEqual(result.additionsAt(5), resources(2));
  assert.equal(f.allowance.baselineSearchDigest, hash("baseline"));
});

test("an unadmitted signed grant cannot retroactively fund earlier execution", async () => {
  const f = fixture(); f.append("grant");
  const result = await replayMetabolicGrants(f.events, f.descriptor, f.resolve);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.admitted, []);
  assert.equal(result.additionsAt(1_000).maxForgeWallMillis, 0);
});

test("replay rejects admission before commitment, duplicate admission, reordered receipt and cross-case identity", async () => {
  for (const scenario of ["before", "duplicate", "reordered", "cross-case", "cross-run"] as const) {
    const f = fixture();
    if (scenario === "before") { f.append("admitted"); f.append("grant"); }
    else {
      f.append("grant"); f.append("grant", f.second, f.secondArtifact);
      if (scenario === "duplicate") { f.append("admitted"); f.append("admitted"); }
      if (scenario === "reordered") f.append("admitted", f.second);
      if (scenario === "cross-case") f.append("admitted", f.first, f.firstArtifact, { caseDigest: hash("foreign") });
      if (scenario === "cross-run") f.append("admitted", f.first, f.firstArtifact, { runDigest: hash("foreign") });
    }
    const result = await replayMetabolicGrants(f.events, f.descriptor, f.resolve);
    assert.ok(result.problems.length > 0, scenario);
    assert.ok(result.additionsAt(100).maxMindInvocations <= (scenario === "duplicate" ? 1 : 0), scenario);
  }
});

test("replay binds exact wrapper bytes, signature, baseline allowance, policy and case", async () => {
  for (const scenario of ["missing", "bytes", "signature", "allowance", "policy", "case", "unsigned-amendment"] as const) {
    const f = fixture();
    let artifact = f.firstArtifact;
    let descriptor: unknown = f.descriptor;
    if (scenario === "missing") f.artifacts.delete(artifact);
    if (scenario === "bytes") f.artifacts.set(artifact, Buffer.from("{}"));
    if (scenario === "signature") { const signed = structuredClone(f.sign(f.first)); signed.envelope.signatures[0]!.sig = Buffer.alloc(64).toString("base64"); artifact = f.retain(signed); }
    if (scenario === "allowance") descriptor = { protocol: "jevyr.policy-descriptor/1", policy: {} };
    if (scenario === "policy") descriptor = { ...f.descriptor, other: "substituted policy identity" };
    if (scenario === "unsigned-amendment") {
      const signed = structuredClone(f.sign(f.first));
      const { digest: _, ...body } = { ...signed.receipt, grant: resources(2), cumulativeGrant: resources(2) };
      (signed as { receipt: MetabolicReceipt }).receipt = { ...body, digest: hash(body) };
      artifact = f.retain(signed);
    }
    f.append("grant", f.first, artifact, scenario === "case" ? { caseDigest: hash("foreign") } : {});
    f.append("admitted");
    const result = await replayMetabolicGrants(f.events, descriptor, f.resolve);
    assert.ok(result.problems.length > 0, scenario);
    assert.equal(result.additionsAt(100).maxMindInvocations, 0, scenario);
  }
});
