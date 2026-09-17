import { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";
import { parseJsonBytes } from "@jevyr/core";
import { adapterCapabilitySnapshot, snapshotAdapterCapability } from "@jevyr/runtime";
import { OPENAPI } from "./openapi.js";
import { createDaemonRuntime, type DaemonRuntime, type DaemonRuntimeOptions } from "./runtime.js";
import { createReadinessReader, readSanitizedCapabilityProbe } from "./readiness.js";
import { MCP_CLIENT_RUN_PATH, serveClientModelRun } from "./mcp-client-run.js";
import { readPublicResponse } from "./public-responses.js";
import { parseMultipartCast, TransportError, waitForTransportClosure } from "./transports.js";
import { A2A_PREFIX, A2A_VERSION, a2aAgentCard, a2aTask, parseA2aCast, streamA2aTask } from "./a2a.js";
import { readGenomeLab } from "./genome-lab.js";
import { AirlockDraftStore, AirlockError, type AirlockDraft } from "./airlock.js";
import { createHttpAccess } from "./http-auth.js";
import { connectionObject, ConnectionSettingsError } from "./connection-profiles.js";
import { connectionRequestAccess } from "./connection-access.js";

export interface JevyrHttpOptions extends DaemonRuntimeOptions {
  readonly runtime?: DaemonRuntime;
  readonly maxBodyBytes?: number;
  readonly allowedOrigins?: readonly string[];
  /** Total time allowed to receive an ordinary bounded request body. */
  readonly requestBodyTimeoutMs?: number;
  /** Hard ceiling for the deliberately open MCP client-model duplex POST. */
  readonly clientModelTransportTimeoutMs?: number;
}

export interface JevyrHttpService {
  readonly fastify: FastifyInstance;
  readonly server: Server;
  readonly runtime: DaemonRuntime;
  listen(port?: number, host?: string): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
  }
}

const DEFAULT_REQUEST_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_MODEL_TRANSPORT_TIMEOUT_MS = 30 * 60_000;
const MAX_CLIENT_MODEL_TRANSPORT_TIMEOUT_MS = 24 * 60 * 60_000;

function boundedTimeout(value: number | undefined, fallback: number, name: string, maximum: number): number {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return timeout;
}

function json(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(encoded.byteLength),
    "cache-control": "no-store",
    ...headers,
  });
  response.end(encoded);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function localOrigin(origin: string): boolean {
  try {
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function applyCommonHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("cross-origin-resource-policy", "same-site");
  const origin = request.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || (localOrigin(origin) && isLoopbackAddress(request.socket.remoteAddress)))) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "origin");
    response.setHeader("access-control-allow-headers", "authorization,content-type,last-event-id,a2a-version");
    response.setHeader("access-control-allow-methods", "GET,POST,PUT,PATCH,OPTIONS");
    response.setHeader(
      "access-control-expose-headers",
      "x-jevyr-digest,content-length,content-type,content-disposition",
    );
  }
}

async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number,
  timeoutMs: number,
  mode: "json" | "cast" | "a2a" = "json",
): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !(mode === "cast" && contentType === "multipart/form-data")
    && !(mode === "a2a" && contentType === "application/a2a+json")) throw new HttpError(415, "Unsupported Cast Content-Type");
  const declaredHeader = request.headers["content-length"];
  if (declaredHeader !== undefined) {
    if (Array.isArray(declaredHeader) || !/^(?:0|[1-9][0-9]*)$/u.test(declaredHeader)) {
      throw new HttpError(400, "Content-Length must be one canonical non-negative integer");
    }
    const declared = Number(declaredHeader);
    if (!Number.isSafeInteger(declared)) throw new HttpError(413, "Request body is too large");
    if (declared > maxBytes) throw new HttpError(413, "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  const timedOut = Symbol("request-body-timeout");
  let deadline!: NodeJS.Timeout;
  const timeout = new Promise<typeof timedOut>((resolve) => {
    deadline = setTimeout(resolve, timeoutMs, timedOut);
    deadline.unref();
  });
  const iterator = request[Symbol.asyncIterator]();
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === timedOut) {
        // Stop applying backpressure so Node can discard any late bytes while
        // the 408 response closes this bounded public request cleanly.
        request.resume();
        throw new HttpError(408, "Request body was not received before its deadline", { connection: "close" });
      }
      if (next.done) break;
      const buffer = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
      size += buffer.byteLength;
      if (size > maxBytes) throw new HttpError(413, "Request body is too large");
      chunks.push(buffer);
    }
  } finally {
    clearTimeout(deadline);
  }
  if (contentType === "multipart/form-data") return parseMultipartCast(Buffer.concat(chunks), request.headers["content-type"]!);
  try {
    return parseJsonBytes(Buffer.concat(chunks), "Request body");
  } catch (error) {
    if (error instanceof Error && /not valid UTF-8/u.test(error.message)) {
      throw new HttpError(400, "Request body is not valid UTF-8");
    }
    throw new HttpError(400, "Request body is not valid JSON");
  }
}

function integer(value: string | null, fallback: number, minimum: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new HttpError(400, `Expected a canonical decimal integer from ${minimum} to ${maximum}`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new HttpError(400, `Expected an integer from ${minimum} to ${maximum}`);
  }
  return result;
}

