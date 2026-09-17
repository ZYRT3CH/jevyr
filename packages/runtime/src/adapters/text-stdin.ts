import { parseJsonText } from "@jevyr/core";
import { digestJson } from "@jevyr/protocol";
import type { CapabilityCard, MindAdapter, MindInvocationResult, MindRequest, ProbeResult, PublicContribution } from "../contracts.js";
import { decodeExactByteCapture } from "../evidence-artifacts.js";
import { conservativeUsage, MAX_MIND_RAW_OUTPUT_BYTES, MindMeteredFailure } from "../mind-metering.js";
import { runBoundedProcess } from "../process.js";
import { makePublicMindPrompt, parsePublicContributions } from "./prompt.js";
import { quarantinedProviderEnvironment, rejectCallerWorkingDirectory, withQuarantinedMindWorkspace } from "./process-quarantine.js";

const MAX_INPUT_BYTES = 2_000_000;
const MAX_ARG_BYTES = 65_536;
const MAX_TIMEOUT_MS = 24 * 60 * 60_000;

export interface TextStdinMindOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Defaults to ["--version"]. [] is an explicit empty-stdin probe. */
  readonly probeArgs?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxInputBytes?: number;
  /** Combined stdout and stderr, also limited by the invocation's token grant. */
  readonly maxOutputBytes?: number;
}

function bound(value: number | undefined, fallback: number, maximum: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new TypeError(`${name} must be an integer from 1 through ${maximum}`);
  return result;
}

function args(value: readonly string[] | undefined, fallback: readonly string[], name: string): readonly string[] {
  const result = value ?? fallback;
  if (!Array.isArray(result) || result.length > 128 || result.some((entry) => typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > 8_192)
    || result.reduce((total, entry) => total + Buffer.byteLength(entry), 0) > MAX_ARG_BYTES) throw new TypeError(`${name} must contain at most 128 bounded NUL-free string arguments`);
  return Object.freeze([...result]);
}

function remaining(value: number | undefined, label: string): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new TypeError(`${label} must be a nonnegative safe integer`);
  return value;
}

/**
 * Explicit host-process bridge: one projected UTF-8 prompt on stdin, one complete
 * JSON contribution envelope on stdout. There is no interactive continuation.
 */
