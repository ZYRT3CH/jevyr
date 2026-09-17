import { describe, expect, it, vi } from "vitest";
import { JevyrClient, JevyrHttpError } from "../src/client.js";
import { canonicalJson, sha256Digest } from "../src/digest.js";
import {
  assertConnectionsView, assertConnectionModelList, normalizeConnectionProfile,
  type ConnectionProfile, type ConnectionsView, type ModelConnection,
} from "../src/connections.js";

const local: ModelConnection = { id: "local-qwen", label: "Local model", provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1/", model: "qwen3.5:4b", transport: "native", remoteDisclosure: "none" };
const profile: ConnectionProfile = { protocol: "jevyr.connection-profile/1", models: [local], mcpServerIds: ["reference"] };
const time = "2026-09-05T10:00:00.000Z";
function view(): ConnectionsView {
  return { protocol: "jevyr.connections-view/1", revision: 0, saved: null,
    active: { source: "environment", profileDigest: null, models: [local], mcpServerIds: ["reference"] }, restartRequired: false,
    credentials: [{ id: "openai-env", label: "OpenAI environment", origin: "https://api.openai.com", available: false }],
    mcpServers: [{ id: "reference", label: "Reference", transport: "stdio", allowedTools: ["read_reference"], active: true }],
    permissions: { canConfigure: true, reason: null } };
}
function list() {
  return { protocol: "jevyr.connection-model-list/1", status: "available", models: [{ id: local.model }], selectedModelListed: true, code: "MODELS_LISTED", checkedAt: time };
}
function client(value: unknown) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
  return { client: new JevyrClient({ baseUrl: "http://judge.local", headers: { authorization: "Bearer explicit-http-token" }, fetch: fetcher }), fetcher };
}

