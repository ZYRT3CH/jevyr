import { chromium } from 'file:///C:/Users/sondr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = resolve(process.argv[2] ?? `artifacts/ds-judge-report-browser-qa-${Date.now()}`);
const inventory = JSON.parse(await readFile(resolve('artifacts/ds-judge-status.json'), 'utf8'));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { protocol: 'jevyr.ds-judge-report-browser-qa/1', observedAt: new Date().toISOString(), checks: [], errors: [] };
try {
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(pathToFileURL(resolve('.lavish/ds-judge-validation.html')).href);
  const all = await page.locator('tbody tr').count();
  if (all !== inventory.rows.length) throw new Error('The report lost an evidence area');
  if (JSON.stringify(await page.locator('figcaption').allTextContents()) !== JSON.stringify(inventory.screenshots.map(item => item.caption))) throw new Error('Screenshot scope labels differ from the evidence inventory');
  if (!(await page.locator('.status').textContent()).includes(inventory.validation)) throw new Error('Report validation differs from the source inventory');
  await page.getByRole('button', { name: 'Pending or limited', exact: true }).click();
  if (await page.locator('tbody tr[data-status="Measured"]:visible').count()) throw new Error('Remaining filter includes completed measurements');
  await page.getByRole('button', { name: 'Measured here', exact: true }).focus();
  await page.keyboard.press('Enter');
  if (await page.locator('tbody tr:not([data-status="Measured"]):visible').count()) throw new Error('Measured filter includes pending or limited areas');
  await page.getByRole('button', { name: 'All areas', exact: true }).click();
  if (await page.locator('tbody tr:visible').count() !== all) throw new Error('All-areas filter lost rows');
  await page.locator('summary').first().focus(); await page.keyboard.press('Enter');
  if (!await page.locator('details').first().getAttribute('open').then(value => value !== null)) throw new Error('Evidence references are not keyboard operable');
  report.checks.push(`Evidence filters and reference disclosure work by keyboard; all ${all} areas remain inspectable; exact screenshot scope labels and validation inventory match`);
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const result = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, failedImages: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).length }));
    if (result.document > width || result.failedImages) throw new Error(`Report layout failure: ${JSON.stringify(result)}`);
    report.checks.push(result);
    await page.screenshot({ path: join(output, `validation-${width}.png`), fullPage: true });
  }
  if (report.errors.length) throw new Error('Uncaught browser errors');
  report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; throw error; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
console.log(JSON.stringify(report, null, 2));
