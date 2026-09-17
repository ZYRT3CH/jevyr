import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseJsonBytes } from "@jevyr/core";
import { assertCaseSubmission, type CaseIntent } from "@jevyr/protocol";
import type { McpCreateMessageParams, McpCreateMessageResult } from "@jevyr/runtime";
import type { DaemonRuntime } from "./runtime.js";

export const MAX_MCP_REQUEST_BYTES = 1_048_576;
export const MCP_PROTOCOL_VERSION = "2025-06-18";
export const MCP_COMPATIBLE_PROTOCOL_VERSIONS = Object.freeze(["2025-11-25", MCP_PROTOCOL_VERSION] as const);
export const MAX_CONCURRENT_MCP_REQUESTS = 32;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface JsonRpcSuccessResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly result: unknown;
}

interface JsonRpcErrorResponse {
  readonly jsonrpc: "2.0";
  readonly id: string | number;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse;

export interface McpClientRunContext {
  readonly client: { readonly name: string; readonly version: string; readonly protocolVersion: string };
  readonly sample: (params: McpCreateMessageParams, signal: AbortSignal) => Promise<McpCreateMessageResult>;
  readonly signal: AbortSignal;
  readonly onSealed?: (receipt: unknown) => void;
}

export type McpInputFrame =
  | { readonly bytes: Uint8Array; readonly error?: never }
  | { readonly bytes?: never; readonly error: string };

export interface McpBackend {
  /** Establish backend availability before accepting MCP traffic. */
  ready(): Promise<void>;
  /** The sole semantic write: one complete Case intent becomes one Cast. */
  cast(caseIntent: CaseIntent): Promise<unknown>;
  /** Optional one-transaction bridge to the originating MCP client's sampling capability. */
  runWithClientModel?(caseIntent: CaseIntent, context: McpClientRunContext): Promise<unknown>;
  status(caseId: string): Promise<unknown | undefined>;
  record(caseId: string): Promise<unknown | undefined>;
  /** Exact public terminal signature bundle, unavailable before durable closure. */
  terminalResult?(caseId: string): Promise<unknown | undefined>;
}

export interface McpTransport {
  readonly input: AsyncIterable<Uint8Array>;
  send(message: string): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  if (Object.keys(value).some((key) => !set.has(key))) throw new TypeError(`${label} contains an unknown field`);
}

function rpcId(value: unknown, allowNull: boolean): string | number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) {
    if (allowNull) return null;
    throw new TypeError("MCP response id cannot be null");
  }
  if (typeof value === "string") {
    if (value.length > 1_024) throw new TypeError("MCP string id is too long");
    return value;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("MCP id must be a string, safe integer, null, or absent");
  }
  return value;
}

function parseMcpRequestValue(value: Record<string, unknown>): JsonRpcRequest {
  exactKeys(value, ["jsonrpc", "id", "method", "params"], "MCP request");
  if (value.jsonrpc !== "2.0") throw new TypeError("MCP request jsonrpc must equal 2.0");
  if (typeof value.method !== "string" || value.method.length < 1 || value.method.length > 256) {
    throw new TypeError("MCP request method must be a bounded non-empty string");
  }
  const id = rpcId(value.id, true);
  if (value.params !== undefined && !record(value.params)) {
    throw new TypeError("MCP request params must be an object when present");
  }
  return Object.freeze({
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method: value.method,
    ...(value.params === undefined ? {} : { params: Object.freeze({ ...value.params }) }),
  });
}

/** Decode one JSON-RPC line without replacement UTF-8 or duplicate-key semantics. */
export function parseMcpRequestBytes(bytes: Uint8Array): JsonRpcRequest {
  const value = parseJsonBytes(bytes, "MCP request");
  if (!record(value)) throw new TypeError("MCP request must be an object");
  return parseMcpRequestValue(value);
}