export class TextStdinMindAdapter implements MindAdapter {
  readonly capability: CapabilityCard;
  readonly #options: Required<TextStdinMindOptions>;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(options: TextStdinMindOptions, environment: NodeJS.ProcessEnv = process.env) {
    rejectCallerWorkingDirectory(options, "Text/stdin Mind");
    if (Object.keys(options).some((key) => !["command", "args", "probeArgs", "timeoutMs", "maxInputBytes", "maxOutputBytes"].includes(key))) throw new TypeError("Text/stdin Mind contains an unknown option");
    if (typeof options.command !== "string" || options.command.length < 1 || options.command.length > 4_096
      || options.command.trim() !== options.command || /[\r\n\0]/u.test(options.command)) throw new TypeError("Text/stdin command must be a bounded nonempty executable name or absolute path");
    this.#options = Object.freeze({ command: options.command, args: args(options.args, [], "args"), probeArgs: args(options.probeArgs, ["--version"], "probeArgs"),
      timeoutMs: bound(options.timeoutMs, 180_000, MAX_TIMEOUT_MS, "timeoutMs"),
      maxInputBytes: bound(options.maxInputBytes, MAX_INPUT_BYTES, MAX_INPUT_BYTES, "maxInputBytes"),
      maxOutputBytes: bound(options.maxOutputBytes, MAX_MIND_RAW_OUTPUT_BYTES, MAX_MIND_RAW_OUTPUT_BYTES, "maxOutputBytes") });
    this.#environment = Object.freeze({ ...environment });
    const configurationDigest = digestJson({ protocol: "jevyr.text-stdin-config/1", ...this.#options });
    this.capability = Object.freeze({
      id: "mind.text-stdin.configured", kind: "mind", displayName: "Configured text/stdin Mind",
      // Command/argv mutations must change the daemon's sealed policy identity.
      version: `jevyr.text-stdin/1:${configurationDigest}`,
      transport: "process", trust: "quarantined", modalities: ["text", "structured-data"] as const,
      // Empty cwd is a context boundary, not an OS sandbox for arbitrary code.
      network: "unrestricted", canExecuteTools: true, deterministic: false,
      limits: { configurationDigest, maxInputBytes: this.#options.maxInputBytes, maxOutputBytes: this.#options.maxOutputBytes, timeoutMs: this.#options.timeoutMs, interactive: false },
    });
  }

  #childEnvironment(directory: string): NodeJS.ProcessEnv {
    const environment = quarantinedProviderEnvironment(directory, this.#environment);
    // Do not hand the child daemon configuration or JSON-encoded workspace hints.
    for (const key of Object.keys(environment)) if (key.startsWith("JEVYR_")) delete environment[key];
    return environment;
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    let available = false;
    try {
      if (!signal?.aborted) available = await withQuarantinedMindWorkspace(async (cwd) => {
        const result = await runBoundedProcess({ command: this.#options.command, args: this.#options.probeArgs, cwd,
          env: this.#childEnvironment(cwd), inheritEnv: false, stdin: "", timeoutMs: Math.min(5_000, this.#options.timeoutMs),
          maxOutputBytes: 16_000, terminateOnOutputLimit: true, ...(signal ? { signal } : {}) });
        return result.exitCode === 0 && !result.timedOut && !result.aborted && !result.truncated;
      });
    } catch { available = false; }
    return { available, observedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started),
      detail: available ? "Text/stdin executable probe passed." : "Text/stdin executable probe failed." };
  }

  async runMetered(request: MindRequest): Promise<MindInvocationResult> {
    const prompt = makePublicMindPrompt(request);
    const inputBytes = Buffer.byteLength(prompt);
    const inputLimit = Math.min(this.#options.maxInputBytes, remaining(request.maxInputTokens, "maxInputTokens") ?? this.#options.maxInputBytes);
    const outputLimit = Math.min(this.#options.maxOutputBytes, remaining(request.maxOutputTokens, "maxOutputTokens") ?? this.#options.maxOutputBytes);
    if (request.signal.aborted) throw new MindMeteredFailure("Text/stdin invocation was already aborted", 0);
    if (inputBytes > inputLimit || outputLimit === 0) throw new MindMeteredFailure("Text/stdin invocation exceeds its remaining sealed token grant", 0);
    let transmitted = false;
    try {
      const result = await withQuarantinedMindWorkspace(async (cwd) => {
        transmitted = true;
        return await runBoundedProcess({ command: this.#options.command, args: this.#options.args, cwd,
          env: this.#childEnvironment(cwd), inheritEnv: false, stdin: prompt, timeoutMs: this.#options.timeoutMs,
          maxOutputBytes: outputLimit, terminateOnOutputLimit: true, signal: request.signal });
      });
      if (result.truncated || result.outputBytes > outputLimit) throw new MindMeteredFailure("Text/stdin invocation exceeded its bounded output grant", inputBytes);
      if (result.aborted) throw new MindMeteredFailure("Text/stdin invocation was aborted", inputBytes);
      if (result.timedOut) throw new MindMeteredFailure("Text/stdin invocation timed out", inputBytes);
      if (result.exitCode !== 0) throw new MindMeteredFailure("Text/stdin executable did not exit successfully", inputBytes);
      const stdout = decodeExactByteCapture(result.stdoutCapture);
      const stderr = decodeExactByteCapture(result.stderrCapture);
      if (!result.stdoutCapture.complete || !result.stderrCapture.complete || stdout.text === undefined || stderr.text === undefined) throw new Error("Incomplete or invalid UTF-8 process output");
      // The generic transport accepts no prose recovery, code fences, usage
      // self-report, multiple documents or auxiliary semantic fields.
      const envelope = parseJsonText(stdout.text, "Text/stdin contribution envelope");
      if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope) || Object.keys(envelope).length !== 1 || !("contributions" in envelope)) throw new Error("Invalid contribution envelope");
      const contributions = parsePublicContributions(stdout.text, this.capability.id, request, { strictStructured: true, requireFiniteCandidateSource: request.stage === "diverge" });
      return Object.freeze({ contributions: Object.freeze(contributions), ...conservativeUsage(prompt, stdout.text + stderr.text) });
    } catch (error) {
      if (error instanceof MindMeteredFailure) throw error;
      // Do not persist provider stderr, executable paths, raw JSON or secrets.
      throw new MindMeteredFailure("Text/stdin executable failed to return complete structured UTF-8 contributions", transmitted ? inputBytes : 0);
    }
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> { yield* (await this.runMetered(request)).contributions; }
}

/** Parse startup configuration without shell splitting or replacement decoding. */
export function configuredTextStdinMind(env: NodeJS.ProcessEnv): TextStdinMindAdapter | undefined {
  const command = env.JEVYR_STDIN_COMMAND;
  const fields = ["JEVYR_STDIN_ARGS_JSON", "JEVYR_STDIN_PROBE_ARGS_JSON", "JEVYR_STDIN_TIMEOUT_MS"] as const;
  if (command === undefined) {
    if (fields.some((key) => env[key] !== undefined)) throw new TypeError("Text/stdin options require JEVYR_STDIN_COMMAND");
    return undefined;
  }
  const parseArgs = (key: typeof fields[number]): readonly string[] | undefined => {
    const value = env[key];
    if (value === undefined) return undefined;
    if (Buffer.byteLength(value) > MAX_ARG_BYTES) throw new TypeError(`${key} exceeds its byte bound`);
    let parsed: unknown;
    try { parsed = parseJsonText(value, key); } catch { throw new TypeError(`${key} must contain one valid JSON string array`); }
    if (!Array.isArray(parsed)) throw new TypeError(`${key} must contain a JSON string array`);
    return args(parsed, [], key);
  };
  const commandArgs = parseArgs("JEVYR_STDIN_ARGS_JSON");
  const probeArgs = parseArgs("JEVYR_STDIN_PROBE_ARGS_JSON");
  const rawTimeout = env.JEVYR_STDIN_TIMEOUT_MS;
  if (rawTimeout !== undefined && !/^[1-9][0-9]*$/u.test(rawTimeout)) throw new TypeError("JEVYR_STDIN_TIMEOUT_MS must be a canonical positive integer");
  return new TextStdinMindAdapter({ command, ...(commandArgs ? { args: commandArgs } : {}), ...(probeArgs ? { probeArgs } : {}), ...(rawTimeout === undefined ? {} : { timeoutMs: Number(rawTimeout) }) }, env);
}
