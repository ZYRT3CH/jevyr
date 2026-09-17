import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute, sep } from 'node:path';
import { chromium } from 'playwright';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const spec = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString('utf8'));
if (spec.protocol !== 'jevyr.browser-probe/1' || Object.keys(spec).sort().join(',') !== 'entry,protocol,steps'
  || typeof spec.entry !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*\.html$/u.test(spec.entry)
  || spec.entry.split('/').includes('..') || !Array.isArray(spec.steps) || !spec.steps.length || spec.steps.length > 64
  || !spec.steps.some(step => step.action?.startsWith('assert-'))) throw new Error('Invalid sealed browser specification');
for (const step of spec.steps) {
  const allowed = step.action === 'click' ? ['action','selector'] : step.action === 'fill' ? ['action','selector','value'] : ['action','expected','selector'];
  if (!['click','fill','assert-text','assert-count'].includes(step.action) || Object.keys(step).sort().join(',') !== allowed.sort().join(',')
    || typeof step.selector !== 'string' || !step.selector || step.selector.length > 1024
    || (step.action === 'fill' && (typeof step.value !== 'string' || step.value.length > 8192))
    || (step.action === 'assert-text' && (typeof step.expected !== 'string' || step.expected.length > 8192))
    || (step.action === 'assert-count' && (!Number.isSafeInteger(step.expected) || step.expected < 0 || step.expected > 10000))) throw new Error('Invalid browser step');
}
const root = await realpath(process.cwd());
const sources = new Map();
const events = [];
const server = createServer(async (request, response) => {
  try {
    const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname).replace(/^\//, '');
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || path.startsWith('.')) throw new Error('path');
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024 || await realpath(absolute) !== absolute) throw new Error('file');
    const bytes = await readFile(absolute);
    const sourceDigest = digest(bytes);
    sources.set(path, { path, sourceDigest, byteLength: bytes.length, text: bytes.toString('utf8') });
    response.writeHead(200, { 'content-type': ({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json'})[extname(path)] ?? 'application/octet-stream', 'cache-control':'no-store' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let context;
let page;
let passed = false;
let coverage = [];
let failure;
const collectionFailures = [];
const capturedArtifacts = new Set();
let coverageComplete = false;
const collectionFailure = (phase, error) => collectionFailures.push({ phase, message: String(error?.message ?? error).slice(0, 2000) });
const observedFields = observed => typeof observed === 'string' && observed.length > 8192
  ? { observed: observed.slice(0, 8192), observedTruncated: true, observedLength: observed.length, observedDigest: digest(observed) }
  : observed === undefined ? {} : { observed };
try {
  // OCI is the security boundary. Chromium receives no external network or host files.
  browser = await chromium.launch({ headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'], chromiumSandbox: false });
  context = await browser.newContext({ viewport: { width: 1024, height: 768 }, serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => { if (events.length < 256) events.push({ kind: 'pageerror', message: error.message.slice(0, 2000) }); });
  await page.coverage.startJSCoverage({ resetOnNavigation: false, reportAnonymousScripts: true });
  await page.goto(`${origin}/${spec.entry}`, { waitUntil: 'load', timeout: 10000 });
  for (const [index, step] of spec.steps.entries()) {
    const target = page.locator(step.selector);
    let observed;
    const event = { index, action: step.action, selector: step.selector, ...(step.expected === undefined ? {} : { expected: step.expected }) };
    try {
      if (step.action === 'click') await target.click();
      else if (step.action === 'fill') await target.fill(step.value);
      else if (step.action === 'assert-text') { observed = await target.textContent(); if (observed !== step.expected) throw new Error(`Assertion ${index} text mismatch`); }
      else if (step.action === 'assert-count') { observed = await target.count(); if (observed !== step.expected) throw new Error(`Assertion ${index} count mismatch`); }
      events.push({ ...event, status: 'passed', ...observedFields(observed) });
    } catch (error) {
      events.push({ ...event, status: 'failed', ...observedFields(observed), failure: String(error?.message ?? error).slice(0, 2000) });
      throw error;
    }
  }
  passed = true;
} catch (error) { failure = String(error.message ?? error).slice(0, 2000); }
finally {
  if (page) {
    try { coverage = await page.coverage.stopJSCoverage(); coverageComplete = true; } catch (error) { collectionFailure('coverage', error); }
    try { await page.screenshot({ path: 'jevyr.browser.png', timeout: 3000 }); capturedArtifacts.add('jevyr.browser.png'); } catch (error) { collectionFailure('screenshot', error); }
  }
  if (context) {
    try { await context.tracing.stop({ path: 'jevyr.browser.trace.zip' }); capturedArtifacts.add('jevyr.browser.trace.zip'); } catch (error) { collectionFailure('trace', error); }
  }
  try { await browser?.close(); } catch (error) { collectionFailure('browser-close', error); }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
let scriptSourceBytes = 0;
let runtimeComplete = coverage.length <= 128;
const runtime = coverage.slice(0, 128).map(script => {
  let path;
  try { if (new URL(script.url).origin === origin) path = decodeURIComponent(new URL(script.url).pathname).slice(1); } catch {}
  const source = path ? sources.get(path) : undefined;
  const sourceText = script.source ?? '';
  const sourceByteLength = Buffer.byteLength(sourceText);
  const sourceComplete = sourceByteLength <= 524288 && scriptSourceBytes + sourceByteLength <= 2097152;
  if (sourceComplete) scriptSourceBytes += sourceByteLength;
  if (!sourceComplete || script.functions.length > 1024 || script.functions.some(fn => fn.ranges.length > 1024)) runtimeComplete = false;
  // Coverage attributes observed execution; it does not establish causal necessity.
  return { scriptId: script.scriptId, url: path ?? 'anonymous', scriptDigest: digest(sourceText), sourceByteLength, sourceComplete,
    ...(sourceComplete ? { sourceText } : { sourceOmission: 'script-source-budget' }),
    ...(source ? { source: { path: source.path, sourceDigest: source.sourceDigest } } : {}),
    functions: script.functions.slice(0, 1024).map(fn => ({ name: fn.functionName, ranges: fn.ranges.slice(0, 1024) })) };
});
const artifacts = [];
for (const path of ['jevyr.browser.trace.zip','jevyr.browser.png']) {
  if (!capturedArtifacts.has(path)) continue;
  try { const bytes = await readFile(path); artifacts.push({ path, digest: digest(bytes), bytes: bytes.length }); } catch (error) { collectionFailure(`artifact:${path}`, error); }
}
const evidenceComplete = coverageComplete && runtimeComplete && artifacts.length === 2 && collectionFailures.length === 0;
const report = { protocol: 'jevyr.browser-observation/1', specDigest: digest(JSON.stringify(spec)), passed, assertionsPassed: passed, evidenceComplete,
  coverageComplete, runtimeComplete, collectionFailures, events, runtime,
  sources: [...sources.values()].map(({text,...source}) => source), artifacts, attributionIsCausation: false, ...(failure ? { failure } : {}) };
await writeFile('jevyr.browser.observation.json', JSON.stringify(report));
process.stdout.write(JSON.stringify({ passed, evidenceComplete, reportDigest: digest(JSON.stringify(report)), steps: events.length, scripts: runtime.length }));
process.exitCode = passed ? 0 : 1;
