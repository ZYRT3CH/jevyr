import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope } from "@jevyr/protocol";
import {
  DEFAULT_SEARCH_PROFILE,
  DEFAULT_MCP_SAMPLING_MAX_TOKENS,
  MCP_SAMPLING_MIND_ID,
  McpSamplingMindAdapter,
  MindMeteredFailure,
  makePublicMindPrompt,
  type ExperimentCapability,
  type McpCreateMessageParams,
  type MindRequest,
  type SealedCaseContext,
} from "../src/index.js";

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const intentContract = compileIntentContract({ impulse: "Build one finite mechanism through the caller model" });

const sealed: SealedCaseContext = {
  protocol: "jevyr.case/1",
  caseId: "case_mcp_sampling_12345678",
  submissionDigest: digest("0"),
  subjectMaterialCaptureDigest: digest("1"),
  caseDigest: digest("2"),
  runDigest: digest("3"),
  sealedAt: "2026-09-05T00:00:00.000Z",
  policyVersion: "jevyr.bone/1",
  policyDigest: digest("4"),
  genomeVersion: "jevyr.genome/1",
  genomeDigest: digest("5"),
  searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
  intentContractDigest: intentContract.digest,
  intentContract,
  intent: {
    impulse: "Build one finite mechanism through the caller model",
    mode: "auto",
    subjects: [],
    constraints: [],
    requestedAssays: [],
    privacy: "provider_scoped",
    control: "sovereign",
    seed: "mcp-sampling-fixture",
  },
  subjects: [],
};

const experimentCapability: ExperimentCapability = Object.freeze({
  protocol: "jevyr.experiment-capability/1",
  frontierDigest: digest("6"),
  intentContractDigest: intentContract.digest,
  experiments: Object.freeze([Object.freeze({
    assayId: "jevyr.experiment.node-v1",
    costUnits: 1,
    timeoutMs: 5_000,
    tool: "forge.command",
    command: Object.freeze({ executable: "node", args: Object.freeze(["jevyr.experiment.mjs"]), shell: false }),
    entryFile: "jevyr.experiment.mjs",
    authority: "comparative-only",
  })]),
  digest: digest("7"),
});

function request(overrides: Partial<MindRequest> = {}): MindRequest {
  return Object.freeze({
    stage: "diverge",
    role: "divergent",
    sealed,
    publicFacts: Object.freeze([]),
    seed: digest("8"),
    constraints: Object.freeze([]),
    experimentCapability,
    maxOutputTokens: 512,
    signal: new AbortController().signal,
    ...overrides,
  });
}

function candidate() {
  return {
    contributions: [{
      kind: "candidate",
      summary: "A finite caller-model candidate.",
      body: "The entrypoint emits one bounded observation.",
      parentIds: [],
      tags: ["caller-model"],
      feasibility: "BUILDABLE_NOW",
      confidence: null,
      evidenceRefs: [],
      blueprint: {
        protocol: "jevyr.candidate-blueprint/1",
        files: [{
          path: "jevyr.experiment.mjs",
          content: "process.stdout.write(JSON.stringify({observed:true}) + '\\n');\n",
        }],
        command: { executable: "node", args: ["jevyr.experiment.mjs"] },
      },
    }],
  };
}

function adapter(
  sample: ConstructorParameters<typeof McpSamplingMindAdapter>[0]["sample"],
  overrides: Partial<ConstructorParameters<typeof McpSamplingMindAdapter>[0]> = {},
) {
  return new McpSamplingMindAdapter({
    binding: {
      protocol: "jevyr.mcp-sampling-binding/1",
      bindingId: digest("9"),
      source: "originating-mcp-client",
      clientName: "Fixture MCP host",
      clientVersion: "1.2.3",
      mcpProtocolVersion: "2026-07-28",
    },
    sample,
    ...overrides,
  });
}