function sequenceFromEventId(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new HttpError(400, "Last-Event-ID must be a canonical non-negative decimal sequence");
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result)) {
    throw new HttpError(400, "Last-Event-ID exceeds the safe event cursor range");
  }
  return result;
}

function exactQuery(url: URL, allowed: readonly string[]): void {
  const names = new Set(allowed);
  for (const key of url.searchParams.keys()) {
    if (!names.has(key)) throw new HttpError(400, `Unknown query parameter ${key}`);
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      throw new HttpError(400, `Query parameter ${key} must occur at most once`);
    }
  }
}

function pollingCursor(url: URL): number {
  const afterValue = url.searchParams.get("after");
  const cursorValue = url.searchParams.get("cursor");
  const after = afterValue === null ? undefined : integer(afterValue, 0, 0, Number.MAX_SAFE_INTEGER);
  const cursor = cursorValue === null ? undefined : integer(cursorValue, 0, 0, Number.MAX_SAFE_INTEGER);
  if (after !== undefined && cursor !== undefined && after !== cursor) {
    throw new HttpError(400, "after and cursor identify different event sequences");
  }
  return after ?? cursor ?? 0;
}

function sseCursor(request: IncomingMessage, url: URL): number {
  const lastEventHeader = request.headers["last-event-id"];
  if (Array.isArray(lastEventHeader)) {
    throw new HttpError(400, "Last-Event-ID must occur at most once");
  }
  const lastEventSequence = sequenceFromEventId(lastEventHeader);
  const querySequence = integer(url.searchParams.get("after"), 0, 0, Number.MAX_SAFE_INTEGER);
  // EventSource reuses its original URL but advances Last-Event-ID itself on
  // reconnect. The header must therefore supersede the initial query cursor.
  return lastEventSequence ?? querySequence;
}

/**
 * Writes one complete SSE frame without allowing Node's writable queue to grow
 * past its high-water mark. `true` means the frame entered a live response and
 * any reported backpressure subsequently drained; close/abort returns false.
 */
