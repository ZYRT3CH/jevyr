import { chromium } from 'file:///C:/Users/sondr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
const fixture = resolve(process.argv[2] ?? 'artifacts/genome-lab-ui-1788582734165');
const source = JSON.parse(await readFile(join(fixture, 'report.json'), 'utf8'));
const output = resolve('artifacts/genome-lab-browser-qa', basename(fixture)); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = { protocol: 'jevyr.genome-lab-browser-qa/1', fixture, historical: source.historical, source, checks: [], errors: [] };
let page;
try {
  page = await browser.newPage({ reducedMotion: 'reduce' }); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto('http://localhost:3002/genome-lab'); await page.waitForLoadState('networkidle');
  await page.getByText('Daemon connection', { exact: true }).click();
  await page.getByLabel('Address', { exact: true }).fill(source.url);
  await page.getByRole('heading', { name: /^Paired benchmark/ }).waitFor();
  await page.getByRole('heading', { name: /Repository self-judgment · 1 failure intakes/ }).waitFor();
  if (await page.getByRole('rowheader', { name: 'Critical-defect recall', exact: true }).count() !== 1) throw new Error('Missing paired recall metric');
  if (source.historical && !await page.getByText('HISTORICAL VIEW - not current startup', { exact: true }).count()) throw new Error('Historical fixture was presented as current startup');
  await page.getByText('Benchmark provenance', { exact: true }).click();
  await page.getByText('Bound source Record and reproduced failures', { exact: true }).click();
  const text = await page.locator('main').innerText();
  for (const digest of [source.benchmarkDigest, source.presetDigest, source.quarantinedRequestDigest]) if (!text.includes(digest)) throw new Error('Visible provenance omitted a fixture-bound digest');
  report.checks.push('Actual signed paired benchmark displays all nine metrics, sample counts, Pareto membership, limitations and provenance');
  report.checks.push('Verified self-failure request displays source Record, physical evidence references and quarantined status');
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, unlabeled: [...document.querySelectorAll('input,select,textarea')].filter(e => !e.labels?.length && !e.getAttribute('aria-label')).length }));
    if (layout.document > width || layout.unlabeled) throw new Error(`Genome Lab layout failure ${JSON.stringify(layout)}`);
    await page.getByRole('region', { name: 'Paired benchmark metrics, horizontally scrollable' }).focus(); await page.keyboard.press('ArrowRight');
    await page.screenshot({ path: join(output, `genome-lab-${width}.png`), fullPage: true }); report.checks.push(layout);
  }
  if (report.errors.length) throw new Error('Uncaught browser errors'); report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack; if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }); throw error; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); }
console.log(JSON.stringify(report, null, 2));
