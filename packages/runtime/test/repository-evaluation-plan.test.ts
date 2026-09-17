import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { checkRepositorySuiteReportConsistency, planRepositoryEvaluation, type RepositoryEvaluationInput, type RepositoryEvaluatorRunner } from "../src/repository-evaluation-plan.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";

const runner: RepositoryEvaluatorRunner = { id: "node-test-v1", evaluatorDigest: sha256Digest("trusted controller implementation"), immutableImageId: sha256Digest("node24 image"), capabilityId: "forge.oci" };
const testSource = 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ntest("sum", () => assert.equal(add(2, 3), 5));\n';
function fixture(extra: Readonly<Record<string, string>> = {}, impulse = "Existing tests must pass.") {
  const files = { "src/add.mjs": "export const add = (a, b) => a + b;\n", "tests/add.test.mjs": testSource, ...extra };
  const blobs = new Map<string, Uint8Array>();
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, text]) => { const bytes = Buffer.from(text), blobDigest = sha256Digest(bytes); blobs.set(blobDigest, bytes); return { path, blobDigest, byteLength: bytes.length, mode: 0o644 }; });
  let manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: "directory", subjectDigest: sha256Digest("captured repo"), availability: "MATERIALIZED", entries, directories: [], omissions: [], byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0) };
  const binding: SubjectMaterialBinding = { subjectId: manifest.subjectId, subjectKind: manifest.subjectKind, subjectDigest: manifest.subjectDigest, availability: manifest.availability, byteLength: manifest.byteLength, manifestDigest: digestJson(manifest as unknown as JsonValue) };
  const reads: string[] = [], input: RepositoryEvaluationInput = { captureDigest: digestJson({ protocol: "jevyr.subject-material-capture/1", bindings: [binding] as unknown as JsonValue }), bindings: [binding],
    contract: compileIntentContract({ impulse, subjectIds: ["repo"] }), runner, reader: { readManifest: async () => manifest, readBlob: async (digest) => { reads.push(digest); const bytes = blobs.get(digest); if (!bytes) throw new Error("private host pathname"); return bytes; } } };
  return { input, binding, blobs, reads, files, manifest, mutateManifest: (next: SubjectMaterialManifest) => { manifest = next; } };
}
const codes = (plan: Awaited<ReturnType<typeof planRepositoryEvaluation>>) => plan.subjects.flatMap(subject => subject.refusals.map(refusal => refusal.code));

test("discovers a dependency-free Node suite and binds only the precise existing-test obligation", async () => {
  const f = fixture(), plan = await planRepositoryEvaluation(f.input), subject = plan.subjects[0]!;
  assert.equal(plan.status, "ready"); assert.equal(plan.scope, "exact-existing-test-suite"); assert.equal(plan.target, "sealed-original-subject");
  assert.equal(subject.status, "ready"); assert.equal(subject.authority, "intent-bound"); assert.deepEqual(subject.obligationIds, [f.input.contract.criticalObligations[0]!.id]);
  assert.deepEqual(subject.testFiles.map(file => file.path), ["tests/add.test.mjs"]); assert.deepEqual(subject.sourceFiles.map(file => file.path), ["src/add.mjs", "tests/add.test.mjs"]);
  assert.deepEqual(plan.coverage, { subjects: 1, discoveredTestFiles: 1, plannedTestFiles: 1, omittedTestFiles: 0 }); assert.deepEqual(codes(plan), []);
  assert.equal(subject.testFiles[0]!.digest, sha256Digest(testSource)); assert.equal(subject.runner!.evaluatorDigest, runner.evaluatorDigest);
  const { digest, ...body } = plan; assert.equal(digest, digestJson(body as unknown as JsonValue));
});

test("generic repository missions remain comparative and never invent a critical test criterion", async () => {
  const f = fixture({}, "Investigate this repository and find defects."), plan = await planRepositoryEvaluation(f.input);
  assert.equal(plan.status, "ready"); assert.equal(plan.subjects[0]!.authority, "comparative-only"); assert.deepEqual(plan.subjects[0]!.obligationIds, []);
  assert.equal(plan.intentContractDigest, f.input.contract.digest); assert.ok(f.input.contract.criticalObligations.every(obligation => obligation.assayability === "UNASSAYABLE"));
});

