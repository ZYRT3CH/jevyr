import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope, digestJson, sha256Digest } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/index.js";
import { OpenAICompatibleMindAdapter } from "../src/adapters/openai-compatible.js";
import { MindMeteredFailure, mindFailureInvestigation, providerFailureDiagnostic, safeProviderFailureDiagnostic, type ModelInvestigationFailure, type ProviderFailureCategory } from "../src/mind-metering.js";
import type { MindRequest } from "../src/contracts.js";

const secret = "PRIVATE_PROVIDER_BODY_AND_CREDENTIAL_SENTINEL";
function request(signal = new AbortController().signal): MindRequest {
  const digest = sha256Digest("provider-diagnostic-fixture"), contract = compileIntentContract({ impulse: "Inspect fixture" });
  return { stage: "interpret", role: "interpreter", seed: "fixture", publicFacts: [], constraints: [], preparedPublicPrompt: `PRIVATE_PROMPT ${secret}`, investigationTools: true,
    signal, maxInputTokens: 100_000, maxOutputTokens: 1000,
    sealed: { protocol: "jevyr.case/1", caseId: "case_1234567812345678", caseDigest: digest, submissionDigest: digest, runDigest: digest, sealedAt: "2026-09-05T00:00:00.000Z",
      policyVersion: "fixture", policyDigest: digest, genomeVersion: "fixture", genomeDigest: digest, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), intentContractDigest: contract.digest, intentContract: contract, subjects: [],
      intent: { impulse: "Inspect fixture", subjects: [], constraints: [], requestedAssays: [], mode: "auto", privacy: "local_only", control: "sovereign", seed: "fixture" } } };
}
async function failed(fetcher: typeof fetch, options: { maximum?: number; timeout?: number; signal?: AbortSignal; structured?: boolean; legacy?: boolean } = {}) {
  const original = globalThis.fetch;
  let calls = 0, sentBytes = 0;
  globalThis.fetch = async (input, init) => { calls++; sentBytes += Buffer.byteLength(String(init?.body ?? "")); return await fetcher(input, init); };
  try {
    const provider = new OpenAICompatibleMindAdapter({ id: "mind.diagnostic-fixture", displayName: "Diagnostic fixture", baseUrl: "http://127.0.0.1:11434/v1", model: "fixture", apiKey: secret,
      timeoutMs: options.timeout ?? 1000, ...(options.maximum === undefined ? {} : { maxResponseBytes: options.maximum }), investigationTransport: options.structured ? "structured" : "native" });
    let result: ModelInvestigationFailure | undefined;
    await assert.rejects(provider.runMetered({ ...request(options.signal), ...(options.legacy ? { investigationTools: false } : {}) }), error => {
      assert.ok(error instanceof MindMeteredFailure);
      result = mindFailureInvestigation(error);
      assert.ok(result?.providerFailure, "diagnostic survives the public failure wrapper");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, investigation: result }), /PRIVATE_|authorization|Bearer|chat\/completions/u);
      assert.equal(result.authority, "context-only");
      assert.ok(Object.isFrozen(result.providerFailure));
      if (!options.legacy) assert.equal(error.transmittedInputBytes, sentBytes);
      return true;
    });
    assert.equal(calls, 1, "diagnostics must not retry or switch transport");
    assert.equal(result!.providerRounds, 1);
    return result!;
  } finally { globalThis.fetch = original; }
}

test("HTTP diagnostics classify known statuses without retaining provider bodies or triggering retries", async t => {
  const cases: readonly [number, ProviderFailureCategory, boolean | null][] = [
    [400, "HTTP_CLIENT_ERROR", false], [401, "HTTP_AUTHENTICATION", false], [403, "HTTP_AUTHORIZATION", false], [408, "HTTP_TIMEOUT", true],
    [422, "HTTP_CLIENT_ERROR", false], [429, "HTTP_RATE_LIMIT", true], [500, "HTTP_SERVER_ERROR", null], [501, "HTTP_SERVER_ERROR", false],
    [502, "HTTP_SERVER_ERROR", null], [503, "HTTP_SERVER_ERROR", true], [504, "HTTP_TIMEOUT", null], [507, "HTTP_SERVER_ERROR", null],
  ];
  for (const [status, category, retryable] of cases) await t.test(String(status), async () => {
    const raw = JSON.stringify({ error: { message: `${secret} response_format unsupported` } });
    const result = await failed(async () => new Response(raw, { status }), { structured: status === 422 });
    assert.equal(result.boundary, "PROVIDER_TRANSPORT");
    assert.deepEqual(result.providerFailure, { protocol: "jevyr.provider-failure/1", category, retryable, httpStatus: status,
      responseDigest: sha256Digest(raw), responseBytes: Buffer.byteLength(raw), responseComplete: true });
  });
});

