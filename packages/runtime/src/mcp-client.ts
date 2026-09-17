import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { parseJsonBytes } from "@jevyr/core";
import type { CapabilityCard, ProbeResult, ToolAdapter, ToolInvocation, ToolObservation } from "./contracts.js";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_INPUT_BYTES = 256 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_MAX_LIST_PAGES = 8;
const DEFAULT_MAX_TOOLS = 256;
const DEFAULT_SHUTDOWN_GRACE_MS = 250;
const SERVER_TO_CLIENT_REQUESTS = new Set(["roots/list", "sampling/createMessage", "elicitation/create"]);

type JsonRpcId = string | number | null;
type JsonObject = Record<string, unknown>;

export type McpBoundaryErrorCode =
  | "aborted"
  | "input-limit"
  | "id-mismatch"
  | "invalid-config"
  | "malformed-message"
  | "output-limit"
  | "protocol-mismatch"
  | "remote-error"
  | "server-request"
  | "spawn-failed"
  | "timeout"
  | "tool-not-allowlisted"
  | "tool-not-discovered"
  | "transport-closed"
  | "unexpected-response";

export class McpBoundaryError extends Error {
  readonly code: McpBoundaryErrorCode;

  constructor(code: McpBoundaryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "McpBoundaryError";
    this.code = code;
  }
}

export interface StdioMcpClientOptions {
  readonly id: string;
  readonly displayName: string;
  /** Executed directly with shell=false. Prefer an absolute executable path. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** The child's complete environment. The parent environment is never inherited. */
  readonly env?: Readonly<Record<string, string>>;
  /** Required even when empty. Discovery never grants execution authority. */
  readonly allowedTools: readonly string[];
  readonly protocolVersion?: string;
  readonly operationTimeoutMs?: number;
  /** Maximum bytes in any client JSON-RPC line, including tool arguments. */
  readonly maxInputBytes?: number;
  /** Maximum cumulative stdout bytes accepted during one process lifecycle. */
  readonly maxOutputBytes?: number;
  /** Maximum cumulative stderr bytes accepted during one process lifecycle. */
  readonly maxStderrBytes?: number;
  readonly maxListPages?: number;
  readonly maxTools?: number;
  readonly shutdownGraceMs?: number;
}

export interface QuarantinedMcpToolMetadata {
  readonly serverId: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly schemaDigest: `sha256:${string}`;
  readonly allowlisted: boolean;
  readonly trust: "quarantined";
  readonly authority: "observation-only";
}

interface NormalizedOptions {
  readonly id: string;
  readonly displayName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly allowedTools: ReadonlySet<string>;
  readonly protocolVersion: string;
  readonly operationTimeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
  readonly maxStderrBytes: number;
  readonly maxListPages: number;
  readonly maxTools: number;
  readonly shutdownGraceMs: number;
}

interface InitializedServer {
  readonly protocolVersion: string;
  readonly name?: string;
  readonly version?: string;
}

interface PendingRequest {
  readonly id: number;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new McpBoundaryError("invalid-config", `${name} must be a positive safe integer.`);
  }
  return value;
}

