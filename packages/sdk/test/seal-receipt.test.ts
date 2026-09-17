import { describe, expect, it } from "vitest";
import type { SealReceipt } from "../src/types.js";
import { assertSealReceipt } from "../src/verify.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const receipt: SealReceipt = {
  protocol: "jevyr.seal/1",
  caseId: "case_3333333333333333",
  submissionDigest: digest("1"),
  subjectMaterialCaptureDigest: digest("0"),
  caseDigest: digest("2"),
  runDigest: digest("3"),
  sealedAt: "2026-09-04T00:00:00.000Z",
  policyVersion: "jevyr.bone/1",
  policyDigest: digest("4"),
  genomeVersion: "jevyr.genome/1",
  genomeDigest: digest("5"),
  searchDigest: digest("6"),
  intentContractDigest: digest("a"),
};

describe("SealReceipt validation", () => {
  it("accepts the required subject material capture commitment", () => {
    expect(assertSealReceipt(receipt)).toEqual(receipt);
  });

  it("rejects a missing or malformed subject material capture commitment", () => {
    const { subjectMaterialCaptureDigest: _omitted, ...missing } = receipt;
    expect(() => assertSealReceipt(missing)).toThrow("invalid digest");
    expect(() => assertSealReceipt({ ...receipt, subjectMaterialCaptureDigest: digest("A") })).toThrow("invalid digest");
  });

  it("continues to reject unknown receipt fields", () => {
    expect(() => assertSealReceipt({ ...receipt, mutableSubjectLocator: "/tmp/live" })).toThrow("unknown field mutableSubjectLocator");
  });

  it("rejects a Case id not derived from runDigest and non-canonical timestamps", () => {
    expect(() => assertSealReceipt({ ...receipt, caseId: "case_4444444444444444" })).toThrow("derived from runDigest");
    expect(() => assertSealReceipt({ ...receipt, sealedAt: "2026-09-04T00:00:00Z" })).toThrow("canonical UTC timestamp");
    expect(() => assertSealReceipt({ ...receipt, sealedAt: "2026-09-04T02:00:00.000+02:00" })).toThrow("canonical UTC timestamp");
  });
});
