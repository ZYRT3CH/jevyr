import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { MAXIMUM_GENERATED_TASK_PAIRS, SOURCE_COMMAND, compareQualificationObservation, liveModelCorpus, validateQualificationConfig } from "./live-model-fixtures.mjs";
import { DECLARED_INPUTS_PER_TASK, GENERATED_IMPULSE, GENERATED_SOURCE_FILE, GENERATED_TEMPLATES, MAXIMUM_FILE_LINES, MAXIMUM_TASK_PAIRS, corpusForConfig, generatedSourceCorpus, generatedTask, renderSpecification, seededUnit } from "./generated-source-fixtures.mjs";

const LEGACY_CORPUS_DIGEST = "sha256:10c6dfbc817ceed2647a2ab66c2f4a4afd4b569fef99d5853d28650f67aaeb47";
const seedFor = label => createHash("sha256").update(label).digest("hex");
const config = corpus => ({ protocol: "jevyr.live-model-qualification-config/1", providers: [{ id: "mind.qualification.test", model: "fixture:1", modelFamily: "fixture", modelDigest: `sha256:${"a".repeat(64)}`, baseUrl: "http://127.0.0.1:11434/v1", investigationTransport: "native" }], seeds: ["b".repeat(64)], repeats: 1, dockerImage: "node:24-alpine", ...(corpus ? { corpus } : {}) });

test("the generated corpus is deterministic, bounded and structurally complete", () => {
  const seed = seedFor("determinism"), first = generatedSourceCorpus(seed, 5), second = generatedSourceCorpus(seed, 5);
  assert.deepEqual(first, second); assert.notEqual(generatedSourceCorpus(seedFor("other"), 5).digest, first.digest);
  assert.equal(first.cases.length, 10); assert.equal(first.kind, "generated"); assert.equal(first.generator.taskPairs, 5); assert.equal(first.generator.sourceFile, GENERATED_SOURCE_FILE);
  assert.equal(new Set(first.cases.map(entry => entry.caseKey)).size, 10); assert.equal(new Set(first.cases.map(entry => entry.pairKey)).size, 5);
  assert.deepEqual(first.cases.map(entry => entry.template), GENERATED_TEMPLATES.flatMap(template => [template.id, template.id]));
  for (const [index, entry] of first.cases.entries()) {
    assert.equal(entry.defective, index % 2 === 1); assert.equal(entry.defect === null, !entry.defective);
    assert.equal(entry.expectedJudgment, entry.defective ? "REJECT" : "ACCEPT"); assert.equal(entry.expectedExitCode, entry.defective ? 9 : 0);
    assert.deepEqual(entry.files.map(file => file.path), [GENERATED_SOURCE_FILE, "qualification.json", "truth-oracle.mjs"]);
    assert.equal(entry.expectedObservation.rows.length, DECLARED_INPUTS_PER_TASK);
    assert.equal(entry.expectedObservation.rows.every(row => row.actual === row.expected), !entry.defective);
    assert.deepEqual(JSON.parse(entry.files[1].content).observations, entry.expectedObservation.rows.map(({ input, expected }) => ({ input, expected })));
  }
  assert.equal(first.qualificationRule, liveModelCorpus().qualificationRule); assert.equal(first.protocol, liveModelCorpus().protocol);
  assert.equal(MAXIMUM_TASK_PAIRS, MAXIMUM_GENERATED_TASK_PAIRS);
  for (const pairs of [0, MAXIMUM_TASK_PAIRS + 1, 1.5]) assert.throws(() => generatedSourceCorpus(seed, pairs));
  assert.throws(() => generatedSourceCorpus("not-a-seed", 1));
  assert.ok(seededUnit(seed, 0) >= 0 && seededUnit(seed, 0) < 1); assert.equal(seededUnit(seed, 7), seededUnit(seed, 7)); assert.notEqual(seededUnit(seed, 7), seededUnit(seed, 8));
});

