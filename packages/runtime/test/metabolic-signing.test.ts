import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canonicalize, digestJson, METABOLIC_KINDS, type JsonValue, type MetabolicAllowance, type MetabolicReceipt } from "@jevyr/protocol";
import { verifyDsse } from "@jevyr/core";
import { CaseRepository, createMetabolicAllowance } from "../src/index.js";
import { claimRecordCommitAuthority, type RecordCommitAuthority } from "../src/record-authority.js";

const hash = (value: unknown): string => digestJson(value as JsonValue);
test("metabolic signer enforces Bone authority, separate keys, exact additive allowance and create-once sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-metabolic-signing-"));
  try {
    const signer = CaseRepository.metabolicSignerDescriptorSync(root);
    assert.deepEqual(await CaseRepository.metabolicSignerDescriptor(root), signer);
    const baseline = new CaseRepository(root).searchEnvelope;
    const initial = createMetabolicAllowance(baseline, signer, []);
    // Artificial admission metadata exercises the signer, not empirical calibration.
    const calibrationDigest = hash({ fixture: "signer-only" });
    const { digest: _digest, ...allowanceBody } = initial;
    const body = { ...allowanceBody, calibrations: [{ kind: "Mass" as const, digest: calibrationDigest, summaryDigest: hash("fixture-only-summary"), maximumDose: 2 }],
      calibrationSetDigest: hash({ protocol: "jevyr.metabolic-calibration-set/1", reports: [{ kind: "Mass", digest: calibrationDigest }] }) };
    const allowance: MetabolicAllowance = { ...body, digest: hash(body) };
    const repository = new CaseRepository(root, { metabolicAllowance: allowance });
    const authority = claimRecordCommitAuthority(repository);
    const created = await repository.create({ protocol: "jevyr.case/1", case: { impulse: "Signer boundary fixture", control: "juggler" } });
    const quantity = 1;
    function receipt(previous?: MetabolicReceipt): MetabolicReceipt {
      const grant = allowance.unitCostCeilings.Mass;
      const body = { protocol: "jevyr.metabolism-receipt/1" as const, caseId: created.caseId, caseDigest: created.sealed.caseDigest,
        runDigest: created.sealed.runDigest, policyDigest: created.sealed.policyDigest, searchDigest: baseline.digest,
        allowanceDigest: allowance.digest, calibrationDigest, ballId: `ball_${"x".repeat(43)}`, kind: "Mass" as const,
        quantity, sequence: (previous?.sequence ?? 0) + 1, previousReceiptDigest: previous?.digest ?? null, issuedAt: new Date().toISOString(), grant,
        cumulativeGrant: Object.fromEntries(Object.entries(grant).map(([key, value]) => [key, value * ((previous?.sequence ?? 0) + 1)])) as typeof grant,
        cumulativeQuantities: Object.fromEntries(METABOLIC_KINDS.map((kind) => [kind, kind === "Mass" ? (previous?.sequence ?? 0) + 1 : 0])) as MetabolicReceipt["cumulativeQuantities"],
        work: { general: 1, unfamiliarFamilies: 0, counterbelief: 0, isolatedLanes: 0, scentContinuation: 0 }, baselineUnchanged: true as const, verdictAuthority: "none" as const };
      return { ...body, digest: hash(body) };
    }
    const first = receipt();
    await assert.rejects(repository.writeMetabolicReceipt(created.caseId, first, {} as RecordCommitAuthority), /unforgeable repository authority/u);
    const tampered = { ...first, runDigest: hash("foreign-run") };
    tampered.digest = hash(Object.fromEntries(Object.entries(tampered).filter(([key]) => key !== "digest")));
    await assert.rejects(repository.writeMetabolicReceipt(created.caseId, tampered, authority), /sealed Case boundary/u);
    const concurrent = await Promise.allSettled([repository.writeMetabolicReceipt(created.caseId, first, authority), repository.writeMetabolicReceipt(created.caseId, first, authority)]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    const signed = concurrent.find((result) => result.status === "fulfilled");
    assert.ok(signed && signed.status === "fulfilled");
    assert.ok(verifyDsse(signed.value.envelope, new Map([[signer.keyId, signer.publicKeyPem]])));
    const trust = await repository.publicTrustBundle();
    assert.ok(!trust.keys.some((key) => key.keyId === signer.keyId));
    assert.equal(Buffer.from(signed.value.envelope.payload, "base64").toString("utf8"), canonicalize(first as unknown as JsonValue));
    assert.equal(trust.keys[0]!.payloadTypes.length, 3);
    const path = join(root, "cases", created.caseId, "metabolism", "0001.json");
    const bytes = await readFile(path, "utf8");
    const corrupted = JSON.parse(bytes); corrupted.receipt.issuedAt = "2020-01-01T00:00:00.000Z";
    await writeFile(path, JSON.stringify(corrupted));
    await assert.rejects(repository.writeMetabolicReceipt(created.caseId, receipt(first), authority), /persisted metabolic signature/u);
    await writeFile(path, bytes);
    const second = receipt(first);
    await repository.writeMetabolicReceipt(created.caseId, second, authority);
    await assert.rejects(repository.writeMetabolicReceipt(created.caseId, receipt(second), authority), /calibrat|dose|quantity/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
