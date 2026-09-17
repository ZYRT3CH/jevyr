import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope, digestJson, sha256Digest } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "../src/index.js";
import { runModelToolLoop } from "../src/model-tool-loop.js";
import { MindMeteredFailure, mindFailureInvestigation, mindFailureInputUpperBound } from "../src/mind-metering.js";
import type { MindRequest } from "../src/contracts.js";

test("failed model calls retain source receipt hashes without leaking tool arguments or provider text", async () => {
  const source = "export const private_source_marker = 7;\n", digest = sha256Digest(source);
  const contract = compileIntentContract({ impulse: "Inspect the sealed repository" });
  const projection = { protocol: "jevyr.subject-text-projection/1" as const, files: [{ subjectId: "source", path: "module.mjs", sourceDigest: digest, sourceByteLength: Buffer.byteLength(source), text: source }], omissions: [], manifestDigests: [], includedBytes: Buffer.byteLength(source), limits: { maxFileBytes: 96_000, maxTotalBytes: 512_000, maxFiles: 256 } };
  const request: MindRequest = { stage: "interpret", role: "interpreter", seed: "held", publicFacts: [], constraints: [], preparedPublicPrompt: "private_prompt_marker", signal: new AbortController().signal, maxInputTokens: 100_000, maxOutputTokens: 10_000,
    sealed: { protocol: "jevyr.case/1", caseId: "case_1234567812345678", caseDigest: digest, submissionDigest: digest, runDigest: digest, sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "fixture", policyDigest: digest, genomeVersion: "fixture", genomeDigest: digest, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), intentContractDigest: contract.digest, intentContract: contract, subjects: [], intent: { impulse: "Inspect the sealed repository", subjects: [], constraints: [], requestedAssays: [], mode: "auto", privacy: "local_only", control: "sovereign", seed: "held" } },
    subjectProjection: { ...projection, projectionDigest: digestJson(projection) } };
  let round = 0;
  await assert.rejects(runModelToolLoop(request, { adapterId: "mind.fixture", encode: messages => JSON.stringify(messages), async send() {
    round++;
    return JSON.stringify({ choices: [{ finish_reason: round === 1 ? "tool_calls" : "stop", message: round === 1 ? { content: "private_provider_marker", tool_calls: [
      { id: "read", type: "function", function: { name: "search_subject", arguments: JSON.stringify({ query: "private_source_marker" }) } },
      { id: "bad", type: "function", function: { name: "private_unknown_tool_marker", arguments: JSON.stringify({ private_argument_marker: true }) } },
    ] } : { content: '{"private_invalid_response_marker":true}' } }], usage: { prompt_tokens: 500, completion_tokens: 100 } });
  } }), error => {
    assert.ok(error instanceof MindMeteredFailure);
    const diagnostic = mindFailureInvestigation(error)!;
    assert.equal(diagnostic.boundary, "FINAL_CONTRIBUTION");
    assert.equal(diagnostic.providerRounds, 2);
    assert.deepEqual(diagnostic.tools.map(tool => tool.status), ["observed", "denied"]);
    assert.deepEqual(diagnostic.tools[0]!.sourceDigests, [digest]);
    assert.equal(diagnostic.tools[1]!.name, "unrecognized-tool");
    assert.equal(diagnostic.authority, "context-only");
    assert.ok(Object.isFrozen(diagnostic.tools[0]!.sourceDigests));
    assert.equal(JSON.stringify(diagnostic).includes("private_"), false);
    assert.equal(mindFailureInputUpperBound(error, 1), error.transmittedInputBytes);
    assert.ok(error.transmittedInputBytes > 100);
    return true;
  });
  const forged = Object.assign(new Error("fake"), { investigation: { protocol: "jevyr.model-investigation-failure/1", tools: [source] } });
  assert.equal(mindFailureInvestigation(forged), undefined);
});

test("a failure before dispatch records zero provider rounds and no invented context observations", async () => {
  await assert.rejects(runModelToolLoop({ preparedPublicPrompt: "larger than the input allowance", maxInputTokens: 0, maxOutputTokens: 1, signal: new AbortController().signal } as MindRequest, { adapterId: "mind.fixture", encode: () => "request", async send() { throw new Error("must not dispatch"); } }), error => {
    const diagnostic = mindFailureInvestigation(error)!;
    assert.equal(diagnostic.boundary, "INPUT_BUDGET"); assert.equal(diagnostic.providerRounds, 0); assert.deepEqual(diagnostic.tools, []);
    return true;
  });
});
