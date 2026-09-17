import { JEVYR_BONE_DESCRIPTOR, parseJsonText } from "@jevyr/core";
import { canonicalize, sha256Digest, type JsonValue } from "@jevyr/protocol";
import type { ToolObservation } from "./contracts.js";
import type { ExactByteCapture } from "./typed-oracles.js";

export const TOOL_OBSERVATION_MEDIA_TYPE = "application/vnd.jevyr.tool-observation+json" as const;
export const MAX_TOOL_OBSERVATION_BYTES = JEVYR_BONE_DESCRIPTOR.evidenceStore.maximumObservationBytes;
export const MAX_CASE_EVIDENCE_BYTES = JEVYR_BONE_DESCRIPTOR.evidenceStore.maximumCaseBytes;
export const MAX_EXACT_BYTE_CAPTURE_BYTES = 2_000_000;

const OBSERVATION_KEYS = new Set([
  "invocationId",
  "status",
  "summary",
  "startedAt",
  "finishedAt",
  "exitCode",
  "stdout",
  "stderr",
  "stdoutCapture",
  "stderrCapture",
  "artifactRefs",
  "oracle",
  "metadata",
]);
const OBSERVATION_STATUSES = new Set(["observed", "succeeded", "failed", "not-executed"]);
const ARTIFACT_ID = /^artifact_[a-f0-9]{24}$/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BYTE_CAPTURE_KEYS = Object.freeze([
  "byteLength",
  "complete",
  "data",
  "digest",
  "encoding",
  "observedByteLength",
  "schema",
  "utf8",
].sort());

export interface EncodedToolObservation {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly size: number;
}

export interface DecodedByteCapture {
  readonly bytes: Uint8Array;
  /** Present only when the exact bytes are valid UTF-8. A leading BOM is preserved. */
  readonly text?: string;
}

function strictUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** Builds the sole persisted spelling of one retained process byte stream. */
export function exactByteCapture(
  bytes: Uint8Array,
  observedByteLength = bytes.byteLength,
): ExactByteCapture {
  if (bytes.byteLength > MAX_EXACT_BYTE_CAPTURE_BYTES) {
    throw new RangeError(`Exact byte capture exceeds ${MAX_EXACT_BYTE_CAPTURE_BYTES} retained bytes`);
  }
  if (!Number.isSafeInteger(observedByteLength) || observedByteLength < bytes.byteLength) {
    throw new TypeError("Observed byte length must be a safe integer no smaller than the retained bytes");
  }
  const snapshot = Buffer.from(bytes);
  return Object.freeze({
    schema: "jevyr.exact-byte-capture/1" as const,
    encoding: "base64" as const,
    data: snapshot.toString("base64"),
    digest: sha256Digest(snapshot),
    byteLength: snapshot.byteLength,
    observedByteLength,
    complete: observedByteLength === snapshot.byteLength,
    utf8: strictUtf8(snapshot) === undefined ? "invalid" as const : "valid" as const,
  });
}

/** Validates and decodes a capture without invoking accessors or accepting base64 aliases. */
export function decodeExactByteCapture(value: unknown): DecodedByteCapture {
  if (!isPlainRecord(value)) throw new TypeError("Exact byte capture must be a plain object");
  assertInertJson(value, new Set());
  const keys = Object.keys(value).sort();
  if (keys.length !== BYTE_CAPTURE_KEYS.length
    || keys.some((key, index) => key !== BYTE_CAPTURE_KEYS[index])) {
    throw new TypeError("Exact byte capture fields are not closed");
  }
  if (value.schema !== "jevyr.exact-byte-capture/1" || value.encoding !== "base64") {
    throw new TypeError("Exact byte capture schema or encoding is invalid");
  }
  if (typeof value.data !== "string"
    || value.data.length > Math.ceil(MAX_EXACT_BYTE_CAPTURE_BYTES / 3) * 4
    || (value.data.length !== 0 && (value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.data)))) {
    throw new TypeError("Exact byte capture data is not canonical base64");
  }
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.toString("base64") !== value.data) {
    throw new TypeError("Exact byte capture data is not canonical base64");
  }
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength !== bytes.byteLength) {
    throw new TypeError("Exact byte capture byteLength does not match its decoded bytes");
  }
  if (!Number.isSafeInteger(value.observedByteLength)
    || (value.observedByteLength as number) < bytes.byteLength) {
    throw new TypeError("Exact byte capture observedByteLength is invalid");
  }
  if (typeof value.complete !== "boolean"
    || value.complete !== (value.observedByteLength === bytes.byteLength)) {
    throw new TypeError("Exact byte capture completeness does not match its lengths");
  }
  if (typeof value.digest !== "string"
    || !SHA256_PATTERN.test(value.digest)
    || value.digest !== sha256Digest(bytes)) {
    throw new TypeError("Exact byte capture digest does not match its decoded bytes");
  }
  const text = strictUtf8(bytes);
  if ((value.utf8 !== "valid" && value.utf8 !== "invalid")
    || value.utf8 !== (text === undefined ? "invalid" : "valid")) {
    throw new TypeError("Exact byte capture UTF-8 status is false");
  }
  return Object.freeze({ bytes: Uint8Array.from(bytes), ...(text === undefined ? {} : { text }) });
}

