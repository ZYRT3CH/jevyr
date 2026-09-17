import { describe, expect, it } from "vitest";
import { JevyrClient } from "../src/client.js";
import { digestJson } from "@jevyr/protocol";

const value = {
  protocol: "jevyr.genome-lab/1",
  active: { version: "genome/1", digest: `sha256:${"a".repeat(64)}`, source: "baseline", selectionDigest: digestJson({}), descriptor: {} },
  governance: { startupBound: true, requiresBenchmarkEvidence: true, requiresGovernanceSignature: true, semanticPromotion: false },
  offspring: [], truncated: false,
};
describe("Genome Lab is an inspection surface", () => {
  it("uses GET and validates startup binding", async () => {
    const client = new JevyrClient({ fetch: (async (url: string, init: RequestInit) => {
      expect(url).toMatch(/\/v1\/genome-lab$/u);
      expect(init.method ?? "GET").toBe("GET");
      return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    }) as typeof fetch });
    expect((await client.genomeLab()).active.digest).toBe(value.active.digest);
  });
  it("refuses a server claiming mutable governance", async () => {
    const client = new JevyrClient({ fetch: (async () => new Response(JSON.stringify({ ...value, governance: { ...value.governance, semanticPromotion: true } }))) as typeof fetch });
    await expect(client.genomeLab()).rejects.toThrow("Invalid Genome Lab");
  });
  it("refuses a changed selection descriptor under an existing digest", async () => {
    const client = new JevyrClient({ fetch: (async () => new Response(JSON.stringify({ ...value, active: { ...value.active, descriptor: { tampered: true } } }))) as typeof fetch });
    await expect(client.genomeLab()).rejects.toThrow("descriptor digest mismatch");
  });
  it("checks self-judgment intake content addresses without treating them as governance", async () => {
    const body = { protocol: "jevyr.self-judge-offspring-request/1", source: { caseId: "case_0123456789abcdef", runDigest: value.active.digest }, candidateGenomeDigest: value.active.digest,
      decision: "REQUESTED_NO_GOVERNED_PARENT", proposedChange: "Challenge observed failures", activeGenomeChanged: false, governanceSignature: null, failures: [{ code: "REPRODUCED", evidenceDigest: value.active.digest }] };
    const request = { ...body, digest: digestJson(body) };
    let returned = request;
    const client = new JevyrClient({ fetch: (async () => new Response(JSON.stringify({ ...value, selfJudgmentRequests: [returned] }))) as typeof fetch });
    expect((await client.genomeLab()).selfJudgmentRequests?.[0]?.digest).toBe(request.digest);
    returned = { ...request, proposedChange: "Changed after storage" };
    await expect(client.genomeLab()).rejects.toThrow("intake digest mismatch");
  });
});