test("HTTP error hashing is capped and describes a prefix instead of a full response", async () => {
  const raw = secret.repeat(20), maximum = 17;
  const result = await failed(async () => new Response(raw, { status: 429 }), { maximum });
  assert.deepEqual(result.providerFailure, { protocol: "jevyr.provider-failure/1", category: "HTTP_RATE_LIMIT", retryable: true, httpStatus: 429,
    responseDigest: sha256Digest(Buffer.from(raw).subarray(0, maximum)), responseBytes: maximum, responseComplete: false });
});

test("successful HTTP with malformed JSON and invalid envelopes gets exact response fingerprints", async t => {
  for (const [raw, category, boundary] of [[secret, "RESPONSE_JSON", "PROVIDER_TRANSPORT"], [JSON.stringify({ error: secret }), "RESPONSE_SCHEMA", "PROVIDER_MESSAGE"]] as const) {
    await t.test(category, async () => {
      const result = await failed(async () => new Response(raw, { status: 200 }));
      assert.equal(result.boundary, boundary);
      assert.deepEqual(result.providerFailure, { protocol: "jevyr.provider-failure/1", category, retryable: null, httpStatus: 200,
        responseDigest: sha256Digest(raw), responseBytes: Buffer.byteLength(raw), responseComplete: true });
    });
  }
});

test("successful oversized and non-UTF8 responses remain rejected with bounded byte identity", async t => {
  await t.test("limit", async () => {
    const result = await failed(async () => new Response(secret), { maximum: 7 });
    assert.equal(result.providerFailure!.category, "RESPONSE_BYTE_LIMIT");
    assert.equal(result.providerFailure!.responseBytes, 7);
    assert.equal(result.providerFailure!.responseComplete, false);
    assert.equal(result.providerFailure!.responseDigest, sha256Digest(Buffer.from(secret).subarray(0, 7)));
  });
  await t.test("encoding", async () => {
    const bytes = Buffer.from([0xc3, 0x28]);
    const result = await failed(async () => new Response(bytes));
    assert.equal(result.providerFailure!.category, "RESPONSE_ENCODING");
    assert.equal(result.providerFailure!.responseComplete, true);
    assert.equal(result.providerFailure!.responseDigest, sha256Digest(bytes));
  });
});

test("network exceptions reveal neither their message nor a guessed retryability", async () => {
  const result = await failed(async () => { throw new TypeError(`${secret} https://credential@host`); });
  assert.deepEqual(result.providerFailure, { protocol: "jevyr.provider-failure/1", category: "NETWORK", retryable: null });
});

test("a broken response stream retains only the actually observed prefix", async () => {
  const prefix = Buffer.from(secret), raw = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(prefix); },
    pull(controller) { controller.error(new Error(`${secret} socket diagnostic`)); },
  });
  const result = await failed(async () => new Response(raw));
  assert.deepEqual(result.providerFailure, { protocol: "jevyr.provider-failure/1", category: "NETWORK", retryable: null, httpStatus: 200,
    responseDigest: sha256Digest(prefix), responseBytes: prefix.length, responseComplete: false });
});

