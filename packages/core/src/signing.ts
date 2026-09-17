import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import {
  canonicalize,
  type DsseEnvelope,
  type JsonValue,
  type SealReceipt,
  type SignedRecord,
  type TerminalReceipt,
} from "@jevyr/protocol";
import { parseJsonBytes } from "./json.js";

export const SEAL_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.seal+json";
export const RECORD_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.record+json";
export const TERMINAL_DSSE_PAYLOAD_TYPE = "application/vnd.jevyr.terminal+json";

export interface Ed25519KeyPair {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function canonicalBase64(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length % 4 !== 0) return undefined;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.toString("base64") === value ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** DSSE pre-authentication encoding from the DSSE v1 protocol. */
export function dssePae(payloadType: string, payload: Uint8Array): Uint8Array {
  const type = Buffer.from(payloadType, "utf8");
  const body = Buffer.from(payload);
  return Buffer.concat([Buffer.from(`DSSEv1 ${type.length} `), type, Buffer.from(` ${body.length} `), body]);
}

export function keyIdFor(publicKey: KeyObject | string): string {
  const key = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  const der = key.export({ type: "spki", format: "der" });
  return `sha256:${createHash("sha256").update(der).digest("hex")}`;
}

export function generateSigningKeyPair(): Ed25519KeyPair {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { keyId: keyIdFor(pair.publicKey), publicKeyPem, privateKeyPem };
}

export function signDsse(payloadType: string, payload: string | Uint8Array, privateKey: KeyObject | string, keyId?: string): DsseEnvelope {
  const body = bytes(payload);
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  const publicKey = createPublicKey(key);
  const resolvedKeyId = keyId ?? keyIdFor(publicKey);
  const signature = sign(null, dssePae(payloadType, body), key);
  return Object.freeze({
    payloadType,
    payload: Buffer.from(body).toString("base64"),
    signatures: Object.freeze([{ keyid: resolvedKeyId, sig: signature.toString("base64") }]),
  });
}

export function signJsonDsse(payloadType: string, payload: JsonValue, privateKey: KeyObject | string, keyId?: string): DsseEnvelope {
  return signDsse(payloadType, canonicalize(payload), privateKey, keyId);
}

export function signSealReceipt(receipt: SealReceipt, privateKey: KeyObject | string, keyId?: string): DsseEnvelope {
  return signJsonDsse(SEAL_DSSE_PAYLOAD_TYPE, receipt as unknown as JsonValue, privateKey, keyId);
}

export function signJevyrRecord(record: SignedRecord, privateKey: KeyObject | string, keyId?: string): DsseEnvelope {
  return signJsonDsse(RECORD_DSSE_PAYLOAD_TYPE, record as unknown as JsonValue, privateKey, keyId);
}

export function signTerminalReceipt(receipt: TerminalReceipt, privateKey: KeyObject | string, keyId?: string): DsseEnvelope {
  return signJsonDsse(TERMINAL_DSSE_PAYLOAD_TYPE, receipt as unknown as JsonValue, privateKey, keyId);
}

export function verifyDsse(envelope: DsseEnvelope, publicKeys: ReadonlyMap<string, KeyObject | string>): boolean {
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(canonicalize(envelope as unknown as JsonValue)) as unknown;
  } catch {
    return false;
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
  const value = snapshot as Record<string, unknown>;
  if (
    Object.keys(value).sort().join("\0") !== "payload\0payloadType\0signatures" ||
    typeof value.payloadType !== "string" ||
    value.payloadType.length === 0 ||
    !Array.isArray(value.signatures) ||
    value.signatures.length === 0
  ) return false;
  const payload = canonicalBase64(value.payload);
  if (payload === undefined) return false;
  const signatures = value.signatures.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const fields = entry as Record<string, unknown>;
    return Object.keys(fields).sort().join("\0") === "keyid\0sig"
      && typeof fields.keyid === "string"
      && canonicalBase64(fields.sig) !== undefined;
  }) ? value.signatures as Array<{ keyid: string; sig: string }> : undefined;
  if (signatures === undefined) return false;
  const pae = dssePae(value.payloadType, payload);
  return signatures.some((entry) => {
    const candidate = publicKeys.get(entry.keyid);
    if (candidate === undefined) return false;
    try {
      const signature = canonicalBase64(entry.sig);
      return signature !== undefined
        && verify(null, pae, typeof candidate === "string" ? createPublicKey(candidate) : candidate, signature);
    } catch {
      return false;
    }
  });
}

export function decodeDsseJson<T>(envelope: DsseEnvelope): T {
  const payload = canonicalBase64(envelope.payload);
  if (payload === undefined) throw new TypeError("DSSE payload is not canonical base64");
  return parseJsonBytes(payload, "DSSE JSON payload") as T;
}
