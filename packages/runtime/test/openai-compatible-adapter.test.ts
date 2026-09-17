import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import {
  DEFAULT_SEARCH_PROFILE,
  MindMeteredFailure,
  OpenAICompatibleMindAdapter,
  makePublicMindPrompt,
  type ExperimentCapability,
  type MindRequest,
  type SealedCaseContext,
  type SubjectTextProjection,
  executeInvestigatorTool,
} from "../src/index.js";
import { captureSubjectMaterials, capturedSubjectMaterialReader, projectSubjectText } from "../src/subject-materials.js";
import { createSubjectContext } from "../src/subject-context.js";
import { assertAgentContextInspected } from "../src/adapters/agent-context.js";
import { taskSourceInspectionPlan } from "../src/task-source-inspection.js";

const intentContract = compileIntentContract({ impulse: "Build one finite self-discriminating mechanism" });

const sealed: SealedCaseContext = {
  protocol: "jevyr.case/1",
  caseId: "case_openai_adapter_12345678",
  submissionDigest: `sha256:${"0".repeat(64)}`,
  subjectMaterialCaptureDigest: `sha256:${"1".repeat(64)}`,
  caseDigest: `sha256:${"2".repeat(64)}`,
  runDigest: `sha256:${"3".repeat(64)}`,
  sealedAt: "2026-09-05T00:00:00.000Z",
  policyVersion: "jevyr.bone/1",
  policyDigest: `sha256:${"4".repeat(64)}`,
  genomeVersion: "jevyr.genome/1",
  genomeDigest: `sha256:${"5".repeat(64)}`,
  searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
  intentContractDigest: intentContract.digest,
  intentContract,
  intent: {
    impulse: "Build one finite self-discriminating mechanism",
    mode: "auto",
    subjects: [],
    constraints: [],
    requestedAssays: [],
    privacy: "local_only",
    control: "sovereign",
    seed: "adapter-fixture",
  },
  subjects: [],
};

const experimentCapability: ExperimentCapability = Object.freeze({
  protocol: "jevyr.experiment-capability/1",
  frontierDigest: `sha256:${"6".repeat(64)}`,
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
  digest: `sha256:${"7".repeat(64)}`,
});

function request(): MindRequest {
  return Object.freeze({
    stage: "diverge",
    role: "divergent",
    sealed,
    publicFacts: Object.freeze([Object.freeze({
      id: "contrib_parent_12345678",
      kind: "candidate" as const,
      summary: "A prior abstract mechanism.",
      candidateBlueprintSource: {
        protocol: "jevyr.candidate-blueprint/1",
        files: [{ path: "do-not-forward.mjs", content: "DO_NOT_FORWARD_RAW_BLUEPRINT" }],
      },
    })]),
    seed: `sha256:${"8".repeat(64)}`,
    constraints: Object.freeze([]),
    experimentCapability,
    maxOutputTokens: 512,
    signal: new AbortController().signal,
  });
}

function finiteCandidate(entryFile = "jevyr.experiment.mjs") {
  return {
    contributions: [{
      kind: "candidate",
      summary: "A finite provider candidate.",
      body: "The entry file emits one bounded inspectable observation.",
      parentIds: [],
      tags: ["finite-source"],
      feasibility: "BUILDABLE_NOW",
      confidence: null,
      evidenceRefs: [],
      blueprint: {
        protocol: "jevyr.candidate-blueprint/1",
        files: [{
          path: entryFile,
          content: "process.stdout.write(JSON.stringify({observed:true}) + '\\n');\n",
        }],
        command: { executable: "node", args: [entryFile] },
      },
    }],
  };
}

async function readJsonRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function completion(
  response: ServerResponse,
  content: string,
  finishReason: string = "stop",
  usage: Record<string, number> = { prompt_tokens: 23, completion_tokens: 17 },
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage,
  }));
}