describe("connection client contract", () => {
  it("reads sanitized active and saved state with the configured HTTP authorization", async () => {
    const setup = client(view());
    await expect(setup.client.connections()).resolves.toEqual(view());
    expect(setup.fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = setup.fetcher.mock.calls[0]!;
    expect(url).toBe("http://judge.local/v1/settings/connections");
    expect(request?.headers).toMatchObject({ authorization: "Bearer explicit-http-token", accept: "application/json" });
    expect(request?.body).toBeUndefined();
  });

  it("saves only the normalized profile and exact revision without mutating its input", async () => {
    const withFamily = { ...profile, models: [{ ...local, modelFamily: "declared-qwen-family" }] };
    const input = { ...withFamily, models: [{ ...withFamily.models[0]!, baseUrl: "http://127.0.0.1:11434/v1" }] };
    const response = { ...view(), revision: 1, saved: withFamily, restartRequired: true };
    const setup = client(response);
    await expect(setup.client.saveConnections(0, input)).resolves.toEqual(response);
    const [url, request] = setup.fetcher.mock.calls[0]!;
    expect(url).toBe("http://judge.local/v1/settings/connections");
    expect(request?.method).toBe("PUT");
    expect(JSON.parse(request!.body as string)).toEqual({ revision: 0, profile: withFamily });
    expect(input.models[0]!.baseUrl).toBe("http://127.0.0.1:11434/v1");
  });

  it("does not retry stale writes, permission failures, or provider discovery errors", async () => {
    for (const status of [409, 403, 503]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: "CONNECTION_REQUEST_REFUSED" }, { status }));
      const sdk = new JevyrClient({ fetch: fetcher });
      await expect(sdk.saveConnections(0, profile)).rejects.toMatchObject({ status });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    expect(new JevyrHttpError(409, "STALE_REVISION")).toBeInstanceOf(Error);
  });

  it("discovers an exact selected model and sends neither inference text nor credentials", async () => {
    const setup = client(list());
    await expect(setup.client.connectionModels(local)).resolves.toEqual(list());
    const [url, request] = setup.fetcher.mock.calls[0]!;
    expect(url).toBe("http://judge.local/v1/settings/connections/models");
    expect(request?.method).toBe("POST");
    expect(JSON.parse(request!.body as string)).toEqual({ connection: local });
    const wrong = client({ ...list(), selectedModelListed: false });
    await expect(wrong.client.connectionModels(local)).rejects.toThrow("selected model listing mismatch");
  });

  it("tests only a registered MCP identifier and binds the returned identifier", async () => {
    const result = { protocol: "jevyr.connection-mcp-test/1", serverId: "reference", status: "available", code: "MCP_AVAILABLE", checkedAt: time };
    const setup = client(result);
    await expect(setup.client.testMcpConnection("reference")).resolves.toEqual(result);
    const [url, request] = setup.fetcher.mock.calls[0]!;
    expect(url).toBe("http://judge.local/v1/settings/connections/mcp-test");
    expect(JSON.parse(request!.body as string)).toEqual({ serverId: "reference" });
    await expect(client({ ...result, serverId: "other" }).client.testMcpConnection("reference")).rejects.toThrow("server mismatch");
    await expect(setup.client.testMcpConnection("../command")).rejects.toThrow("identifier");
    expect(setup.fetcher).toHaveBeenCalledTimes(1);
  });

  it("validates secret-free closed requests before performing any fetch", async () => {
    const setup = client(view());
    for (const bad of [
      { ...local, apiKey: "must-never-leave-this-test" },
      { ...local, credentialId: "env:NAME", reference: "env:NAME" },
      { ...local, command: "arbitrary.exe" },
      { ...local, label: "\tcontrol" },
      { ...local, model: "   " },
      { ...local, model: "name\u007f" },
      { ...local, modelFamily: "invalid\tlineage" },
      { ...local, baseUrl: "https://user:secret@example.com/v1", provider: "openai-compatible", remoteDisclosure: "case-policy" },
      { ...local, baseUrl: "https://api.example.com/v1?api_key=secret", provider: "openai-compatible", remoteDisclosure: "case-policy" },
      { ...local, baseUrl: "http://remote.example.com/v1", provider: "openai-compatible", remoteDisclosure: "case-policy" },
      { ...local, baseUrl: "https://remote.example.com/v1", provider: "openai-compatible" },
      { ...local, remoteDisclosure: "case-policy" },
    ]) await expect(setup.client.connectionModels(bad as ModelConnection)).rejects.toThrow("Invalid connection");
    await expect(setup.client.saveConnections(-1, profile)).rejects.toThrow("revision");
    await expect(setup.client.saveConnections(0, { ...profile, mcpServerIds: ["reference", "reference"] })).rejects.toThrow("duplicate");
    await expect(setup.client.saveConnections(0, { ...profile, models: Array.from({ length: 9 }, (_, i) => ({ ...local, id: `id-${i}` })) })).rejects.toThrow("models");
    expect(setup.fetcher).not.toHaveBeenCalled();
  });

  it("accepts an exact-origin opaque cloud credential reference without exposing its value", async () => {
    const cloud: ModelConnection = { ...local, provider: "openai-compatible", baseUrl: "https://api.openai.com/v1/", credentialId: "openai-env", remoteDisclosure: "case-policy" };
    const setup = client(list());
    await setup.client.connectionModels(cloud);
    expect(JSON.parse(setup.fetcher.mock.calls[0]![1]!.body as string).connection.credentialId).toBe("openai-env");
  });

  it("checks active profile content instead of trusting an arbitrary digest or the pending saved profile", async () => {
    const active = { source: "saved-profile" as const, models: profile.models, mcpServerIds: profile.mcpServerIds, profileDigest: await sha256Digest(canonicalJson(profile)) };
    const pending = { ...profile, models: [{ ...local, model: "next-model" }] };
    await expect(assertConnectionsView({ ...view(), revision: 2, active, saved: pending, restartRequired: true })).resolves.toBeDefined();
    await expect(assertConnectionsView({ ...view(), active: { ...active, models: [{ ...local, model: "tampered" }] } })).rejects.toThrow("digest");
    await expect(assertConnectionsView({ ...view(), active: { ...active, source: "environment" } })).rejects.toThrow("source");
    await expect(client({ ...view(), saved: pending, revision: 1 }).client.saveConnections(0, profile)).rejects.toThrow("differs");
    await expect(client({ ...view(), saved: profile, revision: 0 }).client.saveConnections(0, profile)).rejects.toThrow("revision differs");
  });

  it("refuses unknown response fields including hidden credentials, commands, and quality claims", async () => {
    for (const bad of [
      { ...view(), qualified: true },
      { ...view(), active: { ...view().active, assumedLocal: true } },
      { ...view(), credentials: [{ ...view().credentials[0], reference: "env:HIDDEN_SECRET" }] },
      { ...view(), mcpServers: [{ ...view().mcpServers[0], command: "hidden.exe" }] },
      { ...view(), permissions: { ...view().permissions, bypass: true } },
    ]) await expect(client(bad).client.connections()).rejects.toThrow("fields");
    await expect(client({ ...list(), models: [{ id: local.model, metadata: "unbounded" }] }).client.connectionModels(local)).rejects.toThrow("fields");
  });

  it("distinguishes failed discovery from an empty successful listing and validates timestamps and bounds", () => {
    expect(assertConnectionModelList({ ...list(), models: [], selectedModelListed: false }, local.model).status).toBe("available");
    expect(assertConnectionModelList({ ...list(), status: "unavailable", models: [], selectedModelListed: null }, local.model).status).toBe("unavailable");
    expect(assertConnectionModelList({ ...list(), models: [{ id: "another-model" }], code: "MODEL_LIST_PARTIAL" }, local.model).selectedModelListed).toBe(true);
    expect(() => assertConnectionModelList({ ...list(), status: "failed" })).toThrow("unavailable model listing");
    expect(() => assertConnectionModelList({ ...list(), checkedAt: "2026-09-05" })).toThrow("timestamp");
    expect(() => assertConnectionModelList({ ...list(), code: "raw error contains secrets" })).toThrow("code");
    expect(() => assertConnectionModelList({ ...list(), models: Array.from({ length: 129 }, (_, i) => ({ id: `model-${i}` })) })).toThrow("listed models");
    expect(() => normalizeConnectionProfile({ ...profile, models: [local, local] })).toThrow("duplicate");
  });

  it("caps the new endpoints at one MiB and rejects duplicate-key JSON before validation", async () => {
    const tooLarge = new Response("{}", { headers: { "content-length": String(1_048_577) } });
    const duplicate = new Response('{"protocol":"jevyr.connections-view/1","protocol":"other"}');
    for (const [response, message] of [[tooLarge, "1048576-byte limit"], [duplicate, "duplicate object key"]] as const) {
      const sdk = new JevyrClient({ fetch: vi.fn<typeof fetch>().mockResolvedValue(response) });
      await expect(sdk.connections()).rejects.toThrow(message);
    }
  });

  it("forwards cancellation to discovery and never retries an aborted request", async () => {
    const signal = AbortSignal.abort();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(new JevyrClient({ fetch: fetcher }).connectionModels(local, signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.signal).toBe(signal);
  });
});