/** Decode either direction of the connection without confusing responses for client requests. */
function parseMcpMessageBytes(bytes: Uint8Array): JsonRpcMessage {
  const value = parseJsonBytes(bytes, "MCP message");
  if (!record(value)) throw new TypeError("MCP message must be an object");
  if (Object.hasOwn(value, "method")) return parseMcpRequestValue(value);
  exactKeys(value, ["jsonrpc", "id", "result", "error"], "MCP response");
  if (value.jsonrpc !== "2.0") throw new TypeError("MCP response jsonrpc must equal 2.0");
  const id = rpcId(value.id, false);
  if (id === undefined || id === null) throw new TypeError("MCP response id is required");
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) throw new TypeError("MCP response must contain exactly one of result or error");
  if (hasResult) return Object.freeze({ jsonrpc: "2.0", id, result: value.result });
  if (!record(value.error)) throw new TypeError("MCP response error must be an object");
  exactKeys(value.error, ["code", "message", "data"], "MCP response error");
  if (!Number.isSafeInteger(value.error.code) || typeof value.error.message !== "string"
    || value.error.message.length > 4_096) {
    throw new TypeError("MCP response error must contain a bounded message and safe integer code");
  }
  return Object.freeze({
    jsonrpc: "2.0",
    id,
    error: Object.freeze({
      code: value.error.code as number,
      message: value.error.message,
      ...(value.error.data === undefined ? {} : { data: value.error.data }),
    }),
  });
}

/**
 * Split stdio by the LF byte before decoding. LF cannot occur inside a UTF-8
 * continuation sequence, so malformed input is isolated to one request and
 * cannot be replacement-decoded or smuggled across the next frame.
 */
export async function* readMcpInputFrames(
  input: AsyncIterable<Uint8Array>,
  maximumBytes = MAX_MCP_REQUEST_BYTES,
): AsyncGenerator<McpInputFrame> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("MCP maximum request bytes must be a positive safe integer");
  }
  let parts: Buffer[] = [];
  let size = 0;
  let discarding = false;

  const finish = (): Uint8Array => {
    let line = Buffer.concat(parts, size);
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.byteLength - 1);
    parts = [];
    size = 0;
    return line;
  };

  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) {
      yield Object.freeze({ error: "MCP stdio emitted a non-byte chunk" });
      continue;
    }
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const newline = bytes.indexOf(0x0a, offset);
      const end = newline === -1 ? bytes.byteLength : newline;
      const segment = bytes.subarray(offset, end);
      if (!discarding) {
        if (size + segment.byteLength > maximumBytes) {
          parts = [];
          size = 0;
          discarding = true;
          yield Object.freeze({ error: `MCP request exceeds ${maximumBytes} bytes` });
        } else if (segment.byteLength > 0) {
          parts.push(segment);
          size += segment.byteLength;
        }
      }
      if (newline === -1) break;
      if (!discarding) yield Object.freeze({ bytes: finish() });
      else {
        discarding = false;
        parts = [];
        size = 0;
      }
      offset = newline + 1;
    }
  }
  if (!discarding && size > 0) yield Object.freeze({ bytes: finish() });
}

