import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** Resolve one explicit broker reference at startup; retain only a fixed digest. */
export function createHttpAccess(env: NodeJS.ProcessEnv): {
  readonly required: boolean;
  readonly allowRemoteBind: boolean;
  authorize(headers: IncomingHttpHeaders): boolean;
} {
  const reference = env.JEVYR_HTTP_TOKEN_REF;
  let expected: Buffer | undefined;
  if (reference !== undefined) {
    if (!/^env:[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(reference)) throw new TypeError("JEVYR_HTTP_TOKEN_REF must be an explicit env:NAME broker reference");
    const token = env[reference.slice(4)];
    if (!token || token.length < 32 || token.length > 4096 || !/^[A-Za-z0-9._~+/-]+=*$/u.test(token)) throw new TypeError("HTTP broker reference must resolve to a bearer token of 32 through 4096 characters");
    expected = createHash("sha256").update(token).digest();
  }
  return Object.freeze({
    required: expected !== undefined,
    allowRemoteBind: env.JEVYR_ALLOW_REMOTE_BIND === "1" && expected !== undefined,
    authorize(headers: IncomingHttpHeaders): boolean {
      if (!expected) return true;
      const value = headers.authorization;
      if (typeof value !== "string" || !/^Bearer [A-Za-z0-9._~+/-]+=*$/u.test(value) || value.length > 4103) return false;
      return timingSafeEqual(expected, createHash("sha256").update(value.slice(7)).digest());
    },
  });
}
