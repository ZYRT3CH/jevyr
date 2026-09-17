export interface SseMessage {
  readonly id?: string;
  readonly event?: string;
  readonly data: string;
  readonly retry?: number;
}

const MAX_SSE_EVENT_CHARACTERS = 8 * 1_048_576;
const MAX_SSE_TRANSPORT_CHUNK_BYTES = 64 * 1_048_576;
const MAX_SSE_EVENT_LINES = 65_536;

function decodeBlock(block: string): SseMessage | undefined {
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line || line.startsWith(":")) continue;
    const divider = line.indexOf(":");
    const field = divider < 0 ? line : line.slice(0, divider);
    let value = divider < 0 ? "" : line.slice(divider + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id" && !value.includes("\0")) id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "retry" && /^\d+$/.test(value)) retry = Number(value);
  }
  if (data.length === 0) return undefined;
  return {
    data: data.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(event !== undefined ? { event } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let lines: string[] = [];
  let lineCharacters = 0;

  function takeLine(done: boolean): { readonly line: string; readonly consumed: number } | undefined {
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character !== "\n" && character !== "\r") continue;
      if (character === "\r" && index + 1 === buffer.length && !done) return undefined;
      const consumed = character === "\r" && buffer[index + 1] === "\n" ? index + 2 : index + 1;
      return { line: buffer.slice(0, index), consumed };
    }
    return undefined;
  }

  function consumeLines(done: boolean): SseMessage[] {
    const messages: SseMessage[] = [];
    let next = takeLine(done);
    while (next !== undefined) {
      buffer = buffer.slice(next.consumed);
      if (next.line.length === 0) {
        const message = decodeBlock(lines.join("\n"));
        lines = [];
        lineCharacters = 0;
        if (message) messages.push(message);
      } else {
        lineCharacters += next.line.length + 1;
        if (lineCharacters > MAX_SSE_EVENT_CHARACTERS || lines.length >= MAX_SSE_EVENT_LINES) {
          throw new RangeError("SSE event exceeds its bounded transport envelope");
        }
        lines.push(next.line);
      }
      next = takeLine(done);
    }
    return messages;
  }

  try {
    while (!signal?.aborted) {
      const result = await reader.read();
      if (result.value !== undefined && result.value.byteLength > MAX_SSE_TRANSPORT_CHUNK_BYTES) {
        throw new RangeError(`SSE transport chunk exceeds ${MAX_SSE_TRANSPORT_CHUNK_BYTES} bytes`);
      }
      buffer += decoder.decode(result.value, { stream: !result.done });
      for (const message of consumeLines(result.done)) yield message;
      if (lineCharacters + buffer.length > MAX_SSE_EVENT_CHARACTERS) {
        throw new RangeError("SSE event exceeds its bounded transport envelope");
      }
      if (result.done) {
        if (buffer.length > 0) {
          lines.push(buffer);
          lineCharacters += buffer.length;
          buffer = "";
        }
        const final = decodeBlock(lines.join("\n"));
        if (final) yield final;
        lines = [];
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
