// Link this checkout's built CLI into a user-chosen bin directory.
// Never edits PATH, installs packages, or overwrites existing launchers.
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const main = join(root, 'apps', 'cli', 'dist', 'main.js');
await access(main).catch(() => { throw new Error('Build Jevyr first: pnpm install, then pnpm build, inside the Jevyr repository.'); });
const destination = process.argv[2]
  ? resolve(process.argv[2])
  // AppData writes from packaged Windows apps can be redirected into private
  // package storage, invisible to an ordinary CMD window. Use the profile bin.
  : join(homedir(), '.local', 'bin');
if (process.argv.length > 3) throw new Error('Usage: node scripts/install-local-cli.mjs [bin-directory]');
await mkdir(destination, { recursive: true });
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
if (process.platform === 'win32' && /[%\r\n]/u.test(process.execPath + main)) {
  throw new Error('Windows launcher paths cannot contain percent signs or line breaks. Choose a conventional checkout/runtime path.');
}
const content = process.platform === 'win32'
  ? `@echo off\r\n"${process.execPath}" "${main}" %*\r\n`
  : `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(main)} "$@"\n`;
for (const name of ['judge', 'jevyr', 'jevyr']) {
  const launcher = join(destination, process.platform === 'win32' ? `${name}.cmd` : name);
  await writeFile(launcher, content, { flag: 'wx', mode: 0o755 }).catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(launcher, 'utf8') !== content) {
      throw new Error(`A different launcher already exists at ${launcher}; it was not overwritten.`);
    }
  });
  console.log(`Launcher ready: ${launcher}`);
}
console.log(`Checkout: ${root}\nThis is a local linked installation; keep this checkout in place.\nAdd ${destination} to your user PATH to use jevyr from any terminal. PATH was not modified.\nRun jevyr for the terminal interface, or jevyr up to start the app.`);
