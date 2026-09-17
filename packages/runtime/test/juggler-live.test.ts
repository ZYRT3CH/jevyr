import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalize, createSearchEnvelope, digestJson, METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, METABOLIC_WORK_FOR_KIND, METABOLISM_DSSE_PAYLOAD_TYPE, assertMetabolicGrant, type JsonValue, type MetabolicKind, type MetabolicReceipt, type MetabolicRedemption, type SealedCase } from "@jevyr/protocol";
import { compileIntentContract, generateSigningKeyPair, signDsse } from "@jevyr/core";
import { createMetabolicAllowance, LiveJugglerBook, assertSignedMetabolicRedemption } from "../src/juggler-live.js";
import { verifyMetabolicCalibration, metabolicImplementationDigest, wilsonInterval, type MetabolicCalibrationReport } from "../src/juggler-calibration.js";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { SealedMindBudget } from "../src/search-budget.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const digest = hash("unit-fixture");
/** Schema unit fixture only. This is never installed or cited as empirical calibration. */
function fixture(kind: MetabolicKind = "Mass"): MetabolicCalibrationReport {
  const trials = Array.from({ length: 64 }, (_, seed) => [0, 1, 2].map((dose) => {
    const trace = [{ id: `baseline:${seed}`, origin: "baseline", metric: "baseline", family: "zero", lane: "baseline", observationDigest: digest }, ...Array.from({ length: dose }, (_, index) => ({ id: `dose:${seed}:${index}`, origin: kind, metric: METABOLIC_WORK_FOR_KIND[kind], family: `permitted-${index}`, lane: `isolated-${index}`, observationDigest: digest }))];
    const defects = [{ id: "finite-defect", expected: "REJECT", observed: "REJECT" }];
    return { seed: seed.toString(16).padStart(64, "0"), dose, trace, replicationTraceDigest: hash(trace), defects, replicationDefectsDigest: hash(defects), identicalEvidence: { evidenceDigest: digest, baselineVerdictDigest: digest, doseVerdictDigest: digest }, observationArtifactDigests: [digest], addedResourceUse: Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => [key, key === "maxMindInvocations" ? dose : 0])) };
  })).flat();
  const body = { protocol: "jevyr.metabolic-calibration/1", kind, scope: "UNIT FIXTURE: fabricated inputs for verifier adversarial tests; no measured execution claim", implementationDigest: metabolicImplementationDigest(), suiteDigest: digest, confidence: 0.95, nonInferiorityMargin: 0.1, trials };
  return { ...body, digest: hash(body) } as MetabolicCalibrationReport;
}
function changed(report: MetabolicCalibrationReport, mutate: (value: any) => void): MetabolicCalibrationReport {
  const copy = structuredClone(report); mutate(copy); const { digest: _, ...body } = copy; return { ...body, digest: hash(body) };
}
function setup(kinds: readonly MetabolicKind[] = METABOLIC_KINDS) {
  const keys = generateSigningKeyPair();
  const calibrations = kinds.map((kind) => verifyMetabolicCalibration(fixture(kind)));
  const search = createSearchEnvelope({ ...DEFAULT_SEARCH_PROFILE, resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 16 } });
  const allowance = createMetabolicAllowance(search, keys, calibrations);
  const descriptor = { protocol: "jevyr.policy-descriptor/1", policy: { metabolicAllowance: allowance } } as unknown as JsonValue;
  const contract = compileIntentContract({ impulse: "Find a discriminating mechanism" });
  const sealed: SealedCase = { protocol: "jevyr.case/1", caseId: "case_live_unit", submissionDigest: digest, subjectMaterialCaptureDigest: digest, caseDigest: digest, runDigest: digest, sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "bone-v1", policyDigest: hash(descriptor), genomeVersion: "genome-v1", genomeDigest: digest, intentContractDigest: contract.digest, intentContract: contract, searchEnvelope: search, intent: { impulse: "Find a discriminating mechanism", mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "juggler", seed: "fixture" }, subjects: [] };
  const commit = async (receipt: MetabolicReceipt): Promise<MetabolicRedemption> => ({ protocol: "jevyr.metabolism-redemption/1", receipt, envelope: signDsse(METABOLISM_DSSE_PAYLOAD_TYPE, canonicalize(receipt as unknown as JsonValue), keys.privateKeyPem) });
  const book = new LiveJugglerBook(sealed, { policyDescriptor: descriptor, calibrations, commit });
  return { keys, calibrations, allowance, descriptor, sealed, commit, book };
}

