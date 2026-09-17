import { assertRunAttestations, canonicalRecordText, deriveRunStatements, IN_TOTO_DSSE_PAYLOAD_TYPE, type RunAttestations, type RunStatement, type SealReceipt, type SignedRecord, type TerminalReceipt } from "@jevyr/protocol";
import { canonicalJson } from "./digest.js";
import { JevyrContinuityError } from "./errors.js";
import { assertPublicTrustBundle, dssePae, verifyRecordEnvelope, verifySealEnvelope, verifyTerminalEnvelope } from "./trust.js";
export type { RunAttestations, RunStatement } from "@jevyr/protocol";
export { canonicalRecordText } from "@jevyr/protocol";

export interface RunAttestationMaterial {
  readonly seal: SealReceipt; readonly record: SignedRecord; readonly terminal: TerminalReceipt;
  readonly sealEnvelope: unknown; readonly recordEnvelope: unknown; readonly terminalEnvelope: unknown; readonly trust: unknown;
}
export interface VerifiedRunAttestations {
  readonly payload: RunAttestations;
  readonly statements: { readonly production: RunStatement; readonly advisory: RunStatement };
  readonly keyId: string;
  readonly verification: "dsse-ed25519+exact-derived-run-statements";
  readonly slsaLevelClaim: "none";
  /** Save verbatim as UTF-8 canonical-record.json, without a trailing newline. */
  readonly canonicalRecord: string;
}
const buffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
function base64(value: string): Uint8Array {
  try {
    const raw = atob(value);
    if (btoa(raw) !== value) throw new Error();
    return Uint8Array.from(raw, char => char.charCodeAt(0));
  } catch { throw new JevyrContinuityError("Run attestation contains noncanonical base64"); }
}

/** This purpose-specific verifier derives both allowed predicates itself. It does
 * not extend the three-payload public trust contract or verify arbitrary in-toto. */
export async function verifyRunAttestations(raw: unknown, material: RunAttestationMaterial): Promise<VerifiedRunAttestations> {
  const value: unknown = structuredClone(raw); assertRunAttestations(value);
  const [seal, record, terminal, trust] = await Promise.all([
    verifySealEnvelope(material.sealEnvelope, material.trust, material.seal),
    verifyRecordEnvelope(material.recordEnvelope, material.trust, material.record),
    verifyTerminalEnvelope(material.terminalEnvelope, material.trust, material.terminal), assertPublicTrustBundle(material.trust),
  ]);
  if (seal.keyId !== record.keyId || seal.keyId !== terminal.keyId || value.caseId !== seal.payload.caseId || value.runDigest !== seal.payload.runDigest) throw new JevyrContinuityError("Run attestation changed the authenticated Case or signer");
  const statements = deriveRunStatements(seal.payload, record.payload, terminal.payload, seal.keyId);
  const signer = trust.keys.find(key => key.keyId === seal.keyId)!;
  const pem = signer.publicKeyPem.trim().split(/\r?\n/u); pem.shift(); pem.pop();
  const key = await crypto.subtle.importKey("spki", buffer(base64(pem.join(""))), { name: "Ed25519" }, false, ["verify"]);
  for (const name of ["production", "advisory"] as const) {
    const envelope = value[name], payload = base64(envelope.payload), signature = envelope.signatures[0]!;
    if (signature.keyid !== seal.keyId || new TextDecoder("utf-8", {fatal:true}).decode(payload) !== canonicalJson(statements[name])
      || !await crypto.subtle.verify({ name: "Ed25519" }, key, buffer(base64(signature.sig)), buffer(dssePae(IN_TOTO_DSSE_PAYLOAD_TYPE, payload)))) throw new JevyrContinuityError(`Run ${name} attestation failed exact payload or signature verification`);
  }
  return { payload: value, statements, keyId: seal.keyId, verification: "dsse-ed25519+exact-derived-run-statements", slsaLevelClaim: "none", canonicalRecord: canonicalRecordText(record.payload) };
}
