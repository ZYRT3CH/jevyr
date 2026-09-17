import { describe, expect, it, vi } from "vitest";
import { JevyrClient, JevyrContinuityError, JevyrHttpError } from "../src/client.js";
import { canonicalJson, sha256Digest } from "../src/digest.js";
import type { AuthenticatedRecord, JevyrRecord } from "../src/types.js";
import { assertCaseEvent } from "../src/verify.js";

const caseDigest = `sha256:${"a".repeat(64)}`;
const runDigest = `sha256:${"b".repeat(64)}`;

async function firstEvent() {
  const unsigned = {
    protocol: "jevyr.event/1" as const,
    caseDigest,
    runDigest,
    sequence: 1,
    priorDigest: null,
    observedAt: "2026-09-04T00:00:00.000Z",
    stage: "cast" as const,
    kind: "stage.status" as const,
    actor: { id: "bone", kind: "kernel" as const },
    payload: { stage: "cast" as const, status: "completed" as const, summary: "Cast received." },
  };
  return { ...unsigned, eventDigest: await sha256Digest(canonicalJson(unsigned)) };
}

async function secondEvent(priorDigest: string) {
  const unsigned = {
    protocol: "jevyr.event/1" as const,
    caseDigest,
    runDigest,
    sequence: 2,
    priorDigest,
    observedAt: "2026-09-04T00:00:01.000Z",
    stage: "terminate" as const,
    kind: "stage.status" as const,
    actor: { id: "bone", kind: "kernel" as const },
    payload: { stage: "terminate" as const, status: "completed" as const, summary: "Case terminated." },
  };
  return { ...unsigned, eventDigest: await sha256Digest(canonicalJson(unsigned)) };
}

function status(
  headDigest: string | null,
  lastSequence = headDigest === null ? 0 : 1,
  lifecycle: "running" | "terminated" | "invalid" = "terminated",
) {
  return {
    protocol: "jevyr.status/1" as const,
    caseDigest,
    runDigest,
    lifecycle,
    stage: lifecycle === "running" ? "self_scan" as const : "terminate" as const,
    stageStatus: lifecycle === "running" ? "working" as const : "completed" as const,
    lastSequence,
    headDigest,
    updatedAt: "2026-09-04T00:00:01.000Z",
  };
}

function searchResources() {
  return [
    "mindInvocations", "inputTokens", "outputTokens", "wallMillis", "singleInvocationMillis",
    "generatedBytes", "forgeCpuMillis", "forgeWallMillis", "memorySeconds", "writableBytes",
    "writableInodes", "artifactBytes", "networkBytes", "concurrentLineages", "totalAssayCost",
  ].map((name) => ({ name, used: null, ceiling: 100, measurement: "DECLARED_ONLY" as const }));
}

