import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough, Readable } from "node:stream";
import { evaluateMcpCase, parseMcpRequestBytes, readMcpInputFrames, serveMcpBackend } from "../src/mcp.js";

test("MCP request decoding rejects ambiguous or replacement-decoded authority", () => {
  assert.deepEqual(
    parseMcpRequestBytes(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}')),
    { jsonrpc: "2.0", id: 1, method: "ping" },
  );
  assert.throws(
    () => parseMcpRequestBytes(Buffer.from('{"jsonrpc":"2.0","method":"ping","method":"tools/call"}')),
    /duplicate object key/u,
  );
  assert.throws(
    () => parseMcpRequestBytes(Buffer.from('{"jsonrpc":"2.0","method":"ping","\u006dethod":"tools\/call"}')),
    /duplicate object key/u,
  );
  assert.throws(
    () => parseMcpRequestBytes(Uint8Array.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x7d])),
    /not valid UTF-8/u,
  );
  assert.throws(
    () => parseMcpRequestBytes(Buffer.from('{"jsonrpc":"2.0","id":1.5,"method":"ping"}')),
    /safe integer/u,
  );
  assert.throws(
    () => parseMcpRequestBytes(Buffer.from("null")),
    /must be an object/u,
  );
});

test("MCP byte framing survives chunk boundaries, CRLF, and one oversized request", async () => {
  const input = Readable.from([
    Buffer.from("123"),
    Buffer.from("45\n{}\r\n"),
    Buffer.from("ok\n"),
  ]);
  const frames = [];
  for await (const frame of readMcpInputFrames(input, 4)) frames.push(frame);
  assert.deepEqual(frames, [
    { error: "MCP request exceeds 4 bytes" },
    { bytes: Buffer.from("{}") },
    { bytes: Buffer.from("ok") },
  ]);
});

test("MCP byte framing preserves malformed UTF-8 for the fatal decoder", async () => {
  const input = Readable.from([
    Uint8Array.from([0x7b, 0xc3]),
    Uint8Array.from([0x28, 0x7d, 0x0a]),
  ]);
  const frames = [];
  for await (const frame of readMcpInputFrames(input)) frames.push(frame);
  assert.equal(frames.length, 1);
  assert.throws(
    () => parseMcpRequestBytes(frames[0]?.bytes ?? new Uint8Array()),
    /not valid UTF-8/u,
  );
});

test("MCP proxy backend exposes one Cast write and reads an existing case without another runtime", async () => {
  const caseId = "case_2c30753c18f39ea5";
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "jevyr_status", arguments: { caseId } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "jevyr_record", arguments: { caseId } } },
  ];
  const output: string[] = [];
  let readyCalls = 0;
  let castCalls = 0;
  await serveMcpBackend(
    {
      ready: async () => { readyCalls += 1; },
      cast: async () => { castCalls += 1; return { unexpected: true }; },
      status: async (requested) => requested === caseId ? { caseId, lifecycle: "terminated" } : undefined,
      record: async (requested) => requested === caseId ? { protocol: "jevyr.record/1", caseId } : undefined,
    },
    {
      input: Readable.from(requests.map((request) => Buffer.from(`${JSON.stringify(request)}\n`))),
      send: (message) => { output.push(message); },
    },
  );

  assert.equal(readyCalls, 1);
  assert.equal(castCalls, 0);
  assert.equal(output.length, 4);
  const responses = output.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(responses[0]?.result, {
    protocolVersion: "2025-06-18",
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: "jevyr", version: "0.1.0" },
    instructions: "submit and evaluate each create one sealed Case. status and result are read-only. evaluate waits at most 30 seconds after Cast, then returns the existing receipt if still pending. No continuation tool exists.",
  });
  const list = responses[1]?.result as { tools: { name: string }[] };
  const names = list.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["submit", "status", "result", "evaluate"]);
  assert.doesNotMatch(names.join(" "), /continue|message/u);
  assert.match(JSON.stringify(responses[2]), /case_2c30753c18f39ea5/u);
  assert.match(JSON.stringify(responses[3]), /jevyr\.record\/1/u);
});

test("MCP evaluate casts once and bounds both pending and stalled result reads", async () => {
  const caseId = "case_2c30753c18f39ea5";
  let casts = 0;
  const backend = { ready: async () => undefined, cast: async () => { casts++; return { caseId }; }, status: async () => ({ caseId, lifecycle: "running" }), record: async () => undefined,
    terminalResult: async (): Promise<unknown> => undefined };
  const completed = await evaluateMcpCase({ ...backend, terminalResult: async () => ({ protocol: "jevyr.mcp-result/1" }) }, { impulse:"One finite case" }, new AbortController().signal, 20) as {state:string};
  assert.equal(completed.state, "completed");
  const pending = await evaluateMcpCase(backend, { impulse:"One finite case" }, new AbortController().signal, 10) as {state:string;receipt:{caseId:string}};
  assert.equal(pending.state, "pending"); assert.equal(pending.receipt.caseId, caseId);
  const stalled = await evaluateMcpCase({ ...backend, terminalResult: async () => new Promise(() => undefined) }, { impulse:"One finite case" }, new AbortController().signal, 10) as {state:string};
  assert.equal(stalled.state, "pending"); assert.equal(casts, 3);
  await assert.rejects(evaluateMcpCase(backend, { impulse:"One finite case" }, new AbortController().signal, 30_001), /finite boundary/u);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(evaluateMcpCase(backend, { impulse:"One finite case" }, controller.signal, 10));
  assert.equal(casts, 3);
});

