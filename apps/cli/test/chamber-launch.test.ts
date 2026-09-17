import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CHAMBER_PUBLIC_ORIGIN_ENV, CHAMBER_SERVER_LIMITS, chamberEnvironment, chamberLaunchPlan, chamberLoopbackEndpoint, chamberProductionFiles } from '../src/chamber-launch.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) { const part = relative(tmpdir(), resolve(root)); if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Refuse cleanup outside owned temporary root'); await rm(root, { recursive: true, force: true }); } });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'jevyr-production-launch-')); roots.push(root);
  const cli = join(root, 'apps', 'cli'), chamber = join(root, 'apps', 'chamber');
  const files = {
    'apps/cli/dist/chamber-server.js': '// Compiled child marker\n',
    'apps/chamber/dist/server/index.js': 'export default {fetch(){return new Response("built")}};\n',
    'apps/chamber/dist/server/ssr/index.js': 'export default {};\n',
    'apps/chamber/dist/client/vinext-client-entry-manifest.json': '{"appBrowserEntry":"_next/static/chunks/entry-test.js"}',
    'apps/chamber/dist/client/_next/static/chunks/entry-test.js': '/* Built browser entry */',
    'apps/chamber/node_modules/vinext/package.json': '{"type":"module","exports":{"./server/prod-server":{"import":"./dist/server/prod-server.js"}}}',
    'apps/chamber/node_modules/vinext/dist/server/prod-server.js': 'export async function startProdServer(){ throw new Error("fixture not started"); }',
    'apps/chamber/node_modules/vinext/dist/cli.js': 'throw new Error("Do not invoke CLI dotenv or development machinery");',
  };
  for (const [path, body] of Object.entries(files)) { const target = join(root, path); await mkdir(resolve(target, '..'), { recursive: true }); await writeFile(target, body); }
  return { root, cli, chamber, moduleUrl: pathToFileURL(join(cli, 'src', 'chamber-launch.ts')).href };
}

