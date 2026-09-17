import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, METABOLIC_RESOURCE_KEYS, METABOLIC_KINDS, METABOLIC_WORK_FOR_KIND, METABOLIC_WORK_KEYS, type JsonValue, type MetabolicKind, type MetabolicReceipt, type MetabolicResourceVector } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE, adaptiveSearchProfile, compileAssayFrontier, compileExperimentCapability, EvidenceValueScheduler, germinatePhenotype, routeCriticalChallenges, runAdaptiveSearch, runSupplementalInvestigation, type CapabilityCard, type MindAdapter, type MindRequest, type SealedCaseContext } from "../src/index.js";
import { makePublicMindPrompt, parsePublicContributions } from "../src/adapters/prompt.js";
import { RuleMindAdapter } from "../src/adapters/rule-mind.js";
import { planInertiaContinuation } from "../src/inertia-scent.js";
import { buildExecutionRevisionRequest, invokeExecutionRevision, type RevisionInvocationContext } from "../src/revision-investigation.js";

const contract = compileIntentContract({ impulse: "`node check.mjs` exits with code 0" });
const digest = `sha256:${"a".repeat(64)}`;
const sealed: SealedCaseContext = { protocol: "jevyr.case/1", caseId: "case_scheduler_12345678", submissionDigest: digest, caseDigest: digest, runDigest: digest, sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "jevyr.bone/1", policyDigest: digest, genomeVersion: "jevyr.genome/1", genomeDigest: digest, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), intentContractDigest: contract.digest, intentContract: contract, intent: { impulse: "`node check.mjs` exits with code 0", mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "sovereign", seed: "seed-fixed" }, subjects: [] };
const card = (id: string, providerId: string, modelFamily?: string): CapabilityCard => ({ id, kind: "mind", displayName: id, version: "1", transport: "in-process", trust: "quarantined", modalities: ["text"], network: "none", canExecuteTools: false, deterministic: true, limits: { providerId, modelId: id, ...(modelFamily ? { modelFamily } : {}) } });

test("revision requests survive canonical artifact round trips and keep private parent bytes withheld", () => {
  const source = "process.exit(9);", files = [{ path: "check.mjs", content: source, digest: sha256Digest(source) }];
  const cells = [{ candidateId: "parent", assayId: "check", obligationId: contract.criticalObligations[0]!.id, executed: true, exitCode: 9, status: "FAILED" as const, decisive: true, costUnits: 3 }];
  const feedbackBody = { protocol: "jevyr.execution-feedback/1" as const, cells, observationBindings: [{ candidateId: "parent", assayId: "check", observationDigest: digest }], contextDigest: digestJson(cells) };
  const revision: RevisionInvocationContext = { round: 1, feedback: { ...feedbackBody, digest: digestJson(feedbackBody) }, inputs: [], parentCandidateIds: ["parent"], feedbackArtifactDigest: digest, receiptSequence: 2 };
  const frontier = compileAssayFrontier([{ assayId: "check", costUnits: 3, tool: "forge.command", args: { command: "node", args: ["check.mjs"] }, obligationId: contract.criticalObligations[0]!.id }], DEFAULT_SEARCH_PROFILE.resources);
  const base: MindRequest = { sealed, stage: "reflex", role: "reflex", publicFacts: [], constraints: [], seed: "held", signal: new AbortController().signal, experimentCapability: compileExperimentCapability(frontier, contract) };
  const request = buildExecutionRevisionRequest(base, revision, [{ candidateId: "parent", blueprintDigest: digest, files }], "none");
  const { signal: _signal, ...serializable } = request;
  const roundtrip = { ...JSON.parse(canonicalize(serializable as unknown as JsonValue)), signal: request.signal };
  assert.equal(makePublicMindPrompt(request), makePublicMindPrompt(roundtrip));
  const nextRun = buildExecutionRevisionRequest({ ...base, sealed: { ...sealed, runDigest: sha256Digest("other run"), caseId: "case_repeated_12345678", sealedAt: "2026-09-06T00:00:00.000Z" } }, { ...revision, receiptDigest: sha256Digest("other receipt") }, [{ candidateId: "parent", blueprintDigest: digest, files }], "none");
  assert.equal(request.seed, nextRun.seed);
  assert.equal(makePublicMindPrompt(request), makePublicMindPrompt(nextRun));
  const withheld = buildExecutionRevisionRequest({ ...base, sealed: { ...sealed, intent: { ...sealed.intent, privacy: "provider_scoped" } } }, revision, [{ candidateId: "parent", blueprintDigest: digest, files }], "provider");
  assert.equal(withheld.revisionSources, undefined);
  assert.equal(JSON.stringify(withheld.publicFacts).includes("WITHHELD_BY_PRIVACY_SCOPE"), true);
});

