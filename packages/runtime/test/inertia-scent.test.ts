import assert from "node:assert/strict";
import test from "node:test";
import { digestJson, METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, METABOLIC_WORK_KEYS, type JsonValue, type MetabolicReceipt } from "@jevyr/protocol";
import { INERTIA_SCENT_POLICY, assessEvidenceScents, assertInertiaContinuationDecision, maximumInertiaQuantity, planInertiaContinuation, type ScentObservation } from "../src/inertia-scent.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const critical = ["obl_critical"];
function history(candidate: string, count: number, patch: Partial<ScentObservation> = {}): ScentObservation[] { return Array.from({ length: count }, (_, index) => ({ candidateId: candidate, observationDigest: hash({ candidate, index }), assayId: "sealed.node", obligationId: critical[0], status: "FAILED" as const, decisive: true, costUnits: 1, ...patch })); }
function receipt(quantity: number, prior = 0): MetabolicReceipt {
  const resources = (dose: number) => Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key => [key, dose]));
  const body = { protocol: "jevyr.metabolism-receipt/1", caseId: "case_0123456789abcdef", caseDigest: hash("case"), runDigest: hash("run"), policyDigest: hash("policy"), searchDigest: hash("search"), allowanceDigest: hash("allowance"), calibrationDigest: hash("calibration"), ballId: `ball_${"a".repeat(43)}`, kind: "Inertia", quantity, sequence: prior === 0 ? 1 : 2, previousReceiptDigest: prior === 0 ? null : hash("previous"), issuedAt: "2026-09-05T00:00:00.000Z", grant: resources(quantity), cumulativeGrant: resources(quantity + prior), cumulativeQuantities: Object.fromEntries(METABOLIC_KINDS.map(kind => [kind, kind === "Inertia" ? quantity + prior : 0])), work: Object.fromEntries(METABOLIC_WORK_KEYS.map(key => [key, key === "scentContinuation" ? quantity : 0])), baselineUnchanged: true, verdictAuthority: "none" };
  return { ...body, digest: hash(body) } as MetabolicReceipt;
}

test("physical repeated failures reduce continuation value while initial critical failures retain baseline eligibility", () => {
  const initial = assessEvidenceScents(history("candidate-a", 1), critical)[0]!;
  assert.equal(initial.valuePerCost, 1); assert.ok(initial.valuePerCost >= INERTIA_SCENT_POLICY.baselineThreshold);
  const repeated = assessEvidenceScents(history("candidate-a", 4), critical)[0]!;
  assert.equal(repeated.valuePerCost, 0.4); assert.ok(repeated.valuePerCost < INERTIA_SCENT_POLICY.baselineThreshold);
  assert.equal(assessEvidenceScents(history("candidate-a", 1, { costUnits: 4 }), critical)[0]!.valuePerCost, 0.25);
});

test("additional doses lower an actual threshold and select distinct below-baseline physical scents monotonically", () => {
  const observations = [...history("candidate-a", 4), ...history("candidate-b", 8)]; const original = hash(observations);
  assert.equal(maximumInertiaQuantity(observations, critical, 0, 2), 2);
  const one = planInertiaContinuation(receipt(1), observations, critical), two = planInertiaContinuation(receipt(2), observations, critical);
  assert.equal(one.loweredThreshold, 0.25); assert.equal(two.loweredThreshold, 1 / 6); assert.equal(one.baselineThreshold, two.baselineThreshold);
  assert.deepEqual(one.selected.map(value => value.candidateId), ["candidate-a"]); assert.deepEqual(two.selected.map(value => value.candidateId), ["candidate-a", "candidate-b"]);
  assert.equal(two.baselineUnchanged, true); assert.equal(two.verdictAuthority, "none"); assert.equal(two.measurement, "HEURISTIC"); assert.equal(hash(observations), original);
  assertInertiaContinuationDecision(two, receipt(2), observations, critical);
});

test("resolved, blocked-only, noncritical and high-value baseline work cannot be sold as Inertia", () => {
  for (const observations of [history("a", 1), history("a", 4, { status: "PASSED" }), history("a", 4, { status: "BLOCKED" }), history("a", 4, { obligationId: "not-critical" })]) {
    assert.equal(maximumInertiaQuantity(observations, critical, 0, 2), 0);
    assert.throws(() => planInertiaContinuation(receipt(1), observations, critical), /below-threshold/);
  }
  assert.throws(() => planInertiaContinuation(receipt(2), history("a", 4), critical), /below-threshold/);
});

test("observation replay cannot manufacture repeated failed attempts and stale decision tampering is detected", () => {
  const observation = history("a", 1)[0]!;
  assert.equal(assessEvidenceScents([observation, observation, observation], critical)[0]!.executedObservations, 1);
  assert.throws(() => assessEvidenceScents([observation, { ...observation, candidateId: "another" }], critical), /inconsistent bindings/);
  const observations = history("a", 4), grant = receipt(1), decision = planInertiaContinuation(grant, observations, critical);
  assert.throws(() => assertInertiaContinuationDecision({ ...decision, loweredThreshold: 0 }, grant, observations, critical), /differs/);
  assert.throws(() => assertInertiaContinuationDecision(decision, grant, history("a", 3), critical), /below-threshold/);
  assert.throws(() => maximumInertiaQuantity(observations, critical, 0, Infinity), /bounded/);
});

test("a later signed dose uses its cumulative threshold and cannot sell an already selected candidate again", () => {
  const observations = [...history("a", 4), ...history("b", 8)];
  assert.equal(maximumInertiaQuantity(observations, critical, 1, 1, ["a"]), 1);
  const decision = planInertiaContinuation(receipt(1, 1), observations, critical, ["a"]);
  assert.deepEqual(decision.selected.map(value => value.candidateId), ["b"]); assert.equal(decision.loweredThreshold, 1 / 6);
  assert.equal(maximumInertiaQuantity(observations, critical, 2, 2, ["a", "b"]), 0);
});