function result(id: JsonRpcRequest["id"], value: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function failure(id: JsonRpcRequest["id"], code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function text(value: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const TOOLS = [
  {
    name: "jevyr_cast",
    description: "Cast one new sealed Jevyr case. This is the case's only semantic input.",
    inputSchema: {
      type: "object",
      required: ["impulse"],
      additionalProperties: false,
      properties: {
        impulse: { type: "string", minLength: 1, maxLength: 100000 },
        mode: { enum: ["auto", "audit", "design"] },
        subjects: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "locator"],
            properties: {
              id: { type: "string", minLength: 1 },
              kind: { enum: ["git", "directory", "file", "url", "text", "artifact"] },
              locator: { type: "string", minLength: 1 },
              revision: { type: "string", minLength: 1 },
              mediaType: { type: "string", minLength: 1 },
            },
          },
        },
        constraints: { type: "array", items: { type: "string", minLength: 1 } },
        requestedAssays: { type: "array", items: { type: "string", minLength: 1 } },
        control: { enum: ["sovereign", "juggler"] },
        privacy: { enum: ["full_case", "provider_scoped", "local_only"] },
        seed: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "jevyr_run",
    description: "Cast one sealed Jevyr case whose only Mind is the originating MCP client's sampling model, then remain active until authenticated terminal closure. MCP sampling is a legacy compatibility feature; the client chooses and reports the model.",
    inputSchema: {
      type: "object",
      required: ["impulse", "privacy"],
      additionalProperties: false,
      properties: {
        impulse: { type: "string", minLength: 1, maxLength: 100000 },
        mode: { enum: ["auto", "audit", "design"] },
        subjects: {
          type: "array",
          maxItems: 32,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "kind", "locator"],
            properties: {
              id: { type: "string", minLength: 1 },
              kind: { enum: ["git", "directory", "file", "url", "text", "artifact"] },
              locator: { type: "string", minLength: 1 },
              revision: { type: "string", minLength: 1 },
              mediaType: { type: "string", minLength: 1 },
            },
          },
        },
        constraints: { type: "array", items: { type: "string", minLength: 1 } },
        requestedAssays: { type: "array", items: { type: "string", minLength: 1 } },
        control: { enum: ["sovereign", "juggler"] },
        privacy: { enum: ["provider_scoped", "full_case"] },
        seed: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "jevyr_status",
    description: "Read live status and the latest monotonic event cursor for a sealed case.",
    inputSchema: {
      type: "object",
      required: ["caseId"],
      additionalProperties: false,
      properties: { caseId: { type: "string", minLength: 1, maxLength: 256 } },
    },
  },
  {
    name: "jevyr_record",
    description: "Read the signed Record after a case reaches SIGN.",
    inputSchema: {
      type: "object",
      required: ["caseId"],
      additionalProperties: false,
      properties: { caseId: { type: "string", minLength: 1, maxLength: 256 } },
    },
  },
] as const;

const PUBLIC_TOOLS = [
  { ...TOOLS[0], name: "submit", description: "Submit one complete new Case and return its Seal receipt. No post-seal semantic input exists." },
  { ...TOOLS[2], name: "status" },
  { ...TOOLS[3], name: "result", description: "Read the exact Seal, Record and terminal signature bundle after durable Case closure." },
  { ...TOOLS[0], name: "evaluate", description: "Submit one new Case, then wait at most 30 seconds for its terminal signature bundle. If still running, return its Seal receipt and status for later result reads. Never resubmits or continues a Case." },
] as const;

/** One Cast followed only by bounded reads. Timeout leaves the sealed Case running. */
export async function evaluateMcpCase(backend: McpBackend, intent: CaseIntent, signal: AbortSignal, maximumWaitMs = 30_000): Promise<unknown> {
  if (!Number.isSafeInteger(maximumWaitMs) || maximumWaitMs < 1 || maximumWaitMs > 30_000) throw new TypeError("MCP evaluation wait is outside its finite boundary");
  if (!backend.terminalResult) throw new TypeError("This MCP backend cannot return authenticated terminal results");
  signal.throwIfAborted();
  const receipt = await backend.cast(intent);
  if (!record(receipt) || typeof receipt.caseId !== "string" || !/^case_[a-f0-9]{16}$/u.test(receipt.caseId)) throw new TypeError("MCP Cast returned an invalid Case identity");
  const deadline = performance.now() + maximumWaitMs;
  let latestStatus: unknown = null;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const timer = new AbortController();
    try {
      const read = await Promise.race([
        Promise.all([backend.terminalResult(receipt.caseId), backend.status(receipt.caseId)]),
        delay(Math.max(1, deadline - performance.now()), undefined, { signal: AbortSignal.any([signal, timer.signal]) }),
      ]);
      if (read === undefined) break;
      latestStatus = read[1] ?? null;
      if (read[0] !== undefined) return { protocol: "jevyr.mcp-evaluation/1", state: "completed", receipt, result: read[0] };
    } finally { timer.abort(); }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(100, remaining), undefined, { signal });
  }
  return { protocol: "jevyr.mcp-evaluation/1", state: "pending", receipt, status: latestStatus, waitLimitMs: maximumWaitMs };
}

interface McpClientSession {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: (typeof MCP_COMPATIBLE_PROTOCOL_VERSIONS)[number];
  readonly sampling: boolean;
}

interface PendingSampling {
  readonly resolve: (value: McpCreateMessageResult) => void;
  readonly reject: (error: Error) => void;
  readonly signal: AbortSignal;
  readonly onAbort: () => void;
}

class McpClientSamplingError extends Error {
  constructor(readonly rpcCode: number) {
    super(`The MCP client declined or failed sampling (JSON-RPC ${rpcCode})`);
    this.name = "McpClientSamplingError";
  }
}

function idKey(id: JsonRpcRequest["id"]): string {
  if (id === null) return "null";
  return `${typeof id}:${String(id)}`;
}

function publicClientLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : fallback;
}

function initializeSession(params: Record<string, unknown> | undefined): McpClientSession {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : undefined;
  const protocolVersion = MCP_COMPATIBLE_PROTOCOL_VERSIONS.find((version) => version === requested)
    ?? MCP_PROTOCOL_VERSION;
  const capabilities = record(params?.capabilities) ? params.capabilities : undefined;
  const clientInfo = record(params?.clientInfo) ? params.clientInfo : undefined;
  return Object.freeze({
    name: publicClientLabel(clientInfo?.name, "unknown-client"),
    version: publicClientLabel(clientInfo?.version, "unknown-version"),
    protocolVersion,
    sampling: record(capabilities?.sampling),
  });
}

