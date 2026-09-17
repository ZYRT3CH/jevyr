import type { NurseryInvocationUsage, NurseryTokenReading } from "@jevyr/growth";
import type { MindAdapter, MindInvocationResult, MindRequest, PublicContribution } from "./contracts.js";
import { makePublicMindPrompt } from "./adapters/prompt.js";
import { digestJson, isSha256Digest, type JsonValue } from "@jevyr/protocol";
import { INVESTIGATOR_TOOL_DEFINITIONS, INVESTIGATOR_TOOL_POLICY, type InvestigatorToolReceipt } from "./investigator-tools.js";
import { safeSourceReadReceipt } from "./task-source-inspection.js";

export const MAX_MIND_RAW_OUTPUT_BYTES = 2_000_000;

export type ModelFailureBoundary = "INPUT_BUDGET" | "PROVIDER_TRANSPORT" | "PROVIDER_MESSAGE" | "TOOL_REQUEST_FORMAT" | "TOKEN_ACCOUNTING" | "FINAL_CONTRIBUTION" | "SOURCE_INSPECTION_REQUIRED" | "TOOL_CALL_CEILING" | "TOOL_IDENTITIES" | "TOOL_EXECUTION";
export type ProviderFailureCategory = "HTTP_AUTHENTICATION" | "HTTP_AUTHORIZATION" | "HTTP_RATE_LIMIT" | "HTTP_TIMEOUT" | "HTTP_CLIENT_ERROR" | "HTTP_SERVER_ERROR" | "HTTP_OTHER" | "NETWORK" | "TIMEOUT" | "ABORTED" | "RESPONSE_BYTE_LIMIT" | "RESPONSE_ENCODING" | "RESPONSE_JSON" | "RESPONSE_SCHEMA";
/** Status-based transient-failure hint only; this does not authorize any retry.
 * A response digest binds exactly responseBytes captured bytes. When complete is
 * false, that is a bounded prefix, never a claim about the omitted response. */
export interface ProviderFailureDiagnostic {
  readonly protocol: "jevyr.provider-failure/1";
  readonly category: ProviderFailureCategory;
  readonly retryable: boolean | null;
  readonly httpStatus?: number;
  readonly responseDigest?: string;
  readonly responseBytes?: number;
  readonly responseComplete?: boolean;
}
const providerFailures = new WeakMap<Error, ProviderFailureDiagnostic>();
const providerFailureCategories: readonly ProviderFailureCategory[] = ["HTTP_AUTHENTICATION", "HTTP_AUTHORIZATION", "HTTP_RATE_LIMIT", "HTTP_TIMEOUT", "HTTP_CLIENT_ERROR", "HTTP_SERVER_ERROR", "HTTP_OTHER", "NETWORK", "TIMEOUT", "ABORTED", "RESPONSE_BYTE_LIMIT", "RESPONSE_ENCODING", "RESPONSE_JSON", "RESPONSE_SCHEMA"];
export function safeProviderFailureDiagnostic(input: ProviderFailureDiagnostic): ProviderFailureDiagnostic {
  const fields = ["protocol", "category", "retryable", "httpStatus", "responseDigest", "responseBytes", "responseComplete"];
  if (!input || Object.keys(input).some(key => !fields.includes(key)) || input.protocol !== "jevyr.provider-failure/1" || !providerFailureCategories.includes(input.category) || (input.retryable !== null && typeof input.retryable !== "boolean")) throw new TypeError("Invalid provider failure diagnostic");
  if (input.httpStatus !== undefined && (!Number.isSafeInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599)) throw new TypeError("Invalid provider failure status");
  const hasResponse = input.responseDigest !== undefined || input.responseBytes !== undefined || input.responseComplete !== undefined;
  if (hasResponse && (!isSha256Digest(input.responseDigest) || !Number.isSafeInteger(input.responseBytes) || input.responseBytes! < 0 || input.responseBytes! > MAX_MIND_RAW_OUTPUT_BYTES || typeof input.responseComplete !== "boolean")) throw new TypeError("Invalid bounded provider response digest");
  return Object.freeze({ protocol: "jevyr.provider-failure/1", category: input.category, retryable: input.retryable,
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(hasResponse ? { responseDigest: input.responseDigest!, responseBytes: input.responseBytes!, responseComplete: input.responseComplete! } : {}) });
}
/** No message/cause/response object is accepted from a provider exception. */
export class ProviderTransportFailure extends Error {
  constructor(diagnostic: ProviderFailureDiagnostic) {
    const captured = safeProviderFailureDiagnostic(diagnostic);
    super(`Provider request failed (${captured.category}${captured.httpStatus === undefined ? "" : ` HTTP ${captured.httpStatus}`})`);
    this.name = "ProviderTransportFailure";
    providerFailures.set(this, captured);
  }
}
export function providerFailureDiagnostic(error: unknown): ProviderFailureDiagnostic | undefined {
  return error instanceof Error ? providerFailures.get(error) : undefined;
}
export interface ModelInvestigationFailure {
  readonly protocol: "jevyr.model-investigation-failure/1";
  readonly boundary: ModelFailureBoundary;
  readonly providerRounds: number;
  readonly tools: readonly InvestigatorToolReceipt[];
  readonly policyDigest: string;
  readonly authority: "context-only";
  readonly providerFailure?: ProviderFailureDiagnostic;
}
const failedInvestigations = new WeakMap<Error, ModelInvestigationFailure>();

