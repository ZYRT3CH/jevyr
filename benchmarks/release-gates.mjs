#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export const experiments = [
  { id: 'constitutional-kernel', cwd: 'packages/core', cli: 'node_modules/vitest/vitest.mjs', args: ['run'], supports: ['deterministic-judgment', 'unexecuted-critical', 'self-report-authority', 'preference-invariance'] },
  { id: 'memory-tribunal', cwd: 'packages/memory', cli: 'node_modules/vitest/vitest.mjs', args: ['run'], supports: ['memory-contamination', 'privacy-boundary'] },
  { id: 'genome-governance', cwd: 'packages/growth', cli: 'node_modules/vitest/vitest.mjs', args: ['run'], supports: ['genome-quarantine'] },
  { id: 'transport-boundaries', cwd: 'apps/daemon', cli: 'node_modules/tsx/dist/cli.mjs', args: ['--conditions=development', '--test', 'test/**/*.test.ts'], supports: ['one-way-boundary', 'transport-equivalence', 'failure-invalidity'] },
];

export function measuredOutcome(exitCode, output) {
  const plain = output.replace(/\u001b\[[0-9;]*m/gu, '');
  const count = Number(plain.match(/Tests\s+(\d+) passed/u)?.[1] ?? plain.match(/(?:#|ℹ) tests (\d+)/u)?.[1] ?? 0);
  return { status: exitCode === 0 && count > 0 ? 'PASS' : 'FAIL', assertionsExecuted: count };
}

export async function runMeasurement(experiment, repositoryRoot = root) {
  const cwd = resolve(repositoryRoot, experiment.cwd);
  const args = ['--conditions=development', resolve(cwd, experiment.cli), ...experiment.args];
  const startedAt = new Date().toISOString();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_?KEY)/iu.test(key) && !key.startsWith('JEVYR_')));
  env.NO_COLOR = '1';
  const execution = await new Promise((complete) => {
    let output = '';
    const child = spawn(process.execPath, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 8_388_608) child.kill(); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill(), 300_000);
    child.once('error', (error) => { clearTimeout(timer); complete({ exitCode: null, output: `${output}\n${error.message}` }); });
    child.once('close', (exitCode) => { clearTimeout(timer); complete({ exitCode, output }); });
  });
  return { protocol: 'jevyr.measured-test/1', id: experiment.id, supports: experiment.supports, startedAt, endedAt: new Date().toISOString(), command: { executable: 'node', cwd: experiment.cwd, args: ['--conditions=development', experiment.cli, ...experiment.args] }, ...measuredOutcome(execution.exitCode, execution.output), exitCode: execution.exitCode, outputDigest: sha256(execution.output), output: execution.output };
}

export function measurementReport(measurements, observedAt = new Date().toISOString()) {
  return { protocol: 'jevyr.release-unit-evidence/1', observedAt, scope: 'local-test-observations', releaseReady: false, empiricalGates: 'OPEN: live heterogeneous cases, all transports, provider/sandbox failure, browser traces, memory-first comparisons and every voucher still require recorded experimental evidence.', measurements };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output');
  const destination = resolve(root, outputIndex >= 0 ? args[outputIndex + 1] : 'artifacts/release-unit-evidence.json');
  const measurements = [];
  if (args.includes('--run-tests')) {
    for (const experiment of experiments) {
      process.stdout.write(`Measuring ${experiment.id}…\n`);
      const measurement = await runMeasurement(experiment);
      measurements.push(measurement);
      process.stdout.write(`${measurement.status} ${measurement.id}: ${measurement.assertionsExecuted} assertions\n`);
    }
  }
  const report = measurementReport(measurements);
  report.runnerDigest = sha256(await readFile(fileURLToPath(import.meta.url)));
  report.lockfileDigest = sha256(await readFile(resolve(root, 'pnpm-lock.yaml')));
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`Recorded ${measurements.length} measured suites to ${destination}. Empirical release gates remain open.\n`);
  process.exitCode = measurements.some((entry) => entry.status === 'FAIL') ? 1 : 0;
}