test("HTTP failure after a source response keeps prior receipts and charges both exact transmitted bodies", async () => {
  const original = globalThis.fetch, source = `export const value = "${secret}";\n`, sourceDigest = sha256Digest(source);
  const file = { subjectId: "source", path: "fixture.mjs", sourceDigest, sourceByteLength: Buffer.byteLength(source), text: source };
  const projection = { protocol: "jevyr.subject-text-projection/1" as const, files: [file], omissions: [], manifestDigests: [], includedBytes: Buffer.byteLength(source), limits: { maxFileBytes: 96_000, maxTotalBytes: 512_000, maxFiles: 256 } };
  const failureBody = JSON.stringify({ error: secret });
  let calls = 0, inputBytes = 0;
  globalThis.fetch = async (_input, init) => {
    calls++; inputBytes += Buffer.byteLength(String(init?.body));
    if (calls === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { content: "", tool_calls: [{ id: "source-read", type: "function", function: { name: "read_subject_lines", arguments: JSON.stringify({ fileId: digestJson({ subjectId: file.subjectId, path: file.path, sourceDigest }), startLine: 1, endLine: 1 }) } }] } }] });
    assert.ok(String(init?.body).includes(secret), "the prior actual source response crossed the second provider boundary");
    return new Response(failureBody, { status: 503 });
  };
  try {
    const provider = new OpenAICompatibleMindAdapter({ id: "mind.fixture", displayName: "Fixture", baseUrl: "http://127.0.0.1:11434/v1", model: "fixture" });
    await assert.rejects(provider.runMetered({ ...request(), subjectProjection: { ...projection, projectionDigest: digestJson(projection) } }), error => {
      assert.ok(error instanceof MindMeteredFailure);
      assert.equal(error.transmittedInputBytes, inputBytes);
      const diagnostic = mindFailureInvestigation(error)!;
      assert.equal(diagnostic.providerRounds, 2);
      assert.equal(diagnostic.tools.length, 1);
      assert.deepEqual(diagnostic.tools[0]!.sourceDigests, [sourceDigest]);
      assert.equal(diagnostic.tools[0]!.status, "observed");
      assert.equal(diagnostic.providerFailure!.category, "HTTP_SERVER_ERROR");
      assert.equal(diagnostic.providerFailure!.responseDigest, sha256Digest(failureBody));
      assert.doesNotMatch(JSON.stringify({ ...error, message: error.message, diagnostic }), /PRIVATE_/u);
      return true;
    });
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});

function pendingUntilAbort(_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("test transport did not abort")), 1000);
    const abort = () => { clearTimeout(keepAlive); reject(new Error(secret)); };
    if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, { once: true });
  });
}
test("local timeout is distinct from a caller cancellation without claiming server disposition", async t => {
  await t.test("timeout", async () => {
    const result = await failed(pendingUntilAbort, { timeout: 20 });
    assert.deepEqual(result.providerFailure, { protocol: "jevyr.provider-failure/1", category: "TIMEOUT", retryable: null });
  });
  await t.test("abort", async () => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(new Error(secret)), 20);
    try { const result = await failed(pendingUntilAbort, { signal: controller.signal });
      assert.deepEqual(result.providerFailure, { protocol: "jevyr.provider-failure/1", category: "ABORTED", retryable: null });
    } finally { clearTimeout(timer); }
  });
});

test("legacy request failure preserves the same bounded HTTP diagnostic", async () => {
  const result = await failed(async () => new Response(secret, { status: 401 }), { legacy: true });
  assert.equal(result.providerFailure!.category, "HTTP_AUTHENTICATION");
  assert.equal(result.providerFailure!.responseDigest, sha256Digest(secret));
});

test("old failure metadata stays optional and forged diagnostic fields cannot cross the capture boundary", () => {
  const old = new MindMeteredFailure("safe old failure", 12, { boundary: "PROVIDER_TRANSPORT", providerRounds: 1, tools: [] });
  assert.equal(Object.hasOwn(mindFailureInvestigation(old)!, "providerFailure"), false);
  assert.equal(providerFailureDiagnostic(Object.assign(new Error(secret), { providerFailure: { category: "NETWORK" } })), undefined);
  assert.throws(() => safeProviderFailureDiagnostic({ protocol: "jevyr.provider-failure/1", category: "NETWORK", retryable: null, raw: secret } as any), /Invalid provider failure diagnostic/u);
  assert.throws(() => safeProviderFailureDiagnostic({ protocol: "jevyr.provider-failure/1", category: "NETWORK", retryable: null, responseDigest: sha256Digest("") }), /Invalid bounded/u);
});
