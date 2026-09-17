import assert from "node:assert/strict";
import { test } from "node:test";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { createSubjectContext, SUBJECT_CONTEXT_LIMITS, type SubjectContextInput } from "../src/subject-context.js";
import type { SubjectMaterialBinding, SubjectMaterialManifest } from "../src/subject-materials.js";

function fixture(files: Readonly<Record<string, string | Uint8Array>>, omitted: SubjectMaterialManifest["omissions"] = []) {
  const blobs = new Map<string, Uint8Array>();
  const entries = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, value]) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value, blobDigest = sha256Digest(bytes);
    blobs.set(blobDigest, bytes);
    return { path, blobDigest, byteLength: bytes.byteLength, mode: 0o644 };
  });
  let manifest: SubjectMaterialManifest = { protocol: "jevyr.subject-material/1", subjectId: "repo", subjectKind: "directory", subjectDigest: sha256Digest("subject"), availability: "MATERIALIZED", byteLength: entries.reduce((sum, file) => sum + file.byteLength, 0), entries, directories: [], omissions: omitted };
  const binding: SubjectMaterialBinding = { subjectId: manifest.subjectId, subjectKind: manifest.subjectKind, subjectDigest: manifest.subjectDigest, availability: manifest.availability, byteLength: manifest.byteLength, manifestDigest: digestJson(manifest as unknown as JsonValue) };
  const bindings = [binding], captureDigest = digestJson({ protocol: "jevyr.subject-material-capture/1", bindings: bindings as unknown as JsonValue });
  const reads = { manifests: 0, blobs: 0, bytes: 0 };
  const input: SubjectContextInput = { captureDigest, bindings, privacy: "local_only", providerNetwork: "loopback", reader: {
    readManifest: async () => { reads.manifests++; return manifest; },
    readBlob: async (digest, expected) => { reads.blobs++; reads.bytes += expected; const value = blobs.get(digest); if (!value) throw new Error("private C:/secrets/key missing"); return value; },
  } };
  return { input, reads, blobs, binding, manifest, changeManifest: (value: SubjectMaterialManifest) => { manifest = value; } };
}
const value = (result: { value: JsonValue }) => result.value as any;
const refused = async (action: () => Promise<unknown>) => assert.rejects(action, error => error instanceof TypeError && error.message === "Malformed, unavailable, or oversized sealed subject context");

test("privacy refusal happens before any private metadata or byte access and preserves local provider scope", async () => {
  const f = fixture({ "main.mjs": "export const x = 1;" });
  for (const privacy of ["local_only", "provider_scoped"] as const) for (const providerNetwork of ["provider", "unrestricted"] as const) {
    assert.equal(await createSubjectContext({ ...f.input, privacy, providerNetwork }), undefined);
  }
  assert.deepEqual(f.reads, { manifests: 0, blobs: 0, bytes: 0 });
  assert.ok(await createSubjectContext({ ...f.input, privacy: "provider_scoped", providerNetwork: "none" }));
  assert.ok(await createSubjectContext({ ...f.input, privacy: "full_case", providerNetwork: "provider" }));
});

test("catalog paging reaches sealed text beyond projection limits with unchanged opaque identities", async () => {
  const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`src/file-${String(i).padStart(3, "0")}.mjs`, `export const value = ${i};\n`]));
  files["z-large.mjs"] = "// sealed source\n".repeat(8000) + "export const later = 73;\n";
  const f = fixture(files), context = (await createSubjectContext(f.input))!;
  assert.equal(context.descriptor.readableFiles, 301); assert.equal(context.descriptor.totalFiles, 301);
  assert.equal(f.reads.manifests, 1, "initial metadata read is bounded once per manifest, not quadratic in files");
  let offset = 0; const ids: string[] = [];
  for (;;) {
    const result = await context.listFiles({ offset, limit: 128 }), page = value(result);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32_000); assert.deepEqual(result.sourceDigests, []);
    ids.push(...page.files.map((entry: any) => entry.fileId));
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset); offset = page.nextOffset;
  }
  assert.equal(ids.length, 301); assert.equal(new Set(ids).size, 301);
  const sourceDigest = sha256Digest(files["z-large.mjs"]!);
  const expectedId = digestJson({ subjectId: "repo", path: "z-large.mjs", sourceDigest });
  assert.equal(ids.at(-1), expectedId);
  const observed = await context.readLines({ fileId: expectedId, startLine: 8001, endLine: 8002 });
  assert.match(value(observed).text, /later = 73/u); assert.deepEqual(observed.sourceDigests, [sourceDigest]);
  assert.ok(files["z-large.mjs"]!.length > 96 * 1024);
});

