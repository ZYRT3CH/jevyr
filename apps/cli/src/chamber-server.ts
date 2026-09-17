import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import { CHAMBER_PUBLIC_ORIGIN_ENV, CHAMBER_RUNTIME_PROTOCOL, CHAMBER_SERVER_LIMITS, chamberLoopbackEndpoint, chamberProductionFiles } from './chamber-launch.js';

/** Calls vinext's public production API directly: no dotenv loading, build,
 * development server, provider access, or implicit command fallback. */
export async function startChamberProduction(chamberRoot: string, chamberOrigin: string, daemonOrigin: string) {
  const endpoint = chamberLoopbackEndpoint(chamberOrigin, 'chamberUrl');
  const daemon = chamberLoopbackEndpoint(daemonOrigin, 'daemonUrl');
  const files = await chamberProductionFiles(chamberRoot);
  const configuration = Object.freeze({ protocol: CHAMBER_RUNTIME_PROTOCOL, daemonOrigin: daemon.origin });
  Object.defineProperty(globalThis, '__JEVYR_CHAMBER_CONFIG__', { value: configuration, writable: false, configurable: false });
  const module = await import(pathToFileURL(files.serverModule).href) as { startProdServer: (options: { port: number; host: string; outDir: string }) => Promise<{ server: Server; port: number }> };
  if (typeof module.startProdServer !== 'function') throw new TypeError('Installed Chamber runtime lacks its production server API');
  const running = await module.startProdServer({ port: endpoint.port, host: endpoint.host, outDir: files.outDir });
  running.server.requestTimeout = CHAMBER_SERVER_LIMITS.requestMillis;
  running.server.headersTimeout = CHAMBER_SERVER_LIMITS.headersMillis;
  running.server.keepAliveTimeout = CHAMBER_SERVER_LIMITS.keepAliveMillis;
  running.server.maxConnections = CHAMBER_SERVER_LIMITS.maximumConnections;
  running.server.maxRequestsPerSocket = CHAMBER_SERVER_LIMITS.requestsPerSocket;
  return running;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || !process.env[CHAMBER_PUBLIC_ORIGIN_ENV]) throw new TypeError('Chamber child requires its explicit root, loopback address and public daemon origin');
  const { server } = await startChamberProduction(process.argv[2]!, process.argv[3]!, process.env[CHAMBER_PUBLIC_ORIGIN_ENV]!);
  let closing = false;
  const close = () => {
    if (closing) return; closing = true;
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 2_000); timeout.unref();
    server.close(() => { clearTimeout(timeout); process.exit(0); }); server.closeIdleConnections();
  };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
