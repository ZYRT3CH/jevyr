#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { benchmarkFixtures, benchmarkModels, compareTrials } from './blind-memory.mjs';

const digest = value => `sha256:${createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')}`;
async function document(path) { const info = await lstat(path); assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 16_777_216, 'Unbounded or non-regular evidence file'); return JSON.parse(await readFile(path, 'utf8')); }

export async function verifyBlindMemory(path) {
  const root = dirname(resolve(path));
  const report = await document(path);
  const manifest = await document(resolve(root, 'manifest.json'));
  assert.equal(report.protocol, 'jevyr.blind-memory-experiment/1');
  assert.equal(report.manifestDigest, digest(manifest));
  assert.deepEqual(manifest.tasks, benchmarkFixtures);
  assert.deepEqual(manifest.models, benchmarkModels);
  assert.equal(manifest.endpoint, 'http://127.0.0.1:11434/v1/');
  assert.equal(report.trials.length, benchmarkFixtures.length * benchmarkModels.length * 2);
  const unique = new Set(); const trials = [];
  for (const original of report.trials) {
    const fixture = benchmarkFixtures.find(task => task.id === original.taskId);
    assert.ok(fixture && benchmarkModels.includes(original.model));
    assert.ok(['blind', 'memory-first'].includes(original.condition));
    const identity = `${original.model}:${original.taskId}:${original.condition}`;
    assert.ok(!unique.has(identity), 'Duplicate paired arm'); unique.add(identity);
    const trialRoot = resolve(original.directory);
    const local = relative(root, trialRoot);
    assert.ok(local && !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`));
    const generation = await document(resolve(trialRoot, 'generation.json'));
    const observation = await document(resolve(trialRoot, 'observation.json'));
    assert.equal(original.generationDigest, digest(generation));
    assert.equal(original.observationDigest, digest(observation));
    assert.deepEqual(original.assay, observation);
    let measured = false, passed = false;
    if (generation.responseStatus === 200 && typeof generation.source === 'string' && observation.execution) {
      const provider = JSON.parse(generation.response);
      assert.equal(provider.model, original.model, 'Provider-reported model differs from assigned model');
      assert.equal(generation.request.model, original.model);
      assert.equal(generation.request.seed, original.seed);
      const prompt = generation.request.messages[0].content;
      assert.equal(digest(prompt), original.promptDigest);
      assert.ok(prompt.includes(fixture.requirement));
      assert.equal(prompt.includes(fixture.memory), original.condition === 'memory-first');
      assert.equal(JSON.parse(provider.choices[0].message.content).source, generation.source);
      assert.equal(observation.sourceDigest, digest(generation.source));
      const sourceFile = manifest.driver ? 'solution.mjs' : 'program.mjs';
      assert.equal(digest(await readFile(resolve(trialRoot, 'candidate', sourceFile))), observation.sourceDigest);
      if (manifest.driver) {
        assert.equal(digest(manifest.driver), manifest.driverDigest);
        assert.equal(await readFile(resolve(trialRoot, 'candidate', 'program.mjs'), 'utf8'), manifest.driver);
      }
      assert.equal(observation.sourceUnchanged, true);
      assert.equal(observation.imageId, manifest.imageId);
      assert.equal(observation.inputDigest, digest(fixture.inputs));
      assert.deepEqual(observation.expected, fixture.expected);
      const args = observation.command;
      for (const flag of ['--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=256m', '--cpus=1', '--pids-limit=64', '--user=65532:65532']) assert.ok(args.includes(flag));
      assert.deepEqual(args.slice(-3), ['node', manifest.imageId, '/candidate/program.mjs']);
      const output = observation.execution;
      let parsed; try { parsed = JSON.parse(output.stdout); } catch {}
      measured = typeof output.exitCode === 'number';
      passed = measured && output.exitCode === 0 && !output.timedOut && !output.exceeded && isDeepStrictEqual(parsed, fixture.expected);
      assert.equal(observation.passed, passed, 'Original pass assertion disagrees with exact independently evaluated output');
    }
    trials.push({ ...original, assay: measured ? { ...observation, passed } : { passed: false, problem: 'No complete measured candidate execution' } });
  }
  for (const model of benchmarkModels) for (const task of benchmarkFixtures) {
    const pair = trials.filter(trial => trial.model === model && trial.taskId === task.id);
    assert.equal(pair.length, 2); assert.equal(pair[0].seed, pair[1].seed);
  }
  return { protocol: 'jevyr.verified-blind-memory/1', scope: 'independent-output-recalculation-and-local-artifact-consistency', authenticity: 'UNSIGNED_LOCAL_EXPERIMENT', report: resolve(path), reportDigest: digest(report), manifestDigest: digest(manifest), comparison: compareTrials(trials), caveat: 'This recomputes recorded outcomes; it does not rerun stochastic models or independently attest host process observations. A bounded complement is not population-wide superiority or proof that memory caused a failure.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await verifyBlindMemory(resolve(process.argv[2]));
  await writeFile(resolve(dirname(process.argv[2]), 'verified.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