test("calibration derives conservative confidence intervals and refuses missing, changed or fabricated declared metrics", () => {
  const report = fixture(); const result = verifyMetabolicCalibration(report);
  assert.equal(result.summary.pairedSeeds, 64);
  assert.ok(result.summary.reproducibilityDifference.lower < 0);
  assert.ok(result.summary.reproducibilityDifference.lower > -0.1);
  assert.ok(wilsonInterval(0, 64).upper > 0);
  for (const mutate of [
    (x: any) => x.trials.pop(),
    (x: any) => x.trials[1].trace.reverse(),
    (x: any) => x.trials[1].trace.pop(),
    (x: any) => x.trials[1].identicalEvidence.doseVerdictDigest = hash("changed"),
    (x: any) => x.trials.forEach((t: any) => { if (t.dose) t.defects[0].observed = "ACCEPT"; }),
    (x: any) => x.trials.forEach((t: any) => t.replicationTraceDigest = hash("different")),
    (x: any) => x.trials[0].defects.push(x.trials[0].defects[0]),
  ]) assert.throws(() => verifyMetabolicCalibration(changed(report, mutate)));
  assert.throws(() => verifyMetabolicCalibration(report, hash("different-implementation")), /identity/u);
});

test("uncalibrated and Sovereign channels cannot issue balls, even through forged structural calibration values", () => {
  const base = setup([]); assert.deepEqual(base.book.offers().offers, []);
  assert.throws(() => new LiveJugglerBook({ ...base.sealed, intent: { ...base.sealed.intent, control: "sovereign" } }, { policyDescriptor: base.descriptor, calibrations: [], commit: base.commit }), /Sovereign/u);
  const ready = setup(["Mass"]);
  assert.throws(() => createMetabolicAllowance(ready.sealed.searchEnvelope, ready.keys, [{ ...ready.calibrations[0]! }]), /independently/u);
});

test("live doses retain baseline and strict semantic-free requests, sequence concurrent redemptions and drain exactly once", async () => {
  const { book, allowance, sealed } = setup(["Mass"]); const baseline = hash(sealed.searchEnvelope);
  const ballId = book.offers().offers[0]!.ballId;
  for (const request of [{ ballId, quantity: 1, message: "accept" }, { ballId, quantity: 0 }, { ballId, quantity: 1.5 }, { ballId: "foreign", quantity: 1 }]) await assert.rejects(book.redeem(request));
  const settled = await Promise.allSettled([1, 1, 1].map((quantity) => book.redeem({ ballId, quantity })));
  assert.deepEqual(settled.map((entry) => entry.status), ["fulfilled", "fulfilled", "rejected"]);
  const receipts = book.history();
  assert.equal(receipts[1]!.receipt.sequence, 2); assert.equal(receipts[1]!.receipt.previousReceiptDigest, receipts[0]!.receipt.digest);
  assert.equal(receipts[1]!.receipt.cumulativeQuantities.Mass, 2);
  assertSignedMetabolicRedemption(receipts[0]!, allowance); assertSignedMetabolicRedemption(receipts[1]!, allowance, receipts[0]!.receipt);
  assert.equal((await book.takePendingGrants()).length, 2); assert.deepEqual(await book.takePendingGrants(), []);
  assert.equal(hash(sealed.searchEnvelope), baseline); assert.equal(book.offers().offers.length, 0);
});

