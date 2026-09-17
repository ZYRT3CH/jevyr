import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import { configuredMindAdapters, EnvironmentSecretBroker, OpenAICompatibleMindAdapter, secretReference, snapshotAdapterCapability, type MindAdapter, type SecretBroker, type SecretReference } from "@jevyr/runtime";
import type { LoadedMcpWitnesses } from "./mcp-witnesses.js";
import { readConnectionModelList } from "./connection-probes.js";

export interface ModelConnection {
  readonly id: string; readonly label: string;
  readonly provider: "ollama" | "lm-studio" | "openai-compatible";
  readonly baseUrl: string; readonly model: string; readonly transport: "native" | "structured";
  readonly credentialId?: string; readonly modelFamily?: string; readonly remoteDisclosure: "none" | "case-policy";
}
export interface ConnectionProfile { readonly protocol: "jevyr.connection-profile/1"; readonly models: readonly ModelConnection[]; readonly mcpServerIds: readonly string[] }
export interface ConnectionView {
  readonly protocol: "jevyr.connections-view/1"; readonly revision: number; readonly saved: ConnectionProfile | null;
  readonly active: { readonly profileDigest: string | null; readonly models: readonly ModelConnection[]; readonly mcpServerIds: readonly string[]; readonly source: "saved-profile" | "environment" };
  readonly restartRequired: boolean;
  readonly credentials: readonly { readonly id: string; readonly label: string; readonly origin: string; readonly available: boolean }[];
  readonly mcpServers: readonly { readonly id: string; readonly label: string; readonly transport: "stdio"; readonly allowedTools: readonly string[]; readonly active: boolean }[];
  readonly permissions: { readonly canConfigure: boolean; readonly reason: string | null };
}
export class ConnectionSettingsError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const invalid = (): never => { throw new ConnectionSettingsError(400, "INVALID_CONNECTION_SETTINGS"); };
export function connectionObject(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const object = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(object, key)) || Object.keys(object).some(key => !required.includes(key) && !optional.includes(key))) return invalid();
  return object;
}
export function connectionId(value: unknown): string { if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) return invalid(); return value; }
function line(value: unknown, maximum = 256): string { if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) return invalid(); return value; }
export function isConnectionLoopback(url: URL): boolean { return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname); }
function endpoint(value: unknown): URL {
  let url: URL; try { url = new URL(line(value, 2048)); } catch { return invalid(); }
  if (url.username || url.password || url.search || url.hash || !["https:", "http:"].includes(url.protocol)
    || (url.protocol !== "https:" && !isConnectionLoopback(url))) return invalid();
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
export function parseModelConnection(value: unknown): ModelConnection {
  const raw = connectionObject(value, ["id", "label", "provider", "baseUrl", "model", "transport", "remoteDisclosure"], ["credentialId", "modelFamily"]);
  const url = endpoint(raw.baseUrl);
  if (!["ollama", "lm-studio", "openai-compatible"].includes(String(raw.provider)) || !["native", "structured"].includes(String(raw.transport))
    || raw.remoteDisclosure !== (isConnectionLoopback(url) ? "none" : "case-policy")
    || (raw.provider !== "openai-compatible" && !isConnectionLoopback(url))) return invalid();
  return Object.freeze({ id: connectionId(raw.id), label: line(raw.label), provider: raw.provider as ModelConnection["provider"], baseUrl: url.href,
    model: line(raw.model), transport: raw.transport as ModelConnection["transport"], remoteDisclosure: raw.remoteDisclosure as ModelConnection["remoteDisclosure"],
    ...(raw.credentialId === undefined ? {} : { credentialId: connectionId(raw.credentialId) }), ...(raw.modelFamily === undefined ? {} : { modelFamily: line(raw.modelFamily) }) });
}
export function parseConnectionProfile(value: unknown): ConnectionProfile {
  const raw = connectionObject(value, ["protocol", "models", "mcpServerIds"]);
  if (raw.protocol !== "jevyr.connection-profile/1" || !Array.isArray(raw.models) || raw.models.length > 8 || !Array.isArray(raw.mcpServerIds) || raw.mcpServerIds.length > 16) return invalid();
  const models = raw.models.map(parseModelConnection), mcpServerIds = raw.mcpServerIds.map(connectionId);
  if (new Set(models.map(model => model.id)).size !== models.length || new Set(mcpServerIds).size !== mcpServerIds.length) return invalid();
  return Object.freeze({ protocol: "jevyr.connection-profile/1", models: Object.freeze(models), mcpServerIds: Object.freeze(mcpServerIds) });
}
export function connectionRevision(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) return invalid(); return value as number; }
function digest(profile: ConnectionProfile): string { return digestJson(profile as unknown as JsonValue); }
/** Keep the admitted capability ID within Airlock's 128-character limit for every public profile ID. */
export function connectionCapabilityId(id: string): string { return `mind.connection.${digestJson(connectionId(id)).slice(7)}`; }
function plainFile(path: string, maxBytes: number): Buffer {
  const before = lstatSync(path); if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) throw new ConnectionSettingsError(409, "UNSAFE_CONNECTION_SETTINGS_FILE");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd); if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes || stat.nlink !== 1) throw new ConnectionSettingsError(409, "CONNECTION_SETTINGS_CHANGED");
    const bytes = Buffer.alloc(maxBytes + 1); let length = 0;
    while (length < bytes.length) { const read = readSync(fd, bytes, length, bytes.length - length, null); if (!read) break; length += read; }
    const after = fstatSync(fd);
    if (length > maxBytes || length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new ConnectionSettingsError(409, "CONNECTION_SETTINGS_CHANGED");
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
}
interface Store { readonly revision: number; readonly profile: ConnectionProfile | null }
interface Credential { readonly id: string; readonly label: string; readonly origin: string; readonly available: boolean; readonly reference: SecretReference; readonly broker: SecretBroker }