test("shared revision admission preserves every measured token when a provider substitutes its parent or program", async () => {
  const source = "process.exit(9);";
  const request = { stage: "reflex", role: "reflex", sealed, seed: "held", signal: new AbortController().signal, publicFacts: [], constraints: [], revision: { round: 1, contextDigest: digest, parentCandidateIds: ["parent"] }, revisionSources: [{ candidateId: "parent", blueprintDigest: digest, files: [{ path: "check.mjs", content: source, digest: sha256Digest(source) }] }] } satisfies MindRequest;
  for (const [parentId, proposed] of [["foreign", "process.exit(0);"], ["parent", source]]) {
    const mind: MindAdapter = { capability: card("fixture", "local"), async probe() { return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "fixture" }; }, async *run() {}, async runMetered() { return { contributions: [{ id: "revision", kind: "candidate", parentIds: [parentId!], summary: "Proposed", candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: "check.mjs", content: proposed! }] } }], transmittedInputBytes: 123, receivedOutputBytes: 456, tokenUsage: { input: { tokens: 30, measurement: "MEASURED" }, output: { tokens: 40, measurement: "MEASURED" } } }; } };
    const result = await invokeExecutionRevision(mind, request);
    assert.ok(result.admissionProblem);
    assert.deepEqual(result.result.contributions, []);
    assert.equal(result.result.tokenUsage.input.tokens, 30);
    assert.equal(result.result.tokenUsage.output.tokens, 40);
    assert.equal(result.result.receivedOutputBytes, 456);
  }
});

test("held seed gives identical governing phenotype regardless of adapter discovery order", () => {
  const cards = [card("a", "provider-a", "family-a"), card("b", "provider-b", "family-b"), card("c", "provider-c", "family-c")];
  const first = germinatePhenotype(sealed, cards, ["command", "browser"]);
  assert.deepEqual(first, germinatePhenotype(sealed, [...cards].reverse(), ["browser", "command"]));
  const variants = new Set(Array.from({ length: 20 }, (_, index) => germinatePhenotype({ ...sealed, intent: { ...sealed.intent, seed: `seed-${index}` } }, cards, ["command", "browser"]).digest));
  assert.equal(variants.size, 20);
  assert.ok(first.isolation.blindLineages >= 2);
  assert.ok(first.isolation.blindLineages <= sealed.searchEnvelope.profile.nursery.independentLineages);
  assert.equal(Object.hasOwn(first.scheduler, "verdictThreshold"), false);
});

test("finite evidence-value execution reaches the critical defect before comparative work consumes the budget", () => {
  const obligation = contract.criticalObligations[0]!;
  const frontier = compileAssayFrontier([
    { assayId: "aaa_comparative", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["explore.mjs"] } },
    { assayId: "zzz_critical", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["check.mjs"] }, obligationId: obligation.id },
  ], DEFAULT_SEARCH_PROFILE.resources);
  const capability = compileExperimentCapability(frontier, contract);
  const phenotype = germinatePhenotype(sealed, [card("a", "p", "f")]);
  const scheduler = new EvidenceValueScheduler(["candidate-a", "candidate-b"], frontier.assays, contract, capability, phenotype);
  const first = scheduler.next()!;
  assert.equal(first.cell.plan.assayId, "zzz_critical");
  scheduler.observe({ candidateId: first.cell.candidateId, assayId: first.cell.plan.assayId, obligationId: obligation.id, decisive: true, outcome: "FAILED", costUnits: 1 });
  const second = scheduler.next()!;
  assert.equal(second.cell.candidateId, "candidate-b");
  assert.equal(second.cell.plan.assayId, "zzz_critical");
  assert.equal(second.decision.observedDecisive, 1);
  const remaining = [scheduler.next()!, scheduler.next()!];
  assert.ok(remaining.every(entry => entry.cell.plan.assayId === "aaa_comparative"));
  assert.equal(scheduler.next(), undefined);
});

test("critical routing avoids using another same-family identity as cross-family coverage", () => {
  const cards = [card("a", "provider-a", "family-a"), card("alias-a", "provider-a", "family-a"), card("b", "provider-b", "family-b")];
  const routing = routeCriticalChallenges(contract, cards, new Map([["candidate-a", "a"], ["candidate-b", "b"]]), 2);
  assert.deepEqual(routing.assignments.map(entry => entry.adapterId), ["a", "b"]);
  assert.deepEqual(routing.assignments[0]!.candidateIds, ["candidate-b"]);
  assert.deepEqual(routing.assignments[1]!.candidateIds, ["candidate-a"]);
  assert.ok(routing.coverage.every(entry => entry.crossFamily && entry.crossProvider));
  const unknown = routeCriticalChallenges(contract, [card("model-a", "shared"), card("model-b", "shared")], new Map(), 2);
  assert.ok(unknown.coverage.every(entry => !entry.crossFamily && !entry.crossProvider));
  assert.ok(unknown.limitations.some(entry => entry.includes("not established")));
});

