import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sealCase } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/repository.js";
import { analyzeRepositoryPureAssertions, type RepositoryPureAssertionInput } from "../src/repository-pure-assertions.js";
import { inspectLocalDockerImage, sealDockerSubstrateIdentity, SealedForgeAdapter } from "../src/forge.js";
import { decodeExactByteCapture, encodeToolObservation } from "../src/evidence-artifacts.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const encoded = (value: unknown) => Buffer.from(canonicalize(value as JsonValue));
const MAX = "9007199254740991";
// Fixed before execution: no random seeds, adaptive replacement, model output or host evaluation.
const GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  ["addition", [["0 + 0", "0"], ["1 + 2", "3"], ["(-5) + 3", "-2"], ["10 + (-10)", "0"],
    [`${MAX} + 0`, MAX], [`9007199254740990 + 1`, MAX], [`(-${MAX}) + 1`, "-9007199254740990"], ["-7 + (-8)", "-15"]]],
  ["subtraction", [["0 - 0", "0"], ["3 - 8", "-5"], ["-5 - (-2)", "-3"], [`${MAX} - 1`, "9007199254740990"],
    [`-${MAX} - 0`, `-${MAX}`], ["-9007199254740990 - 1", `-${MAX}`], ["7 - (-8)", "15"], ["9007199254740989 - 9007199254740987", "2"]]],
  ["ordering", [["0 < 1", "true"], ["1 < 0", "false"], ["-3 <= -3", "true"], [`${MAX} <= ${MAX}`, "true"],
    [`-${MAX} > ${MAX}`, "false"], [`${MAX} > 9007199254740990`, "true"], ["-5 >= -4", "false"], ["0 >= 0", "true"]]],
  ["equality", [["3 === 3", "true"], ["3 === 4", "false"], ["true === false", "false"], ["false === false", "true"],
    ["3 !== 4", "true"], ["3 !== 3", "false"], ["true !== false", "true"], ["false !== false", "false"]]],
  ["conditional", [["true ? 7 : 9", "7"], ["false ? 7 : 9", "9"], ["(2 < 3) ? -5 : 6", "-5"], [`(${MAX} === ${MAX}) ? ${MAX} : 0`, MAX],
    ["(3 !== 3) ? true : false", "false"], ["(false !== false) ? false : true", "true"], [`(0 > 1) ? (-${MAX}) : (-9007199254740990)`, "-9007199254740990"], ["(-2 >= -2) ? (4 - 1) : (8 + 1)", "3"]]],
  ["nested-expression", [["(2 + 3) - (4 - 1)", "2"], ["(-4 + 8) + (3 - 9)", "-2"], [`(${MAX} - 9007199254740988) + 2`, "5"], ["true ? (false ? 1 : 2) : 3", "2"],
    ["(2 + 3) === (8 - 3)", "true"], ["((-3 + 5) < (7 - 2)) ? (1 + 2) : (3 + 4)", "3"], ["(-(5 - 2)) + 8", "5"], ["(true === false) !== (false === false)", "true"]]],
  ["function-call", [["add(2, 3)", "5"], ["subtract(2, 3)", "-1"], ["min(3, -4)", "-4"], ["max(-3, 4)", "4"],
    [`identity(${MAX})`, MAX], ["chooseInt(true, 2, 9)", "2"], ["equalBool(true, false)", "false"], ["bump(9007199254740990)", MAX]]],
  ["nested-call", [["subtract(add(2, 3), 1)", "4"], ["add(min(-3, 4), max(2, 7))", "4"], ["chooseInt(less(1, 2), add(3, 4), subtract(8, 2))", "7"], ["equalInt(identity(4), bump(3))", "true"],
    ["max(min(8, 3), subtract(7, 5))", "3"], ["identity(chooseInt(false, min(3, 4), max(-2, -1)))", "-1"], ["add(twice(3), subtract(9, 4))", "11"], ["chooseBool(equalBool(true, true), less(-2, -1), false)", "true"]]],
];
const FORMULAS = Object.freeze(GROUPS.flatMap(([group, formulas]) => formulas.map(([expression, expected], index) =>
  Object.freeze({ id: `${group}-${index + 1}`, group, expression, expectedLiteral: expected }))));
