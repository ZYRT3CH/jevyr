import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { liveModelCorpus, qualificationDigest, qualificationHash, validateQualificationConfig, compareQualificationObservation, classifyProbeObservation, PROBE_CLASSIFICATIONS } from "./live-model-fixtures.mjs";
import { assertQualificationManifest, assertArchivedQualificationSources, qualificationCandidateCoverage, FINITE_CANDIDATE_COVERAGE } from "./verify-live-model-qualification.mjs";
import { generatedSourceCorpus } from "./generated-source-fixtures.mjs";

const config = () => ({ protocol: "jevyr.live-model-qualification-config/1", providers: [{ id: "mind.qualification.test", model: "fixture:1", modelFamily: "fixture", modelDigest: `sha256:${"a".repeat(64)}`, baseUrl: "http://127.0.0.1:11434/v1", investigationTransport: "native" }], seeds: ["b".repeat(64)], repeats: 1, dockerImage: "node:24-alpine" });
const rehash = value => { const { digest, ...body } = value; return { ...body, digest: qualificationDigest(body) }; };
test("fixed clean/defect truth is executable and does not depend on candidate or provider output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevyr-truth-fixture-"));
  try {
    for (const fixture of liveModelCorpus().cases) {
      for (const file of fixture.files) await writeFile(join(directory, file.path), file.content);
      const actual = spawnSync(process.execPath, [join(directory, "truth-oracle.mjs")], { encoding: "utf8", timeout: 5000, maxBuffer: 16384, windowsHide: true });
      assert.equal(actual.error, undefined); assert.equal(actual.status, fixture.expectedExitCode); assert.equal(actual.stderr, "");
      assert.equal(compareQualificationObservation(JSON.parse(actual.stdout), fixture), true);
      assert.equal(compareQualificationObservation({ ...fixture.expectedObservation, repaired: true }, fixture), false);
      const falseActual = structuredClone(fixture.expectedObservation); falseActual.rows[0].actual = 999;
      assert.equal(compareQualificationObservation(falseActual, fixture), false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test("configuration refuses remote/credential locators, unbounded runs and semantic extra fields", () => {
  assert.deepEqual(validateQualificationConfig(config()), config());
  for (const mutate of [value => value.providers[0].baseUrl = "https://example.com/v1", value => value.providers[0].baseUrl = "http://secret@127.0.0.1:11434/v1", value => value.providers[0].apiKey = "forbidden", value => value.repeats = 99, value => value.seeds = ["arbitrary"], value => value.providers.push(value.providers[0]), value => value.prompt = "change tests"]) {
    const changed = config(); mutate(changed); assert.throws(() => validateQualificationConfig(changed));
  }
});
test("a rehash cannot hide a planned failed case or replace immutable source truth", () => {
  const settings = config(), corpus = liveModelCorpus(), planned = corpus.cases.map((fixture, index) => {
    const identity = { providerId: settings.providers[0].id, seed: settings.seeds[0], repeat: 0, caseKey: fixture.caseKey };
    return { ...identity, attemptId: qualificationDigest(identity).slice(7, 31), directory: `attempt-${String(index + 1).padStart(3, "0")}` };
  });
  const implementation = rehash({ protocol: "fixture-method/1" });
  const manifest = rehash({ protocol: "jevyr.live-model-qualification/1", config: settings, corpus, implementation, planned });
  assert.doesNotThrow(() => assertQualificationManifest(manifest));
  const omitted = structuredClone(manifest); omitted.planned.pop(); assert.throws(() => assertQualificationManifest(rehash(omitted)), /denominator/u);
  const repaired = structuredClone(manifest); repaired.corpus.cases[1].expectedObservation.rows[0].actual = 0; repaired.corpus = rehash(repaired.corpus);
  assert.throws(() => assertQualificationManifest(rehash(repaired)));
});
test("retained runner and verifier source bytes are digest checked without execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevyr-retained-method-"));
  try {
    const manifest = {}, source = "throw new Error('Archived source must never execute');\n";
    for (const [field, name] of [["runnerDigest", "runner-source.ts"], ["fixtureGeneratorDigest", "fixture-generator-source.mjs"], ["verifierDigest", "verifier-source.mjs"]]) {
      manifest[field] = qualificationHash(source); await writeFile(join(directory, name), source);
    }
    await assertArchivedQualificationSources(directory, manifest);
    await writeFile(join(directory, "verifier-source.mjs"), "changed verifier");
    await assert.rejects(assertArchivedQualificationSources(directory, manifest), /predeclared source identity/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("new coverage separates abstract ideas while retaining every admitted original and revised model program; legacy coverage is unchanged", () => {
  const providerId = "mind.qualification.test", hash = `sha256:${"a".repeat(64)}`;
  const candidates = ["original", "revision", "abstract"].map(candidateId => ({ kind: "candidate.status", actor: { kind: "mind", id: providerId }, payload: { candidateId } }));
  const populations = ["original", "revision"].map((candidateId, index) => {
    const value = { protocol: index ? "jevyr.revision-population/1" : "jevyr.candidate-population/1", candidates: [{ candidateId, blueprintDigest: hash, blueprintArtifactDigest: hash }] };
    return { value, digest: qualificationDigest(value) };
  });
  const actions = populations.map(({ digest }, index) => ({ kind: "action.status", actor: { kind: "kernel", id: "jevyr.bone" }, payload: {
    // Production's initial population uses a run-bound action ID; only revisions use the artifact digest as their action ID.
    actionType: index ? "candidate.revision.population.close" : "candidate.population.close", actionId: index ? digest : "population_run_bound_action", artifactDigests: [digest], status: "completed" } }));
  const events = [...candidates, ...actions];
  assert.deepEqual(qualificationCandidateCoverage(events, providerId, undefined, populations).candidates, ["abstract", "original", "revision"]);
  const coverage = qualificationCandidateCoverage(events, providerId, FINITE_CANDIDATE_COVERAGE, populations);
  assert.deepEqual(coverage.candidates, ["original", "revision"]); assert.deepEqual(coverage.conceptualOnly, ["abstract"]);
  assert.equal(coverage.candidates.every(id => id === "original"), false, "an unexecuted finite revision cannot be silently excluded");
  assert.deepEqual(qualificationCandidateCoverage(candidates, providerId, FINITE_CANDIDATE_COVERAGE, populations).candidates, []);
  assert.deepEqual(qualificationCandidateCoverage(events, "mind.other", FINITE_CANDIDATE_COVERAGE, populations).candidates, []);
  assert.throws(() => qualificationCandidateCoverage(events, providerId, "ignore-failures", populations));
  const tampered = structuredClone(populations); tampered[0].value.candidates[0].candidateId = "abstract";
  assert.throws(() => qualificationCandidateCoverage(events, providerId, FINITE_CANDIDATE_COVERAGE, tampered), /Population bytes changed/u);
});

test("generated configuration validates as an explicit sixth field and refuses malformed corpus declarations", () => {
  const corpus = { kind: "generated", seed: "c".repeat(64), taskPairs: 20 }, generated = () => ({ ...config(), corpus: { ...corpus } });
  assert.deepEqual(validateQualificationConfig(generated()), generated());
  assert.deepEqual(validateQualificationConfig(config()), config(), "the fixed baseline configuration is unchanged");
  for (const mutate of [value => value.corpus.extra = true, value => value.corpus.kind = "fixed", value => value.corpus.seed = "seed", value => value.corpus.taskPairs = 0, value => value.corpus.taskPairs = 61, value => value.corpus.taskPairs = 1.5, value => value.corpus = [corpus], value => delete value.corpus.seed]) {
    const changed = generated(); mutate(changed); assert.throws(() => validateQualificationConfig(changed));
  }
});

test("probe classification separates faithful, specification-following, unrelated and malformed reports without touching the strict comparison", () => {
  const [clean, defective] = liveModelCorpus().cases, observation = defective.expectedObservation;
  assert.deepEqual(PROBE_CLASSIFICATIONS, ["MATCHES_ACTUAL", "MATCHES_INTENDED", "NEITHER", "MALFORMED"]);
  assert.equal(classifyProbeObservation(observation, defective), "MATCHES_ACTUAL"); assert.equal(compareQualificationObservation(observation, defective), true);
  const intended = { ...observation, rows: observation.rows.map(row => ({ ...row, actual: row.expected })) };
  assert.equal(classifyProbeObservation(intended, defective), "MATCHES_INTENDED"); assert.equal(compareQualificationObservation(intended, defective), false);
  const wrongDigest = { ...observation, sourceDigest: `sha256:${"f".repeat(64)}` };
  assert.equal(classifyProbeObservation(wrongDigest, defective), "MATCHES_ACTUAL"); assert.equal(compareQualificationObservation(wrongDigest, defective), false);
  const garbage = { ...observation, rows: observation.rows.map(row => ({ ...row, actual: 999 })) };
  assert.equal(classifyProbeObservation(garbage, defective), "NEITHER");
  const reordered = { ...observation, rows: [...observation.rows].reverse() }, missingActual = { ...observation, rows: observation.rows.map(({ input, expected }) => ({ input, expected })) };
  for (const malformed of [null, [], "text", { ...observation, protocol: "other/1" }, { ...observation, rows: observation.rows.slice(1) }, reordered, missingActual, { ...observation, rows: "rows" }]) assert.equal(classifyProbeObservation(malformed, defective), "MALFORMED");
  assert.equal(classifyProbeObservation(clean.expectedObservation, clean), "MATCHES_ACTUAL");
  assert.equal(classifyProbeObservation({ ...clean.expectedObservation, rows: clean.expectedObservation.rows.map(row => ({ ...row, actual: 999 })) }, clean), "NEITHER");
});

test("a generated manifest regenerates its corpus from the configuration and refuses a foreign seed or an altered case", () => {
  const settings = { ...config(), corpus: { kind: "generated", seed: "d".repeat(64), taskPairs: 2 } }, corpus = generatedSourceCorpus(settings.corpus.seed, 2);
  const planned = corpus.cases.map((fixture, index) => {
    const identity = { providerId: settings.providers[0].id, seed: settings.seeds[0], repeat: 0, caseKey: fixture.caseKey };
    return { ...identity, attemptId: qualificationDigest(identity).slice(7, 31), directory: `attempt-${String(index + 1).padStart(3, "0")}` };
  });
  assert.equal(planned.length, 4);
  const manifest = rehash({ protocol: "jevyr.live-model-qualification/1", config: settings, corpus, implementation: rehash({ protocol: "fixture-method/1" }), planned });
  assert.doesNotThrow(() => assertQualificationManifest(manifest));
  const foreign = structuredClone(manifest); foreign.config.corpus.seed = "e".repeat(64); assert.throws(() => assertQualificationManifest(rehash(foreign)));
  const altered = structuredClone(manifest), differing = altered.corpus.cases[1].expectedObservation.rows.find(row => row.actual !== row.expected);
  assert.ok(differing, "a defective case must differ from its intended behavior on some declared input"); differing.actual = differing.expected; altered.corpus = rehash(altered.corpus);
  assert.throws(() => assertQualificationManifest(rehash(altered)), "a repaired defect row must not verify against the regenerated corpus");
  const fixedInstead = structuredClone(manifest); fixedInstead.corpus = liveModelCorpus(); assert.throws(() => assertQualificationManifest(rehash(fixedInstead)));
});

test("archived source identity must include the generator for generated corpora and stays three files for the fixed baseline", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevyr-retained-generator-"));
  try {
    const source = "throw new Error('Archived source must never execute');\n", manifest = {};
    for (const [field, name] of [["runnerDigest", "runner-source.ts"], ["fixtureGeneratorDigest", "fixture-generator-source.mjs"], ["verifierDigest", "verifier-source.mjs"]]) {
      manifest[field] = qualificationHash(source); await writeFile(join(directory, name), source);
    }
    await assertArchivedQualificationSources(directory, { ...manifest, config: config() });
    await assert.rejects(assertArchivedQualificationSources(directory, { ...manifest, config: { ...config(), corpus: { kind: "generated", seed: "a".repeat(64), taskPairs: 1 } } }), /generator source identity/u);
    await writeFile(join(directory, "generated-fixture-generator-source.mjs"), source);
    const complete = { ...manifest, generatedFixtureGeneratorDigest: qualificationHash(source), config: { ...config(), corpus: { kind: "generated", seed: "a".repeat(64), taskPairs: 1 } } };
    await assertArchivedQualificationSources(directory, complete);
    await writeFile(join(directory, "generated-fixture-generator-source.mjs"), "changed generator");
    await assert.rejects(assertArchivedQualificationSources(directory, complete), /predeclared source identity/u);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
