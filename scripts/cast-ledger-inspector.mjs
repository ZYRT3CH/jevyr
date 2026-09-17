// An actual one-shot task submitted through the human Chamber.
// This creates a durable case; it is not a fixture, specimen, or benchmark.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CASE_EVENT_JSON_SCHEMA } from '../packages/protocol/dist/index.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.JEVYR_PLAYWRIGHT_PATH || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.JEVYR_BROWSER_CHANNEL ? { channel: process.env.JEVYR_BROWSER_CHANNEL } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
try {
  await page.goto(process.env.JEVYR_CHAMBER_URL || 'http://localhost:3001');
  await page.getByRole('heading', { name: 'Ready to work', exact: true }).waitFor({ timeout: 30000 });
  await page.getByLabel('The task', { exact: true }).fill('Create a dependency-free Node.js inspector for Jevyr JSON-lines event ledgers. Detect a missing sequence, a mismatched priorDigest, and case/run identity drift without treating a model claim as proof. Include self-checks covering valid input and each failure; report results as JSON from jevyr.experiment.mjs. No network or external packages.');
  await page.getByText('Create + test', { exact: true }).click();
  await page.getByText('Attach subjects & constraints', { exact: false }).click();
  await page.getByRole('combobox', { name: 'Subject kind', exact: true }).selectOption('text');
  await page.getByLabel('Location or text').fill(JSON.stringify({
    schema: CASE_EVENT_JSON_SCHEMA,
    continuity: 'Sequences start at 1 and advance exactly once per event. The first priorDigest is null. Each later priorDigest equals the previous eventDigest. caseDigest and runDigest remain constant. Recompute each eventDigest from canonical sorted-key JSON of the other event fields using SHA-256. Hash continuity does not prove the truth of payload claims.',
  }));
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await page.locator('.subject-list li').waitFor();
  await page.getByRole('button', { name: 'Seal the case' }).click();
  await page.waitForURL(url => url.searchParams.has('case'), { timeout: 30000 });
  assert.equal(await page.getByLabel('The task', { exact: true }).count(), 0);
  const caseId = new URL(page.url()).searchParams.get('case');
  console.log(JSON.stringify({ caseId, url: page.url(), submittedThrough: 'Chamber', localOnly: true }, null, 2));
} finally {
  await browser.close();
}
