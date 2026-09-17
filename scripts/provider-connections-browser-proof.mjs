import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { chromium } from 'file:///C:/Users/sondr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const fixture = JSON.parse(await readFile(resolve(process.argv[2]), 'utf8'));
assert.equal(fixture.protocol, 'jevyr.connection-fixture/1');
assert.match(basename(fixture.project), /^jevyr-connections-proof-/u);
assert.notEqual(new URL(fixture.daemon).port, '4317');
const output = resolve(process.argv[3] ?? `artifacts/provider-connections-browser-${Date.now()}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1050 }, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage(), checks = [], errors = [], badResponses = [], requests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status() }); });
page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
const passed = name => checks.push({ name, passed: true });
const snapshot = async name => {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Horizontal overflow');
  await page.screenshot({ path: join(output, name), fullPage: true });
};
let failure;
try {
  await page.goto(fixture.chamber);
  await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
  await page.getByText('1 model active now', { exact: true }).waitFor();
  passed('Actual daemon view and live availability, no hard-coded status');
  await snapshot('local-desktop.png');
  await page.getByRole('button', { name: 'Find available models', exact: true }).click();
  const available = page.getByLabel('Available models', { exact: true });
  await available.waitFor();
  const ids = await available.locator('option').evaluateAll(options => options.map(option => option.value).filter(Boolean));
  assert(ids.length > 0); assert(ids.includes('gpt-oss:20b'));
  await available.selectOption('gpt-oss:20b');
  await page.getByText('Name and tool format', { exact: true }).click();
  await page.getByLabel('Display name', { exact: true }).fill('My local investigator');
  await page.getByLabel('Model family · optional', { exact: true }).fill('gpt-oss');
  await page.getByLabel('Tool format', { exact: true }).selectOption('structured');
  await page.getByRole('button', { name: 'Add to next-launch selection', exact: true }).click();
  await page.getByRole('button', { name: 'Edit My local investigator', exact: true }).waitFor();
  passed('Real Ollama model discovery and model/family/transport selection without inference');
  await page.getByRole('button', { name: 'Cloud API', exact: true }).click();
  await page.getByLabel('Allow this provider when the Case permits cloud disclosure.', { exact: false }).check();
  await page.getByRole('button', { name: 'Find available models', exact: true }).click();
  await page.getByText('The service needs a valid credential.', { exact: false }).waitFor();
  assert.equal(await page.locator('input[type=password]').count(), 1, 'Only daemon token field; no raw model key field');
  assert.equal(await page.evaluate(() => localStorage.length), 0);
  await snapshot('cloud-desktop.png');
  passed('Missing cloud credential is explained; no raw key field or browser persistence');
  await page.getByRole('button', { name: 'MCP', exact: true }).click();
  await page.getByRole('button', { name: 'Copy JSON', exact: true }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.deepEqual(copied.mcpServers.jevyr.args, ['mcp', 'serve', '--url', fixture.daemon]);
  await page.getByRole('button', { name: 'Test connection', exact: true }).click();
  await page.getByText('Registered server responded.', { exact: true }).waitFor();
  await page.getByLabel('Synthetic reference tool', { exact: false }).uncheck();
  await snapshot('mcp-desktop.png');
  passed('MCP configuration clipboard binds daemon; registered synthetic server handshake; selection can disable witness');
  await page.getByRole('button', { name: 'Save next-launch selection', exact: true }).click();
  await page.getByText('Selection saved.', { exact: false }).waitFor();
  const saved = JSON.parse(await readFile(join(fixture.project, '.jevyr', 'connections.json'), 'utf8'));
  assert.equal(saved.revision, 1); assert.equal(saved.profile.models.length, 2);
  assert.deepEqual(saved.profile.mcpServerIds, []);
  assert(saved.profile.models.some(model => model.label === 'My local investigator' && model.modelFamily === 'gpt-oss' && model.transport === 'structured'));
  await page.getByText('1 model active now', { exact: true }).waitFor();
  passed('Revisioned save persists intended profile while current active model stays fixed');
  await page.reload(); await page.getByRole('button', { name: 'Refresh status', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit My local investigator', exact: true }).waitFor();
  assert.deepEqual(await page.getByRole('alert').allTextContents(), []);
  passed('Saved pending selection survives browser reload');
  for (const width of [320, 736, 1280]) {
    await page.setViewportSize({ width, height: 920 });
    for (const [name, tab] of [['local', 'Local models'], ['cloud', 'Cloud API'], ['mcp', 'MCP']]) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await snapshot(`${name}-${width}.png`);
    }
  }
  passed('All three panels fit 320, 736 and 1280 pixel widths');
  await page.keyboard.press('Tab');
  assert(await page.evaluate(() => document.activeElement?.tagName !== 'BODY'));
  passed('Keyboard focus reaches real controls');
  assert.equal(requests.filter(request => /chat\/completions|\/v1\/cases(?:$|\?)/u.test(request.url)).length, 0);
  assert.deepEqual(errors, []); assert.deepEqual(badResponses, []);
  passed('No page errors, HTTP errors, inference requests, or Case submissions');
} catch (error) { failure = { message: error.message, stack: error.stack }; await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await writeFile(join(output, 'report.json'), JSON.stringify({ protocol: 'jevyr.connections-browser-proof/1', passed: !failure, fixture, checks, errors, badResponses, requests, ...(failure ? { failure } : {}) }, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ output, checks: checks.length, passed: !failure, failure }));
if (failure) process.exitCode = 1;
