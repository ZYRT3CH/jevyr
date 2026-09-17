import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { verifyBrowserEvidence } from './verify-browser-proof.mjs';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
function fixture({ editReport = () => {}, editObservation = () => {}, editInput = () => {} } = {}) {
  const artifacts = [], artifactBytes = new Map();
  const add = (name, mediaType, value) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const digest = sha(bytes), id = `artifact_${digest.slice(7, 31)}`;
    const meta = { id, name, mediaType, size: bytes.length, digest };
    artifacts.push(meta); artifactBytes.set(id, bytes); return meta;
  };
  const source = 'document.querySelector("p").textContent="2";';
  const html = '<p>0</p><script src="counter.js"></script>';
  const files = [{ path: 'index.html', content: html }, { path: 'counter.js', content: source }]
    .map(file => ({ ...file, digest: sha(file.content), byteLength: Buffer.byteLength(file.content) }));
  const blueprintDigest = sha('fixture-blueprint');
  add('candidate-blueprint.json', 'application/vnd.jevyr.candidate-blueprint+json', { protocol: 'jevyr.candidate-blueprint/1', blueprintDigest, files });
  const png = add('jevyr.browser.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const trace = add('jevyr.browser.trace.zip', 'application/octet-stream', Buffer.from([80, 75, 3, 4, 0]));
  const spec = { protocol: 'jevyr.browser-probe/1', entry: 'index.html', steps: [{ action: 'assert-text', selector: 'p', expected: '1' }] };
  const args = ['/opt/jevyr/browser-probe.mjs', Buffer.from(JSON.stringify(spec)).toString('base64url')];
  const report = { protocol: 'jevyr.browser-observation/1', specDigest: sha(JSON.stringify(spec)), passed: false, assertionsPassed: false,
    evidenceComplete: true, coverageComplete: true, runtimeComplete: true, collectionFailures: [], attributionIsCausation: false,
    artifacts: [trace, png].map(meta => ({ path: meta.name, digest: meta.digest, bytes: meta.size })),
    sources: files.map(file => ({ path: file.path, sourceDigest: file.digest, byteLength: file.byteLength })),
    runtime: [{ scriptId: '1', url: 'counter.js', scriptDigest: sha(source), sourceText: source, sourceComplete: true,
      sourceByteLength: Buffer.byteLength(source), source: { path: 'counter.js', sourceDigest: sha(source) }, functions: [{ name: '', ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }] },
      { scriptId: '2', url: 'anonymous', scriptDigest: sha('42'), sourceText: '42', sourceComplete: true, sourceByteLength: 2, functions: [] }],
    events: [{ index: 0, action: 'assert-text', selector: 'p', expected: '1', observed: '2', status: 'failed', failure: 'text mismatch' }] };
  editReport(report);
  const reportMeta = add('jevyr.browser.observation.json', 'application/json', report);
  const stdout = Buffer.from(JSON.stringify({ passed: report.passed, evidenceComplete: report.evidenceComplete, reportDigest: reportMeta.digest, steps: report.events.length, scripts: report.runtime.length }));
  const refs = [trace.id, png.id, reportMeta.id];
  const observation = { invocationId: 'invocation_browser', artifactRefs: refs,
    metadata: { planBoundAtSeal: true, executionAuthorityStatus: 'VERIFIED', admissible: true, aggregateAdmissible: true, candidateId: 'candidate_browser',
      candidateBlueprintDigest: blueprintDigest, assayId: 'browser.sealed', artifactReceipt: { protocol: 'jevyr.forge-artifact-receipt/1', invocationId: 'invocation_browser', artifactRefs: refs } },
    oracle: { execution: { mode: 'docker', state: 'exited', shell: false, command: 'node', args, exitCode: report.passed ? 0 : 1, outputTruncated: false,
      substrate: { contentAddressed: true, inspectedBeforeExecution: true, startupResolvedImageId: sha('immutable-image'), executionImageId: sha('immutable-image') },
      stdoutCapture: { complete: true, encoding: 'base64', data: stdout.toString('base64'), byteLength: stdout.length, observedByteLength: stdout.length, digest: sha(stdout) } },
      workspace: { complete: true, entries: [...files.map(({ content, ...file }) => ({ ...file, kind: 'file' })), ...[trace, png, reportMeta].map(meta => ({ path: meta.name, kind: 'file', digest: meta.digest, byteLength: meta.size }))] } } };
  editObservation(observation);
  const observationMeta = add('tool-observation.json', 'application/vnd.jevyr.tool-observation+json', observation);
  const input = { artifactIndex: { protocol: 'jevyr.artifacts/1', artifacts }, artifactBytes,
    events: [{ kind: 'evidence.observed', payload: { evidenceType: 'sandbox_execution', contentDigest: observationMeta.digest, candidateId: observation.metadata.candidateId } }],
    policyDescriptor: { artifact: { descriptor: { policy: { assayFrontier: { assays: [{ assayId: 'browser.sealed', tool: 'forge.command', args: { command: 'node', args }, obligationId: 'critical' }] } } } } },
    intentContract: { criticalObligations: [{ id: 'critical', critical: true, oracle: { kind: 'command_exit_code', operand: ['node', ...args].join(' '), operator: 'equals', expected: '0' } }] } };
  editInput(input); return input;
}