test("plans are deterministic across canonical copies, while changed captured source or runner changes identity", async () => {
  const f = fixture(), a = await planRepositoryEvaluation(f.input), b = await planRepositoryEvaluation({ ...f.input, contract: JSON.parse(JSON.stringify(f.input.contract)), bindings: JSON.parse(JSON.stringify(f.input.bindings)) });
  assert.deepEqual(a, b);
  const changed = await planRepositoryEvaluation(fixture({ "src/add.mjs": "export const add = (a, b) => a - b;\n" }).input);
  assert.notEqual(changed.captureDigest, a.captureDigest); assert.notEqual(changed.subjects[0]!.suiteDigest, a.subjects[0]!.suiteDigest);
  const otherRunner = await planRepositoryEvaluation({ ...f.input, runner: { ...runner, evaluatorDigest: sha256Digest("other controller") } });
  assert.notEqual(otherRunner.subjects[0]!.suiteDigest, a.subjects[0]!.suiteDigest);
});

test("dependency declarations, loaders, hooks, unsupported test families and unresolved imports refuse complete admission", async () => {
  const cases: readonly [Record<string, string>, string][] = [
    [{ "package.json": '{"devDependencies":{"vitest":"1"}}' }, "DEPENDENCY_DECLARATION_UNSUPPORTED"],
    [{ "package.json": '{"scripts":{"test":"node --import ./loader.mjs --test"}}' }, "TEST_SCRIPT_UNSUPPORTED"],
    [{ "package.json": '{"scripts":{"test":"node --test","pretest":"node setup.mjs"}}' }, "TEST_LIFECYCLE_HOOK_UNSUPPORTED"],
    [{ "package.json": '{"imports":{"#check":"./other.mjs"}}' }, "PACKAGE_RESOLUTION_UNSUPPORTED"],
    [{ "tsconfig.json": "{}" }, "DEPENDENCY_OR_CUSTOM_CONFIG_UNSUPPORTED"],
    [{ "tests/extra.test.py": "assert True" }, "TEST_LANGUAGE_UNSUPPORTED"],
    [{ "src/add.mjs": 'import thing from "external"; export const add = thing;' }, "EXTERNAL_OR_UNSUPPORTED_IMPORT"],
    [{ "src/add.mjs": 'export { add } from "./missing.mjs";' }, "IMPORT_MATERIAL_UNAVAILABLE"],
    [{ "src/add.mjs": 'const path="external"; export const add = (await import(path)).add;' }, "DYNAMIC_IMPORT_OR_REQUIRE"],
    [{ "src/add.mjs": 'const load = require; export const add = load("external").add;' }, "INDIRECT_REQUIRE"],
    [{ "src/add.mjs": 'export const add = new Function("a", "b", "return a+b");' }, "DYNAMIC_CODE"],
  ];
  for (const [files, expected] of cases) {
    const plan = await planRepositoryEvaluation(fixture(files).input);
    assert.equal(plan.status, "unavailable", expected); assert.ok(codes(plan).includes(expected), JSON.stringify(codes(plan)));
    assert.equal(plan.subjects[0]!.authority, "comparative-only"); assert.deepEqual(plan.subjects[0]!.obligationIds, []);
  }
});

test("a package script is inert metadata and only explicit module type resolves JavaScript imports", async () => {
  const f = fixture({ "package.json": '{"type":"module","scripts":{"test":"node --test"}}', "src/helper.js": "export const helper = 1;", "src/add.mjs": 'import { helper } from "./helper.js"; export const add=(a,b)=>a+b+helper-1;' });
  const plan = await planRepositoryEvaluation(f.input); assert.equal(plan.status, "ready"); assert.equal(plan.subjects[0]!.configFiles[0]!.path, "package.json");
  const ambiguous = await planRepositoryEvaluation(fixture({ "src/add.mjs": 'export {add} from "./helper.js";', "src/helper.js": "export const add=(a,b)=>a+b;" }).input);
  assert.ok(codes(ambiguous).includes("AMBIGUOUS_MODULE_TYPE"));
  const comment = await planRepositoryEvaluation(fixture({ "src/add.mjs": '// import illegal from "external";\nexport const add=(a,b)=>a+b;' }).input); assert.equal(comment.status, "ready");
});

