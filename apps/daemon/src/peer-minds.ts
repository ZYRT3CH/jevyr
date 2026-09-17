import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { parseJsonBytes } from "@jevyr/core";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import {
  EnvironmentSecretBroker, secretReference, conservativeUsage, makePublicMindPrompt, parsePublicContributions,
  MindMeteredFailure, MAX_MIND_RAW_OUTPUT_BYTES, stableId,
  type CapabilityCard, type MindAdapter, type MindInvocationResult, type MindRequest, type ProbeResult, type PublicContribution, type SecretReference,
} from "@jevyr/runtime";
import { transportObject, transportKeys } from "./transports.js";

interface PeerConfig {
  readonly id: string; readonly endpoint: string; readonly allowRemote: boolean; readonly timeoutMs: number;
  readonly credential?: SecretReference;
}

async function readResponse(response: Response, maximum: number): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/u.test(declared) || Number(declared) > maximum)) throw new Error("Peer response exceeds the admitted byte bound");
  if (!response.body) throw new Error("Peer returned no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximum) throw new Error("Peer response exceeds the admitted byte bound");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks, total);
}

/** Each invocation creates one independent A2A task. No task is continued. */
export class A2aPeerMindAdapter implements MindAdapter {
  readonly capability: CapabilityCard;
  readonly #broker: EnvironmentSecretBroker | undefined;
  readonly #config: PeerConfig;
  constructor(config: PeerConfig, environment: NodeJS.ProcessEnv = process.env) {
    const endpoint = new URL(config.endpoint);
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/u.test(config.id) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !["http:", "https:"].includes(endpoint.protocol)) throw new TypeError("Invalid peer id or endpoint");
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
    if (!local && (!config.allowRemote || endpoint.protocol !== "https:")) throw new TypeError("Remote peers require allowRemote and HTTPS");
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 180_000) throw new TypeError("Peer timeout must be 1-180000 milliseconds");
    this.#config = Object.freeze({ ...config, endpoint: endpoint.toString().replace(/\/$/u, "") });
    this.#broker = config.credential ? new EnvironmentSecretBroker([config.credential], environment) : undefined;
    this.capability = Object.freeze({
      id: config.id, kind: "mind", displayName: config.id, version: "jevyr.a2a-peer-mind/1", transport: "a2a", trust: "quarantined",
      modalities: ["text", "structured-data"] as const, network: local ? "loopback" : "provider", canExecuteTools: false, deterministic: false,
      limits: { timeoutMs: config.timeoutMs, endpointDigest: digestJson({ endpoint: this.#config.endpoint }), singleShot: true },
    });
  }
  #headers(): Record<string, string> {
    return { "content-type": "application/a2a+json", "a2a-version": "1.0", "x-jevyr-peer-dispatch": "one-shot", ...(this.#config.credential ? { authorization: this.#broker!.authorization(this.#config.credential, this.#config.endpoint) } : {}) };
  }
  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    let available = false;
    try {
      const response = await fetch(new URL("/.well-known/agent-card.json", this.#config.endpoint), { headers: this.#headers(), redirect: "error", signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(5_000)]) });
      if (response.ok) {
        const card = transportObject(parseJsonBytes(await readResponse(response, 65_536), "Peer card"), "Peer card");
        available = Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.some((raw) => {
          if (!raw || typeof raw !== "object") return false;
          const entry = raw as Record<string, unknown>;
          return entry.protocolVersion === "1.0" && entry.protocolBinding === "HTTP+JSON" && typeof entry.url === "string" && entry.url.replace(/\/$/u, "") === this.#config.endpoint;
        });
      } else await response.body?.cancel();
    } catch { available = false; }
    return { available, observedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started), detail: available ? "Configured A2A 1.0 peer is available." : "Configured A2A peer is unavailable." };
  }
  async runMetered(request: MindRequest): Promise<MindInvocationResult> {
    const prompt = makePublicMindPrompt(request);
    const inputBytes = Buffer.byteLength(prompt);
    if (request.maxInputTokens !== undefined && inputBytes > request.maxInputTokens) throw new MindMeteredFailure("Peer prompt exceeds the remaining input bound", 0);
    let transmitted = false;
    try {
      const maximum = Math.min(MAX_MIND_RAW_OUTPUT_BYTES, request.maxOutputTokens ?? MAX_MIND_RAW_OUTPUT_BYTES);
      // Only the runtime's privacy-projected prompt crosses this boundary. Raw
      // SealedCase objects and local subject locators are never serialized.
      const body = JSON.stringify({ message: { messageId: stableId("peer", { runDigest: request.sealed.runDigest, stage: request.stage, seed: request.seed }), role: "ROLE_USER", parts: [{ text: prompt, mediaType: "text/plain" }] }, configuration: { returnImmediately: false, acceptedOutputModes: ["application/json"], historyLength: 0 } });
      transmitted = true;
      const response = await fetch(`${this.#config.endpoint}/message:send`, { method: "POST", headers: this.#headers(), body, redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(this.#config.timeoutMs)]) });
      if (!response.ok) { await response.body?.cancel(); throw new Error("Peer invocation failed"); }
      const bytes = await readResponse(response, maximum);
      const envelope = transportObject(parseJsonBytes(bytes, "Peer A2A response"), "Peer A2A response");
      const task = envelope.task === undefined ? undefined : transportObject(envelope.task, "Peer task");
      if (task && transportObject(task.status, "Peer status").state !== "TASK_STATE_COMPLETED") throw new Error("Peer failed to return a completed one-shot task");
      const message = envelope.message === undefined ? undefined : transportObject(envelope.message, "Peer message");
      if ((task === undefined) === (message === undefined)) throw new Error("Peer must return exactly one task or message");
      const parts = message?.parts ?? (Array.isArray(task?.artifacts) ? task.artifacts.flatMap((entry) => transportObject(entry, "Peer artifact").parts ?? []) : []);
      if (!Array.isArray(parts) || parts.length < 1 || parts.length > 16) throw new Error("Peer returned invalid result parts");
      const contributions: PublicContribution[] = [];
      for (const partValue of parts) {
        const part = transportObject(partValue, "Peer result part");
        if (typeof part.text === "string") contributions.push(...parsePublicContributions(part.text, this.capability.id, request));
        else if (part.data !== undefined) {
          const data = transportObject(part.data, "Peer data");
          if (Array.isArray(data.contributions)) contributions.push(...parsePublicContributions(JSON.stringify(data), this.capability.id, request, { strictStructured: true }));
          else if (data.protocol === "jevyr.record/1") contributions.push({ id: stableId("peer-record", { peer: this.capability.id, data: data.runDigest }), kind: "claim", summary: `External peer returned a signed Record for ${String(data.caseId).slice(0, 100)}; its judgment is an unverified witness claim.`, body: JSON.stringify(data).slice(0, 12_000) });
        }
      }
      if (contributions.length < 1 || contributions.length > 12) throw new Error("Peer returned no bounded contributions");
      return { contributions: contributions.map((entry) => ({ ...entry, evidenceRefs: [], tags: [...(entry.tags ?? []), "quarantined-peer", this.capability.id] })), ...conservativeUsage(prompt, Buffer.from(bytes).toString("utf8")) };
    } catch { throw new MindMeteredFailure("Configured A2A peer failed its bounded one-shot invocation", transmitted ? inputBytes : 0); }
  }
  async *run(request: MindRequest): AsyncIterable<PublicContribution> { yield* (await this.runMetered(request)).contributions; }
}

export interface LoadedPeerMinds { readonly minds: readonly MindAdapter[]; readonly descriptor: JsonValue; readonly digest: string }

/** Fixed pre-Cast peers; credential values remain inside the broker. */
export function loadPeerMinds(env: NodeJS.ProcessEnv, projectRoot: string): LoadedPeerMinds {
  const configured = env.JEVYR_PEERS_FILE;
  const configs: PeerConfig[] = [];
  if (configured !== undefined) {
    if (!configured.trim() || configured.includes("\0")) throw new TypeError("JEVYR_PEERS_FILE must be a nonempty path");
    const path = resolve(projectRoot, configured);
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1n || before.size > 65_536n) throw new TypeError("Peer config must be a bounded regular file");
    const actual = realpathSync(path);
    const fromRoot = relative(realpathSync(projectRoot), actual);
    if (!isAbsolute(configured) && (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot))) throw new TypeError("Relative peer config escaped the project root");
    const bytes = readFileSync(path);
    const after = lstatSync(path, { bigint: true });
    if (after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size) throw new TypeError("Peer config changed during startup");
    const value = transportObject(parseJsonBytes(bytes, "Peer config"), "Peer config");
    transportKeys(value, ["protocol", "peers"], "Peer config");
    if (value.protocol !== "jevyr.peers/1" || !Array.isArray(value.peers) || value.peers.length > 8) throw new TypeError("Peer config requires jevyr.peers/1 and at most eight peers");
    for (const raw of value.peers) {
      const entry = transportObject(raw, "Peer configuration");
      transportKeys(entry, ["id", "endpoint", "allowRemote", "timeoutMs", "credentialReference"], "Peer configuration");
      if (typeof entry.id !== "string" || typeof entry.endpoint !== "string" || (entry.allowRemote !== undefined && typeof entry.allowRemote !== "boolean") || (entry.timeoutMs !== undefined && typeof entry.timeoutMs !== "number") || (entry.credentialReference !== undefined && typeof entry.credentialReference !== "string")) throw new TypeError("Invalid peer configuration fields");
      configs.push({ id: entry.id, endpoint: entry.endpoint, allowRemote: entry.allowRemote === true, timeoutMs: entry.timeoutMs as number | undefined ?? 180_000, ...(entry.credentialReference ? { credential: secretReference(entry.credentialReference, entry.endpoint) } : {}) });
    }
    if (new Set(configs.map((entry) => entry.id)).size !== configs.length) throw new TypeError("Peer ids must be unique");
  }
  const minds = configs.map((config) => new A2aPeerMindAdapter(config, env));
  const descriptor = { protocol: "jevyr.peer-minds/1", peers: configs.map((config) => ({ id: config.id, endpoint: config.endpoint, allowRemote: config.allowRemote, timeoutMs: config.timeoutMs, credentialReference: config.credential ?? null })) } as unknown as JsonValue;
  return Object.freeze({ minds: Object.freeze(minds), descriptor: Object.freeze(descriptor), digest: digestJson(descriptor) });
}
