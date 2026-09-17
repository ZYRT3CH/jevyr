import { describe, expect, it } from "vitest";
import { canonicalize, createSearchEnvelope, type CaseSubmission } from "@jevyr/protocol";
import { decodeDsseJson, generateSigningKeyPair, sealCase, sealReceipt, signDsse, signSealReceipt, verifyDsse } from "../src/index.js";

const provenance = {
  policyDigest: `sha256:${"1".repeat(64)}`,
  genomeDigest: `sha256:${"2".repeat(64)}`,
  subjectMaterialCaptureDigest: `sha256:${"5".repeat(64)}`,
  searchEnvelope: createSearchEnvelope({
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
  }),
} as const;

describe("sealing", () => {
  it("binds normalized intent, immutable snapshots, genome, policy, and seed", () => {
    const submission: CaseSubmission = {
      protocol: "jevyr.case/1",
      case: {
        impulse: "  Find a counterexample.  ",
        constraints: ["offline", "offline", "read-only"],
        subjects: [{ id: "repo", kind: "git", locator: ".", revision: "abc123" }],
      },
    };
    const sealed = sealCase(submission, {
      policyVersion: "bone/1",
      genomeVersion: "genome/7",
      ...provenance,
      sealedAt: "2026-09-04T12:00:00.000Z",
      subjectSnapshots: [{ subjectId: "repo", digest: `sha256:${"a".repeat(64)}`, resolvedLocator: "/case/repo", revision: "abc123", capturedAt: "2026-09-04T11:59:59.000Z" }],
    });

    submission.case.impulse = "try to mutate the source object";
    expect(sealed.intent.impulse).toBe("Find a counterexample.");
    expect(sealed.intent.constraints).toEqual(["offline", "read-only"]);
    expect(sealed.caseDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sealed.runDigest).not.toBe(sealed.caseDigest);
    expect(Object.isFrozen(sealed.intent)).toBe(true);
  });

  it("requires every declared subject to have a content-addressed snapshot", () => {
    expect(() => sealCase(
      { protocol: "jevyr.case/1", case: { impulse: "Judge this", subjects: [{ id: "repo", kind: "git", locator: "." }] } },
      { policyVersion: "bone/1", genomeVersion: "genome/1", ...provenance, sealedAt: "2026-09-04T12:00:00.000Z" },
    )).toThrow(/not snapshotted/);
  });

  it("gives repeated executions distinct run identities while retaining one case digest", () => {
    const submission: CaseSubmission = {
      protocol: "jevyr.case/1",
      case: { impulse: "Try the same sealed task again.", seed: "held-seed" },
    };
    const first = sealCase(submission, {
      policyVersion: "bone/1",
      genomeVersion: "genome/1",
      ...provenance,
      sealedAt: "2026-09-04T12:00:00.000Z",
    });
    const second = sealCase(submission, {
      policyVersion: "bone/1",
      genomeVersion: "genome/1",
      ...provenance,
      sealedAt: "2026-09-04T12:00:00.001Z",
    });

    expect(second.caseDigest).toBe(first.caseDigest);
    expect(second.runDigest).not.toBe(first.runDigest);
    expect(second.caseId).not.toBe(first.caseId);
  });

  it("changes Case identity with captured material and only run identity with runtime provenance", () => {
    const submission: CaseSubmission = { protocol: "jevyr.case/1", case: { impulse: "Bind the concrete runtime." } };
    const base = { policyVersion: "bone/1", genomeVersion: "genome/1", ...provenance, sealedAt: "2026-09-04T12:00:00.000Z" };
    const first = sealCase(submission, base);
    const changedPolicy = sealCase(submission, { ...base, policyDigest: `sha256:${"3".repeat(64)}` });
    const changedGenome = sealCase(submission, { ...base, genomeDigest: `sha256:${"4".repeat(64)}` });
    const changedSearch = sealCase(submission, {
      ...base,
      searchEnvelope: createSearchEnvelope({
        ...provenance.searchEnvelope.profile,
        resources: { ...provenance.searchEnvelope.profile.resources, maxMindInvocations: 13 },
      }),
    });
    const changedMaterial = sealCase(submission, {
      ...base,
      subjectMaterialCaptureDigest: `sha256:${"6".repeat(64)}`,
    });

    expect(changedPolicy.caseDigest).toBe(first.caseDigest);
    expect(changedGenome.caseDigest).toBe(first.caseDigest);
    expect(changedSearch.caseDigest).toBe(first.caseDigest);
    expect(changedMaterial.caseDigest).not.toBe(first.caseDigest);
    expect(new Set([first.runDigest, changedPolicy.runDigest, changedGenome.runDigest, changedSearch.runDigest]).size).toBe(4);
    expect(sealReceipt(first)).toMatchObject({
      policyDigest: provenance.policyDigest,
      genomeDigest: provenance.genomeDigest,
      searchDigest: provenance.searchEnvelope.digest,
      subjectMaterialCaptureDigest: provenance.subjectMaterialCaptureDigest,
    });
  });

  it("refuses to create a new Seal without an immutable material commitment", () => {
    const options = {
      policyVersion: "bone/1",
      genomeVersion: "genome/1",
      ...provenance,
      sealedAt: "2026-09-04T12:00:00.000Z",
    };
    expect(() => sealCase(
      { protocol: "jevyr.case/1", case: { impulse: "Bind the captured subject." } },
      { ...options, subjectMaterialCaptureDigest: undefined as never },
    )).toThrow(/subjectMaterialCaptureDigest/);
  });
});

describe("DSSE Ed25519 signing", () => {
  it("signs and verifies a canonical seal receipt and rejects substitution", () => {
    const keys = generateSigningKeyPair();
    const sealed = sealCase(
      { protocol: "jevyr.case/1", case: { impulse: "Invent and test a mechanism." } },
      { policyVersion: "bone/1", genomeVersion: "genome/1", ...provenance, sealedAt: "2026-09-04T12:00:00.000Z" },
    );
    const envelope = signSealReceipt(sealReceipt(sealed), keys.privateKeyPem);
    expect(verifyDsse(envelope, new Map([[keys.keyId, keys.publicKeyPem]]))).toBe(true);

    const tampered = { ...envelope, payload: Buffer.from(canonicalize({ fake: true })).toString("base64") };
    expect(verifyDsse(tampered, new Map([[keys.keyId, keys.publicKeyPem]]))).toBe(false);
  });

  it("rejects active envelopes, noncanonical base64, and malformed UTF-8 JSON", () => {
    const keys = generateSigningKeyPair();
    const binary = signDsse("application/octet-stream", Uint8Array.of(0), keys.privateKeyPem);
    expect(verifyDsse(
      { ...binary, payload: binary.payload.replace(/=+$/u, "") },
      new Map([[keys.keyId, keys.publicKeyPem]]),
    )).toBe(false);

    const malformedJson = signDsse("application/json", Uint8Array.of(0xff), keys.privateKeyPem);
    expect(() => decodeDsseJson(malformedJson)).toThrow(/encoded data|UTF-8/iu);

    let reads = 0;
    const active = { ...binary } as Record<string, unknown>;
    Object.defineProperty(active, "payload", {
      enumerable: true,
      get() {
        reads += 1;
        return binary.payload;
      },
    });
    expect(verifyDsse(active as never, new Map([[keys.keyId, keys.publicKeyPem]]))).toBe(false);
    expect(reads).toBe(0);
  });
});
