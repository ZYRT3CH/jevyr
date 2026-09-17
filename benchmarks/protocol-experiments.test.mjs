import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTapChecks, parseVitestChecks } from './protocol-experiments.mjs';

test('a skipped or differently named TAP assertion cannot close the requested check', () => {
  const expected = [{ name: 'actual boundary', gates: ['boundary'], assertions: ['rejection observed'] }];
  assert.equal(parseTapChecks('ok 1 - actual boundary # SKIP\n', expected)[0].status, 'MISSING');
  assert.equal(parseTapChecks('ok 1 - a different boundary\n', expected)[0].status, 'MISSING');
  assert.equal(parseTapChecks('not ok 1 - actual boundary\n', expected)[0].status, 'FAIL');
  assert.equal(parseTapChecks('ok 1 - actual boundary\n', expected)[0].status, 'PASS');
});

test('Vitest must report an executed exact assertion rather than an aggregate success count', () => {
  const expected = [{ name: 'privacy scope' }];
  const document = (status) => JSON.stringify({ testResults: [{ assertionResults: [{ title: 'privacy scope', status }] }] });
  assert.equal(parseVitestChecks(document('passed'), expected)[0].status, 'PASS');
  assert.equal(parseVitestChecks(document('pending'), expected)[0].status, 'MISSING');
  assert.equal(parseVitestChecks('100 tests passed', expected)[0].status, 'MISSING');
});
