export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value))
        throw new TypeError("Canonical JSON does not permit non-finite numbers");
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object": {
      const object = value as object;
      if (seen.has(object)) throw new TypeError("Canonical JSON does not permit cyclic values");
      seen.add(object);
      try {
        const ownKeys = Reflect.ownKeys(object);
        if (ownKeys.some((key) => typeof key !== "string")) {
          throw new TypeError("Canonical JSON does not permit symbol properties");
        }
        const descriptors = Object.getOwnPropertyDescriptors(object);
        if (Array.isArray(value)) {
          if (Object.getPrototypeOf(value) !== Array.prototype) {
            throw new TypeError("Canonical JSON arrays must use the intrinsic Array prototype");
          }
          if (ownKeys.length !== value.length + 1) {
            throw new TypeError("Canonical JSON arrays must be dense and contain no extra properties");
          }
          const items: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            const descriptor = descriptors[String(index)];
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
              throw new TypeError(
                "Canonical JSON arrays must contain enumerable data properties at every index",
              );
            }
            const item = descriptor.value;
            if (
              item === undefined ||
              typeof item === "function" ||
              typeof item === "symbol" ||
              typeof item === "bigint"
            ) {
              throw new TypeError("Canonical JSON arrays may contain only JSON values");
            }
            items.push(serialize(item, seen));
          }
          return `[${items.join(",")}]`;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError("Canonical JSON objects must be plain objects");
        }

        const keys = (ownKeys as string[]).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        const fields: string[] = [];
        for (const key of keys) {
          const descriptor = descriptors[key];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            throw new TypeError(
              `Canonical JSON property ${JSON.stringify(key)} must be an enumerable data property`,
            );
          }
          const item = descriptor.value;
          if (
            item === undefined ||
            typeof item === "function" ||
            typeof item === "symbol" ||
            typeof item === "bigint"
          ) {
            throw new TypeError(
              `Canonical JSON property ${JSON.stringify(key)} is not a JSON value`,
            );
          }
          fields.push(`${JSON.stringify(key)}:${serialize(item, seen)}`);
        }
        return `{${fields.join(",")}}`;
      } finally {
        seen.delete(object);
      }
    }
    default:
      throw new TypeError(`Canonical JSON cannot encode ${typeof value}`);
  }
}

/** Deterministic JSON serialization with lexicographically sorted object keys. */
export function canonicalize(value: JsonValue): string {
  return serialize(value, new Set());
}

const SHA256_INITIAL = Object.freeze([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

const SHA256_ROUND = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

export function sha256Bytes(value: Uint8Array | string): Uint8Array {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const paddedView = new DataView(padded.buffer);
  const bitLength = input.byteLength * 8;
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let [h0, h1, h2, h3, h4, h5, h6, h7] = SHA256_INITIAL;
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] ?? 0;
      const right = words[index - 2] ?? 0;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }

    let a = h0 ?? 0;
    let b = h1 ?? 0;
    let c = h2 ?? 0;
    let d = h3 ?? 0;
    let e = h4 ?? 0;
    let f = h5 ?? 0;
    let g = h6 ?? 0;
    let h = h7 ?? 0;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 =
        (h + sigma1 + choice + (SHA256_ROUND[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    h0 = ((h0 ?? 0) + a) >>> 0;
    h1 = ((h1 ?? 0) + b) >>> 0;
    h2 = ((h2 ?? 0) + c) >>> 0;
    h3 = ((h3 ?? 0) + d) >>> 0;
    h4 = ((h4 ?? 0) + e) >>> 0;
    h5 = ((h5 ?? 0) + f) >>> 0;
    h6 = ((h6 ?? 0) + g) >>> 0;
    h7 = ((h7 ?? 0) + h) >>> 0;
  }

  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((word, index) => {
    outputView.setUint32(index * 4, word ?? 0, false);
  });
  return output;
}

export function sha256Digest(value: Uint8Array | string): string {
  return `sha256:${[...sha256Bytes(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export function digestJson(value: JsonValue): string {
  return sha256Digest(canonicalize(value));
}

export function isSha256Digest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
}
