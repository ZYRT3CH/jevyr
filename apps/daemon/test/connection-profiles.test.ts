import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, symlink, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { digestJson, validateAirlockChoices } from "@jevyr/protocol";
import { snapshotAdapterCapability } from "@jevyr/runtime";
import { ConnectionProfiles, connectionCapabilityId, parseConnectionProfile, parseModelConnection } from "../src/connection-profiles.js";
import { publicConnectionAddress } from "../src/connection-probes.js";
import { emptyMcpWitnesses } from "../src/mcp-witnesses.js";

const model = (overrides: Record<string, unknown> = {}) => ({ id: "local", label: "Local model", provider: "ollama", model: "fixture", baseUrl: "http://127.0.0.1:11434/v1", transport: "native", remoteDisclosure: "none", ...overrides });
const profile = (models: unknown[] = [model()]) => ({ protocol: "jevyr.connection-profile/1", models, mcpServerIds: [] });
const root = () => mkdtemp(join(tmpdir(), "jevyr-connections-unit-"));

test("strict profile parser normalizes URLs, rejects secret fields and distinguishes remote disclosure", () => {
  assert.equal(parseModelConnection(model()).baseUrl, "http://127.0.0.1:11434/v1/");
  for (const changed of [ { apiKey: "secret" }, { command: "node" }, { label: "x\ty" }, { model: " " }, { baseUrl: "http://remote.example/v1" },
    { baseUrl: "https://user:pass@example.com" }, { baseUrl: "https://example.com/?key=x" }, { remoteDisclosure: "case-policy" }, { provider: "ollama", baseUrl: "https://example.com/", remoteDisclosure: "case-policy" } ]) {
    assert.throws(() => parseModelConnection(model(changed)), /INVALID_CONNECTION_SETTINGS/u);
  }
  assert.equal(parseModelConnection(model({ provider: "openai-compatible", baseUrl: "https://example.com/v1", remoteDisclosure: "case-policy" })).baseUrl, "https://example.com/v1/");
  assert.throws(() => parseConnectionProfile(profile([model(), model()])), /INVALID/u);
  assert.throws(() => parseConnectionProfile({ ...profile(), secret: "x" }), /INVALID/u);
});