test("rendered sources execute exactly as the reference implementations for clean and defective members of every template", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jevyr-generated-truth-"));
  try {
    let executed = 0;
    for (const seed of [seedFor("execute-a"), seedFor("execute-b")]) {
      for (const fixture of generatedSourceCorpus(seed, GENERATED_TEMPLATES.length).cases) {
        for (const file of fixture.files) await writeFile(join(directory, file.path), file.content);
        const actual = spawnSync(process.execPath, [join(directory, "truth-oracle.mjs")], { encoding: "utf8", timeout: 5000, maxBuffer: 65_536, windowsHide: true });
        assert.equal(actual.error, undefined); assert.equal(actual.stderr, ""); assert.equal(actual.status, fixture.expectedExitCode, `${fixture.caseKey} exit code`);
        assert.equal(compareQualificationObservation(JSON.parse(actual.stdout), fixture), true, `${fixture.caseKey} observation`);
        assert.equal(compareQualificationObservation({ ...fixture.expectedObservation, repaired: true }, fixture), false);
        const falseActual = structuredClone(fixture.expectedObservation); falseActual.rows[0].actual = 999; assert.equal(compareQualificationObservation(falseActual, fixture), false);
        executed += 1;
      }
    }
    assert.equal(executed, 4 * GENERATED_TEMPLATES.length);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invariants hold across a seed sweep and every template and defect appears", () => {
  const seen = new Map(GENERATED_TEMPLATES.map(template => [template.id, new Set()]));
  for (let sweep = 0; sweep < 40; sweep += 1) {
    const seed = seedFor(`sweep-${sweep}`), corpus = generatedSourceCorpus(seed, GENERATED_TEMPLATES.length), names = new Set();
    for (let taskIndex = 0; taskIndex < GENERATED_TEMPLATES.length; taskIndex += 1) {
      const task = generatedTask(seed, taskIndex, names); names.add(task.name);
      assert.ok(task.intended.some((value, index) => value !== task.defectActual[index]), "defect must differ from intended");
      assert.ok(task.intended.some((value, index) => value !== task.textbookActual[index]), "textbook variant must differ from intended");
      assert.match(task.name, /^[a-z]{4}[A-Z][a-z]{3}$/u); assert.equal(new Set(task.argumentNames).size, task.argumentNames.length);
      for (const argument of task.argumentNames) assert.match(argument, /^[a-z]{4}$/u);
      seen.get(task.template).add(task.defect.id);
    }
    for (const entry of corpus.cases) {
      for (const file of entry.files) assert.ok(file.content.split("\n").length <= MAXIMUM_FILE_LINES, `${entry.caseKey} ${file.path} exceeds ${MAXIMUM_FILE_LINES} lines`);
      const spec = JSON.parse(entry.files[1].content); assert.equal(renderSpecification(spec), entry.files[1].content);
      assert.ok(spec.intendedBehavior.length > 40); assert.equal(spec.comparativeProbe.entryFile, "jevyr.experiment.mjs");
    }
  }
  for (const template of GENERATED_TEMPLATES) assert.deepEqual([...seen.get(template.id)].sort(), Object.keys(template.defects).sort(), `${template.id} defects all appear`);
});

test("the generated impulse compiles to exactly one critical obligation bound to the immutable truth oracle", async () => {
  const { compileIntentContract } = await import("../packages/core/dist/index.js");
  const contract = compileIntentContract({ impulse: GENERATED_IMPULSE, constraints: [], subjectIds: ["fixture-source"] });
  assert.equal(contract.criticalObligations.length, 1); assert.equal(contract.criticalObligations[0].oracle?.operand, SOURCE_COMMAND);
  assert.ok(GENERATED_IMPULSE.includes(GENERATED_SOURCE_FILE) && GENERATED_IMPULSE.includes("qualification.json"));
  assert.equal(generatedSourceCorpus(seedFor("impulse"), 1).impulse, GENERATED_IMPULSE);
});

test("corpusForConfig selects the pinned fixed baseline or the regenerated family", () => {
  assert.equal(liveModelCorpus().digest, LEGACY_CORPUS_DIGEST);
  assert.deepEqual(corpusForConfig(validateQualificationConfig(config())), liveModelCorpus());
  const corpus = { kind: "generated", seed: seedFor("config"), taskPairs: 3 }, validated = validateQualificationConfig(config(corpus));
  assert.deepEqual(validated, config(corpus)); assert.deepEqual(corpusForConfig(validated), generatedSourceCorpus(corpus.seed, 3));
  assert.throws(() => corpusForConfig({ corpus: { kind: "fixed" } }));
});
