import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  digestJson,
  sha256Digest as protocolSha256Digest,
  type DsseEnvelope,
  type IntentContract,
  type JsonValue,
  type PublicTrustBundle,
  type SealReceipt,
  type SignedRecord,
  type TerminalReceipt,
} from "@jevyr/protocol";
import { canonicalJson } from "../src/digest.js";
import { JevyrClient, JevyrContinuityError } from "../src/client.js";
import { assertIntentContractPayload } from "../src/verify.js";
import {
  RECORD_DSSE_PAYLOAD_TYPE,
  SEAL_DSSE_PAYLOAD_TYPE,
  TERMINAL_DSSE_PAYLOAD_TYPE,
  dssePae,
  verifyRecordEnvelope,
  verifySealEnvelope,
  verifyTerminalEnvelope,
} from "../src/trust.js";

const digest = (character: string): string => `sha256:${character.repeat(64)}`;

function intentContractFixture(): IntentContract {
  const originalImpulse = "Judge the sealed repository against its declared test.";
  const unsigned = {
    protocol: "jevyr.intent-contract/1" as const,
    compilerVersion: "jevyr.intent-compiler/1" as const,
    originalImpulse,
    originalImpulseDigest: protocolSha256Digest(originalImpulse),
    goal: { statement: originalImpulse, source: "whole_impulse" as const },
    subjectIds: ["repository"],
    explicitConstraints: [],
    requestedAssays: ["pnpm test"],
    successConditions: [{
      id: "condition:success",
      kind: "success" as const,
      statement: "Every critical obligation is supported by admissible evidence.",
      source: "kernel" as const,
      obligationIds: ["obligation:assay"],
    }],
    failureConditions: [{
      id: "condition:failure",
      kind: "failure" as const,
      statement: "A critical obligation is refuted or remains unsupported.",
      source: "kernel" as const,
      obligationIds: ["obligation:assay"],
    }],
    ambiguities: [],
    alternativeInterpretations: [],
    criticalObligations: [{
      id: "obligation:assay",
      statement: "pnpm test",
      origin: "requested_assay" as const,
      critical: true as const,
      assayability: "ASSAYABLE" as const,
      oracle: { kind: "requested_assay" as const, operand: "pnpm test", operator: "passes" as const, expected: "pass" },
    }],
  };
  return { ...unsigned, digest: digestJson(unsigned as unknown as JsonValue) };
}

function fixture() {
  const pair = generateKeyPairSync("ed25519");
  const spki = pair.publicKey.export({ type: "spki", format: "der" });
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const keyId = `sha256:${createHash("sha256").update(spki).digest("hex")}`;
  const trust: PublicTrustBundle = {
    protocol: "jevyr.trust-bundle/1",
    keys: [{ keyId, algorithm: "Ed25519", publicKeyPem, payloadTypes: [SEAL_DSSE_PAYLOAD_TYPE, RECORD_DSSE_PAYLOAD_TYPE, TERMINAL_DSSE_PAYLOAD_TYPE] }],
  };
  function envelopeBytes(payloadType: string, bytes: Uint8Array): DsseEnvelope {
    return {
      payloadType,
      payload: Buffer.from(bytes).toString("base64"),
      signatures: [{ keyid: keyId, sig: sign(null, dssePae(payloadType, bytes), pair.privateKey).toString("base64") }],
    };
  }
  function envelope(payloadType: string, payload: unknown): DsseEnvelope {
    return envelopeBytes(payloadType, Buffer.from(canonicalJson(payload)));
  }
  return { trust, envelope, envelopeBytes };
}

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

const record: SignedRecord = {
  protocol: "jevyr.record/1",
  caseDigest: receipt.caseDigest,
  runDigest: receipt.runDigest,
  policyDigest: receipt.policyDigest,
  genomeDigest: receipt.genomeDigest,
  searchDigest: receipt.searchDigest,
  intentContractDigest: receipt.intentContractDigest,
  eventHeadDigest: digest("7"),
  verdict: {
    policyVersion: receipt.policyVersion,
    intentContractDigest: receipt.intentContractDigest,
    evidenceDigest: digest("8"),
    integrity: "VALID",
    creation: "NO_SURVIVOR",
    embodiment: "NOT_BUILT",
    judgment: "NOT_APPLICABLE",
    feasibilityByCandidate: {},
    basis: [],
  },
  reflex: { loop: 1, reviewedEvidenceDigest: digest("8"), intentContractDigest: receipt.intentContractDigest, challengedNodeIds: [], materialFindings: [], decision: "confirm" },
  memoryInfluences: [],
  crystallizedAt: "2026-09-04T00:00:01.000Z",
};

