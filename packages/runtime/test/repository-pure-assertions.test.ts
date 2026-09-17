import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract, sealCase } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sealedCaseIdentityDigest, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";
import { analyzeRepositoryPureAssertions, compareRepositoryPureAssertionAnalysis, REPOSITORY_PURE_ASSERTION_LIMITS, type RepositoryPureAssertionInput, type RepositoryPureAssertionAnalysis } from "../src/repository-pure-assertions.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const header = 'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "../src/add.mjs";\n';
const defaultTest = `${header}test("sum", () => assert.equal(add(2, 3), 5));\n`;
function fixture(extra: Readonly<Record<string, string>> = {}, options: { impulse?: string; constraints?: string[]; requestedAssays?: string[]; kind?: "directory" | "git"; omissions?: SubjectMaterialManifest["omissions"]; timestamp?: string } = {}) {
  const files = { "src/add.mjs": "export const add = (a, b) => a + b;\n", "tests/add.test.mjs": defaultTest, ...extra };
  const blobs = new Map<string, Uint8Array>();
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, text]) => { const bytes = Buffer.from(text), blobDigest = sha256Digest(bytes); blobs.set(blobDigest, bytes); return { path, blobDigest, byteLength: bytes.length, mode: 0o644 }; });
  const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: options.kind ?? "directory", subjectDigest: hash(entries), availability: "MATERIALIZED", entries, directories: ["src", "tests"], omissions: options.omissions ?? [], byteLength: entries.reduce((sum, file) => sum + file.byteLength, 0) };
  const binding: SubjectMaterialBinding = { subjectId: "repo", subjectKind: manifest.subjectKind, subjectDigest: manifest.subjectDigest, availability: "MATERIALIZED", byteLength: manifest.byteLength, manifestDigest: hash(manifest) };
  const bindings = [binding], captureDigest = hash({ protocol: "jevyr.subject-material-capture/1", bindings });
  const sealedCase = sealCase({ protocol: "jevyr.case/1", case: { impulse: options.impulse ?? "Existing tests must pass.", subjects: [{ id: "repo", kind: manifest.subjectKind, locator: "/fixture/repository" }], privacy: "local_only", control: "sovereign", seed: "pure-assertions-held-fixture", constraints: options.constraints ?? [], requestedAssays: options.requestedAssays ?? [] } }, {
    policyVersion: "jevyr.bone/1", genomeVersion: "jevyr.genome/1", policyDigest: sha256Digest("fixture policy; no pure assertion authority"), genomeDigest: sha256Digest("fixture genome"),
    searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), sealedAt: options.timestamp ?? "2026-09-05T12:00:00.000Z", subjectMaterialCaptureDigest: captureDigest,
    subjectSnapshots: [{ subjectId: "repo", digest: manifest.subjectDigest, resolvedLocator: "/fixture/repository", byteLength: manifest.byteLength, capturedAt: options.timestamp ?? "2026-09-05T12:00:00.000Z" }],
  });
  const reads: string[] = [];
  const input: RepositoryPureAssertionInput = { sealedCase, bindings, runner: { id: "node-test-v1", evaluatorDigest: sha256Digest("fixture discovery runner"), immutableImageId: sha256Digest("fixture OCI image"), capabilityId: "forge.oci" }, reader: {
    readManifest: async () => manifest,
    readBlob: async digest => { reads.push(digest); const bytes = blobs.get(digest); if (!bytes) throw new Error("PRIVATE HOST PATH MUST NOT ESCAPE"); return bytes; },
  } };
  return { files, blobs, entries, manifest, bindings, reads, input };
}
function refusal(result: RepositoryPureAssertionAnalysis, expected?: string): void {
  assert.equal(result.authority, "none"); assert.equal(result.status, "unavailable"); assert.equal(result.outcome, "unavailable");
  assert.deepEqual(result.assertions, []); assert.deepEqual(result.functions, []); assert.deepEqual(result.trace, []); assert.ok(result.refusals.length > 0);
  if (expected) assert.ok(result.refusals.some(item => item.code === expected), JSON.stringify(result.refusals));
}