function grant(kind: MetabolicKind, quantity: number): MetabolicReceipt {
  const resources = Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key => [key, key === "maxMindInvocations" ? quantity : key === "maxWallMillis" ? 10_000 : key === "maxInputTokens" || key === "maxOutputTokens" || key === "maxGeneratedBytes" ? 100_000 * quantity : 0])) as unknown as MetabolicResourceVector;
  const body = { protocol: "jevyr.metabolism-receipt/1" as const, caseId: sealed.caseId, caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, policyDigest: sealed.policyDigest, searchDigest: sealed.searchEnvelope.digest, allowanceDigest: digest, calibrationDigest: digest, ballId: `ball_${"a".repeat(43)}`, kind, quantity, sequence: 1, previousReceiptDigest: null, issuedAt: "2026-09-05T00:00:00.000Z", grant: resources, cumulativeGrant: resources, cumulativeQuantities: Object.fromEntries(METABOLIC_KINDS.map(key => [key, key === kind ? quantity : 0])) as unknown as MetabolicReceipt["cumulativeQuantities"], work: Object.fromEntries(METABOLIC_WORK_KEYS.map(key => [key, key === METABOLIC_WORK_FOR_KIND[kind] ? quantity : 0])) as unknown as MetabolicReceipt["work"], baselineUnchanged: true as const, verdictAuthority: "none" as const };
  return { ...body, digest: digestJson(body as unknown as JsonValue) };
}

test("all supplemental kinds execute their own bounded method and Fission commits mutually blind lanes", async () => {
  const frontier = compileAssayFrontier(["extra", "second"].map(name => ({ assayId: `python-${name}`, costUnits: 1, tool: "forge.command" as const, args: { command: "python3", args: [`${name}.py`] } })), DEFAULT_SEARCH_PROFILE.resources);
  const capability = compileExperimentCapability(frontier, contract);
  const baselineHypotheses = [{ id: "baseline-candidate", kind: "candidate" as const, summary: "Existing leading mechanism" }, { id: "other-candidate", kind: "candidate" as const, summary: "Other observed mechanism" }];
  for (const kind of ["Mass", "Refraction", "Polarity", "Fission", "Inertia"] as const) {
    const requests: MindRequest[] = [];
    const mind: MindAdapter = { capability: card("model-a", "provider-a", "family-a"), async probe() { return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "fixture" }; }, async *run(request) {
      requests.push(request); const entry = request.constraints.some(value => value.includes("presealed experiment python-second")) ? "second.py" : "extra.py";
      yield { id: `proposal-${requests.length}`, kind: "candidate", summary: `Measured generation ${request.seed}`, candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: entry, content: `# ${request.seed}\nprint(1)` }], command: { executable: "python3", args: [entry] } } };
    } };
    const audits: unknown[] = [];
    const receipt = grant(kind, 2);
    const inertiaDecision = kind !== "Inertia" ? undefined : planInertiaContinuation(receipt, baselineHypotheses.flatMap((candidate, candidateIndex) => Array.from({ length: candidateIndex === 0 ? 4 : 8 }, (_, index) => ({ candidateId: candidate.id, observationDigest: digestJson({ candidate: candidate.id, index }), assayId: "python-extra", obligationId: contract.criticalObligations[0]!.id, status: "FAILED" as const, decisive: true, costUnits: 1 }))), contract.criticalObligations.map(value => value.id));
    const outcome = await runSupplementalInvestigation({ sealed, minds: [mind], publicFacts: [{ id: "memory-old", kind: "observation", summary: "remembered", tags: ["admitted-memory"] }], experimentCapability: capability, signal: new AbortController().signal, observe: observation => { if (observation.audit) audits.push(observation.audit); } }, receipt, { baselineHypotheses, baselineSaturated: true, targetAssayIds: ["python-extra", "python-second"], ...(inertiaDecision ? { inertiaDecision } : {}) });
    assert.equal(requests.length, 2, kind);
    assert.equal(outcome.nursery.resources.mindInvocations, 2, kind);
    assert.equal(outcome.hypotheses.length, 2, kind);
    assert.ok(outcome.nursery.specimens.every(specimen => specimen.phase === (kind === "Fission" ? "EXILE" : kind === "Polarity" ? "COEVOLVE" : "DIVERSIFY")), kind);
    if (kind === "Fission") {
      assert.ok(requests.every(request => request.publicFacts.length === 0));
      assert.equal(audits.length, 2);
    } else assert.equal(audits.length, 0, "Nonblind work must not claim blind-lineage authority");
  }
});

