import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { compileIntentContract, parseJsonBytes, sealReceipt } from "@jevyr/core";
import { TOOL_OBSERVATION_MEDIA_TYPE, PUBLIC_IDEA_MEDIA_TYPE, ORIGINAL_SUBJECT_CERTIFICATE_MEDIA, MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES } from "@jevyr/runtime";
import {
  assertArtifactList,
  assertCasePolicyDescriptor,
  assertCaseStatus,
  assertIntentContractPayload,
  assertPolicyDescriptorRecordBinding,
  assertPublicTrustBundle,
  assertRecordPayload,
  assertSealReceipt,
  assertSealedCase,
  assertTerminalReceipt,
  canonicalJson,
  verifyEventChain,
  verifyRecordEnvelope,
  verifySealEnvelope,
  verifyTerminalEnvelope,
  type ArtifactList,
  type JevyrRecord,
  type PublicTraceEvent,
} from "@jevyr/sdk";
import { replayTrace, type ReplayResult } from "./replay.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const ARTIFACT_BODY = /^artifacts\/(artifact_[a-f0-9]{24})\.blob$/u;
const MAX_MANIFEST_BYTES = 16 * 1_048_576;
const MAX_JSON_BYTES = 256 * 1_048_576;
const MAX_ARTIFACT_BYTES = 512 * 1_048_576;
const MAX_BUNDLE_FILES = 100_000;
const MAX_BUNDLE_BYTES = 10_500_000_000;
const REPLAYABLE_MEDIA_TYPES = new Set([
  TOOL_OBSERVATION_MEDIA_TYPE,
  PUBLIC_IDEA_MEDIA_TYPE,
  ORIGINAL_SUBJECT_CERTIFICATE_MEDIA,
  "application/vnd.jevyr.candidate-population+json",
  "application/vnd.jevyr.candidate-blueprint+json",
]);

const ROOT_FILES = [
  "events.json",
  "intent-contract.json",
  "policy-descriptor.json",
  "record.dsse.json",
  "record.json",
  "replay.json",
  "runtime-provenance.json",
  "seal.dsse.json",
  "seal.json",
  "sealed.json",
  "status.json",
  "terminal.dsse.json",
  "terminal.json",
  "trust.json",
] as const;

export interface GithubAdvisoryProvenance {
  readonly protocol: "jevyr.github-advisory-provenance/1";
  readonly eventName: "pull_request_target" | "workflow_dispatch";
  readonly workflowSha: string;
  readonly runtimeRepository: string;
  readonly runtimeSha: string;
  readonly runtimeTreeOid: string;
  readonly runtimeLockDigest: string;
  readonly subjectRepository: string;
  readonly subjectSha: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly pullRequestNumber: string | null;
}

export interface ProofBundleVerificationOptions {
  /** A key id obtained outside the bundle, for example from the trusted GitHub run summary. */
  readonly trustedKeyId?: string;
  readonly expectedRuntimeSha?: string;
  readonly expectedSubjectSha?: string;
  readonly expectedWorkflowSha?: string;
}

export interface ProofBundleVerificationReport {
  readonly protocol: "jevyr.proof-bundle-verification/1";
  readonly directory: string;
  readonly valid: boolean;
  readonly integrityValid: boolean;
  readonly trust: {
    readonly anchored: boolean;
    readonly keyId?: string;
    readonly scope: "externally-pinned-key" | "bundle-declared-key" | "unavailable";
  };
  readonly caseId?: string;
  readonly provenance?: GithubAdvisoryProvenance;
  readonly replay?: ReplayResult;
  readonly problems: readonly string[];
}

interface FileSnapshot {
  readonly size: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new TypeError(`${label} fields do not match its versioned contract`);
  }
}

function assertSafeEntry(entry: string): void {
  if (!entry || entry.includes("\\") || entry.startsWith("/") || entry.includes("\0")) {
    throw new TypeError(`Unsafe bundle path ${JSON.stringify(entry)}`);
  }
  const segments = entry.split("/");
  if (segments.some((part) => part === "" || part === "." || part === "..")) {
    throw new TypeError(`Unsafe bundle path ${JSON.stringify(entry)}`);
  }
}