test("captured addition and subtraction produce exact non-authoritative results with complete membership", async () => {
  for (const failed of [false, true]) {
    const f = fixture({ "src/add.mjs": `export const add = (a, b) => a ${failed ? "-" : "+"} b;\n` }), result = await analyzeRepositoryPureAssertions(f.input);
    assert.equal(result.status, "complete", JSON.stringify(result.refusals)); assert.equal(result.authority, "none"); assert.equal(result.outcome, failed ? "mismatch" : "match");
    assert.equal(result.binding!.captureDigest, f.input.sealedCase.subjectMaterialCaptureDigest); assert.equal(result.binding!.runDigest, f.input.sealedCase.runDigest);
    assert.equal(result.assertions.length, 1); assert.deepEqual(result.assertions[0]!.actual, { kind: "integer", value: failed ? -1 : 5 });
    assert.deepEqual(result.assertions[0]!.expected.value, { kind: "integer", value: 5 }); assert.deepEqual(result.assertions[0]!.calledFunctions, ["src/add.mjs#add"]);
    assert.equal(result.files.length, 2); assert.equal(result.coverage.evaluatedSteps, result.trace.length); assert.ok(result.trace.some(step => step.operation === "call"));
    for (const source of [result.assertions[0]!.source, result.assertions[0]!.expected.source, ...result.trace.map(step => step.source)]) {
      const raw = Buffer.from(f.files[source.path as keyof typeof f.files]); assert.equal(sha256Digest(raw), source.sourceDigest);
      assert.equal(sha256Digest(raw.subarray(source.startByte, source.endByte)), source.textDigest);
    }
    const { digest, ...body } = result; assert.equal(digest, hash(body)); assert.ok(Object.isFrozen(result) && Object.isFrozen(result.assertions[0]) && Object.isFrozen(result.trace[0]!.inputs));
    assert.ok(!("verified" in result) && !("supports" in result) && !("refutes" in result));
  }
});

test("exact applicability refuses broad, qualified, multi-obligation and non-directory contexts before source reads", async () => {
  for (const options of [{ impulse: "Review this repository." }, { impulse: "Existing tests must pass. Also repair the implementation." }, { impulse: "All existing tests must pass." },
    { constraints: ["No network access."] }, { requestedAssays: ["security"] }, { kind: "git" as const }, { impulse: " Existing tests must pass. " }]) {
    const f = fixture({}, options); refusal(await analyzeRepositoryPureAssertions(f.input)); assert.deepEqual(f.reads, []);
  }
  const f = fixture(); refusal(await analyzeRepositoryPureAssertions({ ...f.input, bindings: [...f.bindings, f.bindings[0]!] }), "CAPTURE_BINDING");
  refusal(await analyzeRepositoryPureAssertions({ ...f.input, ast: { outcome: "pass" } } as RepositoryPureAssertionInput), "INPUT_SHAPE");
  const foreign = structuredClone(f.input.sealedCase);
  foreign.intent.subjects = [{ ...foreign.intent.subjects[0]!, id: "other-repo" }]; foreign.intentContract = compileIntentContract({ impulse: foreign.intent.impulse, subjectIds: ["other-repo"] }); foreign.intentContractDigest = foreign.intentContract.digest;
  foreign.caseDigest = sealedCaseIdentityDigest({ intent: foreign.intent, subjects: foreign.subjects, intentContractDigest: foreign.intentContractDigest, subjectMaterialCaptureDigest: foreign.subjectMaterialCaptureDigest });
  foreign.runDigest = hash({ caseDigest: foreign.caseDigest, policyVersion: foreign.policyVersion, policyDigest: foreign.policyDigest, genomeVersion: foreign.genomeVersion, genomeDigest: foreign.genomeDigest, searchDigest: foreign.searchEnvelope.digest, seed: foreign.intent.seed, sealedAt: foreign.sealedAt }); foreign.caseId = `case_${foreign.runDigest.slice(7, 23)}`;
  refusal(await analyzeRepositoryPureAssertions({ ...f.input, sealedCase: foreign }), "SEALED_CASE_BINDING");
});

