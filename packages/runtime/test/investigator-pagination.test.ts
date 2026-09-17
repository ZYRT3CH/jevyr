import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE, type MindRequest, type SealedCaseContext } from "../src/index.js";
import { executeInvestigatorTool, INVESTIGATOR_TOOL_POLICY } from "../src/investigator-tools.js";

const digest = sha256Digest("pagination-fixture");
const contract = compileIntentContract({ impulse: "Inspect the sealed repository." });
const sealed: SealedCaseContext = { protocol: "jevyr.case/1", caseId: "case_pagination_fixture", submissionDigest: digest, caseDigest: digest, runDigest: digest, sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "bone-v1", policyDigest: digest, genomeVersion: "baseline", genomeDigest: digest, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), intentContractDigest: contract.digest, intentContract: contract, intent: { impulse: "Inspect the sealed repository.", mode: "auto", subjects: [], constraints: [], requestedAssays: [], privacy: "local_only", control: "sovereign", seed: "held" }, subjects: [] };
function request(count = 256, longPaths = false): MindRequest {
  const files = Array.from({ length: count }, (_, index) => {
    const text = `export const value = ${index};\n`;
    return { subjectId: "repository", path: `${longPaths ? `deep/${"🧪".repeat(400)}/` : "src/"}file-${index.toString().padStart(3, "0")}.mjs`, text, sourceDigest: sha256Digest(text), sourceByteLength: Buffer.byteLength(text) };
  });
  const body = { protocol: "jevyr.subject-text-projection/1" as const, files, omissions: [], manifestDigests: [digest], includedBytes: files.reduce((sum, file) => sum + file.sourceByteLength, 0), limits: { maxFileBytes: 96 * 1024, maxTotalBytes: 512 * 1024, maxFiles: 256 } };
  return { sealed, stage: "interpret", role: "interpreter", publicFacts: [], constraints: [], seed: "held", signal: new AbortController().signal, subjectProjection: { ...body, projectionDigest: digestJson(body as unknown as JsonValue) } };
}
const call = (input: MindRequest, name: string, args: unknown = {}) => executeInvestigatorTool(input, name, JSON.stringify(args));

test("a 256-file projection pages every opaque identity without denying the oversized listing", async () => {
  const input = request(), files = input.subjectProjection!.files;
  const original = { availability: "CAPTURED", files: files.map(file => ({ fileId: digestJson({ subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest }), subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest, lines: file.text.split(/\r?\n/u).length })), omissions: 0 };
  const originalBytes = Buffer.byteLength(JSON.stringify(original));
  assert.ok(originalBytes > INVESTIGATOR_TOOL_POLICY.maximumResultBytes);
  assert.equal((await call(input, "list_subject_files")).receipt.status, "observed", `Default unpaged listing contains ${originalBytes} bytes`);
  const ids: string[] = [];
  let offset = 0;
  do {
    const result = await call(input, "list_subject_files", { offset, limit: 128 });
    assert.equal(result.receipt.status, "observed", `The original unpaged listing contains ${originalBytes} bytes`);
    assert.ok(result.receipt.resultBytes <= INVESTIGATOR_TOOL_POLICY.maximumResultBytes);
    assert.deepEqual(result.receipt.sourceDigests, [], "A directory listing is not byte-backed source inspection");
    assert.equal((await call(input, "list_subject_files", { offset, limit: 128 })).content, result.content);
    const page = JSON.parse(result.content);
    assert.equal(page.total, 256); assert.equal(page.offset, offset);
    assert.ok(page.files.length > 0 && page.files.length <= 128);
    ids.push(...page.files.map((file: { fileId: string }) => file.fileId));
    if (page.nextOffset === null) break;
    assert.equal(page.nextOffset, offset + page.files.length); offset = page.nextOffset;
  } while (offset < 256);
  assert.equal(ids.length, 256); assert.equal(new Set(ids).size, 256);
  assert.deepEqual(ids, original.files.map(file => file.fileId));
  const last = await call(input, "read_subject_lines", { fileId: ids.at(-1), startLine: 1, endLine: 2 });
  assert.equal(last.receipt.status, "observed"); assert.deepEqual(last.receipt.sourceDigests, [files.at(-1)!.sourceDigest]);
  assert.match(last.content, /value = 255/u);
});

test("page size follows actual UTF-8 response bytes and default calls remain bounded", async () => {
  const input = request(80, true);
  const result = await call(input, "list_subject_files", { limit: 128 });
  assert.equal(result.receipt.status, "observed"); assert.ok(result.receipt.resultBytes <= 32_000);
  const page = JSON.parse(result.content);
  assert.ok(page.files.length > 0 && page.files.length < 80); assert.equal(page.nextOffset, page.files.length);
  const defaultPage = await call(request(), "list_subject_files");
  assert.equal(defaultPage.receipt.status, "observed"); assert.equal(JSON.parse(defaultPage.content).files.length, 64);
});