function assertSamplingParams(value: McpCreateMessageParams): McpCreateMessageParams {
  if (!record(value)) throw new TypeError("MCP sampling params must be an object");
  exactKeys(value, ["messages", "includeContext", "maxTokens", "temperature", "modelPreferences"], "MCP sampling params");
  if (value.includeContext !== "none") throw new TypeError("MCP client-model sampling must not include ambient host context");
  if (!Number.isSafeInteger(value.maxTokens) || value.maxTokens < 1 || value.maxTokens > 1_000_000) {
    throw new TypeError("MCP sampling maxTokens is outside the bounded compatibility envelope");
  }
  if (value.temperature !== undefined
    && (!Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) {
    throw new TypeError("MCP sampling temperature is outside the bounded compatibility envelope");
  }
  if (!Array.isArray(value.messages) || value.messages.length !== 1) {
    throw new TypeError("MCP client-model sampling requires exactly one prepared public message");
  }
  const message = value.messages[0];
  if (!record(message) || message.role !== "user" || !record(message.content)
    || message.content.type !== "text" || typeof message.content.text !== "string") {
    throw new TypeError("MCP client-model sampling accepts one public user text block only");
  }
  exactKeys(message, ["role", "content"], "MCP sampling message");
  exactKeys(message.content, ["type", "text"], "MCP sampling content");
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    throw new TypeError("MCP sampling params must be finite JSON");
  }
  if (bytes > MAX_MCP_REQUEST_BYTES) throw new TypeError("MCP sampling params exceed the MCP frame boundary");
  return structuredClone(value);
}

function requestProgressToken(request: JsonRpcRequest): string | number | undefined {
  const meta = record(request.params?._meta) ? request.params._meta : undefined;
  const token = meta?.progressToken;
  if (typeof token === "number" && Number.isSafeInteger(token)) return token;
  if (typeof token === "string" && token.length <= 1_024) return token;
  return undefined;
}

/**
 * Stateful 2025-era compatibility dispatcher. Sampling is legal only while the
 * originating jevyr_run tools/call is active; 2026-07-28 MRTR is not advertised.
 */
