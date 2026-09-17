import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { parseJsonBytes } from "@jevyr/core";
import { assertCaseSubmission, type CaseIntent } from "@jevyr/protocol";
import type { McpCreateMessageParams, McpCreateMessageResult } from "@jevyr/runtime";
import { readMcpInputFrames } from "./mcp.js";
import type { DaemonRuntime } from "./runtime.js";

export const MCP_CLIENT_RUN_PATH = "/v1/mcp/run";
export const MCP_CLIENT_RUN_CONTENT_TYPE = "application/x-jevyr-mcp-run";
const MAX_FRAME_BYTES = 1_048_576;
const MAX_INPUT_BYTES = 32 * MAX_FRAME_BYTES;
const MAX_OUTPUT_BYTES = 32 * MAX_FRAME_BYTES;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function local(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Private local duplex transport. The first frame is the sole Case submission.
 * Later frames can only answer an outstanding, daemon-originated model call.
 * There is no session registry, callback URL, token in the ledger, or route by
 * which one connection can answer another connection's model invocation.
 */
export async function serveClientModelRun(request: IncomingMessage, response: ServerResponse, runtime: DaemonRuntime): Promise<void> {
  const deny = (status: number, message: string): void => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ error: message }));
    request.resume();
  };
  if (!local(request.socket.remoteAddress) || request.headers.origin !== undefined) {
    deny(403, "Client-model transport is loopback-only and is not browser-accessible");
    return;
  }
  if (request.headers["content-type"] !== MCP_CLIENT_RUN_CONTENT_TYPE) {
    deny(415, `Content-Type must be ${MCP_CLIENT_RUN_CONTENT_TYPE}`);
    return;
  }
  if (request.headers["content-length"] !== undefined) {
    deny(400, "Client-model transport requires an open chunked request");
    return;
  }
  const controller = new AbortController();
  let complete = false;
  let inputBytes = 0;
  let outputBytes = 0;
  let outputTail: Promise<void> = Promise.resolve();
  let pending: { id: string; resolve: (value: McpCreateMessageResult) => void; reject: (error: Error) => void } | undefined;
  const clearPending = (id: string): void => { if (pending?.id === id) pending = undefined; };
  const abort = (): void => {
    if (complete) return;
    controller.abort(new Error("MCP client-model connection ended or violated its bound protocol"));
    const current = pending;
    pending = undefined;
    current?.reject(new Error("MCP client-model connection is unavailable"));
  };
  request.once("aborted", abort);
  request.once("error", abort);
  response.once("close", abort);
  const send = (frame: unknown): Promise<void> => {
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (bytes.byteLength > MAX_FRAME_BYTES || outputBytes + bytes.byteLength > MAX_OUTPUT_BYTES) {
      abort();
      return Promise.reject(new Error("MCP client-model output exceeds its transport envelope"));
    }
    outputBytes += bytes.byteLength;
    const work = outputTail.then(async () => {
      controller.signal.throwIfAborted();
      if (response.destroyed || response.writableEnded) throw new Error("MCP client-model response is closed");
      await new Promise<void>((resolveWrite, rejectWrite) => {
        response.write(bytes, error => error ? rejectWrite(error) : resolveWrite());
      });
    });
    outputTail = work.catch(() => { abort(); });
    return work;
  };
  const frames = readMcpInputFrames(request, MAX_FRAME_BYTES)[Symbol.asyncIterator]();
  const firstDeadline = setTimeout(() => { abort(); request.destroy(); }, 10_000);
  firstDeadline.unref();
  try {
    const first = await frames.next();
    clearTimeout(firstDeadline);
    if (first.done || first.value.error !== undefined) throw new TypeError("Missing or invalid MCP client-model start frame");
    inputBytes += first.value.bytes.byteLength;
    const start = parseJsonBytes(first.value.bytes, "MCP client-model start");
    if (!object(start) || !exact(start, ["type", "intent", "client"]) || start.type !== "start"
      || !object(start.client) || !exact(start.client, ["name", "version", "protocolVersion"])
      || !bounded(start.client.name) || !bounded(start.client.version)
      || !["2025-06-18", "2025-11-25"].includes(start.client.protocolVersion as string)) {
      throw new TypeError("Invalid MCP client-model start frame");
    }
    assertCaseSubmission({ protocol: "jevyr.case/1", case: start.intent });
    const intent = start.intent as CaseIntent;
    if (intent.privacy !== "provider_scoped" && intent.privacy !== "full_case") {
      throw new TypeError("Client-model runs require explicit provider_scoped or full_case privacy");
    }
    response.writeHead(200, { "content-type": MCP_CLIENT_RUN_CONTENT_TYPE, "cache-control": "no-store", "x-accel-buffering": "no" });
    response.flushHeaders();
    const consume = async (): Promise<void> => {
      while (true) {
        const next = await frames.next();
        if (next.done) { abort(); return; }
        if (next.value.error !== undefined) throw new TypeError("Invalid MCP client-model frame");
        inputBytes += next.value.bytes.byteLength;
        if (inputBytes > MAX_INPUT_BYTES) throw new TypeError("MCP client-model input exceeds its envelope");
        const value = parseJsonBytes(next.value.bytes, "MCP client-model reply");
        if (!object(value) || typeof value.id !== "string" || !pending || pending.id !== value.id) {
          throw new TypeError("MCP client-model reply has no matching outstanding request");
        }
        const current = pending;
        if (value.type === "sample.result" && exact(value, ["type", "id", "result"])) {
          pending = undefined;
          current.resolve(value.result as McpCreateMessageResult);
        } else if (value.type === "sample.error" && exact(value, ["type", "id", "code", "message"])
          && Number.isSafeInteger(value.code) && bounded(value.message)) {
          pending = undefined;
          current.reject(new Error("MCP client declined or failed the requested model call"));
          // Losing the only admitted Mind is not permission to silently continue or fall back.
          abort();
        } else throw new TypeError("MCP client-model reply contains unsupported fields");
      }
    };
    void consume().catch(() => { abort(); });
    const sample = async (params: McpCreateMessageParams, signal: AbortSignal): Promise<McpCreateMessageResult> => {
      controller.signal.throwIfAborted();
      signal.throwIfAborted();
      if (pending) throw new Error("A client-model request is already outstanding");
      const id = `sample_${randomUUID()}`;
      let rejectReply!: (error: Error) => void;
      const answer = new Promise<McpCreateMessageResult>((resolveReply, reject) => {
        rejectReply = reject;
        pending = { id, resolve: resolveReply, reject };
      });
      // Attach immediately so abort during a backpressured write cannot become unhandled.
      void answer.catch(() => undefined);
      const cancel = (): void => {
        clearPending(id);
        rejectReply(new Error("MCP client-model invocation was cancelled"));
        abort();
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await send({ type: "sample.request", id, params });
        return await answer;
      } finally {
        signal.removeEventListener("abort", cancel);
        clearPending(id);
      }
    };
    const value = await runtime.runWithClientModel(intent, {
      client: { name: start.client.name, version: start.client.version, protocolVersion: start.client.protocolVersion as string },
      signal: controller.signal, sample,
      onSealed: receipt => { void send({ type: "sealed", receipt }).catch(abort); },
    });
    if (!controller.signal.aborted) {
      await send({ type: "completed", value });
      complete = true;
      response.end();
    } else {
      complete = true;
      response.end();
    }
  } catch (error) {
    abort();
    if (!response.headersSent && !response.destroyed) deny(400, "Invalid or unavailable client-model run; check protocol and explicit privacy");
    else if (!response.destroyed && !response.writableEnded) {
      response.end(`${JSON.stringify({ type: "failed", code: "CLIENT_MODEL_RUN_FAILED", message: "The client-model run failed; any sealed Case remains inspectable through its normal read endpoints." })}\n`);
    }
  } finally {
    clearTimeout(firstDeadline);
    if (!complete) abort();
    // Request EOF is expected after the final response; pending readers then release naturally.
  }
}
