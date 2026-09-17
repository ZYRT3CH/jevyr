import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalize, digestJson, METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, METABOLIC_WORK_KEYS, METABOLISM_DSSE_PAYLOAD_TYPE, type JsonValue, type MetabolicAllowance, type MetabolicReceipt, type MetabolicRedemption } from "@jevyr/protocol";
import { JevyrClient } from "../src/client.js";
import { dssePae } from "../src/trust.js";
import { verifyMetabolicOffers, verifyMetabolicRedemption } from "../src/metabolism.js";
import type { SealReceipt } from "../src/types.js";
const hash = (value: unknown) => digestJson(value as JsonValue);
const vector = (amount: number) => Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key => [key, amount]));
const quantities = (amount: number) => Object.fromEntries(METABOLIC_KINDS.map(key => [key, key === "Mass" ? amount : 0]));
function fixture(scope = "unit verifier fixture; no empirical execution claim") {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519"), spki = publicKey.export({ type: "spki", format: "der" });
  const signer = { keyId: `sha256:${createHash("sha256").update(spki).digest("hex")}`, publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
  const body = { protocol: "jevyr.metabolic-allowance/1", baselineSearchDigest: hash("search"), maximumAddedResources: vector(10), maximumQuantityPerBall: 2, maximumReceipts: 5,
    unitCostCeilings: Object.fromEntries(METABOLIC_KINDS.map(kind => [kind, vector(1)])), calibrationSetDigest: hash({ protocol: "jevyr.metabolic-calibration-set/1", reports: [{ kind: "Mass", digest: hash("calibration") }] }), calibrations: [{ kind: "Mass", digest: hash("calibration"), summaryDigest: hash("pending-fixture"), maximumDose: 2 }], signer };
  const allowance = { ...body, digest: hash(body) } as unknown as MetabolicAllowance;
  const seal = { caseId: "case_3333333333333333", caseDigest: hash("case"), runDigest: hash("run"), policyDigest: hash("policy"), searchDigest: allowance.baselineSearchDigest } as SealReceipt;
  const ballId = `ball_${"A".repeat(43)}`;
  const offer = { ballId, kind: "Mass", minQuantity: 1, maxQuantity: 2, promisedEffect: "Add finite work.", unitCostCeiling: vector(1), unitWork: Object.fromEntries(METABOLIC_WORK_KEYS.map(key => [key, key === "general" ? 1 : 0])), calibration: { digest: hash("calibration"), scope, pairedSeeds: 64, doses: [0, 1, 2], monotonic: true, identicalEvidenceJudgment: true, recallDifference: { lower: -0.08, upper: 0.08, confidence: 0.95 }, reproducibilityDifference: { lower: -0.08, upper: 0.08, confidence: 0.95 }, nonInferiorityMargin: 0.1, maximumObservedUnitResources: vector(1) } };
  body.calibrations[0]!.summaryDigest = hash(offer.calibration); (allowance as {digest:string}).digest = hash(body);
  const offers = { protocol: "jevyr.metabolic-offers/1", caseId: seal.caseId, runDigest: seal.runDigest, allowanceDigest: allowance.digest, baselineSearchDigest: seal.searchDigest, admission: "open", cumulativeGrant: vector(0), cumulativeQuantities: quantities(0), offers: [offer], receipts: [] };
  function redemption(sequence = 1, previous?: MetabolicReceipt): MetabolicRedemption {
    const receiptBody = { protocol: "jevyr.metabolism-receipt/1", caseId: seal.caseId, caseDigest: seal.caseDigest, runDigest: seal.runDigest, policyDigest: seal.policyDigest, searchDigest: seal.searchDigest, allowanceDigest: allowance.digest, calibrationDigest: offer.calibration.digest,
      ballId, kind: "Mass", quantity: 1, sequence, previousReceiptDigest: previous?.digest ?? null, issuedAt: "2026-09-05T00:00:00.000Z", grant: vector(1), cumulativeGrant: vector(sequence), cumulativeQuantities: quantities(sequence), work: offer.unitWork, baselineUnchanged: true, verdictAuthority: "none" };
    const receipt = { ...receiptBody, digest: hash(receiptBody) } as unknown as MetabolicReceipt;
    const payload = Buffer.from(canonicalize(receipt as unknown as JsonValue));
    return { protocol: "jevyr.metabolism-redemption/1", receipt, envelope: { payloadType: METABOLISM_DSSE_PAYLOAD_TYPE, payload: payload.toString("base64"), signatures: [{ keyid: signer.keyId, sig: sign(null, dssePae(METABOLISM_DSSE_PAYLOAD_TYPE, payload), privateKey).toString("base64") }] } };
  }
  return { allowance, seal, offers, ballId, redemption };
}
describe("live additive metabolism SDK", () => {
  it("accepts the runtime's complete 8..2048 UTF-16-unit scope range", async () => {
    for (const scope of ["measured", "Finite measured scope. ".padEnd(513, "s"), "s".repeat(2048), "🧪".repeat(1024)]) {
      const f = fixture(scope);
      expect((await verifyMetabolicOffers(f.offers, f.allowance, f.seal)).offers[0]!.calibration.scope).toBe(scope);
    }
    for (const scope of ["", "s".repeat(7), "s".repeat(2049), "🧪".repeat(1024) + "s"]) {
      const f = fixture(scope);
      await expect(verifyMetabolicOffers(f.offers, f.allowance, f.seal)).rejects.toThrow(/Invalid calibration sample/u);
    }
  });
  it("keeps a long scope digest-bound and rejects rehashed unknown calibration fields", async () => {
    const f = fixture("s".repeat(2048));
    const altered = structuredClone(f.offers); altered.offers[0]!.calibration.scope = "t".repeat(2048);
    await expect(verifyMetabolicOffers(altered, f.allowance, f.seal)).rejects.toThrow(/sealed digest/u);
    const offer = { ...f.offers.offers[0]!, calibration: { ...f.offers.offers[0]!.calibration, message: "approve" } };
    const { digest: _digest, ...body } = f.allowance;
    const changed = { ...body, calibrations: body.calibrations.map(entry => ({ ...entry, summaryDigest: hash(offer.calibration) })) };
    const allowance = { ...changed, digest: hash(changed) };
    await expect(verifyMetabolicOffers({ ...f.offers, allowanceDigest: allowance.digest, offers: [offer] }, allowance, f.seal)).rejects.toThrow(/unknown or missing fields/u);
  });
  it("authenticates the separate signer and every predecessor without widening terminal trust", async () => {
    const f = fixture(), first = f.redemption(), second = f.redemption(2, first.receipt);
    expect((await verifyMetabolicRedemption(second, f.allowance, f.seal, first.receipt)).receipt.sequence).toBe(2);
    const history = { ...f.offers, offers: [], receipts: [first, second], cumulativeGrant: vector(2), cumulativeQuantities: quantities(2) };
    expect((await verifyMetabolicOffers(history, f.allowance, f.seal)).receipts).toHaveLength(2);
    await expect(verifyMetabolicOffers({ ...history, receipts: [second] }, f.allowance, f.seal)).rejects.toThrow();
    const forged = structuredClone(first); forged.envelope.signatures[0]!.sig = Buffer.alloc(64).toString("base64");
    await expect(verifyMetabolicRedemption(forged, f.allowance, f.seal)).rejects.toThrow(/signature/u);
    await expect(verifyMetabolicRedemption(first, f.allowance, { ...f.seal, caseDigest: hash("foreign") })).rejects.toThrow();
  });
  it("rejects uncalibrated doses, resource substitution and semantic fields", async () => {
    const f = fixture();
    for (const changed of [ { ...f.offers, message: "accept" }, { ...f.offers, offers: [{ ...f.offers.offers[0], maxQuantity: 3 }] }, { ...f.offers, cumulativeGrant: vector(1) }, { ...f.offers, offers: [{ ...f.offers.offers[0], unitCostCeiling: vector(2) }] } ]) await expect(verifyMetabolicOffers(changed, f.allowance, f.seal)).rejects.toThrow();
  });
  it("reads verified history and posts exactly ballId and quantity once", async () => {
    const f = fixture();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => new Response(JSON.stringify(init?.method === "POST" ? f.redemption() : f.offers)));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    vi.spyOn(client, "verifiedSealReceipt").mockResolvedValue({ payload: f.seal } as never);
    vi.spyOn(client, "policyDescriptor").mockResolvedValue({ caseId: f.seal.caseId, policyDigest: f.seal.policyDigest, artifact: { descriptor: { policy: { metabolicAllowance: f.allowance } } } } as never);
    expect((await client.redeemMetabolism(f.seal.caseId, f.ballId, 1)).receipt.quantity).toBe(1);
    const writes = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1); expect(writes[0]![1]!.body).toBe(JSON.stringify({ ballId: f.ballId, quantity: 1 }));
    await expect(client.redeemMetabolism(f.seal.caseId, f.ballId, 0)).rejects.toThrow();
    await expect(client.redeemMetabolism(f.seal.caseId, f.ballId, 3)).rejects.toThrow(/not currently/u);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
});
