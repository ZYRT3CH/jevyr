import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { parseJsonBytes } from "@jevyr/core";
import {
  MAX_MCP_REQUEST_BYTES,
  readMcpInputFrames,
  type McpBackend,
  type McpClientRunContext,
} from "@jevyr/daemon";

const MCP_CLIENT_RUN_PATH = "/v1/mcp/run";
const MCP_CLIENT_RUN_CONTENT_TYPE = "application/x-jevyr-mcp-run";
const MAX_BRIDGE_BYTES = 32 * MAX_MCP_REQUEST_BYTES;

type ClientModelRun = NonNullable<McpBackend["runWithClientModel"]>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function clientRunUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)
    || url.username || url.password) {
    throw new TypeError("MCP client-model transport requires a credential-free loopback HTTP daemon URL");
  }
  url.pathname = MCP_CLIENT_RUN_PATH;
  url.search = "";
  url.hash = "";
  return url;
}

function responseContentType(response: IncomingMessage): string | undefined {
  const raw = response.headers["content-type"];
  return Array.isArray(raw) ? raw[0]?.split(";", 1)[0]?.trim().toLowerCase() : raw?.split(";", 1)[0]?.trim().toLowerCase();
}

function samplingErrorCode(error: unknown): number {
  if (object(error) && Number.isSafeInteger(error.rpcCode)) return error.rpcCode as number;
  return -32000;
}

async function writeFrame(
  request: ClientRequest,
  frame: unknown,
  counter: { value: number },
): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
  if (bytes.byteLength > MAX_MCP_REQUEST_BYTES || counter.value + bytes.byteLength > MAX_BRIDGE_BYTES) {
    throw new Error("MCP client-model bridge input exceeds its bounded transport envelope");
  }
  counter.value += bytes.byteLength;
  await new Promise<void>((resolve, reject) => {
    request.write(bytes, (error) => error ? reject(error) : resolve());
  });
}

async function consumeRunResponse(
  response: IncomingMessage,
  request: ClientRequest,
  context: McpClientRunContext,
  inputBytes: { value: number },
): Promise<unknown> {
  if (response.statusCode !== 200 || responseContentType(response) !== MCP_CLIENT_RUN_CONTENT_TYPE) {
    response.resume();
    throw new Error(`Jevyr client-model bridge refused the run (HTTP ${response.statusCode ?? 0})`);
  }
  let outputBytes = 0;
  const sampleIds = new Set<string>();
  for await (const framed of readMcpInputFrames(response, MAX_MCP_REQUEST_BYTES)) {
    if (framed.error !== undefined) throw new Error("Jevyr client-model bridge returned an oversized frame");
    outputBytes += framed.bytes.byteLength;
    if (outputBytes > MAX_BRIDGE_BYTES) throw new Error("Jevyr client-model bridge output exceeds its bounded transport envelope");
    const frame = parseJsonBytes(framed.bytes, "Jevyr client-model bridge frame");
    if (!object(frame) || typeof frame.type !== "string") throw new Error("Jevyr client-model bridge returned a malformed frame");
    if (frame.type === "sealed" && exact(frame, ["type", "receipt"])) {
      context.onSealed?.(frame.receipt);
      continue;
    }
    if (frame.type === "sample.request" && exact(frame, ["type", "id", "params"])) {
      if (typeof frame.id !== "string" || frame.id.length < 1 || frame.id.length > 256 || sampleIds.has(frame.id)) {
        throw new Error("Jevyr client-model bridge returned a duplicate or malformed sampling id");
      }
      sampleIds.add(frame.id);
      try {
        const result = await context.sample(frame.params as Parameters<McpClientRunContext["sample"]>[0], context.signal);
        context.signal.throwIfAborted();
        await writeFrame(request, { type: "sample.result", id: frame.id, result }, inputBytes);
      } catch (error) {
        if (context.signal.aborted) throw error;
        await writeFrame(request, {
          type: "sample.error",
          id: frame.id,
          code: samplingErrorCode(error),
          message: "The MCP client declined or failed sampling",
        }, inputBytes);
      }
      continue;
    }
    if (frame.type === "completed" && exact(frame, ["type", "value"])) {
      request.end();
      return frame.value;
    }
    if (frame.type === "failed" && exact(frame, ["type", "code", "message"])) {
      request.end();
        throw new Error("The Jevyr client-model run failed; inspect the sealed Case through normal read endpoints");
    }
    throw new Error("Jevyr client-model bridge returned an unsupported frame");
  }
  throw new Error("Jevyr client-model bridge closed without a terminal frame");
}

/**
 * Bind one MCP stdio connection to the daemon's private loopback duplex route.
 * The returned function carries no model/session state between jevyr_run calls.
 */
export function createMcpClientRunBridge(baseUrl: string, headers: Readonly<Record<string, string>> = {}): NonNullable<McpBackend["runWithClientModel"]> {
  const endpoint = clientRunUrl(baseUrl);
  const run: ClientModelRun = async (intent, context) => {
    context.signal.throwIfAborted();
    const inputBytes = { value: 0 };
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (operation: () => void): void => {
        if (settled) return;
        settled = true;
        context.signal.removeEventListener("abort", onAbort);
        operation();
      };
      const fail = (error: unknown): void => finish(() => {
        request.destroy();
        reject(error instanceof Error ? error : new Error("Jevyr client-model bridge failed"));
      });
      const onAbort = (): void => fail(new Error("MCP client-model run was cancelled"));
      const request = httpRequest(endpoint, {
        method: "POST",
        headers: {
          ...headers,
          "content-type": MCP_CLIENT_RUN_CONTENT_TYPE,
          accept: MCP_CLIENT_RUN_CONTENT_TYPE,
          "cache-control": "no-store",
        },
      });
      request.once("error", fail);
      request.once("response", (response) => {
        void consumeRunResponse(response, request, context, inputBytes).then(
          (value) => finish(() => resolve(value)),
          fail,
        );
      });
      context.signal.addEventListener("abort", onAbort, { once: true });
      request.flushHeaders();
      void writeFrame(request, { type: "start", intent, client: context.client }, inputBytes).catch(fail);
    });
  };
  return run;
}
