import { describe, expect, it } from "vitest";
import { MAX_JSON_NESTING_DEPTH, parseJsonBytes, parseJsonText } from "../src/index.js";

describe("unambiguous persisted JSON", () => {
  it("accepts ordinary non-canonical operator JSON and repeated keys in separate objects", () => {
    expect(parseJsonText('{ "left": {"id": 1}, "right": {"id": 2} }')).toEqual({
      left: { id: 1 },
      right: { id: 2 },
    });
  });

  it("rejects duplicate keys, including escape-equivalent names", () => {
    expect(() => parseJsonText('{"policy":1,"policy":2}', "Policy")).toThrow(
      /Policy contains duplicate object key "policy"/u,
    );
    expect(() => parseJsonText('{"policy":1,"\\u0070olicy":2}', "Policy")).toThrow(
      /Policy contains duplicate object key "policy"/u,
    );
    expect(() => parseJsonText('{"outer":{"mode":1,"mode":2}}', "Policy")).toThrow(
      /Policy contains duplicate object key "mode"/u,
    );
  });

  it("decodes bytes with fatal UTF-8 semantics", () => {
    const invalid = Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]);
    expect(() => parseJsonBytes(invalid, "Seal")).toThrow(/Seal is not valid UTF-8/u);
  });

  it("bounds nesting before recursive scanning can exhaust the JavaScript stack", () => {
    const nested = "[".repeat(MAX_JSON_NESTING_DEPTH + 1)
      + "null"
      + "]".repeat(MAX_JSON_NESTING_DEPTH + 1);
    expect(() => parseJsonText(nested, "Control file")).toThrow(
      /Control file exceeds maximum JSON nesting depth 256/u,
    );
  });
});