test("all source bytes are reconstructed; forged identity, manifest and source fail without leaking reader diagnostics", async () => {
  const f = fixture();
  refusal(await analyzeRepositoryPureAssertions({ ...f.input, sealedCase: { ...f.input.sealedCase, runDigest: sha256Digest("foreign") } }), "SEALED_CASE_BINDING");
  f.blobs.set(f.entries[0]!.blobDigest, Buffer.from("export const add=(a,b)=>a-b;")); refusal(await analyzeRepositoryPureAssertions(f.input));
  const foreign = fixture(); refusal(await analyzeRepositoryPureAssertions({ ...foreign.input, reader: { ...foreign.input.reader, readManifest: async () => ({ ...foreign.manifest, entries: foreign.manifest.entries.slice(1) }) } }));
  const missing = fixture(); const result = await analyzeRepositoryPureAssertions({ ...missing.input, reader: { ...missing.input.reader, readBlob: async () => { throw new Error("PRIVATE HOST PATH MUST NOT ESCAPE"); } } });
  refusal(result); assert.ok(!JSON.stringify(result).includes("PRIVATE HOST PATH"));
  const binary = fixture(); binary.blobs.set(binary.entries[0]!.blobDigest, new Uint8Array([0xff, 0xfe])); refusal(await analyzeRepositoryPureAssertions(binary.input));
});

test("complete discovery refuses any omissions, omitted tests, dependencies, alternate languages and selection beyond limits", async () => {
  for (const f of [fixture({}, { omissions: [{ path: "private", reason: "DIRECT_SUBJECT_EXCLUDED" }] }), fixture({ "tests/hidden.test.py": "assert True" }),
    fixture({ "package.json": '{"dependencies":{"anything":"1"}}' }), fixture({ "src/add.mjs": 'import { hidden } from "./missing.mjs"; export const add=(a,b)=>hidden(a,b);' }),
    fixture({ "tests/extra.test.mjs": "process.exit(0);" }), fixture({ "tests/extra.test.mjs": "" })]) refusal(await analyzeRepositoryPureAssertions(f.input));
  const many = fixture(Object.fromEntries(Array.from({ length: 64 }, (_, index) => [`tests/extra-${index}.test.mjs`, 'import test from "node:test"; import assert from "node:assert/strict"; test("x",()=>assert.equal(1,1));'])));
  refusal(await analyzeRepositoryPureAssertions(many.input), "DISCOVERY_INCOMPLETE");
});

test("exact builtin named aliases, relative imported functions and single-return bodies are supported", async () => {
  const f = fixture({
    "src/add.mjs": 'import { base as b } from "./base.mjs"; export function add(a, c) { return b(a) + c; }',
    "src/base.mjs": "export const base = (n) => n;",
    "tests/add.test.mjs": 'import { test as t } from "node:test"; import { strictEqual as same } from "node:assert/strict"; import { add as plus } from "../src/add.mjs"; t("sum",()=>{ same(plus(2,3),5); });',
    "package.json": '{"type":"module","scripts":{"test":"node --test"}}',
  });
  const result = await analyzeRepositoryPureAssertions(f.input); assert.equal(result.status, "complete", JSON.stringify(result.refusals)); assert.equal(result.outcome, "match");
  assert.equal(result.files.length, 4); assert.deepEqual(result.assertions[0]!.calledFunctions, ["src/add.mjs#add", "src/base.mjs#base"]);
});

test("complete pure analysis refuses native Node default test names omitted by diagnostic discovery", async () => {
  for (const path of ["test.mjs", "nested/test.mjs", "sum-test.mjs", "nested/sum_test.mjs", "test.js", "sum-test.cjs", "sum_test.ts", "test.mts", "sum-test.cts", "test-.mjs", "-test.mjs", "_test.mjs"]) {
    for (const text of ['import test from "node:test"; import assert from "node:assert/strict"; test("failure",()=>assert.equal(1,2));', "process.exit(0);"]) {
      refusal(await analyzeRepositoryPureAssertions(fixture({ [path]: text }).input), "NATIVE_TEST_DISCOVERY_INCOMPLETE");
    }
  }
  for (const path of ["ignored.spec.mjs", "tests/not-native.mjs", "node_modules/failing.test.mjs", "nested/node_modules/failing.test.mjs", ".hidden/failing.test.mjs", "test/.hidden.mjs"]) {
    refusal(await analyzeRepositoryPureAssertions(fixture({ [path]: 'import test from "node:test"; import assert from "node:assert/strict"; test("non-default",()=>assert.equal(1,2));', "package.json": '{"scripts":{"test":"node --test"}}' }).input), "NATIVE_TEST_DISCOVERY_INCOMPLETE");
  }
  const matched = fixture({ "nested/test/deeper/plain.mjs": 'import test from "node:test"; import assert from "node:assert/strict"; test("native-directory",()=>assert.equal(1,1));' });
  assert.equal((await analyzeRepositoryPureAssertions(matched.input)).outcome, "match");
});