test("pagination cannot widen disclosure, accept malformed offsets or bypass projection byte integrity", async () => {
  const input = request(3);
  for (const args of [{ offset: -1 }, { offset: 4 }, { offset: 0.5 }, { offset: "0" }, { offset: null }, { limit: 0 }, { limit: 129 }, { limit: 1.5 }, { limit: "3" }, { limit: null }, { path: "../private" }]) assert.equal((await call(input, "list_subject_files", args)).receipt.status, "denied");
  const last = JSON.parse((await call(input, "list_subject_files", { offset: 3 })).content);
  assert.deepEqual(last.files, []); assert.equal(last.nextOffset, null); assert.equal(last.total, 3);
  const { subjectProjection: _projection, ...withheld } = input;
  const hidden = await call(withheld, "list_subject_files");
  assert.deepEqual(JSON.parse(hidden.content), { availability: "WITHHELD_BY_PRIVACY_SCOPE", files: [], omissions: 0, offset: 0, limit: 64, total: 0, nextOffset: null });
  const tampered = { ...input, subjectProjection: { ...input.subjectProjection!, files: input.subjectProjection!.files.map((file, index) => index ? file : { ...file, text: "changed" }) } };
  assert.equal((await call(tampered, "list_subject_files", { limit: 1 })).receipt.status, "denied");
});

test("revision listings page only their permitted committed parent and retain byte-backed reads", async () => {
  const base = request(160);
  const files = base.subjectProjection!.files.map(file => ({ path: file.path, content: file.text, digest: file.sourceDigest }));
  const input: MindRequest = { ...base, stage: "reflex", role: "reflex", revision: { round: 1, contextDigest: digest, parentCandidateIds: ["parent"] }, revisionSources: [{ candidateId: "parent", blueprintDigest: digest, files }] };
  const page = await call(input, "list_revision_files", { offset: 128, limit: 128 });
  assert.equal(page.receipt.status, "observed"); assert.deepEqual(page.receipt.sourceDigests, []);
  const value = JSON.parse(page.content); assert.equal(value.total, 160); assert.equal(value.files.length, 32); assert.equal(value.nextOffset, null);
  const read = await call(input, "read_revision_lines", { fileId: value.files[0].fileId, startLine: 1, endLine: 2 });
  assert.equal(read.receipt.status, "observed"); assert.deepEqual(read.receipt.sourceDigests, [files[128]!.digest]);
  const foreign = { ...input, revision: { ...input.revision!, parentCandidateIds: ["other"] } };
  assert.equal((await call(foreign, "list_revision_files", { limit: 1 })).receipt.status, "denied");
});

test("empty, beyond-EOF and oversized reads never claim source inspection for original or revision files", async () => {
  for (const [text, startLine, endLine, expected] of [["", 1, 1, "denied"], ["four\nreal\nsource\nlines", 15, 25, "denied"], ["source\n", 2, 2, "denied"], ["x".repeat(40_000), 1, 1, "denied"], ["first\nsecond", 2, 20, "observed"]] as const) {
    const base = request(1), original = base.subjectProjection!;
    const files = [{ ...original.files[0]!, text, sourceDigest: sha256Digest(text), sourceByteLength: Buffer.byteLength(text) }];
    const { projectionDigest: _digest, ...body } = { ...original, files, includedBytes: Buffer.byteLength(text) };
    const input = { ...base, subjectProjection: { ...body, projectionDigest: digestJson(body as unknown as JsonValue) } };
    const sourceId = digestJson({ subjectId: files[0]!.subjectId, path: files[0]!.path, sourceDigest: files[0]!.sourceDigest });
    const revision: MindRequest = { ...input, stage: "reflex", role: "reflex", revision: { round: 1, contextDigest: digest, parentCandidateIds: ["parent"] }, revisionSources: [{ candidateId: "parent", blueprintDigest: digest, files: [{ path: "parent.mjs", content: text, digest: sha256Digest(text) }] }] };
    const revisionId = digestJson({ subjectId: "parent", path: "parent.mjs", sourceDigest: sha256Digest(text) });
    for (const [request, name, fileId] of [[input, "read_subject_lines", sourceId], [revision, "read_revision_lines", revisionId]] as const) {
      const result = await call(request, name, { fileId, startLine, endLine });
      assert.equal(result.receipt.status, expected, `${name}: ${text.length} source bytes, range ${startLine}..${endLine}`);
      assert.ok(result.receipt.resultBytes <= 32_000);
      assert.deepEqual(result.receipt.sourceDigests, expected === "observed" ? [sha256Digest(text)] : []);
      if (expected === "observed") { assert.equal(JSON.parse(result.content).text, "second"); assert.equal(JSON.parse(result.content).endLine, 2); }
    }
  }
});