export async function serveMcpBackend(
  backend: McpBackend,
  transport: McpTransport,
): Promise<void> {
  await backend.ready();
  const connectionNonce = randomUUID();
  let samplingOrdinal = 0;
  let client: McpClientSession | undefined;
  let activeRun: { readonly key: string; readonly controller: AbortController } | undefined;
  const activeRequests = new Map<string, AbortController>();
  const requestTasks = new Set<Promise<void>>();
  const pendingSampling = new Map<string, PendingSampling>();

  const rejectPendingSampling = (error: Error): void => {
    for (const [key, pending] of pendingSampling) {
      pendingSampling.delete(key);
      pending.signal.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
  };

  const requestSampling = async (
    value: McpCreateMessageParams,
    signal: AbortSignal,
    runKey: string,
  ): Promise<McpCreateMessageResult> => {
    if (activeRun?.key !== runKey) throw new Error("The originating MCP tool transaction is no longer active");
    if (signal.aborted) throw new Error("MCP client sampling was aborted before transmission");
    if (pendingSampling.size >= MAX_CONCURRENT_MCP_REQUESTS) {
      throw new Error("The MCP sampling request limit is reached");
    }
    const params = assertSamplingParams(value);
    const id = `jevyr:sampling:${connectionNonce}:${++samplingOrdinal}`;
    const key = idKey(id);
    return await new Promise<McpCreateMessageResult>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = pendingSampling.get(key);
        if (!pending) return;
        pendingSampling.delete(key);
        signal.removeEventListener("abort", onAbort);
        reject(new Error("MCP client sampling was aborted"));
      };
      pendingSampling.set(key, { resolve, reject, signal, onAbort });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        transport.send(JSON.stringify({ jsonrpc: "2.0", id, method: "sampling/createMessage", params }));
      } catch (error) {
        pendingSampling.delete(key);
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("Could not send MCP sampling request"));
      }
    });
  };

  const handleRequest = async (request: JsonRpcRequest, controller: AbortController): Promise<void> => {
    const key = idKey(request.id);
    try {
      if (request.method === "initialize") {
        if (activeRun !== undefined) throw new TypeError("MCP cannot be reinitialized during an active client-model run");
        client = initializeSession(request.params);
        transport.send(
          result(request.id, {
            protocolVersion: client.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "jevyr", version: "0.1.0" },
            instructions: "submit and evaluate each create one sealed Case. status and result are read-only. evaluate waits at most 30 seconds after Cast, then returns the existing receipt if still pending. No continuation tool exists.",
          }),
        );
      } else if (request.method === "ping") {
        transport.send(result(request.id, {}));
      } else if (request.method === "tools/list") {
        transport.send(result(request.id, { tools: PUBLIC_TOOLS }));
      } else if (request.method === "tools/call") {
        const name = request.params?.name;
        const rawArguments = request.params?.arguments ?? {};
        if (!record(rawArguments)) throw new TypeError("Tool arguments must be an object");
        const args = rawArguments;
        if (name === "jevyr_cast" || name === "submit") {
          const submission: unknown = { protocol: "jevyr.case/1", case: args };
          assertCaseSubmission(submission);
          const receipt = await backend.cast(submission.case);
          transport.send(result(request.id, text(receipt)));
        } else if (name === "evaluate") {
          const submission: unknown = { protocol: "jevyr.case/1", case: args };
          assertCaseSubmission(submission);
          transport.send(result(request.id, text(await evaluateMcpCase(backend, submission.case, controller.signal))));
        } else if (name === "jevyr_run") {
          if (activeRun !== undefined) throw new TypeError("Only one jevyr_run may be active on an MCP connection");
          if (!client?.sampling) throw new TypeError("jevyr_run requires an initialized MCP client that declares capabilities.sampling");
          if (!backend.runWithClientModel) throw new Error("This Jevyr MCP backend does not provide the client-model bridge");
          const submission: unknown = { protocol: "jevyr.case/1", case: args };
          assertCaseSubmission(submission);
          if (submission.case.privacy !== "provider_scoped" && submission.case.privacy !== "full_case") {
            throw new TypeError("jevyr_run requires explicit provider_scoped or full_case privacy");
          }
          activeRun = Object.freeze({ key, controller });
          let samplingOpen = true;
          const progressToken = requestProgressToken(request);
          try {
            const completed = await backend.runWithClientModel(submission.case, {
              client: {
                name: client.name,
                version: client.version,
                protocolVersion: client.protocolVersion,
              },
              signal: controller.signal,
              sample: async (params, signal) => {
                if (!samplingOpen) throw new Error("MCP sampling cannot continue after jevyr_run completes");
                return await requestSampling(params, AbortSignal.any([controller.signal, signal]), key);
              },
              ...(progressToken === undefined
                ? {}
                : {
                    onSealed: (receipt: unknown): void => {
                      transport.send(JSON.stringify({
                        jsonrpc: "2.0",
                        method: "notifications/progress",
                        params: { progressToken, progress: 0, total: 1, message: JSON.stringify(receipt) },
                      }));
                    },
                  }),
            });
            samplingOpen = false;
            if (pendingSampling.size !== 0) throw new Error("Client-model run completed with unresolved sampling requests");
            transport.send(result(request.id, text(completed)));
          } finally {
            samplingOpen = false;
            if (activeRun?.key === key) activeRun = undefined;
          }
        } else if (name === "jevyr_status" || name === "status") {
          if (Object.keys(args).length !== 1 || typeof args.caseId !== "string"
            || args.caseId.length < 1 || args.caseId.length > 256) {
            throw new TypeError("jevyr_status requires exactly one bounded string caseId");
          }
          const status = await backend.status(args.caseId);
          if (!status) throw new Error("Case not found");
          transport.send(result(request.id, text(status)));
        } else if (name === "jevyr_record" || name === "result") {
          if (Object.keys(args).length !== 1 || typeof args.caseId !== "string"
            || args.caseId.length < 1 || args.caseId.length > 256) {
            throw new TypeError("jevyr_record requires exactly one bounded string caseId");
          }
          if (name === "result" && !backend.terminalResult) throw new TypeError("This MCP backend cannot return authenticated terminal results");
          const caseRecord = name === "result" ? await backend.terminalResult!(args.caseId) : await backend.record(args.caseId);
          if (!caseRecord) throw new Error("Record is not available");
          transport.send(result(request.id, text(caseRecord)));
        } else {
          transport.send(failure(request.id, -32602, "Unknown tool"));
        }
      } else {
        transport.send(failure(request.id, -32601, "Method not found"));
      }
    } catch (error) {
      transport.send(failure(
        request.id,
        controller.signal.aborted ? -32800 : error instanceof TypeError ? -32602 : -32603,
        controller.signal.aborted ? "Request cancelled" : error instanceof Error ? error.message : String(error),
      ));
    } finally {
      activeRequests.delete(key);
    }
  };

  for await (const frame of readMcpInputFrames(transport.input)) {
    if (frame.error !== undefined) {
      if (pendingSampling.size > 0) activeRun?.controller.abort(new Error("The MCP client returned an oversized sampling response"));
      transport.send(failure(null, -32700, "Parse error"));
      continue;
    }
    let message: JsonRpcMessage;
    try {
      message = parseMcpMessageBytes(frame.bytes);
    } catch (error) {
      if (pendingSampling.size > 0) activeRun?.controller.abort(new Error("The MCP client returned a malformed sampling response"));
      transport.send(error instanceof SyntaxError
        ? failure(null, -32700, "Parse error")
        : failure(null, -32600, "Invalid Request"));
      continue;
    }
    if (!("method" in message)) {
      const key = idKey(message.id);
      const pending = pendingSampling.get(key);
      if (!pending) {
        activeRun?.controller.abort(new Error("The MCP client returned an unknown or duplicate sampling response"));
        continue;
      }
      pendingSampling.delete(key);
      pending.signal.removeEventListener("abort", pending.onAbort);
      if ("error" in message) pending.reject(new McpClientSamplingError(message.error.code));
      else pending.resolve(message.result as McpCreateMessageResult);
      continue;
    }
    const request = message;
    if (request.id === undefined) {
      if (request.method === "notifications/cancelled") {
        const cancelledId = request.params?.requestId;
        if (typeof cancelledId === "string" || (typeof cancelledId === "number" && Number.isSafeInteger(cancelledId))) {
          activeRequests.get(idKey(cancelledId))?.abort(new Error("The MCP client cancelled the request"));
        }
      }
      continue;
    }
    const key = idKey(request.id);
    if (activeRequests.has(key)) {
      transport.send(failure(request.id, -32600, "A request with this id is already active"));
      continue;
    }
    if (activeRequests.size >= MAX_CONCURRENT_MCP_REQUESTS) {
      transport.send(failure(request.id, -32001, "The MCP concurrent request limit is reached"));
      continue;
    }
    const controller = new AbortController();
    activeRequests.set(key, controller);
    const task = handleRequest(request, controller).finally(() => requestTasks.delete(task));
    requestTasks.add(task);
    void task;
  }

  activeRun?.controller.abort(new Error("The MCP input stream closed during jevyr_run"));
  rejectPendingSampling(new Error("The MCP input stream closed during sampling"));
  await Promise.allSettled([...requestTasks]);
}

