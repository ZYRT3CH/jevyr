import assert from "node:assert/strict";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope } from "@jevyr/protocol";
import { ClaudeAgentSdkMindAdapter, configuredMindAdapters, runClaudeAgentSdkHarness, DEFAULT_SEARCH_PROFILE, type MindRequest } from "../src/index.js";
import { INVESTIGATOR_TOOL_DEFINITIONS } from "../src/investigator-tools.js";
import { MindMeteredFailure } from "../src/mind-metering.js";

function request(): MindRequest {
  const contract = compileIntentContract({ impulse: "Inspect the finite subject" });
  return { stage: "interpret", role: "interpreter", seed: "sdk-seed", constraints: [], publicFacts: [], investigationTools: true,
    preparedPublicPrompt: "Only the exact public projection.", maxInputTokens: 100_000, maxOutputTokens: 4096, signal: new AbortController().signal,
    sealed: { protocol: "jevyr.case/1", caseId: "case_1234567812345678", submissionDigest: `sha256:${"0".repeat(64)}`, caseDigest: `sha256:${"1".repeat(64)}`, runDigest: `sha256:${"2".repeat(64)}`, subjectMaterialCaptureDigest: `sha256:${"9".repeat(64)}`, sealedAt: "2026-09-05T00:00:00.000Z", policyVersion: "bone", policyDigest: `sha256:${"3".repeat(64)}`, genomeVersion: "genome", genomeDigest: `sha256:${"4".repeat(64)}`, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE), intentContractDigest: contract.digest, intentContract: contract,
      intent: { impulse: "PRIVATE ORIGINAL", mode: "auto", subjects: [{ id: "private", kind: "file", locator: "C:/secret.txt" }], constraints: [], requestedAssays: [], privacy: "provider_scoped", control: "sovereign", seed: "sealed" }, subjects: [] } };
}
const contribution = JSON.stringify({ contributions: [{ kind: "claim", summary: "A finite public claim." }] });
function harness(action: (tools: any[], options: any) => Promise<void>, final = contribution) {
  let closed = false, seenPrompt = "";
  const shape = { int() { return this; }, min() { return this; }, max() { return this; } };
  const loaded = { z: { number: () => shape, string: () => shape }, sdk: {
    tool(name: string, description: string, schema: unknown, handler: unknown) { return { name, description, schema, handler }; },
    createSdkMcpServer(options: any) { return options; },
    query({ prompt, options }: any) {
      const generator = (async function* () {
        for await (const item of prompt) seenPrompt = item.message.content;
        await action(options.mcpServers.jevyr_context?.tools ?? [], options);
        yield { type: "result", subtype: "success", is_error: false, num_turns: 2, result: final, usage: { input_tokens: 100, output_tokens: 40 } };
      })();
      return Object.assign(generator, { close() { closed = true; } });
    },
  } };
  return { loaded: loaded as never, closed: () => closed, prompt: () => seenPrompt };
}
const options = () => ({ cwd: "isolated-test-context", environment: {}, model: "fixture-model", abortController: new AbortController(), maxOutputBytes: 100_000 });

