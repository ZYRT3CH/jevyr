// Browser-only UI checks. This never Casts a task or executes generated artifacts.
// Set JEVYR_CASE_ID to inspect an existing real Case after the basic UI checks.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JEVYR_PLAYWRIGHT_PATH || 'playwright');
const baseUrl = process.env.JEVYR_CHAMBER_URL || 'http://127.0.0.1:3001';
const output = resolve('artifacts/chamber-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.JEVYR_BROWSER_CHANNEL ? { channel: process.env.JEVYR_BROWSER_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const noOverflow = async () => assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Page must not overflow horizontally');
try {
  await page.goto(baseUrl);
  await page.waitForFunction(() => !document.body.innerText.includes('Reading the runtime…'));
  await page.getByLabel('The task', { exact: true }).fill('Inspect the sealed subject and produce runnable evidence.');
  await page.getByText('Create + test', { exact: true }).click();
  assert(await page.locator('input[value="design"]').isChecked());
  await page.getByText('Attach subjects & constraints', { exact: false }).click();
  await page.getByLabel('Location or text').fill('C:\\example\\project');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.getByRole('button', { name: 'Remove C:\\example\\project' }).waitFor();
  assert((await page.locator('.subject-list').innerText()).includes('C:\\example\\project'));
  await page.getByRole('button', { name: 'Remove C:\\example\\project' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.subject-list li').length === 0);
  await page.getByLabel('Constraints · one per line').fill('No network access.');
  assert(await page.getByRole('button', { name: 'Seal the case' }).isEnabled());
  await noOverflow();
  await page.screenshot({ path: resolve(output, 'cast-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.screenshot({ path: resolve(output, 'cast-mobile.png'), fullPage: true });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`${baseUrl}/?specimen=1`);
  await page.getByText('Illustrative events · no execution or proof', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Inspect', exact: true }).click();
  assert.equal(await page.getByLabel('The task', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.getByText('Specimen only. No real files exist.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Outcome', exact: true }).click();
  await page.getByText('The specimen has no signed Record and cannot approve anything.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Live ledger', exact: true }).click();
  await page.locator('.ledger-list button').first().waitFor({ timeout: 15000 });
  await page.locator('.ledger-list button').first().click();
  await page.getByRole('button', { name: 'Return to live' }).waitFor();
  await page.getByRole('button', { name: 'Return to live' }).click();
  assert.equal(await page.getByRole('button', { name: 'Return to live' }).count(), 0);
  await page.getByRole('button', { name: 'Anatomy', exact: true }).click();
  assert(await page.locator('canvas').isVisible());
  await page.getByRole('button', { name: 'New case ↗', exact: true }).click();
  await page.getByLabel('The task', { exact: true }).waitFor();

  if (process.env.JEVYR_CASE_ID) {
    await page.goto(`${baseUrl}/?case=${encodeURIComponent(process.env.JEVYR_CASE_ID)}`);
    await page.getByText('Sealed · observation only', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Inspect', exact: true }).click();
    await page.getByText('Concrete work', { exact: true }).waitFor();
    await page.screenshot({ path: resolve(output, 'case-observe.png'), fullPage: true });
    await page.getByRole('button', { name: 'Candidates', exact: true }).click();
    await page.locator('.candidate-row').first().waitFor({ timeout: 60000 });
    await page.screenshot({ path: resolve(output, 'case-candidates.png'), fullPage: true });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.artifact-list li button').first().waitFor({ timeout: 30000 });
    await page.locator('.artifact-list li button').first().click();
    await page.getByRole('button', { name: 'Download verified file' }).waitFor({ timeout: 30000 });
    await page.getByText('SHA-256 verified · index authenticated', { exact: true }).waitFor({ timeout: 30000 });
    if (await page.getByRole('button', { name: 'Download source file' }).count()) {
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Download source file' }).click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), 'jevyr.experiment.mjs');
      await download.saveAs(resolve(output, 'downloaded-candidate-source.mjs'));
    }
    await page.screenshot({ path: resolve(output, 'case-files.png'), fullPage: true });
    const executionReport = page.locator('.artifact-list li button').filter({ hasText: 'Execution report' }).first();
    if (await executionReport.count()) {
      await executionReport.click();
      await page.getByRole('heading', { name: 'Standard output', exact: true }).waitFor({ timeout: 30000 });
      await page.screenshot({ path: resolve(output, 'case-execution.png'), fullPage: true });
    }
    await page.getByRole('button', { name: 'Outcome', exact: true }).click();
    await page.getByText('Authenticated terminal record', { exact: true }).waitFor({ timeout: 60000 });
    await page.screenshot({ path: resolve(output, 'case-outcome.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow();
    await page.screenshot({ path: resolve(output, 'case-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: 'Observe', exact: true }).click();
    await page.locator('.outcome-strip').waitFor();
    await page.screenshot({ path: resolve(output, 'case-observe.png'), fullPage: true });
  }
  assert.deepEqual(errors, [], 'Browser must not emit uncaught errors');
  console.log(JSON.stringify({ result: 'passed', realCaseInspected: process.env.JEVYR_CASE_ID || null, screenshots: output }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ browserErrors: errors, body: (await page.locator('body').innerText()).slice(0, 4000) }));
  throw error;
} finally {
  await browser.close();
}
