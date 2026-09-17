'use client';

import { useEffect, useState } from 'react';
import type { JevyrClient } from '@jevyr/sdk';

const METRICS = [
  ['defectRecall', 'Critical-defect recall', true], ['falseAccusations', 'False accusations', true],
  ['unprovenRate', 'UNPROVEN rate', true], ['reproducibility', 'Reproducibility', true],
  ['coverage', 'Coverage', true], ['wallMillis', 'Wall time · ms', false], ['tokens', 'Tokens', false],
  ['laneCorrelation', 'Lane correlation', false], ['marginalEvidenceValue', 'Marginal evidence per cost unit', false],
] as const;
type Metric = { value: number | null; interval95: readonly [number, number] | null; observations: number; method: string; reason: string | null };
type Benchmark = { digest: string; corpusDigest: string; pairedKeys: number; trialCount: number; pareto: readonly string[]; limitations: readonly string[]; results: readonly { configurationDigest: string; metrics: Record<string, Metric> }[]; selected: string; presetDigest: string; name: string };
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
function object(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function benchmarkFrom(value: unknown): Benchmark | undefined {
  const descriptor = object(value); const preset = object(descriptor?.preset); const signed = object(descriptor?.benchmark); const report = object(signed?.report);
  if (!preset && !signed) return undefined;
  const configuration = object(preset?.configuration);
  if (descriptor?.protocol !== 'jevyr.preset-startup-selection/1' || report?.protocol !== 'jevyr.genome-benchmark/2' || !preset || !configuration
    || typeof preset.name !== 'string' || !digestPattern.test(String(preset.digest)) || preset.benchmarkDigest !== report.digest || preset.corpusDigest !== report.corpusDigest
    || !digestPattern.test(String(report.digest)) || !digestPattern.test(String(report.corpusDigest)) || !digestPattern.test(String(configuration.configurationDigest))
    || !Number.isSafeInteger(report.pairedKeys) || Number(report.pairedKeys) < 1 || !Array.isArray(report.trials) || report.trials.length > 65_536
    || !Array.isArray(report.results) || report.results.length < 1 || report.results.length > 256 || !Array.isArray(report.pareto) || !report.pareto.every(item => typeof item === 'string' && digestPattern.test(item))
    || !Array.isArray(report.limitations) || !report.limitations.every(item => typeof item === 'string')) throw new Error('The selected preset has no readable, bound paired benchmark.');
  const results = report.results.map(raw => {
    const entry = object(raw); const metrics = object(entry?.metrics);
    if (!entry || !digestPattern.test(String(entry.configurationDigest)) || !metrics) throw new Error('A paired configuration is incomplete.');
    for (const [key] of METRICS) {
      const metric = object(metrics[key]);
      if (!metric || metric.value !== null && (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) || !Number.isSafeInteger(metric.observations) || Number(metric.observations) < 0
        || !['descriptive-rate', 'descriptive-mean', 'unmeasured'].includes(String(metric.method)) || metric.reason !== null && typeof metric.reason !== 'string'
        || metric.interval95 !== null && (!Array.isArray(metric.interval95) || metric.interval95.length !== 2 || !metric.interval95.every(item => typeof item === 'number' && Number.isFinite(item)) || metric.interval95[0] > metric.interval95[1])) throw new Error('A benchmark metric or confidence interval is invalid.');
    }
    return { configurationDigest: String(entry.configurationDigest), metrics: metrics as Record<string, Metric> };
  });
  if (!results.some(entry => entry.configurationDigest === configuration.configurationDigest)) throw new Error('The selected configuration is absent from its benchmark.');
  return { digest: String(report.digest), corpusDigest: String(report.corpusDigest), pairedKeys: Number(report.pairedKeys), trialCount: report.trials.length, pareto: report.pareto as string[], limitations: report.limitations as string[], results, selected: String(configuration.configurationDigest), presetDigest: String(preset.digest), name: preset.name };
}
function numeric(value: number, percentage: boolean): string { return percentage ? `${(value * 100).toFixed(1)}%` : value.toLocaleString(undefined, { maximumFractionDigits: 3 }); }
function MetricCell({ metric, percentage }: { metric: Metric; percentage: boolean }) {
  return <td style={{ verticalAlign: 'top', padding: '0.7rem', minWidth: '10rem' }}>
    <strong>{metric.value === null ? 'Unmeasured' : numeric(metric.value, percentage)}</strong>
    {metric.interval95 && <div>95% interval: {numeric(metric.interval95[0], percentage)}–{numeric(metric.interval95[1], percentage)}</div>}
    <div className="muted">{metric.observations} observations · {metric.method.replaceAll('-', ' ')}</div>
    {metric.reason && <div className="muted">{metric.reason}</div>}
  </td>;
}

export function GenomeLab({ client }: { client: JevyrClient }) {
  const [report, setReport] = useState<Awaited<ReturnType<JevyrClient['genomeLab']>>>();
  const [benchmark, setBenchmark] = useState<Benchmark>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setError(''); setReport(undefined); setBenchmark(undefined);
    void client.genomeLab(controller.signal).then(value => {
      const measured = benchmarkFrom(value.preset?.descriptor);
      if (!controller.signal.aborted) { setReport(value); setBenchmark(measured); }
    }).catch((failure: unknown) => {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Genome registry could not be read.');
    });
    return () => controller.abort();
  }, [client]);

  if (error) return <section className="record-workspace" role="alert"><h2>Genome Lab is unavailable</h2><p>{error}</p></section>;
  if (!report) return <section className="record-workspace" aria-busy="true"><h2>Genome Lab</h2><p>Reading the bound Genome and proposed offspring…</p></section>;

  return <section className="record-workspace" aria-label="Genome Lab">
    <div className="section-label">Genome Lab / read only</div>
    <h2>The strategy bound to this runtime</h2>
    <dl className="verdict-facts">
      <div><dt>Version</dt><dd>{report.active.version}</dd></div>
      <div><dt>Source</dt><dd>{report.active.source.replaceAll('-', ' ')}</dd></div>
      <div><dt>Genome digest</dt><dd><code>{report.active.digest}</code></dd></div>
      <div><dt>Startup selection</dt><dd><code>{report.active.selectionDigest}</code></dd></div>
      <div><dt>Preset mode</dt><dd>{report.preset?.mode === 'preset' ? benchmark?.name ?? 'Signed preset' : 'Wild'}</dd></div>
    </dl>
    <p>The daemon keeps this Genome for its entire startup. A selection made now takes effect at the next startup.</p>
    <p><a href="/airlock">Open Airlock</a> to choose Wild immediately for a new draft, while keeping this startup Genome.</p>
    {report.preset?.mode !== 'preset' && <p>Wild removes preset restrictions. The active Genome, project limits, and constitutional rules still apply. Wild does not imply better performance.</p>}
    {benchmark ? <section aria-labelledby="paired-benchmark-title">
      <h3 id="paired-benchmark-title">Paired benchmark · {benchmark.name}</h3>
      <p>{benchmark.pairedKeys} matched case-and-seed groups · {benchmark.trialCount} recorded runs · {benchmark.results.length} configurations. The daemon verified the signed benchmark and preset when it started.</p>
      <p>Pareto candidates have no measured competitor that is at least as good on every compared metric and better on one. Membership describes this finite comparison; it is not a guarantee of quality on other tasks.</p>
      <div style={{ overflowX: 'auto' }} tabIndex={0} role="region" aria-label="Paired benchmark metrics, horizontally scrollable">
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <caption style={{ textAlign: 'left', padding: '0.5rem 0' }}>Descriptive fixture rates and means with recorded sample counts. Repeated fixtures do not support population confidence intervals.</caption>
          <thead><tr><th scope="col" style={{ textAlign: 'left', padding: '0.7rem' }}>Metric</th>{benchmark.results.map((entry, index) => <th scope="col" key={entry.configurationDigest} style={{ textAlign: 'left', padding: '0.7rem' }}>
            Configuration {index + 1}<div><code title={entry.configurationDigest}>{entry.configurationDigest.slice(-12)}</code></div>
            <div>{entry.configurationDigest === benchmark.selected ? 'Selected · ' : ''}{benchmark.pareto.includes(entry.configurationDigest) ? 'Pareto member' : METRICS.some(([key]) => entry.metrics[key]!.value === null) ? 'Comparison incomplete' : 'Dominated in this comparison'}</div>
          </th>)}</tr></thead>
          <tbody>{METRICS.map(([key, label, percentage]) => <tr key={key}><th scope="row" style={{ textAlign: 'left', verticalAlign: 'top', padding: '0.7rem' }}>{label}</th>{benchmark.results.map(entry => <MetricCell key={entry.configurationDigest} metric={entry.metrics[key]!} percentage={percentage} />)}</tr>)}</tbody>
        </table>
      </div>
      {benchmark.limitations.length > 0 && <aside aria-label="Benchmark limitations"><h4>Measured scope and limitations</h4><ul>{benchmark.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul></aside>}
      <details><summary>Benchmark provenance</summary><dl className="verdict-facts"><div><dt>Corpus</dt><dd><code>{benchmark.corpusDigest}</code></dd></div><div><dt>Benchmark</dt><dd><code>{benchmark.digest}</code></dd></div><div><dt>Preset</dt><dd><code>{benchmark.presetDigest}</code></dd></div></dl></details>
    </section> : <p className="muted">No signed preset benchmark is selected. This view has no paired metrics or Pareto ranking to display.</p>}
    <details><summary>Change the next startup through the CLI</summary><p>Selection cannot alter a running Case. A preset must already exist in the local signed registry.</p><pre className="source-text">{`${benchmark ? `jevyr preset use ${benchmark.presetDigest}\n` : 'jevyr preset use PRESET_DIGEST\n'}jevyr preset wild\njevyr benchmark compare --file SIGNED_BENCHMARK.json`}</pre><p>Creating a preset requires a verified paired benchmark and an explicit governance signing-key reference.</p></details>
    <details><summary>Bound strategy and preset descriptors</summary><pre className="source-text">{JSON.stringify({ genome: report.active.descriptor, preset: report.preset?.descriptor ?? null }, null, 2)}</pre></details>
    <h3>Repository self-judgment · {report.selfJudgmentRequests?.length ?? 0} failure intakes</h3>
    <p className="muted">Only reproduced failures from authenticated self Cases can create these requests. The intake is content addressed; it is not a governance signature. No source or active Genome is changed.</p>
    {(report.selfJudgmentRequests ?? []).map(request => <article className="evidence-entry" key={request.digest}>
      <div className="entry-heading"><code>{request.source.caseId}</code><span>{request.decision.replaceAll('_', ' ')}</span></div>
      <p>{request.proposedChange}</p>
      <p>Candidate: <code>{request.candidateGenomeDigest}</code></p>
      <p>{request.parentGenomeDigest ? 'A descendant remains rejected until its benchmark and governance requirements are met.' : 'The static baseline has no governed parent. This candidate remains a quarantined request.'}</p>
      <details><summary>Bound source Record and reproduced failures</summary><pre className="source-text">{JSON.stringify(request, null, 2)}</pre></details>
    </article>)}
    <h3>Proposed offspring · {report.offspring.length}</h3>
    {report.offspring.length === 0 && <p className="muted">No offspring have been recorded in this registry.</p>}
    {report.offspring.map(offspring => <article className="evidence-entry" key={offspring.proposalDigest}>
      <div className="entry-heading"><code>{offspring.genomeDigest}</code><span>{offspring.decision}</span></div>
      <p>Parent: <code>{offspring.parentDigest}</code></p>
      {offspring.reasons.map((reason, index) => <p key={index}>{reason}</p>)}
      <h4>Recorded governance comparisons</h4>
      {offspring.benchmarkEvidence.length === 0 ? <p className="muted">No benchmark evidence recorded.</p> : <div style={{ overflowX: 'auto' }}><table><thead><tr><th scope="col">Suite</th><th scope="col">Invariant</th><th scope="col">Parent</th><th scope="col">Offspring</th><th scope="col">Result</th><th scope="col">Evidence</th></tr></thead><tbody>{offspring.benchmarkEvidence.map((entry, index) => <tr key={`${entry.evidenceDigest}:${index}`}><td>{entry.suite}{entry.heldOut ? ' · held out' : ''}</td><td>{String(entry.invariant)}</td><td>{entry.parentScore}</td><td>{entry.score}</td><td>{entry.passed ? 'Passed' : 'Failed'}</td><td><code>{entry.evidenceDigest}</code></td></tr>)}</tbody></table></div>}
      <details><summary>Proposal and damage evidence</summary><pre className="source-text">{JSON.stringify(offspring, null, 2)}</pre></details>
    </article>)}
    {report.truncated && <p className="muted">This response is bounded; older proposals remain in the local registry.</p>}
    <p className="muted">This view cannot promote or edit a Genome. Offspring require benchmark evidence and a governance signature before a later startup can select them.</p>
  </section>;
}