const FUNCTIONS = [
  "export const add = (a, b) => a + b;", "export const subtract = (a, b) => a - b;",
  "export const min = (a, b) => a < b ? a : b;", "export const max = (a, b) => a > b ? a : b;",
  "export const identity = (a) => a;", "export const chooseInt = (condition, a, b) => condition ? a : b;",
  "export const equalBool = (a, b) => a === b;", "export const bump = (a) => add(a, 1);",
  "export const less = (a, b) => a < b;", "export const equalInt = (a, b) => a === b;",
  "export const twice = (a) => add(a, a);", "export const chooseBool = (condition, a, b) => condition ? a : b;",
].join("\n") + "\n";
const NAMES = "add, subtract, min, max, identity, chooseInt, equalBool, bump, less, equalInt, twice, chooseBool";
const REFUSALS = Object.freeze([
  { id: "negative-zero", expression: "-0", code: "NEGATIVE_ZERO" },
  { id: "unsafe-integer", expression: `${MAX} + 1`, code: "UNSAFE_INTEGER" },
  { id: "type-conflict", expression: "true + 1", code: "TYPE_DOMAIN_CONFLICT" },
]);
const testSource = (formulas: readonly { id: string; expression: string; expectedLiteral: string }[]) =>
  `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { ${NAMES} } from "../src/functions.mjs";\n`
  + formulas.map(row => `test(${JSON.stringify(row.id)}, () => assert.strictEqual((${row.expression}), ${row.expectedLiteral}));`).join("\n") + "\n";
const TESTS = testSource(FORMULAS);
// This program receives neither the analyzer result nor an AST. Only these trusted generated formulas are executable.
const DRIVER = `import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ${NAMES} } from "./fixture/src/functions.mjs";
const typed = value => { if (typeof value === "boolean") return { kind: "boolean", value }; if (typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0)) return { kind: "integer", value }; throw new Error("Generated fixture left the declared value domain"); };
const rows = [${FORMULAS.map(row => `{id:${JSON.stringify(row.id)},actual:typed((${row.expression}))}`).join(",\n")}];
const sources = ["fixture/src/functions.mjs", "fixture/tests/formulas.test.mjs"].map(path => { const bytes = readFileSync(new URL(path, import.meta.url)); return { path, byteLength: bytes.length, digest: "sha256:" + createHash("sha256").update(bytes).digest("hex") }; });
process.stdout.write(JSON.stringify({ protocol: "jevyr.trusted-numeric-driver-output/1", nodeVersion: process.version, rows, sources }) + "\\n");
`;

