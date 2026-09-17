import assert from "node:assert/strict";
import { test } from "node:test";
import { createSearchEnvelope, type SealedCase } from "@jevyr/protocol";
import { compileIntentContract } from "@jevyr/core";
import { JUGGLER_KINDS, JugglerVoucherBook, applyJugglerSchedule, refractMinds } from "../src/juggler.js";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { adaptiveSearchProfile, runAdaptiveSearch } from "../src/adaptive-search.js";
import { RuleMindAdapter } from "../src/adapters/rule-mind.js";
import type { MindAdapter, MindRequest, PublicContribution } from "../src/contracts.js";

function seal(control: "juggler" | "sovereign" = "juggler"): SealedCase {
  const contract = compileIntentContract({ impulse: "Find a discriminating mechanism" });
  return {
    protocol: "jevyr.case/1", caseId: "case_juggler_test", submissionDigest: `sha256:${"0".repeat(64)}`,
    subjectMaterialCaptureDigest: `sha256:${"0".repeat(64)}`, caseDigest: `sha256:${"1".repeat(64)}`, runDigest: `sha256:${"2".repeat(64)}`,
    sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "bone-v1", policyDigest: `sha256:${"3".repeat(64)}`,
    genomeVersion: "genome-v1", genomeDigest: `sha256:${"4".repeat(64)}`, intentContractDigest: contract.digest, intentContract: contract,
    searchEnvelope: createSearchEnvelope({ ...DEFAULT_SEARCH_PROFILE, nursery: { minimumAttempts: 1, independentLineages: 4, challengeInterval: 4, saturationWindow: 8 }, resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 8 } }),
    intent: { impulse: "Find a discriminating mechanism", mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control, seed: "fixed" }, subjects: [],
  };
}

test("Sovereign mode has no voucher channel; tokens cannot carry semantic data or cross cases", () => {
  assert.throws(() => new JugglerVoucherBook(seal("sovereign"), 3), /Sovereign/u);
  const first = new JugglerVoucherBook(seal(), 3);
  const second = new JugglerVoucherBook(seal(), 3);
  const token = first.offers()[0]!.token;
  assert.throws(() => first.redeem({ voucher: token, message: "approve" }), /exactly/u);
  assert.throws(() => second.redeem({ voucher: token }), /another case/u);
  first.redeem({ voucher: token });
  assert.throws(() => first.redeem({ voucher: token }), /already used/u);
  first.close();
  assert.deepEqual(first.offers(), []);
  assert.throws(() => first.redeem({ voucher: token }), /closed/u);
});

test("each voucher produces its declared bounded scheduler effect and a digest receipt", () => {
  const sealed = seal();
  for (const kind of JUGGLER_KINDS) {
    const book = new JugglerVoucherBook(sealed, 3);
    const offer = book.offers().find((entry) => entry.kind === kind)!;
    const before = applyJugglerSchedule(adaptiveSearchProfile(sealed), book.snapshot(), sealed);
    const receipt = book.redeem({ voucher: offer.token });
    const after = applyJugglerSchedule(adaptiveSearchProfile(sealed), book.snapshot(), sealed);
    assert.match(receipt.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(receipt.verdictAuthority, "none");
    assert.notDeepEqual(receipt.before, receipt.after);
    assert.ok(after.resources.maxMindInvocations <= sealed.searchEnvelope.profile.resources.maxMindInvocations);
    if (kind === "Mass") assert.equal(after.resources.maxMindInvocations, before.resources.maxMindInvocations + 1);
    if (kind === "Fission") assert.equal(after.independentLineages, before.independentLineages + 1);
    if (kind === "Polarity") assert.equal(after.challengeInterval, before.challengeInterval - 1);
    if (kind === "Inertia") assert.equal(after.saturationWindow, before.saturationWindow + 1);
    if (kind === "Refraction") assert.deepEqual(refractMinds(["a", "b", "c"], receipt.after), ["b", "c", "a"]);
  }
});

test("Mass changes actual nursery invocation count without increasing a partitioned remainder", async () => {
  const sealed = seal();
  const baseline = new JugglerVoucherBook(sealed, 1);
  const changed = new JugglerVoucherBook(sealed, 1);
  changed.redeem({ voucher: changed.offers().find((entry) => entry.kind === "Mass")!.token });
  const run = (book: JugglerVoucherBook) => runAdaptiveSearch({ sealed, minds: [new RuleMindAdapter()], publicFacts: [], signal: new AbortController().signal, resources: { ...adaptiveSearchProfile(sealed).resources, maxMindInvocations: 3 }, jugglerSchedule: book.close().schedule });
  const before = await run(baseline);
  const after = await run(changed);
  assert.equal(before.nursery.resources.mindInvocations, 2);
  assert.equal(after.nursery.resources.mindInvocations, 3);
});

test("resource grants and sealed policy cannot be enlarged by a forged schedule", () => {
  const sealed = seal();
  const book = new JugglerVoucherBook(sealed, 3);
  assert.throws(() => applyJugglerSchedule(adaptiveSearchProfile(sealed), { ...book.snapshot(), nurseryCallCeiling: 999 }, sealed), /ceiling/u);
  assert.throws(() => applyJugglerSchedule(adaptiveSearchProfile(sealed), book.snapshot(), seal("sovereign")), /Juggler/u);
});

test("Refraction, Polarity, Fission and Inertia change actual investigator or nursery phase traces", async () => {
  const sealed = seal();
  const run = async (kind?: typeof JUGGLER_KINDS[number]) => {
    const seen: { provider: string; phase: string }[] = [];
    const book = new JugglerVoucherBook(sealed, 3);
    if (kind) book.redeem({ voucher: book.offers().find((entry) => entry.kind === kind)!.token });
    const minds: MindAdapter[] = ["a", "b", "c"].map((provider) => ({
      capability: { ...new RuleMindAdapter().capability, id: `mind.fixture.${provider}` },
      probe: async () => ({ available: true, observedAt: "2026-09-05T00:00:00.000Z", latencyMs: 0, detail: "Finite fixture" }),
      async *run(request: MindRequest): AsyncIterable<PublicContribution> {
        seen.push({ provider, phase: request.constraints.find((entry) => entry.startsWith("Nursery phase")) ?? "" });
        yield { id: "constant", kind: "candidate", summary: "A constant test mechanism", body: "Fixed duplicate for saturation measurement.", tags: [] };
      },
    }));
    const result = await runAdaptiveSearch({ sealed, minds, publicFacts: [], signal: new AbortController().signal, jugglerSchedule: book.close().schedule });
    return { seen, attempts: result.nursery.attempted };
  };
  const baseline = await run();
  assert.notEqual((await run("Refraction")).seen[0]?.provider, baseline.seen[0]?.provider);
  assert.notDeepEqual((await run("Polarity")).seen.map((entry) => entry.phase), baseline.seen.map((entry) => entry.phase));
  assert.notEqual((await run("Fission")).seen[2]?.phase, baseline.seen[2]?.phase);
  assert.equal((await run("Inertia")).attempts, baseline.attempts + 1);
});