test("MCP public aliases preserve one semantic Cast and refuse post-seal fields", async () => {
  const caseId = "case_2c30753c18f39ea5", output: string[] = []; let casts = 0;
  const calls = [
    { name:"submit", arguments:{impulse:"One finite case"} },
    { name:"status", arguments:{caseId} },
    { name:"result", arguments:{caseId} },
    { name:"result", arguments:{caseId,message:"change the verdict"} },
    { name:"evaluate", arguments:{caseId,impulse:"continue"} },
  ];
  await serveMcpBackend({ ready:async()=>undefined,cast:async()=>{casts++;return{caseId};},status:async()=>({caseId}),record:async()=>{throw new Error("New result must use terminal bundle");},terminalResult:async()=>({protocol:"jevyr.mcp-result/1"}) },
    {input:Readable.from(calls.map((params,index)=>Buffer.from(`${JSON.stringify({jsonrpc:"2.0",id:index+1,method:"tools/call",params})}\n`))),send:message=>{output.push(message);} });
  const messages = output.map(value=>JSON.parse(value));
  assert.equal(casts,1); assert.equal(messages.filter(value=>value.error).length,2);
  assert.match(JSON.stringify(messages.find(value=>value.id===3)),/jevyr.mcp-result\/1/u);
});

test("MCP client-model run samples only inside its originating tools/call", async () => {
  const input = new PassThrough();
  const output: Record<string, unknown>[] = [];
  let runCalls = 0;
  let finalResponse!: () => void;
  const final = new Promise<void>((resolve) => { finalResponse = resolve; });
  const serving = serveMcpBackend(
    {
      ready: async () => undefined,
      cast: async () => { throw new Error("ordinary Cast must not run"); },
      runWithClientModel: async (intent, context) => {
        runCalls += 1;
        assert.equal(intent.privacy, "provider_scoped");
        assert.deepEqual(context.client, {
          name: "test-host",
          version: "1.2.3",
          protocolVersion: "2025-11-25",
        });
        context.onSealed?.({ caseId: "case_clientmodel" });
        const sampled = await context.sample({
          messages: [{ role: "user", content: { type: "text", text: "prepared public prompt" } }],
          includeContext: "none",
          maxTokens: 128,
          temperature: 0.5,
        }, context.signal);
        assert.equal(sampled.model, "host-selected-model");
        return { caseId: "case_clientmodel", clientReportedModel: sampled.model };
      },
      status: async () => undefined,
      record: async () => undefined,
    },
    {
      input,
      send: (line) => {
        const message = JSON.parse(line) as Record<string, unknown>;
        output.push(message);
        if (message.method === "sampling/createMessage") {
          assert.equal(output.some((entry) => entry.id === 2 && Object.hasOwn(entry, "result")), false);
          queueMicrotask(() => {
            input.write(`${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                role: "assistant",
                content: { type: "text", text: "[]" },
                model: "host-selected-model",
                stopReason: "endTurn",
              },
            })}\n`);
          });
        }
        if (message.id === 2 && Object.hasOwn(message, "result")) finalResponse();
      },
    },
  );
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: { sampling: {} },
      clientInfo: { name: "test-host", version: "1.2.3" },
    },
  })}\n`);
  input.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "jevyr_run",
      arguments: { impulse: "Use the caller model", privacy: "provider_scoped" },
      _meta: { progressToken: "run-progress" },
    },
  })}\n`);
  await final;
  input.end();
  await serving;

  assert.equal(runCalls, 1);
  const sampleIndex = output.findIndex((entry) => entry.method === "sampling/createMessage");
  const finalIndex = output.findIndex((entry) => entry.id === 2 && Object.hasOwn(entry, "result"));
  assert.ok(sampleIndex >= 0 && finalIndex > sampleIndex);
  assert.equal(output.slice(finalIndex + 1).some((entry) => entry.method === "sampling/createMessage"), false);
  assert.ok(output.some((entry) => entry.method === "notifications/progress"));
});

test("MCP client-model run requires negotiated sampling and explicit disclosure privacy", async () => {
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "jevyr_run", arguments: { impulse: "No sampling capability", privacy: "provider_scoped" } },
    },
    { jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { sampling: {} } } },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "jevyr_run", arguments: { impulse: "Implicit privacy is forbidden" } },
    },
  ];
  const output: Record<string, unknown>[] = [];
  let runCalls = 0;
  await serveMcpBackend(
    {
      ready: async () => undefined,
      cast: async () => undefined,
      runWithClientModel: async () => { runCalls += 1; },
      status: async () => undefined,
      record: async () => undefined,
    },
    {
      input: Readable.from(requests.map((request) => Buffer.from(`${JSON.stringify(request)}\n`))),
      send: (line) => { output.push(JSON.parse(line) as Record<string, unknown>); },
    },
  );
  assert.equal(runCalls, 0);
  const byId = new Map(output.map((message) => [message.id, message]));
  assert.match(JSON.stringify(byId.get(2)), /capabilities\.sampling/u);
  assert.match(JSON.stringify(byId.get(4)), /explicit provider_scoped or full_case privacy/u);
});