test("metadata caps and policy omissions remain explicit, deterministic, and contain no excluded paths", async () => {
  const f = fixture({ "a.mjs": "a", "b.mjs": "bb", "c.mjs": "ccc", "d.mjs": "dddd" }, [{ path: ".env", reason: "built-in-secret-name" }]);
  const context = (await createSubjectContext({ ...f.input, limits: { maxFiles: 2, maxFileBytes: 3 } }))!;
  assert.equal(context.descriptor.totalFiles, 2); assert.equal(context.descriptor.eligibleFiles, 3);
  assert.deepEqual(context.descriptor.omissionCounts, { policy: 1, perFileLimit: 1, catalogLimit: 1 });
  assert.equal(context.descriptor.omissionCount, 3); assert.equal(context.descriptor.complete, false);
  const page = value(await context.listFiles({})); assert.deepEqual(page.files.map((file: any) => file.path), ["a.mjs", "b.mjs"]);
  assert.ok(!JSON.stringify({ descriptor: context.descriptor, page }).includes(".env"));
  const again = (await createSubjectContext({ ...f.input, limits: { maxFiles: 2, maxFileBytes: 3 } }))!;
  assert.deepEqual(again.descriptor, context.descriptor);
  await refused(() => context.readLines({ fileId: digestJson({ subjectId: "repo", path: ".env", sourceDigest: sha256Digest("secret") }), startLine: 1, endLine: 1 }));
  await refused(() => createSubjectContext({ ...f.input, limits: { maxFiles: SUBJECT_CONTEXT_LIMITS.maxFiles + 1 } }));
});

test("initial classification and each search obey input budgets and report uninspected files honestly", async () => {
  const f = fixture({ "a.mjs": "a\n".repeat(5), "b.mjs": "b\n".repeat(5), "c.mjs": "target\n" });
  const context = (await createSubjectContext({ ...f.input, limits: { maxFileBytes: 10, maxScanBytes: 10 } }))!;
  assert.equal(context.descriptor.readableFiles, 1); assert.equal(context.descriptor.uninspectedFiles, 2); assert.equal(context.descriptor.inspectionComplete, false);
  assert.equal(f.reads.bytes, 10);
  let next: { offset: number; startLine?: number } | null = { offset: 0 }, found: any[] = [];
  for (let calls = 0; next !== null && calls < 4; calls++) {
    const before = f.reads.bytes, result = await context.search({ query: "target", ...next }), page = value(result);
    assert.ok(f.reads.bytes - before <= 10); found.push(...page.matches); next = page.next;
  }
  assert.equal(next, null); assert.equal(found.length, 1); assert.equal(found[0].sourceDigest, sha256Digest("target\n"));
  assert.equal(context.descriptor.readableFiles, 1, "descriptor remains the frozen initial classification, not a mutable success claim");
});

test("search resumes within a file without losing matches and emits only bytes containing the literal match", async () => {
  const f = fixture({ "many.mjs": Array.from({ length: 75 }, (_, i) => `${"x".repeat(700)} target-${i}`).join("\n") });
  const context = (await createSubjectContext(f.input))!;
  let next: { offset: number; startLine?: number } | null = { offset: 0 }; const lines: number[] = [];
  for (let calls = 0; next !== null && calls < 8; calls++) {
    const observed = await context.search({ query: "target", ...next }), page = value(observed);
    assert.ok(page.matches.length <= 30); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32_000);
    for (const match of page.matches) { assert.ok(match.text.includes("target")); assert.equal(match.excerptPartial, true); lines.push(match.line); }
    assert.deepEqual(observed.sourceDigests, [sha256Digest(f.blobs.values().next().value!)]); next = page.next;
  }
  assert.deepEqual(lines, Array.from({ length: 75 }, (_, index) => index + 1)); assert.equal(next, null);
  const absent = await context.search({ query: "not-present" }); assert.deepEqual(absent.sourceDigests, []); assert.deepEqual(value(absent).matches, []);
});

test("empty, binary, invalid UTF8, beyond-EOF and oversized excerpts never receive source credit", async () => {
  const f = fixture({ "binary.bin": new Uint8Array([0, 1, 2]), "empty.mjs": "", "invalid.txt": new Uint8Array([0xc0, 0xaf]), "long.txt": "🙂".repeat(10_000), "valid.mjs": "alpha\nbeta" });
  const context = (await createSubjectContext(f.input))!, entries = value(await context.listFiles({})).files;
  assert.equal(context.descriptor.readableFiles, 2); assert.equal(context.descriptor.binaryFiles, 2); assert.equal(context.descriptor.emptyFiles, 1);
  for (const path of ["binary.bin", "empty.mjs", "invalid.txt", "long.txt"]) await refused(() => context.readLines({ fileId: entries.find((file: any) => file.path === path).fileId, startLine: 1, endLine: 1 }));
  const validId = entries.find((file: any) => file.path === "valid.mjs").fileId;
  await refused(() => context.readLines({ fileId: validId, startLine: 3, endLine: 4 }));
  await refused(() => context.readLines({ fileId: validId, startLine: 1, endLine: 81 }));
  const observed = await context.readLines({ fileId: validId, startLine: 2, endLine: 80 });
  assert.equal(value(observed).text, "beta"); assert.equal(value(observed).endLine, 2); assert.deepEqual(observed.sourceDigests, [sha256Digest("alpha\nbeta")]);
});

