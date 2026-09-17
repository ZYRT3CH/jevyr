import { JevyrContinuityError } from "./errors.js";
import { canonicalJson, sha256Digest } from "./digest.js";

export interface ModelConnection {
  readonly id: string;
  readonly label: string;
  readonly provider: "ollama" | "lm-studio" | "openai-compatible";
  readonly baseUrl: string;
  readonly model: string;
  readonly modelFamily?: string;
  readonly transport: "native" | "structured";
  readonly credentialId?: string;
  readonly remoteDisclosure: "none" | "case-policy";
}
export interface ConnectionProfile {
  readonly protocol: "jevyr.connection-profile/1";
  readonly models: readonly ModelConnection[];
  readonly mcpServerIds: readonly string[];
}
export interface ConnectionsView {
  readonly protocol: "jevyr.connections-view/1";
  readonly revision: number;
  readonly saved: ConnectionProfile | null;
  readonly active: {
    readonly profileDigest: string | null;
    readonly models: readonly ModelConnection[];
    readonly mcpServerIds: readonly string[];
    readonly source: "saved-profile" | "environment";
  };
  readonly restartRequired: boolean;
  readonly credentials: readonly { readonly id: string; readonly label: string; readonly origin: string; readonly available: boolean }[];
  readonly mcpServers: readonly { readonly id: string; readonly label: string; readonly transport: "stdio"; readonly allowedTools: readonly string[]; readonly active: boolean }[];
  readonly permissions: { readonly canConfigure: boolean; readonly reason: string | null };
}
export type ConnectionTestStatus = "available" | "unavailable" | "failed";
export interface ConnectionModelList {
  readonly protocol: "jevyr.connection-model-list/1";
  readonly status: ConnectionTestStatus;
  readonly models: readonly { readonly id: string }[];
  readonly selectedModelListed: boolean | null;
  readonly code: string;
  readonly checkedAt: string;
}
export interface ConnectionMcpTest {
  readonly protocol: "jevyr.connection-mcp-test/1";
  readonly serverId: string;
  readonly status: ConnectionTestStatus;
  readonly code: string;
  readonly checkedAt: string;
}

