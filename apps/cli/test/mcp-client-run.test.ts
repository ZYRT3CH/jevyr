import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseJsonBytes } from "@jevyr/core";
import { readMcpInputFrames } from "@jevyr/daemon";
import { createMcpClientRunBridge } from "../src/mcp-client-run.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }));
});

describe("CLI MCP client-model duplex bridge", () => {
  it("relays only correlated sampling between one start frame and terminal completion", async () => {
    let start: unknown;
    let reply: unknown;
    const server = createServer(async (request, response) => {
      expect(request.headers.authorization).toBe("Bearer explicitly-scoped-test-token");
      const frames = readMcpInputFrames(request)[Symbol.asyncIterator]();
      const first = await frames.next();
      if (first.done || first.value.error !== undefined) throw new Error("missing start frame");
      start = parseJsonBytes(first.value.bytes, "test start frame");
      response.writeHead(200, {
        "content-type": "application/x-jevyr-mcp-run",
        "cache-control": "no-store",
      });
      response.flushHeaders();
      response.write(`${JSON.stringify({ type: "sealed", receipt: { caseId: "case_bridge" } })}\n`);
      response.write(`${JSON.stringify({
        type: "sample.request",
        id: "sample_one",
        params: {
          messages: [{ role: "user", content: { type: "text", text: "bounded public prompt" } }],
          includeContext: "none",
          maxTokens: 64,
        },
      })}\n`);
      const second = await frames.next();
      if (second.done || second.value.error !== undefined) throw new Error("missing sampling reply");
      reply = parseJsonBytes(second.value.bytes, "test sample reply");
      response.end(`${JSON.stringify({ type: "completed", value: { caseId: "case_bridge", closed: true } })}\n`);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", () => resolve()).once("error", reject));
    const address = server.address() as AddressInfo;
    const sealed: unknown[] = [];
    const controller = new AbortController();
    const run = createMcpClientRunBridge(`http://127.0.0.1:${address.port}`, { authorization: "Bearer explicitly-scoped-test-token" });

    await expect(run(
      { impulse: "Use the host model", privacy: "provider_scoped" },
      {
        client: { name: "host", version: "1", protocolVersion: "2025-11-25" },
        signal: controller.signal,
        onSealed: (receipt) => { sealed.push(receipt); },
        sample: async (params) => {
          expect(params.includeContext).toBe("none");
          return {
            role: "assistant",
            content: { type: "text", text: "[]" },
            model: "host-model",
            stopReason: "endTurn",
          };
        },
      },
    )).resolves.toEqual({ caseId: "case_bridge", closed: true });

    expect(start).toEqual({
      type: "start",
      intent: { impulse: "Use the host model", privacy: "provider_scoped" },
      client: { name: "host", version: "1", protocolVersion: "2025-11-25" },
    });
    expect(reply).toEqual({
      type: "sample.result",
      id: "sample_one",
      result: {
        role: "assistant",
        content: { type: "text", text: "[]" },
        model: "host-model",
        stopReason: "endTurn",
      },
    });
    expect(sealed).toEqual([{ caseId: "case_bridge" }]);
  });

  it("refuses a non-loopback or credential-bearing daemon URL", () => {
    expect(() => createMcpClientRunBridge("https://example.com"))
      .toThrow(/credential-free loopback HTTP/u);
    expect(() => createMcpClientRunBridge("http://user:secret@127.0.0.1:4317"))
      .toThrow(/credential-free loopback HTTP/u);
  });
});
