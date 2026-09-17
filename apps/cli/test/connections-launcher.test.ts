import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const owned: string[] = [], exec = promisify(execFile);
afterEach(async () => {
  for (const root of owned.splice(0)) {
    const part = relative(tmpdir(), resolve(root));
    if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('Refuse cleanup outside the owned fixture');
    await rm(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'win32')('visual connection selection in the Windows launcher', () => {
  it('keeps starter defaults without a profile and omits them with a saved profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jevyr connection launcher ')); owned.push(root);
    const launcher = await readFile(new URL('../../../Start Jevyr Local.cmd', import.meta.url), 'utf8');
    await writeFile(join(root, 'Start Jevyr Local.cmd'), launcher);
    await writeFile(join(root, 'Start Jevyr.cmd'), '@echo off\r\necho args=%*\r\necho compatible=%JEVYR_OPENAI_COMPATIBLE_MODEL%\r\necho self=%JEVYR_SELF_JUDGE%\r\nexit /b 7\r\n');
    await writeFile(join(root, 'fixture.cmd'), '@echo off\r\ncall "Start Jevyr Local.cmd" --no-open\r\nexit /b %errorlevel%\r\n');
    const run = async () => {
      try {
        await exec(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'fixture.cmd'], { cwd: root, env: { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec }, windowsHide: true, timeout: 10000 });
        throw new Error('The launcher did not preserve the child exit code');
      } catch (error) {
        const result = error as { code?: number; stdout?: string };
        expect(result.code).toBe(7); return result.stdout!;
      }
    };
    const initial = await run();
    expect(initial).toContain('args=--local-model qwen3-coder:30b-32k --no-open');
    expect(initial).toContain('compatible=gpt-oss:20b'); expect(initial).toContain('self=1');
    await mkdir(join(root, '.jevyr'));
    await writeFile(join(root, '.jevyr/connections.json'), '{}');
    const configured = await run();
    expect(configured).toContain('args=--no-open'); expect(configured).not.toContain('--local-model');
    expect(configured).not.toContain('gpt-oss'); expect(configured).toContain('self=1');
  });
});
