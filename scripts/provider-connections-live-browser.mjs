// Read-only production UI proof; model discovery does not perform inference.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium } from 'file:///C:/Users/sondr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const output = resolve(process.argv[2] ?? `artifacts/provider-connections-live-browser-${Date.now()}`);
await mkdir(output, { recursive: true });
const freeze = JSON.parse(await readFile('artifacts/provider-connections-installed-freeze.json', 'utf8'));
const api = 'http://127.0.0.1:4317', origin = 'http://localhost:3001';
const before = await (await fetch(`${api}/v1/settings/connections`, { headers: { origin } })).json();
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage(), checks = [], errors = [], consoleErrors = [], badResponses = [], mutations = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', entry => { if (entry.type() === 'error') consoleErrors.push(entry.text()); });
page.on('response', response => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status() }); });
page.on('request', request => { if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) mutations.push({ method: request.method(), url: request.url() }); });
const pass = name => checks.push({ name, passed: true });
let failure;
try {
  await page.goto(`${origin}/connections`);
  await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
  await page.getByText('2 models active now', { exact: true }).waitFor();
  await page.getByText('Execution sandbox available', { exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
  pass('Production app loads current active models and Docker readiness');
  await page.screenshot({ path: join(output, 'connections-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: 'Find available models', exact: true }).click();
  const available = page.getByLabel('Available models', { exact: true });
  await available.waitFor();
  const models = await available.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
  assert(models.includes('qwen3-coder:30b-32k') && models.includes('gpt-oss:20b'));
  await writeFile(join(output, 'discovered-models.json'), JSON.stringify({ scope: 'real Ollama model listing only', models }, null, 2));
  pass(`Lists ${models.length} actual installed model IDs without generating text`);
  for (const width of [320, 736, 1280]) {
    await page.setViewportSize({ width, height: 920 });
    for (const [id, label] of [['local', 'Local models'], ['cloud', 'Cloud API'], ['mcp', 'MCP']]) {
      await page.getByRole('button', { name: label, exact: true }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Overflow at ${width}/${id}`);
      await page.screenshot({ path: join(output, `${id}-${width}.png`), fullPage: true });
    }
    pass(`Three working panels at ${width}px without horizontal overflow`);
  }
  await page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
  const config = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.deepEqual(config.mcpServers.jevyr.args, ['mcp', 'serve', '--url', api]);
  pass('Copied MCP client configuration addresses the live daemon');
  await page.getByRole('link', { name: 'Airlock', exact: true }).click();
  await page.getByRole('heading', { name: 'Before the seal.', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Chamber', exact: true }).click();
  await page.getByRole('link', { name: 'Connections', exact: true }).waitFor();
  await page.getByRole('link', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
  pass('Chamber and Airlock navigation reach Connections and return');
  assert(await page.locator('link[rel="icon"][href="/favicon.svg"]').count() > 0);
  assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); assert.deepEqual(badResponses, []);
  assert.deepEqual(mutations, [{ method: 'POST', url: `${api}/v1/settings/connections/models` }]);
  const after = await (await fetch(`${api}/v1/settings/connections`, { headers: { origin } })).json();
  assert.deepEqual(after, before);
  pass('No errors, missing favicon, settings mutations, inference, or Case submissions; original settings preserved');
} catch (error) { failure = { message: error.message, stack: error.stack }; await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ protocol: 'jevyr.connections-live-browser-proof/1', passed: !failure, installedFilesDigest: freeze.filesDigest, checks, errors, consoleErrors, badResponses, mutations, ...(failure ? { failure } : {}) }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ output, passed: !failure, checks: checks.length, failure }));
if (failure) process.exitCode = 1;
