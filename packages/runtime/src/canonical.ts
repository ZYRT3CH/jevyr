import { createHash, randomBytes } from "node:crypto";

function normalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot encode non-finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, normalize(record[key])]),
    );
  }
  throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function stableId(prefix: string, value: unknown, length = 20): string {
  return `${prefix}_${sha256(canonicalJson(value)).slice(0, length)}`;
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

export function seededUnit(seed: string, index: number): number {
  const hex = sha256(`${seed}:${index}`).slice(0, 13);
  // Thirteen hexadecimal digits span 52 bits. Keep the value strictly below
  // one so callers can safely use it for array selection and coordinates.
  return Number.parseInt(hex, 16) / 0x10_0000_0000_0000;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
