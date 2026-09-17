import { afterEach, describe, expect, it, vi } from "vitest";
import { JevyrClient, JevyrHttpError, type MetabolicOffers, type MetabolicRedemption } from "@jevyr/sdk";
import { main } from "../src/main.js";
import { assertCommandInvocation, parseArguments } from "../src/arguments.js";

const caseId = "case_3333333333333333", token = "A".repeat(43);
const offers = { protocol: "jevyr.metabolic-offers/1", caseId, runDigest: `sha256:${"3".repeat(64)}`, admission: "open", receipts: [], offers: [{ kind: "Mass", ballId: `ball_${token}`, minQuantity: 1, maxQuantity: 2 }] } as unknown as MetabolicOffers;
afterEach(() => vi.restoreAllMocks());

describe("Juggler CLI", () => {
  it("lists finite offers without redeeming or printing tokens in human output", async () => {
    vi.spyOn(JevyrClient.prototype, "metabolismOffers").mockResolvedValue(offers);
    const redeem = vi.spyOn(JevyrClient.prototype, "redeemMetabolism");
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["juggler", caseId])).toBe(0);
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(text).toContain("Available additions: Mass (1–2)"); expect(text).toContain("Verdict authority: none");
    expect(text).not.toContain(token); expect(redeem).not.toHaveBeenCalled();
  });
  it("resolves the chosen enum to its currently offered token and returns the verified receipt", async () => {
    vi.spyOn(JevyrClient.prototype, "metabolismOffers").mockResolvedValue(offers);
    const receipt = { protocol: "jevyr.metabolism-redemption/1", receipt: { caseId, kind: "Mass", quantity: 2, verdictAuthority: "none", digest: `sha256:${"a".repeat(64)}` } } as MetabolicRedemption;
    const redeem = vi.spyOn(JevyrClient.prototype, "redeemMetabolism").mockResolvedValue(receipt);
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(await main(["juggler", caseId, "--redeem", "Mass", "--quantity", "2", "--json"])).toBe(0);
    expect(redeem).toHaveBeenCalledExactlyOnceWith(caseId, `ball_${token}`, 2);
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toEqual(receipt);
  });
  it("refuses unoffered kinds and propagates sovereign or closed-checkpoint errors", async () => {
    const read = vi.spyOn(JevyrClient.prototype, "metabolismOffers").mockResolvedValue(offers);
    const redeem = vi.spyOn(JevyrClient.prototype, "redeemMetabolism");
    await expect(main(["juggler", caseId, "--redeem", "Fission"])).rejects.toThrow("not currently offered");
    expect(redeem).not.toHaveBeenCalled();
    read.mockRejectedValue(new JevyrHttpError(405, "Sovereign Cases do not offer vouchers"));
    await expect(main(["juggler", caseId])).rejects.toMatchObject({ status: 405 });
    read.mockRejectedValue(new JevyrHttpError(409, "Scheduler checkpoint closed"));
    await expect(main(["juggler", caseId])).rejects.toMatchObject({ status: 409 });
  });
  it("rejects extra positions, semantic fields, malformed tokens-as-kinds, and unsupported options before network use", () => {
    for (const argv of [
      ["juggler"], ["juggler", "case_bad"], ["juggler", caseId, "accept"],
      ["juggler", caseId, "--message", "accept"], ["juggler", caseId, "--constraint", "accept"],
      ["juggler", caseId, "--redeem", token], ["juggler", caseId, "--redeem=Mass=accept"],
      ["juggler", caseId, "--redeem", "Mass", "--redeem", "Fission"], ["juggler", caseId, "--tui"],
      ["juggler", caseId, "--quantity", "2"], ["juggler", caseId, "--redeem", "Mass", "--quantity", "0"], ["juggler", caseId, "--redeem", "Mass", "--quantity", "65"],
    ]) expect(() => assertCommandInvocation(parseArguments(argv))).toThrow();
    expect(parseArguments(["cast", "hello", "--constraint=x=y"]).options.get("constraint")).toEqual(["x=y"]);
  });
});