async function fixtureServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => void Promise.resolve(handler(request, response)).catch((error) => {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an IP fixture address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/`,
    close: async () => await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve())),
  };
}

function adapter(baseUrl: string): OpenAICompatibleMindAdapter {
  return new OpenAICompatibleMindAdapter({
    id: "mind.openai-compatible.fixture",
    displayName: "Fixture provider",
    baseUrl,
    model: "fixture-model",
  });
}

function inspectedRequest(): MindRequest {
  const text = "export const triple = (n) => n * 4;\n";
  const body = { protocol: "jevyr.subject-text-projection/1" as const, files: [{ subjectId: "subject-a", path: "math.mjs", sourceDigest: sha256Digest(text), sourceByteLength: Buffer.byteLength(text), text }], omissions: [], manifestDigests: [], includedBytes: Buffer.byteLength(text), limits: { maxFileBytes: 96_000, maxTotalBytes: 512_000, maxFiles: 256 } };
  const projection: SubjectTextProjection = { ...body, projectionDigest: digestJson(body as unknown as JsonValue) };
  return { ...request(), investigationTools: true, subjectProjection: projection, maxInputTokens: 100_000, maxOutputTokens: 4_000 };
}

test("native inspection discovers and reads a sealed catalog file outside the initial projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-broker-model-loop-"));
  const tree = join(root, "tree"), store = join(root, "cas");
  await mkdir(tree);
  try {
    for (let index = 0; index < 12; index++) await writeFile(join(tree, `file-${String(index).padStart(2, "0")}.mjs`), index === 11 ? "export const laterEvidence = 43;\n" : `export const hint = ${index};\n`);
    const capture = await captureSubjectMaterials(store, [{ id: "tree", kind: "directory", locator: tree }], sealed.sealedAt, {}, { resolveArtifact: async () => undefined });
    const reader = capturedSubjectMaterialReader(store);
    const subjectContext = await createSubjectContext({ captureDigest: capture.captureDigest, bindings: capture.bindings, reader, privacy: "local_only", providerNetwork: "loopback" });
    assert.ok(subjectContext);
    const subjectProjection = await projectSubjectText(store, capture.bindings, { maxFiles: 1 });
    const input: MindRequest = { ...inspectedRequest(), sealed: { ...sealed, subjectMaterialCaptureDigest: capture.captureDigest }, subjectProjection, subjectContext };
    assert.equal(subjectProjection.files.length, 1);
    assert.equal(subjectProjection.files[0]!.path, "file-00.mjs");
    const prompt = makePublicMindPrompt(input);
    assert.ok(prompt.includes(subjectContext.descriptor.catalogDigest));
    assert.ok(prompt.includes('"readableFiles":12'));
    assert.equal(prompt.includes("laterEvidence"), false);
    assert.equal(prompt.includes(tree), false);
    assert.equal(prompt.includes("readManifest"), false);
    let round = 0, laterId = "";
    const server = await fixtureServer(async (incoming, response) => {
      const sent = await readJsonRequest(incoming); round++;
      if (round < 3) {
        const calls = (sent.response_format as any).json_schema.schema.properties.calls.items.anyOf;
        const read = calls.find((call: any) => call.properties.name.enum[0] === "read_subject_lines");
        assert.equal(read.properties.arguments.properties.fileId.enum, undefined, "catalog IDs must not be restricted to prompt hints");
        assert.equal(sent.tool_choice, "auto", "both inspection request channels remain available after a metadata-only listing");
      }
      if (round === 1) {
        completion(response, JSON.stringify({ protocol: "jevyr.context-tools/1", calls: [{ name: "list_subject_files", arguments: { offset: 10, limit: 2 } }] }));
      } else if (round === 2) {
        const listing = JSON.parse((sent.messages as { content: string }[]).at(-1)!.content).result;
        assert.equal(listing.total, 12);
        laterId = listing.files.find((file: any) => file.path === "file-11.mjs").fileId;
        assert.ok(laterId);
        completion(response, JSON.stringify({ protocol: "jevyr.context-tools/1", calls: [{ name: "read_subject_lines", arguments: { fileId: laterId, startLine: 1, endLine: 2 } }] }));
      } else {
        const read = JSON.parse((sent.messages as { content: string }[]).at(-1)!.content).result;
        assert.equal(read.text, "export const laterEvidence = 43;\n");
        const candidate = finiteCandidate();
        candidate.contributions[0]!.blueprint.files[0]!.content = `process.exit(${read.text.includes("43") ? 0 : 9});\n`;
        completion(response, JSON.stringify(candidate));
      }
    });
    try {
      const result = await adapter(server.baseUrl).runMetered(input);
      assert.equal(result.investigation?.providerRounds, 3);
      assert.deepEqual(result.investigation?.tools[0]?.sourceDigests, []);
      assert.deepEqual(result.investigation?.tools[1]?.sourceDigests, [sha256Digest("export const laterEvidence = 43;\n")]);
      assert.equal(result.investigation?.tools[1]?.status, "observed");
      const { subjectProjection: _hint, ...brokerOnly } = input;
      assert.throws(() => assertAgentContextInspected(brokerOnly, []), /lacks a receipt/u);
      assert.throws(() => assertAgentContextInspected(brokerOnly, [result.investigation!.tools[0]!]), /lacks a receipt/u);
      assert.doesNotThrow(() => assertAgentContextInspected(brokerOnly, result.investigation!.tools));
      assert.match(JSON.stringify(result.contributions[0]?.candidateBlueprintSource), /process.exit\(0\)/u);
      const badCapture = { ...input, sealed: { ...input.sealed, subjectMaterialCaptureDigest: sha256Digest("other capture") } };
      const denied = await executeInvestigatorTool(badCapture, "read_subject_lines", JSON.stringify({ fileId: laterId, startLine: 1, endLine: 2 }));
      assert.equal(denied.receipt.status, "denied"); assert.deepEqual(denied.receipt.sourceDigests, []);
      assert.equal(denied.content.includes("laterEvidence"), false);
      const withheld = await createSubjectContext({ captureDigest: capture.captureDigest, bindings: capture.bindings, reader, privacy: "local_only", providerNetwork: "provider" });
      assert.equal(withheld, undefined);
      const { subjectProjection: _projection, subjectContext: _context, ...privateRequest } = input;
      assert.equal(makePublicMindPrompt(privateRequest).includes(subjectContext.descriptor.catalogDigest), false);
      assert.equal((await executeInvestigatorTool(privateRequest, "read_subject_lines", JSON.stringify({ fileId: laterId, startLine: 1, endLine: 2 }))).receipt.status, "denied");
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an empty legacy projection does not require an impossible source receipt", async () => {
  const original = inspectedRequest(), { projectionDigest: _digest, ...body } = original.subjectProjection!;
  const empty = { ...body, includedBytes: 0, files: body.files.map(file => ({ ...file, text: "", sourceByteLength: 0, sourceDigest: sha256Digest("") })) };
  const server = await fixtureServer(async (incoming, response) => {
    const sent = await readJsonRequest(incoming);
    assert.equal(sent.tool_choice, "auto");
    completion(response, JSON.stringify(finiteCandidate()));
  });
  try {
    const result = await adapter(server.baseUrl).runMetered({ ...original, subjectProjection: { ...empty, projectionDigest: digestJson(empty as unknown as JsonValue) } });
    assert.equal(result.investigation?.providerRounds, 1);
    assert.deepEqual(result.investigation?.tools, []);
    assert.doesNotThrow(() => assertAgentContextInspected({ ...original, subjectProjection: { ...empty, projectionDigest: digestJson(empty as unknown as JsonValue) } }, []));
  } finally { await server.close(); }
});

test("a binary and empty-only sealed catalog remains explicit without forcing invented source inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-broker-unreadable-"));
  const tree = join(root, "tree"), store = join(root, "cas");
  await mkdir(tree);
  try {
    await writeFile(join(tree, "empty.txt"), "");
    await writeFile(join(tree, "binary.bin"), Buffer.from([0x00, 0xff, 0x07]));
    const capture = await captureSubjectMaterials(store, [{ id: "tree", kind: "directory", locator: tree }], sealed.sealedAt, {}, { resolveArtifact: async () => undefined });
    const subjectContext = await createSubjectContext({ captureDigest: capture.captureDigest, bindings: capture.bindings, reader: capturedSubjectMaterialReader(store), privacy: "local_only", providerNetwork: "loopback" });
    assert.ok(subjectContext);
    assert.equal(subjectContext.descriptor.readableFiles, 0);
    assert.equal(subjectContext.descriptor.emptyFiles, 1);
    assert.equal(subjectContext.descriptor.binaryFiles, 1);
    const { subjectProjection: _projection, ...base } = inspectedRequest();
    const input: MindRequest = { ...base, subjectContext, sealed: { ...sealed, subjectMaterialCaptureDigest: capture.captureDigest } };
    const server = await fixtureServer(async (incoming, response) => {
      const sent = await readJsonRequest(incoming);
      assert.equal(sent.tool_choice, "auto");
      assert.ok(makePublicMindPrompt(input).includes('"readableFiles":0'));
      completion(response, JSON.stringify(finiteCandidate()));
    });
    try {
      const result = await adapter(server.baseUrl).runMetered(input);
      assert.equal(result.investigation?.providerRounds, 1);
      assert.deepEqual(result.investigation?.tools, []);
      assert.doesNotThrow(() => assertAgentContextInspected(input, []));
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an initially unclassified file is advertised as unknown and only a real read creates a receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-broker-unknown-"));
  const tree = join(root, "tree"), store = join(root, "cas");
  await mkdir(tree);
  try {
    await writeFile(join(tree, "a-binary.bin"), Buffer.alloc(64));
    await writeFile(join(tree, "z-later.txt"), "UNKNOWN_UNTIL_TOOL_READ");
    const capture = await captureSubjectMaterials(store, [{ id: "tree", kind: "directory", locator: tree }], sealed.sealedAt, {}, { resolveArtifact: async () => undefined });
    const subjectContext = await createSubjectContext({ captureDigest: capture.captureDigest, bindings: capture.bindings, reader: capturedSubjectMaterialReader(store), privacy: "local_only", providerNetwork: "loopback", limits: { maxScanBytes: 64, maxFileBytes: 64 } });
    assert.ok(subjectContext);
    assert.equal(subjectContext.descriptor.readableFiles, 0);
    assert.equal(subjectContext.descriptor.uninspectedFiles, 1);
    const { subjectProjection: _projection, ...base } = inspectedRequest();
    const input: MindRequest = { ...base, subjectContext, sealed: { ...sealed, subjectMaterialCaptureDigest: capture.captureDigest } };
    assert.equal(makePublicMindPrompt(input).includes("UNKNOWN_UNTIL_TOOL_READ"), false);
    assert.ok(makePublicMindPrompt(input).includes('"uninspectedFiles":1'));
    assert.doesNotThrow(() => assertAgentContextInspected(input, []));
    const server = await fixtureServer(async (incoming, response) => {
      assert.equal((await readJsonRequest(incoming)).tool_choice, "auto");
      completion(response, JSON.stringify(finiteCandidate()));
    });
    try {
      const result = await adapter(server.baseUrl).runMetered(input);
      assert.deepEqual(result.investigation?.tools, []);
      const listing = await executeInvestigatorTool(input, "list_subject_files", "{}");
      assert.deepEqual(listing.receipt.sourceDigests, []);
      const fileId = JSON.parse(listing.content).files.find((file: any) => file.path === "z-later.txt").fileId;
      const read = await executeInvestigatorTool(input, "read_subject_lines", JSON.stringify({ fileId, startLine: 1, endLine: 1 }));
      assert.equal(JSON.parse(read.content).text, "UNKNOWN_UNTIL_TOOL_READ");
      assert.deepEqual(read.receipt.sourceDigests, [sha256Digest("UNKNOWN_UNTIL_TOOL_READ")]);
    } finally { await server.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("native rounds retain source tools and constrain early final candidates with the existing strict schema", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = await fixtureServer(async (incoming, response) => {
    const sent = await readJsonRequest(incoming);
    requests.push(sent);
    const format = sent.response_format as { type: string; json_schema: { name: string; strict: boolean; schema: any } };
    assert.equal(format.type, "json_schema");
    assert.equal(format.json_schema.strict, true);
    assert.equal(format.json_schema.schema.additionalProperties, false);
    if (requests.length === 1) {
      assert.equal(format.json_schema.name, "jevyr_context_request_v1");
      assert.deepEqual(format.json_schema.schema.required, ["protocol", "calls"]);
      assert.equal(sent.parallel_tool_calls, false);
      assert.equal(sent.tool_choice, "auto");
      assert.deepEqual((sent.tools as { function: { name: string } }[]).map(tool => tool.function.name), ["list_subject_files", "read_subject_lines", "search_subject"]);
      assert.doesNotMatch(String((sent.messages as { content: string }[])[0]!.content), /n \* 4/u);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "inspect-1", type: "function", function: { name: "search_subject", arguments: '{"query":"triple"}' } }] } }], usage: { prompt_tokens: 30, completion_tokens: 20 } }));
      return;
    }
    assert.equal(format.json_schema.name, "jevyr_context_or_candidate_v1");
    assert.deepEqual(format.json_schema.schema.properties.contributions.items.properties.kind.enum, ["candidate"]);
    assert.equal(sent.tool_choice, "auto", "the early final still permits additional native investigation");
    const tool = (sent.messages as { role: string; content: string }[]).find(entry => entry.role === "tool")!;
    const observed = JSON.parse(tool.content).matches[0].text;
    const candidate = finiteCandidate();
    candidate.contributions[0]!.blueprint.files[0]!.content = observed.includes("n * 4") ? "process.exit(9);\n" : "process.exit(0);\n";
    completion(response, JSON.stringify(candidate), "stop", { prompt_tokens: 80, completion_tokens: 90 });
  });
  try {
    const result = await adapter(server.baseUrl).runMetered(inspectedRequest());
    assert.equal(requests.length, 2);
    assert.equal(result.investigation?.providerRounds, 2);
    assert.equal(result.investigation?.tools[0]?.status, "observed");
    assert.equal(result.investigation?.tools[0]?.authority, "context-only");
    assert.equal(result.tokenUsage.input.tokens, 110);
    assert.equal(result.tokenUsage.output.tokens, 110);
    assert.equal(result.transmittedInputBytes, requests.reduce((sum, body) => sum + Buffer.byteLength(JSON.stringify(body)), 0));
    assert.match(JSON.stringify(result.contributions[0]?.candidateBlueprintSource), /process.exit\(9\)/u);
    assert.ok(result.investigation?.tools[0]?.sourceDigests.includes(inspectedRequest().subjectProjection!.files[0]!.sourceDigest));
  } finally { await server.close(); }
});

test("native wire permits four exact required reads in its existing structured batch channel", async () => {
  const base = inspectedRequest(), { projectionDigest: _digest, ...original } = base.subjectProjection!;
  const files = ["one.txt", "two.txt", "three.txt", "four.txt"].map(path => ({ ...original.files[0]!, path }));
  const body = { ...original, files, includedBytes: files.reduce((sum, file) => sum + file.sourceByteLength, 0) };
  const input: MindRequest = { ...base, sealed: { ...sealed, intent: { ...sealed.intent, impulse: "Read one.txt two.txt three.txt four.txt before constructing the experiment." } }, subjectProjection: { ...body, projectionDigest: digestJson(body as unknown as JsonValue) } };
  const plan = taskSourceInspectionPlan(input); assert.equal(plan.references.filter(row => row.status === "REQUIRED").length, 4);
  let rounds = 0;
  const server = await fixtureServer(async (incoming, response) => {
    const sent = await readJsonRequest(incoming); rounds++;
    if (rounds === 1) {
      assert.equal(sent.parallel_tool_calls, false);
      assert.equal(sent.tool_choice, "auto", "required native calls must not prohibit the advertised content batch");
      const schema = (sent.response_format as any).json_schema.schema;
      assert.deepEqual(schema.required, ["protocol", "calls"]);
      assert.equal(schema.properties.contributions, undefined, "source-required content cannot be an early final");
      assert.match(String((sent.messages as { content: string }[])[0]!.content), /batch.*jevyr.context-tools\/1/u);
      assert.equal(schema.properties.calls.maxItems, 4);
      const readSchema = schema.properties.calls.items.anyOf.find((call: any) => call.properties.name.enum[0] === "read_subject_lines");
      assert.deepEqual(readSchema.properties.arguments.properties.fileId.enum, plan.references.map(row => row.fileId));
      completion(response, JSON.stringify({ protocol: "jevyr.context-tools/1", calls: plan.references.map(row => ({ name: "read_subject_lines", arguments: { fileId: row.fileId, startLine: 1, endLine: row.totalLines } })) }));
    } else { assert.equal(sent.tool_choice, "auto"); completion(response, JSON.stringify(finiteCandidate())); }
  });
  try {
    const result = await adapter(server.baseUrl).runMetered(input);
    assert.equal(rounds, 2); assert.equal(result.investigation?.tools.length, 4);
    assert.ok(result.investigation!.tools.every(tool => tool.requestFormat === "jevyr.context-tools/1" && tool.sourceRead?.completeFile));
  } finally { await server.close(); }
});

test("the final native round preserves source results and finite JSON but offers no callable tools", async (context) => {
  for (const respondsWithTool of [false, true]) await context.test(respondsWithTool ? "unsolicited final tools still fail at round four" : "finite final uses the retained observations", async () => {
    const requests: Record<string, unknown>[] = [];
    const server = await fixtureServer(async (incoming, response) => {
      const sent = await readJsonRequest(incoming); requests.push(sent);
      const round = requests.length;
      assert.ok(round <= 4, "A final tool request must never create a fifth provider round");
      if (round === 4) {
        assert.equal(Object.hasOwn(sent, "tools"), false);
        assert.equal(Object.hasOwn(sent, "tool_choice"), false);
        assert.equal(Object.hasOwn(sent, "parallel_tool_calls"), false);
        const format = sent.response_format as any;
        assert.equal(format.type, "json_schema"); assert.equal(format.json_schema.strict, true);
        const contribution = format.json_schema.schema.properties.contributions.items.properties;
        assert.deepEqual(contribution.kind.enum, ["candidate"]);
        assert.deepEqual(contribution.blueprint.properties.files.contains.properties.path.enum, ["jevyr.experiment.mjs"]);
        assert.deepEqual(contribution.blueprint.properties.command.anyOf[0].properties.args.enum, [["jevyr.experiment.mjs"]]);
        const observed = (sent.messages as { role: string; content: string }[]).filter(message => message.role === "tool");
        assert.equal(observed.length, 3);
        assert.ok(observed[0]!.content.includes("n * 4"));
        assert.equal(JSON.parse(observed[0]!.content).matches[0].sourceDigest, inspectedRequest().subjectProjection!.files[0]!.sourceDigest);
        if (!respondsWithTool) { completion(response, JSON.stringify(finiteCandidate())); return; }
      } else {
        assert.ok(Array.isArray(sent.tools) && sent.tools.length > 0);
        assert.equal(sent.parallel_tool_calls, false);
        assert.equal(sent.tool_choice, "auto");
      }
      const call = round === 1 ? { name: "search_subject", arguments: '{"query":"triple"}' }
        : { name: "list_experiment_templates", arguments: "{}" };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `native-final-${round}`, type: "function", function: call }] } }], usage: { prompt_tokens: 23, completion_tokens: 17 } }));
    });
    try {
      if (respondsWithTool) await assert.rejects(adapter(server.baseUrl).runMetered(inspectedRequest()), /TOOL_CALL_CEILING/u);
      else {
        const result = await adapter(server.baseUrl).runMetered(inspectedRequest());
        assert.equal(result.investigation?.providerRounds, 4);
        assert.equal(result.investigation?.tools.length, 3);
        assert.equal(result.transmittedInputBytes, requests.reduce((total, sent) => total + Buffer.byteLength(JSON.stringify(sent)), 0));
      }
      assert.equal(requests.length, 4);
    } finally { await server.close(); }
  });
});

test("native candidate format binds a differently named sealed command and its executable entry file", async () => {
  const entryFile = "checks/shape-check.cjs";
  const experiment = { ...experimentCapability.experiments[0]!, entryFile, command: { executable: "node", args: [entryFile], shell: false as const } };
  const input: MindRequest = { ...request(), investigationTools: true, experimentCapability: { ...experimentCapability, experiments: [experiment] } };
  let omitEntry = false;
  const server = await fixtureServer(async (incoming, response) => {
    const sent = await readJsonRequest(incoming);
    const schema = (sent.response_format as any).json_schema.schema;
    const blueprint = schema.properties.contributions.items.properties.blueprint;
    assert.equal(schema.anyOf, undefined, "native content describes final candidates; tool calls stay in their separate channel");
    assert.deepEqual(blueprint.properties.command.anyOf.map((value: any) => value.properties.executable.enum), [["node"]]);
    assert.deepEqual(blueprint.properties.command.anyOf.map((value: any) => value.properties.args.enum), [[[entryFile]]]);
    assert.deepEqual(blueprint.properties.files.contains.properties.path.enum, [entryFile]);
    assert.deepEqual(blueprint.properties.files.prefixItems[0].properties.path.enum, [entryFile]);
    assert.equal(sent.tool_choice, "auto");
    const candidate = finiteCandidate(entryFile);
    if (omitEntry) candidate.contributions[0]!.blueprint.files[0]!.path = "notes.txt";
    completion(response, JSON.stringify(candidate));
  });
  try {
    const result = await adapter(server.baseUrl).runMetered(input);
    assert.equal(result.investigation?.providerRounds, 1);
    assert.deepEqual(result.contributions[0]?.candidateBlueprintSource, finiteCandidate(entryFile).contributions[0]!.blueprint);
    omitEntry = true;
    await assert.rejects(adapter(server.baseUrl).runMetered(input), /FINAL_CONTRIBUTION/u);
  } finally { await server.close(); }
});

test("native interpret and feedback rounds admit noncandidate JSON without a candidate-only schema", async () => {
  for (const revision of [false, true]) {
    const server = await fixtureServer(async (incoming, response) => {
      const sent = await readJsonRequest(incoming);
      const format = sent.response_format as any;
      assert.equal(format.type, "json_schema");
      assert.equal(format.json_schema.name, "jevyr_public_contributions_v1");
      assert.equal(format.json_schema.schema.properties.contributions.maxItems, revision ? 1 : 6);
      assert.equal(format.json_schema.schema.properties.contributions.items.properties.body.maxLength, undefined);
      assert.equal(format.json_schema.schema.properties.contributions.items.properties.summary.maxLength, undefined);
      const kinds = format.json_schema.schema.properties.contributions.items.properties.kind.enum;
      assert.ok(kinds.includes(revision ? "reflex" : "interpretation"));
      if (revision) assert.deepEqual(kinds, ["candidate", "reflex"]);
      else assert.deepEqual(kinds, ["interpretation", "claim", "observation", "test-plan"], "INTERPRET cannot advertise a performed repair or candidate delivery");
      assert.equal(sent.tool_choice, "auto");
      assert.ok(Array.isArray(sent.tools) && sent.tools.length > 0);
      completion(response, JSON.stringify({ contributions: [{ kind: revision ? "reflex" : "claim", summary: "A bounded assessment without a new candidate." }] }));
    });
    try {
      const input: MindRequest = { ...request(), investigationTools: true, stage: revision ? "reflex" : "interpret", role: revision ? "reflex" : "interpreter", ...(revision ? { revision: { round: 1, contextDigest: sha256Digest("native-feedback"), parentCandidateIds: ["existing-parent"] } } : {}) };
      const result = await adapter(server.baseUrl).runMetered(input);
      assert.equal(result.investigation?.providerRounds, 1);
      assert.equal(result.contributions[0]?.kind, revision ? "reflex" : "claim");
      assert.equal(result.contributions[0]?.candidateBlueprintSource, undefined);
    } finally { await server.close(); }
  }
});

test("both investigation transports share stage final schemas and close tools at round four", async (context) => {
  const finals = new Map<string, unknown>();
  const cases = [
    { key: "interpret", stage: "interpret" as const, role: "interpreter" as const, kinds: ["interpretation", "claim", "observation", "test-plan"], finalKind: "interpretation", maximum: 6 },
    { key: "reflex", stage: "reflex" as const, role: "reflex" as const, kinds: ["interpretation", "claim", "observation", "candidate", "challenge", "test-plan", "repair", "reflex"], finalKind: "reflex", maximum: 6 },
    { key: "diverge", stage: "diverge" as const, role: "divergent" as const, kinds: ["candidate"], finalKind: "candidate", maximum: 1 },
    { key: "revision", stage: "reflex" as const, role: "reflex" as const, kinds: ["candidate", "reflex"], finalKind: "reflex", maximum: 1 },
  ];
  for (const transport of ["native", "structured"] as const) for (const scenario of cases) await context.test(`${transport} ${scenario.key}`, async () => {
    let rounds = 0;
    const bodies: Record<string, unknown>[] = [];
    const server = await fixtureServer(async (incoming, response) => {
      const sent = await readJsonRequest(incoming); bodies.push(sent); rounds++;
      assert.ok(rounds <= 4, "No fifth provider request is permitted");
      const messages = sent.messages as { role: string; content: string }[], format = sent.response_format as any;
      assert.equal(format.type, "json_schema"); assert.equal(format.json_schema.strict, true);
      assert.doesNotMatch(messages.find(message => message.role === "user")!.content, /Use native function calls/u);
      if (transport === "structured") {
        assert.match(messages[0]!.content, /Native calls are unavailable/u);
        for (const key of ["tools", "tool_choice", "parallel_tool_calls"]) assert.equal(Object.hasOwn(sent, key), false);
        assert.equal(messages.some(message => message.role === "tool"), false);
      }
      const schema = format.json_schema.schema;
      if (rounds === 1) {
        assert.deepEqual(schema.required, ["protocol", "calls"]); assert.equal(schema.properties.contributions, undefined);
      } else {
        const finalSchema = transport === "structured" && rounds < 4 ? schema.anyOf[1] : schema;
        assert.equal(finalSchema.additionalProperties, false);
        assert.deepEqual(finalSchema.required, ["contributions"]);
        const contribution = finalSchema.properties.contributions.items;
        assert.deepEqual(contribution.properties.kind.enum, scenario.kinds);
        assert.equal(finalSchema.properties.contributions.maxItems, scenario.maximum);
        assert.equal(contribution.additionalProperties, false);
        const blueprint = contribution.properties.blueprint.anyOf?.[0] ?? contribution.properties.blueprint;
        assert.deepEqual(blueprint.properties.command.anyOf[0].properties.args.enum, [["jevyr.experiment.mjs"]]);
        assert.deepEqual(blueprint.properties.files.prefixItems[0].properties.path.enum, ["jevyr.experiment.mjs"]);
        if (scenario.key === "revision") assert.deepEqual(contribution.properties.parentIds.items.enum, ["committed-parent"]);
        if (rounds === 4) {
          assert.equal(schema.anyOf, undefined); assert.equal(schema.properties.calls, undefined);
          for (const key of ["tools", "tool_choice", "parallel_tool_calls"]) assert.equal(Object.hasOwn(sent, key), false);
          if (transport === "native") finals.set(scenario.key, schema); else assert.deepEqual(schema, finals.get(scenario.key));
          const value = scenario.finalKind === "candidate" ? finiteCandidate() : { contributions: [{ kind: scenario.finalKind, summary: "An assessment of the observed source without claimed execution." }] };
          completion(response, JSON.stringify(value)); return;
        }
      }
      const call = { name: "search_subject", arguments: { query: "triple" } };
      if (transport === "structured") completion(response, JSON.stringify({ protocol: "jevyr.context-tools/1", calls: [call] }));
      else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: `stage-${rounds}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }], usage: { prompt_tokens: 23, completion_tokens: 17 } }));
      }
    });
    try {
      const input: MindRequest = { ...inspectedRequest(), stage: scenario.stage, role: scenario.role,
        ...(scenario.key === "revision" ? { revision: { round: 1, contextDigest: sha256Digest("stage-schema-feedback"), parentCandidateIds: ["committed-parent"] } } : {}) };
      const provider = new OpenAICompatibleMindAdapter({ id: "mind.stage-schema", displayName: "Stage schema fixture", baseUrl: server.baseUrl, model: "fixture-model", investigationTransport: transport });
      const result = await provider.runMetered(input);
      assert.equal(rounds, 4); assert.equal(result.investigation?.providerRounds, 4); assert.equal(result.investigation?.tools.length, 3);
      assert.ok(result.investigation?.tools.every(tool => tool.status === "observed" && tool.sourceDigests.length === 1));
      assert.equal(result.contributions[0]?.kind, scenario.finalKind);
      assert.equal(result.transmittedInputBytes, bodies.reduce((sum, body) => sum + Buffer.byteLength(JSON.stringify(body)), 0));
    } finally { await server.close(); }
  });
});