function validToolName(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeOptions(options: StdioMcpClientOptions): NormalizedOptions {
  if (!options.id.trim() || !options.displayName.trim() || !options.command.trim()) {
    throw new McpBoundaryError("invalid-config", "MCP id, displayName, and command are required.");
  }
  const allowedTools = new Set<string>();
  for (const tool of options.allowedTools) {
    if (!validToolName(tool)) throw new McpBoundaryError("invalid-config", `Invalid allowlisted MCP tool name: ${tool}`);
    if (allowedTools.has(tool)) throw new McpBoundaryError("invalid-config", `Duplicate allowlisted MCP tool: ${tool}`);
    allowedTools.add(tool);
  }
  const protocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
  if (!protocolVersion || protocolVersion.length > 64) {
    throw new McpBoundaryError("invalid-config", "protocolVersion must contain 1-64 characters.");
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (!name || name.includes("=") || name.includes("\u0000") || value.includes("\u0000")) {
      throw new McpBoundaryError("invalid-config", `Invalid explicit environment entry: ${name}`);
    }
    env[name] = value;
  }
  return {
    id: options.id,
    displayName: options.displayName,
    command: options.command,
    args: Object.freeze([...(options.args ?? [])]),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: Object.freeze(env),
    allowedTools,
    protocolVersion,
    operationTimeoutMs: positiveInteger(options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS, "operationTimeoutMs"),
    maxInputBytes: positiveInteger(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, "maxInputBytes"),
    maxOutputBytes: positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes"),
    maxStderrBytes: positiveInteger(options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES, "maxStderrBytes"),
    maxListPages: positiveInteger(options.maxListPages ?? DEFAULT_MAX_LIST_PAGES, "maxListPages"),
    maxTools: positiveInteger(options.maxTools ?? DEFAULT_MAX_TOOLS, "maxTools"),
    shutdownGraceMs: positiveInteger(options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, "shutdownGraceMs"),
  };
}

function errorFrom(reason: unknown): McpBoundaryError {
  if (reason instanceof McpBoundaryError) return reason;
  if (reason instanceof Error && reason.name === "AbortError") {
    return new McpBoundaryError("aborted", "MCP operation was aborted.", { cause: reason });
  }
  return new McpBoundaryError("transport-closed", reason instanceof Error ? reason.message : String(reason), {
    ...(reason instanceof Error ? { cause: reason } : {}),
  });
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

class StdioJsonRpcSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = Buffer.alloc(0);
  private stdoutBytes = 0;
  private stderrBytes = 0;
  private nextId = 1;
  private pending: PendingRequest | undefined;
  private terminalError: McpBoundaryError | undefined;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private resolveClosed!: () => void;

  constructor(private readonly options: NormalizedOptions) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.child = spawn(options.command, [...options.args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    this.child.on("error", (cause) => {
      this.fail(new McpBoundaryError("spawn-failed", `Unable to start MCP server: ${cause.message}`, { cause }), true);
    });
    this.child.on("close", () => {
      this.closed = true;
      if (this.pending) {
        this.rejectPending(
          this.terminalError ?? new McpBoundaryError("transport-closed", "MCP server closed before replying."),
        );
      }
      this.resolveClosed();
    });
  }

  private onStdout(chunk: Buffer): void {
    if (this.terminalError) return;
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.options.maxOutputBytes) {
      this.fail(
        new McpBoundaryError(
          "output-limit",
          `MCP stdout exceeded the ${this.options.maxOutputBytes}-byte lifecycle limit.`,
        ),
        true,
      );
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
    if (this.stdoutBuffer.length > this.options.maxOutputBytes) {
      this.fail(new McpBoundaryError("output-limit", "MCP response line exceeded the output limit."), true);
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
      if (line.length === 0) continue;
      this.receive(line);
      if (this.terminalError) return;
    }
  }

  private onStderr(chunk: Buffer): void {
    if (this.terminalError) return;
    this.stderrBytes += chunk.length;
    if (this.stderrBytes > this.options.maxStderrBytes) {
      this.fail(
        new McpBoundaryError(
          "output-limit",
          `MCP stderr exceeded the ${this.options.maxStderrBytes}-byte lifecycle limit.`,
        ),
        true,
      );
    }
  }

  private receive(line: Uint8Array): void {
    let raw: unknown;
    try {
      raw = parseJsonBytes(line, "MCP server response");
    } catch (cause) {
      this.fail(new McpBoundaryError("malformed-message", "MCP emitted malformed JSON.", { cause }), true);
      return;
    }
    const message = object(raw);
    if (!message || message.jsonrpc !== "2.0") {
      this.fail(new McpBoundaryError("malformed-message", "MCP message is not a JSON-RPC 2.0 object."), true);
      return;
    }
    if (typeof message.method === "string") {
      const hasId = Object.prototype.hasOwnProperty.call(message, "id");
      if (hasId || SERVER_TO_CLIENT_REQUESTS.has(message.method)) {
        if (hasId && (typeof message.id === "string" || typeof message.id === "number" || message.id === null)) {
          void this.write({
            jsonrpc: "2.0",
            id: message.id as JsonRpcId,
            error: { code: -32601, message: "Jevyr rejects server-to-client requests." },
          }).catch(() => undefined);
        }
        this.fail(
          new McpBoundaryError("server-request", `MCP server attempted forbidden request: ${message.method}`),
          true,
        );
      }
      // Valid server notifications are ignored. They cannot steer the sealed run.
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, "id")) {
      this.fail(new McpBoundaryError("malformed-message", "MCP response has no JSON-RPC id."), true);
      return;
    }
    if (!this.pending) {
      this.fail(new McpBoundaryError("unexpected-response", "MCP emitted a response with no pending request."), true);
      return;
    }
    if (message.id !== this.pending.id) {
      this.fail(
        new McpBoundaryError(
          "id-mismatch",
          `MCP response id ${String(message.id)} does not match pending id ${this.pending.id}.`,
        ),
        true,
      );
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(message, "result");
    const hasError = Object.prototype.hasOwnProperty.call(message, "error");
    if (hasResult === hasError) {
      this.fail(
        new McpBoundaryError("malformed-message", "MCP response must contain exactly one of result or error."),
        true,
      );
      return;
    }
    if (hasError) {
      const remote = object(message.error);
      if (!remote || typeof remote.code !== "number" || typeof remote.message !== "string") {
        this.fail(new McpBoundaryError("malformed-message", "MCP error response is malformed."), true);
        return;
      }
      this.rejectPending(
        new McpBoundaryError("remote-error", `MCP error ${remote.code}: ${remote.message.slice(0, 1_000)}`),
      );
      return;
    }
    const pending = this.pending;
    this.pending = undefined;
    pending.cleanup();
    pending.resolve(message.result);
  }

  private rejectPending(reason: unknown): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    pending.cleanup();
    pending.reject(reason);
  }

  private fail(error: McpBoundaryError, terminate: boolean): void {
    if (this.terminalError) return;
    this.terminalError = error;
    this.rejectPending(error);
    if (terminate && !this.closed) this.child.kill("SIGTERM");
  }

  private async write(message: JsonObject): Promise<void> {
    if (this.terminalError) throw this.terminalError;
    const serialized = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > this.options.maxInputBytes) {
      throw new McpBoundaryError(
        "input-limit",
        `MCP request is ${bytes} bytes; the configured limit is ${this.options.maxInputBytes}.`,
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(serialized, "utf8", (cause) => {
        if (cause) reject(new McpBoundaryError("transport-closed", `Unable to write MCP request: ${cause.message}`, { cause }));
        else resolve();
      });
    });
  }

  async notify(method: string, params: JsonObject): Promise<void> {
    await this.write({ jsonrpc: "2.0", method, params });
  }

  async request(method: string, params: JsonObject, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.pending) throw new McpBoundaryError("invalid-config", "Concurrent MCP requests are not supported.");
    if (this.terminalError) throw this.terminalError;
    if (signal?.aborted) throw new McpBoundaryError("aborted", "MCP operation was aborted before request dispatch.");
    const id = this.nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new McpBoundaryError("timeout", `MCP ${method} exceeded ${timeoutMs} ms.`), true);
      }, timeoutMs);
      timer.unref();
      const onAbort = (): void => {
        this.fail(new McpBoundaryError("aborted", `MCP ${method} was aborted.`), true);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      this.pending = { id, resolve, reject, cleanup };
      void this.write({ jsonrpc: "2.0", id, method, params }).catch((cause: unknown) => {
        this.fail(errorFrom(cause), true);
      });
    });
  }

  assertHealthy(): void {
    if (this.terminalError) throw this.terminalError;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.child.stdin.destroyed) this.child.stdin.end();
    await Promise.race([this.closedPromise, waitFor(this.options.shutdownGraceMs)]);
    if (this.closed) return;
    this.child.kill("SIGTERM");
    await Promise.race([this.closedPromise, waitFor(this.options.shutdownGraceMs)]);
    if (this.closed) return;
    this.child.kill("SIGKILL");
    await Promise.race([this.closedPromise, waitFor(this.options.shutdownGraceMs)]);
    if (!this.closed) {
      this.fail(new McpBoundaryError("transport-closed", "MCP server did not terminate after transport shutdown."), false);
    }
  }
}

