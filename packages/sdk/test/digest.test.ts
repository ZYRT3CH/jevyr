import { describe, expect, it } from "vitest";
import type { CaseEvent, LifecycleStage } from "@jevyr/protocol";
import { canonicalJson, sha256Digest, verifyEventChain } from "../src/digest.js";

const caseDigest = `sha256:${"a".repeat(64)}`;
const runDigest = `sha256:${"b".repeat(64)}`;

async function event(
  sequence: number,
  priorDigest: string | null,
  stage: LifecycleStage,
): Promise<CaseEvent> {
  const unsigned = {
    protocol: "jevyr.event/1" as const,
    caseDigest,
    runDigest,
    sequence,
    priorDigest,
    observedAt: `2026-09-04T00:00:0${sequence}.000Z`,
    stage,
    kind: "stage.status" as const,
    actor: { id: "jevyr.bone", kind: "kernel" as const },
    payload: { stage, status: "completed" as const, summary: `${stage} completed.` },
  };
  return { ...unsigned, eventDigest: await sha256Digest(canonicalJson(unsigned)) };
}

describe("offline event-chain verification", () => {
  it("rejects a rehashed event whose discriminator payload is outside the closed schema", async () => {
    const valid = await event(1, null, "cast");
    const { eventDigest: _ignored, ...unsigned } = valid;
    const malformedUnsigned = {
      ...unsigned,
      payload: { ...unsigned.payload, callerApproval: true },
    };
    const malformed = {
      ...malformedUnsigned,
      eventDigest: await sha256Digest(canonicalJson(malformedUnsigned)),
    } as unknown as CaseEvent;
    const result = await verifyEventChain([malformed]);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("field is not part of this protocol version");
  });

  it("rejects a canonically rehashed lifecycle stage regression", async () => {
    const first = await event(1, null, "terminate");
    const second = await event(2, first.eventDigest, "cast");
    const result = await verifyEventChain([first, second]);
    expect(result.valid).toBe(false);
    expect(result.problems).toContain("sequence 2: lifecycle regressed from terminate to cast");
  });
});
