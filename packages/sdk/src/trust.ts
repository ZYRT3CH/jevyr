import type { DsseEnvelope, PublicTrustBundle, SealReceipt, SignedRecord, TerminalReceipt } from "@jevyr/protocol";
import { canonicalJson } from "./digest.js";
import { JevyrContinuityError } from "./errors.js";
import { parseUnambiguousJsonText } from "./json.js";
import type { VerifiedDssePayload } from "./types.js";
import { assertRecordPayload, assertSealReceipt, assertTerminalReceipt } from "./verify.js";

export const SEAL_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.seal+json" as const;
export const RECORD_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.record+json" as const;
export const TERMINAL_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.terminal+json" as const;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PAYLOAD_TYPES = [SEAL_DSSE_PAYLOAD_TYPE, RECORD_DSSE_PAYLOAD_TYPE, TERMINAL_DSSE_PAYLOAD_TYPE] as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snapshot(value: unknown, label: string): unknown {
  try {
    return structuredClone(value);
  } catch {
    throw new JevyrContinuityError(`${label} is not cloneable JSON data`);
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (keys.length !== canonical.length || keys.some((key, index) => key !== canonical[index])) {
    throw new JevyrContinuityError(`${label} fields do not match its versioned contract`);
  }
}

function decodeBase64(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new JevyrContinuityError(`${label} is not canonical base64`);
  }
  try {
    const decoded = globalThis.atob(value);
    if (globalThis.btoa(decoded) !== value) throw new Error("non-canonical base64");
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    throw new JevyrContinuityError(`${label} is not valid base64`);
  }
}