export const MAX_CONNECTION_ENDPOINT_BYTES = 1_048_576;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function fail(label: string): never { throw new JevyrContinuityError(`Invalid connection ${label}`); }
function object(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail(label);
  const item = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(item, key)) || Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))) return fail(`${label} fields`);
  return item;
}
function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000\r\n]/u.test(value)) return fail(label);
  return value;
}
function line(value: unknown, maximum: number, label: string): string {
  const result = text(value, maximum, label);
  if (!result.trim() || /[\u0000-\u001f\u007f]/u.test(result)) return fail(label);
  return result;
}
export function assertConnectionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ID.test(value)) fail("identifier");
}
export function assertConnectionRevision(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_147_483_647) fail("revision");
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return fail(label);
  return value;
}
function array(value: unknown, maximum: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) return fail(label);
  return value;
}
function unique(items: readonly string[], label: string): void {
  if (new Set(items).size !== items.length) fail(`duplicate ${label}`);
}
function ids(value: unknown, maximum: number, label: string): readonly string[] {
  const values = array(value, maximum, label);
  for (const value of values) assertConnectionId(value);
  unique(values as string[], label);
  return values as string[];
}
function endpoint(value: unknown, label: string): URL {
  const input = line(value, 2_048, label);
  let url: URL;
  try { url = new URL(input); } catch { return fail(label); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return fail(label);
  return url;
}
function loopback(url: URL): boolean { return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"; }

/** Validate a secret-free model selection. No network request or provider probe occurs. */
export function assertModelConnection(value: unknown): ModelConnection {
  const raw = object(value, ["id", "label", "provider", "baseUrl", "model", "transport", "remoteDisclosure"], ["credentialId", "modelFamily"], "model");
  assertConnectionId(raw.id);
  line(raw.label, 256, "model label"); line(raw.model, 256, "model name");
  if (Object.hasOwn(raw, "modelFamily")) line(raw.modelFamily, 256, "model family");
  if (!["ollama", "lm-studio", "openai-compatible"].includes(raw.provider as string)
    || !["native", "structured"].includes(raw.transport as string)
    || !["none", "case-policy"].includes(raw.remoteDisclosure as string)) fail("model selection");
  if (Object.hasOwn(raw, "credentialId")) assertConnectionId(raw.credentialId);
  const url = endpoint(raw.baseUrl, "model URL");
  if (loopback(url) && raw.remoteDisclosure !== "none") fail("local disclosure policy");
  if (!loopback(url) && (url.protocol !== "https:" || raw.remoteDisclosure !== "case-policy" || raw.provider !== "openai-compatible")) fail("remote disclosure or endpoint");
  return raw as unknown as ModelConnection;
}
/** Normalize the same credential-free base URL form accepted by the daemon. */
export function normalizeModelConnection(value: unknown): ModelConnection {
  const connection = assertModelConnection(value);
  const url = new URL(connection.baseUrl);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return { ...connection, baseUrl: url.href };
}
function models(value: unknown): readonly ModelConnection[] {
  const entries = array(value, 8, "models").map(assertModelConnection);
  unique(entries.map(entry => entry.id), "model identifiers");
  return entries;
}
export function assertConnectionProfile(value: unknown): ConnectionProfile {
  const raw = object(value, ["protocol", "models", "mcpServerIds"], [], "profile");
  if (raw.protocol !== "jevyr.connection-profile/1") fail("profile protocol");
  models(raw.models); ids(raw.mcpServerIds, 16, "MCP identifiers");
  return raw as unknown as ConnectionProfile;
}
export function normalizeConnectionProfile(value: unknown): ConnectionProfile {
  const profile = assertConnectionProfile(value);
  return { protocol: profile.protocol, models: profile.models.map(normalizeModelConnection), mcpServerIds: [...profile.mcpServerIds] };
}

/** Live settings metadata, not a signed Case or a claim of provider qualification. */
export async function assertConnectionsView(value: unknown): Promise<ConnectionsView> {
  const raw = object(value, ["protocol", "revision", "saved", "active", "restartRequired", "credentials", "mcpServers", "permissions"], [], "view");
  if (raw.protocol !== "jevyr.connections-view/1") fail("view protocol");
  assertConnectionRevision(raw.revision);
  if (raw.saved !== null && canonicalJson(assertConnectionProfile(raw.saved)) !== canonicalJson(normalizeConnectionProfile(raw.saved))) fail("saved profile URL normalization");
  boolean(raw.restartRequired, "restartRequired");
  const active = object(raw.active, ["profileDigest", "models", "mcpServerIds", "source"], [], "active selection");
  const activeModels = models(active.models);
  if (activeModels.some(model => model.baseUrl !== normalizeModelConnection(model).baseUrl)) fail("active model URL normalization");
  const activeIds = ids(active.mcpServerIds, 16, "active MCP identifiers");
  if (active.source === "saved-profile") {
    const profile = { protocol: "jevyr.connection-profile/1", models: activeModels, mcpServerIds: activeIds };
    if (typeof active.profileDigest !== "string" || !DIGEST.test(active.profileDigest)
      || active.profileDigest !== await sha256Digest(canonicalJson(profile))) fail("active profile digest");
  } else if (active.source !== "environment" || active.profileDigest !== null) fail("active source");
  const credentials = array(raw.credentials, 18, "credential catalog").map(value => {
    const entry = object(value, ["id", "label", "origin", "available"], [], "credential metadata");
    assertConnectionId(entry.id); line(entry.label, 256, "credential label"); boolean(entry.available, "credential availability");
    const url = endpoint(entry.origin, "credential origin");
    if (url.origin !== entry.origin || (!loopback(url) && url.protocol !== "https:")) fail("credential origin");
    return entry;
  });
  unique(credentials.map(entry => entry.id as string), "credential identifiers");
  const servers = array(raw.mcpServers, 16, "MCP catalog").map(value => {
    const entry = object(value, ["id", "label", "transport", "allowedTools", "active"], [], "MCP metadata");
    assertConnectionId(entry.id); text(entry.label, 256, "MCP label"); boolean(entry.active, "MCP active flag");
    if (entry.transport !== "stdio") fail("MCP transport");
    const tools = array(entry.allowedTools, 128, "MCP tool names").map(tool => text(tool, 4_096, "MCP tool name"));
    unique(tools, "MCP tool names");
    return entry;
  });
  unique(servers.map(entry => entry.id as string), "MCP server identifiers");
  const permissions = object(raw.permissions, ["canConfigure", "reason"], [], "permissions");
  boolean(permissions.canConfigure, "configuration permission");
  if (permissions.reason !== null) text(permissions.reason, 256, "permission reason");
  return raw as unknown as ConnectionsView;
}
function testMetadata(raw: Record<string, unknown>): void {
  if (!["available", "unavailable", "failed"].includes(raw.status as string)
    || typeof raw.code !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.code)) fail("test status or code");
  if (typeof raw.checkedAt !== "string" || !Number.isFinite(Date.parse(raw.checkedAt)) || new Date(raw.checkedAt).toISOString() !== raw.checkedAt) fail("test timestamp");
}
export function assertConnectionModelList(value: unknown, selectedModel?: string): ConnectionModelList {
  const raw = object(value, ["protocol", "status", "models", "selectedModelListed", "code", "checkedAt"], [], "model listing");
  if (raw.protocol !== "jevyr.connection-model-list/1") fail("model listing protocol");
  testMetadata(raw);
  const entries = array(raw.models, 128, "listed models").map(value => {
    const entry = object(value, ["id"], [], "listed model");
    return line(entry.id, 256, "listed model identifier");
  });
  unique(entries, "listed model identifiers");
  if (raw.status === "available") {
    boolean(raw.selectedModelListed, "selected model listing");
    if (selectedModel !== undefined && (entries.includes(selectedModel) && raw.selectedModelListed !== true
      || !entries.includes(selectedModel) && raw.selectedModelListed === true && raw.code !== "MODEL_LIST_PARTIAL")) fail("selected model listing mismatch");
  } else if (entries.length !== 0 || raw.selectedModelListed !== null) fail("unavailable model listing");
  return raw as unknown as ConnectionModelList;
}
export function assertConnectionMcpTest(value: unknown, serverId?: string): ConnectionMcpTest {
  const raw = object(value, ["protocol", "serverId", "status", "code", "checkedAt"], [], "MCP test");
  if (raw.protocol !== "jevyr.connection-mcp-test/1") fail("MCP test protocol");
  assertConnectionId(raw.serverId); testMetadata(raw);
  if (serverId !== undefined && raw.serverId !== serverId) fail("MCP test server mismatch");
  return raw as unknown as ConnectionMcpTest;
}
