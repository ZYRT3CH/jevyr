// Read-only browser validation of an already running app and already signed Case.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'file:///C:/Users/sondr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const caseId = process.argv[2], output = resolve(process.argv[3]);
assert.match(caseId, /^case_[a-f0-9]+$/u);
await mkdir(output);
const base = 'http://localhost:3001', api = 'http://127.0.0.1:4317';
const expectedResponse = await fetch(`${api}/v1/cases/${caseId}/record`);
assert.equal(expectedResponse.status, 200);
const expected = await expectedResponse.json();
const report = { protocol: 'jevyr.live-app-browser-check/1', observedAt: new Date().toISOString(), caseId,
  scope: 'Read-only running app and named signed Case; no Cast, promotion or metabolic grant; browser identity checks are separate from CLI verdict replay',
  launcher: await readFile(resolve('Start Jevyr Local.cmd'), 'utf8'), checks: [], errors: [] };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let page;
try {
  const staticContext = await browser.newContext({ javaScriptEnabled: false });
  const staticPage = await staticContext.newPage();
  await staticPage.goto(`${base}/record?case=${caseId}`);
  assert.equal(await staticPage.getByRole('button', { name: 'Read authenticated Record', exact: true }).isDisabled(), true);
  report.checks.push('Record form disabled before hydration');
  await staticContext.close();
  page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  for (const route of ['/', '/airlock', '/genome-lab']) {
    const response = await page.goto(base + route);
    assert.equal(response.status(), 200);
    await page.waitForLoadState('networkidle');
    for (const width of [1024, 736, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(size.document <= width, `${route} overflows at ${width}`);
      await page.screenshot({ path: join(output, `${route.slice(1) || 'chamber'}-${width}.png`) });
      report.checks.push({ route, status: response.status(), ...size });
    }
  }
  await page.goto(`${base}/record?case=${caseId}&api=${encodeURIComponent(api)}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Read authenticated Record', exact: true }).click();
  await page.getByRole('heading', { name: 'Binding findings and unresolved claims', exact: true }).waitFor({ timeout: 30_000 });
  const axes = await page.locator('.verdict-facts > div').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.querySelector('dt').textContent, node.querySelector('dd').textContent])));
  for (const axis of ['integrity', 'creation', 'embodiment', 'judgment']) assert.equal(axes[axis], expected.verdict[axis]);
  report.checks.push({ route: '/record', authenticated: true, axes });
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert.ok(size.document <= width, `Record overflows at ${width}`);
    await page.screenshot({ path: join(output, `record-${width}.png`) });
    report.checks.push({ route: '/record', ...size });
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = error.stack;
  if (page) { report.visibleText = await page.locator('body').innerText(); await page.screenshot({ path: join(output, 'failure.png') }); }
  throw error;
} finally {
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ output, passed: report.passed, checks: report.checks.length, errors: report.errors }));