test("capture, manifest and blob tampering fails closed, including mutation after initial inspection", async () => {
  const f = fixture({ "main.mjs": "source" });
  await refused(() => createSubjectContext({ ...f.input, captureDigest: sha256Digest("foreign") })); assert.equal(f.reads.manifests, 0);
  const context = (await createSubjectContext(f.input))!, id = value(await context.listFiles({})).files[0].fileId;
  const digest = sha256Digest("source"); f.blobs.set(digest, Buffer.from("other!"));
  await refused(() => context.readLines({ fileId: id, startLine: 1, endLine: 1 }));
  await refused(() => context.search({ query: "source" }));
  f.blobs.set(digest, Buffer.from("source"));
  f.changeManifest({ ...f.manifest, entries: [{ ...f.manifest.entries[0]!, path: "changed.mjs" }] });
  await refused(() => context.readLines({ fileId: id, startLine: 1, endLine: 1 }));
  await refused(() => createSubjectContext(f.input));
});

test("catalog does not retain mutable input metadata, expose readers or accept locator-shaped requests", async () => {
  const f = fixture({ "main.mjs": "source" }), context = (await createSubjectContext(f.input))!;
  assert.deepEqual(Object.keys(context).sort(), ["descriptor", "inspectionCatalog", "listFiles", "readLines", "search"]);
  assert.ok(Object.isFrozen(context)); assert.ok(Object.isFrozen(context.descriptor));
  for (const parameters of [{ offset: null }, { offset: -1 }, { offset: 2 }, { limit: 0 }, { limit: 129 }, { path: "C:/private" }]) await refused(() => context.listFiles(parameters as any));
  for (const parameters of [{ query: "", offset: 0 }, { query: "source", offset: null }, { query: "source", startLine: 0 }, { query: "source", locator: "../private" }]) await refused(() => context.search(parameters as any));
  const page = value(await context.listFiles({})); assert.throws(() => { page.files[0].path = "changed"; });
  (f.input.bindings as SubjectMaterialBinding[])[0] = { ...f.binding, manifestDigest: sha256Digest("foreign") };
  assert.equal(value(await context.readLines({ fileId: page.files[0].fileId, startLine: 1, endLine: 1 })).text, "source");
});

test("readable display metadata distinguishes exact captured bytes from line normalization",async()=>{
  const originals={"crlf.mjs":"export const n=1;\r\n","lf.mjs":"export const n=1;\n","no-final.mjs":"export const n=1;"};
  const f=fixture(originals),context=(await createSubjectContext(f.input))!;
  const catalog=value(await context.listFiles({}));
  for(const file of catalog.files){
    const original=originals[file.path as keyof typeof originals],result=await context.readLines({fileId:file.fileId,startLine:1,endLine:file.totalLines}),display=value(result);
    assert.equal(display.ociReadOnlyPath,`/subject/subject-0000/${file.path}`);assert.equal(display.sourceDigest,sha256Digest(original));assert.equal(display.sourceByteLength,Buffer.byteLength(original));
    assert.equal(display.textDigest,sha256Digest(display.text));assert.equal(display.textByteLength,Buffer.byteLength(display.text));assert.equal(display.textNormalization,"CRLF_TO_LF");assert.equal(display.textNormalized,file.path==="crlf.mjs");assert.equal(display.textMatchesSourceBytes,file.path!=="crlf.mjs");
    assert.equal(display.text.endsWith("\n"),file.path!=="no-final.mjs");assert.equal(result.sourceRead!.sourceDigest,display.sourceDigest);assert.equal(result.sourceRead!.textDigest,display.textDigest);assert.ok(Buffer.byteLength(JSON.stringify(display))<=32_000);
  }
  const crlf=catalog.files.find((file:any)=>file.path==="crlf.mjs");const partial=value(await context.readLines({fileId:crlf.fileId,startLine:1,endLine:1}));assert.equal(partial.completeFile,false);assert.equal(partial.textMatchesSourceBytes,false);
});

test("manifest paths cannot include live locators, traversal, or conflicting policy exclusions", async () => {
  for (const path of ["../private", "C:/private/key", "/private/key", "folder\\private", "a/./b"]) {
    const f = fixture({ [path]: "source" }); await refused(() => createSubjectContext(f.input));
  }
  const f = fixture({ ".env": "secret" }, [{ path: ".env", reason: "built-in-secret-name" }]);
  await refused(() => createSubjectContext(f.input)); assert.equal(f.reads.blobs, 0);
  const directory = fixture({ ".ssh/private": "secret" }, [{ path: ".ssh", reason: "built-in-credential-directory" }]);
  await refused(() => createSubjectContext(directory.input)); assert.equal(directory.reads.blobs, 0);
});