/** Standalone MCP owns a runtime and therefore requires exclusive repository access. */
export async function serveMcpStdio(runtime: DaemonRuntime): Promise<void> {
  await serveMcpBackend(
    {
      ready: async () => await runtime.ready(),
      cast: async (caseIntent) => (await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: caseIntent })).receipt,
      runWithClientModel: async (caseIntent, context) => await runtime.runWithClientModel(caseIntent, context),
      status: async (caseId) => await runtime.status(caseId),
      record: async (caseId) => await runtime.repository.record(caseId),
      terminalResult: async (caseId) => {
        const status = await runtime.repository.status(caseId);
        if (!status || !["terminated", "invalid"].includes(status.lifecycle)) return undefined;
        const [record, recordEnvelope, sealEnvelope, terminal, terminalEnvelope, trust] = await Promise.all([
          runtime.repository.record(caseId), runtime.repository.recordEnvelope(caseId), runtime.repository.sealEnvelope(caseId),
          runtime.repository.terminalReceipt(caseId), runtime.repository.terminalEnvelope(caseId), runtime.repository.publicTrustBundle(),
        ]);
        if (!record || !recordEnvelope || !sealEnvelope || !terminal || !terminalEnvelope) return undefined;
        return { protocol: "jevyr.mcp-result/1", seal: status.receipt, sealEnvelope, record, recordEnvelope, terminal, terminalEnvelope, trust };
      },
    },
    {
      input: process.stdin,
      send: (message) => process.stdout.write(`${message}\n`),
    },
  );
}