function remaining(deadline: number): number {
  const value = Math.ceil(deadline - performance.now());
  if (value <= 0) throw new McpBoundaryError("timeout", "MCP lifecycle exhausted its operation deadline.");
  return value;
}

function readServerInfo(result: unknown, expectedProtocol: string): InitializedServer {
  const body = object(result);
  const capabilities = object(body?.capabilities);
  if (!body || typeof body.protocolVersion !== "string" || !capabilities) {
    throw new McpBoundaryError("malformed-message", "MCP initialize result is malformed.");
  }
  if (body.protocolVersion !== expectedProtocol) {
    throw new McpBoundaryError(
      "protocol-mismatch",
      `MCP server selected ${body.protocolVersion}; Jevyr configured ${expectedProtocol}.`,
    );
  }
  if (!object(capabilities.tools)) {
    throw new McpBoundaryError("protocol-mismatch", "MCP server did not declare a tools capability.");
  }
  const serverInfo = object(body.serverInfo);
  return {
    protocolVersion: body.protocolVersion,
    ...(typeof serverInfo?.name === "string" ? { name: serverInfo.name.slice(0, 256) } : {}),
    ...(typeof serverInfo?.version === "string" ? { version: serverInfo.version.slice(0, 128) } : {}),
  };
}

function readToolMetadata(
  raw: unknown,
  options: NormalizedOptions,
): Omit<QuarantinedMcpToolMetadata, "allowlisted"> & { readonly allowlisted: boolean } {
  const tool = object(raw);
  const schema = object(tool?.inputSchema);
  if (!tool || typeof tool.name !== "string" || !validToolName(tool.name) || !schema) {
    throw new McpBoundaryError("malformed-message", "MCP tools/list contained malformed tool metadata.");
  }
  const serializedSchema = JSON.stringify(schema);
  return Object.freeze({
    serverId: options.id,
    name: tool.name,
    ...(typeof tool.title === "string" ? { title: tool.title.slice(0, 512) } : {}),
    ...(typeof tool.description === "string" ? { description: tool.description.slice(0, 4_096) } : {}),
    inputSchema: schema,
    schemaDigest: sha256(serializedSchema),
    allowlisted: options.allowedTools.has(tool.name),
    trust: "quarantined",
    authority: "observation-only",
  });
}