test("structured final-round calls and unsupported schemas remain failures with no retry or relaxed format", async () => {
  for (const rejectSchema of [false, true]) {
    let rounds = 0;
    const server = await fixtureServer(async (incoming, response) => {
      const sent = await readJsonRequest(incoming); rounds++;
      assert.equal((sent.response_format as any).type, "json_schema");
      assert.ok(rounds <= (rejectSchema ? 1 : 4));
      if (rejectSchema) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "unsupported json_schema" } })); return; }
      if (rounds === 4) assert.equal((sent.response_format as any).json_schema.schema.properties.calls, undefined);
      completion(response, JSON.stringify({ protocol: "jevyr.context-tools/1", calls: [{ name: "search_subject", arguments: { query: "triple" } }] }));
    });
    try {
      const provider = new OpenAICompatibleMindAdapter({ id: "mind.structured-closure", displayName: "Structured closure fixture", baseUrl: server.baseUrl, model: "fixture-model", investigationTransport: "structured" });
      await assert.rejects(provider.runMetered({ ...inspectedRequest(), stage: "interpret", role: "interpreter" }), rejectSchema ? /PROVIDER_TRANSPORT/u : /TOOL_CALL_CEILING/u);
      assert.equal(rounds, rejectSchema ? 1 : 4);
    } finally { await server.close(); }
  }
});