function analyzerFixture(tests: string, imageId: string) {
  const files = { "src/functions.mjs": FUNCTIONS, "tests/formulas.test.mjs": tests };
  const blobs = new Map<string, Buffer>();
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, source]) => {
    const bytes = Buffer.from(source), blobDigest = sha256Digest(bytes); blobs.set(blobDigest, bytes);
    return { path, blobDigest, byteLength: bytes.length, mode: 0o444 };
  });
  const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "fixture", subjectKind: "directory",
    subjectDigest: hash(entries), availability: "MATERIALIZED", byteLength: entries.reduce((sum, item) => sum + item.byteLength, 0),
    entries, directories: ["src", "tests"], omissions: [] };
  const binding: SubjectMaterialBinding = { subjectId: manifest.subjectId, subjectKind: manifest.subjectKind, subjectDigest: manifest.subjectDigest,
    availability: "MATERIALIZED", manifestDigest: hash(manifest), byteLength: manifest.byteLength };
  const bindings = [binding], captureDigest = hash({ protocol: "jevyr.subject-material-capture/1", bindings });
  const sealedCase = sealCase({ protocol: "jevyr.case/1", case: { impulse: "Existing tests must pass.", privacy: "local_only", control: "sovereign",
    seed: "64".repeat(32), subjects: [{ id: "fixture", kind: "directory", locator: "/trusted-generated-numeric-fixture" }] } }, {
    policyVersion: "jevyr.bone/1", genomeVersion: "jevyr.genome/1", policyDigest: sha256Digest("numeric differential fixture; no evaluator authority"),
    genomeDigest: sha256Digest("fixed generated numeric fixture"), searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
    sealedAt: "2026-09-05T12:00:00.000Z", subjectMaterialCaptureDigest: captureDigest,
    subjectSnapshots: [{ subjectId: "fixture", digest: manifest.subjectDigest, resolvedLocator: "/trusted-generated-numeric-fixture",
      byteLength: manifest.byteLength, capturedAt: "2026-09-05T12:00:00.000Z" }],
  });
  const input: RepositoryPureAssertionInput = { sealedCase, bindings, runner: { id: "node-test-v1", evaluatorDigest: sha256Digest(DRIVER),
    immutableImageId: imageId, capabilityId: "forge.oci" }, reader: {
    readManifest: async requested => { assert.deepEqual(requested, binding); return structuredClone(manifest); },
    readBlob: async (digest, length) => { const bytes = blobs.get(digest); assert.ok(bytes); assert.equal(bytes.length, length); return Buffer.from(bytes); },
  } };
  return { input, files, manifest, bindings, captureDigest };
}

