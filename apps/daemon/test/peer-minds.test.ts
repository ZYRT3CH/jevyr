import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonRuntime } from "../src/runtime.js";
import { A2aPeerMindAdapter, loadPeerMinds } from "../src/peer-minds.js";
import { RuleMindAdapter, SealedForgeAdapter, secretReference, type MindRequest } from "@jevyr/runtime";

test("peer startup binds explicit configuration and keeps broker credentials outside descriptors", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-peer-config-"));
  try {
    const path = join(root, "peers.json");
    await writeFile(path, JSON.stringify({ protocol: "jevyr.peers/1", peers: [{ id: "mind.peer.test", endpoint: "http://127.0.0.1:5555/a2a", credentialReference: "PEER_TEST_TOKEN" }] }));
    const env = { JEVYR_PEERS_FILE: "peers.json", PEER_TEST_TOKEN: "never-put-this-secret-in-a-descriptor" };
    const peers = loadPeerMinds(env, root);
    assert.equal(peers.minds.length, 1);
    assert.equal(peers.minds[0]!.capability.trust, "quarantined");
    assert.equal(JSON.stringify(peers).includes(env.PEER_TEST_TOKEN), false);
    assert.equal(loadPeerMinds(env, root).digest, peers.digest);
    await writeFile(path, JSON.stringify({ protocol: "jevyr.peers/1", peers: [{ id: "mind.peer.remote", endpoint: "http://example.com/a2a", allowRemote: true }] }));
    assert.throws(() => loadPeerMinds(env, root), /HTTPS/u);
    await writeFile(path, '{"protocol":"jevyr.peers/1","peers":[],"peers":[]}');
    assert.throws(() => loadPeerMinds(env, root));
    assert.throws(() => new A2aPeerMindAdapter({ id: "peer", endpoint: "https://user:secret@example.com/a2a", allowRemote: true, timeoutMs: 1000 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("A2A peer transmits only projected prompt and returns metered authority-free contributions", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-peer-wire-"));
  const runtime = createDaemonRuntime({ dataDir: root, minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const observed: { body: unknown; authorization: string | undefined }[] = [];
  let endpoint = "";
  let hostile = false;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/a2a+json");
    if (request.url === "/.well-known/agent-card.json") {
      response.end(JSON.stringify({ supportedInterfaces: [{ url: endpoint, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }] })); return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    observed.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")), authorization: request.headers.authorization });
    if (hostile) { response.end("x".repeat(2048)); return; }
    response.end(JSON.stringify({ message: { role: "ROLE_AGENT", messageId: "response-1", parts: [{ data: { contributions: [{ kind: "claim", summary: "A peer observation", evidenceRefs: ["forged-proof"], confidence: 1 }] } }] } }));
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/a2a`;
    const adapter = new A2aPeerMindAdapter({ id: "mind.peer.test", endpoint, allowRemote: false, timeoutMs: 3000, credential: secretReference("PEER_TOKEN", endpoint) }, { PEER_TOKEN: "broker-only-secret" });
    assert.equal((await adapter.probe()).available, true);
    const accepted = await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: { impulse: "Private sealed impulse must not leak" } });
    const sealed = (await runtime.repository.status(accepted.caseId))!.sealed;
    const request: MindRequest = { stage: "interpret", role: "interpreter", sealed, publicFacts: [], constraints: [], seed: "peer-trial", preparedPublicPrompt: "Exactly this public projection.", signal: new AbortController().signal, maxInputTokens: 1000, maxOutputTokens: 10000 };
    const result = await adapter.runMetered(request);
    const body = observed[0]!.body as any;
    assert.equal(body.message.parts[0].text, request.preparedPublicPrompt);
    assert.equal(body.configuration.returnImmediately, false);
    assert.equal(body.message.taskId, undefined);
    assert.equal(body.message.contextId, undefined);
    assert.equal(JSON.stringify(body).includes(sealed.intent.impulse), false);
    assert.equal(JSON.stringify(body).includes("broker-only-secret"), false);
    assert.equal(observed[0]!.authorization, "Bearer broker-only-secret");
    assert.deepEqual(result.contributions[0]!.evidenceRefs, []);
    assert.ok(result.contributions[0]!.tags!.includes("quarantined-peer"));
    assert.equal(result.tokenUsage.output.measurement, "UPPER_BOUND");
    assert.equal(result.transmittedInputBytes, Buffer.byteLength(request.preparedPublicPrompt!));
    hostile = true;
    await assert.rejects(adapter.runMetered({ ...request, maxOutputTokens: 1024 }), (error: Error) => /bounded one-shot/u.test(error.message) && !error.message.includes("secret"));
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    await runtime.close(); await rm(root, { recursive: true, force: true });
  }
});
