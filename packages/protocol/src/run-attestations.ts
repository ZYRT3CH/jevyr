import { canonicalize, digestJson, isSha256Digest, type JsonValue } from "./canonical.js";
import { validateSealReceipt, validateSignedRecord, validateTerminalReceipt } from "./validation.js";
import type { DsseEnvelope, SealReceipt, SignedRecord, TerminalReceipt } from "./types.js";

export const RUN_ATTESTATIONS_PROTOCOL = "jevyr.run-attestations/1" as const;
export const IN_TOTO_DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json" as const;
export const SLSA_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1" as const;
export const ADVISORY_VERDICT_PREDICATE_TYPE = "urn:jevyr:advisory-verdict:v1" as const;
export interface RunStatement {
  readonly _type: "https://in-toto.io/Statement/v1";
  readonly subject: readonly { readonly name: "canonical-record.json"; readonly digest: { readonly sha256: string } }[];
  readonly predicateType: typeof SLSA_PROVENANCE_PREDICATE_TYPE | typeof ADVISORY_VERDICT_PREDICATE_TYPE;
  readonly predicate: JsonValue;
}
export interface RunAttestations {
  readonly protocol: typeof RUN_ATTESTATIONS_PROTOCOL;
  readonly caseId: string;
  readonly runDigest: string;
  readonly production: DsseEnvelope;
  readonly advisory: DsseEnvelope;
}
const json = (value: unknown) => value as JsonValue;

/** Exact UTF-8 bytes are this canonical JSON text, with no trailing newline. */
export function canonicalRecordText(record: SignedRecord): string {
  if (!validateSignedRecord(record).ok) throw new TypeError("Canonical Record requires a valid signed-Record payload");
  return canonicalize(json(record));
}

/** Fixed builder/advisory predicates only. No caller-defined payload or policy assertion. */
export function deriveRunStatements(seal: SealReceipt, record: SignedRecord, terminal: TerminalReceipt, keyId: string): { production: RunStatement; advisory: RunStatement } {
  if (!validateSealReceipt(seal).ok || !validateSignedRecord(record).ok || !validateTerminalReceipt(terminal).ok || !isSha256Digest(keyId)) throw new TypeError("Run statements require valid sealed provenance and terminal payloads");
  for (const key of ["caseDigest", "runDigest", "policyDigest", "genomeDigest", "searchDigest", "intentContractDigest"] as const) if (seal[key] !== record[key]) throw new TypeError(`Run statement Record differs from Seal ${key}`);
  if (terminal.caseId !== seal.caseId || terminal.caseDigest !== seal.caseDigest || terminal.runDigest !== seal.runDigest || terminal.recordDigest !== digestJson(json(record)) || terminal.closedAt < seal.sealedAt) throw new TypeError("Run statement terminal identity or canonical Record digest mismatch");
  const subject = [{ name: "canonical-record.json" as const, digest: { sha256: terminal.recordDigest.slice(7) } }];
  const dependency = (name: string, digest: string) => ({ uri: `urn:jevyr:${name}:${digest}`, digest: { sha256: digest.slice(7) } });
  const dependencies = [dependency("policy", seal.policyDigest), dependency("genome", seal.genomeDigest), dependency("search", seal.searchDigest),
    dependency("subject-material-capture", seal.subjectMaterialCaptureDigest), dependency("intent-contract", seal.intentContractDigest),
    dependency("evidence", record.verdict.evidenceDigest), dependency("artifact-index", terminal.artifactIndexDigest), dependency("terminal-receipt", digestJson(json(terminal))),
    ...(terminal.eventHeadDigest ? [dependency("event-head", terminal.eventHeadDigest)] : [])];
  const production: RunStatement = { _type: "https://in-toto.io/Statement/v1", subject, predicateType: SLSA_PROVENANCE_PREDICATE_TYPE,
    predicate: json({ buildDefinition: { buildType: "urn:jevyr:local-case-lifecycle:v1", externalParameters: { caseDigest: seal.caseDigest, intentContractDigest: seal.intentContractDigest },
      internalParameters: { policyDigest: seal.policyDigest, genomeDigest: seal.genomeDigest, searchDigest: seal.searchDigest }, resolvedDependencies: dependencies },
      runDetails: { builder: { id: `urn:jevyr:local-builder:${keyId}` }, metadata: { invocationId: seal.runDigest, startedOn: seal.sealedAt, finishedOn: terminal.closedAt } } }) };
  const advisory: RunStatement = { _type: "https://in-toto.io/Statement/v1", subject, predicateType: ADVISORY_VERDICT_PREDICATE_TYPE,
    predicate: json({ protocol: "jevyr.advisory-verdict/1", caseId: seal.caseId, caseDigest: seal.caseDigest, runDigest: seal.runDigest,
      policyDigest: seal.policyDigest, genomeDigest: seal.genomeDigest, searchDigest: seal.searchDigest, intentContractDigest: seal.intentContractDigest,
      evidenceDigest: record.verdict.evidenceDigest, eventHeadDigest: terminal.eventHeadDigest, artifactIndexDigest: terminal.artifactIndexDigest,
      terminalReceiptDigest: digestJson(json(terminal)), lifecycle: terminal.lifecycle,
      axes: { integrity: record.verdict.integrity, creation: record.verdict.creation, embodiment: record.verdict.embodiment, judgment: record.verdict.judgment },
      authority: "advisory-only", enforcement: "none", slsaLevelClaim: "none" }) };
  return structuredClone({ production, advisory });
}

export function assertRunAttestations(raw: unknown): asserts raw is RunAttestations {
  const exact = (value: unknown, keys: readonly string[]) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError("Run attestation has unknown or missing fields");
    return value as Record<string, unknown>;
  };
  const value = exact(raw, ["protocol", "caseId", "runDigest", "production", "advisory"]);
  if (value.protocol !== RUN_ATTESTATIONS_PROTOCOL || !isSha256Digest(value.runDigest) || value.caseId !== `case_${value.runDigest.slice(7, 23)}`) throw new TypeError("Run attestation identity is invalid");
  for (const name of ["production", "advisory"] as const) {
    const envelope = exact(value[name], ["payloadType", "payload", "signatures"]);
    if (envelope.payloadType !== IN_TOTO_DSSE_PAYLOAD_TYPE || typeof envelope.payload !== "string" || envelope.payload.length > 262_144 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(envelope.payload)
      || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) throw new TypeError("Run attestation envelope is not the bounded in-toto contract");
    const signature = exact(envelope.signatures[0], ["keyid", "sig"]);
    if (!isSha256Digest(signature.keyid) || typeof signature.sig !== "string" || !/^[A-Za-z0-9+/]{86}==$/u.test(signature.sig)) throw new TypeError("Run attestation requires exactly one Ed25519 signature");
  }
}