test("opt-in Node24 Docker differential: 64 trusted generated formulas and separate domain refusals", {
  skip: process.env.JEVYR_TEST_PURE_NUMERIC_DOCKER !== "1", timeout: 120_000,
}, async () => {
  assert.equal(FORMULAS.length, 64); assert.equal(new Set(FORMULAS.map(row => row.id)).size, 64);
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const retained = await mkdtemp(join(repositoryRoot, "artifacts", `repository-pure-numeric-differential-${Date.now()}-`));
  const artifacts: { name: string; digest: string; byteLength: number }[] = [];
  const persist = async (name: string, bytes: Buffer) => {
    const path = join(retained, ...name.split("/")); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); artifacts.push({ name, digest: sha256Digest(bytes), byteLength: bytes.length });
  };
  const json = async (name: string, value: unknown) => await persist(name, encoded(value));
  const sourcePaths = ["packages/runtime/src/repository-pure-assertions.ts", "packages/runtime/src/repository-evaluation-plan.ts",
    "packages/runtime/src/repository-evaluation-closure.ts", "packages/runtime/src/forge.ts", "packages/runtime/src/evidence-artifacts.ts",
    "packages/runtime/test/repository-pure-numeric-differential.test.ts"];
  const sourceIdentity = async () => await Promise.all(sourcePaths.map(async path => ({ path, digest: sha256Digest(await readFile(join(repositoryRoot, path))) })));
  const before = await sourceIdentity(); await json("implementation-before.json", before);
  await json("predeclared-corpus.json", { protocol: "jevyr.pure-numeric-corpus/1", formulas: FORMULAS, refusals: REFUSALS,
    scope: "trusted generated supported integer/boolean formulas only; no arbitrary repository authority", repeatedAttempts: 0 });
  const report: Record<string, unknown> = { protocol: "jevyr.pure-numeric-differential/1", mode: "source", importCondition: "development",
    authority: "none", scope: "interpreter differential semantics only", plannedFormulas: 64, plannedRefusals: 3,
    status: "FAIL", artifactDirectory: retained, artifacts, ordinaryRepositoryExecution: false, modelInference: false, signedCaseProof: false };
  let temporary: string | undefined;
  try {
    const image = sealDockerSubstrateIdentity("node:24-alpine", inspectLocalDockerImage({ dockerCommand: "docker", requestedReference: "node:24-alpine" }), "local-docker-cli");
    report.image = image; await json("image-identity.json", image);
    assert.equal(image.status, "resolved", "Opt-in test requires the existing local image; it never pulls"); assert.ok(image.immutableImageId);
    const fixture = analyzerFixture(TESTS, image.immutableImageId);
    await json("sealed-fixture.json", fixture.input.sealedCase); await json("capture.json", { protocol: "jevyr.subject-material-capture/1", bindings: fixture.bindings, captureDigest: fixture.captureDigest });
    await json("manifest.json", fixture.manifest);
    const packageFiles = { "driver.mjs": DRIVER, "fixture/src/functions.mjs": FUNCTIONS, "fixture/tests/formulas.test.mjs": TESTS };
    for (const [path, source] of Object.entries(packageFiles)) await persist(`package/${path}`, Buffer.from(source));
    const entries = [...["fixture", "fixture/src", "fixture/tests"].map(path => ({ path, type: "directory" })),
      ...Object.entries(packageFiles).map(([path, source]) => ({ path, type: "file", digest: sha256Digest(source), byteLength: Buffer.byteLength(source) }))].sort((a, b) => a.path < b.path ? -1 : 1);
    const packageDescriptor = { protocol: "jevyr.trusted-numeric-package/1", entries, driverDigest: sha256Digest(DRIVER), corpusDigest: hash(FORMULAS),
      originalCaptureDigest: fixture.captureDigest, forgeTreeDigest: hash({ protocol: "jevyr.directory-manifest/1", entries }) };
    const packageDigest = hash(packageDescriptor); await json("package-descriptor.json", { ...packageDescriptor, digest: packageDigest });
    const analysis = await analyzeRepositoryPureAssertions(fixture.input); await json("analysis.json", analysis);
    const controls = [];
    for (const control of REFUSALS) {
      const source = testSource([{ ...control, expectedLiteral: "0" }]);
      await persist(`refusals/${control.id}.test.mjs`, Buffer.from(source));
      const result = await analyzeRepositoryPureAssertions(analyzerFixture(source, image.immutableImageId).input);
      await json(`refusals/${control.id}.analysis.json`, result);
      controls.push({ ...control, status: result.status, authority: result.authority, actualCodes: result.refusals.map(item => item.code),
        correct: result.status === "unavailable" && result.assertions.length === 0 && result.refusals.some(item => item.code === control.code) });
    }
    report.refusals = controls;
    temporary = await mkdtemp(join(tmpdir(), "jevyr-pure-numeric-"));
    const subjectRoot = join(temporary, "subject"), sourceRoot = join(temporary, "tooling"); await mkdir(subjectRoot); await mkdir(sourceRoot);
    for (const [path, source] of Object.entries(packageFiles)) { const destination = join(subjectRoot, ...path.split("/")); await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, source, { flag: "wx", mode: 0o444 }); }
    const forge = new SealedForgeAdapter({ mode: "docker", dockerImage: image.requestedReference, dockerSubstrateIdentity: image, allowNetwork: false,
      maxFileBytes: 256 * 1024, maxFiles: 16, maxProcessOutputBytes: 128 * 1024, maxWritableBytes: 1024 * 1024, maxWritableInodes: 128 });
    const observation = await forge.execute({ invocationId: "trusted_numeric_differential_64", caseId: fixture.input.sealedCase.caseId, tool: "forge.command",
      args: { command: "node", args: ["/subject/driver.mjs"] }, timeoutMs: 30_000, signal: AbortSignal.timeout(35_000),
      resourceLimits: { maxArtifactBytes: 2 * 1024 * 1024, maxWritableBytes: 1024 * 1024, maxWritableInodes: 128 },
      forgeMaterials: { protocol: "jevyr.forge-invocation-materials/2", workspace: { role: "empty-tooling", sourceRoot }, subjects: { subjectRoot, captureDigest: packageDigest, materializationDigest: packageDigest } } });
    await persist("forge-observation.json", Buffer.from(encodeToolObservation(observation).bytes));
    report.physicalInvocations = 1; report.execution = observation.oracle?.execution ?? null;
    const execution = observation.oracle?.execution; assert.ok(execution?.stdoutCapture && execution.stderrCapture);
    const stdout = decodeExactByteCapture(execution.stdoutCapture), stderr = decodeExactByteCapture(execution.stderrCapture);
    await persist("stdout.bin", Buffer.from(stdout.bytes)); await persist("stderr.bin", Buffer.from(stderr.bytes));
    assert.equal(observation.status, "succeeded"); assert.equal(execution.mode, "docker"); assert.equal(execution.state, "exited"); assert.equal(execution.exitCode, 0);
    assert.equal(execution.outputTruncated, false); assert.equal(execution.stdoutCapture.complete, true); assert.equal(execution.stderrCapture.complete, true); assert.equal(stderr.bytes.length, 0);
    const boundary = observation.oracle!.subjectBoundary!;
    assert.equal(boundary.sealedSubjectReadOnly, true); assert.equal(boundary.complete, true); assert.equal(boundary.originalSubjectAccessible, false);
    assert.equal(boundary.beforeDigest, packageDescriptor.forgeTreeDigest); assert.equal(boundary.afterDigest, packageDescriptor.forgeTreeDigest);
    assert.equal(boundary.captureDigest, packageDigest); assert.equal(boundary.materializationDigest, packageDigest);
    assert.equal(observation.oracle!.toolingWorkspace?.initialEntries, 0);
    assert.equal(typeof stdout.text, "string");
    const native = JSON.parse(stdout.text!) as { protocol: string; nodeVersion: string; rows: { id: string; actual: unknown }[]; sources: unknown[] };
    assert.equal(native.protocol, "jevyr.trusted-numeric-driver-output/1"); assert.match(native.nodeVersion, /^v24\./);
    assert.deepEqual(native.sources, Object.entries(fixture.files).map(([path, source]) => ({ path: `fixture/${path}`, byteLength: Buffer.byteLength(source), digest: sha256Digest(source) })));
    assert.equal(native.rows.length, 64); assert.deepEqual(native.rows.map(row => row.id), FORMULAS.map(row => row.id));
    const byName = new Map(analysis.assertions.map(row => [row.name, row.actual]));
    const comparisons = native.rows.map(row => ({ id: row.id, nodeActual: row.actual, analyzerActual: byName.get(row.id) ?? null,
      equal: canonicalize(row.actual as JsonValue) === canonicalize((byName.get(row.id) ?? null) as JsonValue) }));
    await json("comparisons.json", comparisons); report.comparedFormulas = comparisons.length; report.matchingFormulas = comparisons.filter(row => row.equal).length;
    report.nodeVersion = native.nodeVersion; report.analyzerStatus = analysis.status; report.analyzerOutcome = analysis.outcome;
    const unchanged = await Promise.all(Object.entries(packageFiles).map(async ([path, source]) => ({ path, expected: sha256Digest(source), actual: sha256Digest(await readFile(join(subjectRoot, ...path.split("/")))) })));
    await json("package-after.json", unchanged); assert.ok(unchanged.every(item => item.expected === item.actual)); report.packageUnchanged = true;
    assert.equal(analysis.authority, "none"); assert.equal(analysis.status, "complete", JSON.stringify(analysis.refusals)); assert.equal(analysis.outcome, "match");
    assert.equal(analysis.assertions.length, 64); assert.ok(comparisons.every(row => row.equal)); assert.ok(controls.every(row => row.correct), JSON.stringify(controls));
    const after = await sourceIdentity(); await json("implementation-after.json", after); assert.deepEqual(after, before); report.implementationUnchanged = true;
    report.status = "PASS";
  } catch (error) { report.failure = error instanceof Error ? { name: error.name, message: error.message.slice(0, 4000) } : { name: "UnknownFailure" }; throw error; }
  finally {
    await writeFile(join(retained, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Retained numeric differential report: ${join(retained, "report.json")}`);
    if (temporary) {
      const actual = await realpath(temporary), stat = await lstat(temporary);
      assert.equal(actual, resolve(temporary)); assert.equal(dirname(actual), resolve(tmpdir())); assert.ok(basename(actual).startsWith("jevyr-pure-numeric-"));
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink()); await chmod(actual, 0o700); await rm(actual, { recursive: true, force: true });
    }
  }
});