function captureBindingProblem(capture: unknown, text: unknown, label: string): void {
  if (capture === undefined) return;
  const decoded = decodeExactByteCapture(capture);
  if (decoded.text === undefined) {
    if (text !== undefined) throw new TypeError(`${label} text must be absent when exact bytes are invalid UTF-8`);
  } else if (text !== undefined && text !== decoded.text) {
    throw new TypeError(`${label} text does not equal the exact UTF-8 bytes`);
  }
}

/** Actual observed process bytes, independent of base64 or replacement-text length. */
export function toolObservationOutputBytes(observation: ToolObservation): number {
  const oracle = isPlainRecord(observation.oracle) ? observation.oracle : undefined;
  const execution = isPlainRecord(oracle?.execution) ? oracle.execution : undefined;
  const hasExecutionCapture = execution?.stdoutCapture !== undefined || execution?.stderrCapture !== undefined;
  if (hasExecutionCapture && (execution?.stdoutCapture === undefined || execution.stderrCapture === undefined)) {
    throw new TypeError("Forge execution must bind both stdout and stderr captures");
  }
  const stdoutCapture = hasExecutionCapture ? execution?.stdoutCapture : observation.stdoutCapture;
  const stderrCapture = hasExecutionCapture ? execution?.stderrCapture : observation.stderrCapture;
  if (stdoutCapture !== undefined || stderrCapture !== undefined) {
    if (stdoutCapture === undefined || stderrCapture === undefined) {
      throw new TypeError("Process observations must bind both stdout and stderr captures");
    }
    decodeExactByteCapture(stdoutCapture);
    decodeExactByteCapture(stderrCapture);
    const total = (stdoutCapture as ExactByteCapture).observedByteLength
      + (stderrCapture as ExactByteCapture).observedByteLength;
    if (!Number.isSafeInteger(total)) throw new TypeError("Observed process byte total is not a safe integer");
    return total;
  }
  return Buffer.byteLength(observation.stdout ?? "", "utf8")
    + Buffer.byteLength(observation.stderr ?? "", "utf8");
}

/** Encodes the exact observation bytes that an evidence event commits to. */
export function encodeToolObservation(observation: ToolObservation): EncodedToolObservation {
  assertToolObservation(observation);
  const bytes = new TextEncoder().encode(canonicalize(observation as unknown as JsonValue));
  if (bytes.byteLength > MAX_TOOL_OBSERVATION_BYTES) {
    throw new RangeError(
      `Tool observation is ${bytes.byteLength} bytes; Bone permits at most ${MAX_TOOL_OBSERVATION_BYTES}`,
    );
  }
  return Object.freeze({
    bytes,
    digest: sha256Digest(bytes),
    size: bytes.byteLength,
  });
}

/**
 * Accepts only the canonical bytes emitted above. Alternate JSON spellings are
 * rejected so the artifact digest identifies one exact replay representation.
 */
