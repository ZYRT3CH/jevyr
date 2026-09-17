import { describe, expect, it } from "vitest";
import { parseSse } from "../src/sse.js";

function stream(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("parseSse", () => {
  it("survives chunk boundaries, comments, and multiline data", async () => {
    const messages = [];
    for await (const message of parseSse(stream([": hi\r\nid: c:1\r\nevent: trace\r\nda", "ta: one\r\ndata: two\r\n\r\n"]))) {
      messages.push(message);
    }
    expect(messages).toEqual([{ id: "c:1", event: "trace", data: "one\ntwo" }]);
  });

  it("recognizes CRLF boundaries split between transport chunks", async () => {
    const messages = [];
    for await (const message of parseSse(stream([
      "id: 1\r\ndata: one\r",
      "\n\r",
      "\nid: 2\ndata: two\n\n",
    ]))) {
      messages.push(message);
    }
    expect(messages).toEqual([
      { id: "1", data: "one" },
      { id: "2", data: "two" },
    ]);
  });

  it("supports bare carriage-return line endings without joining events", async () => {
    const messages = [];
    for await (const message of parseSse(stream(["id: 1\rdata: one\r\rid: 2\rdata: two\r\r"]))) {
      messages.push(message);
    }
    expect(messages).toEqual([
      { id: "1", data: "one" },
      { id: "2", data: "two" },
    ]);
  });

  it("rejects malformed UTF-8 instead of replacement-decoding event authority", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0x64, 0x61, 0x74, 0x61, 0x3a, 0x20, 0xff, 0x0a, 0x0a]));
        controller.close();
      },
    });
    await expect(async () => {
      for await (const _message of parseSse(body)) {
        // Fatal decoding must happen before any event is emitted.
      }
    }).rejects.toThrow();
  });

  it("bounds an unterminated SSE event", async () => {
    const oversized = `data: ${"x".repeat(8 * 1_048_576)}`;
    await expect(async () => {
      for await (const _message of parseSse(stream([oversized]))) {
        // A peer cannot retain an unbounded partial event.
      }
    }).rejects.toThrow("SSE event exceeds");
  });
});
