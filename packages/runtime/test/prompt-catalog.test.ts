import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { canonicalize, createSearchEnvelope, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE, type MindRequest, type SealedCaseContext } from "../src/index.js";
import { makePublicMindPrompt } from "../src/adapters/prompt.js";

const digest = sha256Digest("catalog-fixture"), contract = compileIntentContract({ impulse: "Inspect the sealed source." });
const sealed: SealedCaseContext = { protocol: "jevyr.case/1", caseId: "case_catalog_fixture", submissionDigest: digest, caseDigest: digest, runDigest: digest, sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "bone-v1", policyDigest: digest, genomeVersion: "baseline", genomeDigest: digest, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), intentContractDigest: contract.digest, intentContract: contract, intent: { impulse: "Inspect the sealed source.", mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "sovereign", seed: "held" }, subjects: [] };
function request(omissionCount: number, fileCount = 256): MindRequest {
  const text = "PRIVATE_SOURCE_BYTES_FOR_TOOL_READ\n";
  const files = Array.from({ length: fileCount }, (_, index) => ({ subjectId: "repository", path: `src/file-${index}.mjs`, text, sourceDigest: sha256Digest(text), sourceByteLength: Buffer.byteLength(text) }));
  const omissions = Array.from({ length: omissionCount }, (_, index) => {
    const body = { subjectId: "repository", path: `omitted/file-${index}.mjs`, reason: index % 2 ? "TOTAL_LIMIT" as const : "POLICY_EXCLUDED" as const, sourceDigest: sha256Digest(`omitted-${index}`), sourceByteLength: 8192 };
    return { ...body, omissionDigest: digestJson(body) };
  });
  const body = { protocol: "jevyr.subject-text-projection/1" as const, files, omissions, manifestDigests: [digest], includedBytes: files.length * Buffer.byteLength(text), limits: { maxFileBytes: 96 * 1024, maxTotalBytes: 512 * 1024, maxFiles: 256 } };
  return { sealed, stage: "interpret", role: "interpreter", publicFacts: [], constraints: [], seed: "held", investigationTools: true, signal: new AbortController().signal, subjectProjection: { ...body, projectionDigest: digestJson(body as unknown as JsonValue) } };
}
function material(input: MindRequest): any {
  const line = makePublicMindPrompt(input).split("\n").find(line => line.startsWith("Sealed subject material: "))!;
  return JSON.parse(line.slice("Sealed subject material: ".length));
}

test("shared investigation guidance is transport-neutral and never advertises unavailable native calls", () => {
  const prompt = makePublicMindPrompt(request(0, 1));
  assert.match(prompt, /Use the supplied context-tool protocol for inspection first/u);
  assert.doesNotMatch(prompt, /Use native function calls/u);
  assert.match(prompt, /Use the supplied tool channel and batch multiple reads when that channel supports batching/u);
  assert.doesNotMatch(prompt, /jevyr\.context-tools\/1|three inspection rounds|native tools/u);
  assert.equal(prompt.includes("PRIVATE_SOURCE_BYTES_FOR_TOOL_READ"), false);
});

test("tool source prompts have constant-size catalogs while binding every readable file and omission", () => {
  const small = request(32), large = request(4096), catalog = material(large);
  assert.ok(Buffer.byteLength(JSON.stringify(catalog)) <= 8192);
  assert.ok(Math.abs(Buffer.byteLength(makePublicMindPrompt(large)) - Buffer.byteLength(makePublicMindPrompt(small))) < 64, "Omission count must not cause linear prompt growth");
  assert.equal(catalog.projectionDigest, large.subjectProjection!.projectionDigest);
  assert.equal(catalog.files.count, 256); assert.equal(catalog.files.firstPageHint.length, 4); assert.equal(catalog.files.hintIsPartial, true);
  const fullMetadata = large.subjectProjection!.files.map(file => ({ fileId: digestJson({ subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest }), subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest, lines: file.text.split(/\r?\n/u).length }));
  assert.equal(catalog.files.catalogDigest, digestJson(fullMetadata)); assert.deepEqual(catalog.files.firstPageHint, fullMetadata.slice(0, 4));
  assert.equal(catalog.omissions.count, 4096); assert.equal(catalog.omissions.digest, digestJson(large.subjectProjection!.omissions as unknown as JsonValue));
  assert.deepEqual(catalog.omissions.reasonCounts, [{ reason: "POLICY_EXCLUDED", count: 2048 }, { reason: "TOTAL_LIMIT", count: 2048 }]);
  assert.equal(catalog.omissions.examples.length, 3); assert.equal(catalog.omissions.examplesArePartial, true);
  assert.match(catalog.inspection, /list_subject_files.*nextOffset/u); assert.match(catalog.restrictions, /Omitted files remain unavailable/u);
  assert.equal(makePublicMindPrompt(large).includes("PRIVATE_SOURCE_BYTES_FOR_TOOL_READ"), false);
  assert.equal(makePublicMindPrompt(large).includes("omitted/file-4095.mjs"), false);
});

test("changes beyond partial examples change exact catalog digests without leaking their paths", () => {
  const input = request(100), original = material(input), projection = input.subjectProjection!;
  const omissions = projection.omissions.map((row, index) => index === 99 ? { ...row, path: "UNEXPOSED_CHANGED_PATH", sourceDigest: sha256Digest("changed"), omissionDigest: sha256Digest("changed-row") } : row);
  const { projectionDigest: _digest, ...body } = { ...projection, omissions };
  const changed: MindRequest = { ...input, subjectProjection: { ...body, projectionDigest: digestJson(body as unknown as JsonValue) } };
  const current = material(changed);
  assert.notEqual(current.projectionDigest, original.projectionDigest); assert.notEqual(current.omissions.digest, original.omissions.digest);
  assert.deepEqual(current.omissions.examples, original.omissions.examples); assert.equal(current.omissions.count, original.omissions.count);
  assert.equal(makePublicMindPrompt(changed).includes("UNEXPOSED_CHANGED_PATH"), false);
});

test("catalogs remain deterministic across canonical serialization and physical runs; prepared prompts remain exact", () => {
  const input = request(458, 8), { signal: _signal, ...serializable } = input;
  const roundtrip: MindRequest = { ...JSON.parse(canonicalize(serializable as unknown as JsonValue)), signal: input.signal };
  assert.equal(makePublicMindPrompt(input), makePublicMindPrompt(roundtrip));
  assert.equal(makePublicMindPrompt(input), makePublicMindPrompt({ ...input, sealed: { ...sealed, caseId: "different-physical-case", runDigest: sha256Digest("new physical run"), sealedAt: "2026-09-06T00:00:00.000Z" } }));
  assert.equal(makePublicMindPrompt({ ...input, preparedPublicPrompt: "Pinned original exact prompt" }), "Pinned original exact prompt");
});

test("traditional source prompts remain complete and provider withholding remains unchanged", () => {
  const input = request(10, 8);
  assert.deepEqual(material({ ...input, investigationTools: false }), input.subjectProjection);
  assert.equal(makePublicMindPrompt({ ...input, investigationTools: false }).includes("PRIVATE_SOURCE_BYTES_FOR_TOOL_READ"), true);
  const { subjectProjection: _projection, ...withheld } = input;
  assert.deepEqual(material(withheld), { availability: "WITHHELD_BY_PRIVACY_SCOPE" });
  assert.equal(makePublicMindPrompt(withheld).includes("omitted/file"), false);
});
