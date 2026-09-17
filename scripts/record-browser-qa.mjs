import { chromium } from 'file:///C:/Users/sondr/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), fixture = resolve(root, process.argv[2] ?? 'artifacts/lifecycle-revision-1788580660671');
const output = join(root, 'artifacts', 'record-browser-qa', basename(fixture)); await mkdir(output, { recursive: true });
const load = async name => JSON.parse(await readFile(join(fixture, 'proof', name), 'utf8'));
const report = JSON.parse(await readFile(join(fixture, 'report.json'), 'utf8')), id = report.caseId;
const [events, index, terminal] = await Promise.all([load('events.json'), load('artifact-index.json'), load('terminal-receipt.json')]);
const sealed = report.status?.sealed ?? await load('sealed-case.json'), prefix = `/v1/cases/${id}`;
const status = { protocol: 'jevyr.status/1', caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, lifecycle: terminal.lifecycle, stage: terminal.stage, stageStatus: terminal.stageStatus, lastSequence: terminal.lastSequence, headDigest: terminal.eventHeadDigest, updatedAt: terminal.closedAt };
const routes = new Map([[prefix, status], [`${prefix}/sealed-case`, sealed]]);
for (const [suffix, file] of [['/record', 'record.json'], ['/record/envelope', 'record.dsse.json'], ['/seal', 'seal-receipt.json'], ['/seal/envelope', 'seal.dsse.json'], ['/terminal', 'terminal-receipt.json'], ['/terminal/envelope', 'terminal.dsse.json'], ['/artifacts', 'artifact-index.json'], ['/intent-contract', 'intent-contract.json'], ['/policy-descriptor', 'policy-descriptor.json']]) routes.set(prefix + suffix, await load(file));
routes.set('/v1/trust', await load('trust.json'));
let sidecars;
try { sidecars = await load('run-attestations.json'); }
catch (error) { if (error.code !== 'ENOENT') throw error; try { sidecars = JSON.parse(await readFile(join(fixture, '.jevyr', 'cases', id, 'run-attestations.json'), 'utf8')); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; } }
if (sidecars) routes.set(`${prefix}/attestations`, sidecars);
let corruptArtifact = false;
let heldArtifact;
const server = createServer(async (request, response) => {
  response.setHeader('access-control-allow-origin', 'http://localhost:3002'); response.setHeader('access-control-allow-headers', 'authorization,last-event-id'); response.setHeader('access-control-expose-headers', 'x-jevyr-digest,content-length,content-type');
  if (request.method === 'OPTIONS') { response.writeHead(204).end(); return; }
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  const url = new URL(request.url, 'http://localhost'), after = Number(url.searchParams.get('after') ?? 0);
  if (url.pathname === `${prefix}/events/stream`) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.filter(event => event.sequence > after).map(event => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`).join('')); return; }
  if (url.pathname === `${prefix}/events`) {
    const page = events.filter(event => event.sequence > after).slice(0, Number(url.searchParams.get('limit') ?? 500)), through = page.at(-1)?.sequence ?? after;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ protocol: 'jevyr.live/1', caseDigest: sealed.caseDigest, runDigest: sealed.runDigest, afterSequence: after, throughSequence: through, headDigest: page.at(-1)?.eventDigest ?? events.find(event => event.sequence === after)?.eventDigest ?? null, caughtUp: through === events.length, events: page, polledAt: new Date().toISOString() })); return;
  }
  if (routes.has(url.pathname)) { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(routes.get(url.pathname))); return; }
  const artifact = index.artifacts.find(entry => url.pathname === `${prefix}/artifacts/${entry.id}`);
  if (artifact) { const data = await readFile(join(fixture, 'proof', 'artifacts', `${artifact.id}.blob`)); if (corruptArtifact && data.length) data[0] ^= 1; const hold = heldArtifact; heldArtifact = undefined; if (hold) { hold.seen(); await hold.release; } response.writeHead(200, { 'content-type': artifact.mediaType, 'content-length': data.length, 'x-jevyr-digest': artifact.digest }).end(data); return; }
  response.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No fixture read route', path: url.pathname }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ channel: 'msedge', headless: true });
const result = { protocol: 'jevyr.record-browser-qa/1', fixture, caseId: id, mode: report.mode, judgment: routes.get(`${prefix}/record`).verdict.judgment, scope: 'Real signed lifecycle proof, served through an isolated read-only fixture HTTP adapter; no live Case is created or altered', checks: [], errors: [] };
let page;
try {
  page = await browser.newPage({ reducedMotion: 'reduce' }); page.on('pageerror', error => result.errors.push(error.message));
  await page.goto(`http://localhost:3002/record?case=${id}&api=${encodeURIComponent(address)}`); await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Read authenticated Record', exact: true }).click();
  await page.getByRole('heading', { name: 'Binding findings and unresolved claims' }).waitFor({ timeout: 30_000 });
  await page.getByRole('link', { name: /^Open evidence/ }).first().click();
  await page.locator('details[open]').filter({ hasText: 'evidence.observed' }).first().waitFor();
  const evidence = page.locator('details[open]').filter({ hasText: 'evidence.observed' }).first();
  await evidence.getByRole('button', { name: /^Inspect / }).first().click();
  await page.getByRole('button', { name: 'Download verified bytes', exact: true }).waitFor();
  result.checks.push('Authenticated Record basis opens exact ledger evidence and verified indexed observation bytes');
  corruptArtifact = true;
  await evidence.getByRole('button', { name: /^Inspect / }).first().click();
  await page.getByRole('alert').filter({ hasText: 'SHA-256' }).waitFor();
  if (await page.getByRole('button', { name: 'Download verified bytes', exact: true }).count()) throw new Error('A corrupted artifact retained the verified download control');
  corruptArtifact = false;
  await evidence.getByRole('button', { name: /^Inspect / }).first().click();
  await page.getByRole('button', { name: 'Download verified bytes', exact: true }).waitFor();
  result.checks.push('Changed artifact response bytes are rejected; corrupted material has no verified download control');
  if (sidecars) { await page.getByText('Verified SLSA production and in-toto advisory statements', { exact: true }).click(); result.checks.push('Verified fixed production/advisory statements are visible'); }
  else { await page.getByText('This historical Case has no required production-attestation sidecars.', { exact: true }).waitFor(); result.checks.push('Historical unmarked Case is accurately labeled without production sidecars'); }
  const policy = routes.get(`${prefix}/policy-descriptor`).artifact.descriptor;
  const reproducible = sealed.intent.control === 'sovereign' || policy.policy?.metabolicCheckpoints?.protocol === 'jevyr.metabolic-checkpoints/1';
  const visible = await page.locator('main').innerText();
  for (const flag of ['--same-seed', '--new-seed']) if (visible.includes(`judge replay ${id} ${flag}`) !== reproducible) throw new Error('Replay commands do not match the authenticated policy');
  if (sealed.intent.control === 'juggler' && reproducible && !visible.includes('first eligible checkpoint in each original stage')) throw new Error('Juggler rerun omitted its actual new-seed mapping limit');
  result.checks.push('Displayed seeded replay commands follow the authenticated Case mode and checkpoint policy, with explicit Juggler mapping limits');
  for (const width of [1024, 736, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const measured = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
    if (measured.document > width) throw new Error(`Record overflow ${measured.document} > ${width}`);
    await page.screenshot({ path: join(output, `record-${width}.png`), fullPage: true }); result.checks.push(measured);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(output, `record-top-${width}.png`) });
  }
  let releaseArtifact, sawArtifact;
  const artifactSeen = new Promise(resolve => { sawArtifact = resolve; });
  heldArtifact = { release: new Promise(resolve => { releaseArtifact = resolve; }), seen: sawArtifact };
  await evidence.getByRole('button', { name: /^Inspect / }).first().click();
  await artifactSeen;
  await page.getByRole('button', { name: 'Inspect another Case', exact: true }).click();
  await page.getByRole('button', { name: 'Read authenticated Record', exact: true }).click();
  await page.getByRole('heading', { name: 'Binding findings and unresolved claims' }).waitFor();
  releaseArtifact();
  await page.waitForTimeout(300);
  if (await page.getByRole('button', { name: 'Download verified bytes', exact: true }).count() || await page.getByRole('alert').count()) throw new Error('A canceled prior-view artifact request contaminated the newly authenticated Record view');
  result.checks.push('A delayed verified artifact response cannot populate or fail a new Record inspection after resetting the view');
  if (result.errors.length) throw new Error('Uncaught browser errors'); result.passed = true;
} catch (error) { result.passed = false; result.failure = error.stack; if (page) { result.visibleText = await page.locator('body').innerText(); await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }); } throw error; }
finally { await writeFile(join(output, 'report.json'), JSON.stringify(result, null, 2)); await browser.close(); await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(result, null, 2));
