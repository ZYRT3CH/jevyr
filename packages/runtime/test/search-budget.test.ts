import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mindInvocationOutputReservation,
  mindResourceEnvelopeForInvocations,
  SealedMindBudget,
} from "../src/index.js";

function envelope() {
  return {
    maxMindInvocations: 3,
    maxInputTokens: 100,
    maxOutputTokens: 50,
    maxWallMillis: 1_000,
    maxSingleInvocationMillis: 400,
    maxGeneratedBytes: 80,
    maxForgeCpuMillis: 0,
    maxForgeWallMillis: 0,
    maxMemorySeconds: 0,
    maxWritableBytes: 0,
    maxWritableInodes: 0,
    maxArtifactBytes: 0,
    maxNetworkBytes: 0,
    concurrentLineages: 1,
    maxTotalAssayCost: 0,
  };
}

test("one meter monotonically partitions a sealed Mind envelope", () => {
  const budget = new SealedMindBudget(envelope());
  assert.equal(budget.refusal(60), undefined);
  assert.equal(budget.charge({
    contributions: [],
    tokenUsage: {
      input: { tokens: 60, measurement: "UPPER_BOUND" },
      output: { tokens: 20, measurement: "MEASURED" },
    },
    transmittedInputBytes: 60,
    receivedOutputBytes: 25,
  }, 100), true);
  assert.deepEqual(budget.remaining(), {
    maxMindInvocations: 2,
    maxInputTokens: 40,
    maxOutputTokens: 30,
    maxWallMillis: 900,
    maxGeneratedBytes: 55,
    maxSingleInvocationMillis: 400,
  });
  assert.match(budget.refusal(41) ?? "", /exceeds 40/u);
  assert.equal(budget.snapshot().inputTokenMeasurement, "UPPER_BOUND");
});

test("nursery usage is absorbed rather than receiving a second budget", () => {
  const budget = new SealedMindBudget(envelope());
  budget.chargeFailure(10, 5, 50);
  budget.absorbNursery({
    mindInvocations: 2,
    inputTokens: 20,
    outputTokens: 10,
    inputTokenMeasurement: "MEASURED",
    outputTokenMeasurement: "MEASURED",
    wallMillis: 100,
    generatedBytes: 12,
  });
  assert.equal(budget.remaining().maxMindInvocations, 0);
  assert.match(budget.refusal(1) ?? "", /invocation budget is exhausted/u);
  assert.equal(budget.snapshot().outputTokenMeasurement, "UPPER_BOUND");
});

test("per-invocation output permission is a fair share of the remaining Case budget", () => {
  const budget = new SealedMindBudget(envelope());
  assert.equal(mindInvocationOutputReservation(budget.remaining()), 17);
  budget.chargeFailure(10, 17, 50);
  assert.equal(budget.remaining().maxOutputTokens, 33);
  assert.equal(budget.remaining().maxMindInvocations, 2);
  assert.equal(mindInvocationOutputReservation(budget.remaining()), 17);
});

test("a successful call crossing its reservation is rejected but its actual usage remains charged", () => {
  const budget = new SealedMindBudget(envelope());
  const admitted = budget.charge({
    contributions: [],
    tokenUsage: {
      input: { tokens: 1, measurement: "MEASURED" },
      output: { tokens: 18, measurement: "MEASURED" },
    },
    transmittedInputBytes: 1,
    receivedOutputBytes: 18,
  }, 1, 17);
  assert.equal(admitted, false);
  assert.equal(budget.snapshot().outputTokens, 18);
  assert.equal(budget.remaining().maxOutputTokens, 32);
});

test("a nursery sub-envelope reserves the proportional complement for later Mind stages", () => {
  const allocation = mindResourceEnvelopeForInvocations({
    maxMindInvocations: 11,
    maxInputTokens: 101,
    maxOutputTokens: 50,
    maxWallMillis: 1_001,
    maxGeneratedBytes: 80,
    maxSingleInvocationMillis: 400,
  }, 8);
  assert.deepEqual(allocation, {
    maxMindInvocations: 8,
    maxInputTokens: 73,
    maxOutputTokens: 36,
    maxWallMillis: 728,
    maxGeneratedBytes: 58,
    maxSingleInvocationMillis: 400,
  });
  assert.ok(allocation.maxInputTokens <= 101);
  assert.ok(allocation.maxOutputTokens <= 50);
  assert.ok(allocation.maxWallMillis <= 1_001);
  assert.ok(allocation.maxGeneratedBytes <= 80);
  assert.throws(() => mindResourceEnvelopeForInvocations({ ...allocation, maxMindInvocations: 1 }, 2));
});
