import { readFileSync } from "node:fs";
import { isAbsolute, dirname, resolve } from "node:path";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import {
  QuarantinedStdioMcpAdapter,
  type StdioMcpClientOptions,
} from "@jevyr/runtime";

const MCP_WITNESS_PROTOCOL = "jevyr.mcp-witnesses/1" as const;
const MAX_SERVERS = 16;
const MAX_CALLS = 64;
const MAX_ARGUMENT_BYTES = 256 * 1024;

export interface SealedMcpWitnessCall {
  readonly id: string;
  readonly serverId: string;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface LoadedMcpWitnesses {
  readonly adapters: readonly QuarantinedStdioMcpAdapter[];
  readonly calls: readonly SealedMcpWitnessCall[];
  /** Public, secret-free configuration bound into every subsequent Seal. */
  readonly descriptor: JsonValue;
  readonly digest: string;
}

interface RawServer {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly passEnvironment?: readonly string[];
  readonly allowedTools: readonly string[];
  readonly operationTimeoutMs?: number;
  readonly maxInputBytes?: number;
  readonly maxOutputBytes?: number;
  readonly maxStderrBytes?: number;
}

interface RawCall {
  readonly id: string;
  readonly serverId: string;
  readonly tool: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly timeoutMs?: number;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permit = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !permit.has(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${label} contains unknown fields: ${unknown.join(", ")}`);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} must be a stable identifier`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\u0000\r\n]/u.test(value)) {
    throw new TypeError(`${label} must be a non-empty single-line string of at most ${maximum} characters`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maximum: number): readonly string[] {
  if (!Array.isArray(value) || value.length > maximum || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${label} must be an array of at most ${maximum} strings`);
  }
  const normalized = value.map((entry, index) => boundedString(entry, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) throw new TypeError(`${label} must not contain duplicates`);
  return Object.freeze(normalized);
}

function optionalPositiveInteger(
  value: unknown,
  fallback: number,
  label: string,
  maximum: number,
): number {
  const result = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(result) || (result as number) < 1 || (result as number) > maximum) {
    throw new TypeError(`${label} must be an integer from 1 through ${maximum}`);
  }
  return result as number;
}

function containsSecretShapedKey(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) throw new TypeError("MCP call arguments must be an acyclic JSON object");
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => containsSecretShapedKey(entry, seen));
  return Object.entries(value as Record<string, unknown>).some(([key, entry]) =>
    /(?:^|[_-])(?:api[_-]?key|authorization|credential|password|secret|token)(?:$|[_-])/iu.test(key)
    || containsSecretShapedKey(entry, seen));
}

function jsonArguments(value: unknown, label: string): Readonly<Record<string, unknown>> {
  const args = value === undefined ? {} : object(value, label);
  if (containsSecretShapedKey(args)) {
    throw new TypeError(`${label} contains a secret-shaped field; pass credentials through an explicitly named environment variable`);
  }
  let encoded: string;
  try {
    encoded = JSON.stringify(args);
  } catch (cause) {
    throw new TypeError(`${label} must be JSON serializable`, { cause });
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_ARGUMENT_BYTES) {
    throw new TypeError(`${label} exceeds ${MAX_ARGUMENT_BYTES} canonical input bytes`);
  }
  return Object.freeze(structuredClone(args));
}

function resolveServer(
  rawValue: unknown,
  index: number,
  baseDirectory: string,
  env: NodeJS.ProcessEnv,
): { readonly raw: RawServer; readonly options: StdioMcpClientOptions; readonly descriptor: JsonValue } {
  const label = `MCP server ${index}`;
  const raw = object(rawValue, label) as unknown as RawServer & Record<string, unknown>;
  exactKeys(raw, [
    "id",
    "displayName",
    "command",
    "args",
    "cwd",
    "passEnvironment",
    "allowedTools",
    "operationTimeoutMs",
    "maxInputBytes",
    "maxOutputBytes",
    "maxStderrBytes",
  ], label);
  const id = identifier(raw.id, `${label}.id`);
  const displayName = boundedString(raw.displayName, `${label}.displayName`, 256);
  const command = boundedString(raw.command, `${label}.command`);
  if (!isAbsolute(command)) throw new TypeError(`${label}.command must be an absolute executable path`);
  const args = raw.args === undefined ? Object.freeze([]) : stringArray(raw.args, `${label}.args`, 64);
  const cwd = raw.cwd === undefined ? undefined : resolve(baseDirectory, boundedString(raw.cwd, `${label}.cwd`));
  const passEnvironment = raw.passEnvironment === undefined
    ? Object.freeze([])
    : stringArray(raw.passEnvironment, `${label}.passEnvironment`, 32);
  for (const name of passEnvironment) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) throw new TypeError(`${label}.passEnvironment contains an invalid name: ${name}`);
    if (env[name] === undefined) throw new TypeError(`${label} requires missing environment variable ${name}`);
  }
  const allowedTools = stringArray(raw.allowedTools, `${label}.allowedTools`, 128);
  const operationTimeoutMs = optionalPositiveInteger(raw.operationTimeoutMs, 10_000, `${label}.operationTimeoutMs`, 600_000);
  const maxInputBytes = optionalPositiveInteger(raw.maxInputBytes, 256 * 1024, `${label}.maxInputBytes`, 16 * 1024 * 1024);
  const maxOutputBytes = optionalPositiveInteger(raw.maxOutputBytes, 1024 * 1024, `${label}.maxOutputBytes`, 64 * 1024 * 1024);
  const maxStderrBytes = optionalPositiveInteger(raw.maxStderrBytes, 64 * 1024, `${label}.maxStderrBytes`, 16 * 1024 * 1024);
  const environment = Object.fromEntries(passEnvironment.map((name) => [name, env[name] as string]));
  const normalizedRaw: RawServer = Object.freeze({
    id,
    displayName,
    command,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    passEnvironment,
    allowedTools,
    operationTimeoutMs,
    maxInputBytes,
    maxOutputBytes,
    maxStderrBytes,
  });
  const options: StdioMcpClientOptions = Object.freeze({
    id,
    displayName,
    command,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    env: Object.freeze(environment),
    allowedTools,
    operationTimeoutMs,
    maxInputBytes,
    maxOutputBytes,
    maxStderrBytes,
  });
  const descriptor = Object.freeze({
    id,
    displayName,
    executionDigest: digestJson({
      command,
      args,
      ...(cwd === undefined ? {} : { cwd }),
      passEnvironment,
    } as unknown as JsonValue),
    passEnvironment,
    allowedTools,
    operationTimeoutMs,
    maxInputBytes,
    maxOutputBytes,
    maxStderrBytes,
    trust: "quarantined",
    authority: "observation-only",
  }) as unknown as JsonValue;
  return { raw: normalizedRaw, options, descriptor };
}

function resolveCall(rawValue: unknown, index: number, servers: ReadonlyMap<string, RawServer>): SealedMcpWitnessCall {
  const label = `MCP call ${index}`;
  const raw = object(rawValue, label) as unknown as RawCall & Record<string, unknown>;
  exactKeys(raw, ["id", "serverId", "tool", "arguments", "timeoutMs"], label);
  const id = identifier(raw.id, `${label}.id`);
  const serverId = identifier(raw.serverId, `${label}.serverId`);
  const server = servers.get(serverId);
  if (!server) throw new TypeError(`${label} names unknown server ${serverId}`);
  const tool = boundedString(raw.tool, `${label}.tool`, 256);
  if (!server.allowedTools.includes(tool)) throw new TypeError(`${label} tool ${tool} is not explicitly allowlisted by ${serverId}`);
  const args = jsonArguments(raw.arguments, `${label}.arguments`);
  const timeoutMs = optionalPositiveInteger(raw.timeoutMs, server.operationTimeoutMs ?? 10_000, `${label}.timeoutMs`, 600_000);
  return Object.freeze({ id, serverId, tool, args, timeoutMs });
}

export function emptyMcpWitnesses(): LoadedMcpWitnesses {
  const descriptor = Object.freeze({
    protocol: MCP_WITNESS_PROTOCOL,
    servers: Object.freeze([]),
    calls: Object.freeze([]),
  }) as unknown as JsonValue;
  return Object.freeze({ adapters: Object.freeze([]), calls: Object.freeze([]), descriptor, digest: digestJson(descriptor) });
}

/**
 * Loads operator-owned MCP witnesses. Tool discovery never adds authority: both
 * executable servers and exact calls are fixed before Cast and become public
 * policy provenance. Credential values are passed through a named environment
 * allowlist and are deliberately absent from the descriptor.
 */
export function loadMcpWitnesses(
  env: NodeJS.ProcessEnv = process.env,
  projectRoot = process.cwd(),
): LoadedMcpWitnesses {
  const configuredPath = env.JEVYR_MCP_WITNESSES_FILE?.trim();
  if (!configuredPath) return emptyMcpWitnesses();
  const path = resolve(projectRoot, configuredPath);
  const root = object(parseJsonBytes(readFileSync(path), "MCP witness configuration"), "MCP witness configuration");
  exactKeys(root, ["protocol", "servers", "calls"], "MCP witness configuration");
  if (root.protocol !== MCP_WITNESS_PROTOCOL) throw new TypeError(`MCP witness configuration protocol must be ${MCP_WITNESS_PROTOCOL}`);
  if (!Array.isArray(root.servers) || root.servers.length > MAX_SERVERS) {
    throw new TypeError(`MCP witness configuration supports at most ${MAX_SERVERS} servers`);
  }
  if (!Array.isArray(root.calls) || root.calls.length > MAX_CALLS) {
    throw new TypeError(`MCP witness configuration supports at most ${MAX_CALLS} calls`);
  }
  const baseDirectory = dirname(path);
  const normalizedServers = root.servers.map((server, index) => resolveServer(server, index, baseDirectory, env));
  const ids = normalizedServers.map(({ options }) => options.id);
  if (new Set(ids).size !== ids.length) throw new TypeError("MCP server ids must be unique");
  const rawById = new Map<string, RawServer>(normalizedServers.map(({ raw }) => [raw.id, raw]));
  const calls = Object.freeze(root.calls.map((call, index) => resolveCall(call, index, rawById)));
  if (new Set(calls.map((call) => call.id)).size !== calls.length) throw new TypeError("MCP call ids must be unique");
  const descriptor = Object.freeze({
    protocol: MCP_WITNESS_PROTOCOL,
    servers: Object.freeze(normalizedServers.map(({ descriptor }) => descriptor)),
    calls: Object.freeze(calls.map((call) => ({
      id: call.id,
      serverId: call.serverId,
      tool: call.tool,
      argumentsDigest: digestJson(call.args as unknown as JsonValue),
      timeoutMs: call.timeoutMs,
      trust: "quarantined",
      authority: "observation-only",
    }))),
  }) as unknown as JsonValue;
  return Object.freeze({
    adapters: Object.freeze(normalizedServers.map(({ options }) => new QuarantinedStdioMcpAdapter(options))),
    calls,
    descriptor,
    digest: digestJson(descriptor),
  });
}