describe('built production Chamber launch', () => {
  it('keeps custom loopback host/ports and produces a bounded compiled child invocation', async () => {
    const f = await fixture(), plan = await chamberLaunchPlan('http://127.0.0.1:19371', 'http://[::1]:19372', { NODE_OPTIONS: '--inspect', OPENAI_API_KEY: 'private', PATH: '/os/bin' }, f.moduleUrl);
    expect(plan.executable).toBe(process.execPath); expect(plan.cwd).toBe(f.chamber); expect(plan.windowsHide).toBe(true);
    expect(plan.args).toEqual(['--max-old-space-size=512', '--max-http-header-size=16384', join(f.cli, 'dist', 'chamber-server.js'), f.chamber, 'http://[::1]:19372']);
    expect(plan.env).toEqual({ PATH: '/os/bin', NODE_ENV: 'production', JEVYR_CHAMBER_API_ORIGIN: 'http://127.0.0.1:19371' });
    expect(plan.stdio).toEqual(['ignore', 'inherit', 'inherit']);
  });
  it('passes only OS essentials and the explicit public origin, without ambient credentials or loader/proxy settings', () => {
    const value = chamberEnvironment('http://localhost:4319', { Path: 'os-path', SystemRoot: 'os-root', TEMP: 'os-temp', HOME: 'os-home', NODE_ENV: 'development',
      NODE_OPTIONS: '--require /bad.js', NODE_PATH: '/host/modules', HTTP_PROXY: 'http://user:password@example.org', SSLKEYLOGFILE: '/sensitive/log',
      OPENAI_API_KEY: 'secret', Authorization: 'Bearer secret', DATABASE_URL: 'postgres://secret', SESSION_COOKIE: 'secret', NEXT_PUBLIC_JEVYR_API: 'http://wrong',
      JEVYR_CHAMBER_API_ORIGIN: 'http://wrong', JEVYR_API_TOKEN: 'secret', npm_config_userconfig: '/credentials' });
    expect(value).toEqual({ Path: 'os-path', SystemRoot: 'os-root', TEMP: 'os-temp', HOME: 'os-home', NODE_ENV: 'production', JEVYR_CHAMBER_API_ORIGIN: 'http://localhost:4319' });
  });
  it.each(['https://localhost:4317', 'http://0.0.0.0:4317', 'http://example.org', 'http://user:secret@localhost:4317', 'http://localhost:4317/extra', 'http://localhost:4317?x=1', 'http://localhost:4317#x'])('rejects unsafe launch endpoint %s', endpoint => {
    expect(() => chamberLoopbackEndpoint(endpoint, 'daemonUrl')).toThrow();
  });
  it('fails before daemon startup when compiled browser assets or server entry are missing, with no dev fallback', async () => {
    const f = await fixture();
    await writeFile(join(f.chamber, 'dist/client/vinext-client-entry-manifest.json'), '{"appBrowserEntry":"../../private.js"}');
    await expect(chamberLaunchPlan('http://localhost:4317', 'http://localhost:3001', {}, f.moduleUrl)).rejects.toThrow('outside its static asset directory');
    await writeFile(join(f.chamber, 'dist/client/vinext-client-entry-manifest.json'), '{"appBrowserEntry":"_next/static/chunks/missing.js"}');
    await expect(chamberProductionFiles(f.chamber)).rejects.toThrow('built Chamber is missing');
    await writeFile(join(f.chamber, 'dist/server/index.js'), '');
    await expect(chamberProductionFiles(f.chamber)).rejects.toThrow('pnpm --filter @jevyr/chamber build');
  });
  it('requires the installed public server API and bounds manifest reads', async () => {
    const f = await fixture();
    await writeFile(join(f.chamber, 'node_modules/vinext/package.json'), '{"type":"module","exports":{}}');
    await expect(chamberProductionFiles(f.chamber)).rejects.toThrow('supported production server API');
    await writeFile(join(f.chamber, 'dist/client/vinext-client-entry-manifest.json'), ' '.repeat(1_048_577));
    await expect(chamberProductionFiles(f.chamber)).rejects.toThrow('manifest is oversized');
  });
  it('actual child bypasses dotenv, installs only validated public metadata, enforces HTTP bounds and shuts down', async () => {
    const f = await fixture();
    await writeFile(join(f.chamber, '.env.production.local'), 'OPENAI_API_KEY=dotenv-must-not-load\nJEVYR_API_TOKEN=dotenv-must-not-load\n');
    const module = `import{createServer,maxHeaderSize}from'node:http';export async function startProdServer(options){const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({options,config:globalThis.__JEVYR_CHAMBER_CONFIG__,env:{mode:process.env.NODE_ENV,publicOrigin:process.env.JEVYR_CHAMBER_API_ORIGIN,provider:process.env.OPENAI_API_KEY??null,token:process.env.JEVYR_API_TOKEN??null},limits:{headerBytes:maxHeaderSize,requestMillis:server.requestTimeout,headersMillis:server.headersTimeout,keepAliveMillis:server.keepAliveTimeout,maximumConnections:server.maxConnections,requestsPerSocket:server.maxRequestsPerSocket}}))});await new Promise((yes,no)=>{server.once('error',no);server.listen(options.port,options.host,yes)});return{server,port:options.port}};`;
    await writeFile(join(f.chamber, 'node_modules/vinext/dist/server/prod-server.js'), module);
    const reserve = createServer(); await new Promise<void>(done => reserve.listen(0, '127.0.0.1', done));
    const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('No test port');
    await new Promise<void>((done, reject) => reserve.close(error => error ? reject(error) : done()));
    const origin = `http://127.0.0.1:${address.port}`, daemon = 'http://127.0.0.1:19371';
    const sourceEntry = fileURLToPath(new URL('../src/chamber-server.ts', import.meta.url));
    const tsx = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
    const child = spawn(process.execPath, ['--max-old-space-size=512', '--max-http-header-size=16384', tsx, sourceEntry, f.chamber, origin],
      { cwd: f.chamber, env: chamberEnvironment(daemon, { ...process.env, OPENAI_API_KEY: 'parent-secret', JEVYR_API_TOKEN: 'parent-secret' }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; child.stdout.on('data', bytes => { diagnostics += bytes; }); child.stderr.on('data', bytes => { diagnostics += bytes; });
    try {
      let result: any; const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && child.exitCode === null) {
        try { const response = await fetch(origin, { signal: AbortSignal.timeout(500) }); result = await response.json(); break; }
        catch { await new Promise(done => setTimeout(done, 50)); }
      }
      expect(result, diagnostics).toBeDefined();
      expect(result.options).toEqual({ host: '127.0.0.1', port: address.port, outDir: join(f.chamber, 'dist') });
      expect(result.config).toEqual({ protocol: 'jevyr.chamber-runtime/1', daemonOrigin: daemon });
      expect(result.env).toEqual({ mode: 'production', publicOrigin: daemon, provider: null, token: null });
      const { heapMegabytes: _heap, ...limits } = CHAMBER_SERVER_LIMITS; expect(result.limits).toEqual(limits);
      expect(await readFile(join(f.chamber, '.env.production.local'), 'utf8')).toContain('dotenv-must-not-load');
    } finally {
      if (child.exitCode === null) {
        const closed = new Promise(done => child.once('close', done)); child.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Chamber child did not stop')); }, 5_000); })]); }
        finally { if (timer) clearTimeout(timer); }
      }
    }
  }, 20_000);
});