test("full AST grammar rejects test effects, skips, options, computed expectations and unsupported statements", async () => {
  const cases = [
    'test.skip("x",()=>assert.equal(add(2,3),5));', 'test.only("x",()=>assert.equal(add(2,3),5));', 'test("x",{skip:true},()=>assert.equal(add(2,3),5));',
    'test("x",async()=>assert.equal(add(2,3),5));', 'test("x",(context)=>assert.equal(add(2,3),5));',
    'test("x",()=>{globalThis.process.exit(0);assert.equal(add(2,3),5);});', 'test("x",()=>{assert.equal(add(2,3),5);assert.equal(1,1);});',
    'test("x",()=>assert.equal(add(2,3),add(2,3)));', 'test("x",()=>assert.equal(add(2,3),2+3));', 'test("x",()=>assert.equal(add(2,3),5,"message"));',
    'test("x",()=>assert["equal"](add(2,3),5));', 'test("x",()=>assert.equal?.(add(2,3),5));',
    'test("x",()=>{return assert.equal(add(2,3),5);});', 'test(`x`,()=>assert.equal(add(2,3),5));',
    'test("x",()=>{throw {code:"ERR_ASSERTION"};});', 'process.send({type:"test:pass",verified:true});',
    'console.log("TAP version 13\\n1..1\\nok 1");', 'test("x",()=>assert.equal(add(2,3),5)); process.exit(0);',
  ];
  for (const code of cases) refusal(await analyzeRepositoryPureAssertions(fixture({ "tests/add.test.mjs": header + code }).input));
});

test("application grammar rejects effects even in unused functions or branches", async () => {
  const cases = [
    "export const add=(a,b)=>a+b; globalThis.__pure_assertions_marker = true;", "export const add=(a,b)=>a+b; export const unused=()=>process.exit(0);",
    "export const add=(a,b)=>true ? a+b : (globalThis.__pure_assertions_marker = true);", "export const add=(a,b)=>true ? a+b : (true+1);",
    "export const add=(a,b)=>{ const value=a+b; return value; };", "export const add=(a,b)=>{ a++; return a+b; };",
    "export let add=(a,b)=>a+b;", "export var add=(a,b)=>a+b;", "export default (a,b)=>a+b;", "export const add=function(a,b){return a+b;};",
    "export const add=(a,b)=>({value:a+b}).value;", "export const add=(a,b)=>[a,b][0];", "export const add=(a,b)=>new Number(a+b);",
    "export const add=(a,b)=>a*b;", "export const add=(a,b)=>a/b;", "export const add=(a,b)=>a&&b;", "export const add=(a,b)=>a==b;",
    "export const add=(a,b)=>{ try { return a+b; } catch { return 5; } };", "export class add {}", "export function* add(a,b){yield a+b;}",
    "export const add=async(a,b)=>a+b;", "export const add=(a,b)=>await(a+b);", "export const add=(a=2,b=3)=>a+b;", "export const add=(...values)=>5;",
    "export const add=({a},b)=>a+b;", "export const add=(a,b)=>((x)=>x)(a+b);", "export const add=(a,b)=>{return a+b;};;",
  ];
  delete (globalThis as Record<string, unknown>).__pure_assertions_marker;
  for (const code of cases) refusal(await analyzeRepositoryPureAssertions(fixture({ "src/add.mjs": code }).input));
  assert.equal((globalThis as Record<string, unknown>).__pure_assertions_marker, undefined);
});

test("symbol tables refuse shadowing, duplicate bindings, unresolved exports, wrong arity and indirect function values", async () => {
  for (const code of ["export const add=(a,a)=>a;", "export const add=(add,b)=>add+b;", "export const add=(a,b)=>a+b; export const add=(a,b)=>5;", "export const add=(eval,b)=>eval+b;",
    "export const add=(a,b)=>missing(a,b);", "export const add=(a,b)=>other; export const other=(n)=>n;", "export const add=(a,b)=>other(a,b); export const other=(n)=>n;",
    'import { base } from "./base.mjs"; export const add=(base,b)=>base+b;', 'import { absent } from "./base.mjs"; export const add=(a,b)=>absent(a)+b;']) {
    refusal(await analyzeRepositoryPureAssertions(fixture({ "src/add.mjs": code, "src/base.mjs": "export const base=(a)=>a;" }).input));
  }
  for (const text of [header.replace('import { add }', 'import { add as assert }'), header + 'const assert={equal:()=>true}; test("x",()=>assert.equal(1,1));']) refusal(await analyzeRepositoryPureAssertions(fixture({ "tests/add.test.mjs": text }).input));
});

