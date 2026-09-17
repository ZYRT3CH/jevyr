import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { SealedForgeAdapter } from "@jevyr/runtime";
import { JevyrClient } from "../../../packages/sdk/src/client.js";
import { type ConnectionProfile } from "../../../packages/sdk/src/connections.js";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";

const profile: ConnectionProfile = { protocol: "jevyr.connection-profile/1", models: [{ id: "new-model", label: "Next model", provider: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1/", model: "fixture-only-new", transport: "structured", remoteDisclosure: "none" }], mcpServerIds: [] };
const route = "/v1/settings/connections";
const token = "test-only-http-token-" + "x".repeat(48);

async function removeFixture(root: string): Promise<void> {
  const absolute = resolve(root), base = resolve(tmpdir());
  assert.ok(absolute.startsWith(base + sep) && absolute.slice(base.length + 1).startsWith("jevyr-connections-http-"));
  await rm(absolute, { recursive: true, force: true });
}
async function fixture(extraEnv: NodeJS.ProcessEnv = {}, setup?: (root: string) => Promise<NodeJS.ProcessEnv>) {
  const root = await mkdtemp(join(tmpdir(), "jevyr-connections-http-"));
  const configured = await setup?.(root) ?? {};
  const env = { JEVYR_HTTP_TOKEN_REF: "env:JUDGE_TEST_TOKEN", JUDGE_TEST_TOKEN: token, ...extraEnv, ...configured };
  const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, "store"), env, forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env, allowedOrigins: ["http://127.0.0.1:3001"] });
  try {
    const { url } = await service.listen(0);
    const headers = { origin: url, authorization: `Bearer ${token}`, "content-type": "application/json" };
    return { root, env, runtime, service, url, headers, client: new JevyrClient({ baseUrl: url, headers }),
      close: async () => { await service.close(); await removeFixture(root); } };
  } catch (error) { await service.close(); await removeFixture(root); throw error; }
}
async function customHost(url: string, host: string, headers: Record<string, string>): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const request = httpRequest(`${url}${route}`, { headers: { ...headers, host } }, response => { response.resume(); resolve(response.statusCode!); });
    request.once("error", reject); request.end();
  });
}

