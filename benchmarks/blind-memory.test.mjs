import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareTrials } from './blind-memory.mjs';

const trial = (condition, assay) => ({ model: 'qwen3-coder:30b-32k', taskId: 'lower-bound', condition, assay });
const measured = passed => ({ passed, imageId: `sha256:${'a'.repeat(64)}`, sourceUnchanged: true, execution: { exitCode: passed ? 0 : 1 } });

test('missing or unavailable memory trials cannot count as a measured blind advantage', () => {
  for (const trials of [[trial('blind', measured(true))], [trial('blind', measured(true)), trial('memory-first', { passed: false, problem: 'Provider unavailable' })]]) {
    const comparison = compareTrials(trials);
    assert.equal(comparison.blindComplementsMemory, false);
    assert.equal(comparison.paired[0].scorable, false);
    assert.equal(comparison.paired[0].memoryPassed, null);
    assert.equal(comparison.complementaryPairs.length, 0);
  }
});

test('a complete measured failed candidate arm remains visible without certifying an unfinished experiment', () => {
  const comparison = compareTrials([trial('blind', measured(true)), trial('memory-first', measured(false))]);
  assert.equal(comparison.paired[0].scorable, true);
  assert.equal(comparison.complementaryPairs.length, 1);
  assert.equal(comparison.complete, false);
  assert.equal(comparison.blindComplementsMemory, false);
});