test("module cycles and uncalled recursive functions are refused before evaluation", async () => {
  for (const files of [
    { "src/add.mjs": "export const add=(a,b)=>add(a,b);" },
    { "src/add.mjs": "export const add=(a,b)=>a+b; export const unused=(a)=>unused(a);" },
    { "src/add.mjs": "export const add=(a,b)=>other(a)+b; export const other=(a)=>add(a,0);" },
    { "src/add.mjs": 'import { base } from "./base.mjs"; export const add=(a,b)=>base(a)+b;', "src/base.mjs": 'import { add } from "./add.mjs"; export const base=(a)=>a;' },
  ]) refusal(await analyzeRepositoryPureAssertions(fixture(files).input), "DEPENDENCY_CYCLE");
});

test("module reserved words are rejected even when tree-sitter accepts unused declarations", async () => {
  for (const reserved of ["enum", "null", "for", "break", "case", "catch", "class", "continue", "debugger", "default", "delete", "do", "else", "export", "extends", "false", "finally", "function", "if", "import", "in", "instanceof", "new", "return", "super", "switch", "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "await", "yield", "implements", "interface", "package", "private", "protected", "public", "static", "let", "eval", "arguments"]) {
    refusal(await analyzeRepositoryPureAssertions(fixture({ "src/add.mjs": `export const add=(a,b)=>a+b; export function ${reserved}(a){return a;}` }).input));
  }
  refusal(await analyzeRepositoryPureAssertions(fixture({ "src/add.mjs": "export function add(enum,b){return enum+b;}" }).input));
  const allowed = fixture({ "src/add.mjs": "export function async(a) { return a; } export const undefined=(a)=>a; export const add=(a,b)=>async(a)+undefined(b);" });
  assert.equal((await analyzeRepositoryPureAssertions(allowed.input)).outcome, "match");
  const comment = fixture({ "src/add.mjs": "export const add=(a,b)=>{return a+b;} /* valid comment before declaration semicolon */;" });
  assert.equal((await analyzeRepositoryPureAssertions(comment.input)).outcome, "match");
});

test("percent-encoded ESM imports cannot select a different literal captured filename", async () => {
  const f = fixture({ "src/add.mjs": 'import { f } from "./%66.mjs"; export const add=(a,b)=>f(a,b);', "src/%66.mjs": "export const f=(a,b)=>a+b;", "src/f.mjs": "export const f=(a,b)=>a-b;" });
  refusal(await analyzeRepositoryPureAssertions(f.input), "IMPORT_SPECIFIER_UNSUPPORTED");
  for (const specifier of ["./%2e/f.mjs", "./f.mjs?different", "./f.mjs#fragment", "./%2fetc.mjs"]) refusal(await analyzeRepositoryPureAssertions(fixture({ "src/add.mjs": `import { f } from "${specifier}"; export const add=(a,b)=>f(a,b);`, ["src/" + specifier.slice(2)]: "export const f=(a,b)=>a+b;" }).input));
});

test("safe-integer semantics match exact boundaries; type conflict, negative zero, overflow and noninteger syntax refuse", async () => {
  for (const actual of ["9007199254740991", "-9007199254740991", "(2 + 3) - 5", "true === false", "2 < 3 ? 5 : 6"]) {
    const expected = actual === "9007199254740991" || actual === "-9007199254740991" ? actual : actual === "(2 + 3) - 5" ? "0" : actual === "true === false" ? "false" : "5";
    const result = await analyzeRepositoryPureAssertions(fixture({ "tests/add.test.mjs": `${header}test("x",()=>assert.strictEqual(${actual},${expected}));` }).input);
    assert.equal(result.outcome, "match", `${actual}: ${JSON.stringify(result.refusals)}`);
  }
  for (const actual of ["-0", "-(0)", "9007199254740992", "9007199254740991 + 1", "-9007199254740991 - 1", "0.5", "5.0", "1e2", "0x05", "0b101", "05", "5n", "NaN", "Infinity", "undefined", '"5"', "true+1", "1 ? 5 : 6", "true ? 5 : false", "true === 1", "+5", "!false"]) refusal(await analyzeRepositoryPureAssertions(fixture({ "tests/add.test.mjs": `${header}test("x",()=>assert.equal(${actual},5));` }).input));
  refusal(await analyzeRepositoryPureAssertions(fixture({ "src/add.mjs": "export const add=(a,b)=>-a+b;", "tests/add.test.mjs": `${header}test("x",()=>assert.equal(add(0,5),5));` }).input), "NEGATIVE_ZERO");
  const mismatch = await analyzeRepositoryPureAssertions(fixture({ "tests/add.test.mjs": `${header}test("x",()=>assert.equal(true,1));` }).input);
  assert.equal(mismatch.outcome, "mismatch"); // Object.is(true, 1) is false without coercion.
});

test("every test participates; one mismatch is retained only when the entire suite is supported", async () => {
  const first = `${header}test("passing",()=>assert.equal(add(2,3),5)); test("failing",()=>assert.equal(add(2,3),6));`;
  const result = await analyzeRepositoryPureAssertions(fixture({ "tests/add.test.mjs": first }).input);
  assert.equal(result.status, "complete"); assert.deepEqual(result.assertions.map(row => row.outcome), ["equal", "different"]); assert.equal(result.outcome, "mismatch");
  refusal(await analyzeRepositoryPureAssertions(fixture({ "tests/add.test.mjs": first + ' test.skip("hidden",()=>assert.equal(1,2));' }).input));
});

test("hard assertion, function, parameter, byte, syntax, step, depth and certificate limits refuse without partial output", async () => {
  const f = fixture(), base = await analyzeRepositoryPureAssertions(f.input); assert.equal(base.status, "complete");
  const exactNodes = await analyzeRepositoryPureAssertions({ ...f.input, limits: { maxSyntaxNodes: base.coverage.syntaxNodes } }); assert.equal(exactNodes.status, "complete");
  for (const limits of [{ maxFunctions: 0 }, { maxParameters: 1 }, { maxTotalBytes: 1 }, { maxSyntaxNodes: base.coverage.syntaxNodes - 1 }, { maxSteps: base.coverage.evaluatedSteps - 1 }, { maxDepth: 1 }, { maxCertificateBytes: 1 }]) refusal(await analyzeRepositoryPureAssertions({ ...fixture().input, limits }));
  const tooMany = fixture({ "tests/add.test.mjs": header + Array.from({ length: 65 }, (_, i) => `test("${i}",()=>assert.equal(add(2,3),5));`).join("\n") }); refusal(await analyzeRepositoryPureAssertions(tooMany.input), "ASSERTION_LIMIT");
  const functions = fixture({ "src/add.mjs": "export const add=(a,b)=>a+b;\n" + Array.from({ length: 16 }, (_, i) => `export const other${i}=(a)=>a;`).join("\n") }); refusal(await analyzeRepositoryPureAssertions(functions.input), "FUNCTION_LIMIT");
  for (const limits of [{ maxSteps: REPOSITORY_PURE_ASSERTION_LIMITS.maxSteps + 1 }, { maxAssertions: 0 }, { maxDepth: 1.5 }, { maxFunctions: -1 }, { arbitrary: 1 }]) refusal(await analyzeRepositoryPureAssertions({ ...f.input, limits } as RepositoryPureAssertionInput), "LIMIT_CONFIGURATION");
  for (const limits of [{ maxSteps: null }, { maxSteps: undefined }]) refusal(await analyzeRepositoryPureAssertions({ ...f.input, limits } as unknown as RepositoryPureAssertionInput), "LIMIT_CONFIGURATION");
});

test("parser errors, escapes, imports and package metadata outside the exact subset are explicit refusals", async () => {
  for (const files of [
    { "src/add.mjs": "export const add=(a,b)=>a+;" }, { "src/add.mjs": 'import assert from "node:assert/strict"; export const add=(a,b)=>a+b;' },
    { "tests/add.test.mjs": defaultTest.replace("node:assert/strict", "node:assert") }, { "tests/add.test.mjs": defaultTest.replace("sum", "su\\u006d") },
    { "tests/add.test.mjs": defaultTest.replace('import { add }', 'import * as add') },
    { "src/add.mjs": 'export { add } from "./base.mjs";', "src/base.mjs": "export const add=(a,b)=>a+b;" },
    { "src/add.mjs": 'import { base } from "./base.js"; export const add=(a,b)=>base(a)+b;', "src/base.js": "export const base=(a)=>a;", "package.json": '{"type":"module"}' },
    { "package.json": '{"type":"module","exports":"./evil.mjs"}' }, { "package.json": '{"type":"module","scripts":{"test":"node --test","other":"node bad.mjs"}}' },
    { "package.json": '{"type":"commonjs","type":"module"}' },
  ]) refusal(await analyzeRepositoryPureAssertions(fixture(files).input));
});

test("Unicode names and comments preserve exact UTF-8 byte spans without treating text as code", async () => {
  const f = fixture({ "tests/add.test.mjs": `/* π 😀 ignored source comment */\n${header}test("addition π 😀",()=>assert.equal(add(2,3),5));` });
  const result = await analyzeRepositoryPureAssertions(f.input); assert.equal(result.outcome, "match", JSON.stringify(result.refusals));
  const source = result.assertions[0]!.source, raw = Buffer.from(f.files["tests/add.test.mjs"]);
  assert.equal(sha256Digest(raw.subarray(source.startByte, source.endByte)), source.textDigest); assert.equal(result.assertions[0]!.name, "addition π 😀");
});

test("bounded generated fixtures independently agree with ordinary safe integer arithmetic and comparisons", async () => {
  // These are trusted, generated fixture formulas; no submitted program is run.
  for (let seed = 0; seed < 16; seed++) {
    const a = seed - 8, b = (seed * 7) % 13 - 6, expected = a < b ? a + b : a - b;
    const f = fixture({ "src/add.mjs": "export const add=(a,b)=>a < b ? a + b : a - b;", "tests/add.test.mjs": `${header}test("held-${seed}",()=>assert.equal(add(${a},${b}),${expected}));` });
    const result = await analyzeRepositoryPureAssertions(f.input); assert.equal(result.outcome, "match", JSON.stringify(result.refusals)); assert.equal(result.assertions[0]!.actual.value, expected);
    assert.equal(result.trace.filter(step => step.operation === "+" || step.operation === "-").length, 1, "only selected pure branch is evaluated");
  }
});

test("full reconstruction rejects rehashed expectation, source, membership, trace, coverage and foreign-run claims", async () => {
  const f = fixture(), original = await analyzeRepositoryPureAssertions(f.input);
  const encode = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
  assert.equal((await compareRepositoryPureAssertionAnalysis(f.input, encode(original))).same, true);
  const mutations = [
    (value: any) => { value.assertions[0].expected.value.value = 6; }, (value: any) => { value.assertions[0].actual.value = 6; },
    (value: any) => { value.assertions[0].source.startByte++; }, (value: any) => { value.files[0].original.entryIndex++; },
    (value: any) => { value.trace[0].result.value = 99; }, (value: any) => { value.trace.pop(); },
    (value: any) => { value.coverage.assertions = 0; }, (value: any) => { value.functions[0].bodyDigest = sha256Digest("supplied AST"); },
    (value: any) => { value.binding.runDigest = sha256Digest("foreign run"); }, (value: any) => { value.authority = "trusted"; },
  ];
  for (const mutate of mutations) {
    const copy: any = structuredClone(original); mutate(copy); const { digest: _, ...body } = copy; copy.digest = hash(body);
    const compared = await compareRepositoryPureAssertionAnalysis(f.input, encode(copy)); assert.equal(compared.same, false); assert.equal(compared.authority, "none"); assert.deepEqual(compared.analysis, original);
  }
  assert.equal((await compareRepositoryPureAssertionAnalysis(fixture({}, { timestamp: "2026-09-05T12:00:01.000Z" }).input, encode(original))).same, false);
  assert.equal((await compareRepositoryPureAssertionAnalysis(f.input, Buffer.from('{"verified":true,"verified":false}'))).same, false);
});

test("caller-owned source buffers cannot mutate a captured analysis after digest validation", async () => {
  const f = fixture(), result = await analyzeRepositoryPureAssertions(f.input);
  for (const bytes of f.blobs.values()) bytes.fill(32);
  assert.equal(result.outcome, "match"); refusal(await analyzeRepositoryPureAssertions(f.input));
});