test("atomic revision save is detached from active runtime, and restart selects normalized saved profile", async () => {
  const directory = await root(), manager = new ConnectionProfiles(directory, { JEVYR_OLLAMA_MODEL: "qwen", JEVYR_OPENAI_COMPATIBLE_MODEL: "gpt-oss", JEVYR_OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:11434/v1/", JEVYR_OPENAI_COMPATIBLE_INVESTIGATION_TRANSPORT: "structured" }, emptyMcpWitnesses());
  assert.deepEqual(manager.view(true).active.models.map(model => [model.model, model.transport]), [["qwen", "native"], ["gpt-oss", "structured"]]);
  const selected = profile([model({ model: "next" })]); manager.save(0, selected); selected.models[0]!.model = "mutated";
  assert.equal(manager.view(true).revision, 1); assert.equal(manager.view(true).saved?.models[0]?.model, "next");
  assert.equal(manager.view(true).restartRequired, true); assert.equal(manager.view(true).active.models[0]?.model, "qwen");
  assert.throws(() => manager.save(0, profile()), /REVISION_CONFLICT/u);
  const restarted = new ConnectionProfiles(directory, {}, emptyMcpWitnesses());
  assert.equal(restarted.view(true).restartRequired, false); assert.equal(restarted.view(true).active.profileDigest, digestJson(restarted.view(true).saved as any));
  assert.equal(snapshotAdapterCapability(restarted.minds()[0]!).id, connectionCapabilityId("local"));
  restarted.save(1, restarted.view(true).saved); assert.equal(restarted.view(true).revision, 2); assert.equal(restarted.view(true).restartRequired, false);
  const stored = await readFile(join(directory, ".jevyr", "connections.json"), "utf8"); assert.doesNotMatch(stored, /apiKey|authorization/u);
});

test("model family survives environment discovery and next-start profile; longest IDs remain Airlock-selectable", async () => {
  const directory = await root(), manager = new ConnectionProfiles(directory, { JEVYR_OLLAMA_MODEL: "qwen", JEVYR_OLLAMA_MODEL_FAMILY: "qwen" }, emptyMcpWitnesses());
  assert.equal(manager.view(true).active.models[0]?.modelFamily, "qwen");
  manager.save(0, profile([model({ id: "a".repeat(128), modelFamily: "qwen" })]));
  const restarted = new ConnectionProfiles(directory, {}, emptyMcpWitnesses()), card = snapshotAdapterCapability(restarted.minds()[0]!);
  assert.equal(card.limits?.modelFamily, "qwen"); assert.equal(card.id.length, 80);
  assert.deepEqual(validateAirlockChoices({ capabilityIds: [card.id] }).capabilityIds, [card.id]);
});

test("saved HTTP selection preserves configured native adapters and empty profile remains explicit", async () => {
  const directory = await root(); new ConnectionProfiles(directory, {}, emptyMcpWitnesses()).save(0, profile([]));
  const restarted = new ConnectionProfiles(directory, { JEVYR_CODEX_ENABLED: "1", JEVYR_OLLAMA_MODEL: "ignored" }, emptyMcpWitnesses());
  assert.equal(restarted.view(true).active.models.length, 0);
  assert.ok(restarted.minds().some(mind => snapshotAdapterCapability(mind).id.includes("codex")));
  assert.ok(restarted.minds().every(mind => !snapshotAdapterCapability(mind).id.includes("ollama")));
});

test("browser credential references cannot rebind existing environment secrets to another audience", async () => {
  const directory = await root(), manager = new ConnectionProfiles(directory, { OPENAI_API_KEY: "known-secret", OTHER_TOKEN: "must-not-be-enumerated" }, emptyMcpWitnesses());
  assert.equal(manager.view(true).credentials[0]?.available, true);
  assert.doesNotMatch(JSON.stringify(manager.view(true)), /known-secret|OTHER_TOKEN|must-not/u);
  for (const credentialId of ["OTHER_TOKEN", "env:OTHER_TOKEN", "openai-env"]) {
    assert.throws(() => manager.save(0, profile([model({ credentialId, provider: "openai-compatible", baseUrl: "https://evil.example/v1/", remoteDisclosure: "case-policy" })])), /DESTINATION_NOT_REGISTERED/u);
  }
  manager.save(0, profile([model({ credentialId: "openai-env", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", remoteDisclosure: "case-policy" })]));
  assert.doesNotMatch(await readFile(join(directory, ".jevyr", "connections.json"), "utf8"), /known-secret/u);
});

test("unavailable/deleted broker remains configured but cannot send anonymous requests", async () => {
  const directory = await root(); let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('{"data":[]}'); }); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number }, baseUrl = `http://127.0.0.1:${address.port}/v1/`;
    await mkdir(join(directory, ".jevyr"));
    const configPath = join(directory, ".jevyr", "connection-credentials.json");
    await writeFile(configPath, JSON.stringify({ protocol: "jevyr.connection-credentials/1", credentials: [{ id: "missing", label: "Missing", origin: new URL(baseUrl).origin, reference: "env:MISSING_KEY" }] }));
    const manager = new ConnectionProfiles(directory, {}, emptyMcpWitnesses()), input = model({ baseUrl, credentialId: "missing" });
    manager.save(0, profile([input]));
    assert.equal((await manager.models(input)).code, "CREDENTIAL_UNAVAILABLE");
    assert.equal((await new ConnectionProfiles(directory, {}, emptyMcpWitnesses()).minds()[0]!.probe()).available, false);
    await writeFile(configPath, JSON.stringify({ protocol: "jevyr.connection-credentials/1", credentials: [] }));
    const missing = new ConnectionProfiles(directory, {}, emptyMcpWitnesses()); assert.equal((await missing.minds()[0]!.probe()).available, false);
    assert.equal(requests, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("settings reject directory aliases and hard-linked storage instead of writing outside the project", async () => {
  const directory = await root(), foreign = await root();
  await symlink(foreign, join(directory, ".jevyr"), "junction");
  assert.throws(() => new ConnectionProfiles(directory, {}, emptyMcpWitnesses()), /UNSAFE_CONNECTION_SETTINGS_DIRECTORY/u);
  const clean = await root(), manager = new ConnectionProfiles(clean, {}, emptyMcpWitnesses()); manager.save(0, profile());
  await link(join(clean, ".jevyr", "connections.json"), join(foreign, "linked.json"));
  assert.throws(() => manager.save(1, profile([])), /UNSAFE_CONNECTION_SETTINGS_FILE/u);
});

test("remote resolver excludes private and transition addresses", () => {
  for (const address of ["127.0.0.1", "10.1.1.1", "169.254.169.254", "172.16.2.3", "192.168.1.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fc00::1", "2002:7f00:1::"]) assert.equal(publicConnectionAddress(address), false, address);
  assert.equal(publicConnectionAddress("8.8.8.8"), true); assert.equal(publicConnectionAddress("2606:4700:4700::1111"), true);
});

test("metadata discovery is bounded GET-only, no redirects/cookies/proxy, with explicit partial results", async () => {
  const directory = await root(), observed: { url?: string; method?: string; cookie?: string }[] = [];
  const server = createServer((request, response) => {
    observed.push({ url: request.url, method: request.method, cookie: request.headers.cookie });
    if (request.url === "/redirect/models") { response.writeHead(302, { location: "/v1/models" }); response.end(); }
    else if (request.url === "/large/models") response.end("x".repeat(262_145));
    else if (request.url === "/invalid/models") response.end('{"data":[{"id":""}]}');
    else response.end(JSON.stringify({ data: Array.from({ length: 130 }, (_, i) => ({ id: `model-${i}` })) }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
    const manager = new ConnectionProfiles(directory, {}, emptyMcpWitnesses());
    const listed = await manager.models(model({ baseUrl: `${base}/v1`, model: "model-129" }));
    assert.equal(listed.status, "available"); assert.equal(listed.code, "MODEL_LIST_PARTIAL"); assert.equal(listed.models.length, 128); assert.equal(listed.selectedModelListed, true);
    assert.equal((await manager.models(model({ baseUrl: `${base}/redirect` }))).code, "MODEL_LIST_REDIRECT_REFUSED");
    assert.equal(observed.length, 2);
    const large = await manager.models(model({ baseUrl: `${base}/large` })); assert.equal(large.status, "failed"); assert.equal(large.models.length, 0); assert.equal(large.selectedModelListed, null);
    assert.equal((await manager.models(model({ baseUrl: `${base}/invalid` }))).code, "MODEL_LIST_INVALID");
    assert.ok(observed.every(entry => entry.method === "GET" && !entry.cookie && entry.url?.endsWith("/models")));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("signed template lifecycle binds startup connection snapshot and independently replays after a pending save", async () => {
  const { createDaemonRuntime } = await import("../src/runtime.js");
  const { createJevyrHttpService } = await import("../src/server.js");
  const { SealedForgeAdapter } = await import("@jevyr/runtime");
  const { JevyrClient } = await import("../../../packages/sdk/src/client.js");
  const { replayAuthenticatedCase } = await import("../../cli/src/replay.js");
  const directory = await root(); new ConnectionProfiles(directory, {}, emptyMcpWitnesses()).save(0, profile([]));
  const runtime = createDaemonRuntime({ projectRoot: directory, env: {}, forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const before = runtime.repository.policyDigest;
    const receipt = await client.cast({ case: { impulse: "Inspect one finite mechanism", privacy: "local_only", control: "sovereign" } });
    runtime.connections.save(1, profile());
    const signed = await client.waitForAuthenticatedRecord(receipt.caseId);
    assert.equal(runtime.repository.policyDigest, before); assert.equal(receipt.policyDigest, before);
    assert.equal(runtime.connections.view(true).restartRequired, true);
    const descriptor = await runtime.repository.descriptor(before);
    assert.deepEqual((descriptor?.descriptor as any).policy.connectionStartup.models, []);
    assert.equal((descriptor?.descriptor as any).policy.connectionStartup.profileDigest, digestJson(profile([]) as any));
    const replay = await replayAuthenticatedCase(client, receipt.caseId, signed.payload);
    assert.equal(replay.valid, true, JSON.stringify(replay.problems));
    assert.equal(signed.payload.verdict.integrity, "VALID"); assert.equal(signed.payload.verdict.judgment, "UNPROVEN");
  } finally { await service.close(); }
});
