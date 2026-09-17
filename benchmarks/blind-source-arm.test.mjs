import assert from "node:assert/strict";
import { test } from "node:test";
import { liveModelCorpus } from "./live-model-fixtures.mjs";
import { generatedSourceCorpus } from "./generated-source-fixtures.mjs";
import { aggregateBlindTrials, blindDriverSource, blindSeedInteger, blindSourcePrompt, chatCompletionsUrl, compareBlindObservation, corpusPairs } from "./blind-source-arm.mjs";

test("pairs are discovered from shared specification bytes for the fixed baseline and the generated family", () => {
  const legacy = corpusPairs(liveModelCorpus());
  assert.equal(legacy.length, 1); assert.equal(legacy[0].pairKey, "clamp"); assert.equal(legacy[0].functionName, "clamp"); assert.equal(legacy[0].cases.filter(entry => entry.defective).length, 1);
  assert.deepEqual(legacy[0].intended, [0, 0, 3, 5]); assert.deepEqual(legacy[0].cases.find(entry => entry.defective).actual, [-2, 0, 3, 5]);
  const generated = corpusPairs(generatedSourceCorpus("a".repeat(64), 4));
  assert.equal(generated.length, 4); assert.deepEqual(generated.map(pair => pair.cases.length), [2, 2, 2, 2]);
  for (const pair of generated) { assert.match(pair.functionName, /^[a-z]{4}[A-Z][a-z]{3}$/u); assert.equal(pair.declaredInputs.length, 6); assert.equal(pair.sourceFiles.length, 4); }
  const broken = liveModelCorpus(); broken.cases.pop(); assert.throws(() => corpusPairs(broken), /pair one clean and one defective/u);
});

test("the blind prompt carries only the specification and the driver and seed derivations are deterministic", () => {
  for (const corpus of [liveModelCorpus(), generatedSourceCorpus("b".repeat(64), 2)]) for (const pair of corpusPairs(corpus)) {
    const prompt = blindSourcePrompt(pair.spec);
    assert.ok(prompt.includes(pair.spec.function) && prompt.includes(pair.spec.intendedBehavior) && prompt.includes(JSON.stringify(pair.declaredInputs[0])));
    for (const content of pair.sourceFiles) assert.ok(!prompt.includes(content), "prompt must not contain source or oracle text");
    assert.ok(!prompt.includes("sourceDigest") && !prompt.includes("truth-oracle"));
    assert.equal(blindSourcePrompt(pair.spec), prompt);
  }
  assert.equal(blindDriverSource("clamp"), blindDriverSource("clamp")); assert.match(blindDriverSource("kelaToru"), /import \{ kelaToru \} from "\.\/solution\.mjs"/u);
  assert.equal(blindSeedInteger("30352fb5d9f2a681"), 0x30352fb5); assert.equal(chatCompletionsUrl("http://127.0.0.1:11434/v1/"), "http://127.0.0.1:11434/v1/chat/completions"); assert.equal(chatCompletionsUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1/chat/completions");
});

test("blind comparison distinguishes intended, defect-actual, unrelated, malformed and unexecuted outcomes", () => {
  const [pair] = corpusPairs(liveModelCorpus()), defective = pair.cases.find(entry => entry.defective), clean = pair.cases.find(entry => !entry.defective);
  const probes = [
    { attemptId: "clean", caseKey: clean.caseKey, defective: false, candidateId: "c1", artifactDigest: "d1", probeVector: clean.actual },
    { attemptId: "defect", caseKey: defective.caseKey, defective: true, candidateId: "c2", artifactDigest: "d2", probeVector: pair.intended },
    { attemptId: "defect-crash", caseKey: defective.caseKey, defective: true, candidateId: "c3", artifactDigest: "d3", probeVector: null }];
  const run = stdout => ({ exitCode: 0, stdout, timedOut: false, exceeded: false });
  const intended = compareBlindObservation(run(JSON.stringify(pair.intended)), pair, probes);
  assert.equal(intended.blindExecuted, true); assert.equal(intended.blindEqualsIntended, true);
  assert.deepEqual(intended.perCase.map(entry => entry.blindEqualsActual), [true, false]);
  assert.deepEqual(intended.withSource.map(entry => entry.blindEqualsWithSourceProbe), [true, true, null]); assert.deepEqual(intended.withSource.map(entry => entry.probeEqualsIntended), [true, true, null]);
  assert.deepEqual(intended.blindEqualsFirstWithSourceProbe, { clean: true, defective: true });
  const faithful = compareBlindObservation(run(JSON.stringify(defective.actual)), pair, probes);
  assert.equal(faithful.blindEqualsIntended, false); assert.deepEqual(faithful.perCase.map(entry => entry.blindEqualsActual), [false, true]); assert.deepEqual(faithful.blindEqualsFirstWithSourceProbe, { clean: false, defective: false });
  const unrelated = compareBlindObservation(run(JSON.stringify([9, 9, 9, 9])), pair, probes);
  assert.equal(unrelated.blindEqualsIntended, false); assert.deepEqual(unrelated.perCase.map(entry => entry.blindEqualsActual), [false, false]);
  for (const malformed of [run("not json"), run(JSON.stringify([1, 2])), { exitCode: 1, stdout: JSON.stringify(pair.intended), timedOut: false, exceeded: false }, { exitCode: 0, stdout: JSON.stringify(pair.intended), timedOut: true, exceeded: false }, null]) {
    const comparison = compareBlindObservation(malformed, pair, probes);
    assert.equal(comparison.blindExecuted, false); assert.equal(comparison.blindVector, null); assert.equal(comparison.blindEqualsIntended, null);
    assert.deepEqual(comparison.perCase.map(entry => entry.blindEqualsActual), [null, null]); assert.deepEqual(comparison.withSource.map(entry => entry.blindEqualsWithSourceProbe), [null, null, null]);
    assert.deepEqual(comparison.blindEqualsFirstWithSourceProbe, { clean: null, defective: null });
  }
  const aggregate = aggregateBlindTrials([{ generated: true, comparison: intended }, { generated: true, comparison: faithful }, { generated: false, comparison: compareBlindObservation(null, pair, probes) }]);
  assert.deepEqual(aggregate, { planned: 3, generated: 2, executed: 2, blindEqualsIntended: 1, defective: { comparisons: 2, blindEqualsWithSourceProbe: 1, blindEqualsIntendedAndProbeMatchesIntended: 1, blindEqualsDefectActual: 1 }, clean: { comparisons: 2, blindEqualsWithSourceProbe: 1 } });
});
