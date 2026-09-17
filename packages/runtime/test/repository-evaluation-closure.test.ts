import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { compileIntentContract } from "@jevyr/core";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { planRepositoryEvaluation, REPOSITORY_EVALUATION_DISCOVERY, type RepositorySubjectEvaluation } from "../src/repository-evaluation-plan.js";
import { deriveRepositoryEvaluationClosure, materializeRepositoryEvaluationClosure, type RepositoryEvaluationClosureInput } from "../src/repository-evaluation-closure.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
const suiteSource = 'import test from "node:test"; import assert from "node:assert/strict"; import { add } from "../src/add.mjs"; test("add",()=>assert.equal(add(2,3),5));';
async function fixture(extra: Record<string, string> = {}) {
  const files = { "README.md": "Unselected original content", "src/add.mjs": "export const add=(a,b)=>a+b;", "tests/add.test.mjs": suiteSource, ...extra };
  const blobs = new Map<string, Buffer>();
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, text]) => {
    const bytes = Buffer.from(text), blobDigest = sha256Digest(bytes); blobs.set(blobDigest, bytes); return { path, blobDigest, byteLength: bytes.length, mode: 0o644 };
  });
  const manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: "directory", subjectDigest: sha256Digest("fixture original"), availability: "MATERIALIZED", entries, directories: ["src", "tests"], omissions: [], byteLength: entries.reduce((sum, entry) => sum + entry.byteLength, 0) };
  const binding: SubjectMaterialBinding = { subjectId: "repo", subjectKind: "directory", subjectDigest: manifest.subjectDigest, availability: "MATERIALIZED", manifestDigest: hash(manifest), byteLength: manifest.byteLength };
  const captureDigest = hash({ protocol: "jevyr.subject-material-capture/1", bindings: [binding] });
  const reader = { readManifest: async () => manifest, readBlob: async (digest: string) => blobs.get(digest)! };
  const plan = await planRepositoryEvaluation({ captureDigest, bindings: [binding], reader, contract: compileIntentContract({ impulse: "Existing tests must pass.", subjectIds: ["repo"] }),
    runner: { id: "node-test-v1", evaluatorDigest: sha256Digest("controller fixture"), immutableImageId: sha256Digest("image fixture"), capabilityId: "forge.oci" } });
  assert.equal(plan.status, "ready");
  return { input: { captureDigest, bindings: [binding], reader, subject: plan.subjects[0]! } satisfies RepositoryEvaluationClosureInput, manifest, blobs };
}
function rehashSubject(input: RepositoryEvaluationClosureInput, subject: RepositorySubjectEvaluation): RepositorySubjectEvaluation {
  return { ...subject, suiteDigest: hash({ discovery: REPOSITORY_EVALUATION_DISCOVERY, captureDigest: input.captureDigest, subjectId: subject.subjectId, manifestDigest: subject.manifestDigest,
    testFiles: subject.testFiles, sourceFiles: subject.sourceFiles, configFiles: subject.configFiles, runner: subject.runner }) };
}
async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "jevyr-evaluation-closure-"));
  try { await run(root); } finally {
    // Only this freshly created test directory is eligible for recursive cleanup.
    const absolute = resolve(root), base = resolve(tmpdir());
    assert.ok(absolute.startsWith(`${base}${sep}`) && absolute.split(sep).at(-1)!.startsWith("jevyr-evaluation-closure-"));
    const writable = async (path: string): Promise<void> => { const info = await lstat(path); if (info.isSymbolicLink()) return; await chmod(path, 0o700); if (info.isDirectory()) for (const name of await readdir(path)) await writable(join(path, name)); };
    await writable(absolute); await rm(absolute, { recursive: true, force: true });
  }
}

test("copies only selected source bytes with complete original membership and a distinct immutable closure identity", async () => {
  const f = await fixture();
  await temporary(async base => {
    const expected = await deriveRepositoryEvaluationClosure(f.input), a = await materializeRepositoryEvaluationClosure(f.input, join(base, "a")), b = await materializeRepositoryEvaluationClosure(f.input, join(base, "b"));
    assert.deepEqual(a.descriptor, expected); assert.deepEqual(b.descriptor, expected); assert.equal(expected.scope, "selected-static-test-closure");
    assert.equal(expected.target, "sealed-original-subject"); assert.equal(expected.mountReadOnlyRequired, true);
    assert.deepEqual(expected.files.map(file => file.path), ["src/add.mjs", "tests/add.test.mjs"]); assert.deepEqual(expected.directories, ["src", "tests"]);
    assert.notEqual(expected.materializationDigest, expected.captureDigest); assert.notEqual(expected.treeDigest, expected.subjectDigest);
    for (const file of expected.files) {
      assert.equal(file.original.manifestDigest, f.input.bindings[0]!.manifestDigest); assert.deepEqual(f.manifest.entries[file.original.entryIndex], { path: file.path, blobDigest: file.digest, byteLength: file.bytes, mode: file.original.mode });
      const output = await readFile(join(a.root, ...file.path.split("/"))); assert.equal(sha256Digest(output), file.digest); assert.equal(output.length, file.bytes);
      assert.equal((await lstat(join(a.root, ...file.path.split("/")))).nlink, 1);
    }
    await assert.rejects(readFile(join(a.root, "README.md")), { code: "ENOENT" });
    const { materializationDigest, ...body } = expected; assert.equal(materializationDigest, hash(body)); assert.ok(Object.isFrozen(expected.files[0]!.original));
  });
});

