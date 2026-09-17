import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JevyrClient } from '@jevyr/sdk';
import { initialize } from '../src/config.js';

const fixture = vi.hoisted(() => ({ daemon: false, chamber: false, openerExitCode: 0, events: [] as string[], spawns: [] as { file: string; args: string[]; options: any }[] }));
vi.mock('@jevyr/daemon', async importOriginal => ({ ...await importOriginal<any>(), createJevyrHttpService: () => ({
  listen: async () => { fixture.daemon = true; fixture.events.push('daemon.ready'); },
  close: async () => { fixture.daemon = false; fixture.events.push('daemon.closed'); },
}) }));
vi.mock('../src/chamber-launch.js', async importOriginal => ({ ...await importOriginal<any>(), chamberLaunchPlan: async () => ({
  executable: 'fixture-chamber', args: [], cwd: tmpdir(), env: {}, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true,
}) }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<any>(), spawn: (file: string, args: string[], options: any) => {
  fixture.spawns.push({ file, args, options });
  const child = new EventEmitter() as EventEmitter & { exitCode: number | null; kill: () => boolean; unref: () => void };
  child.exitCode = null; child.unref = () => {};
  child.kill = () => { fixture.chamber = false; child.exitCode = 0; fixture.events.push('chamber.closed'); queueMicrotask(() => child.emit('close', 0)); return true; };
  if (file === 'fixture-chamber') { fixture.chamber = true; fixture.events.push('chamber.ready'); queueMicrotask(() => child.emit('spawn')); }
  else { fixture.events.push('browser.open'); queueMicrotask(() => { child.emit('spawn'); child.exitCode = fixture.openerExitCode; child.emit('exit', fixture.openerExitCode); child.emit('close', fixture.openerExitCode); }); }
  return child;
} }));
import { main } from '../src/main.js';
const roots: string[] = [], exec = promisify(execFile);
beforeEach(() => {
  fixture.daemon = false; fixture.chamber = false; fixture.openerExitCode = 0; fixture.events.length = 0; fixture.spawns.length = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(JevyrClient.prototype, 'readiness').mockImplementation(async () => { if (!fixture.daemon) throw new Error('offline'); return { models: { adapters: [] } } as any; });
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: fixture.chamber ? 200 : 503 })));
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) { const part = relative(tmpdir(), resolve(root)); if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Refuse cleanup outside owned fixture'); await rm(root, { recursive: true, force: true }); }
});
async function project() {
  const root = await mkdtemp(join(tmpdir(), 'jevyr-airlock-order-')); roots.push(root); await initialize(root);
  await writeFile(join(root, '.jevyr/config.json'), JSON.stringify({ daemonUrl: 'http://127.0.0.1:4393', chamberUrl: 'http://127.0.0.1:3093', privacy: 'local_only', control: 'juggler' }));
  vi.stubEnv('INIT_CWD', root); vi.stubEnv('JEVYR_URL', 'http://127.0.0.1:4393'); vi.stubEnv('JEVYR_CHAMBER_URL', 'http://127.0.0.1:3093');
  return root;
}
describe('Airlock readiness and browser launch', () => {
  it('refuses a competing local-model flag before opening or starting a saved-profile runtime', async () => {
    const root = await project();
    await writeFile(join(root, '.jevyr/connections.json'), JSON.stringify({ protocol: 'jevyr.connection-profile-store/1', revision: 1, profile: { protocol: 'jevyr.connection-profile/1', models: [], mcpServerIds: [] } }));
    await expect(main(['up', '--local-model', 'competing-model', '--no-open'])).rejects.toThrow('saved Connections profile');
    expect(fixture.events).toEqual([]); expect(fixture.spawns).toEqual([]);
  });
  it('opens its exact editor after cold readiness and keeps services alive until explicit shutdown', async () => {
    const root = await project(); let settled = false;
    const running = main(['airlock', root, '--json']).finally(() => { settled = true; });
    try {
      await vi.waitFor(() => expect(fixture.events).toContain('browser.open'), { timeout: 1000 });
      expect(fixture.events).toEqual(['daemon.ready', 'chamber.ready', 'browser.open']);
      expect(settled).toBe(false); expect(fixture.daemon && fixture.chamber).toBe(true);
      const opener = fixture.spawns.find(value => value.file !== 'fixture-chamber')!;
      const url = process.platform === 'win32' ? opener.options.env.JEVYR_BROWSER_OPEN_URL : opener.args[0];
      expect(new URL(url).pathname).toBe('/airlock'); expect(new URL(url).searchParams.get('subject-locator')).toBe(root);
    } finally { process.emit('SIGTERM'); await running; }
    expect(fixture.events.slice(-2)).toEqual(['chamber.closed', 'daemon.closed']);
  });
  it('reuses ready services and no-open remains URL-only without starting services', async () => {
    const root = await project();
    await expect(main(['airlock', root, '--no-open', '--json'])).resolves.toBe(0);
    expect(fixture.events).toEqual([]); expect(fixture.spawns).toEqual([]);
    fixture.daemon = true; fixture.chamber = true;
    await expect(main(['airlock', root, '--json'])).resolves.toBe(0);
    expect(fixture.events).toEqual(['browser.open']); expect(fixture.daemon && fixture.chamber).toBe(true);
  });
  it.runIf(process.platform === 'win32')('passes the URL as literal environment data through actual PowerShell, excluding credentials', async () => {
    await project(); fixture.daemon = true; fixture.chamber = true;
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-not-a-credential'); vi.stubEnv('NODE_OPTIONS', '--require no-file'); vi.stubEnv('HTTP_PROXY', 'http://synthetic-private');
    await expect(main(['airlock', '--json'])).resolves.toBe(0);
    const opener = fixture.spawns[0]!;
    expect(opener.file).toBe('powershell.exe');
    expect(opener.options.env.OPENAI_API_KEY).toBeUndefined(); expect(opener.options.env.NODE_OPTIONS).toBeUndefined(); expect(opener.options.env.HTTP_PROXY).toBeUndefined();
    const literal = "http://127.0.0.1:3093/airlock?api=http%3A%2F%2F127.0.0.1%3A4393&subject-kind=directory&subject-locator=C%3A%5Cfixture&literal='apostrophe';$variable=$(Write-Output BAD)";
    expect(opener.args).not.toContain(opener.options.env.JEVYR_BROWSER_OPEN_URL);
    expect(opener.args.at(-1)).toContain('$env:JEVYR_BROWSER_OPEN_URL');
    const command = 'function Start-Process { param([string]$FilePath) [Console]::Out.Write($FilePath) }; ' + opener.args.at(-1);
    const result = await exec(opener.file, ['-NoProfile', '-NonInteractive', '-Command', command], { env: { ...opener.options.env, JEVYR_BROWSER_OPEN_URL: literal }, windowsHide: true, timeout: 10000 });
    expect(result.stdout).toBe(literal); expect(result.stderr).toBe('');
  });
  it.runIf(process.platform === 'win32')('reports a failed browser opener and closes only its newly owned services', async () => {
    const root = await project(); fixture.openerExitCode = 7;
    await expect(main(['airlock', root, '--json'])).rejects.toThrow('browser opener exited with code 7');
    expect(fixture.events).toEqual(['daemon.ready', 'chamber.ready', 'browser.open', 'chamber.closed', 'daemon.closed']);
    expect(fixture.daemon || fixture.chamber).toBe(false);
  });
});
