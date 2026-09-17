#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const measurement = (id, file, scope, checks) => ({ id, file, scope, checks });
export const protocolExperiments = [
  measurement('airlock-http', 'apps/daemon/test/server.test.ts', 'real loopback HTTP, SSE and persisted Case; explicit Rule fixture', [
    { name: 'HTTP daemon exposes exact canonical boundaries, resumable SSE, and no continuation', gates: ['one-way-boundary'], assertions: ['late message/continue/verdict routes rejected', 'SSE resume and long-poll exact ledger closure', 'only one Case created'] },
  ]),
  measurement('seven-submission-surfaces', 'apps/daemon/test/transports.test.ts', 'real CLI child, HTTP JSON/multipart, JSONL framing, atomic filesystem, MCP framing and A2A; shared exact input and seed', [
    { name: 'CLI, HTTP JSON, multipart uploads, JSONL, drop bundle, MCP, and A2A seal identical Case identity', gates: ['transport-equivalence'], assertions: ['seven equal case digests', 'seven equal submission/material digests', 'seven distinct run identities', 'sealed Cases reach closure'] },
    { name: 'JSONL isolates oversized and malformed lines and refuses semantic continuation', gates: ['one-way-boundary'], assertions: ['oversized and ambiguous inputs rejected', 'continuation refused before extra Case creation'] },
    { name: 'A2A rejects all task/context continuation and caller verdict fields before Cast', gates: ['one-way-boundary'], assertions: ['task/context IDs and approval/verdict/continue fields refused'] },
  ]),
  measurement('mcp-one-write', 'apps/daemon/test/mcp.test.ts', 'actual framed MCP dispatch against a bounded backend fixture', [
    { name: 'MCP proxy backend exposes one Cast write and reads an existing case without another runtime', gates: ['one-way-boundary'], assertions: ['exactly one advertised semantic Cast', 'read methods do not cast'] },
  ]),
  measurement('policy-and-lifecycle-perturbations', 'benchmarks/boundary-experiments.ts', 'explicit paired kernel perturbations plus complete loopback fault-injection lifecycles; no language model invoked', [
    { name: 'same-evidence policy judgments ignore flattering and hostile public prose', gates: ['preference-invariance'], assertions: ['ACCEPT and REJECT retained for both flattering and hostile wording', 'all axes, selection and reasons identical; provenance digest changes retained'] },
    { name: 'model assertions cannot override either observed success or observed failure', gates: ['self-report-authority'], assertions: ['opposing zero-authority self-report changes neither observed outcome', 'model-only unexecuted assay remains UNPROVEN'] },
    { name: 'text and JSON delivery preserve the exact authoritative Record and verdict', gates: ['delivery-invariance'], assertions: ['actual CLI text renderer and compact/pretty JSON leave canonical Record unchanged'] },
    { name: 'sealed source remains byte-identical through a complete local case', gates: ['source-immutability'], assertions: ['before/after source hashes equal through full lifecycle'] },
    { name: 'injected provider and Forge exceptions produce authenticated INVALID Records', gates: ['failure-invalidity'], assertions: ['both adapter fault boundaries actually reached', 'both signed Records authenticate and are INVALID'] },
  ]),
  measurement('material-projection-and-reconstruction', 'packages/runtime/test/sealed-material-flow.test.ts', 'actual orchestrator requests and disposable filesystem roots with recording adapters', [
    { name: 'every mind sees synthetic locators while provider scope withholds material only from remote minds', gates: ['privacy-boundary'], assertions: ['local Mind receives sealed bytes', 'remote Mind receives no subject projection', 'no Mind receives original subject paths'] },
    { name: "Forge receives a fresh CAS reconstruction and never the policy plan's original sourceRoot", gates: ['source-immutability'], assertions: ['Forge sees captured source bytes in distinct roots', 'disposable roots removed after execution'] },
  ]),
  measurement('juggler-scheduler', 'packages/runtime/test/juggler.test.ts', 'actual adaptive nursery scheduler with three deterministic investigator fixtures; sealed ceilings held fixed', [
    { name: 'Sovereign mode has no voucher channel; tokens cannot carry semantic data or cross cases', gates: ['juggler-trace-effect', 'one-way-boundary'], assertions: ['no Sovereign book', 'extra semantic fields, foreign, spent and closed tokens rejected'] },
    { name: 'each voucher produces its declared bounded scheduler effect and a digest receipt', gates: ['juggler-trace-effect'], assertions: ['Mass/Refraction/Polarity/Fission/Inertia exact deltas', 'no verdict authority', 'no sealed resource ceiling enlarged'] },
    { name: 'Mass changes actual nursery invocation count without increasing a partitioned remainder', gates: ['juggler-trace-effect'], assertions: ['actual calls change 2 to 3 within existing remainder 3'] },
    { name: 'resource grants and sealed policy cannot be enlarged by a forged schedule', gates: ['juggler-trace-effect'], assertions: ['forged grants and Sovereign schedule denied'] },
    { name: 'Refraction, Polarity, Fission and Inertia change actual investigator or nursery phase traces', gates: ['juggler-trace-effect'], assertions: ['first investigator rotates', 'challenge phases differ', 'blind lineage phases differ', 'saturation produces one more attempt'] },
  ]),
  measurement('juggler-http-ledger', 'apps/daemon/test/juggler-http.test.ts', 'real loopback token redemption during a paused lifecycle; signed public trace', [
    { name: 'HTTP Juggler redeems only opaque single-use tokens and binds scheduling receipts', gates: ['juggler-trace-effect'], assertions: ['semantic body rejected', 'opaque token single-use and closed-window enforcement', 'receipt digest appears in persisted trace'] },
  ]),
  measurement('sandbox-failure-classification', 'packages/runtime/test/forge-integrity.test.ts', 'exact typed boundary metadata classifier; does not claim a live Docker outage', [
    { name: 'lost startup sandbox and broken execution boundaries invalidate independently of prose', gates: ['failure-invalidity'], assertions: ['lost startup engine and typed boundary mismatches classify INVALID', 'prose cannot confer this authority'] },
    { name: 'command failure and enforced resource stops remain assay outcomes', gates: ['failure-invalidity'], assertions: ['ordinary nonzero exit stays an assay outcome', 'sealed image authority mismatch is integrity failure'] },
  ]),
  measurement('corrupt-storage-recovery', 'apps/daemon/test/recovery.test.ts', 'actual disk state, daemon restart, fixed recovery Records and signature publication', [
    { name: 'startup invalidates an interrupted case instead of rerunning it', gates: ['failure-invalidity'], assertions: ['restart produces INVALID', 'no semantic resume or live mutable memory entrypoint'] },
    { name: 'startup refuses malformed or duplicate status authority before recovery can append or sign', gates: ['failure-invalidity'], assertions: ['malformed persisted authority rejected before signing'] },
    { name: 'a partial Record pair is preserved while recovery publishes the emergency Record', gates: ['failure-invalidity'], assertions: ['original partial signed material preserved', 'emergency INVALID receipt published'] },
  ]),
  { ...measurement('memory-project-closure', 'packages/memory/test/reconciliation.test.ts', 'real SQLite-backed memory lineage and persisted contamination mutations; explicit finite evidence fixtures', [
    { name: 'reconstructs the fixed point and binds independently re-derived admissions', gates: ['memory-contamination'], assertions: ['transitive ancestry closure reconstructed', 'copied unsigned closure denied'] },
    { name: 'rejects missing, pending, corrupt, and direct cross-project lineage', gates: ['memory-contamination', 'privacy-boundary'], assertions: ['pending/missing/corrupted SQLite evidence denied', 'foreign project memory cannot directly cross the boundary'] },
    { name: 'permits only an admitted SELF abstraction to bridge project ancestry', gates: ['privacy-boundary'], assertions: ['two later reproductions and privacy review required before SELF bridge'] },
  ]), engine: 'vitest' },
  { ...measurement('memory-contamination-dominance', 'packages/memory/test/evidence-ledger.test.ts', 'real durable evidence reconciliation with independently identified Case/run fixtures', [
    { name: 'lets any real contamination failure dominate passing checks', gates: ['memory-contamination'], assertions: ['a real failed contamination observation dominates prior passes'] },
    { name: 'admits only after two independent reproductions and a real passing contamination observation', gates: ['memory-contamination'], assertions: ['same-run repeats do not replace two independent reproductions', 'passing contamination witness mandatory'] },
    { name: 'keeps SELF abstraction private and requires a real privacy-review observation', gates: ['privacy-boundary'], assertions: ['SELF not shared before actual privacy review evidence'] },
  ]), engine: 'vitest' },
];

