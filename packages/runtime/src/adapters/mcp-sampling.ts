import type {
  CapabilityCard,
  MindAdapter,
  MindRequest,
  ProbeResult,
  PublicContribution,
  SamplingReceipt,
} from "../contracts.js";
import {
  MAX_MIND_RAW_OUTPUT_BYTES,
  MindMeteredFailure,
  conservativeUsage,
  utf8Bytes,
} from "../mind-metering.js";
import { sha256 } from "../canonical.js";
import { makePublicMindPrompt, parsePublicContributions } from "./prompt.js";

export const MCP_SAMPLING_MIND_ID = "mind.mcp-sampling.v1" as const;
export const MCP_SAMPLING_BINDING_PROTOCOL = "jevyr.mcp-sampling-binding/1" as const;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,255}$/u;
const MCP_PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/u;
const DEFAULT_TIMEOUT_MS = 180_000;
/** Stock per-invocation request ceiling; the sealed Case budget may only tighten it. */
export const DEFAULT_MCP_SAMPLING_MAX_TOKENS = 90_000;
const MAX_SAMPLING_TEXT_BLOCKS = 64;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function publicLabel(value: string, label: string, maximumBytes = 256): string {
  if (
    value.length === 0
    || value !== value.trim()
    || utf8Bytes(value) > maximumBytes
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${label} must be a bounded, single-line public value`);
  }
  return value;
}

function priority(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be a number in [0, 1]`);
  }
  return value;
}

export interface McpSamplingBinding {
  readonly protocol: typeof MCP_SAMPLING_BINDING_PROTOCOL;
  /** One-off public identity supplied by the broker for this originating client binding. */
  readonly bindingId: string;
  readonly source: "originating-mcp-client";
  readonly clientName: string;
  readonly clientVersion: string;
  readonly mcpProtocolVersion: string;
}

export interface McpSamplingTextContent {
  readonly type: "text";
  readonly text: string;
  readonly [extension: string]: unknown;
}

export interface McpCreateMessageParams {
  readonly messages: readonly [{
    readonly role: "user";
    readonly content: McpSamplingTextContent;
  }];
  readonly includeContext: "none";
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly modelPreferences?: Readonly<{
    readonly hints?: readonly Readonly<{ readonly name: string }>[];
    readonly costPriority?: number;
    readonly speedPriority?: number;
    readonly intelligencePriority?: number;
  }>;
}

export interface McpCreateMessageResult {
  readonly role: "assistant";
  readonly content: McpSamplingTextContent | readonly McpSamplingTextContent[];
  /** MCP defines this as the client-selected model name. Jevyr records it only as a client assertion. */
  readonly model: string;
  readonly stopReason?: string;
  readonly [extension: string]: unknown;
}

export type McpSamplingCallback = (
  params: McpCreateMessageParams,
  signal: AbortSignal,
) => Promise<McpCreateMessageResult>;

export interface McpSamplingMindOptions {
  readonly binding: McpSamplingBinding;
  readonly sample: McpSamplingCallback;
  /** Broker readiness only. This does not perform or prove a model inference. */
  readonly probe?: (signal: AbortSignal) => Promise<boolean>;
  readonly modelHints?: readonly string[];
  readonly costPriority?: number;
  readonly speedPriority?: number;
  readonly intelligencePriority?: number;
  readonly temperature?: number;
  readonly timeoutMs?: number;
  readonly maxTokensCeiling?: number;
  readonly maxResponseBytes?: number;
}

export interface McpSamplingInvocationResult {
  readonly contributions: readonly PublicContribution[];
  readonly tokenUsage: import("@jevyr/growth").NurseryInvocationUsage;
  readonly transmittedInputBytes: number;
  readonly receivedOutputBytes: number;
  readonly samplingReceipt: SamplingReceipt;
}

class SamplingBoundaryError extends Error {}

function binding(input: McpSamplingBinding): Readonly<McpSamplingBinding> {
  if (input.protocol !== MCP_SAMPLING_BINDING_PROTOCOL) {
    throw new TypeError(`binding.protocol must be ${MCP_SAMPLING_BINDING_PROTOCOL}`);
  }
  if (!SHA256_DIGEST.test(input.bindingId)) {
    throw new TypeError("binding.bindingId must be a SHA-256 digest");
  }
  if (input.source !== "originating-mcp-client") {
    throw new TypeError("binding.source must identify the originating MCP client");
  }
  const mcpProtocolVersion = publicLabel(input.mcpProtocolVersion, "binding.mcpProtocolVersion", 32);
  if (!MCP_PROTOCOL_VERSION.test(mcpProtocolVersion)) {
    throw new TypeError("binding.mcpProtocolVersion must be an MCP date-version");
  }
  return Object.freeze({
    protocol: MCP_SAMPLING_BINDING_PROTOCOL,
    bindingId: input.bindingId,
    source: "originating-mcp-client",
    clientName: publicLabel(input.clientName, "binding.clientName"),
    clientVersion: publicLabel(input.clientVersion, "binding.clientVersion", 128),
    mcpProtocolVersion,
  });
}

