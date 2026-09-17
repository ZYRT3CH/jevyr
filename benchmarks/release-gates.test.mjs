import { strict as assert } from 'node:assert';
import test from 'node:test';
import { measuredOutcome, measurementReport } from './release-gates.mjs';

test('a successful process without executed tests does not become evidence', () => {
  assert.equal(measuredOutcome(0, 'ready').status, 'FAIL');
  assert.equal(measuredOutcome(0, '').status, 'FAIL');
});
test('exit status and measured test count must both establish completion', () => {
  assert.deepEqual(measuredOutcome(0, 'Tests  42 passed (42)'), { status: 'PASS', assertionsExecuted: 42 });
  assert.equal(measuredOutcome(1, 'Tests  42 passed (42)').status, 'FAIL');
  assert.equal(measuredOutcome(null, '# tests 4').status, 'FAIL');
});
test('unit results never silently close empirical release gates', () => {
  assert.equal(measurementReport([{ status: 'PASS', assertionsExecuted: 400 }]).releaseReady, false);
  assert.match(measurementReport([]).empiricalGates, /^OPEN/u);
});