export function parseTapChecks(output, checks) {
  const results = new Map([...output.matchAll(/^(not )?ok \d+ - (.+)$/gmu)].map((match) => [match[2], match[1] ? 'FAIL' : 'PASS']));
  return checks.map((check) => ({ ...check, status: results.get(check.name) ?? 'MISSING' }));
}

export function parseVitestChecks(output, checks) {
  try {
    const report = JSON.parse(output);
    const results = new Map(report.testResults.flatMap((file) => file.assertionResults.map((entry) => [entry.title, entry.status === 'passed' ? 'PASS' : entry.status === 'failed' ? 'FAIL' : 'MISSING'])));
    return checks.map((check) => ({ ...check, status: results.get(check.name) ?? 'MISSING' }));
  } catch { return checks.map((check) => ({ ...check, status: 'MISSING' })); }
}

export async function runProtocolExperiment(experiment, root = repositoryRoot) {
  const cwd = /^(apps|packages)\//u.test(experiment.file) ? experiment.file.split('/').slice(0, 2).join('/') : '.';
  const pattern = `(?:${experiment.checks.map((check) => escapeRegex(check.name)).join('|')})`;
  const args = experiment.engine === 'vitest'
    ? ['--conditions=development', resolve(root, cwd, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', '--testNamePattern', pattern, resolve(root, experiment.file)]
    : [resolve(root, 'apps/cli/node_modules/tsx/dist/cli.mjs'), '--conditions=development', '--test', '--test-reporter=tap', `--test-name-pattern=^${pattern}$`, resolve(root, experiment.file)];
  const sourceBefore = digest(await readFile(resolve(root, experiment.file)));
  const startedAt = new Date().toISOString();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY)/iu.test(key) && !key.startsWith('JEVYR_')));
  env.NO_COLOR = '1';
  const execution = await new Promise((complete) => {
    let output = ''; let stdout = '';
    const child = spawn(process.execPath, args, { cwd: resolve(root, cwd), env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 8_388_608) child.kill(); };
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); collect(chunk); }); child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), 180_000);
    child.once('error', (error) => { clearTimeout(timer); complete({ exitCode: null, stdout, output: `${output}\n${error.message}` }); });
    child.once('close', (exitCode) => { clearTimeout(timer); complete({ exitCode, stdout, output }); });
  });
  const checks = experiment.engine === 'vitest' ? parseVitestChecks(execution.stdout, experiment.checks) : parseTapChecks(execution.output, experiment.checks);
  const sourceAfter = digest(await readFile(resolve(root, experiment.file)));
  const observations = execution.output.split(/\r?\n/u).flatMap((line) => { if (!line.startsWith('# {')) return []; try { return [JSON.parse(line.slice(2))]; } catch { return []; } });
  return { protocol: 'jevyr.protocol-experiment/1', id: experiment.id, scope: experiment.scope, startedAt, endedAt: new Date().toISOString(), command: { executable: 'node', cwd, args }, sourceBefore, sourceAfter, sourceUnchanged: sourceBefore === sourceAfter, status: execution.exitCode === 0 && checks.every((check) => check.status === 'PASS') && sourceBefore === sourceAfter ? 'PASS' : 'FAIL', checks, observations, exitCode: execution.exitCode, outputDigest: digest(execution.output), output: execution.output, ...(experiment.engine === 'vitest' ? { machineOutput: execution.stdout } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const output = resolve(args.includes('--output') ? args[args.indexOf('--output') + 1] : 'artifacts/protocol-experiments.json');
  const selected = args.includes('--experiment') ? args[args.indexOf('--experiment') + 1] : undefined;
  if (selected && !protocolExperiments.some((entry) => entry.id === selected)) throw new TypeError(`Unknown experiment ${selected}`);
  const results = [];
  for (const experiment of protocolExperiments.filter((entry) => !selected || entry.id === selected)) {
    process.stdout.write(`Measuring ${experiment.id}\n`);
    const result = await runProtocolExperiment(experiment);
    results.push(result);
    process.stdout.write(`${result.status} ${experiment.id}: ${result.checks.filter((check) => check.status === 'PASS').length}/${result.checks.length} exact checks\n`);
  }
  const gates = [...new Set(protocolExperiments.flatMap((entry) => entry.checks.flatMap((check) => check.gates)))].map((id) => {
    const required = protocolExperiments.flatMap((experiment) => experiment.checks.filter((check) => check.gates.includes(id)).map((check) => ({ experiment: experiment.id, check: check.name })));
    const observed = required.map((ref) => ({ ...ref, status: results.find((result) => result.id === ref.experiment)?.checks.find((check) => check.name === ref.check)?.status ?? 'MISSING' }));
    return { id, status: observed.every((entry) => entry.status === 'PASS') ? 'PASS' : observed.some((entry) => entry.status === 'FAIL') ? 'FAIL' : 'OPEN', scope: 'the exact finite checks listed; no statistical model generalization asserted', checks: observed };
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify({ protocol: 'jevyr.protocol-experiment-report/1', observedAt: new Date().toISOString(), scope: 'measured-finite-protocol-and-policy-experiments', releaseReady: false, note: 'Separate from broad unit-suite counts. PASS is limited to executed named checks; live model, browser, memory comparisons and corpus expectations have independent evidence.', runnerDigest: digest(await readFile(fileURLToPath(import.meta.url))), lockfileDigest: digest(await readFile(resolve(repositoryRoot, 'pnpm-lock.yaml'))), gates, experiments: results }, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Measured ${results.length} experiments: ${output}\n`);
  process.exitCode = results.every((entry) => entry.status === 'PASS') ? 0 : 1;
}