test("native INTERPRET JSON content must request actual inspection before a general contribution", async () => {
  let rounds = 0;
  const server = await fixtureServer(async (incoming, response) => {
    const sent = await readJsonRequest(incoming); rounds++;
    const format = sent.response_format as any;
    assert.equal(format.type, "json_schema");
    if (rounds === 1) {
      assert.equal(format.json_schema.name, "jevyr_context_request_v1");
      assert.deepEqual(format.json_schema.schema.required, ["protocol", "calls"]);
      assert.equal(format.json_schema.schema.properties.contributions, undefined);
      assert.equal(sent.tool_choice, "auto");
      completion(response, JSON.stringify({ protocol: "jevyr.context-tools/1", calls: [{ name: "search_subject", arguments: { query: "triple" } }] }));
    } else {
      assert.equal(format.json_schema.name, "jevyr_public_contributions_v1");
      const actual = JSON.parse((sent.messages as { role: string; content: string }[]).at(-1)!.content);
      assert.equal(actual.protocol, "jevyr.context-tool-result/1");
      assert.ok(JSON.stringify(actual).includes("n * 4"));
      completion(response, JSON.stringify({ contributions: [{ kind: "interpretation", summary: "The observed implementation multiplies by four; the intended contract remains an interpretation." }] }));
    }
  });
  try {
    const result = await adapter(server.baseUrl).runMetered({ ...inspectedRequest(), stage: "interpret", role: "interpreter" });
    assert.equal(rounds, 2);
    assert.equal(result.contributions[0]?.kind, "interpretation");
    assert.equal(result.investigation?.tools[0]?.requestFormat, "jevyr.context-tools/1");
    assert.ok(result.investigation?.tools[0]?.sourceDigests.includes(inspectedRequest().subjectProjection!.files[0]!.sourceDigest));
  } finally { await server.close(); }
});