function modelPreferences(options: McpSamplingMindOptions): McpCreateMessageParams["modelPreferences"] {
  const hints = options.modelHints === undefined
    ? undefined
    : Object.freeze(options.modelHints.map((name) => {
      if (!MODEL_IDENTIFIER.test(name)) throw new TypeError("modelHints contains an invalid model identifier");
      return Object.freeze({ name });
    }));
  if ((hints?.length ?? 0) > 8 || new Set(hints?.map((hint) => hint.name)).size !== (hints?.length ?? 0)) {
    throw new TypeError("modelHints must contain at most eight unique model identifiers");
  }
  const costPriority = priority(options.costPriority, "costPriority");
  const speedPriority = priority(options.speedPriority, "speedPriority");
  const intelligencePriority = priority(options.intelligencePriority, "intelligencePriority");
  if (hints === undefined && costPriority === undefined && speedPriority === undefined && intelligencePriority === undefined) {
    return undefined;
  }
  return Object.freeze({
    ...(hints === undefined ? {} : { hints }),
    ...(costPriority === undefined ? {} : { costPriority }),
    ...(speedPriority === undefined ? {} : { speedPriority }),
    ...(intelligencePriority === undefined ? {} : { intelligencePriority }),
  });
}

function sampledText(result: unknown, maximumBytes: number): {
  readonly raw: string;
  readonly clientReportedModel: string;
  readonly stopReason: "endTurn" | null;
} {
  if (!isRecord(result) || result.role !== "assistant") {
    throw new SamplingBoundaryError("MCP caller-model returned a malformed assistant result");
  }
  if (typeof result.model !== "string" || !MODEL_IDENTIFIER.test(result.model)) {
    throw new SamplingBoundaryError("MCP caller-model returned an invalid client-reported model identifier");
  }
  if (result.stopReason === "maxTokens") {
    throw new SamplingBoundaryError("MCP caller-model truncated its structured output at the requested token limit");
  }
  if (result.stopReason === "toolUse") {
    throw new SamplingBoundaryError("MCP caller-model requested tool use although Jevyr granted no tools");
  }
  if (result.stopReason !== undefined && result.stopReason !== "endTurn") {
    throw new SamplingBoundaryError("MCP caller-model ended without a recognized complete stop");
  }
  const blocks = Array.isArray(result.content) ? result.content : [result.content];
  if (blocks.length === 0 || blocks.length > MAX_SAMPLING_TEXT_BLOCKS) {
    throw new SamplingBoundaryError("MCP caller-model returned an invalid number of public content blocks");
  }
  const parts: string[] = [];
  let bytes = 0;
  for (const block of blocks) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
      throw new SamplingBoundaryError("MCP caller-model returned non-text or hidden content");
    }
    bytes += utf8Bytes(block.text);
    if (bytes > maximumBytes) {
      throw new SamplingBoundaryError(`MCP caller-model crossed the ${maximumBytes}-byte public output limit`);
    }
    parts.push(block.text);
  }
  const raw = parts.join("");
  if (raw.trim().length === 0) {
    throw new SamplingBoundaryError("MCP caller-model returned no public text content");
  }
  return Object.freeze({
    raw,
    clientReportedModel: result.model,
    stopReason: result.stopReason === "endTurn" ? "endTurn" : null,
  });
}

async function awaitCallback<T>(callback: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new SamplingBoundaryError("MCP caller-model sampling timed out or was aborted");
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      operation();
    };
    const onAbort = () => finish(() => reject(
      new SamplingBoundaryError("MCP caller-model sampling timed out or was aborted"),
    ));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(callback)
      .then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
  });
}

/**
 * Compatibility bridge for MCP caller-controlled model access. MCP Sampling is
 * deprecated in protocol 2026-07-28; wire-era negotiation and human approval
 * remain broker responsibilities outside this adapter.
 */
export class McpSamplingMindAdapter implements MindAdapter {
  readonly capability: CapabilityCard;
  readonly #binding: Readonly<McpSamplingBinding>;
  readonly #preferences: McpCreateMessageParams["modelPreferences"];
  readonly #timeoutMs: number;
  readonly #maxTokensCeiling: number;
  readonly #maxResponseBytes: number;
  readonly #temperature: number;

