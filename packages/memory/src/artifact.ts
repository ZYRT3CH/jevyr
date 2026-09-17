import { canonicalize, isSha256Digest, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { parseJsonBytes } from "@jevyr/core";
import { stageMemory } from "./tribunal.js";
import {
  MAX_MEMORY_CANDIDATE_BYTES,
  MEMORY_CANDIDATE_MEDIA_TYPE,
  type MemoryCandidate,
  type StoredMemory,
} from "./types.js";

export interface EncodedMemoryCandidate {
  readonly mediaType: typeof MEMORY_CANDIDATE_MEDIA_TYPE;
  readonly digest: string;
  readonly size: number;
  readonly bytes: Uint8Array;
  readonly memory: StoredMemory;
}

/** Produce the sole byte representation accepted for a staged memory artifact. */
export function encodeMemoryCandidate(candidate: MemoryCandidate): EncodedMemoryCandidate {
  const memory = stageMemory(candidate);
  const bytes = new TextEncoder().encode(
    canonicalize(memory.candidate as unknown as JsonValue),
  );
  if (bytes.byteLength > MAX_MEMORY_CANDIDATE_BYTES) {
    throw new RangeError(
      `Memory candidate exceeds the ${MAX_MEMORY_CANDIDATE_BYTES}-byte canonical boundary.`,
    );
  }
  const digest = sha256Digest(bytes);
  if (digest !== memory.digest) throw new Error("Memory candidate encoding changed its identity.");
  return Object.freeze({
    mediaType: MEMORY_CANDIDATE_MEDIA_TYPE,
    digest,
    size: bytes.byteLength,
    bytes: bytes.slice(),
    memory,
  });
}

/** Parse only exact canonical UTF-8 bytes and optionally bind them to an expected address. */
export function decodeMemoryCandidate(
  input: Uint8Array,
  expectedDigest?: string,
): StoredMemory {
  if (!(input instanceof Uint8Array)) throw new TypeError("Memory artifact must be bytes.");
  if (input.byteLength > MAX_MEMORY_CANDIDATE_BYTES) {
    throw new RangeError(
      `Memory candidate exceeds the ${MAX_MEMORY_CANDIDATE_BYTES}-byte canonical boundary.`,
    );
  }
  if (expectedDigest !== undefined && !isSha256Digest(expectedDigest)) {
    throw new TypeError("Expected memory digest must be a SHA-256 digest.");
  }
  const parsed = parseJsonBytes(input, "Memory artifact");
  // parseJsonBytes has already decoded these exact bytes with fatal UTF-8.
  const text = new TextDecoder().decode(input);
  const memory = stageMemory(parsed as MemoryCandidate);
  const canonical = canonicalize(memory.candidate as unknown as JsonValue);
  if (canonical !== text) throw new TypeError("Memory artifact bytes are not canonical JSON.");
  const digest = sha256Digest(input);
  if (digest !== memory.digest || (expectedDigest !== undefined && digest !== expectedDigest)) {
    throw new Error("Memory artifact digest does not match its content address.");
  }
  return memory;
}
