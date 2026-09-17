import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { parseJsonBytes } from "@jevyr/core";
import { isConnectionLoopback, type ModelConnection } from "./connection-profiles.js";

export interface ConnectionModelList { readonly protocol: "jevyr.connection-model-list/1"; readonly status: "available" | "unavailable" | "failed"; readonly models: readonly { readonly id: string }[]; readonly selectedModelListed: boolean | null; readonly code: string; readonly checkedAt: string }
/** Remote metadata probes may not target private networks, even through DNS rebinding. */
export function publicConnectionAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) || (a === 198 && [18, 19].includes(b)));
  }
  // Admit global unicast only; exclude transition/translation/reserved ranges.
  if (isIP(address) === 6) return /^[23]/u.test(address) && !/^(2001:(?:0:|db8:|10:|20:)|2002:)/iu.test(address);
  return false;
}
export async function readConnectionModelList(connection: ModelConnection, authorization?: () => string): Promise<ConnectionModelList> {
  const result = (status: ConnectionModelList["status"], code: string, models: readonly { id: string }[] = [], selectedModelListed: boolean | null = null): ConnectionModelList => ({ protocol: "jevyr.connection-model-list/1", status, code, models, selectedModelListed, checkedAt: new Date().toISOString() });
  let header: string | undefined;
  try { header = authorization?.(); } catch { return result("unavailable", "CREDENTIAL_UNAVAILABLE"); }
  const url = new URL("models", connection.baseUrl), controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    let address: string, family: number;
    if (isConnectionLoopback(url)) { address = url.hostname === "[::1]" ? "::1" : "127.0.0.1"; family = isIP(address); }
    else {
      const host = url.hostname.replace(/^\[|\]$/gu, ""), literal = isIP(host);
      const answers = literal ? [{ address: host, family: literal }] : await Promise.race([
        lookup(host, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("PROBE_TIMEOUT")), { once: true })),
      ]);
      if (controller.signal.aborted) return result("unavailable", "MODEL_LIST_TIMEOUT");
      if (!answers.length || answers.some(answer => !publicConnectionAddress(answer.address))) return result("failed", "ENDPOINT_ADDRESS_NOT_PUBLIC");
      ({ address, family } = answers[0]!);
    }
    const response = await new Promise<{ status: number; bytes: Buffer }>((resolve, reject) => {
      // Node core requests do not inherit HTTP_PROXY, a browser cookie jar, or fetch redirect behavior.
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: "GET", agent: false, signal: controller.signal,
        headers: { accept: "application/json", ...(header ? { authorization: header } : {}) },
        lookup: ((_host: string, options: unknown, callback: (...args: any[]) => void) => {
          if ((options as { all?: boolean }).all) callback(null, [{ address, family }]); else callback(null, address, family);
        }) as any,
      }, response => {
        const status = response.statusCode ?? 0;
        if (status !== 200) { response.resume(); request.destroy(); resolve({ status, bytes: Buffer.alloc(0) }); return; }
        const chunks: Buffer[] = []; let length = 0;
        response.on("data", (chunk: Buffer) => { length += chunk.length; if (length > 262_144) request.destroy(new Error("MODEL_LIST_TOO_LARGE")); else chunks.push(Buffer.from(chunk)); });
        response.on("end", () => resolve({ status, bytes: Buffer.concat(chunks) }));
        response.on("error", reject);
      });
      request.on("error", reject); request.end();
    });
    if (response.status !== 200) return result("unavailable", response.status >= 300 && response.status < 400 ? "MODEL_LIST_REDIRECT_REFUSED" : "MODEL_LIST_HTTP_UNAVAILABLE");
    const body = parseJsonBytes(response.bytes) as { data?: unknown };
    if (!body || typeof body !== "object" || !Array.isArray(body.data)) return result("failed", "MODEL_LIST_INVALID");
    const ids: string[] = [];
    for (const entry of body.data) {
      if (!entry || typeof entry !== "object" || typeof (entry as any).id !== "string" || !(entry as any).id.trim() || (entry as any).id.length > 256 || /[\u0000-\u001f\u007f]/u.test((entry as any).id)) return result("failed", "MODEL_LIST_INVALID");
      ids.push((entry as any).id);
    }
    const unique = [...new Set(ids)];
    return result("available", unique.length > 128 ? "MODEL_LIST_PARTIAL" : "MODEL_LIST_AVAILABLE", unique.slice(0, 128).map(id => ({ id })), unique.includes(connection.model));
  } catch (error) { return result("failed", controller.signal.aborted ? "MODEL_LIST_TIMEOUT" : error instanceof Error && error.message === "MODEL_LIST_TOO_LARGE" ? "MODEL_LIST_TOO_LARGE" : "MODEL_LIST_FAILED"); }
  finally { clearTimeout(timeout); }
}