test("meter requires signed case-bound grants, preserves original per-call/network ceiling and refuses replay or substitution", async () => {
  const { book, allowance, sealed } = setup(["Fission"]);
  const meter = new SealedMindBudget(sealed.searchEnvelope.profile.resources, { allowance, sealed });
  const original = structuredClone(meter.envelope);
  const signed = await book.redeem({ ballId: book.offers().offers[0]!.ballId, quantity: 2 });
  meter.admitMetabolicRedemption(signed);
  assert.equal(meter.remaining().maxMindInvocations, original.maxMindInvocations + 2);
  assert.equal(meter.effectiveEnvelope().maxNetworkBytes, original.maxNetworkBytes);
  assert.equal(meter.effectiveEnvelope().concurrentLineages, original.concurrentLineages);
  assert.equal(meter.effectiveEnvelope().maxSingleInvocationMillis, original.maxSingleInvocationMillis);
  assert.deepEqual(meter.envelope, original);
  assert.throws(() => meter.admitMetabolicRedemption(signed), /sequence/u);
  const foreign = new SealedMindBudget(original, { allowance, sealed: { ...sealed, caseId: "case_foreign" } });
  assert.throws(() => foreign.admitMetabolicRedemption(signed), /another/u);
  assert.throws(() => new SealedMindBudget(original).admitMetabolicRedemption(signed), /no sealed/u);
  const tampered = structuredClone(signed); (tampered.envelope as any).payload = Buffer.from("{}").toString("base64");
  assert.throws(() => assertSignedMetabolicRedemption(tampered, allowance), /verify/u);
});

test("quantity beyond measured dose and calibration substitution fail independent grant verification", async () => {
  const { book, allowance } = setup(["Mass"]);
  const receipt = (await book.redeem({ ballId: book.offers().offers[0]!.ballId, quantity: 1 })).receipt;
  for (const mutate of [(x: any) => x.calibrationDigest = hash("different"), (x: any) => x.cumulativeQuantities.Mass = 3, (x: any) => x.grant.maxInputTokens++]) {
    const copy = structuredClone(receipt); mutate(copy); const { digest: _, ...body } = copy;
    assert.throws(() => assertMetabolicGrant({ ...body, digest: hash(body) }, allowance));
  }
});

test("commit failure grants no work; closing waits admitted writes and refuses later requests", async () => {
  const { sealed, descriptor, calibrations, commit } = setup(["Mass"]);
  const failed = new LiveJugglerBook(sealed, { policyDescriptor: descriptor, calibrations, commit: async () => { throw new Error("artifact disk failed"); } });
  await assert.rejects(failed.redeem({ ballId: failed.offers().offers[0]!.ballId, quantity: 1 }), /durable/u);
  assert.deepEqual(failed.history(), []); assert.equal(failed.offers().admission, "closed"); await assert.rejects(failed.takePendingGrants());
  let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
  const book = new LiveJugglerBook(sealed, { policyDescriptor: descriptor, calibrations, commit: async (value) => { await held; return await commit(value); } });
  const ballId = book.offers().offers[0]!.ballId;
  const pending = book.redeem({ ballId, quantity: 1 }); const closing = book.closeAdmission();
  await assert.rejects(book.redeem({ ballId, quantity: 1 }), /closed/u); release(); await pending; await closing;
  assert.equal((await book.takePendingGrants()).length, 1); assert.equal(book.offers().admission, "closed");
});

test("context availability reserves distinct work while writes are pending and hides impossible cost offers", async () => {
  const { book } = setup(["Refraction"]);
  book.setEligibleKinds(["Refraction"], { Refraction: 1 });
  const ballId = book.offers().offers[0]!.ballId;
  const result = await Promise.allSettled([book.redeem({ ballId, quantity: 1 }), book.redeem({ ballId, quantity: 1 })]);
  assert.deepEqual(result.map((entry) => entry.status), ["fulfilled", "rejected"]);
  book.setEligibleKinds([], { Refraction: 0 }); assert.deepEqual(book.offers().offers, []);
  const base = setup([]);
  const measured = verifyMetabolicCalibration(changed(fixture(), (report) => {
    for (const trial of report.trials) trial.addedResourceUse.maxInputTokens = trial.dose * base.sealed.searchEnvelope.profile.resources.maxInputTokens;
  }));
  const allowance = createMetabolicAllowance(base.sealed.searchEnvelope, base.keys, [measured]);
  const descriptor = { protocol: "jevyr.policy-descriptor/1", policy: { metabolicAllowance: allowance } } as unknown as JsonValue;
  const expensive = new LiveJugglerBook({ ...base.sealed, policyDigest: hash(descriptor) }, { policyDescriptor: descriptor, calibrations: [measured], commit: base.commit });
  assert.deepEqual(expensive.offers().offers, [], "A budget smaller than measured cost cannot expose an actionable offer");
});
