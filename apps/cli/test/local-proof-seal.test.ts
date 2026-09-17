import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDaemonRuntime, createJevyrHttpService } from "@jevyr/daemon";
import { compileIntentContract } from "@jevyr/core";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { digestJson, sealedCaseIdentityDigest, sha256Digest, validateSealedCase, type SealedCase } from "@jevyr/protocol";
import { JevyrClient } from "@jevyr/sdk";
import { exportLocalProof, verifyLocalProof } from "../src/local-proof.js";

/** Rehash public identity fields, without possession of the Seal signing key. */
function rehashCase(sealed: SealedCase): SealedCase {
  sealed.caseDigest = sealedCaseIdentityDigest(sealed);
  sealed.runDigest = digestJson({ caseDigest: sealed.caseDigest, policyVersion: sealed.policyVersion,
    policyDigest: sealed.policyDigest, genomeVersion: sealed.genomeVersion, genomeDigest: sealed.genomeDigest,
    searchDigest: sealed.searchEnvelope.digest, seed: sealed.intent.seed, sealedAt: sealed.sealedAt });
  sealed.caseId = `case_${sealed.runDigest.slice(7, 23)}`;
  return sealed;
}

describe("offline proof sealed Case authentication", () => {
  let root: string, proof: string, keyId: string, originalBytes: Buffer, original: SealedCase, foreign: SealedCase;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jevyr-local-proof-seal-"));
    const subject = join(root, "subject");
    await mkdir(subject);
    await writeFile(join(subject, "source.mjs"), "export const answer = 42;\n");
    const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, "store"), env: {},
      minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
    const service = createJevyrHttpService({ runtime, env: {} });
    try {
      const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
      const receipt = await client.cast({ case: { impulse: "Inspect the sealed archival specimen.", seed: "ab".repeat(32),
        subjects: [{ id: "files", kind: "directory", locator: subject }, { id: "text", kind: "text", locator: "first\r\nsecond" }] } });
      proof = join(root, "proof");
      const verified = await exportLocalProof(client, receipt.caseId, proof);
      expect(verified.valid).toBe(true);
      if (!verified.valid || !verified.keyId) throw new Error("Signed proof fixture did not verify");
      keyId = verified.keyId;
      originalBytes = await readFile(join(proof, "sealed-case.json"));
      original = JSON.parse(originalBytes.toString("utf8"));
      const other = await client.cast({ case: { impulse: "Inspect a different archival specimen.", seed: "cd".repeat(32) } });
      await client.waitForAuthenticatedRecord(other.caseId, { preferSse: false });
      foreign = await client.verifiedSealedCase(other.caseId);
    } finally { await service.close(); }
  }, 30_000);

  beforeEach(async () => { await writeFile(join(proof, "sealed-case.json"), originalBytes); });
  afterAll(async () => {
    if (!root) return;
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("jevyr-local-proof-seal-")) {
      throw new Error("Refusing cleanup outside the exact generated test directory");
    }
    await rm(target, { recursive: true, force: true });
  });

  it("verifies exported identity without rewriting any sealed Case bytes", async () => {
    expect(await verifyLocalProof(proof, keyId)).toMatchObject({ valid: true, caseId: original.caseId });
    expect(await readFile(join(proof, "sealed-case.json"))).toEqual(originalBytes);
    // JSON formatting is not signed; the normalized Case identity is.
    await writeFile(join(proof, "sealed-case.json"), JSON.stringify(original));
    expect(await verifyLocalProof(proof, keyId)).toMatchObject({ valid: true });
  });

  it("refuses a missing sealed-case.json even though all three signed payloads remain intact", async () => {
    await unlink(join(proof, "sealed-case.json"));
    const result = await verifyLocalProof(proof, keyId);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("sealed-case.json");
  });

  it("refuses malformed or unknown sealed Case fields", async () => {
    for (const value of ["{", JSON.stringify({ ...original, verified: true })]) {
      await writeFile(join(proof, "sealed-case.json"), value);
      expect(await verifyLocalProof(proof, keyId)).toMatchObject({ valid: false });
    }
  });

  it("refuses unrehashed intent tampering", async () => {
    const changed = structuredClone(original);
    changed.intent.impulse = "Replace the sealed instruction.";
    await writeFile(join(proof, "sealed-case.json"), JSON.stringify(changed));
    const result = await verifyLocalProof(proof, keyId);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("identity validation");
  });

  it("refuses a valid foreign Case under the same daemon signing key", async () => {
    expect(validateSealedCase(foreign).ok).toBe(true);
    await writeFile(join(proof, "sealed-case.json"), JSON.stringify(foreign));
    const result = await verifyLocalProof(proof, keyId);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("authenticated signed Seal");
  });

  const mutations: ReadonlyArray<readonly [string, (sealed: SealedCase) => void]> = [
    ["rehashed replacement intent and contract", sealed => {
      sealed.intent.impulse = "Inspect a replacement instruction.";
      sealed.intentContract = compileIntentContract({ impulse: sealed.intent.impulse, constraints: sealed.intent.constraints,
        requestedAssays: sealed.intent.requestedAssays, subjectIds: sealed.intent.subjects.map(subject => subject.id) });
      sealed.intentContractDigest = sealed.intentContract.digest;
    }],
    ["rehashed original locator and resolved snapshot", sealed => {
      const reference = sealed.intent.subjects.find(subject => subject.id === "files")!;
      const snapshot = sealed.subjects.find(subject => subject.subjectId === "files")!;
      reference.locator = join(root, "different-source"); snapshot.resolvedLocator = reference.locator;
    }],
    ["rehashed source snapshot digest", sealed => { sealed.subjects.find(subject => subject.subjectId === "files")!.digest = sha256Digest("different source bytes"); }],
    ["rehashed inline source bytes with changed line endings", sealed => {
      const reference = sealed.intent.subjects.find(subject => subject.id === "text")!;
      const snapshot = sealed.subjects.find(subject => subject.subjectId === "text")!;
      reference.locator = reference.locator.replace("\r\n", "\n");
      snapshot.digest = sha256Digest(reference.locator); snapshot.byteLength = Buffer.byteLength(reference.locator);
    }],
    ["rehashed Case seed", sealed => { sealed.intent.seed = "ef".repeat(32); }],
    ["rehashed captured-material binding", sealed => { sealed.subjectMaterialCaptureDigest = sha256Digest("foreign capture"); }],
  ];
  it.each(mutations)("refuses %s despite internally consistent public hashes", async (_name, mutate) => {
    const changed = structuredClone(original); mutate(changed); rehashCase(changed);
    expect(validateSealedCase(changed).ok).toBe(true);
    expect(changed.runDigest).not.toBe(original.runDigest);
    await writeFile(join(proof, "sealed-case.json"), JSON.stringify(changed));
    const result = await verifyLocalProof(proof, keyId);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("authenticated signed Seal");
  });
});
