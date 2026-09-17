import { stableId } from "./canonical.js";
import type { CapabilityCard, PeerAdapter, ProbeResult, PublicContribution, SealedPeerTask } from "./contracts.js";

export interface HttpPeerOptions {
  readonly id: string;
  readonly displayName: string;
  readonly endpoint: string;
  readonly bearerToken?: string;
  readonly allowRemote?: boolean;
  readonly timeoutMs?: number;
}

function loopback(url: URL): boolean {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
}

/** One-shot peer dispatch. There is deliberately no follow-up or continuation method. */
export class HttpOneShotPeerAdapter implements PeerAdapter {
  readonly capability: CapabilityCard;
  private readonly endpoint: URL;

  constructor(private readonly options: HttpPeerOptions) {
    this.endpoint = new URL(options.endpoint);
    if (!options.allowRemote && !loopback(this.endpoint)) throw new Error("Remote peers require allowRemote=true");
    this.capability = {
      id: options.id,
      kind: "peer",
      displayName: options.displayName,
      version: "jevyr-peer/1",
      transport: "a2a",
      trust: "quarantined",
      modalities: ["text", "structured-data"],
      network: loopback(this.endpoint) ? "loopback" : "provider",
      canExecuteTools: false,
      deterministic: false,
    };
  }

  private headers(): HeadersInit {
    return {
      "content-type": "application/json",
      ...(this.options.bearerToken ? { authorization: `Bearer ${this.options.bearerToken}` } : {}),
    };
  }

  async probe(signal?: AbortSignal): Promise<ProbeResult> {
    const started = performance.now();
    try {
      const response = await fetch(new URL("./.well-known/agent-card.json", this.endpoint), {
        headers: this.headers(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
      });
      return {
        available: response.ok,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - started),
        detail: response.ok ? "Peer agent card is reachable." : `Peer returned HTTP ${response.status}.`,
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

  async *dispatch(task: SealedPeerTask): AsyncIterable<PublicContribution> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.any([task.signal, AbortSignal.timeout(this.options.timeoutMs ?? 180_000)]),
      body: JSON.stringify({
        protocol: "jevyr.peer-task/1",
        taskId: task.taskId,
        caseDigest: task.sealed.caseDigest,
        runDigest: task.sealed.runDigest,
        impulse: task.sealed.intent.impulse,
        subjects: task.sealed.intent.subjects,
        assignment: task.assignment,
        evidenceRefs: task.evidenceRefs,
        replyMode: "single-final",
      }),
    });
    if (!response.ok) throw new Error(`Peer returned HTTP ${response.status}`);
    const body = (await response.json()) as { contributions?: unknown[] };
    for (const [index, raw] of (body.contributions ?? []).slice(0, 12).entries()) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.summary !== "string") continue;
      yield {
        id: stableId("peer", { peer: this.capability.id, task: task.taskId, index, summary: item.summary }),
        kind: ["interpretation", "claim", "observation", "candidate", "challenge", "test-plan", "repair", "reflex"].includes(
          String(item.kind),
        )
          ? (item.kind as PublicContribution["kind"])
          : "claim",
        summary: item.summary.slice(0, 1_000),
        ...(typeof item.body === "string" ? { body: item.body.slice(0, 12_000) } : {}),
        tags: [this.capability.id, "quarantined-peer"],
      };
    }
  }
}
