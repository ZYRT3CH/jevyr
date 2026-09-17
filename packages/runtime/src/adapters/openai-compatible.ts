import { createHash } from "node:crypto";
import { parseJsonText } from "@jevyr/core";
import type { CapabilityCard, ModelAdapter, MindInvocationResult, MindRequest, ProbeResult, PublicContribution } from "../contracts.js";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { INVESTIGATOR_TOOL_POLICY } from "../investigator-tools.js";
import { runModelToolLoop } from "../model-tool-loop.js";
import { investigationImplementationDescriptor } from "../investigation-identity.js";
import {
  MAX_MIND_RAW_OUTPUT_BYTES,
  MindMeteredFailure,
  ProviderTransportFailure,
  providerFailureDiagnostic,
  providerOrConservativeUsage,
  utf8Bytes,
  type ProviderFailureCategory,
  type ProviderFailureDiagnostic,
} from "../mind-metering.js";
import { makePublicMindPrompt, parsePublicContributions } from "./prompt.js";
import type { SecretBroker, SecretReference } from "../secret-broker.js";

export interface OpenAICompatibleOptions {
  readonly id: string;
  readonly displayName: string;
  readonly baseUrl: string;
  readonly model: string;
  /** Explicit configured family provenance. Never inferred from output or a display label. */
  readonly modelFamily?: string;
  /** Selected before sealing; structured mode supports raw models without native function calling. */
  readonly investigationTransport?: "native" | "structured";
  readonly apiKey?: string;
  readonly credential?: SecretReference;
  readonly secretBroker?: SecretBroker;
  readonly allowRemote?: boolean;
  readonly timeoutMs?: number;
  /** Hard cap for the provider's JSON response body, independent of token claims. */
  readonly maxResponseBytes?: number;
}

function isLoopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

type CompletionResponseMode = "json-schema" | "json-object" | "plain";

const COMMAND_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["executable", "args"],
  properties: {
    executable: { type: "string" },
    args: { type: "array", maxItems: 64, items: { type: "string" } },
  },
});

function finiteCandidateSchema(commandRequired: boolean): Readonly<Record<string, unknown>> {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["contributions"],
    properties: {
      contributions: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "kind",
            "summary",
            "body",
            "parentIds",
            "tags",
            "feasibility",
            "confidence",
            "evidenceRefs",
            "blueprint",
          ],
          properties: {
            kind: { type: "string", enum: ["candidate"] },
            summary: { type: "string" },
            body: { type: ["string", "null"] },
            parentIds: { type: "array", maxItems: 24, items: { type: "string" } },
            tags: { type: "array", maxItems: 16, items: { type: "string" } },
            feasibility: {
              type: ["string", "null"],
              enum: ["BUILDABLE_NOW", "BRIDGEABLE", "LAWFUL_BUT_OPEN", "CONTRADICTED", null],
            },
            confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
            evidenceRefs: { type: "array", maxItems: 24, items: { type: "string" } },
            blueprint: {
              type: "object",
              additionalProperties: false,
              required: commandRequired ? ["protocol", "files", "command"] : ["protocol", "files"],
              properties: {
                protocol: { type: "string", enum: ["jevyr.candidate-blueprint/1"] },
                files: {
                  type: "array",
                  minItems: 1,
                  maxItems: 64,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["path", "content"],
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" },
                    },
                  },
                },
                ...(commandRequired ? { command: COMMAND_SCHEMA } : {}),
              },
            },
          },
        },
      },
    },
  });
}

function responseFormat(mode: CompletionResponseMode, request: MindRequest): Readonly<Record<string, unknown>> | undefined {
  if (mode === "plain") return undefined;
  if (mode === "json-object") return { type: "json_object" };
  return {
    type: "json_schema",
    json_schema: {
      name: "jevyr_finite_candidate_v1",
      strict: true,
      schema: finiteCandidateSchema((request.experimentCapability?.experiments.length ?? 0) > 0),
    },
  };
}