  constructor(private readonly options: McpSamplingMindOptions) {
    this.#binding = binding(options.binding);
    this.#preferences = modelPreferences(options);
    this.#timeoutMs = safeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1, 300_000);
    this.#maxTokensCeiling = safeInteger(
      options.maxTokensCeiling ?? DEFAULT_MCP_SAMPLING_MAX_TOKENS,
      "maxTokensCeiling",
      1,
      1_000_000,
    );
    this.#maxResponseBytes = safeInteger(
      options.maxResponseBytes ?? MAX_MIND_RAW_OUTPUT_BYTES,
      "maxResponseBytes",
      1,
      MAX_MIND_RAW_OUTPUT_BYTES,
    );
    if (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) {
      throw new RangeError("temperature must be a number in [0, 2]");
    }
    this.#temperature = options.temperature ?? 0.8;
    this.capability = Object.freeze({
      id: MCP_SAMPLING_MIND_ID,
      kind: "mind",
      displayName: "MCP caller model",
      version: "jevyr.mcp-sampling-mind/1",
      transport: "in-process",
      trust: "quarantined",
      modalities: Object.freeze(["text", "structured-data"] as const),
      network: "provider",
      canExecuteTools: false,
      deterministic: false,
      limits: Object.freeze({
        bindingId: this.#binding.bindingId,
        source: this.#binding.source,
        clientName: this.#binding.clientName,
        clientVersion: this.#binding.clientVersion,
        mcpProtocolVersion: this.#binding.mcpProtocolVersion,
        includeContext: "none",
        tools: false,
        samplingDeprecatedSince: "2026-07-28",
        timeoutMs: this.#timeoutMs,
        maxTokensCeiling: this.#maxTokensCeiling,
        maxResponseBytes: this.#maxResponseBytes,
      }),
    });
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(Math.min(this.#timeoutMs, 5_000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (this.options.probe === undefined) {
      return Object.freeze({
        available: true,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        version: this.#binding.mcpProtocolVersion,
        detail: "An originating-client sampling callback is bound; no model inference was preflighted.",
      });
    }
    try {
      const available = await awaitCallback(() => this.options.probe!(combined), combined);
      if (typeof available !== "boolean") throw new Error("invalid broker probe result");
      return Object.freeze({
        available,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        version: this.#binding.mcpProtocolVersion,
        detail: available
          ? "The originating-client sampling broker reports an available binding; no model inference was performed."
          : "The originating-client sampling broker reports no available binding.",
      });
    } catch {
      return Object.freeze({
        available: false,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        version: this.#binding.mcpProtocolVersion,
        detail: "The originating-client sampling broker could not be probed.",
      });
    }
  }

  async runMetered(request: MindRequest): Promise<McpSamplingInvocationResult> {
    const prompt = makePublicMindPrompt(request);
    const promptBytes = utf8Bytes(prompt);
    let transmittedInputBytes = 0;
    try {
      if (request.signal.aborted) {
        throw new SamplingBoundaryError("MCP caller-model sampling was aborted before transmission");
      }
      if (request.maxInputTokens !== undefined && promptBytes > request.maxInputTokens) {
        throw new SamplingBoundaryError("MCP caller-model sampling would exceed the sealed input-token permission");
      }
      const requestedMaxTokens = Math.min(request.maxOutputTokens ?? this.#maxTokensCeiling, this.#maxTokensCeiling);
      if (!Number.isSafeInteger(requestedMaxTokens) || requestedMaxTokens < 1) {
        throw new SamplingBoundaryError("MCP caller-model sampling has no positive completion-token permission");
      }
      const message = Object.freeze({
        role: "user" as const,
        content: Object.freeze({ type: "text" as const, text: prompt }),
      });
      const params: McpCreateMessageParams = Object.freeze({
        messages: Object.freeze([message]) as McpCreateMessageParams["messages"],
        includeContext: "none",
        maxTokens: requestedMaxTokens,
        temperature: this.#temperature,
        ...(this.#preferences === undefined ? {} : { modelPreferences: this.#preferences }),
      });
      const timeout = AbortSignal.timeout(this.#timeoutMs);
      const signal = AbortSignal.any([request.signal, timeout]);
      transmittedInputBytes = promptBytes;
      const result = await awaitCallback(() => this.options.sample(params, signal), signal);
      const sampled = sampledText(result, this.#maxResponseBytes);
      let contributions: PublicContribution[];
      try {
        contributions = parsePublicContributions(sampled.raw, this.capability.id, request, {
          strictStructured: true,
          requireFiniteCandidateSource: request.stage === "diverge",
        });
      } catch {
        throw new SamplingBoundaryError("MCP caller-model returned invalid structured public contributions");
      }
      const usage = conservativeUsage(prompt, sampled.raw);
      const samplingReceipt: SamplingReceipt = Object.freeze({
        protocol: "jevyr.mcp-sampling-receipt/1",
        adapterId: MCP_SAMPLING_MIND_ID,
        bindingId: this.#binding.bindingId,
        source: this.#binding.source,
        clientName: this.#binding.clientName,
        clientVersion: this.#binding.clientVersion,
        mcpProtocolVersion: this.#binding.mcpProtocolVersion,
        caseDigest: request.sealed.caseDigest,
        runDigest: request.sealed.runDigest,
        stage: request.stage,
        clientReportedModel: sampled.clientReportedModel,
        stopReason: sampled.stopReason,
        requestedMaxTokens,
        promptDigest: `sha256:${sha256(prompt)}`,
        outputDigest: `sha256:${sha256(sampled.raw)}`,
      });
      return Object.freeze({
        contributions: Object.freeze(contributions),
        ...usage,
        samplingReceipt,
      });
    } catch (error) {
      const message = error instanceof SamplingBoundaryError
        ? error.message
        : "MCP caller-model sampling failed at the injected broker boundary";
      throw new MindMeteredFailure(message, transmittedInputBytes);
    }
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    const result = await this.runMetered(request);
    for (const contribution of result.contributions) yield contribution;
  }
}