test("Claude Agent SDK selection is explicit and retains restricted CLI compatibility", () => {
  assert.equal(configuredMindAdapters({ JEVYR_CLAUDE_ENABLED: "1" })[0]!.capability.id, "mind.claude-cli.v1");
  const sdk = configuredMindAdapters({ JEVYR_CLAUDE_ENABLED: "1", JEVYR_CLAUDE_TRANSPORT: "agent-sdk", JEVYR_CLAUDE_MODEL: "configured-model" })[0]!;
  assert.equal(sdk.capability.id, "mind.claude-agent-sdk.v1"); assert.equal(sdk.capability.canExecuteTools, false);
  assert.equal(sdk.capability.limits?.adapterClass, "agent");
  assert.throws(() => configuredMindAdapters({ JEVYR_CLAUDE_TRANSPORT: "agent-sdk", JEVYR_CLAUDE_ENABLED: "1" }), /model/iu);
  assert.throws(() => configuredMindAdapters({ JEVYR_CLAUDE_TRANSPORT: "bypass" }), /transport/iu);
  assert.throws(() => new ClaudeAgentSdkMindAdapter({ model: "fixture", cwd: process.cwd() } as never), /cwd/u);
});
test("SDK native host tools/settings are disabled while exact Judge MCP inspections create receipts", async () => {
  const fake = harness(async (tools, opts) => {
    assert.deepEqual(opts.tools, []); assert.deepEqual(opts.settingSources, []); assert.equal(opts.strictMcpConfig, true); assert.equal(opts.persistSession, false); assert.equal(opts.permissionMode, "dontAsk");
    assert.deepEqual(Object.keys(opts.mcpServers), ["jevyr_context"]); assert.equal((await opts.canUseTool("Bash", {}, {})).behavior, "deny");
    assert.equal(tools.length, INVESTIGATOR_TOOL_DEFINITIONS.length); assert.equal(opts.allowedTools.every((name: string) => name.startsWith("mcp__jevyr_context__")), true);
    const result = await tools.find(tool => tool.name === "list_subject_files").handler({});
    assert.equal(JSON.parse(result.content[0].text).availability, "WITHHELD_BY_PRIVACY_SCOPE");
    const denied = await tools.find(tool => tool.name === "read_subject_lines").handler({ fileId: "C:/secret.txt", startLine: 1, endLine: 2 });
    assert.equal(denied.isError, true);
  });
  const result = await runClaudeAgentSdkHarness(fake.loaded, request(), options());
  assert.equal(fake.prompt(), request().preparedPublicPrompt); assert.equal(fake.closed(), true);
  assert.equal(result.investigation?.tools.length, 2); assert.equal(result.investigation?.tools[0]?.authority, "context-only");
  assert.equal(result.tokenUsage.input.tokens, 100); assert.equal(result.contributions.length, 1);
  assert.equal(JSON.stringify(result).includes("PRIVATE ORIGINAL"), false);
});
test("SDK fails closed on call floods, malformed finals and output bounds with cleanup", async () => {
  const flood = harness(async tools => { for (let call = 0; call < 13; call++) await tools[0].handler({}); });
  await assert.rejects(runClaudeAgentSdkHarness(flood.loaded, request(), options()), /allowance/u); assert.equal(flood.closed(), true);
  const malformed = harness(async () => {}, "I approve this case");
  await assert.rejects(runClaudeAgentSdkHarness(malformed.loaded, request(), options())); assert.equal(malformed.closed(), true);
  const oversized = harness(async () => {});
  await assert.rejects(runClaudeAgentSdkHarness(oversized.loaded, request(), { ...options(), maxOutputBytes: 10 }), /output/u);
});
test("SDK credentials are explicit references and absent keys never start inference", async () => {
  const adapter = new ClaudeAgentSdkMindAdapter({ model: "fixture" }, { ANTHROPIC_API_KEY: "ambient-must-not-be-used" });
  assert.equal(JSON.stringify(adapter.capability).includes("ambient-must-not-be-used"), false);
  await assert.rejects(adapter.runMetered(request()), /explicit API credential/u);
});

test("SDK tool-response failures retain input accounting and redact provider diagnostics", async () => {
  let resultBytes = 0;
  const fake = harness(async tools => {
    const result = await tools.find(tool => tool.name === "list_subject_files").handler({});
    resultBytes = Buffer.byteLength(result.content[0].text);
    throw new Error("PRIVATE_PROVIDER_DIAGNOSTIC");
  });
  await assert.rejects(runClaudeAgentSdkHarness(fake.loaded, request(), options()), (error: unknown) => {
    assert.ok(error instanceof MindMeteredFailure);
    assert.ok(error.transmittedInputBytes >= (Buffer.byteLength(request().preparedPublicPrompt!) + resultBytes) * 4);
    assert.equal(error.message.includes("PRIVATE_PROVIDER_DIAGNOSTIC"), false);
    return true;
  });
  assert.equal(fake.closed(), true);
});