test("connection routes require bearer, exact local Host and permitted Origin independently of CORS", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.url}${route}`)).status, 401);
    assert.equal((await fetch(`${f.url}${route}`, { headers: { authorization: `Bearer ${token}wrong`, origin: f.url } })).status, 401);
    const noOrigin = await fetch(`${f.url}${route}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(noOrigin.status, 200);
    assert.equal((await noOrigin.json() as any).permissions.canConfigure, false);
    for (const origin of ["https://hostile.example", "http://127.0.0.1:39999", "null"]) {
      assert.equal((await fetch(`${f.url}${route}`, { headers: { ...f.headers, origin } })).status, 403, origin);
      assert.equal((await fetch(`${f.url}${route}`, { method: "OPTIONS", headers: { ...f.headers, origin } })).status, 403, origin);
    }
    assert.equal((await fetch(`${f.url}${route}`, { headers: { ...f.headers, origin: "http://127.0.0.1:3001" } })).status, 200);
    assert.equal((await fetch(`${f.url}${route}`, { method: "OPTIONS", headers: f.headers })).status, 204);
    assert.equal(await customHost(f.url, "attacker.example", { authorization: `Bearer ${token}`, origin: f.url }), 403);
    assert.equal(await customHost(f.url, "127.0.0.1:1", { authorization: `Bearer ${token}`, origin: f.url }), 403);
    const unsignedOrigin = await fetch(`${f.url}${route}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ revision: 0, profile }) });
    assert.equal(unsignedOrigin.status, 403);
    assert.equal((await f.client.connections()).revision, 0);
    assert.equal((await fetch(`${f.url}${route}?token=${token}`, { headers: f.headers })).status, 400);
  } finally { await f.close(); }
});

test("ordinary SDK profile saves bind revisions and preserve active adapters and sealed startup policy", async () => {
  const f = await fixture({ JEVYR_OLLAMA_MODEL: "fixture-only-existing", JEVYR_OLLAMA_MODEL_FAMILY: "fixture-family" });
  try {
    const initial = await f.client.connections(), policyDigest = f.runtime.repository.policyDigest;
    assert.equal(initial.active.models[0]?.model, "fixture-only-existing");
    assert.equal(initial.active.models[0]?.modelFamily, "fixture-family");
    assert.equal(initial.active.source, "environment");
    const submitted = { ...profile, models: [{ ...profile.models[0]!, baseUrl: "http://127.0.0.1:11434/v1" }] };
    const saved = await f.client.saveConnections(initial.revision, submitted);
    assert.deepEqual(saved.saved, profile);
    assert.equal(saved.revision, 1); assert.equal(saved.restartRequired, true);
    assert.deepEqual(saved.active, initial.active); assert.equal(f.runtime.repository.policyDigest, policyDigest);
    await assert.rejects(f.client.saveConnections(0, profile), (error: any) => error.status === 409);
    const concurrent = await Promise.allSettled([f.client.saveConnections(1, profile), f.client.saveConnections(1, profile)]);
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter(result => result.status === "rejected" && result.reason.status === 409).length, 1);
    const now = await f.client.connections(); assert.equal(now.revision, 2); assert.deepEqual(now.active, initial.active);
    for (const bad of [
      { revision: 2, profile, secret: "must-not-be-saved" },
      { revision: 2, profile: { ...profile, models: [{ ...profile.models[0], apiKey: "must-not-be-saved" }] } },
      { revision: 2, profile: { ...profile, mcpServerIds: ["invented-command"] } },
    ]) assert.equal((await fetch(`${f.url}${route}`, { method: "PUT", headers: f.headers, body: JSON.stringify(bad) })).status, 400);
    const oversize = await fetch(`${f.url}${route}`, { method: "PUT", headers: f.headers, body: " ".repeat(32_769) });
    assert.equal(oversize.status, 413);
    const stored = await readFile(join(f.root, ".jevyr", "connections.json"), "utf8");
    assert.doesNotMatch(stored, /must-not-be-saved|test-only-http-token/u);
    assert.equal((await f.client.connections()).revision, 2);
    const cases = await readdir(join(f.root, "store", "cases")).catch(() => []);
    assert.equal(cases.length, 0); // Setup performs no Cast or model invocation.
  } finally { await f.close(); }
});

test("connection discovery retains only model IDs and preapproved MCP metadata without inference or tool calls", async () => {
  const modelRequests: { method: string; path: string; authorization?: string }[] = [];
  const modelServer = createServer((request, response) => {
    modelRequests.push({ method: request.method!, path: request.url!, ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}) });
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture-model", internal: "not-public" }] }));
  });
  modelServer.listen(0, "127.0.0.1"); await once(modelServer, "listening");
  const modelPort = (modelServer.address() as { port: number }).port;
  const f = await fixture({}, async root => {
    const program = join(root, "witness.mjs"), log = join(root, "witness-methods.jsonl"), config = join(root, "witnesses.json");
    await writeFile(program, `import { createInterface } from 'node:readline'; import { appendFileSync } from 'node:fs';
const input=createInterface({input:process.stdin});
input.on('line',line=>{const message=JSON.parse(line);appendFileSync(process.argv[2],JSON.stringify({method:message.method})+'\\n');
if(message.id===undefined)return;
const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'trusted-fixture',version:'1'}}
:message.method==='tools/list'?{tools:[{name:'read_reference',inputSchema:{type:'object'}}]}:null;
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,...(result?{result}:{error:{code:-32601,message:'not available'}})})+'\\n');});\n`);
    await writeFile(config, JSON.stringify({ protocol: "jevyr.mcp-witnesses/1", servers: [{ id: "reference", displayName: "Reference fixture", command: process.execPath,
      args: [program, log], allowedTools: ["read_reference"], operationTimeoutMs: 2_000, maxInputBytes: 4096, maxOutputBytes: 8192, maxStderrBytes: 4096 }],
      calls: [{ id: "planned-only", serverId: "reference", tool: "read_reference", arguments: {} }] }));
    return { JEVYR_MCP_WITNESSES_FILE: config };
  });
  try {
    const selection = { ...profile.models[0]!, baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: "fixture-model" };
    const listing = await f.client.connectionModels(selection);
    assert.deepEqual(listing.models, [{ id: "fixture-model" }]); assert.equal(listing.selectedModelListed, true);
    assert.deepEqual(modelRequests, [{ method: "GET", path: "/v1/models" }]);
    assert.doesNotMatch(JSON.stringify(listing), /not-public|test-only-http-token/u);
    const result = await f.client.testMcpConnection("reference"); assert.equal(result.status, "available");
    const methods = (await readFile(join(f.root, "witness-methods.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).method);
    assert.ok(methods.includes("initialize")); assert.ok(methods.includes("tools/list"));
    assert.ok(methods.every(method => ["initialize", "notifications/initialized", "tools/list"].includes(method)));
    for (const body of [{ serverId: "reference", command: "not-permitted.exe" }, { serverId: "invented" }]) {
      assert.equal((await fetch(`${f.url}${route}/mcp-test`, { method: "POST", headers: f.headers, body: JSON.stringify(body) })).status, 400);
    }
    assert.deepEqual((await readFile(join(f.root, "witness-methods.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).method), methods);
  } finally { await f.close(); modelServer.close(); await once(modelServer, "close"); }
});