/** Settings are outside Cases. Active adapters, credential values and host MCP registration are captured once. */
export class ConnectionProfiles {
  readonly #root: string; readonly #directory: string; readonly #path: string; readonly #env: NodeJS.ProcessEnv;
  readonly #credentials: readonly Credential[]; readonly #registered: LoadedMcpWitnesses; readonly #startup: Store;
  readonly #active: ConnectionView["active"]; readonly #servers: ConnectionView["mcpServers"];
  #inFlight = 0;
  constructor(projectRoot: string, environment: NodeJS.ProcessEnv, registered: LoadedMcpWitnesses) {
    this.#root = realpathSync(resolve(projectRoot)); this.#directory = join(this.#root, ".jevyr"); this.#path = join(this.#directory, "connections.json");
    this.#env = { ...environment }; this.#registered = registered; this.#checkParent();
    this.#credentials = this.#loadCredentials(); this.#startup = this.#read();
    const descriptor = registered.descriptor as { servers: { id: string; displayName: string; allowedTools: string[] }[] };
    const activeIds = this.#startup.profile?.mcpServerIds ?? registered.adapters.map(adapter => snapshotAdapterCapability(adapter).id);
    this.#servers = Object.freeze(descriptor.servers.map(server => Object.freeze({ id: server.id, label: server.displayName, transport: "stdio" as const,
      allowedTools: Object.freeze([...server.allowedTools]), active: activeIds.includes(server.id) })));
    this.#active = Object.freeze({ profileDigest: this.#startup.profile ? digest(this.#startup.profile) : null,
      models: this.#startup.profile?.models ?? Object.freeze(this.#environmentModels()), mcpServerIds: Object.freeze([...activeIds]), source: this.#startup.profile ? "saved-profile" : "environment" });
    this.view(false); // Refuse an oversized operator catalog rather than emitting a truncated catalog.
  }
  #checkParent(create = false): void {
    if (realpathSync(this.#root) !== this.#root) throw new ConnectionSettingsError(409, "CONNECTION_SETTINGS_CHANGED");
    if (!existsSync(this.#directory)) { if (create) mkdirSync(this.#directory); else return; }
    const stat = lstatSync(this.#directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(this.#directory) !== this.#directory) throw new ConnectionSettingsError(409, "UNSAFE_CONNECTION_SETTINGS_DIRECTORY");
  }
  #read(): Store {
    this.#checkParent(); if (!existsSync(this.#path)) return { revision: 0, profile: null };
    const raw = connectionObject(parseJsonBytes(plainFile(this.#path, 32_768)), ["protocol", "revision", "profile"]);
    if (raw.protocol !== "jevyr.connection-profile-store/1") return invalid();
    return { revision: connectionRevision(raw.revision), profile: parseConnectionProfile(raw.profile) };
  }
  #loadCredentials(): readonly Credential[] {
    const entries: { id: string; label: string; origin: string; reference: string }[] = [
      { id: "openai-env", label: "OpenAI environment credential", origin: "https://api.openai.com", reference: "env:OPENAI_API_KEY" },
    ];
    const compatibleName = this.#env.JEVYR_OPENAI_COMPATIBLE_CREDENTIAL_REF ?? (this.#env.JEVYR_OPENAI_COMPATIBLE_API_KEY ? "JEVYR_OPENAI_COMPATIBLE_API_KEY" : undefined);
    if (compatibleName && this.#env.JEVYR_OPENAI_COMPATIBLE_BASE_URL) entries.push({ id: "environment-compatible", label: "Configured endpoint credential",
      origin: endpoint(this.#env.JEVYR_OPENAI_COMPATIBLE_BASE_URL).origin, reference: `env:${compatibleName}` });
    const file = this.#env.JEVYR_CONNECTION_CREDENTIALS_FILE ? resolve(this.#root, this.#env.JEVYR_CONNECTION_CREDENTIALS_FILE) : join(this.#directory, "connection-credentials.json");
    if (existsSync(file)) {
      const raw = connectionObject(parseJsonBytes(plainFile(file, 32_768)), ["protocol", "credentials"]);
      if (raw.protocol !== "jevyr.connection-credentials/1" || !Array.isArray(raw.credentials) || raw.credentials.length > 16) return invalid();
      for (const value of raw.credentials) {
        const entry = connectionObject(value, ["id", "label", "origin", "reference"]), url = endpoint(entry.origin);
        if (url.pathname !== "/" || typeof entry.reference !== "string" || !/^env:[A-Z][A-Z0-9_]{0,127}$/u.test(entry.reference)) return invalid();
        entries.push({ id: connectionId(entry.id), label: line(entry.label), origin: url.origin, reference: entry.reference });
      }
    }
    if (new Set(entries.map(entry => entry.id)).size !== entries.length) return invalid();
    return Object.freeze(entries.map(entry => {
      const reference = secretReference(entry.reference.slice(4), entry.origin); let available = true, broker: SecretBroker;
      try { broker = new EnvironmentSecretBroker([reference], this.#env); } catch { available = false; broker = Object.freeze({ authorization(): never { throw new Error("CONNECTION_CREDENTIAL_UNAVAILABLE"); } }); }
      return Object.freeze({ ...entry, reference, broker, available });
    }));
  }
  #environmentModels(): ModelConnection[] {
    const models: ModelConnection[] = [];
    const add = (id: string, label: string, provider: ModelConnection["provider"], model: string | undefined, baseUrl: string | undefined, transport: string | undefined, modelFamily?: string, credentialId?: string) => {
      if (!model || !baseUrl) return; const url = endpoint(baseUrl);
      models.push(parseModelConnection({ id, label, provider, model, baseUrl: url.href, transport: transport ?? "native", remoteDisclosure: isConnectionLoopback(url) ? "none" : "case-policy", ...(credentialId ? { credentialId } : {}), ...(modelFamily ? { modelFamily } : {}) }));
    };
    add("ollama", "Ollama", "ollama", this.#env.JEVYR_OLLAMA_MODEL, this.#env.JEVYR_OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1/", this.#env.JEVYR_OLLAMA_INVESTIGATION_TRANSPORT, this.#env.JEVYR_OLLAMA_MODEL_FAMILY);
    add("lm-studio", "LM Studio", "lm-studio", this.#env.JEVYR_LMSTUDIO_MODEL, this.#env.JEVYR_LMSTUDIO_BASE_URL ?? "http://127.0.0.1:1234/v1/", this.#env.JEVYR_LMSTUDIO_INVESTIGATION_TRANSPORT, this.#env.JEVYR_LMSTUDIO_MODEL_FAMILY);
    add("environment-compatible", "Configured text endpoint", "openai-compatible", this.#env.JEVYR_OPENAI_COMPATIBLE_MODEL, this.#env.JEVYR_OPENAI_COMPATIBLE_BASE_URL, this.#env.JEVYR_OPENAI_COMPATIBLE_INVESTIGATION_TRANSPORT, this.#env.JEVYR_OPENAI_COMPATIBLE_MODEL_FAMILY,
      this.#credentials.some(entry => entry.id === "environment-compatible") ? "environment-compatible" : undefined);
    return models;
  }
  #credential(connection: ModelConnection, required: boolean): Credential | undefined {
    if (!connection.credentialId) return undefined;
    const credential = this.#credentials.find(entry => entry.id === connection.credentialId && entry.origin === new URL(connection.baseUrl).origin);
    if (!credential && required) throw new ConnectionSettingsError(400, "CREDENTIAL_DESTINATION_NOT_REGISTERED");
    return credential;
  }
  #authorize(profile: ConnectionProfile): void {
    for (const model of profile.models) this.#credential(model, true);
    if (profile.mcpServerIds.some(id => !this.#servers.some(server => server.id === id))) throw new ConnectionSettingsError(400, "MCP_SERVER_NOT_REGISTERED");
  }
  view(canConfigure: boolean, reason: string | null = canConfigure ? null : "Use the authorized local application origin to configure connections."): ConnectionView {
    const store = this.#read();
    const value: ConnectionView = { protocol: "jevyr.connections-view/1", revision: store.revision, saved: store.profile, active: this.#active,
      restartRequired: store.profile !== null && digest(store.profile) !== this.#active.profileDigest,
      credentials: this.#credentials.map(({ id, label, origin, available }) => ({ id, label, origin, available })), mcpServers: this.#servers,
      permissions: { canConfigure, reason } };
    if (Buffer.byteLength(JSON.stringify(value)) > 900_000) throw new ConnectionSettingsError(409, "CONNECTION_CATALOG_TOO_LARGE");
    return structuredClone(value);
  }
  save(revision: unknown, input: unknown): void {
    const expected = connectionRevision(revision), profile = parseConnectionProfile(input); this.#authorize(profile); this.#checkParent(true);
    const lock = join(this.#directory, "connections.lock"); let fd: number;
    try { fd = openSync(lock, "wx", 0o600); } catch { throw new ConnectionSettingsError(409, "CONNECTION_SETTINGS_BUSY"); }
    const temporary = join(this.#directory, `connections.${randomUUID()}.tmp`);
    try {
      if (this.#read().revision !== expected) throw new ConnectionSettingsError(409, "CONNECTION_REVISION_CONFLICT");
      if (expected === 2_147_483_647) throw new ConnectionSettingsError(409, "CONNECTION_REVISION_EXHAUSTED");
      const bytes = Buffer.from(JSON.stringify({ protocol: "jevyr.connection-profile-store/1", revision: expected + 1, profile }));
      const output = openSync(temporary, "wx", 0o600); try { writeFileSync(output, bytes); fsyncSync(output); } finally { closeSync(output); }
      this.#checkParent(); if (this.#read().revision !== expected) throw new ConnectionSettingsError(409, "CONNECTION_REVISION_CONFLICT");
      renameSync(temporary, this.#path);
    } finally { closeSync(fd); unlinkSync(lock); if (existsSync(temporary)) unlinkSync(temporary); }
  }
  /** Native command and stdin adapters retain their separately registered operator configuration. */
  minds(): readonly MindAdapter[] {
    if (!this.#startup.profile) return configuredMindAdapters(this.#env);
    const env = { ...this.#env }; delete env.JEVYR_OLLAMA_MODEL; delete env.JEVYR_LMSTUDIO_MODEL; delete env.JEVYR_OPENAI_COMPATIBLE_MODEL;
    const native = configuredMindAdapters(env), models = this.#startup.profile.models.map(connection => {
      const credential = this.#credential(connection, false);
      const missing = connection.credentialId && !credential ? secretReference("UNREGISTERED_CONNECTION_CREDENTIAL", connection.baseUrl) : undefined;
      return new OpenAICompatibleMindAdapter({ id: connectionCapabilityId(connection.id), displayName: connection.label, model: connection.model,
        baseUrl: connection.baseUrl, investigationTransport: connection.transport, allowRemote: connection.remoteDisclosure === "case-policy", ...(connection.modelFamily ? { modelFamily: connection.modelFamily } : {}),
        ...(credential ? { credential: credential.reference, secretBroker: credential.broker } : missing ? { credential: missing,
          secretBroker: { authorization(): never { throw new Error("CONNECTION_CREDENTIAL_UNAVAILABLE"); } } } : {}) });
    });
    return Object.freeze([...native.filter(mind => models.length === 0 || snapshotAdapterCapability(mind).id !== "mind.rule.v1"), ...models]);
  }
  witnesses(): LoadedMcpWitnesses {
    if (!this.#startup.profile) return this.#registered;
    const selected = new Set(this.#startup.profile.mcpServerIds), original = this.#registered.descriptor as { protocol: string; servers: { id: string }[]; calls: { serverId: string }[] };
    const descriptor = { ...original, servers: original.servers.filter(server => selected.has(server.id)), calls: original.calls.filter(call => selected.has(call.serverId)) } as unknown as JsonValue;
    return Object.freeze({ adapters: Object.freeze(this.#registered.adapters.filter(adapter => selected.has(snapshotAdapterCapability(adapter).id))),
      calls: Object.freeze(this.#registered.calls.filter(call => selected.has(call.serverId))), descriptor, digest: digestJson(descriptor) });
  }
  get descriptor(): JsonValue { return structuredClone({ protocol: "jevyr.connection-startup/1", ...this.#active }) as unknown as JsonValue; }
  async models(input: unknown): Promise<Awaited<ReturnType<typeof readConnectionModelList>>> {
    const connection = parseModelConnection(input), credential = this.#credential(connection, true);
    if (this.#inFlight >= 2) throw new ConnectionSettingsError(429, "CONNECTION_TEST_BUSY"); this.#inFlight++;
    try { return await readConnectionModelList(connection, credential ? () => credential.broker.authorization(credential.reference, connection.baseUrl) : undefined); }
    finally { this.#inFlight--; }
  }
  async testMcp(input: unknown): Promise<{ protocol: "jevyr.connection-mcp-test/1"; serverId: string; status: "available" | "unavailable" | "failed"; code: string; checkedAt: string }> {
    const serverId = connectionId(input), adapter = this.#registered.adapters.find(adapter => snapshotAdapterCapability(adapter).id === serverId);
    if (!adapter) throw new ConnectionSettingsError(400, "MCP_SERVER_NOT_REGISTERED");
    if (this.#inFlight >= 2) throw new ConnectionSettingsError(429, "CONNECTION_TEST_BUSY"); this.#inFlight++;
    try { const result = await adapter.probe(AbortSignal.timeout(5_000)); return { protocol: "jevyr.connection-mcp-test/1", serverId, status: result.available ? "available" : "unavailable", code: result.available ? "MCP_METADATA_AVAILABLE" : "MCP_METADATA_UNAVAILABLE", checkedAt: new Date().toISOString() }; }
    catch { return { protocol: "jevyr.connection-mcp-test/1", serverId, status: "failed", code: "MCP_METADATA_FAILED", checkedAt: new Date().toISOString() }; }
    finally { this.#inFlight--; }
  }
}
