import { lstat, readFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHAMBER_RUNTIME_PROTOCOL = 'jevyr.chamber-runtime/1' as const;
export const CHAMBER_PUBLIC_ORIGIN_ENV = 'JEVYR_CHAMBER_API_ORIGIN';
export const CHAMBER_SERVER_LIMITS = Object.freeze({ heapMegabytes: 512, headerBytes: 16_384, requestMillis: 30_000,
  headersMillis: 15_000, keepAliveMillis: 5_000, maximumConnections: 64, requestsPerSocket: 1_000 });
export interface ChamberEndpoint { readonly origin: string; readonly host: 'localhost' | '127.0.0.1' | '::1'; readonly port: number }
export function chamberLoopbackEndpoint(value: string, label: string): ChamberEndpoint {
  const url = new URL(value), host = url.hostname === '[::1]' ? '::1' : url.hostname;
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(host) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new TypeError(`${label} must be a local HTTP origin without credentials`);
  const port = Number(url.port || 80);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new TypeError(`${label} must contain a valid TCP port`);
  return { origin: url.origin, host: host as ChamberEndpoint['host'], port };
}

/** OS process essentials only. In particular, no provider token, public build
 * variable, Node loader flag, package-manager setting or dotenv value passes. */
export function chamberEnvironment(daemonOrigin: string, input: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const origin = chamberLoopbackEndpoint(daemonOrigin, 'daemonUrl').origin, environment: NodeJS.ProcessEnv = {};
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'LANG', 'LC_ALL', 'TZ']);
  for (const [key, value] of Object.entries(input)) if (allowed.has(key.toUpperCase()) && value !== undefined) environment[key] = value;
  environment.NODE_ENV = 'production'; environment[CHAMBER_PUBLIC_ORIGIN_ENV] = origin;
  return environment;
}

async function ordinary(path: string, directory = false): Promise<Stats> {
  const stat = await lstat(path).catch(() => undefined);
  if (!stat || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.size === 0)) {
    throw new Error('The built Chamber is missing or incomplete; run `pnpm --filter @jevyr/chamber build` and rebuild the CLI before `judge up`. Use `pnpm dev:chamber` explicitly for development.');
  }
  return stat;
}
export async function chamberProductionFiles(chamberRoot: string): Promise<{ outDir: string; serverModule: string }> {
  const root = resolve(chamberRoot), outDir = join(root, 'dist');
  await ordinary(join(outDir, 'server', 'index.js'));
  await ordinary(join(outDir, 'server', 'ssr', 'index.js'));
  await ordinary(join(outDir, 'client'), true);
  const manifest = join(outDir, 'client', 'vinext-client-entry-manifest.json');
  const manifestStat = await ordinary(manifest);
  if (manifestStat.size > 1_048_576) throw new Error('The built Chamber client manifest is oversized');
  const bytes = await readFile(manifest);
  if (bytes.byteLength !== manifestStat.size || bytes.byteLength > 1_048_576) throw new Error('The built Chamber client manifest changed while reading');
  const entry: unknown = JSON.parse(bytes.toString('utf8'));
  const appBrowserEntry = (entry as { appBrowserEntry?: unknown } | null)?.appBrowserEntry;
  if (typeof appBrowserEntry !== 'string' || !/^_next\/static\/chunks\/[A-Za-z0-9_.-]+\.js$/u.test(appBrowserEntry)) throw new Error('The built Chamber client entry is missing or outside its static asset directory');
  await ordinary(join(outDir, 'client', appBrowserEntry));
  const packageRoot = join(root, 'node_modules', 'vinext');
  let exported: unknown;
  try { exported = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).exports?.['./server/prod-server']?.import; }
  catch { throw new Error('The Chamber production runtime is not installed beside the CLI; run the workspace install before `judge up`'); }
  if (exported !== './dist/server/prod-server.js') throw new Error('Installed vinext does not expose the supported production server API');
  const serverModule = join(packageRoot, 'dist', 'server', 'prod-server.js');
  await ordinary(serverModule);
  return { outDir, serverModule };
}

export async function chamberLaunchPlan(daemonOrigin: string, chamberOrigin: string, input: NodeJS.ProcessEnv = process.env,
  cliModuleUrl = import.meta.url) {
  const cliRoot = resolve(dirname(fileURLToPath(cliModuleUrl)), '..'), chamberRoot = resolve(cliRoot, '..', 'chamber');
  const childEntry = join(cliRoot, 'dist', 'chamber-server.js');
  await ordinary(childEntry); await chamberProductionFiles(chamberRoot);
  const endpoint = chamberLoopbackEndpoint(chamberOrigin, 'chamberUrl');
  return { executable: process.execPath, args: [`--max-old-space-size=${CHAMBER_SERVER_LIMITS.heapMegabytes}`,
    `--max-http-header-size=${CHAMBER_SERVER_LIMITS.headerBytes}`, childEntry, chamberRoot, endpoint.origin], cwd: chamberRoot,
    env: chamberEnvironment(daemonOrigin, input), stdio: ['ignore', 'inherit', 'inherit'] as const, windowsHide: true };
}