test("discovery and source budgets never silently turn a partial inventory into a passing suite", async () => {
  const f = fixture({ "tests/other.test.mjs": testSource }), plan = await planRepositoryEvaluation({ ...f.input, limits: { maxTestFiles: 1 } });
  assert.equal(plan.status, "unavailable"); assert.ok(codes(plan).includes("TEST_FILE_BUDGET"));
  assert.deepEqual(plan.coverage, { subjects: 1, discoveredTestFiles: 2, plannedTestFiles: 0, omittedTestFiles: 2 });
  const bounded = fixture(), limited = await planRepositoryEvaluation({ ...bounded.input, limits: { maxTotalBytes: 8, maxFileBytes: 8 } });
  assert.ok(codes(limited).includes("SOURCE_BUDGET")); assert.deepEqual(bounded.reads, []);
  const withoutRunner = await planRepositoryEvaluation({ ...fixture().input, runner: undefined } as unknown as RepositoryEvaluationInput);
  assert.ok(codes(withoutRunner).includes("TRUSTED_RUNNER_UNAVAILABLE"));
});

test("capture, manifest, and source tampering cannot supply an evaluator plan", async () => {
  const f = fixture();
  await assert.rejects(() => planRepositoryEvaluation({ ...f.input, captureDigest: sha256Digest("foreign") }), /mismatched sealed input/u); assert.deepEqual(f.reads, []);
  f.blobs.set(sha256Digest(testSource), Buffer.from("candidate passing replacement"));
  await assert.rejects(() => planRepositoryEvaluation(f.input), /mismatched sealed input/u);
  f.mutateManifest({ ...f.manifest, entries: f.manifest.entries.map(entry => ({ ...entry, path: `changed/${entry.path}` })) });
  await assert.rejects(() => planRepositoryEvaluation(f.input), /mismatched sealed input/u);
  await assert.rejects(() => planRepositoryEvaluation({ ...fixture().input, runner: { ...runner, command: "candidate.mjs" } as RepositoryEvaluatorRunner }), /mismatched sealed input/u);
});

test("a syntactically empty or non-Node test cannot become a complete selected suite", async () => {
  for (const text of ["", "process.exit(0);", 'import assert from "node:assert/strict"; assert.equal(1,1);']) {
    const plan = await planRepositoryEvaluation(fixture({ "tests/add.test.mjs": text }).input);
    assert.equal(plan.status, "unavailable"); assert.ok(codes(plan).includes("NO_NODE_TEST_DECLARATION"));
  }
});

test("report checking is consistency-only and refuses skipped, cancelled, errors, zero tests and synthetic file passes", () => {
  const suiteDigest = sha256Digest("suite"), report = { protocol: "jevyr.repository-suite-controller-report/1", suiteDigest, complete: true, executedTests: 2, passed: 2, failed: 0, errors: 0, skipped: 0, cancelled: 0, fileOnlyPasses: 0 };
  assert.deepEqual(checkRepositorySuiteReportConsistency(report, suiteDigest), { consistent: true, outcome: "pass", reasons: [] });
  assert.deepEqual(checkRepositorySuiteReportConsistency({ ...report, passed: 1, failed: 1 }, suiteDigest), { consistent: true, outcome: "fail", reasons: [] });
  for (const patch of [{ complete: false }, { executedTests: 0, passed: 0 }, { passed: 1, skipped: 1 }, { passed: 1, cancelled: 1 }, { passed: 1, errors: 1 }, { fileOnlyPasses: 1 }, { passed: 99 }, { suiteDigest: sha256Digest("foreign") }, { authority: "I passed" }]) {
    const checked = checkRepositorySuiteReportConsistency({ ...report, ...patch }, suiteDigest); assert.equal(checked.consistent, false); assert.equal(checked.outcome, "unproven");
  }
});
