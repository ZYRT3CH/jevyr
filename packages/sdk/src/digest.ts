import { LIFECYCLE_STAGES, validateCaseEventShape, type CaseEvent } from "@jevyr/protocol";
import type { EventChainVerification } from "./types.js";

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("Canonical JSON does not permit non-finite numbers");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      if (seen.has(value)) throw new TypeError("Canonical JSON does not permit cyclic values");
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return `[${value.map((item) => {
            if (item === undefined || typeof item === "function" || typeof item === "symbol") {
              throw new TypeError("Canonical JSON arrays may contain only JSON values");
            }
            return serialize(item, seen);
          }).join(",")}]`;
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Canonical JSON objects must be plain objects");
        }
        const input = value as Record<string, unknown>;
        return `{${Object.keys(input).sort().map((key) => {
          const item = input[key];
          if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
            throw new TypeError(`Canonical JSON property ${JSON.stringify(key)} is not a JSON value`);
          }
          return `${JSON.stringify(key)}:${serialize(item, seen)}`;
        }).join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

/** Raw lowercase SHA-256 hex. Protocol digests should use sha256Digest. */
export async function sha256(value: string): Promise<string> {
  return await sha256Bytes(new TextEncoder().encode(value));
}

/** Raw lowercase SHA-256 hex for exact bytes. */
export async function sha256Bytes(value: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(value.byteLength);
  bytes.set(value);
  const result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Digest(value: string): Promise<string> {
  return `sha256:${await sha256(value)}`;
}

/** Canonical protocol digest for exact bytes. */
export async function sha256BytesDigest(value: Uint8Array): Promise<string> {
  return `sha256:${await sha256Bytes(value)}`;
}

export async function recomputeEventDigest(event: CaseEvent): Promise<string> {
  const { eventDigest: _ignored, ...unsigned } = event;
  return await sha256Digest(canonicalJson(unsigned));
}

/** @deprecated Canonical events already carry the hash-chain head. */
export async function advanceSegmentDigest(_previous: string, event: CaseEvent): Promise<string> {
  return await recomputeEventDigest(event);
}

export async function verifyEventChain(events: readonly CaseEvent[]): Promise<EventChainVerification> {
  const problems: string[] = [];
  let priorDigest: string | null = null;
  let caseDigest: string | undefined;
  let runDigest: string | undefined;
  let lastStageIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const expectedSequence = index + 1;
    const shape = validateCaseEventShape(event);
    if (!shape.ok) {
      problems.push(...shape.problems.map((entry) =>
        `sequence ${expectedSequence}: ${entry.path} ${entry.message}`));
    }
    if (event.sequence !== expectedSequence) problems.push(`sequence ${event.sequence}: expected ${expectedSequence}`);
    if (event.priorDigest !== priorDigest) problems.push(`sequence ${event.sequence}: priorDigest does not match the previous event`);
    if (event.eventDigest !== await recomputeEventDigest(event)) problems.push(`sequence ${event.sequence}: eventDigest does not match canonical content`);
    caseDigest ??= event.caseDigest;
    runDigest ??= event.runDigest;
    if (event.caseDigest !== caseDigest) problems.push(`sequence ${event.sequence}: caseDigest changed`);
    if (event.runDigest !== runDigest) problems.push(`sequence ${event.sequence}: runDigest changed`);
    const stageIndex = LIFECYCLE_STAGES.indexOf(event.stage);
    if (stageIndex < lastStageIndex) {
      problems.push(`sequence ${event.sequence}: lifecycle regressed from ${LIFECYCLE_STAGES[lastStageIndex]} to ${event.stage}`);
    }
    lastStageIndex = Math.max(lastStageIndex, stageIndex);
    priorDigest = event.eventDigest;
  }
  return {
    valid: problems.length === 0,
    headDigest: priorDigest,
    ...(caseDigest ? { caseDigest } : {}),
    ...(runDigest ? { runDigest } : {}),
    problems,
  };
}