test("native schema rejection remains a metered failure without a weaker-format retry", async () => {
  let attempts = 0;
  const server = await fixtureServer(async (incoming, response) => {
    const sent = await readJsonRequest(incoming); attempts++;
    assert.equal((sent.response_format as { type: string }).type, "json_schema");
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "json_schema unsupported" } }));
  });
  try {
    await assert.rejects(adapter(server.baseUrl).runMetered(inspectedRequest()), MindMeteredFailure);
    assert.equal(attempts, 1);
  } finally { await server.close(); }
});

test("context tools cannot read a host path, hidden lineage, withheld source or execute a command", async () => {
  const input = inspectedRequest();
  const attempts = [
    ["read_subject_lines", '{"fileId":"C:/private/key","startLine":1,"endLine":2}'],
    ["inspect_public_evidence", '{"id":"hidden-lineage-candidate"}'],
    ["exec", '{"command":"node check.mjs"}'],
    ["search_subject", '{"query":"triple","path":"C:/private"}'],
  ];
  for (const [name, args] of attempts) assert.equal((await executeInvestigatorTool(input, name!, args!)).receipt.status, "denied");
  const withheld = { ...input, subjectProjection: undefined } as unknown as MindRequest;
  assert.deepEqual(JSON.parse((await executeInvestigatorTool(withheld, "search_subject", '{"query":"triple"}')).content).matches, []);
  assert.equal((await executeInvestigatorTool({ ...input, subjectProjection: { ...input.subjectProjection!, projectionDigest: `sha256:${"f".repeat(64)}` } }, "list_subject_files", "{}")).receipt.status, "denied");
});

