import { describe, expect, it } from "vitest";
import {
  decodeMemoryCandidate,
  encodeMemoryCandidate,
  MAX_MEMORY_CANDIDATE_BYTES,
  MEMORY_CANDIDATE_MEDIA_TYPE,
  type MemoryCandidate,
} from "../src/index.js";
import { sha256Digest } from "@jevyr/protocol";

function candidate(): MemoryCandidate {
  return {
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: "strategy",
    abstractSummary: "Test the causal boundary before reusing the mechanism.",
    content: { version: "1", conditions: { isolated: true } },
    sourceMemoryDigests: [],
    evidenceDigests: [sha256Digest("origin-evidence")],
    projectId: "artifact-project",
    caseDigest: sha256Digest("origin-case"),
  };
}

describe("canonical memory artifacts", () => {
  it("round-trips one immutable content-addressed representation", () => {
    const encoded = encodeMemoryCandidate(candidate());
    expect(encoded.mediaType).toBe(MEMORY_CANDIDATE_MEDIA_TYPE);
    expect(encoded.digest).toBe(sha256Digest(encoded.bytes));
    const decoded = decodeMemoryCandidate(encoded.bytes, encoded.digest);
    expect(decoded).toEqual(encoded.memory);
    expect(Object.isFrozen(decoded.candidate)).toBe(true);
    expect(Object.isFrozen(decoded.candidate.content)).toBe(true);
  });

  it("rejects noncanonical bytes, an incorrect address, and oversized input", () => {
    const encoded = encodeMemoryCandidate(candidate());
    const pretty = new TextEncoder().encode(JSON.stringify(candidate(), null, 2));
    expect(() => decodeMemoryCandidate(pretty)).toThrow(/not canonical/);
    expect(() => decodeMemoryCandidate(encoded.bytes, sha256Digest("wrong"))).toThrow(
      /digest does not match/,
    );
    expect(() => decodeMemoryCandidate(new Uint8Array(MAX_MEMORY_CANDIDATE_BYTES + 1))).toThrow(
      /exceeds/,
    );
  });

  it("rejects malformed UTF-8, duplicate escaped keys, and shape-invalid JSON", () => {
    expect(() => decodeMemoryCandidate(Uint8Array.from([0xc3, 0x28]))).toThrow(
      /not valid UTF-8/,
    );
    expect(() => decodeMemoryCandidate(new TextEncoder().encode(String.raw`{
      "protocol":"jevyr.memory/1",
      "\u0070rotocol":"jevyr.memory/1"
    }`))).toThrow(/duplicate object key "protocol"/);
    expect(() => decodeMemoryCandidate(new TextEncoder().encode("[]"))).toThrow(
      /Memory candidate must be a plain object/,
    );
  });

  it("rejects unknown fields, sparse content, and accessors without invoking them", () => {
    expect(() => encodeMemoryCandidate({ ...candidate(), authority: "ADMIT" } as never)).toThrow(
      /unknown or missing/,
    );

    const sparse = new Array(2) as unknown[];
    sparse[1] = "present";
    expect(() => encodeMemoryCandidate({ ...candidate(), content: sparse } as never)).toThrow(
      /inert canonical JSON/,
    );

    let getterCalls = 0;
    const content = {} as Record<string, unknown>;
    Object.defineProperty(content, "strategy", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "smuggled";
      },
    });
    expect(() => encodeMemoryCandidate({ ...candidate(), content } as never)).toThrow(
      /inert canonical JSON/,
    );
    expect(getterCalls).toBe(0);
  });
});