function validateCallResult(result: unknown): JsonObject {
  const body = object(result);
  if (!body || !Array.isArray(body.content)) {
    throw new McpBoundaryError("malformed-message", "MCP tools/call result must contain a content array.");
  }
  if (body.isError !== undefined && typeof body.isError !== "boolean") {
    throw new McpBoundaryError("malformed-message", "MCP tools/call isError must be boolean when present.");
  }
  for (const item of body.content) {
    const content = object(item);
    if (!content || typeof content.type !== "string") {
      throw new McpBoundaryError("malformed-message", "MCP tools/call content item is malformed.");
    }
  }
  return body;
}

/**
 * A lifecycle-per-operation MCP client. The child is initialized, queried, and
 * closed for every discovery or tool call. Server output remains quarantined and
 * is returned only as ToolObservation; it is never an assay or verdict.
 */
export class QuarantinedStdioMcpAdapter implements ToolAdapter {
  readonly capability: CapabilityCard;
  private readonly options: NormalizedOptions;

  constructor(options: StdioMcpClientOptions) {
    this.options = normalizeOptions(options);
    this.capability = Object.freeze({
      id: this.options.id,
      kind: "tool",
      displayName: this.options.displayName,
      version: "jevyr.mcp-stdio-client/1",
      transport: "process",
      trust: "quarantined",
      modalities: ["text", "structured-data"] as const,
      // A stdio boundary does not constrain what the child itself can reach.
      network: "unrestricted",
      canExecuteTools: true,
      deterministic: false,
      limits: {
        lifecycle: "one-shot-per-operation",
        allowedToolCount: this.options.allowedTools.size,
        maxInputBytes: this.options.maxInputBytes,
        maxOutputBytes: this.options.maxOutputBytes,
        maxStderrBytes: this.options.maxStderrBytes,
        operationTimeoutMs: this.options.operationTimeoutMs,
      },
    });
  }