test("pre-evidence nursery never offers Inertia and an explicit later-checkpoint owner retains admission", async () => {
  let closed = false; const offered: string[][] = [];
  const mind: MindAdapter = { capability: card("model-a", "provider-a", "family-a"), async probe() { return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "fixture" }; }, async *run() { yield { id: "duplicate", kind: "candidate", summary: "One fixed candidate" }; } };
  await runAdaptiveSearch({ sealed, minds: [mind], publicFacts: [], signal: new AbortController().signal, deferMetabolicClosure: true, closeMetabolicAdmission: () => { closed = true; }, takePendingGrants: async () => [], onMetabolicEligibility: kinds => { offered.push([...kinds]); } });
  assert.equal(closed, false); assert.ok(offered.length > 0); assert.ok(offered.every(kinds => !kinds.includes("Inertia")));
  assert.deepEqual(offered.at(-1), [], "The evidence checkpoint inherits an open book with no stale nursery offers");
  await assert.rejects(runSupplementalInvestigation({ sealed, minds: [mind], publicFacts: [], signal: new AbortController().signal }, grant("Inertia", 1), { baselineHypotheses: [{ id: "duplicate", kind: "candidate", summary: "One fixed candidate" }], baselineSaturated: true }), /physical evidence history/);
});

test("deferred closure consumes a final committed nursery grant before handing off empty eligibility", async () => {
  const calls: string[] = [];
  const mind: MindAdapter = { capability: card("model-a", "provider-a", "family-a"), async probe() { return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "fixture" }; }, async *run(request) { calls.push(request.seed); yield { id: request.seed, kind: "candidate", summary: request.seed }; } };
  const resources = { maxMindInvocations: 2, maxInputTokens: 100_000, maxOutputTokens: 100_000, maxWallMillis: 10_000, maxGeneratedBytes: 100_000, maxSingleInvocationMillis: 5_000 };
  let eligibilityStopped = false, consumed = false;
  const result = await runAdaptiveSearch({ sealed, minds: [mind], publicFacts: [], resources, signal: new AbortController().signal, deferMetabolicClosure: true, closeMetabolicAdmission: () => { assert.fail("physical checkpoint retains the open admission book"); }, onMetabolicEligibility: kinds => { if (!kinds.length) eligibilityStopped = true; }, takePendingGrants: async () => { if (!eligibilityStopped || consumed) return []; consumed = true; return [grant("Mass", 1)]; } });
  assert.equal(consumed, true); assert.equal(result.nursery.resources.mindInvocations, 3); assert.equal(calls.length, 3);
});

test("live additions preserve every baseline call and account a final committed grant after admission closes", async () => {
  const calls: string[] = [];
  const mind: MindAdapter = { capability: card("model-a", "provider-a", "family-a"), async probe() { return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "fixture" }; }, async *run(request) { calls.push(request.seed); yield { id: request.seed, kind: "candidate", summary: request.seed }; } };
  const resources = { maxMindInvocations: 2, maxInputTokens: 100_000, maxOutputTokens: 100_000, maxWallMillis: 10_000, maxGeneratedBytes: 100_000, maxSingleInvocationMillis: 5_000 };
  const baseline = await runAdaptiveSearch({ sealed, minds: [mind], publicFacts: [], resources, signal: new AbortController().signal });
  const baselineCalls = [...calls]; calls.length = 0;
  let closed = false, consumed = false;
  const result = await runAdaptiveSearch({ sealed, minds: [mind], publicFacts: [], resources, signal: new AbortController().signal, closeMetabolicAdmission: () => { closed = true; }, takePendingGrants: async () => { if (!closed || consumed) return []; consumed = true; return [grant("Mass", 1)]; } });
  assert.deepEqual(calls.slice(0, baselineCalls.length), baselineCalls);
  assert.equal(result.nursery.resources.mindInvocations, baseline.nursery.resources.mindInvocations + 1);
  assert.equal(consumed, true);
});