test("repeated context without usage receipts is fully charged before another model round is allowed", async () => {
  let calls = 0;
  const server = await fixtureServer(async (incoming, response) => {
    await readJsonRequest(incoming); calls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "inspect-limit", type: "function", function: { name: "list_subject_files", arguments: "{}" } }] } }] }));
  });
  try {
    await assert.rejects(adapter(server.baseUrl).runMetered({ ...inspectedRequest(), maxInputTokens: 14_000 }), MindMeteredFailure);
    assert.ok(calls >= 1 && calls <= 2);
  } finally { await server.close(); }
});

test("tool-loop accounting includes accompanying assistant prose and accepts an empty final tool list", async () => {
  const prose = "I will inspect only the sealed file manifest.";
  const calls = [{ id: "manifest", type: "function", function: { name: "search_subject", arguments: "{\"query\":\"triple\"}" } }];
  const final = JSON.stringify(finiteCandidate());
  let round = 0;
  const server = await fixtureServer(async (incoming, response) => {
    await readJsonRequest(incoming); round++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ finish_reason: round === 1 ? "tool_calls" : "stop", message: round === 1 ? { content: prose, tool_calls: calls } : { content: final, tool_calls: [] } }] }));
  });
  try {
    const result = await adapter(server.baseUrl).runMetered(inspectedRequest());
    const expected = Buffer.byteLength(prose) + Buffer.byteLength(JSON.stringify(calls)) + Buffer.byteLength(final);
    assert.equal(round, 2);
    assert.equal(result.receivedOutputBytes, expected);
    assert.deepEqual(result.tokenUsage.output, { tokens: expected, measurement: "UPPER_BOUND" });
  } finally { await server.close(); }
});

test("a missing later usage receipt cannot erase earlier reported tokens beyond the observed byte bound", async () => {
    const { runModelToolLoop } = await import("../src/model-tool-loop.js");
    let sent = 0;
    await assert.rejects(runModelToolLoop(inspectedRequest(), {
      adapterId: "mind.mixed-receipt",
      encode: (messages) => JSON.stringify({ messages }),
      send: async () => {
        sent++;
        return sent === 1
          ? JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "inspect", type: "function", function: { name: "list_subject_files", arguments: "{}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 1_000 } })
          : JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(finiteCandidate()) } }] });
      },
    }), MindMeteredFailure);
    assert.equal(sent, 2);
});

test("a source-bearing invocation cannot admit fabricated early finals without any source inspection", async () => {
  const { runModelToolLoop } = await import("../src/model-tool-loop.js");
  let rounds = 0;
  await assert.rejects(runModelToolLoop(inspectedRequest(), {
    adapterId: "mind.skipped-inspection",
    encode: (messages, _tools, _max, final, required) => {
      assert.equal(required, true);
      assert.equal(final, rounds === 3);
      return JSON.stringify({ messages });
    },
    send: async () => { rounds++; return JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(finiteCandidate()) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }); },
  }), /SOURCE_INSPECTION_REQUIRED/u);
  assert.equal(rounds, 4);
});

test("revision generation requires actual committed-parent inspection after original-source inspection",async()=>{
  const {runModelToolLoop}=await import("../src/model-tool-loop.js");
  const content="export const parentObservation = 'PARENT_BYTES_V1';\n",sourceDigest=sha256Digest(content);
  const input:MindRequest={...inspectedRequest(),revision:{round:1,contextDigest:sha256Digest("revision-context"),parentCandidateIds:["candidate-parent"]},revisionSources:[{candidateId:"candidate-parent",blueprintDigest:sha256Digest("parent-blueprint"),files:[{path:"parent.mjs",content,digest:sourceDigest}]}]};
  let round=0,revisionFileId="";
  const revised=finiteCandidate();(revised.contributions[0] as {parentIds:string[]}).parentIds=["candidate-parent"];
  const result=await runModelToolLoop(input,{adapterId:"mind.revision-inspection",encode:messages=>{
    if(round===2){const listing=JSON.parse(String(messages.at(-1)!.content));revisionFileId=listing.files[0].fileId;assert.equal(listing.files[0].sourceDigest,sourceDigest);}
    if(round===3){const observed=JSON.parse(String(messages.filter(message=>message.role==="tool").at(-1)!.content));assert.equal(observed.text,content);assert.equal(observed.sourceDigest,sourceDigest);}
    return JSON.stringify({messages});
  },send:async()=>{
    round++;const call=round===1?{name:"search_subject",arguments:JSON.stringify({query:"triple"})}:round===2?{name:"list_revision_files",arguments:"{}"}:round===3?{name:"read_revision_lines",arguments:JSON.stringify({fileId:revisionFileId,startLine:1,endLine:2})}:undefined;
    return JSON.stringify({choices:[{finish_reason:call?"tool_calls":"stop",message:call?{content:null,tool_calls:[{id:`revision-${round}`,type:"function",function:call}]}:{content:JSON.stringify(revised)}}],usage:{prompt_tokens:20,completion_tokens:20}});
  }});
  assert.equal(round,4);assert.ok(result.investigation?.tools.some(receipt=>receipt.name==="read_revision_lines"&&receipt.status==="observed"&&receipt.sourceDigests.includes(sourceDigest)));
  let attempts=0;
  await assert.rejects(runModelToolLoop(input,{adapterId:"mind.claimed-parent-inspection",encode:messages=>JSON.stringify({messages}),send:async()=>{
    attempts++;return JSON.stringify({choices:[{finish_reason:attempts===1?"tool_calls":"stop",message:attempts===1?{content:null,tool_calls:[{id:"source-only",type:"function",function:{name:"search_subject",arguments:'{"query":"triple"}'}}]}:{content:JSON.stringify(finiteCandidate())}}],usage:{prompt_tokens:20,completion_tokens:20}});
  }}),/SOURCE_INSPECTION_REQUIRED/u);
  assert.equal(attempts,4);
  const withheld={...input,revisionSources:undefined} as unknown as MindRequest;
  const listing=await executeInvestigatorTool(withheld,"list_revision_files","{}");assert.deepEqual(JSON.parse(listing.content).files,[]);
  const unavailable=await executeInvestigatorTool(withheld,"read_revision_lines",JSON.stringify({fileId:revisionFileId,startLine:1,endLine:2}));assert.equal(unavailable.receipt.status,"denied");assert.equal(unavailable.content.includes("PARENT_BYTES_V1"),false);
});