test("borrows exactly one bounded caller-model sample and records client-asserted provenance", async () => {
  let sent: McpCreateMessageParams | undefined;
  const mind = adapter(async (params) => {
    sent = params;
    return {
      role: "assistant",
      content: { type: "text", text: JSON.stringify(candidate()), privateReasoning: "MUST_NOT_PROPAGATE" },
      model: "actual/client-model",
      stopReason: "endTurn",
      _meta: { hidden: "MUST_NOT_PROPAGATE" },
    };
  }, {
    modelHints: ["preferred-model"],
    intelligencePriority: 0.9,
    speedPriority: 0.2,
  });
  const mindRequest = request();
  const result = await mind.runMetered(mindRequest);
  const prompt = makePublicMindPrompt(mindRequest);
  const raw = JSON.stringify(candidate());

  assert.equal(mind.capability.id, MCP_SAMPLING_MIND_ID);
  assert.equal(mind.capability.network, "provider");
  assert.equal(mind.capability.canExecuteTools, false);
  assert.equal(mind.capability.limits?.bindingId, digest("9"));
  assert.deepEqual(Object.keys(sent ?? {}).sort(), [
    "includeContext", "maxTokens", "messages", "modelPreferences", "temperature",
  ]);
  assert.equal(sent?.includeContext, "none");
  assert.equal(sent?.maxTokens, 512);
  assert.equal(sent?.messages[0].content.text, prompt);
  assert.deepEqual(sent?.modelPreferences?.hints, [{ name: "preferred-model" }]);
  assert.equal(result.contributions.length, 1);
  assert.deepEqual(result.tokenUsage, {
    input: { tokens: Buffer.byteLength(prompt), measurement: "UPPER_BOUND" },
    output: { tokens: Buffer.byteLength(raw), measurement: "UPPER_BOUND" },
  });
  assert.deepEqual(result.samplingReceipt, {
    protocol: "jevyr.mcp-sampling-receipt/1",
    adapterId: MCP_SAMPLING_MIND_ID,
    bindingId: digest("9"),
    source: "originating-mcp-client",
    clientName: "Fixture MCP host",
    clientVersion: "1.2.3",
    mcpProtocolVersion: "2026-07-28",
    caseDigest: sealed.caseDigest,
    runDigest: sealed.runDigest,
    stage: "diverge",
    clientReportedModel: "actual/client-model",
    stopReason: "endTurn",
    requestedMaxTokens: 512,
    promptDigest: `sha256:${createHash("sha256").update(prompt).digest("hex")}`,
    outputDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
  });
  assert.equal(JSON.stringify(result).includes("MUST_NOT_PROPAGATE"), false);
  assert.equal(Object.isFrozen(result.samplingReceipt), true);
});

test("defaults to a 90000-token request ceiling while sealed and embedder limits may tighten it", async (t) => {
  assert.equal(DEFAULT_MCP_SAMPLING_MAX_TOKENS, 90_000);

  await t.test("stock ceiling", async () => {
    let sent: McpCreateMessageParams | undefined;
    const mind = adapter(async (params) => {
      sent = params;
      return { role: "assistant", content: { type: "text", text: JSON.stringify(candidate()) }, model: "m", stopReason: "endTurn" };
    });
    const result = await mind.runMetered(request({ maxOutputTokens: 250_000 }));
    assert.equal(sent?.maxTokens, 90_000);
    assert.equal(mind.capability.limits?.maxTokensCeiling, 90_000);
    assert.equal(result.samplingReceipt.requestedMaxTokens, 90_000);
  });

  await t.test("sealed per-call remainder", async () => {
    let sent: McpCreateMessageParams | undefined;
    const mind = adapter(async (params) => {
      sent = params;
      return { role: "assistant", content: { type: "text", text: JSON.stringify(candidate()) }, model: "m", stopReason: "endTurn" };
    });
    await mind.runMetered(request({ maxOutputTokens: 12_345 }));
    assert.equal(sent?.maxTokens, 12_345);
  });

  await t.test("explicit adapter ceiling", async () => {
    let sent: McpCreateMessageParams | undefined;
    const mind = adapter(async (params) => {
      sent = params;
      return { role: "assistant", content: { type: "text", text: JSON.stringify(candidate()) }, model: "m", stopReason: "endTurn" };
    }, { maxTokensCeiling: 7_777 });
    await mind.runMetered(request({ maxOutputTokens: 250_000 }));
    assert.equal(sent?.maxTokens, 7_777);
    assert.equal(mind.capability.limits?.maxTokensCeiling, 7_777);
  });
});

