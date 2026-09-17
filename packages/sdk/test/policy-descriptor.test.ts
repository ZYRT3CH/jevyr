import { describe, expect, it, vi } from "vitest";
import { JevyrClient } from "../src/client.js";
import { canonicalJson, sha256Digest } from "../src/digest.js";
import { JevyrContinuityError } from "../src/errors.js";
import type {
  AuthenticatedRecord,
  CasePolicyDescriptor,
  DescriptorArtifact,
  JevyrRecord,
} from "../src/types.js";
import {
  assertCasePolicyDescriptor,
  assertDescriptorArtifact,
  assertPolicyDescriptorRecordBinding,
} from "../src/verify.js";

const CASE_ID = "case_0123456789abcdef";
const CASE_DIGEST = `sha256:${"a".repeat(64)}`;
const RUN_DIGEST = `sha256:${"b".repeat(64)}`;
const INTENT_DIGEST = `sha256:${"c".repeat(64)}`;

async function fixture(): Promise<{
  artifact: DescriptorArtifact;
  binding: CasePolicyDescriptor;
  record: JevyrRecord;
}> {
  const descriptor = {
    protocol: "jevyr.policy-descriptor/1",
    version: "jevyr.bone/1",
    policy: {
      protocol: "jevyr.effective-policy/1",
      assayFrontierDigest: `sha256:${"d".repeat(64)}`,
      assayFrontier: { protocol: "jevyr.assay-frontier/1" },
    },
    subjectSnapshots: { protocol: "jevyr.subject-snapshot-policy/1" },
  } as const;
  const policyDigest = await sha256Digest(canonicalJson(descriptor));
  const artifact: DescriptorArtifact = {
    protocol: "jevyr.descriptor-artifact/1",
    kind: "policy",
    digest: policyDigest,
    descriptor,
  };
  const binding: CasePolicyDescriptor = {
    protocol: "jevyr.case-policy-descriptor/1",
    caseId: CASE_ID,
    caseDigest: CASE_DIGEST,
    runDigest: RUN_DIGEST,
    policyDigest,
    artifact,
  };
  const record: JevyrRecord = {
    protocol: "jevyr.record/1",
    caseDigest: CASE_DIGEST,
    runDigest: RUN_DIGEST,
    policyDigest,
    genomeDigest: `sha256:${"e".repeat(64)}`,
    searchDigest: `sha256:${"f".repeat(64)}`,
    intentContractDigest: INTENT_DIGEST,
    eventHeadDigest: `sha256:${"1".repeat(64)}`,
    verdict: {
      policyVersion: "jevyr.bone/1",
      intentContractDigest: INTENT_DIGEST,
      evidenceDigest: `sha256:${"2".repeat(64)}`,
      integrity: "VALID",
      creation: "NO_SURVIVOR",
      embodiment: "NOT_BUILT",
      judgment: "UNPROVEN",
      feasibilityByCandidate: {},
      basis: [],
    },
    reflex: {
      loop: 1,
      reviewedEvidenceDigest: `sha256:${"3".repeat(64)}`,
      intentContractDigest: INTENT_DIGEST,
      challengedNodeIds: [],
      materialFindings: [],
      decision: "confirm",
    },
    memoryInfluences: [],
    crystallizedAt: "2026-09-04T12:00:00.000Z",
  };
  return { artifact, binding, record };
}

describe("policy descriptor verification", () => {
  it("rehashes the descriptor and binds Case, run, and policy to a Record", async () => {
    const { artifact, binding, record } = await fixture();
    await expect(assertDescriptorArtifact(artifact, { kind: "policy", digest: artifact.digest }))
      .resolves.toEqual(artifact);
    const checked = await assertCasePolicyDescriptor(binding, CASE_ID);
    expect(assertPolicyDescriptorRecordBinding(checked, record)).toEqual(binding);
  });

  it("rejects unknown fields, payload substitution, kind confusion, and cross-Case bindings", async () => {
    const { artifact, binding, record } = await fixture();
    await expect(assertDescriptorArtifact({ ...artifact, hidden: true })).rejects.toThrow("missing or unknown");
    await expect(assertDescriptorArtifact({
      ...artifact,
      descriptor: { ...(artifact.descriptor as Record<string, unknown>), version: "substituted" },
    })).rejects.toThrow("do not match");
    await expect(assertDescriptorArtifact({ ...artifact, kind: "genome" }, { kind: "policy" }))
      .rejects.toThrow("wrong provenance kind");
    await expect(assertCasePolicyDescriptor({ ...binding, caseId: "case_other" }, CASE_ID))
      .rejects.toThrow("Case binding");
    expect(() => assertPolicyDescriptorRecordBinding(binding, {
      ...record,
      policyDigest: `sha256:${"9".repeat(64)}`,
    })).toThrow("authenticated Record identity");
    expect(() => assertPolicyDescriptorRecordBinding(binding, {
      ...record,
      verdict: { ...record.verdict, callerApproval: true },
    })).toThrow("canonical field contract");
  });

  it("fetches only a strictly checked descriptor endpoint response", async () => {
    const { binding } = await fixture();
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(binding));
    const client = new JevyrClient({ baseUrl: "http://test", fetch: fetcher });
    await expect(client.policyDescriptor(CASE_ID)).resolves.toEqual(binding);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`http://test/v1/cases/${CASE_ID}/policy-descriptor`);

    const malicious = { ...binding, policyDigest: `sha256:${"8".repeat(64)}` };
    const rejected = new JevyrClient({
      baseUrl: "http://test",
      fetch: vi.fn<typeof fetch>(async () => Response.json(malicious)),
    });
    await expect(rejected.policyDescriptor(CASE_ID)).rejects.toBeInstanceOf(JevyrContinuityError);
  });

  it("marks a policy verified only after a DSSE-verified Record agrees", async () => {
    const { binding, record } = await fixture();
    const client = new JevyrClient({ baseUrl: "http://test", fetch: vi.fn<typeof fetch>() });
    const authenticatedRecord: AuthenticatedRecord = {
      payload: record,
      envelope: {
        payloadType: "application/vnd.jevyr.record+json",
        payload: "e30=",
        signatures: [{ keyid: `sha256:${"4".repeat(64)}`, sig: "AA==" }],
      },
      keyId: `sha256:${"4".repeat(64)}`,
      payloadType: "application/vnd.jevyr.record+json",
      verification: "dsse-ed25519",
      verificationScope: "dsse-signature+seal-provenance",
      persistedEvidence: "not-replayed",
    };
    vi.spyOn(client, "authenticatedRecord").mockResolvedValue(authenticatedRecord);
    vi.spyOn(client, "policyDescriptor").mockResolvedValue(binding);
    await expect(client.verifiedPolicyDescriptor(CASE_ID)).resolves.toMatchObject({
      binding,
      record: authenticatedRecord,
      verification: "sha256+dsse-record-binding",
    });

    vi.spyOn(client, "policyDescriptor").mockResolvedValue({
      ...binding,
      runDigest: `sha256:${"7".repeat(64)}`,
    });
    await expect(client.verifiedPolicyDescriptor(CASE_ID)).rejects.toThrow("authenticated Record identity");
  });
});
