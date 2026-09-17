import { describe, expect, it } from "vitest";
import {
  createSearchEnvelope,
  digestJson,
  sealedCaseIdentityDigest,
  sha256Digest,
  type SealedCase,
} from "@jevyr/protocol";
import { assertSealedCase } from "../src/verify.js";

function fixture(): SealedCase {
  const impulse = "Discriminate the exact text.";
  const unsignedContract = {
    protocol: "jevyr.intent-contract/1" as const,
    compilerVersion: "jevyr.intent-compiler/1" as const,
    originalImpulse: impulse,
    originalImpulseDigest: sha256Digest(impulse),
    goal: { statement: impulse, source: "whole_impulse" as const },
    subjectIds: ["input"],
    explicitConstraints: [],
    requestedAssays: [],
    successConditions: [{
      id: "success-1",
      kind: "success" as const,
      statement: "The obligation is proven.",
      source: "kernel" as const,
      obligationIds: ["obligation-1"],
    }],
    failureConditions: [{
      id: "failure-1",
      kind: "failure" as const,
      statement: "The obligation is refuted.",
      source: "kernel" as const,
      obligationIds: ["obligation-1"],
    }],
    ambiguities: [],
    alternativeInterpretations: [],
    criticalObligations: [{
      id: "obligation-1",
      statement: impulse,
      origin: "impulse" as const,
      critical: true as const,
      assayability: "UNASSAYABLE" as const,
      unassayableReason: "No sealed oracle was supplied.",
    }],
  };
  const intentContract = { ...unsignedContract, digest: digestJson(unsignedContract) };
  const text = "unrepeatable input";
  const intent = {
    impulse,
    mode: "design" as const,
    subjects: [{
      id: "input",
      kind: "text" as const,
      locator: text,
      revision: "input-v1",
      mediaType: "text/plain; charset=utf-8",
    }],
    constraints: ["offline"],
    requestedAssays: [],
    privacy: "local_only" as const,
    control: "sovereign" as const,
    seed: "sdk-sealed-case",
  };
  const subjects = [{
    subjectId: "input",
    digest: sha256Digest(text),
    resolvedLocator: "inline:input",
    revision: "input-v1",
    capturedAt: "2026-09-04T11:59:59.000Z",
    byteLength: new TextEncoder().encode(text).byteLength,
    mediaType: "text/plain; charset=utf-8",
  }];
  const searchEnvelope = createSearchEnvelope({
    attemptSafetyCeiling: "1500000000000000000000",
    nursery: { minimumAttempts: 6, saturationWindow: 4, independentLineages: 4, challengeInterval: 3 },
    resources: {
      maxMindInvocations: 12,
      maxInputTokens: 262_144,
      maxOutputTokens: 131_072,
      maxWallMillis: 900_000,
      maxSingleInvocationMillis: 120_000,
      maxGeneratedBytes: 50_000_000,
      maxForgeCpuMillis: 120_000,
      maxForgeWallMillis: 180_000,
      maxMemorySeconds: 30,
      maxWritableBytes: 100_000_000,
      maxWritableInodes: 10_000,
      maxArtifactBytes: 20_000_000,
      maxNetworkBytes: 0,
      concurrentLineages: 4,
      maxTotalAssayCost: 1_000,
    },
    seedDerivation: "sha256-run-digest-frontier-v1",
  });
  const subjectMaterialCaptureDigest = `sha256:${"1".repeat(64)}`;
  const caseDigest = sealedCaseIdentityDigest({
    intent,
    intentContractDigest: intentContract.digest,
    subjectMaterialCaptureDigest,
    subjects,
  });
  const sealedAt = "2026-09-04T12:00:00.000Z";
  const policyDigest = `sha256:${"2".repeat(64)}`;
  const genomeDigest = `sha256:${"3".repeat(64)}`;
  const runDigest = digestJson({
    caseDigest,
    policyVersion: "jevyr.bone/1",
    policyDigest,
    genomeVersion: "jevyr.genome/1",
    genomeDigest,
    searchDigest: searchEnvelope.digest,
    seed: intent.seed,
    sealedAt,
  });
  return {
    protocol: "jevyr.case/1",
    caseId: `case_${runDigest.slice(7, 23)}`,
    submissionDigest: `sha256:${"4".repeat(64)}`,
    subjectMaterialCaptureDigest,
    caseDigest,
    runDigest,
    sealedAt,
    policyVersion: "jevyr.bone/1",
    policyDigest,
    genomeVersion: "jevyr.genome/1",
    genomeDigest,
    searchEnvelope,
    intentContractDigest: intentContract.digest,
    intentContract,
    intent,
    subjects,
  };
}

function reidentify(value: SealedCase): SealedCase {
  const mutable = value as unknown as Record<string, unknown>;
  const caseDigest = sealedCaseIdentityDigest({
    intent: value.intent,
    intentContractDigest: value.intentContractDigest,
    subjectMaterialCaptureDigest: value.subjectMaterialCaptureDigest,
    subjects: value.subjects,
  });
  const runDigest = digestJson({
    caseDigest,
    policyVersion: value.policyVersion,
    policyDigest: value.policyDigest,
    genomeVersion: value.genomeVersion,
    genomeDigest: value.genomeDigest,
    searchDigest: value.searchEnvelope.digest,
    seed: value.intent.seed,
    sealedAt: value.sealedAt,
  });
  mutable.caseDigest = caseDigest;
  mutable.runDigest = runDigest;
  mutable.caseId = `case_${runDigest.slice(7, 23)}`;
  return value;
}

describe("SealedCase verification", () => {
  it("returns a fully validated canonical Case", () => {
    expect(assertSealedCase(fixture())).toEqual(fixture());
  });

  it.each([
    ["unknown intent state", (value: any) => { value.intent.pleaseHuman = true; }],
    ["unknown subject-reference state", (value: any) => { value.intent.subjects[0].live = true; }],
    ["an invalid snapshot media type", (value: any) => { value.subjects[0].mediaType = "freeform"; }],
    ["a fractional snapshot byte length", (value: any) => { value.subjects[0].byteLength = 2.5; }],
    ["a substituted text digest", (value: any) => { value.subjects[0].digest = `sha256:${"f".repeat(64)}`; }],
    ["snapshot/reference media drift", (value: any) => { value.subjects[0].mediaType = "application/json"; }],
    ["a future capture time", (value: any) => { value.subjects[0].capturedAt = "2026-09-04T12:00:00.001Z"; }],
    ["a missing snapshot", (value: any) => { value.subjects = []; }],
  ])("rejects %s even under recomputed Case and Run digests", (_label, mutate) => {
    const candidate = structuredClone(fixture());
    mutate(candidate);
    reidentify(candidate);
    expect(() => assertSealedCase(candidate)).toThrow(/SealedCase violates the canonical contract/);
  });
});