test("preflights sealed input and output permission before invoking the broker", async (t) => {
  await t.test("input", async () => {
    let calls = 0;
    const mindRequest = request();
    const promptBytes = Buffer.byteLength(makePublicMindPrompt(mindRequest));
    await assert.rejects(
      adapter(async () => {
        calls += 1;
        throw new Error("unreachable");
      }).runMetered(request({ maxInputTokens: promptBytes - 1 })),
      (error: unknown) => {
        assert.ok(error instanceof MindMeteredFailure);
        assert.equal(error.transmittedInputBytes, 0);
        assert.match(error.message, /sealed input-token permission/u);
        return true;
      },
    );
    assert.equal(calls, 0);
  });
  await t.test("output", async () => {
    let calls = 0;
    await assert.rejects(
      adapter(async () => {
        calls += 1;
        throw new Error("unreachable");
      }).runMetered(request({ maxOutputTokens: 0 })),
      (error: unknown) => {
        assert.ok(error instanceof MindMeteredFailure);
        assert.equal(error.transmittedInputBytes, 0);
        assert.match(error.message, /no positive completion-token permission/u);
        return true;
      },
    );
    assert.equal(calls, 0);
  });
});

test("rejects truncation, tool use, hidden blocks, and unknown terminal reasons", async (t) => {
  for (const [name, response, expected] of [
    ["truncation", { role: "assistant", content: { type: "text", text: "{}" }, model: "m", stopReason: "maxTokens" }, /truncated/u],
    ["tool use", { role: "assistant", content: { type: "text", text: "{}" }, model: "m", stopReason: "toolUse" }, /granted no tools/u],
    ["hidden block", { role: "assistant", content: { type: "thinking", thinking: "secret" }, model: "m", stopReason: "endTurn" }, /non-text or hidden/u],
    ["unknown stop", { role: "assistant", content: { type: "text", text: "{}" }, model: "m", stopReason: "provider_private_reason" }, /recognized complete stop/u],
  ] as const) {
    await t.test(name, async () => {
      const mindRequest = request();
      const promptBytes = Buffer.byteLength(makePublicMindPrompt(mindRequest));
      await assert.rejects(
        adapter(async () => response as never).runMetered(mindRequest),
        (error: unknown) => {
          assert.ok(error instanceof MindMeteredFailure);
          assert.equal(error.transmittedInputBytes, promptBytes);
          assert.match(error.message, expected);
          assert.equal(error.cause, undefined);
          assert.doesNotMatch(error.message, /secret|provider_private_reason/u);
          return true;
        },
      );
    });
  }
});

test("broker failures are cause-free and charge the one transmitted prompt", async () => {
  const mindRequest = request();
  const promptBytes = Buffer.byteLength(makePublicMindPrompt(mindRequest));
  await assert.rejects(
    adapter(async () => {
      throw new Error("PRIVATE_CLIENT_BODY api_key=secret");
    }).runMetered(mindRequest),
    (error: unknown) => {
      assert.ok(error instanceof MindMeteredFailure);
      assert.equal(error.transmittedInputBytes, promptBytes);
      assert.equal(error.message, "MCP caller-model sampling failed at the injected broker boundary");
      assert.equal(error.cause, undefined);
      return true;
    },
  );
});

test("probe reports only broker availability and never performs sampling", async () => {
  let samples = 0;
  const mind = adapter(async () => {
    samples += 1;
    throw new Error("not a probe");
  }, { probe: async () => false });
  const result = await mind.probe();
  assert.equal(result.available, false);
  assert.match(result.detail, /no available binding/u);
  assert.equal(samples, 0);
});