describe("JevyrClient", () => {
  it("rejects duplicate-key and malformed-UTF-8 JSON endpoint bodies", async () => {
    const canonical = JSON.stringify(status(null, 0, "running"));
    const ambiguous = canonical.replace(
      '"protocol":"jevyr.status/1"',
      '"protocol":"jevyr.status/1","\\u0070rotocol":"jevyr.status/1"',
    );
    const duplicateClient = new JevyrClient({
      baseUrl: "http://test",
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(ambiguous)),
    });
    await expect(duplicateClient.status("case_abc")).rejects.toThrow("duplicate object key");

    const malformedClient = new JevyrClient({
      baseUrl: "http://test",
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(Uint8Array.from([0x7b, 0xff, 0x7d]))),
    });
    await expect(malformedClient.status("case_abc")).rejects.toThrow("not valid UTF-8");
  });

  it("refuses an oversized JSON endpoint before buffering its advertised body", async () => {
    const client = new JevyrClient({
      baseUrl: "http://test",
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("{}", {
        headers: { "content-length": String(32 * 1_048_576 + 1) },
      })),
    });
    await expect(client.status("case_abc")).rejects.toThrow("exceeds the 33554432-byte limit");
  });

  it("requires an exact canonical timestamp on every status snapshot", async () => {
    const event = await firstEvent();
    const { updatedAt: _updatedAt, ...incomplete } = status(event.eventDigest);
    const client = new JevyrClient({
      baseUrl: "http://test",
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(incomplete)),
    });
    await expect(client.status("case_abc")).rejects.toThrow("invalid updatedAt");
  });

  it("retries a transient initial status read before opening the observer", async () => {
    const event = await firstEvent();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)))
      .mockResolvedValueOnce(new Response(`id: 1\ndata: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const frames = [];
    for await (const frame of client.liveEvents("case_abc", {
      reconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
    })) frames.push(frame);
    expect(frames.map((frame) => frame.cursor)).toEqual([1]);
  });

  it("falls back to cursor polling and preserves canonical continuity", async () => {
    const event = await firstEvent();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)))
      .mockResolvedValueOnce(new Response("no", { status: 503 }))
      .mockResolvedValueOnce(
        Response.json({
          protocol: "jevyr.live/1",
          caseDigest,
          runDigest,
          afterSequence: 0,
          throughSequence: 1,
          headDigest: event.eventDigest,
          caughtUp: true,
          events: [event],
          polledAt: "2026-09-04T00:00:01.000Z",
        }),
      )
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const frames = [];
    for await (const frame of client.liveEvents("case_abc", { maxSseFailures: 1, pollWaitMs: 0 })) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      cursor: 1,
      transport: "poll",
      continuity: "verified",
      verificationScope: "event-hash-chain",
      headDigest: event.eventDigest,
    });
  });

  it("uses a numeric Last-Event-ID when resuming SSE", async () => {
    const event = await firstEvent();
    const payload = `id: 1\ndata: ${JSON.stringify(event)}\n\n`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)))
      .mockResolvedValueOnce(new Response(payload, { headers: { "content-type": "text/event-stream" } }))
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const frames = [];
    for await (const frame of client.events("case_abc")) frames.push(frame);
    expect(frames[0]?.event).toEqual(event);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ "last-event-id": "0" }) });
  });

  it("reconnects SSE from the exact accepted cursor without replaying an event", async () => {
    const first = await firstEvent();
    const second = await secondEvent(first.eventDigest);
    const eventStream = (event: unknown) => new Response(
      `id: ${(event as { sequence: number }).sequence}\ndata: ${JSON.stringify(event)}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(null, 0, "running")))
      .mockResolvedValueOnce(eventStream(first))
      .mockResolvedValueOnce(Response.json(status(first.eventDigest, 1, "running")))
      .mockResolvedValueOnce(eventStream(second))
      .mockResolvedValueOnce(Response.json(status(second.eventDigest, 2, "terminated")));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const frames = [];
    for await (const frame of client.liveEvents("case_abc", {
      reconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
    })) frames.push(frame);

    expect(frames.map((frame) => frame.cursor)).toEqual([1, 2]);
    expect(fetcher.mock.calls[3]?.[0]).toBe("http://test/v1/cases/case_abc/events/stream?after=1");
    expect(fetcher.mock.calls[3]?.[1]).toMatchObject({
      headers: expect.objectContaining({ "last-event-id": "1" }),
    });
  });

  it("refuses duplicate SSE sequences instead of silently discarding them", async () => {
    const event = await firstEvent();
    const payload = `id: 1\ndata: ${JSON.stringify(event)}\n\nid: 1\ndata: ${JSON.stringify(event)}\n\n`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)))
      .mockResolvedValueOnce(new Response(payload, { headers: { "content-type": "text/event-stream" } }));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(async () => {
      for await (const _frame of client.liveEvents("case_abc")) {
        // The first event is accepted; the duplicate makes the stream fail.
      }
    }).rejects.toThrow("Event gap: expected 2, received 1");
  });

  it("rejects duplicate JSON members in SSE data before granting event authority", async () => {
    const event = await firstEvent();
    const ambiguous = JSON.stringify(event).replace(
      '"protocol":"jevyr.event/1"',
      '"protocol":"jevyr.event/1","\\u0070rotocol":"jevyr.event/1"',
    );
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)))
      .mockResolvedValueOnce(new Response(`id: 1\ndata: ${ambiguous}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(async () => {
      for await (const _frame of client.liveEvents("case_abc")) {
        // Ambiguous JSON must be refused before the first frame is yielded.
      }
    }).rejects.toThrow("invalid or ambiguous JSON");
  });

  it("requires every SSE CaseEvent to carry its exact numeric event id", async () => {
    const event = await firstEvent();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(event)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(async () => {
      for await (const _frame of client.liveEvents("case_abc")) {
        // The generator refuses the event before yielding authority.
      }
    }).rejects.toThrow("SSE id is missing");
  });

  it("backs off and resumes cursor polling after transient poll failures", async () => {
    const event = await firstEvent();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(null, 0, "running")))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        protocol: "jevyr.live/1",
        caseDigest,
        runDigest,
        afterSequence: 0,
        throughSequence: 1,
        headDigest: event.eventDigest,
        caughtUp: true,
        events: [event],
        polledAt: "2026-09-04T00:00:01.000Z",
      }))
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const frames = [];
    for await (const frame of client.liveEvents("case_abc", {
      maxSseFailures: 1,
      pollWaitMs: 0,
      reconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
    })) frames.push(frame);
    expect(frames.map((frame) => [frame.cursor, frame.transport])).toEqual([[1, "poll"]]);
  });

  it("refuses a polling page that claims unseen events but advances no cursor", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(null, 0, "running")))
      .mockResolvedValueOnce(Response.json({
        protocol: "jevyr.live/1",
        caseDigest,
        runDigest,
        afterSequence: 0,
        throughSequence: 0,
        headDigest: null,
        caughtUp: false,
        events: [],
        polledAt: "2026-09-04T00:00:01.000Z",
      }));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(async () => {
      for await (const _frame of client.liveEvents("case_abc", { preferSse: false, pollWaitMs: 0 })) {
        // No frame can be accepted from a non-progressing page.
      }
    }).rejects.toThrow("made no cursor progress");
  });

  it("rejects content that does not match eventDigest", async () => {
    const event = { ...(await firstEvent()), payload: { stage: "cast", status: "completed", summary: "tampered" } };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(status(event.eventDigest)))
      .mockResolvedValueOnce(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(async () => {
      for await (const _frame of client.events("case_abc")) {
        // The generator fails before yielding.
      }
    }).rejects.toBeInstanceOf(JevyrContinuityError);
  });

  it("rejects a rehashed event with a non-canonical timestamp", async () => {
    const base = await firstEvent();
    const { eventDigest: _digest, ...unsigned } = base;
    const nonCanonical = { ...unsigned, observedAt: "2026-09-04T00:00:00Z" };
    const event = { ...nonCanonical, eventDigest: await sha256Digest(canonicalJson(nonCanonical)) };
    await expect(assertCaseEvent(event, {
      sequence: 1,
      priorDigest: null,
      caseDigest,
      runDigest,
    })).rejects.toThrow("canonical UTC timestamp");
  });

  it("accepts protocol-defined search telemetry", async () => {
    const unsigned = {
      protocol: "jevyr.event/1" as const,
      caseDigest,
      runDigest,
      sequence: 1,
      priorDigest: null,
      observedAt: "2026-09-04T00:00:00.000Z",
      stage: "diverge" as const,
      kind: "search.status" as const,
      actor: { id: "search", kind: "kernel" as const },
      payload: {
        layer: "HYPOTHESIS_NURSERY" as const,
        status: "exploring" as const,
        attempted: 17,
        attemptSafetyCeiling: "1500000000000000000000",
        resources: searchResources(),
        hypothesisNursery: {
          exactDistinctHypotheses: 6,
          scars: 1,
          declaredMechanismLabels: ["substrate-state"],
          exactYieldAge: 2,
        },
        summary: "The frontier is still changing.",
      },
    };
    const searchEvent = { ...unsigned, eventDigest: await sha256Digest(canonicalJson(unsigned)) };
    await expect(assertCaseEvent(searchEvent, { sequence: 1, priorDigest: null, caseDigest, runDigest })).resolves.toEqual(searchEvent);
  });

  it("rejects rehashed legacy fields and a 129-digit attempt guard", async () => {
    const canonicalPayload = {
      layer: "HYPOTHESIS_NURSERY" as const,
      status: "exploring" as const,
      attempted: 17,
      attemptSafetyCeiling: "9".repeat(128),
      resources: searchResources(),
      hypothesisNursery: {
        exactDistinctHypotheses: 6,
        scars: 1,
        declaredMechanismLabels: ["substrate-state"],
        exactYieldAge: 2,
      },
      summary: "The frontier is still changing.",
    };
    const event = async (payload: Record<string, unknown>) => {
      const unsigned = {
        protocol: "jevyr.event/1" as const,
        caseDigest,
        runDigest,
        sequence: 1,
        priorDigest: null,
        observedAt: "2026-09-04T00:00:00.000Z",
        stage: "diverge" as const,
        kind: "search.status" as const,
        actor: { id: "search", kind: "kernel" as const },
        payload,
      };
      return { ...unsigned, eventDigest: await sha256Digest(canonicalJson(unsigned)) };
    };

    const legacy = await event({ ...canonicalPayload, effortUsed: 3 });
    const overlong = await event({ ...canonicalPayload, attemptSafetyCeiling: "9".repeat(129) });
    await expect(assertCaseEvent(legacy, { sequence: 1, priorDigest: null, caseDigest, runDigest }))
      .rejects.toThrow("canonical payload contract");
    await expect(assertCaseEvent(overlong, { sequence: 1, priorDigest: null, caseDigest, runDigest }))
      .rejects.toThrow("at most 128 digits");
  });

  it("keeps trace binding distinct from persisted-evidence replay when waiting", async () => {
    const head = await firstEvent();
    const record = {
      caseDigest,
      runDigest,
      eventHeadDigest: head.eventDigest,
    } as unknown as JevyrRecord;
    const authenticated: AuthenticatedRecord = {
      payload: record,
      envelope: {
        payloadType: "application/vnd.jevyr.record+json",
        payload: "e30=",
        signatures: [{ keyid: caseDigest, sig: "AA==" }],
      },
      keyId: caseDigest,
      payloadType: "application/vnd.jevyr.record+json",
      verification: "dsse-ed25519",
      verificationScope: "dsse-signature+seal-provenance",
      persistedEvidence: "not-replayed",
    };
    const terminal = {
      protocol: "jevyr.terminal/1" as const,
      caseId: "case_abc",
      caseDigest,
      runDigest,
      lifecycle: "terminated" as const,
      stage: "terminate" as const,
      stageStatus: "completed" as const,
      lastSequence: 1,
      eventHeadDigest: head.eventDigest,
      recordDigest: await sha256Digest(canonicalJson(record)),
      artifactIndexDigest: await sha256Digest(canonicalJson({
        protocol: "jevyr.artifacts/1",
        caseId: "case_abc",
        artifacts: [],
      })),
      closedAt: head.observedAt,
    };
    const authenticatedTerminal = {
      payload: terminal,
      envelope: {
        payloadType: "application/vnd.jevyr.terminal+json",
        payload: "e30=",
        signatures: [{ keyid: caseDigest, sig: "AA==" }],
      },
      keyId: caseDigest,
      payloadType: "application/vnd.jevyr.terminal+json",
      verification: "dsse-ed25519" as const,
    };
    const client = new JevyrClient({ baseUrl: "http://test", fetch: vi.fn<typeof fetch>() });
    vi.spyOn(client, "liveEvents").mockImplementation(async function* () {});
    vi.spyOn(client, "authenticatedRecord")
      .mockRejectedValueOnce(new JevyrHttpError(409, "Record is not available yet"))
      .mockResolvedValue(authenticated);
    vi.spyOn(client, "authenticatedTerminalReceipt").mockResolvedValue(authenticatedTerminal);
    vi.spyOn(client, "artifactList").mockResolvedValue({
      protocol: "jevyr.artifacts/1",
      caseId: "case_abc",
      artifacts: [],
    });
    vi.spyOn(client, "status").mockResolvedValue({ ...status(head.eventDigest), updatedAt: head.observedAt });
    vi.spyOn(client, "pollEvents").mockResolvedValue({
      protocol: "jevyr.live/1",
      caseDigest,
      runDigest,
      afterSequence: 0,
      throughSequence: 1,
      headDigest: head.eventDigest,
      caughtUp: true,
      events: [head],
      polledAt: "2026-09-04T00:00:01.000Z",
    });

    await expect(client.waitForAuthenticatedRecord("case_abc", {
      reconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
    })).resolves.toMatchObject({
      traceVerification: "event-hash-chain+signed-terminal-head",
      persistedEvidence: "not-replayed",
      payload: record,
      terminal: authenticatedTerminal,
    });
    expect(client.authenticatedRecord).toHaveBeenCalledTimes(2);
  });
});