test("structured context requests execute the same sealed inspection and retain actual results with metered bytes", async () => {
  const { runModelToolLoop } = await import("../src/model-tool-loop.js");
  let rounds = 0;
  const replies = [JSON.stringify({ protocol: "jevyr.context-tools/1", calls: [{ name: "search_subject", arguments: { query: "triple" } }] }), JSON.stringify(finiteCandidate())];
  const result = await runModelToolLoop(inspectedRequest(), {
    adapterId: "mind.structured-tools",
    encode: (messages) => {
      if (rounds === 1) {
        const actualResult = JSON.parse(String(messages.at(-1)!.content));
        assert.equal(actualResult.protocol, "jevyr.context-tool-result/1");
        assert.match(actualResult.result.matches[0].text, /n \* 4/u);
        assert.equal(actualResult.authority, "context-only");
        assert.equal(messages.some(message => message.role === "tool"), false, "structured calls must not pretend the provider emitted native calls");
      }
      return JSON.stringify({ messages });
    },
    send: async () => JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: replies[rounds++] } }] }),
  });
  assert.equal(rounds, 2);
  assert.equal(result.investigation?.tools[0]?.requestFormat, "jevyr.context-tools/1");
  assert.equal(result.investigation?.tools[0]?.status, "observed");
  assert.equal(result.receivedOutputBytes, replies.reduce((sum, reply) => sum + Buffer.byteLength(reply), 0), "synthetic internal IDs do not replace or duplicate actual provider output bytes");
});

test("structured context requests refuse unknown fields, unbounded calls, and ambiguous native plus structured requests", async () => {
  const { runModelToolLoop } = await import("../src/model-tool-loop.js");
  const call = { name: "search_subject", arguments: { query: "triple" } };
  for (const value of [
    { protocol: "jevyr.context-tools/1", calls: [call], verdict: "ACCEPT" },
    { protocol: "jevyr.context-tools/1", calls: [{ ...call, approval: true }] },
    { protocol: "jevyr.context-tools/1", calls: Array(5).fill(call) },
    { protocol: "jevyr.context-tools/1", calls: [{ ...call, arguments: [] }] },
  ]) {
    let rounds = 0;
    await assert.rejects(runModelToolLoop(inspectedRequest(), { adapterId: "mind.malformed-tools", encode: messages => JSON.stringify({ messages }), send: async () => { rounds++; return JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }] }); } }), /TOOL_REQUEST_FORMAT/u);
    assert.equal(rounds, 1);
  }
  await assert.rejects(runModelToolLoop(inspectedRequest(), { adapterId: "mind.ambiguous-tools", encode: messages => JSON.stringify({ messages }), send: async () => JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: JSON.stringify({ protocol: "jevyr.context-tools/1", calls: [call] }), tool_calls: [{ id: "native", type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }] }) }), /TOOL_REQUEST_FORMAT/u);
});

test("DIVERGE requests strict finite-source JSON and preserves only inspectable candidate data", async () => {
  let sent: Record<string, unknown> | undefined;
  const server = await fixtureServer(async (incoming, response) => {
    sent = await readJsonRequest(incoming);
    completion(response, JSON.stringify(finiteCandidate()));
  });
  try {
    const mindRequest = request();
    const result = await adapter(server.baseUrl).runMetered(mindRequest);
    assert.equal(result.contributions.length, 1);
    assert.equal(result.contributions[0]?.kind, "candidate");
    assert.deepEqual(result.contributions[0]?.candidateBlueprintSource, finiteCandidate().contributions[0]?.blueprint);
    assert.deepEqual(result.tokenUsage, {
      input: { tokens: 23, measurement: "MEASURED" },
      output: { tokens: 17, measurement: "MEASURED" },
    });

    const responseFormat = sent?.response_format as Record<string, unknown>;
    assert.equal(responseFormat.type, "json_schema");
    const descriptor = responseFormat.json_schema as Record<string, unknown>;
    assert.equal(descriptor.strict, true);
    const schema = descriptor.schema as Record<string, unknown>;
    assert.equal(schema.additionalProperties, false);
    const messages = sent?.messages as { content?: unknown }[];
    const prompt = String(messages[0]?.content);
    assert.match(prompt, /DIVERGE delivery contract/u);
    assert.match(prompt, /jevyr\.experiment\.mjs/u);
    assert.match(prompt, /zero execution, assay, oracle, evidence, or verdict authority/u);
    assert.match(prompt, /MUST NOT read or wait on stdin/u);
    assert.match(prompt, /terminate autonomously/u);
    assert.match(prompt, /Embed deterministic fixtures and self-check cases/u);
    assert.match(prompt, /explicit output and exit-status requirements.*govern and override the generic defaults/u);
    assert.match(prompt, /Only when no output format is specified, emit bounded inspectable JSON/u);
    assert.match(prompt, /Only when no exit-status requirement is specified, exit nonzero/u);
    const explicitContract = "Emit CSV with literal columns input,observed in order; report mismatches and exit 0.";
    const explicitPrompt = makePublicMindPrompt({ ...mindRequest, constraints: [explicitContract] });
    assert.ok(explicitPrompt.includes(explicitContract));
    assert.match(explicitPrompt, /Reporting an observed defect does not itself determine the required process exit/u);
    assert.match(explicitPrompt, /self-check cases only where compatible with that explicit contract/u);
    assert.match(prompt, /successful process exit is only a tool observation, never verdict authority/u);
    assert.doesNotMatch(prompt, /DO_NOT_FORWARD_RAW_BLUEPRINT/u);
    assert.match(prompt, /uncompiledBlueprintProposed/u);
    assert.equal(sent?.max_tokens, 512);
  } finally {
    await server.close();
  }
});