function spkiBytes(publicKeyPem: string): Uint8Array {
  if (publicKeyPem.includes("PRIVATE KEY")) throw new JevyrContinuityError("Trust bundle contains private key material");
  const lines = publicKeyPem.trim().split(/\r?\n/u);
  if (lines.shift() !== "-----BEGIN PUBLIC KEY-----" || lines.pop() !== "-----END PUBLIC KEY-----") {
    throw new JevyrContinuityError("Trust key is not a PUBLIC KEY PEM document");
  }
  return decodeBase64(lines.join(""), "Trust key body");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function keyIdForSpki(spki: Uint8Array): Promise<string> {
  return `sha256:${hex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", arrayBuffer(spki))))}`;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

/** DSSE v1 pre-authentication encoding. */
export function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const type = encoder.encode(payloadType);
  return concat(
    encoder.encode(`DSSEv1 ${type.byteLength} `),
    type,
    encoder.encode(` ${payload.byteLength} `),
    payload,
  );
}

export function assertDsseEnvelope(value: unknown): DsseEnvelope {
  value = snapshot(value, "DSSE envelope");
  if (!object(value)) throw new JevyrContinuityError("DSSE endpoint returned a non-object envelope");
  exactKeys(value, ["payloadType", "payload", "signatures"], "DSSE envelope");
  if (typeof value.payloadType !== "string" || !PAYLOAD_TYPES.includes(value.payloadType as typeof PAYLOAD_TYPES[number])) {
    throw new JevyrContinuityError("DSSE envelope uses an unsupported payload type");
  }
  decodeBase64(value.payload, "DSSE payload");
  if (!Array.isArray(value.signatures) || value.signatures.length === 0) throw new JevyrContinuityError("DSSE envelope has no signatures");
  for (const entry of value.signatures) {
    if (!object(entry)) throw new JevyrContinuityError("DSSE signature entry is not an object");
    exactKeys(entry, ["keyid", "sig"], "DSSE signature");
    if (typeof entry.keyid !== "string" || !DIGEST.test(entry.keyid)) throw new JevyrContinuityError("DSSE signature has an invalid key id");
    if (decodeBase64(entry.sig, "DSSE signature").byteLength !== 64) throw new JevyrContinuityError("Ed25519 signature must contain 64 bytes");
  }
  return value as unknown as DsseEnvelope;
}

export async function assertPublicTrustBundle(value: unknown): Promise<PublicTrustBundle> {
  value = snapshot(value, "Public trust bundle");
  if (!object(value) || value.protocol !== "jevyr.trust-bundle/1") {
    throw new JevyrContinuityError("Trust endpoint did not return jevyr.trust-bundle/1");
  }
  exactKeys(value, ["protocol", "keys"], "PublicTrustBundle");
  if (!Array.isArray(value.keys) || value.keys.length === 0) throw new JevyrContinuityError("Trust bundle contains no public keys");
  const seen = new Set<string>();
  for (const raw of value.keys) {
    if (!object(raw)) throw new JevyrContinuityError("Trust key is not an object");
    exactKeys(raw, ["keyId", "algorithm", "publicKeyPem", "payloadTypes"], "PublicTrustKey");
    if (typeof raw.keyId !== "string" || !DIGEST.test(raw.keyId) || raw.algorithm !== "Ed25519" || typeof raw.publicKeyPem !== "string") {
      throw new JevyrContinuityError("Trust key metadata is invalid");
    }
    if (!Array.isArray(raw.payloadTypes)
      || raw.payloadTypes.length !== PAYLOAD_TYPES.length
      || raw.payloadTypes.some((entry, index) => entry !== PAYLOAD_TYPES[index])) {
      throw new JevyrContinuityError("Trust key payloadTypes do not match the Jevyr signing contract");
    }
    if (seen.has(raw.keyId)) throw new JevyrContinuityError(`Trust bundle repeats key id ${raw.keyId}`);
    seen.add(raw.keyId);
    const spki = spkiBytes(raw.publicKeyPem);
    if (await keyIdForSpki(spki) !== raw.keyId) throw new JevyrContinuityError(`Trust key ${raw.keyId} does not match its public key bytes`);
    try {
      await globalThis.crypto.subtle.importKey("spki", arrayBuffer(spki), { name: "Ed25519" }, false, ["verify"]);
    } catch {
      throw new JevyrContinuityError(`Trust key ${raw.keyId} is not a valid Ed25519 public key`);
    }
  }
  return value as unknown as PublicTrustBundle;
}

async function verifyEnvelope<T>(
  envelopeValue: unknown,
  bundleValue: unknown,
  payloadType: typeof PAYLOAD_TYPES[number],
  parsePayload: (value: unknown) => T,
  expectedPayload?: T,
): Promise<VerifiedDssePayload<T>> {
  const envelope = assertDsseEnvelope(envelopeValue);
  const expected = expectedPayload === undefined ? undefined : snapshot(expectedPayload, "Expected payload") as T;
  const bundle = await assertPublicTrustBundle(bundleValue);
  if (envelope.payloadType !== payloadType) throw new JevyrContinuityError(`Expected DSSE payload type ${payloadType}`);

  const payloadBytes = decodeBase64(envelope.payload, "DSSE payload");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    throw new JevyrContinuityError("DSSE payload is not valid UTF-8");
  }
  let decoded: unknown;
  try {
    decoded = parseUnambiguousJsonText(text, "DSSE payload");
  } catch {
    throw new JevyrContinuityError("DSSE payload is not valid unambiguous JSON");
  }
  const payload = parsePayload(decoded);
  if (canonicalJson(payload) !== text) throw new JevyrContinuityError("DSSE payload bytes are not canonical JSON for the decoded payload");
  if (expected !== undefined && canonicalJson(expected) !== text) {
    throw new JevyrContinuityError("DSSE payload does not equal the canonical endpoint payload");
  }

  const trustById = new Map(bundle.keys.map((key) => [key.keyId, key]));
  const pae = dssePae(payloadType, payloadBytes);
  let trustedKeyId: string | undefined;
  for (const signature of envelope.signatures) {
    const trusted = trustById.get(signature.keyid);
    if (!trusted || !trusted.payloadTypes.includes(payloadType)) continue;
    try {
      const publicKey = await globalThis.crypto.subtle.importKey("spki", arrayBuffer(spkiBytes(trusted.publicKeyPem)), { name: "Ed25519" }, false, ["verify"]);
      const valid = await globalThis.crypto.subtle.verify(
        { name: "Ed25519" },
        publicKey,
        arrayBuffer(decodeBase64(signature.sig, "DSSE signature")),
        arrayBuffer(pae),
      );
      if (valid) {
        trustedKeyId = trusted.keyId;
        break;
      }
    } catch {
      // A malformed key was already rejected with detail above. Do not mistake a verification failure for parsing success.
    }
  }
  if (!trustedKeyId) throw new JevyrContinuityError("DSSE Ed25519 signature did not verify under a trusted key id");
  return { payload, envelope, keyId: trustedKeyId, payloadType, verification: "dsse-ed25519" };
}

export async function verifySealEnvelope(
  envelope: unknown,
  trustBundle: unknown,
  expectedPayload?: SealReceipt,
): Promise<VerifiedDssePayload<SealReceipt>> {
  return await verifyEnvelope(envelope, trustBundle, SEAL_DSSE_PAYLOAD_TYPE, assertSealReceipt, expectedPayload);
}

export async function verifyRecordEnvelope(
  envelope: unknown,
  trustBundle: unknown,
  expectedPayload?: SignedRecord,
): Promise<VerifiedDssePayload<SignedRecord>> {
  return await verifyEnvelope(envelope, trustBundle, RECORD_DSSE_PAYLOAD_TYPE, assertRecordPayload, expectedPayload);
}

export async function verifyTerminalEnvelope(
  envelope: unknown,
  trustBundle: unknown,
  expectedPayload?: TerminalReceipt,
): Promise<VerifiedDssePayload<TerminalReceipt>> {
  return await verifyEnvelope(envelope, trustBundle, TERMINAL_DSSE_PAYLOAD_TYPE, assertTerminalReceipt, expectedPayload);
}
