import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalize, type JsonValue } from "@jevyr/protocol";
import { assertArtifactList, assertSealReceipt } from "@jevyr/sdk";
import { decodeOriginalSubjectCertificate, ORIGINAL_SUBJECT_CERTIFICATE_MEDIA } from "@jevyr/runtime";
import { verifyLocalProof } from "../src/local-proof.js";

// Retained signed physical fixtures are produced separately by the opt-in OCI
// integration. These tests only read bytes: no daemon, provider or Forge is run.
const retainedProof = process.env.JEVYR_TEST_ORIGINAL_SUBJECT_PROOF;
describe.skipIf(!retainedProof)("retained original-subject proof transport and source sidecars", () => {
  let temporary: string, proof: string, certificateFile: string;
  const files = new Map<string, Buffer>();
  beforeAll(async () => {
    const source = resolve(retainedProof!);
    const verified = await verifyLocalProof(source);
    expect(verified.valid, JSON.stringify(verified.problems)).toBe(true);
    if (!verified.valid) throw new Error("Opt-in fixture is not a complete authenticated proof");
    expect(verified.replay.evidenceReplay?.verifiedOriginalSubjectEdges.length).toBe(1);
    const seal = assertSealReceipt(JSON.parse(await readFile(join(source, "seal-receipt.json"), "utf8")));
    const index = assertArtifactList(JSON.parse(await readFile(join(source, "artifact-index.json"), "utf8")), seal.caseId);
    const certificate = index.artifacts.filter(meta => meta.mediaType === ORIGINAL_SUBJECT_CERTIFICATE_MEDIA);
    expect(certificate).toHaveLength(1);
    certificateFile = `artifacts/${certificate[0]!.id}.blob`;
    const names = ["record.json", "seal-receipt.json", "record.dsse.json", "seal.dsse.json", "terminal-receipt.json", "terminal.dsse.json",
      "trust.json", "events.json", "intent-contract.json", "policy-descriptor.json", "artifact-index.json", "sealed-case.json",
      "canonical-record.json", "run-attestations.json", ...index.artifacts.map(meta => `artifacts/${meta.id}.blob`)];
    for (const name of names) files.set(name, await readFile(join(source, ...name.split("/"))));
    temporary = await mkdtemp(join(tmpdir(), "jevyr-original-proof-test-"));
  }, 60_000);
  beforeEach(async () => {
    proof = await mkdtemp(join(temporary, "copy-"));
    for (const [name, bytes] of files) { const path = join(proof, ...name.split("/")); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: "wx" }); }
  });
  afterAll(async () => {
    if (!temporary) return;
    const target = resolve(temporary);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("jevyr-original-proof-test-")) throw new Error("Refusing cleanup outside the generated test root");
    await rm(target, { recursive: true, force: true });
  });

  it("ordinary exported proof reconstructs captured source from its indexed certificate alone", async () => {
    const certificate = decodeOriginalSubjectCertificate(files.get(certificateFile)!);
    expect(certificate.artifacts.some(file => file.name === "mount/repository-pure/request.json")).toBe(true);
    expect(certificate.artifacts.some(file => file.name.includes("/blobs/"))).toBe(true);
    const result = await verifyLocalProof(proof);
    expect(result.valid, JSON.stringify(result.problems)).toBe(true);
    if (result.valid) expect(result.replay.evidenceReplay?.verifiedOriginalSubjectEdges).toHaveLength(1);
    expect(await readFile(join(proof, "sealed-case.json"))).toEqual(files.get("sealed-case.json"));
  }, 60_000);

  it("refuses a missing certificate even when the signed Record and full Seal remain", async () => {
    await unlink(join(proof, certificateFile));
    expect(await verifyLocalProof(proof)).toMatchObject({ valid: false });
  });

  it("a producer's reduced context cannot replace the authenticated full sealed Case", async () => {
    const certificate = decodeOriginalSubjectCertificate(files.get(certificateFile)!);
    const request = JSON.parse(Buffer.from(certificate.artifacts.find(file => file.name === "mount/repository-pure/request.json")!.base64, "base64").toString("utf8"));
    await writeFile(join(proof, "sealed-case.json"), JSON.stringify(request.context));
    const result = await verifyLocalProof(proof);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("sealed-case.json");
  });

  it("rehashing an altered embedded source cannot bypass the signed outer artifact inventory", async () => {
    const certificate = JSON.parse(files.get(certificateFile)!.toString("utf8"));
    const source = certificate.artifacts.find((file: { name: string }) => file.name.includes("/blobs/"));
    expect(source).toBeDefined();
    const bytes = Buffer.from(source.base64, "base64"); bytes[0] ^= 1;
    const { sha256Digest } = await import("@jevyr/protocol");
    source.base64 = bytes.toString("base64"); source.digest = sha256Digest(bytes); source.byteLength = bytes.length;
    await writeFile(join(proof, certificateFile), canonicalize(certificate as JsonValue));
    const result = await verifyLocalProof(proof);
    expect(result.valid).toBe(false);
    expect(result.problems.join(" ")).toContain("signed inventory");
  });
});