function writeSseFrame(
  response: ServerResponse,
  frame: string,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      response.removeListener("drain", onDrain);
      response.removeListener("close", onClose);
      response.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (accepted: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(accepted);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onAbort = (): void => finish(false);
    const onError = (error: Error): void => finish(false, error);

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted || response.destroyed || response.writableEnded) {
      finish(false);
      return;
    }
    try {
      if (response.write(frame)) finish(true);
      // A false result means the frame was queued, but the caller must not
      // enqueue another frame or advance its cursor until `drain` arrives.
    } catch (error) {
      finish(false, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function sse(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: DaemonRuntime,
  caseId: string,
  after: number,
): Promise<void> {
  const controller = new AbortController();
  const close = (): void => controller.abort();
  request.on("aborted", close);
  request.on("close", close);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let cursor = after;
  try {
    if (!await writeSseFrame(response, "retry: 1500\n\n", controller.signal)) return;
    while (!controller.signal.aborted) {
      const before = await runtime.status(caseId);
      if (before && (before.lifecycle === "terminated" || before.lifecycle === "invalid")) {
        if (cursor > before.lastSequence) throw new Error("SSE cursor moved beyond the terminal event ledger");
        if (cursor === before.lastSequence) {
          if (cursor > 0 && before.headDigest === null) throw new Error("Terminal status has no event head");
          break;
        }
      }
      const page = await runtime.events.wait(caseId, cursor, 15_000, controller.signal);
      if (before && page.events.some((event) =>
        event.caseDigest !== before.caseDigest || event.runDigest !== before.runDigest)) {
        throw new Error("SSE event page crossed the sealed Case or run boundary");
      }
      if (page.events.length === 0) {
        if (!await writeSseFrame(response, `: keepalive ${Date.now()}\n\n`, controller.signal)) break;
      } else {
        for (const event of page.events) {
          const accepted = await writeSseFrame(
            response,
            `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
            controller.signal,
          );
          if (!accepted) break;
          // The next page resumes after a frame only once its write has been
          // accepted and any high-water-mark pressure has drained.
          cursor = event.sequence;
        }
      }
      if (controller.signal.aborted || response.destroyed || response.writableEnded) break;
      const status = await runtime.status(caseId);
      if (status && (status.lifecycle === "terminated" || status.lifecycle === "invalid") && cursor >= status.lastSequence) break;
    }
  } finally {
    request.removeListener("aborted", close);
    request.removeListener("close", close);
    if (!response.destroyed && !response.writableEnded) response.end();
  }
}

export function createJevyrHttpService(options: JevyrHttpOptions = {}): JevyrHttpService {
  const access = createHttpAccess(options.env ?? process.env);
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > 64 * 1_048_576) {
    throw new RangeError("maxBodyBytes must be a positive safe integer no greater than 67108864");
  }
  const requestBodyTimeoutMs = boundedTimeout(
    options.requestBodyTimeoutMs,
    DEFAULT_REQUEST_BODY_TIMEOUT_MS,
    "requestBodyTimeoutMs",
    5 * 60_000,
  );
  const clientModelTransportTimeoutMs = boundedTimeout(
    options.clientModelTransportTimeoutMs,
    DEFAULT_CLIENT_MODEL_TRANSPORT_TIMEOUT_MS,
    "clientModelTransportTimeoutMs",
    MAX_CLIENT_MODEL_TRANSPORT_TIMEOUT_MS,
  );
  if (clientModelTransportTimeoutMs < requestBodyTimeoutMs) {
    throw new RangeError("clientModelTransportTimeoutMs cannot be less than requestBodyTimeoutMs");
  }
  const runtime = options.runtime ?? createDaemonRuntime(options);
  const capabilityAdapters = [...runtime.minds, runtime.forge];
  for (const mind of runtime.minds) snapshotAdapterCapability(mind);
  snapshotAdapterCapability(runtime.forge);
  const allowedOrigins = options.allowedOrigins ?? [];
  const sockets = new Set<Socket>();
  const readiness = createReadinessReader(runtime);
  const drafts = new AirlockDraftStore(runtime.repository.dataDir);
  const draftResponse = async (draft: AirlockDraft): Promise<unknown> => {
    if (draft.receipt && draft.receipt.policyDigest !== runtime.repository.policyDigest) {
      const [status, policy] = await Promise.all([runtime.repository.status(draft.receipt.caseId), runtime.repository.descriptor(draft.receipt.policyDigest)]);
      if (!status || !policy || policy.kind !== "policy") throw new Error("Sealed draft provenance is unavailable");
      const body = (policy.descriptor as { policy?: { mindCapabilities?: unknown[] } }).policy;
      return { ...draft, startup: { policyDigest: status.sealed.policyDigest, genomeDigest: status.sealed.genomeDigest,
        genomeVersion: status.sealed.genomeVersion, searchEnvelope: status.sealed.searchEnvelope,
        capabilities: body?.mindCapabilities ?? [], policy: policy.descriptor,
        subjectCapture: "Sealed subject bytes and this startup snapshot are immutable" } };
    }
    return { ...draft, startup: {
    ...runtime.previewAirlock(draft.choices),
    subjectCapture: "Subject bytes are captured at Seal; preview does not read files or contact providers",
    } };
  };
  let clientModelConnections = 0;

  // Node's requestTimeout covers the entire still-open request body. The MCP
  // bridge is intentionally duplex over one chunked POST, so it needs a finite
  // Case-scale ceiling. Ordinary public bodies retain their shorter independent
  // deadline in readJsonBody instead of inheriting this allowance.
  const fastify = Fastify({ bodyLimit: maxBodyBytes, logger: false, requestTimeout: clientModelTransportTimeoutMs });
  const server = fastify.server;
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    applyCommonHeaders(request, response, allowedOrigins);
    try {
      await runtime.ready();
      const url = new URL(request.url ?? "/", "http://jevyr.local");
      if (url.pathname.startsWith("/v1/settings/connections") && request.method === "OPTIONS") connectionRequestAccess(request, allowedOrigins, true);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname !== "/health" && !access.authorize(request.headers)) {
        request.resume();
        throw new HttpError(401, "Authentication required", { "www-authenticate": "Bearer realm=\"Jevyr\"" });
      }
      if (url.pathname === "/v1/settings/connections" || url.pathname === "/v1/settings/connections/models" || url.pathname === "/v1/settings/connections/mcp-test") {
        exactQuery(url, []);
        const canConfigure = connectionRequestAccess(request, allowedOrigins, request.method !== "GET");
        if (url.pathname === "/v1/settings/connections" && request.method === "GET") { json(response, 200, runtime.connections.view(canConfigure)); return; }
        if (url.pathname === "/v1/settings/connections" && request.method === "PUT") {
          const body = connectionObject(await readJsonBody(request, 32_768, requestBodyTimeoutMs), ["revision", "profile"]);
          runtime.connections.save(body.revision, body.profile); json(response, 200, runtime.connections.view(canConfigure)); return;
        }
        if (url.pathname.endsWith("/models") && request.method === "POST") {
          const body = connectionObject(await readJsonBody(request, 8_192, requestBodyTimeoutMs), ["connection"]);
          json(response, 200, await runtime.connections.models(body.connection)); return;
        }
        if (url.pathname.endsWith("/mcp-test") && request.method === "POST") {
          const body = connectionObject(await readJsonBody(request, 1_024, requestBodyTimeoutMs), ["serverId"]);
          json(response, 200, await runtime.connections.testMcp(body.serverId)); return;
        }
        throw new HttpError(405, "Method not allowed", { allow: url.pathname === "/v1/settings/connections" ? "GET,PUT" : "POST" });
      }
      const draftMatch = url.pathname.match(/^\/v1\/drafts(?:\/(draft_[a-f0-9]{32})(\/seal)?)?$/u);
      if (url.pathname === "/v1/reproductions") {
        exactQuery(url, []);
        if (request.method !== "POST") throw new HttpError(405, "A reproduction casts a new immutable Case", { allow: "POST" });
        const body = await readJsonBody(request, 256, requestBodyTimeoutMs);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join("\0") !== "seed\0sourceCaseId"
          || !/^case_[a-f0-9]{16}$/u.test(String((body as any).sourceCaseId)) || !["same", "new"].includes((body as any).seed)) throw new HttpError(400, "Reproduction accepts exactly sourceCaseId and seed: same or new");
        try {
          const created = await runtime.reproduceCase((body as any).sourceCaseId, (body as any).seed);
          json(response, 202, created.receipt, { location: `/v1/cases/${created.caseId}` });
        } catch (error) { throw new HttpError(409, error instanceof Error ? error.message : "The frozen source cannot be reproduced"); }
        return;
      }
      if (draftMatch) {
        exactQuery(url, []);
        try {
          const id = draftMatch[1];
          if (!id && request.method === "POST") {
            const draft = await drafts.create(await readJsonBody(request, maxBodyBytes, requestBodyTimeoutMs));
            json(response, 201, await draftResponse(draft), { location: `/v1/drafts/${draft.draftId}` });
          } else if (id && draftMatch[2] && request.method === "POST") {
            const body = await readJsonBody(request, 256, requestBodyTimeoutMs);
            if (!body || typeof body !== "object" || Array.isArray(body)
              || Object.keys(body).sort().join("\0") !== "policyDigest\0revision") throw new HttpError(400, "Seal requires exactly revision and the previewed policyDigest");
            const current = await drafts.read(id);
            const policyDigest = runtime.previewAirlock(current.choices).policyDigest;
            if ((body as Record<string, unknown>).policyDigest !== policyDigest) throw new HttpError(409, "Draft execution policy changed; review the draft again before sealing");
            const draft = await drafts.seal(id, { revision: (body as Record<string, unknown>).revision }, async (submission, choices) => await runtime.castAirlock(submission, choices, policyDigest));
            json(response, 202, await draftResponse(draft), { location: `/v1/cases/${draft.receipt!.caseId}` });
          } else if (id && !draftMatch[2] && request.method === "GET") {
            json(response, 200, await draftResponse(await drafts.read(id)));
          } else if (id && !draftMatch[2] && request.method === "PATCH") {
            const body = await readJsonBody(request, maxBodyBytes, requestBodyTimeoutMs);
            if (body && typeof body === "object" && Object.hasOwn(body, "choices")) runtime.previewAirlock((body as any).choices);
            json(response, 200, await draftResponse(await drafts.replace(id, body)));
          } else throw new HttpError(405, "Drafts support creation, revision replacement, inspection, and one Seal");
        } catch (error) {
          if (error instanceof AirlockError) throw new HttpError(error.status, error.message);
          throw error;
        }
        return;
      }
      if (url.pathname === MCP_CLIENT_RUN_PATH) {
        exactQuery(url, []);
        if (request.method !== "POST") throw new HttpError(405, "Client-model transport requires POST");
        if (clientModelConnections >= 8) throw new HttpError(429, "Client-model connection limit reached");
        clientModelConnections += 1;
        try {
          await serveClientModelRun(request, response, runtime);
        } finally {
          clientModelConnections -= 1;
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/") {
        json(response, 200, {
          protocol: "jevyr.daemon/1",
          name: "Jevyr",
          links: { health: "/health", readiness: "/v1/readiness", openapi: "/openapi.json", trust: "/v1/trust", cast: "/v1/cases" },
          semanticContinuation: false,
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { status: "ok", now: new Date().toISOString() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/openapi.json") {
        json(response, 200, OPENAPI);
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        const probes = await Promise.all(
          capabilityAdapters.map(async (adapter) => ({
            capability: adapterCapabilitySnapshot(adapter),
            probe: await readSanitizedCapabilityProbe(adapter),
          })),
        );
        json(response, 200, { protocol: "jevyr.capabilities/1", adapters: probes });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/readiness") {
        exactQuery(url, []);
        json(response, 200, await readiness());
        return;
      }
      if (url.pathname === "/v1/genome-lab") {
        if (request.method !== "GET") throw new HttpError(405, "Genome Lab is read-only", { allow: "GET" });
        exactQuery(url, []);
        json(response, 200, await readGenomeLab(runtime));
        return;
      }
      if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
        exactQuery(url, []);
        const address = server.address();
        const base = address && typeof address !== "string"
          ? `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}` : "http://127.0.0.1:4317";
        json(response, 200, a2aAgentCard(base));
        return;
      }
      if (url.pathname.startsWith(`${A2A_PREFIX}/`)) {
        if (request.headers["a2a-version"] !== A2A_VERSION) throw new HttpError(400, "VersionNotSupportedError: A2A-Version must equal 1.0");
        response.setHeader("a2a-version", A2A_VERSION);
        exactQuery(url, []);
        const send = url.pathname === `${A2A_PREFIX}/message:send`;
        const stream = url.pathname === `${A2A_PREFIX}/message:stream`;
        const get = url.pathname.match(/^\/a2a\/tasks\/(case_[a-f0-9]{16})$/u);
        const subscribe = url.pathname.match(/^\/a2a\/tasks\/(case_[a-f0-9]{16}):subscribe$/u);
        const cursorHeader = request.headers["last-event-id"];
        if (Array.isArray(cursorHeader)) throw new HttpError(400, "Last-Event-ID must occur at most once");
        const after = sequenceFromEventId(cursorHeader) ?? 0;
        if ((send || stream) && cursorHeader !== undefined) throw new HttpError(400, "New A2A Cast cannot carry an existing event cursor");
        let caseId: string;
        if (send || stream) {
          if (request.method !== "POST") throw new HttpError(405, "A2A Cast requires POST");
          const peerDispatch = request.headers["x-jevyr-peer-dispatch"];
          if (peerDispatch !== undefined && peerDispatch !== "one-shot") throw new HttpError(400, "Invalid peer dispatch boundary");
          if (peerDispatch !== undefined && runtime.minds.some((mind) => adapterCapabilitySnapshot(mind).transport === "a2a")) throw new HttpError(409, "Delegated A2A Cases require a leaf runtime without outbound peers");
          const parsed = parseA2aCast(await readJsonBody(request, maxBodyBytes, requestBodyTimeoutMs, "a2a"));
          const cast = await runtime.orchestrator.cast(parsed.submission);
          caseId = cast.caseId;
          if (send) {
            if (!parsed.returnImmediately) await waitForTransportClosure(runtime, caseId);
            json(response, 200, { task: await a2aTask(runtime, caseId) }, { "content-type": "application/a2a+json" });
            return;
          }
        } else if (get) {
          if (request.method !== "GET") throw new HttpError(405, "A2A task is read-only", { allow: "GET" });
          json(response, 200, await a2aTask(runtime, get[1]!), { "content-type": "application/a2a+json" });
          return;
        } else if (subscribe) {
          if (request.method !== "POST") throw new HttpError(405, "A2A SubscribeToTask requires POST");
          // Read-only subscription accepts no semantic body, even an otherwise valid Case.
          const value = await readJsonBody(request, 1_024, requestBodyTimeoutMs, "a2a");
          if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 0) throw new HttpError(400, "A2A subscription requires an empty JSON object");
          caseId = subscribe[1]!;
          const status = await runtime.status(caseId);
          if (!status) throw new HttpError(404, "TaskNotFoundError");
          if (status.lifecycle === "terminated" || status.lifecycle === "invalid") throw new HttpError(409, "UnsupportedOperationError: terminal tasks cannot be subscribed to");
        } else throw new HttpError(405, "UnsupportedOperationError: only Cast and read-only A2A progress are supported");
        if (after > await runtime.events.lastSequence(caseId)) throw new HttpError(409, "A2A event cursor is beyond the ledger");
        const controller = new AbortController();
        const close = (): void => controller.abort();
        request.on("aborted", close);
        response.on("close", close);
        response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" });
        try {
          await streamA2aTask(runtime, caseId, after, controller.signal, async (value, sequence) => await writeSseFrame(response, `${sequence === undefined ? "" : `id: ${sequence}\n`}data: ${JSON.stringify(value)}\n\n`, controller.signal));
        } finally {
          request.removeListener("aborted", close);
          response.removeListener("close", close);
          if (!response.destroyed && !response.writableEnded) response.end();
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/trust") {
        json(response, 200, await runtime.repository.publicTrustBundle());
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/cases") {
        const body = await readJsonBody(request, maxBodyBytes, requestBodyTimeoutMs, "cast");
        const status = await runtime.orchestrator.cast(body);
        json(response, 202, status.receipt, {
          location: `/v1/cases/${status.caseId}`,
          link: [
            `</v1/cases/${status.caseId}>; rel="status"`,
            `</v1/cases/${status.caseId}/events>; rel="monitor"`,
            `</v1/cases/${status.caseId}/events/stream>; rel="stream"`,
            `</v1/cases/${status.caseId}/record>; rel="record"`,
            `</v1/cases/${status.caseId}/record/envelope>; rel="describedby"`,
            `</v1/cases/${status.caseId}/terminal>; rel="closure"`,
            `</v1/cases/${status.caseId}/terminal/envelope>; rel="describedby"`,
            `</v1/cases/${status.caseId}/intent-contract>; rel="replay-contract"`,
            `</v1/cases/${status.caseId}/policy-descriptor>; rel="replay-policy"`,
            `</v1/trust>; rel="trust-anchor"`,
          ].join(", "),
        });
        return;
      }

      const abortMatch = url.pathname.match(/^\/(?:v1\/cases|runs)\/(case_[a-f0-9]{16})\/abort$/u);
      const attestationsMatch = url.pathname.match(/^\/v1\/cases\/(case_[a-f0-9]{16})\/attestations$/u);
      if (attestationsMatch) {
        exactQuery(url, []);
        if (request.method !== "GET") throw new HttpError(405, "Run attestations are immutable", { allow: "GET" });
        const attestations = await runtime.repository.runAttestations(attestationsMatch[1]!);
        if (!attestations) throw new HttpError(404, "Run attestations are unavailable for this Case");
        json(response, 200, attestations); return;
      }
      const sealedCaseMatch = url.pathname.match(/^\/v1\/cases\/(case_[a-f0-9]{16})\/sealed-case$/u);
      if (sealedCaseMatch) {
        exactQuery(url, []);
        if (request.method !== "GET") throw new HttpError(405, "Sealed Case specifications are immutable", { allow: "GET" });
        const status = await runtime.repository.status(sealedCaseMatch[1]!);
        if (!status) throw new HttpError(404, "Case not found");
        json(response, 200, status.sealed);
        return;
      }
      if (abortMatch) {
        exactQuery(url, []);
        if (request.method !== "POST") throw new HttpError(405, "Emergency abort requires POST", { allow: "POST" });
        const body = await readJsonBody(request, 256, requestBodyTimeoutMs);
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 0) {
          throw new HttpError(400, "Emergency abort accepts exactly an empty JSON object");
        }
        const caseId = abortMatch[1]!;
        const status = await runtime.repository.status(caseId);
        if (!status) throw new HttpError(404, "Case not found");
        if (runtime.orchestrator.abort(caseId) !== "accepted") {
          throw new HttpError(409, "Signing has closed abort admission; the sealed output is immutable");
        }
        json(response, 202, { protocol: "jevyr.abort-accepted/1", caseId, runDigest: status.sealed.runDigest,
          outcome: "INVALID", resumable: false }, { location: `/v1/cases/${caseId}/terminal` });
        return;
      }
      const voucherMatch = url.pathname.match(/^\/v1\/cases\/(case_[a-f0-9]{16})\/vouchers(\/redeem)?$/u);
      const metabolismMatch = url.pathname.match(/^\/(?:v1\/cases|runs)\/(case_[a-f0-9]{16})\/metabolism(\/redeem)?$/u);
      if (metabolismMatch) {
        exactQuery(url, []);
        const caseId = metabolismMatch[1]!;
        const status = await runtime.repository.status(caseId);
        if (!status) throw new HttpError(404, "Case not found");
        if (status.sealed.intent.control !== "juggler") throw new HttpError(405, "Sovereign Cases have no metabolic input channel");
        if (metabolismMatch[2] || url.pathname.startsWith("/runs/") && request.method === "POST") {
          if (request.method !== "POST") throw new HttpError(405, "Metabolic redemption requires POST", { allow: "POST" });
          const body = await readJsonBody(request, 256, requestBodyTimeoutMs);
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join("\0") !== "ballId\0quantity"
            || !("ballId" in body) || typeof body.ballId !== "string" || !/^ball_[A-Za-z0-9_-]{43}$/u.test(body.ballId)
            || !("quantity" in body) || !Number.isSafeInteger(body.quantity) || Number(body.quantity) < 1 || Number(body.quantity) > 64) {
            throw new HttpError(400, "Redemption accepts exactly an offered ballId and an integer quantity from 1 through 64");
          }
          try { json(response, 200, await runtime.orchestrator.redeemMetabolism(caseId, body)); }
          catch { throw new HttpError(409, "The offered addition is unavailable or exceeds its calibrated allowance"); }
        } else {
          if (request.method !== "GET") throw new HttpError(405, "Metabolic offers are read-only", { allow: "GET" });
          try { json(response, 200, runtime.orchestrator.metabolismOffers(caseId)); }
          catch { throw new HttpError(409, "Metabolic admission is closed for this Case"); }
        }
        return;
      }
      if (voucherMatch) {
        exactQuery(url, []);
        const caseId = voucherMatch[1]!;
        const status = await runtime.repository.status(caseId);
        if (!status) throw new HttpError(404, "Case not found");
        if (status.sealed.intent.control !== "juggler") throw new HttpError(405, "Sovereign Cases do not offer Juggler vouchers");
        if (voucherMatch[2]) {
          if (request.method !== "POST") throw new HttpError(405, "Opaque voucher redemption requires POST");
          const body = await readJsonBody(request, 256, requestBodyTimeoutMs);
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length !== 1
            || !("voucher" in body) || typeof body.voucher !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(body.voucher)) throw new HttpError(400, "Redemption accepts exactly one opaque voucher token");
          try { json(response, 200, runtime.orchestrator.redeemVoucher(caseId, body)); }
          catch { throw new HttpError(409, "Voucher is unavailable, already used, or its scheduler checkpoint has closed"); }
        } else {
          if (request.method !== "GET") throw new HttpError(405, "Voucher offers are read-only", { allow: "GET" });
          try { json(response, 200, { protocol: "jevyr.juggler-offers/1", caseId, runDigest: status.sealed.runDigest, offers: runtime.orchestrator.vouchers(caseId) }); }
          catch { throw new HttpError(409, "The Juggler scheduler checkpoint is unavailable"); }
        }
        return;
      }
      const continuation = url.pathname.match(/^\/v1\/cases\/([^/]+)\/(?:continue|messages?|input)$/);
      if (continuation && request.method === "POST") {
        throw new HttpError(405, "Sealed cases have no semantic continuation endpoint", { allow: "GET" });
      }
      const streamMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/events\/stream$/);
      if (streamMatch) {
        if (request.method !== "GET") throw new HttpError(405, "The event stream is read-only", { allow: "GET" });
        exactQuery(url, ["after"]);
        const caseId = decodeURIComponent(streamMatch[1] ?? "");
        if (!(await runtime.repository.status(caseId))) throw new HttpError(404, "Case not found");
        const after = sseCursor(request, url);
        const latestSequence = await runtime.events.lastSequence(caseId);
        if (after > latestSequence) {
          throw new HttpError(409, `Event cursor ${after} is beyond ledger sequence ${latestSequence}`);
        }
        await sse(request, response, runtime, caseId, after);
        return;
      }
      const eventsMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/events$/);
      if (eventsMatch) {
        if (request.method !== "GET") throw new HttpError(405, "The event ledger is read-only", { allow: "GET" });
        exactQuery(url, ["after", "cursor", "waitMs", "limit"]);
        const caseId = decodeURIComponent(eventsMatch[1] ?? "");
        const status = await runtime.repository.status(caseId);
        if (!status) throw new HttpError(404, "Case not found");
        const after = pollingCursor(url);
        const latestBeforeWait = await runtime.events.lastSequence(caseId);
        if (after > latestBeforeWait) {
          throw new HttpError(409, `Event cursor ${after} is beyond ledger sequence ${latestBeforeWait}`);
        }
        const waitMs = integer(url.searchParams.get("waitMs"), 0, 0, 30_000);
        const limit = integer(url.searchParams.get("limit"), 500, 1, 2_000);
        const terminalAtCursor = (status.lifecycle === "terminated" || status.lifecycle === "invalid")
          && after === latestBeforeWait;
        const page = waitMs > 0 && !terminalAtCursor
          ? await runtime.events.wait(caseId, after, waitMs, undefined, limit)
          : await runtime.events.list(caseId, after, limit);
        const visible = page.events.slice(0, limit);
        if (visible.some((event) =>
          event.caseDigest !== status.sealed.caseDigest || event.runDigest !== status.sealed.runDigest)) {
          throw new Error("Event page crossed the sealed Case or run boundary");
        }
        const throughSequence = visible.at(-1)?.sequence ?? after;
        json(response, 200, {
          protocol: "jevyr.live/1",
          caseDigest: status.sealed.caseDigest,
          runDigest: status.sealed.runDigest,
          afterSequence: after,
          throughSequence,
          headDigest: page.headDigest,
          caughtUp: throughSequence >= page.latestSequence,
          events: visible,
          polledAt: new Date().toISOString(),
        });
        return;
      }
      const recordEnvelopeMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/record\/envelope$/);
      if (recordEnvelopeMatch && request.method === "GET") {
        const caseId = decodeURIComponent(recordEnvelopeMatch[1] ?? "");
        if (!(await runtime.repository.status(caseId))) throw new HttpError(404, "Case not found");
        const envelope = await runtime.repository.recordEnvelope(caseId);
        if (!envelope) throw new HttpError(409, "Record is not available until the case reaches SIGN");
        json(response, 200, envelope);
        return;
      }
      const terminalEnvelopeMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/terminal\/envelope$/);
      if (terminalEnvelopeMatch && request.method === "GET") {
        const caseId = decodeURIComponent(terminalEnvelopeMatch[1] ?? "");
        if (!(await runtime.repository.status(caseId))) throw new HttpError(404, "Case not found");
        const envelope = await runtime.repository.terminalEnvelope(caseId);
        if (!envelope) throw new HttpError(409, "Signed terminal closure is not available yet");
        json(response, 200, envelope);
        return;
      }
      const terminalMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/terminal$/);
      if (terminalMatch && request.method === "GET") {
        const caseId = decodeURIComponent(terminalMatch[1] ?? "");
        if (!(await runtime.repository.status(caseId))) throw new HttpError(404, "Case not found");
        const receipt = await runtime.repository.terminalReceipt(caseId);
        if (!receipt) throw new HttpError(409, "Signed terminal closure is not available yet");
        json(response, 200, receipt);
        return;
      }
      const intentContractMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/intent-contract$/);
      if (intentContractMatch && request.method === "GET") {
        const caseId = decodeURIComponent(intentContractMatch[1] ?? "");
        const contract = await runtime.repository.intentContract(caseId);
        if (!contract) throw new HttpError(404, "Case not found");
        json(response, 200, contract);
        return;
      }
      const policyDescriptorMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/policy-descriptor$/);
      if (policyDescriptorMatch && request.method === "GET") {
        const caseId = decodeURIComponent(policyDescriptorMatch[1] ?? "");
        const status = await runtime.repository.status(caseId);
        if (!status) throw new HttpError(404, "Case not found");
        const record = await runtime.repository.record(caseId);
        if (record && (
          record.caseDigest !== status.sealed.caseDigest
          || record.runDigest !== status.sealed.runDigest
          || record.policyDigest !== status.sealed.policyDigest
        )) {
          throw new Error("Stored Record and sealed Case disagree on policy identity");
        }
        const artifact = await runtime.repository.descriptor(status.sealed.policyDigest);
        if (!artifact || artifact.kind !== "policy" || artifact.digest !== status.sealed.policyDigest) {
          throw new Error("The Case policy descriptor is missing or has the wrong descriptor kind");
        }
        json(response, 200, {
          protocol: "jevyr.case-policy-descriptor/1",
          caseId,
          caseDigest: status.sealed.caseDigest,
          runDigest: status.sealed.runDigest,
          policyDigest: status.sealed.policyDigest,
          artifact,
        });
        return;
      }
      const recordMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/record$/);
      if (recordMatch && request.method === "GET") {
        const caseId = decodeURIComponent(recordMatch[1] ?? "");
        const status = await runtime.repository.status(caseId);
        if (!status) throw new HttpError(404, "Case not found");
        const record = await runtime.repository.record(caseId);
        if (!record) throw new HttpError(409, "Record is not available until the case reaches SIGN");
        json(response, 200, record);
        return;
      }
      const sealEnvelopeMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/seal\/envelope$/);
      if (sealEnvelopeMatch && request.method === "GET") {
        const caseId = decodeURIComponent(sealEnvelopeMatch[1] ?? "");
        const envelope = await runtime.repository.sealEnvelope(caseId);
        if (!envelope) throw new HttpError(404, "Case not found");
        json(response, 200, envelope);
        return;
      }
      const sealMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/seal$/);
      if (sealMatch && request.method === "GET") {
        const caseId = decodeURIComponent(sealMatch[1] ?? "");
        const receipt = await runtime.repository.receipt(caseId);
        if (!receipt) throw new HttpError(404, "Case not found");
        json(response, 200, receipt);
        return;
      }
      const artifactMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/artifacts\/([^/]+)$/);
      if (artifactMatch && request.method === "GET") {
        const caseId = decodeURIComponent(artifactMatch[1] ?? "");
        const artifactId = decodeURIComponent(artifactMatch[2] ?? "");
        const artifact = await runtime.repository.artifact(caseId, artifactId);
        if (!artifact) throw new HttpError(404, "Artifact not found");
        response.writeHead(200, {
          "content-type": artifact.meta.mediaType,
          "content-length": String(artifact.data.byteLength),
          "content-disposition": `attachment; filename="${artifact.meta.name.replaceAll('"', "")}"`,
          "x-jevyr-digest": artifact.meta.digest,
          "cache-control": "private, immutable",
        });
        response.end(artifact.data);
        return;
      }
      const artifactsMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/artifacts$/);
      if (artifactsMatch && request.method === "GET") {
        const caseId = decodeURIComponent(artifactsMatch[1] ?? "");
        if (!(await runtime.repository.status(caseId))) throw new HttpError(404, "Case not found");
        json(response, 200, { protocol: "jevyr.artifacts/1", caseId, artifacts: await runtime.repository.artifacts(caseId) });
        return;
      }
      const publicResponseMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)\/public-responses\/([a-f0-9]{64})$/);
      if (publicResponseMatch) {
        if (request.method !== "GET") throw new HttpError(405, "Public response recovery is read-only", { allow: "GET" });
        exactQuery(url, []);
        const caseId = decodeURIComponent(publicResponseMatch[1] ?? "");
        if (!(await runtime.repository.status(caseId))) throw new HttpError(404, "Case not found");
        const recovered = await readPublicResponse(runtime.repository, caseId, publicResponseMatch[2]!);
        if (!recovered) throw new HttpError(404, "Verified public response not found");
        json(response, 200, recovered);
        return;
      }
      const statusMatch = url.pathname.match(/^\/v1\/cases\/([^/]+)$/);
      if (statusMatch) {
        if (request.method !== "GET") throw new HttpError(405, "Case status is read-only", { allow: "GET" });
        exactQuery(url, []);
        const caseId = decodeURIComponent(statusMatch[1] ?? "");
        const status = await runtime.status(caseId);
        if (!status) throw new HttpError(404, "Case not found");
        json(response, 200, status);
        return;
      }
      throw new HttpError(404, "Route not found");
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      const status = error instanceof HttpError || error instanceof TransportError || error instanceof ConnectionSettingsError ? error.status : error instanceof TypeError ? 400 : 500;
      const message = status === 500 ? "Internal Jevyr daemon error" : error instanceof Error ? error.message : String(error);
      json(response, status, { protocol: "jevyr.error/1", status, error: message }, error instanceof HttpError ? error.headers : {});
    }
  };
  // Bone's parser owns exact bytes (including duplicate-key and fatal UTF-8
  // rejection), so Fastify must not JSON-decode the input before admission.
  // Hijacking also preserves bounded raw SSE writes and the MCP duplex stream.
  fastify.addHook("onRequest", async (request, reply) => {
    reply.hijack();
    await handle(request.raw, reply.raw);
  });
  fastify.all("/", async () => undefined);
  fastify.all("/*", async () => undefined);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    fastify,
    server,
    runtime,
    async listen(port = 4_317, host = "127.0.0.1") {
      if (!["127.0.0.1", "::1", "localhost"].includes(host) && !access.allowRemoteBind) {
        await runtime.close();
        throw new Error("Remote daemon binding requires JEVYR_ALLOW_REMOTE_BIND=1 and JEVYR_HTTP_TOKEN_REF");
      }
      try {
        await runtime.ready();
      } catch (error) {
        await runtime.close();
        throw error;
      }
      try {
        await fastify.listen({ port, host });
      } catch (error) {
        await runtime.close();
        throw error;
      }
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Daemon did not acquire a TCP address");
      return { host, port: address.port, url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}` };
    },
    async close() {
      runtime.orchestrator.abortAll();
      for (const socket of sockets) socket.destroy();
      await fastify.close();
      await runtime.close();
    },
  };
}