test("v2 locked seed preserves actual nursery, supplemental methods, and logical cell schedule across distinct Run receipts", async () => {
  const baseline = { ...sealed, searchEnvelope: createSearchEnvelope({ ...DEFAULT_SEARCH_PROFILE, seedDerivation: "sha256-case-seed-frontier-v2" }) };
  const repeated = { ...baseline, caseId: "case_distinct_physical_run", runDigest: digestJson("different run receipt"), sealedAt: "2026-09-05T00:01:00.000Z" };
  assert.notEqual(baseline.runDigest, repeated.runDigest);
  const run = async (input: SealedCaseContext, supplemental: boolean) => {
    const requests: { seed: string; constraints: readonly string[]; role: string }[] = [];
    const mind: MindAdapter = { capability: card("fixture", "provider", "family"), async probe() { return { available: true, observedAt: input.sealedAt, latencyMs: 0, detail: "deterministic fixture" }; }, async *run(request) { requests.push({ seed: request.seed, constraints: request.constraints, role: request.role }); yield { id: request.seed, kind: "candidate", summary: request.seed }; } };
    const phenotype = germinatePhenotype(input, [mind.capability], ["intent-command"]);
    const options = { sealed: input, minds: [mind], phenotype, publicFacts: [], resources: { maxMindInvocations: 4, maxInputTokens: 100_000, maxOutputTokens: 100_000, maxWallMillis: 10_000, maxGeneratedBytes: 100_000, maxSingleInvocationMillis: 5_000 }, signal: new AbortController().signal };
    let outcome;
    if (supplemental) {
      const original = grant("Fission", 2);
      const { digest: _, ...body } = { ...original, caseId: input.caseId, caseDigest: input.caseDigest, runDigest: input.runDigest, issuedAt: input.sealedAt, searchDigest: input.searchEnvelope.digest };
      outcome = await runSupplementalInvestigation(options, { ...body, digest: digestJson(body as unknown as JsonValue) }, { baselineHypotheses: [], baselineSaturated: false });
    } else outcome = await runAdaptiveSearch(options);
    const frontier = compileAssayFrontier([{ assayId: "bound", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["check.mjs"] }, obligationId: contract.criticalObligations[0]!.id }], DEFAULT_SEARCH_PROFILE.resources);
    const scheduler = new EvidenceValueScheduler(outcome.hypotheses.map(hypothesis => hypothesis.id), frontier.assays, contract, compileExperimentCapability(frontier, contract), phenotype);
    const cells = [];
    while (scheduler.remaining) cells.push(scheduler.next()!.decision);
    return { requests, phenotype, profileSeed: outcome.nursery.profile.seed, hypotheses: outcome.hypotheses, cells };
  };
  assert.deepEqual(await run(baseline, false), await run(repeated, false));
  assert.deepEqual(await run(baseline, true), await run(repeated, true));
  const legacy = { ...baseline, searchEnvelope: createSearchEnvelope({ ...DEFAULT_SEARCH_PROFILE, seedDerivation: "sha256-run-digest-frontier-v1" }) };
  assert.notEqual(adaptiveSearchProfile(legacy).seed, adaptiveSearchProfile({ ...legacy, runDigest: repeated.runDigest }).seed, "old sealed seed rule remains supported exactly");
});

test("v2 common provider prompts and parsed or Rule proposals exclude physical Run identity", async () => {
  const request: MindRequest = { sealed, stage: "interpret", role: "interpreter", publicFacts: [], seed: "held-provider-seed", constraints: [], signal: new AbortController().signal };
  const repeated: MindRequest = { ...request, sealed: { ...sealed, caseId: "case_distinct_run_id", runDigest: digestJson("new physical run"), sealedAt: "2026-09-06T00:00:00.000Z" } };
  assert.deepEqual(makePublicMindPrompt(request), makePublicMindPrompt(repeated));
  assert.ok(!makePublicMindPrompt(request).includes(sealed.caseId));
  const result = JSON.stringify({ contributions: [{ kind: "claim", summary: "An identical inspectable proposal" }] });
  assert.deepEqual(parsePublicContributions(result, "model", request), parsePublicContributions(result, "model", repeated));
  const rule = new RuleMindAdapter();
  const collect = async (input: MindRequest) => { const output = []; for await (const contribution of rule.run(input)) output.push(contribution); return output; };
  assert.deepEqual(await collect(request), await collect(repeated));
  const legacyRequest = { ...request, sealed: { ...sealed, searchEnvelope: createSearchEnvelope({ ...DEFAULT_SEARCH_PROFILE, seedDerivation: "sha256-run-digest-frontier-v1" }) } };
  assert.notEqual(makePublicMindPrompt(legacyRequest), makePublicMindPrompt({ ...legacyRequest, sealed: { ...legacyRequest.sealed, caseId: repeated.sealed.caseId } }));
});