function structuredInvestigationFormat(request: MindRequest, tools: readonly { function: { name: string; parameters: unknown } }[], finalRound: boolean, sourceRequired: boolean, revisionRequired = false): Record<string, unknown> {
  const offered = (sourceRequired ? tools.filter(tool => ["list_subject_files", "read_subject_lines", "search_subject"].includes(tool.function.name)) : revisionRequired ? tools.filter(tool => ["list_revision_files", "read_revision_lines"].includes(tool.function.name)) : tools).map(tool => {
    if (tool.function.name === "read_revision_lines" && request.revisionSources?.length) {
      const parameters = structuredClone(tool.function.parameters) as any;
      parameters.properties.fileId.enum = request.revisionSources.flatMap(source => source.files.map(file => digestJson({ subjectId: source.candidateId, path: file.path, sourceDigest: file.digest })));
      return { function: { ...tool.function, parameters } };
    }
    // A broker exposes a separately authorized sealed catalog beyond the prompt
    // projection. Its opaque IDs are validated by the broker, not this hint set.
    if (tool.function.name !== "read_subject_lines" || request.subjectContext || !request.subjectProjection?.files.length) return tool;
    const parameters = structuredClone(tool.function.parameters) as any;
    parameters.properties.fileId.enum = request.subjectProjection.files.map(file => digestJson({ subjectId: file.subjectId, path: file.path, sourceDigest: file.sourceDigest }));
    return { function: { ...tool.function, parameters } };
  });
  const toolRequest = { type: "object", additionalProperties: false, required: ["protocol", "calls"], properties: { protocol: { type: "string", enum: ["jevyr.context-tools/1"] }, calls: { type: "array", minItems: 1, maxItems: INVESTIGATOR_TOOL_POLICY.maximumCallsPerRound, items: { anyOf: offered.map(tool => ({ type: "object", additionalProperties: false, required: ["name", "arguments"], properties: { name: { type: "string", enum: [tool.function.name] }, arguments: tool.function.parameters } })) } } } };
  if (!finalRound && (sourceRequired || revisionRequired)) return { type: "json_schema", json_schema: { name: "jevyr_context_request_v1", strict: true, schema: toolRequest } };
  const final = investigationContributionSchema(request);
  return { type: "json_schema", json_schema: { name: request.stage === "diverge" && !request.revision ? "jevyr_context_or_candidate_v1" : "jevyr_context_or_contributions_v1", strict: true, schema: finalRound ? final : { anyOf: [toolRequest, final] } } };
}

/** The public final contract is stage-owned and identical across transports.
 * Tool request channels differ; source, command and parent authority do not. */
function investigationContributionSchema(request: MindRequest): Record<string, any> {
  const schema = structuredClone(finiteCandidateSchema((request.experimentCapability?.experiments.length ?? 0) > 0)) as any;
  const experiments = request.experimentCapability?.experiments ?? [];
  if (experiments.length > 0) {
    const blueprint = schema.properties.contributions.items.properties.blueprint;
    blueprint.properties.command = { anyOf: experiments.map(experiment => ({ type: "object", additionalProperties: false, required: ["executable", "args"], properties: { executable: { type: "string", enum: [experiment.command.executable] }, args: { type: "array", enum: [experiment.command.args] } } })) };
    blueprint.properties.files.contains = { type: "object", required: ["path"], properties: { path: { type: "string", enum: experiments.map(experiment => experiment.entryFile) } } };
    blueprint.properties.files.prefixItems = [{ ...blueprint.properties.files.items, properties: { ...blueprint.properties.files.items.properties, path: { type: "string", enum: experiments.map(experiment => experiment.entryFile) } } }];
  }
  if (request.stage === "diverge" && !request.revision) return schema;
  schema.properties.contributions.maxItems = request.revision ? 1 : 6;
  const contribution = schema.properties.contributions.items;
  contribution.properties.kind.enum = request.revision
    ? ["candidate", "reflex"]
    : request.stage === "interpret"
      ? ["interpretation", "claim", "observation", "test-plan"]
      : ["interpretation", "claim", "observation", "candidate", "challenge", "test-plan", "repair", "reflex"];
  contribution.properties.summary.minLength = 1;
  // Transport grammars need not expand the parser's large text limits into
  // thousands of repetitions. Existing response-byte/token bounds still apply.
  contribution.properties.blueprint = { anyOf: [contribution.properties.blueprint, { type: "null" }] };
  if (request.revision) {
    contribution.properties.parentIds.maxItems = 1;
    contribution.properties.parentIds.items.enum = [...request.revision.parentCandidateIds];
  }
  return schema;
}

