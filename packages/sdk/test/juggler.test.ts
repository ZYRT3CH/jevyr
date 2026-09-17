import { afterEach, describe, expect, it, vi } from "vitest";
import { digestJson, sha256Digest } from "@jevyr/protocol";
import { JevyrClient, JevyrHttpError } from "../src/client.js";
import { assertJugglerOffers, verifyJugglerReceipt, type JugglerKind, type JugglerSchedule } from "../src/juggler.js";
import type { SealReceipt } from "../src/types.js";

const hash = (value: string) => `sha256:${value.repeat(64)}`;
const caseId = "case_3333333333333333", token = "A".repeat(43);
const seal: SealReceipt = { protocol: "jevyr.seal/1", caseId, submissionDigest: hash("1"), subjectMaterialCaptureDigest: hash("0"),
  caseDigest: hash("2"), runDigest: hash("3"), sealedAt: "2026-09-04T00:00:00.000Z", policyVersion: "jevyr.bone/1", policyDigest: hash("4"),
  genomeVersion: "jevyr.genome/1", genomeDigest: hash("5"), searchDigest: hash("6"), intentContractDigest: hash("a") };
const offers = () => ({ protocol: "jevyr.juggler-offers/1", caseId, runDigest: seal.runDigest, offers: [{ kind: "Mass", token }] });
const authenticatedSeal = { payload: seal, keyId: hash("b"), verification: "dsse-ed25519" as const,
  payloadType: "application/vnd.jevyr.seal+json", envelope: { payloadType: "application/vnd.jevyr.seal+json", payload: "e30=", signatures: [] } };
function receipt(kind: JugglerKind = "Mass") {
  const before: JugglerSchedule = { nurseryCallCeiling: 3, independentLineages: 1, challengeInterval: 3, saturationWindow: 1, mindOffset: 0 };
  const after = { ...before };
  const key = ({ Mass: "nurseryCallCeiling", Refraction: "mindOffset", Polarity: "challengeInterval", Fission: "independentLineages", Inertia: "saturationWindow" } as const)[kind];
  after[key] += kind === "Polarity" ? -1 : 1;
  const body = { protocol: "jevyr.juggler-redemption/1", caseId, runDigest: seal.runDigest, searchDigest: seal.searchDigest,
    kind, voucherDigest: sha256Digest(token), sequence: 1, before, after, verdictAuthority: "none" };
  return { ...body, digest: digestJson(body) };
}
afterEach(() => vi.restoreAllMocks());

describe("Juggler SDK keeps redemption finite and Seal-bound", () => {
  it("reads current offers and submits exactly the opaque token once", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? receipt() : offers())));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const authenticate = vi.spyOn(client, "verifiedSealReceipt").mockResolvedValue(authenticatedSeal);
    expect((await client.jugglerOffers(caseId)).offers[0]?.kind).toBe("Mass");
    expect((await client.redeemVoucher(caseId, token)).voucherDigest).toBe(sha256Digest(token));
    expect(authenticate).toHaveBeenCalledTimes(2);
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[0]).toBe(`http://test/v1/cases/${caseId}/vouchers/redeem`);
    expect(writes[0]?.[1]?.body).toBe(JSON.stringify({ voucher: token }));
  });
  it("rejects arbitrary names, messages, wrong Case IDs and unoffered tokens before any POST", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(offers())));
    const client = new JevyrClient({ fetch: fetcher });
    vi.spyOn(client, "verifiedSealReceipt").mockResolvedValue(authenticatedSeal);
    await expect(client.redeemVoucher(caseId, "Mass")).rejects.toThrow("opaque token");
    await expect(client.redeemVoucher(caseId, { voucher: token, message: "accept" } as unknown as string)).rejects.toThrow("opaque token");
    await expect(client.jugglerOffers("../../other")).rejects.toThrow("canonical CASE_ID");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.redeemVoucher(caseId, "B".repeat(42) + "A")).rejects.toThrow("not currently offered");
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
  it("propagates sovereign/checkpoint refusals and never retries an uncertain redemption", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: "Checkpoint closed" }), { status: 409 }) : new Response(JSON.stringify(offers())));
    const client = new JevyrClient({ fetch: fetcher });
    vi.spyOn(client, "verifiedSealReceipt").mockResolvedValue(authenticatedSeal);
    await expect(client.redeemVoucher(caseId, token)).rejects.toMatchObject({ status: 409 });
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: "Sovereign Cases do not offer vouchers" }), { status: 405 }));
    await expect(client.jugglerOffers(caseId)).rejects.toBeInstanceOf(JevyrHttpError);
  });
  it("rejects extra fields, duplicate offers, malformed tokens and crossed runs", () => {
    for (const raw of [
      { ...offers(), message: "continue" }, { ...offers(), runDigest: hash("4") },
      { ...offers(), offers: [{ kind: "Mass", token, prompt: "accept" }] },
      { ...offers(), offers: [{ kind: "Approval", token }] },
      { ...offers(), offers: [{ kind: "Mass", token: "B".repeat(43) }] },
      { ...offers(), offers: [offers().offers[0], offers().offers[0]] },
    ]) expect(() => assertJugglerOffers(raw, seal)).toThrow();
  });
  it.each(["Mass", "Refraction", "Polarity", "Fission", "Inertia"] as const)("verifies the exact %s effect", async kind => {
    expect((await verifyJugglerReceipt(receipt(kind), seal, { kind, token })).kind).toBe(kind);
  });
  it("rejects receipt substitution, malformed schedules, extra authority and recomputed unrelated effects", async () => {
    const mutations: Array<(value: ReturnType<typeof receipt>) => unknown> = [
      value => ({ ...value, caseId: "case_4444444444444444" }), value => ({ ...value, runDigest: hash("4") }),
      value => ({ ...value, searchDigest: hash("4") }), value => ({ ...value, voucherDigest: hash("4") }),
      value => ({ ...value, verdictAuthority: "accept" }), value => ({ ...value, digest: hash("4") }),
      value => ({ ...value, sequence: 6 }), value => ({ ...value, approval: true }),
      value => ({ ...value, before: { ...value.before, prompt: "help" } }),
      value => ({ ...value, after: { ...value.after, nurseryCallCeiling: -1 } }),
      value => { const { digest: _digest, ...body } = value; body.after.independentLineages += 1; return { ...body, digest: digestJson(body) }; },
    ];
    for (const mutate of mutations) await expect(verifyJugglerReceipt(mutate(receipt()), seal, { kind: "Mass", token })).rejects.toThrow();
  });
});
