import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { canonicalize, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { compileAssayFrontier } from "../src/assay-frontier.js";
import { selectBaselineRevision, type BaselineRevisionInput } from "../src/baseline-revision.js";
import { compileExperimentCapability, evaluateComparativeExperiment } from "../src/experiment-capability.js";
import { maximumInertiaQuantity } from "../src/inertia-scent.js";
import type { FeedbackInput } from "../src/revision-investigation.js";
import { evaluateForgeOracle } from "../src/typed-oracles.js";

const resources = { maxMindInvocations: 8, maxInputTokens: 100_000, maxOutputTokens: 100_000, maxWallMillis: 60_000, maxSingleInvocationMillis: 20_000,
  maxGeneratedBytes: 1_000_000, maxForgeCpuMillis: 60_000, maxForgeWallMillis: 60_000, maxMemorySeconds: 30, maxWritableBytes: 1_000_000,
  maxWritableInodes: 100, maxArtifactBytes: 5_000_000, maxNetworkBytes: 0, concurrentLineages: 1, maxTotalAssayCost: 100 };
function fixture(costUnits = 1) {
  const contract = compileIntentContract({ impulse: "`node original.mjs` exits with code 0" });
  const obligation = contract.criticalObligations[0]!;
  const frontier = compileAssayFrontier([
    { assayId: "source", tool: "forge.command", args: { command: "node", args: ["original.mjs"] }, costUnits: 1, obligationId: obligation.id },
    { assayId: "probe", tool: "forge.command", args: { command: "node", args: ["checks/probe.mjs"] }, costUnits },
  ], resources);
  const capability = compileExperimentCapability(frontier, contract), experiment = capability.experiments.find(item => item.assayId === "probe")!;
  assert.equal(experiment.authority, "comparative-only");
  const cell = (candidateId: string, assayId: "source" | "probe", exitCode: number, ordinal = 1): FeedbackInput => {
    const observation = { invocationId: `${candidateId}-${assayId}-${ordinal}`, status: exitCode === 0 ? "succeeded" as const : "failed" as const, summary: "Fixture-bound process exit",
      startedAt: "2026-09-05T00:00:00.000Z", finishedAt: "2026-09-05T00:00:01.000Z",
      oracle: { execution: { state: "exited" as const, mode: "docker" as const, command: "node", args: [assayId === "probe" ? "checks/probe.mjs" : "original.mjs"], shell: false, exitCode } } };
    const evaluation = assayId === "probe" ? evaluateComparativeExperiment(experiment, observation.oracle)
      : evaluateForgeOracle(obligation, { tool: "forge.command", obligationId: obligation.id, command: "node", args: ["original.mjs"], shell: false }, observation.oracle);
    return { candidateId, assayId, observationDigest: sha256Digest(canonicalize(observation)), observation, evaluation, admissible: true, costUnits: assayId === "probe" ? costUnits : 1 };
  };
  const choose = (inputs: readonly FeedbackInput[], patch: Partial<BaselineRevisionInput> = {}) => selectBaselineRevision({ inputs, contract, frontier, candidateIds: ["parent"], policyVersion: "observed-comparative-repair", ...patch });
  return { contract, frontier, cell, choose };
}

test("new baseline repairs an actual failed comparative socket despite complete critical support; legacy stops", () => {
  const f = fixture(), inputs = [f.cell("parent", "source", 0), f.cell("parent", "probe", 1)];
  assert.equal(f.contract.criticalObligations.length, 1);
  assert.equal(inputs[0]!.evaluation?.status, "PASSED", JSON.stringify(inputs[0]!.evaluation));
  const original = canonicalize(inputs as unknown as JsonValue);
  assert.deepEqual(f.choose(inputs), { candidateId: "parent", assayId: "probe", purpose: "comparative-socket-failure", observationDigests: [inputs[1]!.observationDigest], valuePerCost: 1, verdictAuthority: "none" });
  assert.equal(f.choose(inputs, { policyVersion: "legacy-critical-only" }), undefined);
  assert.equal(f.choose(inputs, { policyVersion: undefined }), undefined);
  assert.equal(canonicalize(inputs as unknown as JsonValue), original, "method choice cannot rewrite truth or observations");
});

test("unresolved critical failure keeps baseline priority without relabeling comparative evidence", () => {
  const f = fixture(), inputs = [f.cell("parent", "probe", 1), f.cell("parent", "source", 9)];
  for (const policyVersion of ["legacy-critical-only", "observed-comparative-repair"] as const) {
    assert.equal(f.choose(inputs, { policyVersion })?.purpose, "critical-failure");
  }
});

test("later pass or inadmissible/blocked state supersedes an earlier comparative failure", () => {
  const f = fixture(), source = f.cell("parent", "source", 0), failed = f.cell("parent", "probe", 1);
  assert.equal(f.choose([source, failed, f.cell("parent", "probe", 0, 2)]), undefined);
  assert.equal(f.choose([source, failed, { ...f.cell("parent", "probe", 1, 2), admissible: false }]), undefined);
  assert.equal(f.choose([source, { ...failed, observation: { ...failed.observation, oracle: { execution: { state: "timed-out", mode: "docker" } } } }]), undefined);
  assert.equal(f.choose([source, { ...failed, evaluation: { ...failed.evaluation!, decisive: false } }]), undefined);
});

test("comparative repair requires the exact sealed argv, evaluation, cost and real nonzero exit", () => {
  const f = fixture(), source = f.cell("parent", "source", 0), failed = f.cell("parent", "probe", 1);
  for (const changed of [
    { ...failed, assayId: "unsealed" }, { ...failed, costUnits: 0 }, { ...failed, admissible: false },
    { ...failed, evaluation: { ...failed.evaluation!, obligationId: "claimed-comparative" } },
    { ...failed, observation: { ...failed.observation, oracle: { execution: { ...failed.observation.oracle!.execution, args: ["other.mjs"] } } } },
    { ...failed, observation: { ...failed.observation, oracle: { execution: { ...failed.observation.oracle!.execution, shell: true } } } },
    { ...failed, observation: { ...failed.observation, oracle: { execution: { ...failed.observation.oracle!.execution, exitCode: 0 } } } },
  ]) assert.equal(f.choose([source, changed]), undefined);
  const invalid = compileAssayFrontier([{ assayId: "probe", tool: "forge.command", args: { command: "node", args: ["checks/probe.mjs"] }, costUnits: 1, obligationId: `obl_${"f".repeat(20)}` }], resources);
  assert.equal(f.choose([source, failed], { frontier: invalid }), undefined, "invalid explicit binding cannot become comparative");
});

test("sealed cost and repeated physical attempts bound comparative continuation; duplicates do not mint work", () => {
  const expensive = fixture(3);
  assert.equal(expensive.choose([expensive.cell("parent", "source", 0), expensive.cell("parent", "probe", 1)]), undefined);
  const f = fixture(), source = f.cell("parent", "source", 0), failed = f.cell("parent", "probe", 1);
  assert.equal(f.choose([source, failed, failed])?.observationDigests.length, 1);
  assert.equal(f.choose([source, ...[1,2,3].map(ordinal => f.cell("parent", "probe", 1, ordinal))])?.valuePerCost, 0.5);
  assert.equal(f.choose([source, ...[1,2,3,4].map(ordinal => f.cell("parent", "probe", 1, ordinal))]), undefined);
});

test("only committed parents and then the latest revision child qualify; ties are deterministic", () => {
  const f = fixture(), source = f.cell("parent", "source", 0), parent = f.cell("parent", "probe", 1), child = f.cell("child", "probe", 1);
  assert.equal(f.choose([source, child]), undefined);
  assert.equal(f.choose([source, parent, child], { candidateIds: ["child", "parent"], lastRevisionCandidateId: "child" })?.candidateId, "child");
  assert.equal(f.choose([source, parent], { lastRevisionCandidateId: "child" }), undefined);
  const a = f.choose([source, parent, child], { candidateIds: ["child", "parent"] });
  const b = f.choose([child, source, parent], { candidateIds: ["parent", "child"] });
  assert.deepEqual(a, b);
});

test("comparative repair eligibility does not widen the separately calibrated Inertia critical domain", () => {
  const f = fixture(3), failed = f.cell("parent", "probe", 1);
  const history = [{ candidateId: failed.candidateId, assayId: failed.assayId, observationDigest: failed.observationDigest, obligationId: failed.evaluation!.obligationId,
    decisive: true, status: "FAILED" as const, costUnits: failed.costUnits }];
  assert.equal(maximumInertiaQuantity(history, f.contract.criticalObligations.map(item => item.id)), 0);
});