test('browser gate follows exact source, runtime, report and invocation links without asserting causation', () => {
  const result = verifyBrowserEvidence(fixture());
  assert.equal(result.valid, true, result.problems.join('; '));
  assert.deepEqual(result.observations[0].executedSourcePaths, ['counter.js']);
  assert.equal(result.observations[0].failedActions[0].observed, '2');
  assert.equal(result.attributionIsCausation, false);
  assert.equal(result.signatureVerification, 'required-separately-via-verifyLocalProof');
});

test('browser gate rejects changed bytes even when a report still claims complete evidence', () => {
  const input = fixture();
  const trace = input.artifactIndex.artifacts.find(meta => meta.name.endsWith('.zip'));
  input.artifactBytes.set(trace.id, Buffer.from('replacement'));
  const result = verifyBrowserEvidence(input);
  assert.equal(result.valid, false); assert.match(result.problems.join('; '), /Artifact bytes differ/);
});

test('browser gate independently rejects internally forged report claims with recomputed outer digests', () => {
  const mutations = [
    report => { delete report.evidenceComplete; },
    report => { report.collectionFailures.push({ phase: 'trace', message: 'failed' }); },
    report => { delete report.events[0].observed; },
    report => { report.events[0].status = 'passed'; },
    report => { report.runtime[0].sourceText = 'altered'; },
    report => { report.runtime[1].scriptDigest = sha('fake anonymous source'); },
    report => { report.runtime[0].functions[0].ranges[0].endOffset = 100000; },
    report => { report.runtime[0].functions[0].ranges[0].count = 0; },
    report => { report.sources[0].sourceDigest = sha('unrelated candidate'); },
    report => { report.sources[0].path = '../outside'; },
    report => { report.attributionIsCausation = true; },
    report => { report.artifacts[0].digest = sha('unrelated trace'); },
  ];
  for (const editReport of mutations) assert.equal(verifyBrowserEvidence(fixture({ editReport })).valid, false, String(editReport));
});

test('browser gate rejects invocation, sealed-spec, candidate and authority substitutions', () => {
  const mutations = [
    observation => { observation.metadata.artifactReceipt.invocationId = 'other'; },
    observation => { observation.metadata.candidateBlueprintDigest = sha('unrelated'); },
    observation => { observation.metadata.executionAuthorityStatus = 'UNVERIFIED'; },
    observation => { observation.oracle.execution.substrate.executionImageId = sha('retagged'); },
    observation => { observation.oracle.execution.stdoutCapture.data = Buffer.from('{}').toString('base64'); },
  ];
  for (const editObservation of mutations) assert.equal(verifyBrowserEvidence(fixture({ editObservation })).valid, false, String(editObservation));
  assert.equal(verifyBrowserEvidence(fixture({ editInput: input => { input.events[0].payload.evidenceType = 'model_report'; } })).valid, false);
  assert.equal(verifyBrowserEvidence(fixture({ editInput: input => { input.intentContract.criticalObligations[0].oracle.expected = '1'; } })).valid, false);
});