const terminal: TerminalReceipt = {
  protocol: "jevyr.terminal/1",
  caseId: receipt.caseId,
  caseDigest: receipt.caseDigest,
  runDigest: receipt.runDigest,
  lifecycle: "terminated",
  stage: "terminate",
  stageStatus: "completed",
  lastSequence: 8,
  eventHeadDigest: digest("9"),
  recordDigest: digestJson(record as unknown as JsonValue),
  artifactIndexDigest: digestJson({
    protocol: "jevyr.artifacts/1",
    caseId: receipt.caseId,
    artifacts: [],
  }),
  closedAt: "2026-09-04T00:00:02.000Z",
};

describe("DSSE trust verification", () => {
  it("validates the full replay contract including both canonical digests", () => {
    const contract = intentContractFixture();
    expect(assertIntentContractPayload(contract)).toEqual(contract);
    expect(() => assertIntentContractPayload({ ...contract, originalImpulse: `${contract.originalImpulse} tampered` })).toThrow(
      "originalImpulseDigest does not bind",
    );
    expect(() => assertIntentContractPayload({ ...contract, requestedAssays: ["different assay"] })).toThrow(
      "digest does not bind the canonical intent contract",
    );
    expect(() => assertIntentContractPayload({ ...contract, compilerVersion: "jevyr.intent-compiler/999" })).toThrow(
      "must equal jevyr.intent-compiler/1",
    );
    expect(() => assertIntentContractPayload({ ...contract, goal: { ...contract.goal, vote: "human" } })).toThrow(
      "field is not part of this protocol version",
    );
  });

  it("client verifiedIntentContract binds the validated contract to the authenticated SealReceipt", async () => {
    const contract = intentContractFixture();
    const boundReceipt: SealReceipt = { ...receipt, intentContractDigest: contract.digest };
    const { trust, envelope } = fixture();
    const routes: Record<string, unknown> = {
      "/v1/trust": trust,
      "/v1/cases/case_3333333333333333/seal": boundReceipt,
      "/v1/cases/case_3333333333333333/seal/envelope": envelope(SEAL_DSSE_PAYLOAD_TYPE, boundReceipt),
      "/v1/cases/case_3333333333333333/intent-contract": contract,
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      const body = routes[path];
      return body === undefined ? Response.json({ error: "missing" }, { status: 404 }) : Response.json(body);
    });
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(client.intentContract(boundReceipt.caseId)).resolves.toEqual(contract);
    await expect(client.verifiedIntentContract(boundReceipt.caseId)).resolves.toEqual(contract);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("rejects a canonical contract whose digest is not the one authenticated at Seal", async () => {
    const contract = intentContractFixture();
    const { trust, envelope } = fixture();
    const routes: Record<string, unknown> = {
      "/v1/trust": trust,
      "/v1/cases/case_3333333333333333/seal": receipt,
      "/v1/cases/case_3333333333333333/seal/envelope": envelope(SEAL_DSSE_PAYLOAD_TYPE, receipt),
      "/v1/cases/case_3333333333333333/intent-contract": contract,
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      return Response.json(routes[path]);
    });
    await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).verifiedIntentContract(receipt.caseId)).rejects.toBeInstanceOf(
      JevyrContinuityError,
    );
  });

  it("client authenticatedRecord states its exact scope and preserves the verifiedRecord alias", async () => {
    const { trust, envelope } = fixture();
    const routes: Record<string, unknown> = {
      "/v1/trust": trust,
      "/v1/cases/case_3333333333333333/seal": receipt,
      "/v1/cases/case_3333333333333333/seal/envelope": envelope(SEAL_DSSE_PAYLOAD_TYPE, receipt),
      "/v1/cases/case_3333333333333333/record": record,
      "/v1/cases/case_3333333333333333/record/envelope": envelope(RECORD_DSSE_PAYLOAD_TYPE, record),
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      const body = routes[path];
      return body === undefined ? Response.json({ error: "missing" }, { status: 404 }) : Response.json(body);
    });
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    const authenticated = await client.authenticatedRecord(receipt.caseId);
    expect(authenticated).toMatchObject({
      payload: record,
      verification: "dsse-ed25519",
      verificationScope: "dsse-signature+seal-provenance",
      persistedEvidence: "not-replayed",
    });
    await expect(client.verifiedRecord(receipt.caseId)).resolves.toMatchObject({
      verificationScope: "dsse-signature+seal-provenance",
      persistedEvidence: "not-replayed",
    });
    expect(fetcher).toHaveBeenCalledTimes(10);
  });

  it("refuses a Seal and Record that resolve to different advertised keys", async () => {
    const sealSigner = fixture();
    const recordSigner = fixture();
    const trust: PublicTrustBundle = {
      protocol: "jevyr.trust-bundle/1",
      keys: [...sealSigner.trust.keys, ...recordSigner.trust.keys],
    };
    const routes: Record<string, unknown> = {
      "/v1/trust": trust,
      "/v1/cases/case_3333333333333333/seal": receipt,
      "/v1/cases/case_3333333333333333/seal/envelope": sealSigner.envelope(SEAL_DSSE_PAYLOAD_TYPE, receipt),
      "/v1/cases/case_3333333333333333/record": record,
      "/v1/cases/case_3333333333333333/record/envelope": recordSigner.envelope(RECORD_DSSE_PAYLOAD_TYPE, record),
    };
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url).pathname;
      return Response.json(routes[path]);
    });
    await expect(new JevyrClient({ baseUrl: "http://test", fetch: fetcher }).authenticatedRecord(receipt.caseId))
      .rejects.toThrow("different keys");
  });

  it("authenticates canonical Seal, Record, and terminal payloads with an advertised Ed25519 key", async () => {
    const { trust, envelope } = fixture();
    await expect(verifySealEnvelope(envelope(SEAL_DSSE_PAYLOAD_TYPE, receipt), trust, receipt)).resolves.toMatchObject({
      payload: receipt,
      verification: "dsse-ed25519",
      payloadType: SEAL_DSSE_PAYLOAD_TYPE,
    });
    await expect(verifyRecordEnvelope(envelope(RECORD_DSSE_PAYLOAD_TYPE, record), trust, record)).resolves.toMatchObject({
      payload: record,
      verification: "dsse-ed25519",
      payloadType: RECORD_DSSE_PAYLOAD_TYPE,
    });
    await expect(verifyTerminalEnvelope(envelope(TERMINAL_DSSE_PAYLOAD_TYPE, terminal), trust, terminal)).resolves.toMatchObject({
      payload: terminal,
      verification: "dsse-ed25519",
      payloadType: TERMINAL_DSSE_PAYLOAD_TYPE,
    });
  });

  it("rejects a terminal envelope whose canonical closure invariants are invalid", async () => {
    const { trust, envelope } = fixture();
    const invalid = { ...terminal, lifecycle: "terminated", stageStatus: "failed" };
    await expect(verifyTerminalEnvelope(envelope(TERMINAL_DSSE_PAYLOAD_TYPE, invalid), trust)).rejects.toThrow(
      "terminated closure must complete",
    );
  });

  it("rejects an untrusted key id and signature tampering", async () => {
    const { trust, envelope } = fixture();
    const signed = envelope(RECORD_DSSE_PAYLOAD_TYPE, record);
    const untrusted = { ...signed, signatures: [{ ...signed.signatures[0]!, keyid: digest("9") }] };
    const signature = Buffer.from(signed.signatures[0]!.sig, "base64");
    signature[0] = (signature[0] ?? 0) ^ 1;
    const tampered = { ...signed, signatures: [{ ...signed.signatures[0]!, sig: signature.toString("base64") }] };
    await expect(verifyRecordEnvelope(untrusted, trust, record)).rejects.toThrow("trusted key id");
    await expect(verifyRecordEnvelope(tampered, trust, record)).rejects.toThrow("did not verify");
  });

  it("rejects a wrong payload type and a payload differing from the bare endpoint", async () => {
    const { trust, envelope } = fixture();
    await expect(verifyRecordEnvelope(envelope(SEAL_DSSE_PAYLOAD_TYPE, record), trust, record)).rejects.toThrow("Expected DSSE payload type");
    await expect(verifyRecordEnvelope(envelope(RECORD_DSSE_PAYLOAD_TYPE, record), trust, { ...record, searchDigest: digest("9") })).rejects.toThrow("does not equal");
  });

  it("rejects validly signed JSON whose bytes are not canonical", async () => {
    const { trust, envelopeBytes } = fixture();
    const pretty = Buffer.from(JSON.stringify(receipt, null, 2));
    await expect(verifySealEnvelope(envelopeBytes(SEAL_DSSE_PAYLOAD_TYPE, pretty), trust, receipt)).rejects.toThrow("not canonical JSON");
  });

  it("rejects validly signed DSSE JSON with duplicate or escape-equivalent members", async () => {
    const { trust, envelopeBytes } = fixture();
    const ambiguous = canonicalJson(receipt).replace(
      '"protocol":"jevyr.seal/1"',
      '"protocol":"jevyr.seal/1","\\u0070rotocol":"jevyr.seal/1"',
    );
    await expect(
      verifySealEnvelope(envelopeBytes(SEAL_DSSE_PAYLOAD_TYPE, Buffer.from(ambiguous)), trust, receipt),
    ).rejects.toThrow("not valid unambiguous JSON");
  });

  it("rejects a trust key id that does not identify its public bytes", async () => {
    const { trust, envelope } = fixture();
    const invalid: PublicTrustBundle = { ...trust, keys: [{ ...trust.keys[0]!, keyId: digest("9") }] };
    await expect(verifySealEnvelope(envelope(SEAL_DSSE_PAYLOAD_TYPE, receipt), invalid, receipt)).rejects.toThrow("does not match its public key bytes");
  });
});
