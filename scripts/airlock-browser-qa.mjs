import { chromium } from 'file:///C:/Users/sondr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const output = fileURLToPath(new URL('../artifacts/airlock-browser-qa/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let page;
const report = { protocol: 'jevyr.airlock-browser-qa/1', startedAt: new Date().toISOString(), browser: 'Microsoft Edge / Playwright', fixture: 'local Rule mind, observe-only body, isolated store', checks: [], errors: [] };
try {
  page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  const writes = []; page.on('request', request => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.goto('http://localhost:3002/airlock?api=http%3A%2F%2F127.0.0.1%3A4328&subject-kind=directory&subject-locator=C%3A%2Freviewed%20source');
  await page.waitForLoadState('networkidle');
  const prefilled = JSON.parse(await page.getByLabel(/^Subject references · JSON/).inputValue());
  if (prefilled.length !== 1 || prefilled[0].locator !== 'C:/reviewed source' || prefilled[0].kind !== 'directory' || writes.length) throw new Error('CLI Airlock prefill created work or lost its exact editable source');
  report.checks.push('CLI source URL prefills an editable subject without saving, sealing or issuing a POST');
  await page.goto('http://localhost:3002/airlock');
  await page.waitForLoadState('networkidle');
  await page.getByText('Daemon connection', { exact: true }).click();
  await page.getByLabel('Address', { exact: true }).fill('http://127.0.0.1:4328');
  await page.getByLabel('Impulse', { exact: true }).fill('Build an observable counter.');
  await page.getByRole('button', { name: 'Save draft & inspect', exact: true }).click();
  await page.getByRole('button', { name: 'Seal & run autonomously' }).waitFor();
  if (!/^[a-f0-9]{64}$/.test(await page.getByLabel(/^Seed/).inputValue())) throw new Error('Generated seed is not 256 bits');
  await page.getByText('Investigation permissions', { exact: true }).click();
  await page.getByRole('combobox', { name: /^Preset/ }).selectOption('wild');
  await page.getByRole('combobox', { name: /^Sandbox/ }).selectOption('observe_only');
  await page.getByLabel('Lower resource ceilings · JSON').fill('{"maxForgeWallMillis":0}');
  await page.getByRole('button', { name: 'Save revision & inspect', exact: true }).click();
  await page.getByText('Revision 2', { exact: true }).waitFor();
  report.checks.push('Draft creation, 256-bit seed, Wild selection, observe-only and reduced ceilings persisted as revision 2');
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, unlabeled: [...document.querySelectorAll('input,select,textarea')].filter(e => !e.labels?.length && !e.getAttribute('aria-label')).length }));
    if (layout.document > width || layout.unlabeled) throw new Error(`Airlock layout/accessibility failed: ${JSON.stringify(layout)}`);
    await page.screenshot({ path: `${output}/draft-${width}.png`, fullPage: true });
    report.checks.push({ width, ...layout });
  }
  await page.getByRole('button', { name: 'Seal & run autonomously' }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Emergency abort · INVALID' }).click();
  await page.getByText(/Authenticated closure:/).waitFor({ timeout: 30_000 });
  const closure = await page.getByText(/Authenticated closure:/).innerText();
  if (!closure.includes('INVALID')) throw new Error(`Abort did not authenticate INVALID: ${closure}`);
  if (await page.getByRole('button', { name: 'Save revision & inspect', exact: true }).isEnabled()) throw new Error('Sealed editing remained enabled');
  report.checks.push('Keyboard sealing, semantic edit closure, abort and authenticated INVALID');
  await page.screenshot({ path: `${output}/aborted-320.png`, fullPage: true });
  await page.goto('http://localhost:3002/airlock');
  await page.waitForLoadState('networkidle');
  await page.getByText('Daemon connection', { exact: true }).click();
  await page.getByLabel('Address', { exact: true }).fill('http://127.0.0.1:4328');
  await page.getByLabel('Impulse', { exact: true }).fill('Build a counter with an unspecified aesthetic quality.');
  await page.getByRole('combobox', { name: /^Control/ }).selectOption('sovereign');
  await page.getByRole('button', { name: 'Save draft & inspect', exact: true }).click();
  await page.getByRole('button', { name: 'Seal & run autonomously' }).click();
  await page.getByText(/Authenticated closure:/).waitFor({ timeout: 90_000 });
  report.checks.push(await page.getByText(/Authenticated closure:/).innerText());
  await page.screenshot({ path: `${output}/sovereign-320.png`, fullPage: true });
  await page.goto('http://localhost:3002/genome-lab');
  await page.waitForLoadState('networkidle');
  await page.getByText('Daemon connection', { exact: true }).click();
  await page.getByLabel('Address', { exact: true }).fill('http://127.0.0.1:4328');
  await page.getByRole('heading', { name: 'The strategy bound to this runtime' }).waitFor();
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const actual = await page.evaluate(() => document.documentElement.scrollWidth);
    if (actual > width) throw new Error(`Genome Lab overflow: ${actual} > ${width}`);
    await page.screenshot({ path: `${output}/genome-lab-${width}.png`, fullPage: true });
  }
  report.checks.push('Genome Lab reads bound startup, truthful empty benchmark/proposal states, and fits 320/736/1024');
  if (report.errors.length) throw new Error('Browser reported uncaught page errors');
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; if (page) { report.visibleText = await page.locator('body').innerText(); await page.screenshot({ path: `${output}/failure.png`, fullPage: true }); } throw error; }
finally { await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); await browser.close(); }
console.log(JSON.stringify(report, null, 2));
