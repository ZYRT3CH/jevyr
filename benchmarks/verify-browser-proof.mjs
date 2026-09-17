import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const fail = message => { throw new Error(message); };
const requireThat = (condition, message) => { if (!condition) fail(message); };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const utf8 = bytes => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
const decodeJson = bytes => JSON.parse(utf8(bytes));
const exactJson = bytes => {
  const text = utf8(bytes), value = JSON.parse(text);
  requireThat(JSON.stringify(value) === text, 'Artifact JSON is ambiguous or not an exact serialized object');
  return value;
};
const pathIsSafe = path => typeof path === 'string' && path.length <= 4096 && !path.includes('\\')
  && path.split('/').every(part => part && part !== '.' && part !== '..' && !part.includes(':'));

/** Additional evidence gate only. The caller must first verifyLocalProof against its trust policy. */
export function verifyBrowserEvidence({ artifactIndex, artifactBytes, events, policyDescriptor, intentContract }) {
  const observations = [], problems = [];
  try {
    requireThat(artifactIndex?.protocol === 'jevyr.artifacts/1' && Array.isArray(artifactIndex.artifacts) && artifactIndex.artifacts.length <= 4096, 'Invalid artifact index');
    const metadata = new Map(), json = new Map();
    for (const meta of artifactIndex.artifacts) {
      requireThat(/^artifact_[a-f0-9]{24}$/.test(meta.id) && !metadata.has(meta.id), 'Invalid or duplicate artifact ID');
      const bytes = artifactBytes.get(meta.id);
      requireThat(Buffer.isBuffer(bytes) && bytes.length === meta.size && sha(bytes) === meta.digest, `Artifact bytes differ: ${meta.id}`);
      metadata.set(meta.id, meta);
      if (meta.name === 'jevyr.browser.observation.json' || meta.mediaType === 'application/vnd.jevyr.tool-observation+json'
        || meta.mediaType === 'application/vnd.jevyr.candidate-blueprint+json') json.set(meta.id, exactJson(bytes));
    }
    const reports = artifactIndex.artifacts.filter(meta => meta.name === 'jevyr.browser.observation.json');
    requireThat(reports.length > 0, 'No browser observation artifact');
    for (const reportMeta of reports) {
      try {
        const report = json.get(reportMeta.id);
        requireThat(report.protocol === 'jevyr.browser-observation/1' && report.evidenceComplete === true && report.coverageComplete === true
          && report.runtimeComplete === true && Array.isArray(report.collectionFailures) && report.collectionFailures.length === 0, 'Browser capture is incomplete');
        requireThat(typeof report.passed === 'boolean' && report.assertionsPassed === report.passed && report.attributionIsCausation === false, 'Browser outcome or attribution scope is invalid');
        const associated = artifactIndex.artifacts.filter(meta => meta.mediaType === 'application/vnd.jevyr.tool-observation+json')
          .map(meta => ({ meta, value: json.get(meta.id) }))
          .filter(({ value }) => value?.artifactRefs?.includes(reportMeta.id));
        requireThat(associated.length === 1, 'Browser report lacks one exact Forge observation binding');
        const { meta: observationMeta, value: observation } = associated[0];
        const execution = observation.oracle?.execution, workspace = observation.oracle?.workspace;
        requireThat(execution?.mode === 'docker' && execution.state === 'exited' && execution.shell === false && execution.command === 'node'
          && execution.args?.length === 2 && execution.args[0] === '/opt/jevyr/browser-probe.mjs'
          && execution.exitCode === (report.passed ? 0 : 1) && execution.outputTruncated === false, 'Browser report lacks an exact completed immutable runner execution');
        requireThat(execution.substrate?.contentAddressed === true && execution.substrate.inspectedBeforeExecution === true
          && execution.substrate.startupResolvedImageId === execution.substrate.executionImageId, 'Browser image identity is unbound');
        requireThat(observation.metadata?.planBoundAtSeal === true && observation.metadata.executionAuthorityStatus === 'VERIFIED'
          && observation.metadata.admissible === true && observation.metadata.aggregateAdmissible === true, 'Browser execution was not admitted by Bone');
        requireThat(events.some(event => event.kind === 'evidence.observed' && event.payload.evidenceType === 'sandbox_execution'
          && event.payload.contentDigest === observationMeta.digest && event.payload.candidateId === observation.metadata.candidateId), 'Browser observation has no matching sandbox evidence event');
        const receipt = observation.metadata.artifactReceipt;
        requireThat(receipt?.protocol === 'jevyr.forge-artifact-receipt/1' && receipt.invocationId === observation.invocationId
          && same(receipt.artifactRefs, observation.artifactRefs), 'Browser artifact receipt is not invocation-bound');
        const plan = policyDescriptor?.artifact?.descriptor?.policy?.assayFrontier?.assays?.find(plan => plan.assayId === observation.metadata.assayId);
        requireThat(plan?.tool === 'forge.command' && plan.args.command === execution.command && same(plan.args.args, execution.args), 'Browser specification differs from its sealed assay');
        const obligation = intentContract?.criticalObligations?.find(item => item.id === plan.obligationId);
        requireThat(obligation?.critical === true && obligation.oracle?.kind === 'command_exit_code' && obligation.oracle.operator === 'equals'
          && obligation.oracle.expected === '0' && obligation.oracle.operand === [execution.command, ...execution.args].join(' '), 'Browser assay lacks its exact sealed critical obligation');
        const specBytes = Buffer.from(execution.args[1], 'base64url');
        requireThat(specBytes.toString('base64url') === execution.args[1] && sha(specBytes) === report.specDigest, 'Browser specification digest mismatch');
        const spec = exactJson(specBytes);
        requireThat(spec.protocol === 'jevyr.browser-probe/1' && Array.isArray(spec.steps) && spec.steps.length > 0 && spec.steps.length <= 64, 'Invalid finite browser specification');
        const capture = execution.stdoutCapture;
        const output = Buffer.from(capture?.data ?? '', 'base64');
        requireThat(capture?.complete === true && capture.encoding === 'base64' && capture.byteLength === output.length
          && capture.observedByteLength === output.length && sha(output) === capture.digest && output.toString('base64') === capture.data, 'Browser stdout is not exact');
        const summary = exactJson(output);
        requireThat(summary.reportDigest === reportMeta.digest && summary.passed === report.passed && summary.evidenceComplete === true, 'Browser stdout does not bind its complete report');
        const entries = workspace?.entries;
        requireThat(workspace?.complete === true && Array.isArray(entries), 'Browser workspace manifest is incomplete');
        const workspaceFile = (path, digest, byteLength) => entries.some(entry => entry.path === path && entry.kind === 'file' && entry.digest === digest && entry.byteLength === byteLength);
        requireThat(workspaceFile(reportMeta.name, reportMeta.digest, reportMeta.size), 'Browser report differs from its final workspace');
        requireThat(Array.isArray(report.artifacts) && report.artifacts.length === 2
          && new Set(report.artifacts.map(item => item.path)).size === 2, 'Missing browser trace or screenshot reference');
        for (const item of report.artifacts) {
          requireThat(['jevyr.browser.trace.zip', 'jevyr.browser.png'].includes(item.path), 'Unexpected browser capture path');
          const linked = observation.artifactRefs.map(id => metadata.get(id)).filter(meta => meta?.name === item.path && meta.digest === item.digest && meta.size === item.bytes);
          requireThat(linked.length === 1 && workspaceFile(item.path, item.digest, item.bytes), 'Browser trace/screenshot lacks exact invocation and workspace bytes');
          const bytes = artifactBytes.get(linked[0].id);
          requireThat(item.path.endsWith('.zip') ? bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
            : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Browser trace/screenshot format is not recognizable');
        }
        const blueprint = [...json.values()].find(value => value?.protocol === 'jevyr.candidate-blueprint/1'
          && value.blueprintDigest === observation.metadata.candidateBlueprintDigest);
        requireThat(Array.isArray(blueprint?.files), 'Browser candidate source blueprint is absent');
        const served = new Map();
        requireThat(Array.isArray(report.sources) && report.sources.length > 0, 'Browser served sources are absent');
        for (const source of report.sources) {
          requireThat(pathIsSafe(source.path) && !served.has(source.path), 'Ambiguous browser source path');
          const file = blueprint.files.find(file => file.path === source.path);
          requireThat(file && file.digest === source.sourceDigest && file.byteLength === source.byteLength
            && typeof file.content === 'string' && sha(file.content) === file.digest && Buffer.byteLength(file.content) === file.byteLength
            && workspaceFile(file.path, file.digest, file.byteLength), 'Served browser source differs from candidate or final workspace');
          served.set(source.path, source);
        }
        requireThat(served.has(spec.entry), 'Browser entry is not a bound served source');
        const executedSourcePaths = new Set();
        requireThat(Array.isArray(report.runtime) && report.runtime.length > 0 && report.runtime.length <= 128 && summary.scripts === report.runtime.length, 'Browser runtime coverage is absent or unbounded');
        let sourceBytes = 0;
        for (const script of report.runtime) {
          requireThat(script.sourceComplete === true && typeof script.sourceText === 'string' && Buffer.byteLength(script.sourceText) === script.sourceByteLength
            && script.sourceByteLength <= 524288 && sha(script.sourceText) === script.scriptDigest, 'Browser runtime script bytes differ or are omitted');
          sourceBytes += script.sourceByteLength;
          requireThat(sourceBytes <= 2097152 && Array.isArray(script.functions) && script.functions.length <= 1024, 'Browser runtime source budget exceeded');
          for (const fn of script.functions) requireThat(Array.isArray(fn.ranges) && fn.ranges.length <= 1024 && fn.ranges.every(range =>
            Number.isSafeInteger(range.startOffset) && Number.isSafeInteger(range.endOffset) && range.startOffset >= 0 && range.endOffset >= range.startOffset
            && range.endOffset <= script.sourceText.length && Number.isSafeInteger(range.count) && range.count >= 0), 'Invalid browser runtime source range');
          if (script.source !== undefined) {
            requireThat(script.url === script.source.path && served.get(script.source.path)?.sourceDigest === script.source.sourceDigest, 'Runtime script lacks its served-source link');
            if (script.functions.some(fn => fn.ranges.some(range => range.count > 0))) executedSourcePaths.add(script.source.path);
          } else requireThat(script.url === 'anonymous', 'Named runtime script lacks a source link');
        }
        requireThat(executedSourcePaths.size > 0, 'No executed runtime range links to a candidate source');
        requireThat(Array.isArray(report.events) && summary.steps === report.events.length, 'Browser action summary differs');
        const actions = report.events.filter(event => Number.isSafeInteger(event.index));
        requireThat(actions.length > 0 && actions.length <= spec.steps.length, 'Browser actions are absent or excessive');
        for (const [index, event] of actions.entries()) {
          const step = spec.steps[index];
          requireThat(event.index === index && event.action === step.action && event.selector === step.selector
            && (event.status === 'passed' || event.status === 'failed') && (index === actions.length - 1 || event.status === 'passed'), 'Browser action order differs from sealed steps');
          if (step.action.startsWith('assert-')) {
            requireThat(event.expected === step.expected && Object.hasOwn(event, 'observed'), 'Browser assertion lacks expected and actual observations');
            requireThat(event.status === (event.observedTruncated === true || event.observed !== step.expected ? 'failed' : 'passed'), 'Browser assertion outcome differs from observation');
          }
        }
        requireThat(report.passed ? actions.length === spec.steps.length && actions.every(event => event.status === 'passed')
          : actions.at(-1).status === 'failed', 'Browser overall outcome differs from its action trace');
        observations.push({ reportDigest: reportMeta.digest, observationDigest: observationMeta.digest, candidateId: observation.metadata.candidateId,
          assayId: observation.metadata.assayId, assertionsPassed: report.passed, evidenceComplete: true, executedSourcePaths: [...executedSourcePaths],
          failedActions: actions.filter(event => event.status === 'failed'), attributionIsCausation: false });
      } catch (error) { problems.push(`${reportMeta.id}: ${error.message}`); }
    }
  } catch (error) { problems.push(error.message); }
  return { protocol: 'jevyr.browser-proof-verification/1', valid: problems.length === 0 && observations.length > 0,
    signatureVerification: 'required-separately-via-verifyLocalProof', observations, problems, attributionIsCausation: false };
}

async function boundedRead(path, maximum = 64 * 1048576) {
  const before = await lstat(path);
  requireThat(before.isFile() && !before.isSymbolicLink() && before.size <= maximum, 'Proof file is not a bounded regular file');
  const bytes = await readFile(path), after = await lstat(path);
  requireThat(before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && bytes.length === before.size, 'Proof file changed while read');
  return bytes;
}

export async function verifyBrowserProof(proofDirectory) {
  try {
    const root = resolve(proofDirectory);
    requireThat(await realpath(root) === root && await realpath(join(root, 'artifacts')) === join(root, 'artifacts'), 'Proof root follows a link');
    const artifactIndex = decodeJson(await boundedRead(join(root, 'artifact-index.json')));
    requireThat(Array.isArray(artifactIndex.artifacts) && artifactIndex.artifacts.length <= 4096, 'Invalid artifact index');
    const artifactBytes = new Map(); let total = 0;
    for (const meta of artifactIndex.artifacts) {
      requireThat(/^artifact_[a-f0-9]{24}$/.test(meta.id), 'Unsafe artifact ID');
      const bytes = await boundedRead(join(root, 'artifacts', `${meta.id}.blob`));
      total += bytes.length; requireThat(total <= 128 * 1048576, 'Proof artifact budget exceeded'); artifactBytes.set(meta.id, bytes);
    }
    return verifyBrowserEvidence({ artifactIndex, artifactBytes, events: decodeJson(await boundedRead(join(root, 'events.json'))),
      policyDescriptor: decodeJson(await boundedRead(join(root, 'policy-descriptor.json'))), intentContract: decodeJson(await boundedRead(join(root, 'intent-contract.json'))) });
  } catch (error) { return { protocol: 'jevyr.browser-proof-verification/1', valid: false, signatureVerification: 'required-separately-via-verifyLocalProof', observations: [], problems: [error.message], attributionIsCausation: false }; }
}