  private async initialize(session: StdioJsonRpcSession, deadline: number, signal?: AbortSignal): Promise<InitializedServer> {
    const result = await session.request(
      "initialize",
      {
        protocolVersion: this.options.protocolVersion,
        capabilities: {},
        clientInfo: { name: "jevyr-quarantined-mcp-client", version: "0.1.0" },
      },
      remaining(deadline),
      signal,
    );
    const server = readServerInfo(result, this.options.protocolVersion);
    await session.notify("notifications/initialized", {});
    return server;
  }

  private async listTools(
    session: StdioJsonRpcSession,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<readonly QuarantinedMcpToolMetadata[]> {
    const tools: QuarantinedMcpToolMetadata[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < this.options.maxListPages; page += 1) {
      const result = await session.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        remaining(deadline),
        signal,
      );
      const body = object(result);
      if (!body || !Array.isArray(body.tools)) {
        throw new McpBoundaryError("malformed-message", "MCP tools/list result is malformed.");
      }
      for (const raw of body.tools) {
        const metadata = readToolMetadata(raw, this.options);
        if (names.has(metadata.name)) {
          throw new McpBoundaryError("malformed-message", `MCP tools/list repeated tool name: ${metadata.name}`);
        }
        names.add(metadata.name);
        tools.push(metadata);
        if (tools.length > this.options.maxTools) {
          throw new McpBoundaryError("output-limit", `MCP server exposed more than ${this.options.maxTools} tools.`);
        }
      }
      if (body.nextCursor === undefined) return Object.freeze(tools);
      if (typeof body.nextCursor !== "string" || body.nextCursor.length === 0 || body.nextCursor.length > 1_024) {
        throw new McpBoundaryError("malformed-message", "MCP tools/list returned an invalid nextCursor.");
      }
      if (cursors.has(body.nextCursor)) {
        throw new McpBoundaryError("malformed-message", "MCP tools/list repeated a pagination cursor.");
      }
      cursors.add(body.nextCursor);
      cursor = body.nextCursor;
    }
    throw new McpBoundaryError("output-limit", `MCP tools/list exceeded ${this.options.maxListPages} pages.`);
  }