export function decodeToolObservation(bytes: Uint8Array): ToolObservation {
  if (bytes.byteLength > MAX_TOOL_OBSERVATION_BYTES) {
    throw new RangeError(
      `Tool observation is ${bytes.byteLength} bytes; Bone permits at most ${MAX_TOOL_OBSERVATION_BYTES}`,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Tool observation artifact is not valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = parseJsonText(text, "Tool observation artifact");
  } catch {
    throw new TypeError("Tool observation artifact is not valid JSON");
  }
  assertToolObservation(parsed);
  if (canonicalize(parsed as unknown as JsonValue) !== text) {
    throw new TypeError("Tool observation artifact is not canonical Jevyr JSON");
  }
  return structuredClone(parsed);
}

export function assertToolObservation(value: unknown): asserts value is ToolObservation {
  if (!isPlainRecord(value)) throw new TypeError("Tool observation must be a plain object");
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !OBSERVATION_KEYS.has(key))) {
    throw new TypeError("Tool observation contains unknown fields");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError("Tool observation fields must be enumerable own data properties");
    }
  }
  if (typeof value.invocationId !== "string" || value.invocationId.length < 1 || value.invocationId.length > 256) {
    throw new TypeError("Tool observation invocationId must contain 1–256 characters");
  }
  if (typeof value.status !== "string" || !OBSERVATION_STATUSES.has(value.status)) {
    throw new TypeError("Tool observation status is invalid");
  }
  if (typeof value.summary !== "string" || value.summary.length > 32_768) {
    throw new TypeError("Tool observation summary must contain at most 32,768 characters");
  }
  for (const field of ["startedAt", "finishedAt"] as const) {
    const timestamp = value[field];
    if (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp))) {
      throw new TypeError(`Tool observation ${field} must be a timestamp`);
    }
  }
  if (value.exitCode !== undefined && (
    typeof value.exitCode !== "number"
    || !Number.isSafeInteger(value.exitCode)
    || Math.abs(value.exitCode) > 2_147_483_647
  )) {
    throw new TypeError("Tool observation exitCode must be a signed 32-bit integer");
  }
  if (value.stdout !== undefined && typeof value.stdout !== "string") {
    throw new TypeError("Tool observation stdout must be a string");
  }
  if (value.stderr !== undefined && typeof value.stderr !== "string") {
    throw new TypeError("Tool observation stderr must be a string");
  }
  const hasTopCapture = value.stdoutCapture !== undefined || value.stderrCapture !== undefined;
  if (hasTopCapture && (value.stdoutCapture === undefined || value.stderrCapture === undefined)) {
    throw new TypeError("Tool observation process capture must contain both stdout and stderr");
  }
  captureBindingProblem(value.stdoutCapture, value.stdout, "Tool observation stdout");
  captureBindingProblem(value.stderrCapture, value.stderr, "Tool observation stderr");
  if (value.artifactRefs !== undefined) {
    if (!Array.isArray(value.artifactRefs)
      || value.artifactRefs.some((entry) => typeof entry !== "string" || !ARTIFACT_ID.test(entry))
      || new Set(value.artifactRefs).size !== value.artifactRefs.length) {
      throw new TypeError("Tool observation artifactRefs must be unique Jevyr artifact identifiers");
    }
  }
  if (value.oracle !== undefined) {
    assertJsonValue(value.oracle, "oracle");
    if (isPlainRecord(value.oracle) && isPlainRecord(value.oracle.execution)) {
      const execution = value.oracle.execution;
      const hasExecutionCapture = execution.stdoutCapture !== undefined || execution.stderrCapture !== undefined;
      if (hasExecutionCapture && (execution.stdoutCapture === undefined || execution.stderrCapture === undefined)) {
        throw new TypeError("Forge execution capture must contain both stdout and stderr");
      }
      captureBindingProblem(execution.stdoutCapture, execution.stdout, "Forge execution stdout");
      captureBindingProblem(execution.stderrCapture, execution.stderr, "Forge execution stderr");
      captureBindingProblem(execution.stdoutCapture, value.stdout, "Tool observation stdout");
      captureBindingProblem(execution.stderrCapture, value.stderr, "Tool observation stderr");
      if (hasTopCapture && hasExecutionCapture) {
        if (canonicalize(value.stdoutCapture as unknown as JsonValue)
          !== canonicalize(execution.stdoutCapture as JsonValue)
          || canonicalize(value.stderrCapture as unknown as JsonValue)
          !== canonicalize(execution.stderrCapture as JsonValue)) {
          throw new TypeError("Top-level and Forge execution byte captures disagree");
        }
      }
      if (hasExecutionCapture && typeof execution.outputTruncated === "boolean") {
        const stdout = execution.stdoutCapture as ExactByteCapture;
        const stderr = execution.stderrCapture as ExactByteCapture;
        if (execution.outputTruncated !== (!stdout.complete || !stderr.complete)) {
          throw new TypeError("Forge outputTruncated does not match exact capture completeness");
        }
      }
    }
  }
  if (value.metadata !== undefined) assertJsonValue(value.metadata, "metadata");
}

function assertJsonValue(value: unknown, label: string): void {
  try {
    assertInertJson(value, new Set());
    canonicalize(value as JsonValue);
  } catch (error) {
    throw new TypeError(`Tool observation ${label} must be canonical JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertInertJson(value: unknown, ancestors: Set<object>): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("numbers must be finite");
    return;
  }
  if (typeof value !== "object") throw new TypeError(`cannot encode ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("cyclic values are forbidden");
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("arrays must use the intrinsic prototype");
      const expected = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
      if (value.length > 100_000 || Object.keys(descriptors).some((key) => !expected.has(key))) {
        throw new TypeError("arrays must be dense and contain no extra fields");
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("array entries must be enumerable data properties");
        }
        assertInertJson(descriptor.value, ancestors);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("objects must be plain");
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) {
      throw new TypeError("symbol fields are forbidden");
    }
    for (const descriptor of Object.values(descriptors)) {
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("object fields must be enumerable data properties");
      }
      assertInertJson(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
