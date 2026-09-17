import { describe, expect, it, vi } from "vitest";
import { JevyrClient, JevyrContinuityError, assertReadiness, type JevyrReadiness } from "../src/index.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const READY: JevyrReadiness = {
  protocol: "jevyr.readiness/1",
  ready: true,
  scope: "infrastructure",
  observedAt: "2026-09-05T10:00:00.000Z",
  semanticContinuation: false,
  models: {
    status: "ready",
    mode: "local",
    configuredCount: 2,
    availableCount: 2,
    reasoningConfiguredCount: 1,
    reasoningAvailableCount: 1,
    adapters: [
      {
        id: "mind.ollama.qwen3-coder:30b-32k",
        role: "reasoning",
        configured: true,
        transport: "http",
        network: "loopback",
        probe: { status: "available", observedAt: "2026-09-05T10:00:00.000Z", latencyMs: 4 },
      },
      {
        id: "mind.rule.v1",
        role: "template",
        configured: true,
        transport: "in-process",
        network: "none",
        probe: { status: "available", observedAt: "2026-09-05T10:00:00.000Z", latencyMs: 0 },
      },
    ],
  },
  forge: {
    id: "tool.forge.docker.v1",
    mode: "docker",
    configured: true,
    status: "ready",
    canExecuteTools: true,
    network: "none",
    probe: { status: "available", observedAt: "2026-09-05T10:00:00.000Z", latencyMs: 8 },
    evidenceAuthority: "verified-docker",
    substrate: { status: "resolved", immutableImageId: digest("a") },
    usable: true,
  },
  assays: {
    status: "admitted",
    mode: "comparative-only",
    count: 1,
    ids: ["jevyr.experiment.node-v1"],
    frontierDigest: digest("b"),
    caseApplicability: "case-dependent",
  },
  blockers: [],
};

describe("readiness client", () => {
  it("fetches and strictly validates the read-only readiness surface", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(READY));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const controller = new AbortController();
    await expect(client.readiness(controller.signal)).resolves.toEqual(READY);
    expect(fetcher).toHaveBeenCalledWith("http://test/v1/readiness", expect.objectContaining({
      signal: controller.signal,
      headers: expect.objectContaining({ accept: "application/json" }),
    }));
  });

  it("rejects a ready bit that contradicts unavailable infrastructure", () => {
    const contradictory = structuredClone(READY) as unknown as Record<string, unknown>;
    contradictory.ready = false;
    expect(() => assertReadiness(contradictory)).toThrow(JevyrContinuityError);
  });

  it("rejects raw adapter detail fields at the no-secrets boundary", () => {
    const hostile = structuredClone(READY) as unknown as {
      models: { adapters: Array<{ probe: Record<string, unknown> }> };
    };
    hostile.models.adapters[0]!.probe.detail = "C:\\private\\provider-token";
    expect(() => assertReadiness(hostile)).toThrow(/missing or unknown fields/u);
  });
});