function absoluteEntry(root: string, entry: string): string {
  assertSafeEntry(entry);
  const segments = entry.split("/");
  const path = resolve(root, ...segments);
  const fromRoot = relative(root, path);
  if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
    throw new TypeError(`Bundle path escapes its root: ${entry}`);
  }
  return path;
}

function snapshot(stat: BigIntStats): FileSnapshot {
  return {
    size: Number(stat.size),
    dev: stat.dev,
    ino: stat.ino,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

function sameFile(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.size === right.size && left.dev === right.dev && left.ino === right.ino
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function stableFile<T>(
  root: string,
  entry: string,
  maximumBytes: number,
  consume: (handle: Awaited<ReturnType<typeof open>>, size: number) => Promise<T>,
): Promise<T> {
  const path = absoluteEntry(root, entry);
  const beforePath = await lstat(path, { bigint: true });
  if (beforePath.isSymbolicLink() || !beforePath.isFile()) {
    throw new TypeError(`Bundle entry is not a regular file: ${entry}`);
  }
  const noFollow = "O_NOFOLLOW" in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await open(path, fsConstants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat({ bigint: true });
    const identity = snapshot(before);
    if (!before.isFile() || identity.size < 0 || identity.size > maximumBytes) {
      throw new RangeError(`Bundle entry ${entry} exceeds its ${maximumBytes}-byte limit`);
    }
    const result = await consume(handle, identity.size);
    const after = snapshot(await handle.stat({ bigint: true }));
    const afterPath = await lstat(path, { bigint: true });
    if (afterPath.isSymbolicLink() || !afterPath.isFile()
      || !sameFile(identity, after)
      || identity.dev !== afterPath.dev || identity.ino !== afterPath.ino
      || identity.size !== Number(afterPath.size)
      || identity.mtimeNs !== afterPath.mtimeNs || identity.ctimeNs !== afterPath.ctimeNs) {
      throw new Error(`Bundle entry changed while it was being verified: ${entry}`);
    }
    return result;
  } finally {
    await handle.close();
  }
}

async function readStableFile(root: string, entry: string, maximumBytes: number): Promise<Uint8Array> {
  return await stableFile(root, entry, maximumBytes, async (handle, size) => {
    const bytes = await handle.readFile();
    if (bytes.byteLength !== size) throw new Error(`Bundle entry was truncated while reading: ${entry}`);
    return new Uint8Array(bytes);
  });
}

async function hashStableFile(root: string, entry: string, maximumBytes: number): Promise<{ size: number; hex: string }> {
  return await stableFile(root, entry, maximumBytes, async (handle, size) => {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(1_048_576, Math.max(1, size)));
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.byteLength, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead < 1) throw new Error(`Bundle entry was truncated while hashing: ${entry}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, offset)).bytesRead !== 0) {
      throw new Error(`Bundle entry grew while hashing: ${entry}`);
    }
    return { size, hex: hash.digest("hex") };
  });
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function inventory(root: string): Promise<{ readonly files: Set<string>; readonly directories: Set<string> }> {
  const files = new Set<string>();
  const directories = new Set<string>();
  const rootEntries = await readdir(root, { withFileTypes: true });
  if (rootEntries.length > MAX_BUNDLE_FILES) throw new RangeError("Proof bundle contains too many entries");
  for (const entry of rootEntries) {
    const info = await lstat(join(root, entry.name));
    if (info.isSymbolicLink()) throw new TypeError(`Proof bundle contains symbolic link ${entry.name}`);
    if (info.isFile()) files.add(entry.name);
    else if (info.isDirectory() && entry.name === "artifacts") directories.add(entry.name);
    else throw new TypeError(`Proof bundle contains unsupported entry ${entry.name}`);
  }
  if (!directories.has("artifacts")) throw new TypeError("Proof bundle has no artifacts directory");
  const artifacts = await readdir(join(root, "artifacts"), { withFileTypes: true });
  if (rootEntries.length + artifacts.length > MAX_BUNDLE_FILES) {
    throw new RangeError("Proof bundle contains too many entries");
  }
  for (const entry of artifacts) {
    const relativePath = `artifacts/${entry.name}`;
    const info = await lstat(join(root, "artifacts", entry.name));
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new TypeError(`Proof bundle contains non-regular entry ${relativePath}`);
    }
    files.add(relativePath);
  }
  return { files, directories };
}

function parseManifest(bytes: Uint8Array): Map<string, string> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw new SyntaxError("MANIFEST.sha256 is not valid UTF-8", { cause });
  }
  if (!text.endsWith("\n")) throw new SyntaxError("MANIFEST.sha256 must end with one complete line");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") throw new SyntaxError("MANIFEST.sha256 is empty");
  const entries = new Map<string, string>();
  let previous = "";
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  \.\/([\x21-\x7e]+)$/u.exec(line);
    if (!match) throw new SyntaxError("MANIFEST.sha256 contains a noncanonical line");
    const [, digest, entry] = match;
    if (!digest || !entry) throw new SyntaxError("MANIFEST.sha256 contains an incomplete line");
    assertSafeEntry(entry);
    if (entry === "MANIFEST.sha256" || entries.has(entry)) {
      throw new SyntaxError(`MANIFEST.sha256 repeats or self-addresses ${entry}`);
    }
    if (previous && previous >= entry) throw new SyntaxError("MANIFEST.sha256 entries are not strictly sorted");
    previous = entry;
    entries.set(entry, digest);
  }
  return entries;
}

async function jsonFile(root: string, manifest: ReadonlyMap<string, string>, entry: string): Promise<unknown> {
  const bytes = await readStableFile(root, entry, MAX_JSON_BYTES);
  if (sha256(bytes).slice("sha256:".length) !== manifest.get(entry)) {
    throw new Error(`Bundle entry changed after manifest verification: ${entry}`);
  }
  return parseJsonBytes(bytes, `Proof bundle ${entry}`);
}

function assertProvenance(value: unknown): GithubAdvisoryProvenance {
  const provenance = object(value, "Runtime provenance");
  exactKeys(provenance, [
    "protocol", "eventName", "workflowSha", "runtimeRepository", "runtimeSha",
    "runtimeTreeOid", "runtimeLockDigest", "subjectRepository", "subjectSha",
    "runId", "runAttempt", "pullRequestNumber",
  ], "Runtime provenance");
  if (provenance.protocol !== "jevyr.github-advisory-provenance/1"
    || (provenance.eventName !== "pull_request_target" && provenance.eventName !== "workflow_dispatch")
    || typeof provenance.workflowSha !== "string" || !GIT_OID.test(provenance.workflowSha)
    || typeof provenance.runtimeRepository !== "string" || provenance.runtimeRepository.length > 256
    || !REPOSITORY.test(provenance.runtimeRepository)
    || typeof provenance.runtimeSha !== "string" || !GIT_OID.test(provenance.runtimeSha)
    || typeof provenance.runtimeTreeOid !== "string" || !GIT_OID.test(provenance.runtimeTreeOid)
    || typeof provenance.runtimeLockDigest !== "string" || !DIGEST.test(provenance.runtimeLockDigest)
    || typeof provenance.subjectRepository !== "string" || provenance.subjectRepository.length > 256
    || !REPOSITORY.test(provenance.subjectRepository)
    || typeof provenance.subjectSha !== "string" || !GIT_OID.test(provenance.subjectSha)
    || typeof provenance.runId !== "string" || provenance.runId.length > 32 || !POSITIVE_INTEGER.test(provenance.runId)
    || typeof provenance.runAttempt !== "string" || provenance.runAttempt.length > 32 || !POSITIVE_INTEGER.test(provenance.runAttempt)
    || (provenance.pullRequestNumber !== null
      && (typeof provenance.pullRequestNumber !== "string" || provenance.pullRequestNumber.length > 32
        || !POSITIVE_INTEGER.test(provenance.pullRequestNumber)))
    || (provenance.eventName === "pull_request_target") !== (provenance.pullRequestNumber !== null)) {
    throw new TypeError("Runtime provenance contains malformed identity fields");
  }
  return provenance as unknown as GithubAdvisoryProvenance;
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((entry) => right.has(entry));
}

function replayDocument(value: unknown): Record<string, unknown> {
  const document = object(value, "Persisted replay report");
  const allowed = ["valid", "expected", "observed", "terminalHead", "events", "problems", "evidenceReplay", "authenticity"];
  if (Object.keys(document).some((key) => !allowed.includes(key))
    || !["valid", "expected", "observed", "terminalHead", "events", "problems", "authenticity"].every((key) => Object.hasOwn(document, key))) {
    throw new TypeError("Persisted replay report fields do not match its contract");
  }
  return document;
}

export async function verifyProofBundle(
  directory: string,
  options: ProofBundleVerificationOptions = {},
): Promise<ProofBundleVerificationReport> {
  const requestedDirectory = resolve(directory);
  let root = requestedDirectory;
  let caseId: string | undefined;
  let keyId: string | undefined;
  let provenance: GithubAdvisoryProvenance | undefined;
  let replay: ReplayResult | undefined;
  const integrityProblems: string[] = [];
  const expectationProblems: string[] = [];
  try {
    for (const [label, value] of [
      ["trustedKeyId", options.trustedKeyId],
    ] as const) {
      if (value !== undefined && !DIGEST.test(value)) throw new TypeError(`${label} must be a canonical SHA-256 key id`);
    }
    for (const [label, value] of [
      ["expectedRuntimeSha", options.expectedRuntimeSha],
      ["expectedSubjectSha", options.expectedSubjectSha],
      ["expectedWorkflowSha", options.expectedWorkflowSha],
    ] as const) {
      if (value !== undefined && !GIT_OID.test(value)) throw new TypeError(`${label} must be a full lowercase Git object id`);
    }

    root = await realpath(requestedDirectory);
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory()) throw new TypeError("Proof bundle path is not a directory");
    const discovered = await inventory(root);
    const manifestBytes = await readStableFile(root, "MANIFEST.sha256", MAX_MANIFEST_BYTES);
    const manifest = parseManifest(manifestBytes);
    const manifestedFiles = new Set(manifest.keys());
    const actualManifestedFiles = new Set([...discovered.files].filter((entry) => entry !== "MANIFEST.sha256"));
    if (!discovered.files.has("MANIFEST.sha256") || !sameSet(manifestedFiles, actualManifestedFiles)) {
      throw new Error("MANIFEST.sha256 does not name every and only regular bundle file");
    }
    let totalBytes = 0;
    for (const [entry, expected] of manifest) {
      const maximum = ARTIFACT_BODY.test(entry) ? MAX_ARTIFACT_BYTES : MAX_JSON_BYTES;
      const observed = await hashStableFile(root, entry, maximum);
      totalBytes += observed.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BUNDLE_BYTES) {
        throw new RangeError(`Proof bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
      }
      if (observed.hex !== expected) throw new Error(`MANIFEST.sha256 mismatch for ${entry}`);
    }

    const seal = assertSealReceipt(await jsonFile(root, manifest, "seal.json"));
    caseId = seal.caseId;
    const [sealed, record, status, terminal, trust, intentContract, policyDescriptor, artifactIndex] = await Promise.all([
      Promise.resolve(assertSealedCase(await jsonFile(root, manifest, "sealed.json"))),
      Promise.resolve(assertRecordPayload(await jsonFile(root, manifest, "record.json"))),
      Promise.resolve(assertCaseStatus(await jsonFile(root, manifest, "status.json"))),
      Promise.resolve(assertTerminalReceipt(await jsonFile(root, manifest, "terminal.json"))),
      assertPublicTrustBundle(await jsonFile(root, manifest, "trust.json")),
      Promise.resolve(assertIntentContractPayload(await jsonFile(root, manifest, "intent-contract.json"))),
      assertCasePolicyDescriptor(await jsonFile(root, manifest, "policy-descriptor.json"), seal.caseId),
      Promise.resolve(assertArtifactList(await jsonFile(root, manifest, "artifacts/index.json"), seal.caseId)),
    ]);
    const sealEnvelope = await jsonFile(root, manifest, "seal.dsse.json");
    const [verifiedSeal, verifiedRecord, verifiedTerminal] = await Promise.all([
      verifySealEnvelope(sealEnvelope, trust, seal),
      verifyRecordEnvelope(await jsonFile(root, manifest, "record.dsse.json"), trust, record),
      verifyTerminalEnvelope(await jsonFile(root, manifest, "terminal.dsse.json"), trust, terminal),
    ]);
    if (verifiedSeal.keyId !== verifiedRecord.keyId || verifiedSeal.keyId !== verifiedTerminal.keyId) {
      throw new Error("Seal, Record, and terminal closure were authenticated by different bundle keys");
    }
    keyId = verifiedRecord.keyId;
    if (options.trustedKeyId !== undefined && keyId !== options.trustedKeyId) {
      expectationProblems.push(`Authenticated key ${keyId} does not match the externally trusted key`);
    }
    if (canonicalJson(sealReceipt(sealed)) !== canonicalJson(seal)) {
      throw new Error("SealedCase does not reproduce the authenticated SealReceipt");
    }
    if (canonicalJson(sealed.intentContract) !== canonicalJson(intentContract)) {
      throw new Error("Exported IntentContract is not the contract inside the authenticated SealedCase");
    }
    if (intentContract.originalImpulse.trim() !== sealed.intent.impulse) {
      throw new Error("IntentContract original impulse does not normalize to the sealed impulse");
    }
    const recompiledContract = compileIntentContract({
      impulse: intentContract.originalImpulse,
      constraints: sealed.intent.constraints,
      requestedAssays: sealed.intent.requestedAssays,
      subjectIds: sealed.intent.subjects.map((subject) => subject.id),
    });
    if (canonicalJson(recompiledContract) !== canonicalJson(intentContract)) {
      throw new Error("IntentContract is not the deterministic compilation of the sealed intent");
    }
    if (record.caseDigest !== seal.caseDigest || record.runDigest !== seal.runDigest
      || record.policyDigest !== seal.policyDigest || record.genomeDigest !== seal.genomeDigest
      || record.searchDigest !== seal.searchDigest || record.intentContractDigest !== seal.intentContractDigest
      || record.verdict.policyVersion !== seal.policyVersion) {
      throw new Error("Record provenance does not equal the authenticated SealReceipt");
    }
    assertPolicyDescriptorRecordBinding(policyDescriptor, record);
    const effectivePolicy = object(policyDescriptor.artifact.descriptor, "Effective policy descriptor");
    if (effectivePolicy.version !== seal.policyVersion) {
      throw new Error("Effective policy descriptor version does not match the authenticated SealReceipt");
    }

    const provenanceBytes = await readStableFile(root, "runtime-provenance.json", MAX_JSON_BYTES);
    if (sha256(provenanceBytes).slice("sha256:".length) !== manifest.get("runtime-provenance.json")) {
      throw new Error("Runtime provenance changed after manifest verification");
    }
    provenance = assertProvenance(parseJsonBytes(provenanceBytes, "Runtime provenance"));
    const provenanceText = canonicalJson(provenance);
    if (!Buffer.from(provenanceBytes).equals(Buffer.from(provenanceText, "utf8"))) {
      throw new Error("Runtime provenance is not encoded as exact canonical JSON bytes");
    }
    if (options.expectedRuntimeSha !== undefined && provenance.runtimeSha !== options.expectedRuntimeSha) {
      expectationProblems.push("Runtime provenance does not match expectedRuntimeSha");
    }
    if (options.expectedSubjectSha !== undefined && provenance.subjectSha !== options.expectedSubjectSha) {
      expectationProblems.push("Runtime provenance does not match expectedSubjectSha");
    }
    if (options.expectedWorkflowSha !== undefined && provenance.workflowSha !== options.expectedWorkflowSha) {
      expectationProblems.push("Runtime provenance does not match expectedWorkflowSha");
    }
    const [sourceReference, provenanceReference] = sealed.intent.subjects;
    const [sourceSnapshot, provenanceSnapshot] = sealed.subjects;
    if (sealed.intent.subjects.length !== 2 || sealed.subjects.length !== 2
      || sourceReference?.id !== "subject-1" || sourceReference.kind !== "git"
      || sourceReference.revision !== provenance.subjectSha
      || sourceSnapshot?.subjectId !== "subject-1" || sourceSnapshot.revision !== provenance.subjectSha
      || sourceSnapshot.resolvedLocator !== sourceReference.locator
      || provenanceReference?.id !== "subject-2" || provenanceReference.kind !== "text"
      || provenanceReference.locator !== provenanceText
      || Object.hasOwn(provenanceReference, "revision")
      || Object.hasOwn(provenanceReference, "mediaType")
      || provenanceSnapshot?.subjectId !== "subject-2"
      || provenanceSnapshot.digest !== sha256(provenanceBytes)
      || provenanceSnapshot.resolvedLocator !== "inline:subject-2"
      || provenanceSnapshot.byteLength !== provenanceBytes.byteLength
      || Object.hasOwn(provenanceSnapshot, "revision")
      || Object.hasOwn(provenanceSnapshot, "mediaType")) {
      throw new Error("Authenticated SealedCase does not bind the exact Git subject and runtime provenance");
    }

    if (status.lifecycle !== "terminated" && status.lifecycle !== "invalid") {
      throw new Error("Proof bundle status is not terminal");
    }
    if (status.caseDigest !== record.caseDigest || status.runDigest !== record.runDigest) {
      throw new Error("Terminal status does not belong to the authenticated Record");
    }
    const rawEvents = await jsonFile(root, manifest, "events.json");
    if (!Array.isArray(rawEvents) || rawEvents.length === 0) throw new TypeError("events.json must be a non-empty array");
    const events = rawEvents as PublicTraceEvent[];
    const chain = await verifyEventChain(events);
    if (!chain.valid) throw new Error(`Event chain is invalid: ${chain.problems.join("; ")}`);
    const finalEvent = events.at(-1);
    if (chain.caseDigest !== record.caseDigest || chain.runDigest !== record.runDigest
      || status.lastSequence !== finalEvent?.sequence || status.lastSequence !== events.length
      || status.headDigest !== chain.headDigest || status.headDigest !== finalEvent?.eventDigest) {
      throw new Error("events.json does not equal the declared terminal ledger");
    }
    if (terminal.caseId !== seal.caseId
      || terminal.caseDigest !== record.caseDigest
      || terminal.runDigest !== record.runDigest
      || terminal.recordDigest !== sha256(Buffer.from(canonicalJson(record), "utf8"))
      || terminal.artifactIndexDigest !== sha256(Buffer.from(canonicalJson(artifactIndex), "utf8"))
      || terminal.lifecycle !== status.lifecycle
      || terminal.stage !== status.stage
      || terminal.stageStatus !== status.stageStatus
      || terminal.lastSequence !== status.lastSequence
      || terminal.eventHeadDigest !== status.headDigest
      || terminal.closedAt !== status.updatedAt
      || terminal.closedAt !== finalEvent?.observedAt) {
      throw new Error("Authenticated terminal closure does not equal the Record, artifact index, terminal status, and final event");
    }
    const expectedFiles = new Set<string>([
      ...ROOT_FILES,
      "artifacts/index.json",
      ...artifactIndex.artifacts.map((meta) => `artifacts/${meta.id}.blob`),
    ]);
    if (!sameSet(expectedFiles, manifestedFiles)) {
      throw new Error("Proof bundle does not have the closed version-1 file layout");
    }
    let previousArtifactId = "";
    const artifactByDigest = new Map<string, ArtifactList["artifacts"][number]>();
    const replayBytes = new Map<string, Uint8Array>();
    for (const meta of artifactIndex.artifacts) {
      if (previousArtifactId && previousArtifactId >= meta.id) {
        throw new Error("Artifact index is not in strict identifier order");
      }
      previousArtifactId = meta.id;
      if (meta.mediaType === ORIGINAL_SUBJECT_CERTIFICATE_MEDIA && meta.size > MAX_ORIGINAL_SUBJECT_CERTIFICATE_BYTES) throw new RangeError("Original-subject certificate exceeds its bounded replay envelope");
      const entry = `artifacts/${meta.id}.blob`;
      const hashed = await hashStableFile(root, entry, MAX_ARTIFACT_BYTES);
      if (hashed.size !== meta.size || `sha256:${hashed.hex}` !== meta.digest) {
        throw new Error(`Artifact body does not match indexed metadata: ${meta.id}`);
      }
      artifactByDigest.set(meta.digest, meta);
      if (REPLAYABLE_MEDIA_TYPES.has(meta.mediaType)) {
        const bytes = await readStableFile(root, entry, Math.min(MAX_ARTIFACT_BYTES, 32 * 1_048_576));
        if (sha256(bytes) !== meta.digest) throw new Error(`Replay artifact changed after verification: ${meta.id}`);
        replayBytes.set(meta.digest, bytes);
      }
    }

    replay = await replayTrace(record, events, intentContract, {
      persistedEvidence: {
        policyDescriptor,
        trustedRecordKeys: new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem])),
        originalSubject: { sealedCase: sealed, sealEnvelope: verifiedSeal.envelope,
          trustedCaseKeys: new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem])) },
        resolveArtifact: async (digest) => {
          const meta = artifactByDigest.get(digest);
          if (meta === undefined) return undefined;
          if (!REPLAYABLE_MEDIA_TYPES.has(meta.mediaType)) {
            throw new TypeError(`Replay digest ${digest} has unsupported media type ${meta.mediaType}`);
          }
          return replayBytes.get(digest);
        },
      },
    });
    if (!replay.valid) throw new Error(`Independent replay failed: ${replay.problems.join("; ")}`);
    if (replay.terminalHead !== status.headDigest || replay.events !== status.lastSequence) {
      throw new Error("Independent replay did not consume the exact terminal ledger");
    }
    const saved = replayDocument(await jsonFile(root, manifest, "replay.json"));
    const authenticity = object(saved.authenticity, "Persisted replay authenticity");
    exactKeys(authenticity, ["verification", "keyId"], "Persisted replay authenticity");
    if (authenticity.verification !== "dsse-ed25519" || authenticity.keyId !== keyId) {
      throw new Error("Persisted replay report does not name the authenticated Record key");
    }
    const { authenticity: _ignored, ...savedReplay } = saved;
    if (canonicalJson(savedReplay) !== canonicalJson(replay)) {
      throw new Error("Persisted replay report differs from fresh offline replay");
    }

    const finalManifestBytes = await readStableFile(root, "MANIFEST.sha256", MAX_MANIFEST_BYTES);
    if (!Buffer.from(finalManifestBytes).equals(Buffer.from(manifestBytes))) {
      throw new Error("MANIFEST.sha256 changed during verification");
    }
  } catch (error) {
    integrityProblems.push(error instanceof Error ? error.message : String(error));
  }

  const problems = [...integrityProblems, ...expectationProblems];
  const integrityValid = integrityProblems.length === 0;
  const anchored = integrityValid && options.trustedKeyId !== undefined && keyId === options.trustedKeyId;
  return {
    protocol: "jevyr.proof-bundle-verification/1",
    directory: root,
    valid: integrityValid && anchored && expectationProblems.length === 0,
    integrityValid,
    trust: {
      anchored,
      ...(keyId === undefined ? {} : { keyId }),
      scope: keyId === undefined
        ? "unavailable"
        : anchored
          ? "externally-pinned-key"
          : "bundle-declared-key",
    },
    ...(caseId === undefined ? {} : { caseId }),
    ...(provenance === undefined ? {} : { provenance }),
    ...(replay === undefined ? {} : { replay }),
    problems,
  };
}