/** Digest-only context survives failure; raw arguments, results and provider text never do. */
export function mindFailureInvestigation(error: unknown): ModelInvestigationFailure | undefined {
  return error instanceof Error ? failedInvestigations.get(error) : undefined;
}

function captureFailureInvestigation(input: Pick<ModelInvestigationFailure, "boundary" | "providerRounds" | "tools" | "providerFailure">): ModelInvestigationFailure {
  const boundaries: readonly ModelFailureBoundary[] = ["INPUT_BUDGET", "PROVIDER_TRANSPORT", "PROVIDER_MESSAGE", "TOOL_REQUEST_FORMAT", "TOKEN_ACCOUNTING", "FINAL_CONTRIBUTION", "SOURCE_INSPECTION_REQUIRED", "TOOL_CALL_CEILING", "TOOL_IDENTITIES", "TOOL_EXECUTION"];
  if (!boundaries.includes(input.boundary) || !Number.isSafeInteger(input.providerRounds) || input.providerRounds < 0 || input.providerRounds > INVESTIGATOR_TOOL_POLICY.maximumRounds || input.tools.length > INVESTIGATOR_TOOL_POLICY.maximumRounds * INVESTIGATOR_TOOL_POLICY.maximumCallsPerRound) throw new TypeError("Invalid bounded investigation failure");
  const names = new Set(INVESTIGATOR_TOOL_DEFINITIONS.map(tool => tool.function.name));
  const tools = input.tools.map(receipt => {
    if (!isSha256Digest(receipt.argumentsDigest) || !isSha256Digest(receipt.resultDigest) || receipt.sourceDigests.length > 256 || receipt.sourceDigests.some(digest => !isSha256Digest(digest)) || !Number.isSafeInteger(receipt.resultBytes) || receipt.resultBytes < 0 || receipt.resultBytes > INVESTIGATOR_TOOL_POLICY.maximumResultBytes || !["observed", "denied"].includes(receipt.status)) throw new TypeError("Invalid bounded failed-tool receipt");
    const sourceRead = receipt.sourceRead ? safeSourceReadReceipt(receipt.sourceRead) : undefined;
    if (sourceRead && (receipt.status !== "observed" || receipt.name !== "read_subject_lines" || !receipt.sourceDigests.includes(sourceRead.sourceDigest))) throw new TypeError("Failed source-read receipt lost its observation binding");
    return Object.freeze({ protocol: "jevyr.investigator-tool-receipt/1" as const, name: names.has(receipt.name) ? receipt.name : "unrecognized-tool", argumentsDigest: receipt.argumentsDigest, resultDigest: receipt.resultDigest, sourceDigests: Object.freeze([...receipt.sourceDigests]), resultBytes: receipt.resultBytes, status: receipt.status, authority: "context-only" as const, ...(sourceRead ? { sourceRead } : {}), ...(["native-functions", "jevyr.context-tools/1"].includes(receipt.requestFormat ?? "") ? { requestFormat: receipt.requestFormat } : {}) });
  });
  return Object.freeze({ protocol: "jevyr.model-investigation-failure/1", boundary: input.boundary, providerRounds: input.providerRounds, tools: Object.freeze(tools), policyDigest: digestJson(INVESTIGATOR_TOOL_POLICY as unknown as JsonValue), authority: "context-only", ...(input.providerFailure ? { providerFailure: safeProviderFailureDiagnostic(input.providerFailure) } : {}) });
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertSafeCount(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
}

/**
 * A failed Mind call that can still disclose how many input bytes crossed its
 * transport boundary. It never carries prompts, provider bodies, or secrets.
 */
export class MindMeteredFailure extends Error {
  readonly transmittedInputBytes: number;

  constructor(message: string, transmittedInputBytes: number, investigation?: Pick<ModelInvestigationFailure, "boundary" | "providerRounds" | "tools" | "providerFailure">) {
    super(message);
    this.name = "MindMeteredFailure";
    assertSafeCount(transmittedInputBytes, "transmittedInputBytes");
    this.transmittedInputBytes = transmittedInputBytes;
    if (investigation) failedInvestigations.set(this, captureFailureInvestigation(investigation));
  }
}

/** Exact UTF-8 bytes are a conservative token upper bound for failed calls. */
export function mindFailureInputUpperBound(error: unknown, fallbackBytes: number): number {
  assertSafeCount(fallbackBytes, "fallbackBytes");
  return error instanceof MindMeteredFailure
    ? Math.max(fallbackBytes, error.transmittedInputBytes)
    : fallbackBytes;
}

/** Provider usage is accepted as measured only when exposed as a finite integer. */
export function providerReading(reported: unknown, fallbackBytes: number): NurseryTokenReading {
  assertSafeCount(fallbackBytes, "fallbackBytes");
  return typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0
    ? Object.freeze({ tokens: reported, measurement: "MEASURED" })
    : Object.freeze({ tokens: fallbackBytes, measurement: "UPPER_BOUND" });
}

export function conservativeUsage(input: string, completeRawOutput: string): {
  readonly tokenUsage: NurseryInvocationUsage;
  readonly transmittedInputBytes: number;
  readonly receivedOutputBytes: number;
} {
  const transmittedInputBytes = utf8Bytes(input);
  const receivedOutputBytes = utf8Bytes(completeRawOutput);
  return Object.freeze({
    tokenUsage: Object.freeze({
      input: Object.freeze({ tokens: transmittedInputBytes, measurement: "UPPER_BOUND" }),
      output: Object.freeze({ tokens: receivedOutputBytes, measurement: "UPPER_BOUND" }),
    }),
    transmittedInputBytes,
    receivedOutputBytes,
  });
}

export function providerOrConservativeUsage(
  input: string,
  completeRawOutput: string,
  reportedInputTokens: unknown,
  reportedOutputTokens: unknown,
): {
  readonly tokenUsage: NurseryInvocationUsage;
  readonly transmittedInputBytes: number;
  readonly receivedOutputBytes: number;
} {
  const transmittedInputBytes = utf8Bytes(input);
  const receivedOutputBytes = utf8Bytes(completeRawOutput);
  return Object.freeze({
    tokenUsage: Object.freeze({
      input: providerReading(reportedInputTokens, transmittedInputBytes),
      output: providerReading(reportedOutputTokens, receivedOutputBytes),
    }),
    transmittedInputBytes,
    receivedOutputBytes,
  });
}

function validateResult(result: MindInvocationResult): MindInvocationResult {
  assertSafeCount(result.transmittedInputBytes, "transmittedInputBytes");
  assertSafeCount(result.receivedOutputBytes, "receivedOutputBytes");
  for (const [field, reading, bytes] of [
    ["input", result.tokenUsage.input, result.transmittedInputBytes],
    ["output", result.tokenUsage.output, result.receivedOutputBytes],
  ] as const) {
    assertSafeCount(reading.tokens, `tokenUsage.${field}.tokens`);
    if (reading.measurement !== "MEASURED" && reading.measurement !== "UPPER_BOUND") {
      throw new TypeError(`tokenUsage.${field}.measurement must be MEASURED or UPPER_BOUND.`);
    }
    if (reading.measurement === "UPPER_BOUND" && reading.tokens !== bytes) {
      throw new TypeError(`tokenUsage.${field} upper bounds must equal the exact UTF-8 byte count.`);
    }
  }
  return result;
}

/**
 * Executes one logical Mind invocation and returns exactly one usage receipt.
 * Legacy/in-process adapters expose no provider raw text, so their complete
 * yielded boundary is serialized deterministically and charged as an upper bound.
 */
export async function invokeMindMetered(
  adapter: MindAdapter,
  request: MindRequest,
): Promise<MindInvocationResult> {
  if (request.maxInputTokens !== undefined) assertSafeCount(request.maxInputTokens, "maxInputTokens");
  if (request.maxOutputTokens !== undefined) assertSafeCount(request.maxOutputTokens, "maxOutputTokens");
  if (adapter.runMetered) return validateResult(await adapter.runMetered(request));
  const contributions: PublicContribution[] = [];
  const outputByteLimit = Math.min(request.maxOutputTokens ?? MAX_MIND_RAW_OUTPUT_BYTES, MAX_MIND_RAW_OUTPUT_BYTES);
  for await (const contribution of adapter.run(request)) {
    contributions.push(contribution);
    if (contributions.length > 256) {
      throw new Error("Legacy Mind exceeded the hard 256-contribution boundary");
    }
    const received = JSON.stringify({ contributions });
    if (utf8Bytes(received) > outputByteLimit) {
      throw new Error(`Legacy Mind crossed the ${outputByteLimit}-byte conservative output boundary`);
    }
  }
  const completeBoundary = JSON.stringify({ contributions });
  const usage = conservativeUsage(makePublicMindPrompt(request), completeBoundary);
  return validateResult(Object.freeze({
    contributions: Object.freeze(contributions),
    ...usage,
  }));
}