/** Native calls and public JSON are separate response channels. Until an actual
 * source receipt exists, JSON content may request context but cannot be a final. */
function nativeInvestigationFormat(request: MindRequest, tools: readonly { function: { name: string; parameters: unknown } }[], finalRound: boolean, sourceRequired: boolean, revisionRequired = false): Record<string, unknown> {
  if (!finalRound && (sourceRequired || revisionRequired)) {
    return structuredInvestigationFormat(request, tools, false, sourceRequired, revisionRequired);
  }
  return { type: "json_schema", json_schema: { name: request.stage === "diverge" && !request.revision ? "jevyr_context_or_candidate_v1" : "jevyr_public_contributions_v1", strict: true, schema: investigationContributionSchema(request) } };
}

function completionModes(request: MindRequest): readonly CompletionResponseMode[] {
  return request.stage === "diverge"
    ? ["json-schema", "json-object", "plain"]
    : ["json-object", "plain"];
}

function explicitlyUnsupportedFormat(
  status: number,
  text: string,
  mode: Exclude<CompletionResponseMode, "plain">,
): boolean {
  if (status !== 400 && status !== 422) return false;
  const raw = text.toLowerCase();
  const mentionsFormat = raw.includes("response_format")
    || raw.includes("response format")
    || (mode === "json-schema"
      ? raw.includes("json_schema") || raw.includes("json schema")
      : raw.includes("json_object") || raw.includes("json object"));
  const rejectsFormat = /\b(?:unsupported|unrecognized|unknown)\b|\bnot supported\b|\bdoes not support\b|\bnot available\b|\binvalid (?:parameter|schema|type|value|response[_ -]?format)\b/u.test(raw);
  return mentionsFormat && rejectsFormat;
}

type ResponseFingerprint = Pick<ProviderFailureDiagnostic, "httpStatus" | "responseDigest" | "responseBytes" | "responseComplete">;
function interruptedCategory(signal: AbortSignal): ProviderFailureCategory {
  return signal.aborted ? signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "ABORTED" : "NETWORK";
}
function httpFailure(status: number, fingerprint: ResponseFingerprint): ProviderFailureDiagnostic {
  const category: ProviderFailureCategory = status === 401 ? "HTTP_AUTHENTICATION" : status === 403 ? "HTTP_AUTHORIZATION"
    : status === 429 ? "HTTP_RATE_LIMIT" : status === 408 || status === 504 ? "HTTP_TIMEOUT"
    : status >= 400 && status < 500 ? "HTTP_CLIENT_ERROR" : status >= 500 ? "HTTP_SERVER_ERROR" : "HTTP_OTHER";
  // A transient status is a diagnostic hint, never a retry permission. Network
  // failures and local timeouts do not establish whether a request was applied.
  // RFC 9110 explicitly permits repeating 408 and describes 503 as temporary;
  // RFC 6585 gives 429 a retry wait. Generic/gateway 5xx do not establish that
  // the upstream request was unapplied or the condition temporary.
  const retryable = [408, 429, 503].includes(status) ? true
    : status >= 300 && status < 500 || status === 501 || status === 505 ? false : null;
  return { protocol: "jevyr.provider-failure/1", category, retryable, ...fingerprint, httpStatus: status };
}

/** Hash exact body bytes while retaining at most the configured prefix. A limit
 * or interrupted stream is explicitly incomplete; no provider text escapes. */
