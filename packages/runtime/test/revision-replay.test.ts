import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createCaseEvent, type EventDraft } from "@jevyr/core";
import { canonicalize, sha256Digest, type CaseEvent, type JsonValue } from "@jevyr/protocol";
import { verifyPersistedAssayEvidence } from "../src/evidence-replay.js";
import { LEGACY_REVISION_INVESTIGATION_POLICY, REVISION_INVESTIGATION_POLICY, revisionInvestigationVersion } from "../src/revision-investigation.js";

// A compact public proof capture makes these semantic replay regressions
// portable. CI neither needs Docker nor trusts a fixture's claimed verdict.
const captured = JSON.parse(readFileSync(new URL("./fixtures/execution-revision-proof.json", import.meta.url), "utf8"));
function fixture() {
  const value = structuredClone(captured);
  return { ...value, events: value.events as CaseEvent[], artifacts: new Map<string, Uint8Array>(Object.entries(value.artifacts).map(([digest, base64]) => [digest, Buffer.from(base64 as string, "base64")])) };
}
function rechain(events: readonly CaseEvent[]): CaseEvent[] {
  const result: CaseEvent[] = [];
  for (const event of events) {
    const { sequence: _sequence, previousEventDigest: _previous, eventDigest: _digest, protocol: _protocol, ...draft } = event;
    result.push(createCaseEvent(draft as EventDraft, result.length + 1, result.at(-1)?.eventDigest ?? null));
  }
  return result;
}
const replay = (value: ReturnType<typeof fixture>) => verifyPersistedAssayEvidence(value.events, value.contract, value.policy.policy.assayFrontier, value.policy, async digest => value.artifacts.get(digest));
function rewritePopulation(value: ReturnType<typeof fixture>, change: (population: any) => void) {
  const event = value.events.find(event => event.kind === "action.status" && event.payload.actionType === "candidate.revision.population.close");
  assert.ok(event?.kind === "action.status");
  const population = JSON.parse(Buffer.from(value.artifacts.get(event.payload.artifactDigests![0]!)!).toString("utf8"));
  change(population);
  const bytes = Buffer.from(canonicalize(population as JsonValue)), digest = sha256Digest(bytes);
  value.artifacts.set(digest, bytes);
  (event.payload as any).artifactDigests = [digest]; (event.payload as any).actionId = digest;
  value.events = rechain(value.events);
}

test("independent replay reconstructs the executed failure, parent-bound revision and union population", async () => {
  const report = await replay(fixture());
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems));
  assert.equal(report.frontierState.candidateIds.length, 3);
  assert.equal(report.verifiedAuthorityEdges.length > 0, true);
});

test("the versioned baseline preserves exact legacy policy and independently selects the same observed critical repair", async () => {
  const value = fixture();
  assert.deepEqual(value.policy.policy.executionRevisions, LEGACY_REVISION_INVESTIGATION_POLICY);
  assert.equal(revisionInvestigationVersion(value.policy), "legacy-critical-only");
  // This is a policy-projection regression using retained raw physical cells,
  // not a claim that the historical signed Seal contains the future /2 policy.
  value.policy.policy.executionRevisions = REVISION_INVESTIGATION_POLICY;
  assert.equal(revisionInvestigationVersion(value.policy), "observed-comparative-repair");
  const report = await replay(value);
  assert.equal(report.replayComplete, true, JSON.stringify(report.problems));
  value.policy.policy.executionRevisions = { ...REVISION_INVESTIGATION_POLICY, baselineEligibility: { ...REVISION_INVESTIGATION_POLICY.baselineEligibility, threshold: 0 } };
  assert.equal(revisionInvestigationVersion(value.policy), undefined, "a similar policy cannot silently weaken the threshold");
  assert.equal((await replay(value)).replayComplete, false);
});

test("new baseline replay refuses a different failed parent even when it is already in the committed population", async () => {
  const value = fixture();
  value.policy.policy.executionRevisions = REVISION_INVESTIGATION_POLICY;
  const firstPopulation = value.events.find(event => event.kind === "action.status" && event.payload.actionType === "candidate.population.close");
  assert.ok(firstPopulation?.kind === "action.status");
  const population = JSON.parse(Buffer.from(value.artifacts.get(firstPopulation.payload.artifactDigests![0]!)!).toString("utf8"));
  let changedParent = "";
  rewritePopulation(value, revision => {
    changedParent = population.candidates.find((candidate: any) => candidate.candidateId !== revision.parentCandidateIds[0]).candidateId;
    revision.parentCandidateIds = [changedParent];
  });
  const report = await replay(value);
  assert.equal(report.replayComplete, false);
  assert.equal(report.problems.some(problem => problem.message.includes("Baseline revision differs from its sealed critical or comparative execution eligibility")), true, JSON.stringify(report.problems));
});

for (const [name, change] of [
  ["unobserved parent", (population: any) => { population.parentCandidateIds = ["candidate_fictional"]; }],
  ["feedback loop beyond the hard cap", (population: any) => { population.round = 3; }],
  ["a new evaluator frontier", (population: any) => { population.assayFrontierDigest = `sha256:${"c".repeat(64)}`; }],
  ["broken append-only ancestry", (population: any) => { population.previousPopulationDigest = `sha256:${"d".repeat(64)}`; }],
  ["fictional execution feedback", (population: any) => { population.contextDigest = `sha256:${"e".repeat(64)}`; }],
  ["unsigned additive authority", (population: any) => { population.receiptDigest = `sha256:${"f".repeat(64)}`; population.inertiaDecisionDigest = `sha256:${"a".repeat(64)}`; }],
] as const) test(`replay refuses ${name} even with canonical artifacts and a valid replacement event chain`, async () => {
  const value = fixture(); rewritePopulation(value, change);
  const report = await replay(value);
  assert.equal(report.replayComplete, false);
  assert.equal(report.problems.some(problem => problem.code === "MATRIX_INCOMPLETE"), true);
});

test("a revision cannot execute first and commit its population afterward", async () => {
  const value = fixture();
  const index = value.events.findIndex(event => event.kind === "action.status" && event.payload.actionType === "candidate.revision.population.close");
  const [closure] = value.events.splice(index, 1);
  const afterExecution = value.events.findIndex((event, position) => position > index && event.kind === "action.status" && event.actor.kind === "forge" && event.payload.status === "completed");
  assert.ok(afterExecution > index);
  value.events.splice(afterExecution + 1, 0, closure!); value.events = rechain(value.events);
  assert.equal((await replay(value)).replayComplete, false);
});