  private async withSession<T>(
    timeoutMs: number,
    signal: AbortSignal | undefined,
    operation: (
      session: StdioJsonRpcSession,
      deadline: number,
      server: InitializedServer,
    ) => Promise<T>,
  ): Promise<T> {
    if (signal?.aborted) throw new McpBoundaryError("aborted", "MCP operation was aborted before process start.");
    const session = new StdioJsonRpcSession(this.options);
    const deadline = performance.now() + timeoutMs;
    let completion: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };
    try {
      const server = await this.initialize(session, deadline, signal);
      const value = await operation(session, deadline, server);
      session.assertHealthy();
      completion = { ok: true, value };
    } catch (error) {
      completion = { ok: false, error };
    } finally {
      await session.close();
    }
    if (!completion.ok) throw completion.error;
    // Catch protocol violations emitted after the expected response but before EOF.
    session.assertHealthy();
    return completion.value;
  }

  async discoverTools(signal?: AbortSignal): Promise<readonly QuarantinedMcpToolMetadata[]> {
    return await this.withSession(this.options.operationTimeoutMs, signal, async (session, deadline) => {
      return await this.listTools(session, deadline, signal);
    });
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    try {
      const discovered = await this.discoverTools(signal);
      return {
        available: true,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        version: this.options.protocolVersion,
        detail: `Discovered ${discovered.length} quarantined MCP tool(s); ${discovered.filter((tool) => tool.allowlisted).length} explicitly allowlisted.`,
      };
    } catch (reason) {
      const error = errorFrom(reason);
      return {
        available: false,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        detail: `${error.code}: ${error.message}`,
      };
    }
  }

  async execute(invocation: ToolInvocation): Promise<ToolObservation> {
    const startedAt = new Date().toISOString();
    const baseMetadata = {
      serverId: this.options.id,
      tool: invocation.tool,
      trust: "quarantined",
      authority: "observation-only",
      admissibleAsProof: false,
      canAuthorVerdict: false,
      lifecycle: "one-shot-per-operation",
    } as const;
    try {
      if (!this.options.allowedTools.has(invocation.tool)) {
        throw new McpBoundaryError(
          "tool-not-allowlisted",
          `MCP tool ${invocation.tool} is not in the explicit allowlist.`,
        );
      }
      let serializedArguments: string;
      try {
        serializedArguments = JSON.stringify(invocation.args);
      } catch (cause) {
        throw new McpBoundaryError("input-limit", "MCP tool arguments are not JSON serializable.", { cause });
      }
      if (Buffer.byteLength(serializedArguments, "utf8") > this.options.maxInputBytes) {
        throw new McpBoundaryError(
          "input-limit",
          `MCP tool arguments exceed the ${this.options.maxInputBytes}-byte input limit.`,
        );
      }
      const timeoutMs = positiveInteger(invocation.timeoutMs, "invocation.timeoutMs");
      const result = await this.withSession(timeoutMs, invocation.signal, async (session, deadline, server) => {
        const discovered = await this.listTools(session, deadline, invocation.signal);
        const metadata = discovered.find((tool) => tool.name === invocation.tool);
        if (!metadata) {
          throw new McpBoundaryError("tool-not-discovered", `Allowlisted MCP tool ${invocation.tool} was not discovered.`);
        }
        const raw = await session.request(
          "tools/call",
          { name: invocation.tool, arguments: invocation.args },
          remaining(deadline),
          invocation.signal,
        );
        return { body: validateCallResult(raw), metadata, server };
      });
      const encoded = JSON.stringify(result.body);
      const isError = result.body.isError === true;
      return {
        invocationId: invocation.invocationId,
        status: isError ? "failed" : "observed",
        summary: isError
          ? `Quarantined MCP tool ${invocation.tool} reported an error; it has no proof authority.`
          : `Quarantined MCP tool ${invocation.tool} returned an observation with no proof authority.`,
        startedAt,
        finishedAt: new Date().toISOString(),
        stdout: encoded,
        metadata: {
          ...baseMetadata,
          protocolVersion: result.server.protocolVersion,
          ...(result.server.name === undefined ? {} : { serverName: result.server.name }),
          ...(result.server.version === undefined ? {} : { serverVersion: result.server.version }),
          schemaDigest: result.metadata.schemaDigest,
          resultDigest: sha256(encoded),
          resultIsError: isError,
        },
      };
    } catch (reason) {
      const error = errorFrom(reason);
      const notExecuted = ["input-limit", "invalid-config", "tool-not-allowlisted", "tool-not-discovered"].includes(error.code);
      return {
        invocationId: invocation.invocationId,
        status: notExecuted ? "not-executed" : "failed",
        summary: `Quarantined MCP invocation ${notExecuted ? "was refused" : "failed"}: ${error.message}`,
        startedAt,
        finishedAt: new Date().toISOString(),
        stderr: `${error.code}: ${error.message}`,
        metadata: {
          ...baseMetadata,
          boundaryError: error.code,
          outcome: notExecuted ? "not-executed" : "indeterminate",
        },
      };
    }
  }
}