async function readDiagnosticResponse(response: Response, maximum: number, signal: AbortSignal): Promise<{ bytes: Buffer; fingerprint: ResponseFingerprint }> {
  const chunks: Buffer[] = [], hash = createHash("sha256");
  let size = 0, complete = false;
  const reader = response.body?.getReader();
  const fingerprint = (): ResponseFingerprint => ({ httpStatus: response.status, responseDigest: `sha256:${hash.digest("hex")}`, responseBytes: size, responseComplete: complete });
  try {
    if (!reader) complete = true;
    else while (true) {
      const next = await reader.read();
      if (next.done) { complete = true; break; }
      const retained = next.value.subarray(0, Math.max(0, maximum - size));
      if (retained.byteLength) { const copy = Buffer.from(retained); chunks.push(copy); hash.update(copy); size += copy.byteLength; }
      if (next.value.byteLength > retained.byteLength) { try { await reader.cancel(); } catch { /* cancellation diagnostics never include a provider exception */ } break; }
    }
    return { bytes: Buffer.concat(chunks, size), fingerprint: fingerprint() };
  } catch {
    throw new ProviderTransportFailure({ protocol: "jevyr.provider-failure/1", category: interruptedCategory(signal), retryable: null, ...fingerprint() });
  } finally { reader?.releaseLock(); }
}

function decodeDiagnosticResponse(bytes: Buffer, fingerprint: ResponseFingerprint): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new ProviderTransportFailure({ protocol: "jevyr.provider-failure/1", category: "RESPONSE_ENCODING", retryable: null, ...fingerprint }); }
}

function completionText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) return undefined;
    const item = part as Record<string, unknown>;
    if ((item.type !== "text" && item.type !== "output_text") || typeof item.text !== "string") return undefined;
    parts.push(item.text);
  }
  return parts.join("");
}

