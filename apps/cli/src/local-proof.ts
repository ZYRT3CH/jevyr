import { createHash } from "node:crypto";
import { lstat, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseJsonBytes, sealReceipt } from "@jevyr/core";
import { canonicalRecordText, RUN_ATTESTATIONS_PROTOCOL, validateSealedCase } from "@jevyr/protocol";
import { ORIGINAL_SUBJECT_CERTIFICATE_MEDIA, MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES } from "@jevyr/runtime";
import {
  assertArtifactList, assertCasePolicyDescriptor, assertIntentContractPayload, assertRecordPayload,
  assertSealReceipt, assertTerminalReceipt, canonicalJson, verifyRecordEnvelope, verifySealEnvelope,
  verifyTerminalEnvelope, verifyRunAttestations, assertPublicTrustBundle, JevyrHttpError, type PublicTraceEvent, type JevyrClient,
} from "@jevyr/sdk";
import { allEvents, replayTrace } from "./replay.js";

const hash = (value: Uint8Array | string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** Export exact terminal documents for independent offline inspection, never rerun a Case. */
export async function exportLocalProof(client: JevyrClient, caseId: string, directory: string) {
  const authenticated = await client.waitForAuthenticatedRecord(caseId, { preferSse: false });
  const [seal, recordEnvelope, sealEnvelope, terminal, terminalEnvelope, trust, events, contract, policy, artifacts, sealedCase] = await Promise.all([
    client.sealReceipt(caseId), client.recordEnvelope(caseId), client.sealEnvelope(caseId),
    client.terminalReceipt(caseId), client.terminalEnvelope(caseId), client.trustBundle(),
    allEvents(client, caseId), client.intentContract(caseId), client.policyDescriptor(caseId), client.artifactList(caseId), client.verifiedSealedCase(caseId),
  ]);
  const root = resolve(directory);
  await mkdir(join(root, "artifacts"), { recursive: true });
  const documents = { "record.json": authenticated.payload, "seal-receipt.json": seal, "record.dsse.json": recordEnvelope,
    "seal.dsse.json": sealEnvelope, "terminal-receipt.json": terminal, "terminal.dsse.json": terminalEnvelope,
    "trust.json": trust, "events.json": events, "intent-contract.json": contract,
    "policy-descriptor.json": policy, "artifact-index.json": artifacts, "sealed-case.json": sealedCase };
  const requiredAttestations = (policy.artifact.descriptor as {policy?:{runAttestations?:unknown}}).policy?.runAttestations === RUN_ATTESTATIONS_PROTOCOL;
  let attestations: Awaited<ReturnType<JevyrClient["verifiedRunAttestations"]>> | undefined;
  try { attestations = await client.verifiedRunAttestations(caseId); }
  catch (error) { if (requiredAttestations || !(error instanceof JevyrHttpError) || error.status !== 404) throw error; }
  for (const [name, value] of Object.entries(documents)) await writeFile(join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (attestations) {
    await writeFile(join(root, "canonical-record.json"), canonicalRecordText(authenticated.payload), { flag: "wx", mode: 0o600 });
    await writeFile(join(root, "run-attestations.json"), `${JSON.stringify(attestations.payload, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  for (const meta of artifacts.artifacts) {
    if (meta.mediaType === ORIGINAL_SUBJECT_CERTIFICATE_MEDIA && meta.size > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES) throw new RangeError("Original-subject certificate exceeds its bounded replay envelope");
    const artifact = await client.fetchArtifact(caseId, meta.id);
    await writeFile(join(root, "artifacts", `${meta.id}.blob`), artifact.data, { flag: "wx", mode: 0o600 });
  }
  return await verifyLocalProof(root, authenticated.keyId);
}

async function ordinaryFile(path: string, maximum = 64 * 1_048_576): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new TypeError(`Proof entry is not an ordinary bounded file: ${path}`);
  const bytes = await readFile(path);
  if (bytes.byteLength !== stat.size || bytes.byteLength > maximum) throw new Error("Proof entry changed while reading");
  return bytes;
}

/** Offline verification of local lifecycle proofs; no daemon, model or execution is reopened. */
export async function verifyLocalProof(directory: string, expectedKeyId?: string) {
  const root = resolve(directory);
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new TypeError("Proof directory must be ordinary and local");
    if (expectedKeyId !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(expectedKeyId)) throw new TypeError("Expected signer key must be a canonical digest");
    const json = async (name: string) => parseJsonBytes(await ordinaryFile(join(root, name)), `Local proof ${name}`);
    const seal = assertSealReceipt(await json("seal-receipt.json"));
    const record = assertRecordPayload(await json("record.json"));
    const terminal = assertTerminalReceipt(await json("terminal-receipt.json"));
    const trust = await assertPublicTrustBundle(await json("trust.json"));
    const sealEnvelope = await json("seal.dsse.json");
    const signedSeal = await verifySealEnvelope(sealEnvelope, trust, seal);
    const signedRecord = await verifyRecordEnvelope(await json("record.dsse.json"), trust, record);
    const signedTerminal = await verifyTerminalEnvelope(await json("terminal.dsse.json"), trust, terminal);
    if (signedSeal.keyId !== signedRecord.keyId || signedSeal.keyId !== signedTerminal.keyId) throw new Error("Seal, Record and terminal signer identities differ");
    if (expectedKeyId !== undefined && signedSeal.keyId !== expectedKeyId) throw new Error("Proof does not verify under the independently pinned signer");
    const sealedCase = validateSealedCase(await json("sealed-case.json"));
    if (!sealedCase.ok || !sealedCase.value) throw new Error("Local proof sealed-case.json failed sealed Case identity validation");
    if (canonicalJson(sealReceipt(sealedCase.value)) !== canonicalJson(signedSeal.payload)) {
      throw new Error("Local proof sealed-case.json does not match the authenticated signed Seal");
    }
    for (const field of ["caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest"] as const) {
      if (seal[field] !== record[field]) throw new Error(`Seal and Record differ in ${field}`);
    }
    const artifacts = assertArtifactList(await json("artifact-index.json"), seal.caseId);
    if (artifacts.artifacts.length > 10_000 || artifacts.artifacts.reduce((sum, item) => sum + item.size, 0) > 512 * 1_048_576) throw new Error("Proof artifact inventory exceeds the bounded local verifier");
    if (artifacts.artifacts.length) {
      const artifactDirectory = await lstat(join(root, "artifacts"));
      if (!artifactDirectory.isDirectory() || artifactDirectory.isSymbolicLink()) throw new TypeError("Proof artifacts must remain inside an ordinary directory");
    }
    const bodies = new Map<string, Uint8Array>();
    for (const meta of artifacts.artifacts) {
      if (meta.mediaType === ORIGINAL_SUBJECT_CERTIFICATE_MEDIA && meta.size > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES) throw new RangeError("Original-subject certificate exceeds its bounded replay envelope");
      if (!/^artifact_[a-f0-9]{24}$/u.test(meta.id)) throw new Error("Artifact identifier is not a safe proof filename");
      const bytes = await ordinaryFile(join(root, "artifacts", `${meta.id}.blob`), 512 * 1_048_576);
      if (bytes.byteLength !== meta.size || hash(bytes) !== meta.digest) throw new Error(`Artifact ${meta.id} does not match its signed inventory`);
      bodies.set(meta.digest, bytes);
    }
    const eventsValue = await json("events.json");
    if (!Array.isArray(eventsValue) || eventsValue.length > 100_000) throw new TypeError("Proof events must be a bounded array");
    const events = eventsValue as PublicTraceEvent[];
    const contract = assertIntentContractPayload(await json("intent-contract.json"));
    const policy = await assertCasePolicyDescriptor(await json("policy-descriptor.json"), seal.caseId);
    const requiredAttestations = (policy.artifact.descriptor as {policy?:{runAttestations?:unknown}}).policy?.runAttestations === RUN_ATTESTATIONS_PROTOCOL;
    const sidecars = await Promise.all(["canonical-record.json", "run-attestations.json"].map(async name => {
      try { await lstat(join(root, name)); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }));
    if (requiredAttestations || sidecars.some(Boolean)) {
      if (sidecars.some(present => !present)) throw new Error("Proof is missing required canonical Record or run attestation sidecars");
      const canonicalRecord = await ordinaryFile(join(root, "canonical-record.json"));
      if (canonicalRecord.toString("utf8") !== canonicalRecordText(record) || hash(canonicalRecord) !== terminal.recordDigest) throw new Error("Production subject is not the exact canonical Record bytes");
      await verifyRunAttestations(await json("run-attestations.json"), { seal, record, terminal, sealEnvelope: await json("seal.dsse.json"), recordEnvelope: await json("record.dsse.json"), terminalEnvelope: await json("terminal.dsse.json"), trust });
    }
    const trustedKeys = new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem]));
    const replay = await replayTrace(record, events, contract, { persistedEvidence: {
      policyDescriptor: policy, resolveArtifact: async (digest) => bodies.get(digest), trustedRecordKeys: trustedKeys,
      originalSubject: { sealedCase: sealedCase.value, sealEnvelope: signedSeal.envelope, trustedCaseKeys: trustedKeys },
    } });
    if (!replay.valid) throw new Error(`Independent replay failed: ${replay.problems.join("; ")}`);
    const tail = events.at(-1);
    const lastStage = [...events].reverse().find((event) => event.kind === "stage.status");
    if (terminal.caseId !== seal.caseId || terminal.caseDigest !== seal.caseDigest || terminal.runDigest !== seal.runDigest
      || terminal.recordDigest !== hash(canonicalJson(record)) || terminal.artifactIndexDigest !== hash(canonicalJson(artifacts))
      || terminal.lastSequence !== events.length || terminal.eventHeadDigest !== tail?.eventDigest
      || terminal.closedAt !== tail?.observedAt || terminal.stage !== tail?.stage
      || lastStage?.kind !== "stage.status" || terminal.stage !== lastStage.stage || terminal.stageStatus !== lastStage.payload.status
      || (terminal.lifecycle === "terminated" && (terminal.stage !== "terminate" || terminal.stageStatus !== "completed"))
      || (terminal.lifecycle === "invalid" && terminal.stageStatus !== "failed")) throw new Error("Signed terminal receipt does not bind the exact replayed ledger, lifecycle and artifact inventory");
    const investigatorReceipts = events.flatMap((event) => event.kind === "evidence.observed" && event.payload.audit?.kind === "lineage_commitment" ? [event.payload.audit] : []);
    return {
      protocol: "jevyr.local-proof-verification/1" as const,
      directory: root, valid: true, trustScope: expectedKeyId ? "externally-pinned-key" : "proof-declared-key",
      keyId: signedSeal.keyId, caseId: seal.caseId, recordDigest: hash(canonicalJson(record)),
      caseDigest: record.caseDigest, runDigest: record.runDigest, policyDigest: record.policyDigest,
      intentContractDigest: record.intentContractDigest,
      eventHeadDigest: terminal.eventHeadDigest, artifactIndexDigest: terminal.artifactIndexDigest,
      verdict: record.verdict, replay, lifecycle: [...new Set(events.filter((event) => event.kind === "stage.status" && event.payload.status === "entered").map((event) => event.stage))],
      investigators: [...new Set(investigatorReceipts.map((receipt) => `${receipt.providerId}/${receipt.modelId}`))],
      sandboxExecutions: events.filter((event) => event.kind === "evidence.observed" && event.payload.evidenceType === "sandbox_execution").length,
      artifactMediaTypes: [...new Set(artifacts.artifacts.map((entry) => entry.mediaType))],
      problems: [] as string[],
    };
  } catch (error) {
    return { protocol: "jevyr.local-proof-verification/1" as const, directory: root, valid: false, trustScope: "unavailable", problems: [error instanceof Error ? error.message : String(error)] };
  }
}
