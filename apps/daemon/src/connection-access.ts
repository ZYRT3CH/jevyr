import type { IncomingMessage } from "node:http";
import { ConnectionSettingsError } from "./connection-profiles.js";

/** These local settings routes require a real loopback peer and an exact browser origin. CORS alone grants nothing. */
export function connectionRequestAccess(request: IncomingMessage, allowedOrigins: readonly string[], mutation: boolean): boolean {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) throw new ConnectionSettingsError(403, "CONNECTION_SETTINGS_LOCAL_ONLY");
  const host = request.headers.host;
  let destination: URL;
  try { destination = new URL(`http://${host ?? ""}`); } catch { throw new ConnectionSettingsError(403, "CONNECTION_SETTINGS_HOST_REFUSED"); }
  if (!host || destination.host !== host || !["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname) || destination.username || destination.password
    || Number(destination.port || 80) !== request.socket.localPort || destination.pathname !== "/" || destination.search || destination.hash) throw new ConnectionSettingsError(403, "CONNECTION_SETTINGS_HOST_REFUSED");
  const origin = request.headers.origin;
  let permitted = false;
  if (origin) {
    let parsed: URL; try { parsed = new URL(origin); } catch { throw new ConnectionSettingsError(403, "CONNECTION_SETTINGS_ORIGIN_REFUSED"); }
    permitted = parsed.origin === origin && ["http:", "https:"].includes(parsed.protocol)
      && (origin === destination.origin || allowedOrigins.includes(origin));
    if (!permitted) throw new ConnectionSettingsError(403, "CONNECTION_SETTINGS_ORIGIN_REFUSED");
  }
  if (mutation && !permitted) throw new ConnectionSettingsError(403, "CONNECTION_SETTINGS_ORIGIN_REQUIRED");
  return permitted;
}