function safeMeteredFailureMessage(error: unknown, displayName: string, adapterId: string): string {
  const fallback = `${displayName} failed its bounded contribution request`;
  if (!(error instanceof Error)) return fallback;
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return `${displayName} timed out or was aborted`;
  }
  const message = error.message;
  const isAdapterMessage = message.startsWith(`${displayName} `) || message.startsWith(`${adapterId} `);
  const isBoundMessage = /^Provider response exceeded the \d+-byte hard limit$/u.test(message);
  return (isAdapterMessage || isBoundMessage) && message.length <= 1_000 && !/[\r\n]/u.test(message)
    ? message
    : fallback;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel("Jevyr provider response byte limit exceeded");
        throw new Error(`Provider response exceeded the ${maxBytes}-byte hard limit`);
      }
      chunks.push(decoder.decode(next.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export class OpenAICompatibleMindAdapter implements ModelAdapter {
  readonly adapterClass = "model" as const;
  readonly capability: CapabilityCard;
  private readonly base: URL;
  readonly #authorization: (() => string) | undefined;
  private readonly options: OpenAICompatibleOptions;

  constructor(options: OpenAICompatibleOptions) {
    if (options.investigationTransport !== undefined && options.investigationTransport !== "native" && options.investigationTransport !== "structured") throw new TypeError("Unknown model investigation transport");
    this.base = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (this.base.username || this.base.password || this.base.search || this.base.hash) throw new TypeError("Provider URL must not contain credentials, query, or fragment");
    if (options.apiKey && options.credential) throw new TypeError("Use one credential source");
    if ((options.credential === undefined) !== (options.secretBroker === undefined)) throw new TypeError("Credential reference requires its broker");
    const { apiKey, secretBroker, ...publicOptions } = options;
    this.options = Object.freeze(publicOptions);
    const credential = options.credential === undefined ? undefined : Object.freeze({ ...options.credential });
    this.#authorization = credential && secretBroker
      ? () => secretBroker.authorization(credential, this.base.origin)
      : apiKey ? () => `Bearer ${apiKey}` : undefined;
    if (!options.allowRemote && !isLoopback(this.base)) {
      throw new Error(`Remote endpoint ${this.base.origin} requires allowRemote=true`);
    }
    if (
      options.maxResponseBytes !== undefined &&
      (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1 || options.maxResponseBytes > MAX_MIND_RAW_OUTPUT_BYTES)
    ) {
      throw new RangeError(`maxResponseBytes must be an integer from 1 through ${MAX_MIND_RAW_OUTPUT_BYTES}`);
    }
    this.capability = {
      id: options.id,
      kind: "mind",
      displayName: options.displayName,
      version: "openai-compatible/1",
      transport: "http",
      trust: "quarantined",
      modalities: ["text", "structured-data"],
      network: isLoopback(this.base) ? "loopback" : "provider",
      canExecuteTools: false,
      deterministic: false,
      limits: { adapterClass: "model", providerId: this.base.origin, modelId: options.model, ...(options.modelFamily ? { modelFamily: options.modelFamily } : {}), investigationTransport: options.investigationTransport ?? "native", seedEnforcement: "unverified", maxModelRounds: INVESTIGATOR_TOOL_POLICY.maximumRounds, investigatorToolsDigest: digestJson(INVESTIGATOR_TOOL_POLICY as unknown as JsonValue), investigationImplementationDigest: investigationImplementationDescriptor().digest },
    };
  }

  private headers(): HeadersInit {
    return {
      "content-type": "application/json",
      ...(this.#authorization ? { authorization: this.#authorization() } : {}),
    };
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    const timeout = AbortSignal.timeout(Math.min(this.options.timeoutMs ?? 5_000, 5_000));
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetch(new URL("models", this.base), {
        headers: this.headers(),
        redirect: "error",
        signal: combined,
      });
      const raw = await readBoundedText(response, 64_000);
      let body: { data?: { id?: string }[] } | undefined;
      try {
        body = parseJsonText(raw, `${this.capability.displayName} model-list response`) as { data?: { id?: string }[] };
      } catch {
        body = undefined;
      }
      const models = body?.data?.map((entry) => entry.id).filter(Boolean).slice(0, 8) ?? [];
      return {
        available: response.ok,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        detail: response.ok
          ? `Endpoint reachable; advertised models: ${models.join(", ") || "not disclosed"}.`
          : `Endpoint returned HTTP ${response.status}.`,
      };
    } catch (error) {
      return {
        available: false,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async runMetered(request: MindRequest): Promise<MindInvocationResult> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 180_000);
    const signal = AbortSignal.any([request.signal, timeout]);
    let lastResponse: ResponseFingerprint | undefined;
    const invoke = async (body: string): Promise<Response> => {
      lastResponse = undefined;
      try { return await fetch(new URL("chat/completions", this.base), { method: "POST", headers: this.headers(), redirect: "error", signal, body }); }
      catch { throw new ProviderTransportFailure({ protocol: "jevyr.provider-failure/1", category: interruptedCategory(signal), retryable: null }); }
    };
    const read = async (response: Response): Promise<string> => {
      const captured = await readDiagnosticResponse(response, response.ok ? this.options.maxResponseBytes ?? MAX_MIND_RAW_OUTPUT_BYTES : Math.min(64_000, this.options.maxResponseBytes ?? MAX_MIND_RAW_OUTPUT_BYTES), signal);
      lastResponse = captured.fingerprint;
      if (!response.ok) {
        // Legacy non-investigation format negotiation examines bounded error
        // text locally. It is never retained in a diagnostic or Error cause.
        try { return new TextDecoder("utf-8", { fatal: true }).decode(captured.bytes); }
        catch { return ""; } // Invalid encoding can never authorize a legacy fallback.
      }
      if (!captured.fingerprint.responseComplete) throw new ProviderTransportFailure({ protocol: "jevyr.provider-failure/1", category: "RESPONSE_BYTE_LIMIT", retryable: null, ...captured.fingerprint });
      return decodeDiagnosticResponse(captured.bytes, captured.fingerprint);
    };
    if (request.investigationTools) return await runModelToolLoop({ ...request, signal }, {
      adapterId: this.capability.id,
      requestEncoding: this.options.investigationTransport ?? "native",
      encode: (messages, tools, maxTokens, finalRound, sourceInspectionRequired, revisionInspectionRequired) => JSON.stringify({
        model: this.options.model, temperature: 0.8, n: 1, messages, max_tokens: maxTokens,
        ...(this.options.investigationTransport === "structured"
          ? { response_format: structuredInvestigationFormat(request, tools, finalRound, sourceInspectionRequired, revisionInspectionRequired) }
          : {
            // The final request preserves observations but offers no callable
            // functions, including to providers that ignore tool_choice:none.
            ...(finalRound ? {} : {
              tools: sourceInspectionRequired ? tools.filter(tool => ["list_subject_files", "read_subject_lines", "search_subject"].includes(tool.function.name))
                : revisionInspectionRequired ? tools.filter(tool => ["list_revision_files", "read_revision_lines"].includes(tool.function.name)) : tools,
              parallel_tool_calls: false,
              // Both declared channels can request inspection. Requiring a
              // native call would forbid a structured multi-file batch while
              // parallel native calls are disabled. Receipts still gate finals.
              tool_choice: "auto",
            }),
            response_format: nativeInvestigationFormat(request, tools, finalRound, sourceInspectionRequired, revisionInspectionRequired),
          }),
      }),
      send: async body => {
        const response = await invoke(body);
        const text = await read(response);
        if (!response.ok) throw new ProviderTransportFailure(httpFailure(response.status, lastResponse!));
        return text;
      },
      failureDiagnostic: boundary => lastResponse && (boundary === "PROVIDER_TRANSPORT" || boundary === "PROVIDER_MESSAGE")
        ? { protocol: "jevyr.provider-failure/1", category: boundary === "PROVIDER_TRANSPORT" ? "RESPONSE_JSON" : "RESPONSE_SCHEMA", retryable: null, ...lastResponse } : undefined,
    });
    const prompt = makePublicMindPrompt(request);
    const promptBytes = utf8Bytes(prompt);
    let attempts = 0;
    let receivedEnvelope = false;
    try {
      const body = {
        model: this.options.model,
        temperature: 0.8,
        n: 1,
        messages: [{ role: "user", content: prompt }],
        ...(request.maxOutputTokens !== undefined ? { max_tokens: request.maxOutputTokens } : {}),
      };
      const invokeMode = async (mode: CompletionResponseMode): Promise<Response> => {
        const format = responseFormat(mode, request);
        return await invoke(JSON.stringify({ ...body, ...(format === undefined ? {} : { response_format: format }) }));
      };
      const modes = completionModes(request);
      let response: Response | undefined;
      let responseText: string | undefined;
      for (const [index, mode] of modes.entries()) {
        if (
          request.maxInputTokens !== undefined
          && promptBytes * (attempts + 1) > request.maxInputTokens
        ) {
          throw new Error(
            `${this.capability.displayName} declined another transport attempt because it would exceed the sealed input-token permission`,
          );
        }
        attempts += 1;
        const candidate = await invokeMode(mode);
        const candidateText = await read(candidate);
        if (candidate.ok || mode === "plain" || index === modes.length - 1) {
          response = candidate;
          responseText = candidateText;
          break;
        }
        if (!lastResponse?.responseComplete || !explicitlyUnsupportedFormat(candidate.status, candidateText, mode)) {
          response = candidate;
          responseText = candidateText;
          break;
        }
      }
      if (response === undefined) throw new Error(`${this.capability.displayName} produced no HTTP response`);
      if (!response.ok) {
        throw new ProviderTransportFailure(httpFailure(response.status, lastResponse!));
      }
      let result: {
        choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
      };
      try {
        result = parseJsonText(responseText!, `${this.capability.displayName} response`) as typeof result;
      } catch {
        throw new ProviderTransportFailure({ protocol: "jevyr.provider-failure/1", category: "RESPONSE_JSON", retryable: null, ...lastResponse });
      }
      receivedEnvelope = true;
      const choice = result.choices?.[0];
      if (choice?.finish_reason === "length") {
        throw new Error(`${this.capability.displayName} truncated its structured output at the configured completion-token limit`);
      }
      if (choice?.finish_reason !== undefined && choice.finish_reason !== null && choice.finish_reason !== "stop") {
        throw new Error(`${this.capability.displayName} ended structured generation without a complete stop`);
      }
      if (typeof choice?.message?.refusal === "string" && choice.message.refusal.trim().length > 0) {
        throw new Error(`${this.capability.displayName} refused the bounded contribution request`);
      }
      const raw = completionText(choice?.message?.content);
      if (raw === undefined || raw.trim().length === 0) {
        throw new Error(`${this.capability.displayName} returned no text content`);
      }
      const contributions = parsePublicContributions(raw, this.capability.id, request, {
        strictStructured: true,
        requireFiniteCandidateSource: request.stage === "diverge",
      });
      const transmittedPrompts = prompt.repeat(attempts);
      return Object.freeze({
        contributions: Object.freeze(contributions),
        ...providerOrConservativeUsage(
          transmittedPrompts,
          raw,
          attempts === 1 ? result.usage?.prompt_tokens : undefined,
          result.usage?.completion_tokens,
        ),
      });
    } catch (error) {
      if (error instanceof MindMeteredFailure) throw error;
      const transportDiagnostic = providerFailureDiagnostic(error);
      const diagnostic = transportDiagnostic ?? (receivedEnvelope && lastResponse
        ? { protocol: "jevyr.provider-failure/1" as const, category: "RESPONSE_SCHEMA" as const, retryable: null, ...lastResponse } : undefined);
      const message = transportDiagnostic?.category.startsWith("HTTP_") ? `${this.capability.displayName} returned HTTP ${transportDiagnostic.httpStatus} (${transportDiagnostic.category})`
        : transportDiagnostic?.category === "RESPONSE_JSON" ? `${this.capability.displayName} returned a malformed completion envelope`
        : transportDiagnostic?.category === "RESPONSE_BYTE_LIMIT" ? `Provider response exceeded the ${this.options.maxResponseBytes ?? MAX_MIND_RAW_OUTPUT_BYTES}-byte hard limit`
        : transportDiagnostic ? `Provider request failed (${transportDiagnostic.category})` : safeMeteredFailureMessage(error, this.capability.displayName, this.capability.id);
      // The metering error crosses into durable public accounting. Do not retain
      // the provider exception as a cause: parser and transport errors may hold
      // rejected private output, endpoint credentials, or request internals.
      throw new MindMeteredFailure(message, promptBytes * attempts, diagnostic ? { boundary: "PROVIDER_TRANSPORT", providerRounds: attempts, tools: [], providerFailure: diagnostic } : undefined);
    }
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    const result = await this.runMetered(request);
    for (const item of result.contributions) yield item;
  }
}

export function ollamaMind(model: string, baseUrl = "http://127.0.0.1:11434/v1/", modelFamily?: string, investigationTransport?: "native" | "structured"): OpenAICompatibleMindAdapter {
  return new OpenAICompatibleMindAdapter({
    id: `mind.ollama.${model}`,
    displayName: `Ollama · ${model}`,
    baseUrl,
    model,
    ...(modelFamily ? { modelFamily } : {}),
    ...(investigationTransport ? { investigationTransport } : {}),
  });
}

export function lmStudioMind(model: string, baseUrl = "http://127.0.0.1:1234/v1/", modelFamily?: string, investigationTransport?: "native" | "structured"): OpenAICompatibleMindAdapter {
  return new OpenAICompatibleMindAdapter({
    id: `mind.lmstudio.${model}`,
    displayName: `LM Studio · ${model}`,
    baseUrl,
    model,
    ...(modelFamily ? { modelFamily } : {}),
    ...(investigationTransport ? { investigationTransport } : {}),
  });
}