test("rejects tampered capture, manifest, selected byte contents and nonmembers without creating an output tree", async () => {
  const f = await fixture();
  await temporary(async base => {
    const destination = join(base, "absent");
    await assert.rejects(materializeRepositoryEvaluationClosure({ ...f.input, captureDigest: sha256Digest("wrong") }, destination));
    await assert.rejects(materializeRepositoryEvaluationClosure({ ...f.input, reader: { ...f.input.reader, readManifest: async () => ({ ...f.manifest, byteLength: 0 }) } }, destination));
    const foreign = { path: "extra.mjs", bytes: 1, digest: sha256Digest("x") }, subject = rehashSubject(f.input, { ...f.input.subject, sourceFiles: [foreign, ...f.input.subject.sourceFiles] });
    await assert.rejects(materializeRepositoryEvaluationClosure({ ...f.input, subject }, destination));
    f.blobs.set(f.input.subject.testFiles[0]!.digest, Buffer.from("process.exit(0)"));
    await assert.rejects(materializeRepositoryEvaluationClosure(f.input, destination)); await assert.rejects(lstat(destination), { code: "ENOENT" });
  });
});

test("rejects portable-path escapes, case aliases and file/directory collisions even with recomputed suite identities", async () => {
  const f = await fixture();
  for (const path of ["../outside.mjs", "/outside.mjs", "a\\b.mjs", "C:/outside.mjs", "a:stream", "a/./b.mjs", "a//b.mjs", "NUL.mjs", "a. /b.mjs", "a?/b.mjs"]) {
    const replacement = { ...f.input.subject.sourceFiles[0]!, path }, subject = rehashSubject(f.input, { ...f.input.subject, sourceFiles: [replacement].sort((a, b) => a.path < b.path ? -1 : 1) });
    await assert.rejects(deriveRepositoryEvaluationClosure({ ...f.input, subject }), undefined, path);
  }
  for (const extra of [{ "src/ADD.mjs": "export const x=1;" }, { src: "conflict" }]) {
    const g = await fixture(extra), entry = g.manifest.entries.find(item => item.path === Object.keys(extra)[0])!;
    const subject = rehashSubject(g.input, { ...g.input.subject, sourceFiles: [...g.input.subject.sourceFiles, { path: entry.path, bytes: entry.byteLength, digest: entry.blobDigest }].sort((a, b) => a.path < b.path ? -1 : 1) });
    await assert.rejects(deriveRepositoryEvaluationClosure({ ...g.input, subject }));
  }
});

test("never overwrites an existing destination or traverses a linked parent", async () => {
  const f = await fixture();
  await temporary(async base => {
    const existing = join(base, "existing"); await mkdir(existing); await writeFile(join(existing, "sentinel"), "unchanged");
    await assert.rejects(materializeRepositoryEvaluationClosure(f.input, existing)); assert.equal(await readFile(join(existing, "sentinel"), "utf8"), "unchanged");
    const outside = join(base, "outside"), linked = join(base, "linked"); await mkdir(outside); await symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(materializeRepositoryEvaluationClosure(f.input, join(linked, "closure"))); assert.deepEqual(await readdir(outside), []);
  });
});

test("copies mutable CAS views immediately and refuses omitted-path or conflicting role metadata", async () => {
  const f = await fixture(), original = f.input.reader.readBlob;
  const seen: Buffer[] = [];
  const reader = { ...f.input.reader, readBlob: async (digest: string) => { for (const prior of seen) prior.fill(0); const bytes = Buffer.from(await original(digest)); seen.push(bytes); return bytes; } };
  await temporary(async base => {
    const output = await materializeRepositoryEvaluationClosure({ ...f.input, reader }, join(base, "closure"));
    for (const file of output.descriptor.files) assert.equal(sha256Digest(await readFile(join(output.root, ...file.path.split("/")))), file.digest);
  });
  const subject = rehashSubject(f.input, { ...f.input.subject, configFiles: [{ ...f.input.subject.testFiles[0]!, digest: sha256Digest("other") }] });
  await assert.rejects(deriveRepositoryEvaluationClosure({ ...f.input, subject }));
  const manifest: SubjectMaterialManifest = { ...f.manifest, omissions: [{ path: "src", reason: "GIT_PATH_EXCLUDED" }] };
  const binding = { ...f.input.bindings[0]!, manifestDigest: hash(manifest) }, captureDigest = hash({ protocol: "jevyr.subject-material-capture/1", bindings: [binding] });
  const omittedInput = { ...f.input, captureDigest, bindings: [binding], reader: { ...f.input.reader, readManifest: async () => manifest } };
  const omittedSubject = rehashSubject(omittedInput, { ...f.input.subject, manifestDigest: binding.manifestDigest });
  await assert.rejects(deriveRepositoryEvaluationClosure({ ...omittedInput, subject: omittedSubject }));
});
