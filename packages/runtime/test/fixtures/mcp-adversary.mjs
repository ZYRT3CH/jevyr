import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const scenario = process.argv[2] ?? "normal";
const shutdownMarker = process.argv[3];
const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });

function emit(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  emit({ jsonrpc: "2.0", id, result: value });
}

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    result(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "deterministic-adversary", version: "1.0.0" },
    });
    return;
  }
  if (request.method === "notifications/initialized") return;
  if (request.method === "tools/list") {
    result(request.id, {
      tools: [
        {
          name: "echo",
          title: "Echo fixture",
          description: "Returns its arguments for boundary tests.",
          inputSchema: { type: "object", additionalProperties: true },
        },
        {
          name: "forbidden",
          description: "A discovered capability that is deliberately not allowlisted.",
          inputSchema: { type: "object" },
        },
      ],
    });
    return;
  }
  if (request.method !== "tools/call") return;

  if (scenario === "mismatched-id") {
    result(Number(request.id) + 100, { content: [{ type: "text", text: "wrong id" }] });
    return;
  }
  if (scenario === "oversized") {
    result(request.id, { content: [{ type: "text", text: "x".repeat(64 * 1024) }] });
    return;
  }
  if (scenario === "timeout") return;
  if (scenario === "malformed") {
    process.stdout.write("this is not json\n");
    return;
  }
  if (scenario === "duplicate-key") {
    process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"observed":true},"\\u0072esult":{"observed":false}}\n`);
    return;
  }
  if (scenario === "invalid-utf8") {
    process.stdout.write(Buffer.concat([
      Buffer.from(`{"jsonrpc":"2.0","id":${JSON.stringify(request.id)},"result":{"text":"`),
      Buffer.from([0xc3, 0x28]),
      Buffer.from('"}}\n'),
    ]));
    return;
  }
  if (scenario.startsWith("server-request:")) {
    emit({
      jsonrpc: "2.0",
      id: "fixture-server-request",
      method: scenario.slice("server-request:".length),
      params: {},
    });
    return;
  }
  if (scenario === "request-after-result") {
    result(request.id, { content: [{ type: "text", text: "apparently valid" }] });
    emit({ jsonrpc: "2.0", id: "late-request", method: "sampling/createMessage", params: {} });
    return;
  }
  result(request.id, {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          arguments: request.params?.arguments ?? null,
          inheritedSecret: process.env.JEVYR_MCP_TEST_SECRET ?? null,
        }),
      },
    ],
    structuredContent: { observed: true },
  });
});

input.on("close", () => {
  if (shutdownMarker) writeFileSync(shutdownMarker, "stdin-eof", "utf8");
});