test("DIVERGE without a sealed experiment requests source without inventing a command", async () => {
  let sent: Record<string, unknown> | undefined;
  const sourceOnly = finiteCandidate();
  delete (sourceOnly.contributions[0]!.blueprint as { command?: unknown }).command;
  const server = await fixtureServer(async (incoming, response) => {
    sent = await readJsonRequest(incoming);
    completion(response, JSON.stringify(sourceOnly));
  });
  try {
    const mindRequest: MindRequest = Object.freeze({ ...request(), experimentCapability: undefined });
    const result = await adapter(server.baseUrl).runMetered(mindRequest);
    assert.deepEqual(result.contributions[0]?.candidateBlueprintSource, sourceOnly.contributions[0]?.blueprint);

    const responseFormat = sent?.response_format as Record<string, unknown>;
    const descriptor = responseFormat.json_schema as Record<string, unknown>;
    const schema = descriptor.schema as Record<string, unknown>;
    const rootProperties = schema.properties as Record<string, unknown>;
    const contributions = rootProperties.contributions as Record<string, unknown>;
    const contribution = contributions.items as Record<string, unknown>;
    const contributionProperties = contribution.properties as Record<string, unknown>;
    const blueprint = contributionProperties.blueprint as Record<string, unknown>;
    assert.deepEqual(blueprint.required, ["protocol", "files"]);
    assert.ok(!Object.hasOwn(blueprint.properties as object, "command"));

    const messages = sent?.messages as { content?: unknown }[];
    assert.match(String(messages[0]?.content), /omit blueprint\.command/u);
  } finally {
    await server.close();
  }
});

test("DIVERGE rejects prose, absent source, and source outside the sealed experiment socket", async (t) => {
  for (const [name, raw, expected] of [
    ["prose", "I would build something interesting.", /malformed structured public contributions/u],
    [
      "missing source",
      JSON.stringify({ contributions: [{ kind: "candidate", summary: "Only an idea." }] }),
      /not finite/u,
    ],
    [
      "wrong experiment",
      JSON.stringify(finiteCandidate("other.mjs")),
      /do not match any sealed experiment capability/u,
    ],
  ] as const) {
    await t.test(name, async () => {
      const server = await fixtureServer(async (incoming, response) => {
        await readJsonRequest(incoming);
        completion(response, raw);
      });
      try {
        await assert.rejects(adapter(server.baseUrl).runMetered(request()), expected);
      } finally {
        await server.close();
      }
    });
  }
});

test("completion-token truncation is an explicit adapter failure", async () => {
  const server = await fixtureServer(async (incoming, response) => {
    await readJsonRequest(incoming);
    completion(response, "{\"contributions\":[", "length");
  });
  try {
    await assert.rejects(
      adapter(server.baseUrl).runMetered(request()),
      /truncated its structured output at the configured completion-token limit/u,
    );
  } finally {
    await server.close();
  }
});

test("provider-controlled terminal metadata is not copied into a durable failure", async () => {
  const server = await fixtureServer(async (incoming, response) => {
    await readJsonRequest(incoming);
    completion(response, JSON.stringify(finiteCandidate()), "PRIVATE_PROVIDER_SENTINEL");
  });
  try {
    await assert.rejects(adapter(server.baseUrl).runMetered(request()), (error: unknown) => {
      assert.ok(error instanceof MindMeteredFailure);
      assert.match(error.message, /without a complete stop/u);
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_SENTINEL/u);
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally {
    await server.close();
  }
});

test("format fallback is bounded and conservatively accounts for every transmitted prompt", async () => {
  const sent: Record<string, unknown>[] = [];
  const server = await fixtureServer(async (incoming, response) => {
    const body = await readJsonRequest(incoming);
    sent.push(body);
    if (sent.length === 1) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "json_schema unsupported" } }));
      return;
    }
    completion(response, JSON.stringify(finiteCandidate()), "stop", { prompt_tokens: 7, completion_tokens: 5 });
  });
  try {
    const mindRequest = request();
    const promptBytes = Buffer.byteLength(makePublicMindPrompt(mindRequest), "utf8");
    const result = await adapter(server.baseUrl).runMetered(mindRequest);
    assert.equal(sent.length, 2);
    assert.equal((sent[0]?.response_format as Record<string, unknown>).type, "json_schema");
    assert.equal((sent[1]?.response_format as Record<string, unknown>).type, "json_object");
    assert.ok(sent.every((attempt) => attempt.max_tokens === mindRequest.maxOutputTokens));
    assert.equal(result.transmittedInputBytes, promptBytes * 2);
    assert.deepEqual(result.tokenUsage.input, { tokens: promptBytes * 2, measurement: "UPPER_BOUND" });
    assert.deepEqual(result.tokenUsage.output, { tokens: 5, measurement: "MEASURED" });
  } finally {
    await server.close();
  }
});

test("an arbitrary provider 400 is not retried as a response-format compatibility fallback", async () => {
  let attempts = 0;
  const server = await fixtureServer(async (incoming, response) => {
    await readJsonRequest(incoming);
    attempts += 1;
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "request rejected by provider policy" } }));
  });
  try {
    await assert.rejects(adapter(server.baseUrl).runMetered(request()), /returned HTTP 400/u);
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});

test("a failed fallback chain reports every transmitted prompt without exposing its bytes", async () => {
  let attempts = 0;
  const server = await fixtureServer(async (incoming, response) => {
    await readJsonRequest(incoming);
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "json_schema unsupported" } }));
      return;
    }
    completion(response, "{\"contributions\":[", "length");
  });
  try {
    const mindRequest = request();
    const expectedInputBytes = Buffer.byteLength(makePublicMindPrompt(mindRequest), "utf8") * 2;
    await assert.rejects(adapter(server.baseUrl).runMetered(mindRequest), (error: unknown) => {
      assert.ok(error instanceof MindMeteredFailure);
      assert.equal(error.transmittedInputBytes, expectedInputBytes);
      assert.match(error.message, /truncated its structured output/u);
      assert.doesNotMatch(error.message, /contributions/u);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(attempts, 2);
  } finally {
    await server.close();
  }
});

test("format fallback never sends a second prompt beyond the sealed input permission", async () => {
  let attempts = 0;
  const server = await fixtureServer(async (incoming, response) => {
    await readJsonRequest(incoming);
    attempts += 1;
    response.writeHead(422, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "json_schema unsupported" } }));
  });
  try {
    const initial = request();
    const promptBytes = Buffer.byteLength(makePublicMindPrompt(initial), "utf8");
    const mindRequest: MindRequest = Object.freeze({ ...initial, maxInputTokens: promptBytes });
    await assert.rejects(adapter(server.baseUrl).runMetered(mindRequest), (error: unknown) => {
      assert.ok(error instanceof MindMeteredFailure);
      assert.equal(error.transmittedInputBytes, promptBytes);
      assert.match(error.message, /exceed the sealed input-token permission/u);
      return true;
    });
    assert.equal(attempts, 1);
  } finally {
    await server.close();
  }
});
