import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { loadMcpWitnesses } from "../src/mcp-witnesses.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function configuration(value: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-witnesses-"));
  roots.push(root);
  const path = join(root, "witnesses.json");
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return path;
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol: "jevyr.mcp-witnesses/1",
    servers: [{
      id: "research",
      displayName: "Research witness",
      command: process.execPath,
      args: ["server.mjs"],
      passEnvironment: ["JEVYR_TEST_WITNESS_CREDENTIAL"],
      allowedTools: ["inspect"],
      operationTimeoutMs: 2_000,
    }],
    calls: [{
      id: "inspect-subject",
      serverId: "research",
      tool: "inspect",
      arguments: { query: "fixed before Cast" },
      timeoutMs: 1_500,
    }],
    ...overrides,
  };
}

test("an absent witness file produces a stable empty sealed descriptor", () => {
  const first = loadMcpWitnesses({});
  const second = loadMcpWitnesses({});
  assert.equal(first.adapters.length, 0);
  assert.equal(first.calls.length, 0);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.descriptor, {
    protocol: "jevyr.mcp-witnesses/1",
    servers: [],
    calls: [],
  });
});

test("exact servers and calls are loaded while credential values remain outside public provenance", async () => {
  const secret = "credential-must-not-enter-descriptor";
  const path = await configuration(validConfig());
  const loaded = loadMcpWitnesses({
    JEVYR_MCP_WITNESSES_FILE: path,
    JEVYR_TEST_WITNESS_CREDENTIAL: secret,
  });
  assert.equal(loaded.adapters.length, 1);
  assert.equal(loaded.calls.length, 1);
  assert.equal(loaded.calls[0]?.tool, "inspect");
  assert.match(loaded.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(loaded.descriptor), new RegExp(secret, "u"));
  assert.match(JSON.stringify(loaded.descriptor), /observation-only/u);
});

test("witness authority rejects duplicate keys and malformed UTF-8 before adapters exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-mcp-witnesses-bytes-"));
  roots.push(root);
  const path = join(root, "witnesses.json");
  const env = {
    JEVYR_MCP_WITNESSES_FILE: path,
    JEVYR_TEST_WITNESS_CREDENTIAL: "x",
  };

  await writeFile(
    path,
    '{"protocol":"jevyr.mcp-witnesses/0","protocol":"jevyr.mcp-witnesses/1","servers":[],"calls":[]}',
    "utf8",
  );
  assert.throws(() => loadMcpWitnesses(env), /duplicate object key "protocol"/u);

  const encoded = Buffer.from(JSON.stringify(validConfig()), "utf8");
  const marker = encoded.indexOf("fixed before Cast");
  assert.ok(marker >= 0);
  encoded[marker] = 0xff;
  await writeFile(path, encoded);
  assert.throws(() => loadMcpWitnesses(env), /not valid UTF-8/u);
});

test("configuration is strict and a discovered tool cannot create call authority", async (context) => {
  const env = { JEVYR_TEST_WITNESS_CREDENTIAL: "x" };
  await context.test("unknown root field", async () => {
    const path = await configuration(validConfig({ surprise: true }));
    assert.throws(() => loadMcpWitnesses({ ...env, JEVYR_MCP_WITNESSES_FILE: path }), /unknown fields: surprise/u);
  });
  await context.test("relative executable", async () => {
    const value = validConfig();
    (value.servers as Record<string, unknown>[])[0] = {
      ...((value.servers as Record<string, unknown>[])[0] as Record<string, unknown>),
      command: "node",
    };
    const path = await configuration(value);
    assert.throws(() => loadMcpWitnesses({ ...env, JEVYR_MCP_WITNESSES_FILE: path }), /absolute executable/u);
  });
  await context.test("unallowlisted call", async () => {
    const value = validConfig();
    (value.calls as Record<string, unknown>[])[0] = {
      ...((value.calls as Record<string, unknown>[])[0] as Record<string, unknown>),
      tool: "discovered-but-not-authorized",
    };
    const path = await configuration(value);
    assert.throws(() => loadMcpWitnesses({ ...env, JEVYR_MCP_WITNESSES_FILE: path }), /not explicitly allowlisted/u);
  });
  await context.test("secret-shaped call argument", async () => {
    const value = validConfig();
    (value.calls as Record<string, unknown>[])[0] = {
      ...((value.calls as Record<string, unknown>[])[0] as Record<string, unknown>),
      arguments: { api_token: "do-not-seal-this" },
    };
    const path = await configuration(value);
    assert.throws(() => loadMcpWitnesses({ ...env, JEVYR_MCP_WITNESSES_FILE: path }), /secret-shaped field/u);
  });
});

test("missing credential environment is refused before any MCP process can start", async () => {
  const path = await configuration(validConfig());
  assert.throws(
    () => loadMcpWitnesses({ JEVYR_MCP_WITNESSES_FILE: path }),
    /requires missing environment variable JEVYR_TEST_WITNESS_CREDENTIAL/u,
  );
});
