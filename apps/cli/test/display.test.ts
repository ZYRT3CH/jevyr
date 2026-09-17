import { describe, expect, it } from "vitest";
import type { JevyrRecord, SealReceipt } from "@jevyr/sdk";
import { renderRecord, renderSealReceipt } from "../src/display.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

describe("CLI public Seal receipt", () => {
  it("shows the immutable subject material commitment in human output", () => {
    const receipt: SealReceipt = {
      protocol: "jevyr.seal/1",
      caseId: "case_abcdefgh",
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

    expect(renderSealReceipt(receipt)).toBe([
      receipt.caseId,
      `sealed ${receipt.caseDigest}`,
      `subjectMaterialCaptureDigest=${receipt.subjectMaterialCaptureDigest}`,
      `watch: jevyr watch ${receipt.caseId}`,
    ].join("\n"));
  });
});

describe("CLI authenticated Record language", () => {
  it("labels VALID as the recorded verdict rather than an independent replay result", () => {
    const record = {
      caseDigest: digest("1"),
      runDigest: digest("2"),
      eventHeadDigest: digest("3"),
      verdict: {
        integrity: "VALID",
        creation: "CREATED",
        embodiment: "BUILT",
        judgment: "ACCEPT",
        policyVersion: "jevyr.bone/1",
      },
    } as JevyrRecord;

    expect(renderRecord(record)).toContain("recorded-verdict integrity=VALID");
    expect(renderRecord(record).startsWith("VALID")).toBe(false);
  });
});
