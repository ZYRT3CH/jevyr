'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  type ArtifactMeta,
  type AuthenticatedTerminalRecord,
  type JevyrClient,
  type VerifiedArtifact,
} from '@jevyr/sdk';
import type { JevyrPublicEvent } from './jevyr-substrate';
import { CouchMode } from './couch-mode';
import { ArtifactVisual } from './visual-artifact';
import { couchState } from '@/lib/couch-state';
import { GenomeLab } from './genome-lab';
import { deriveEventMorphology } from '@/lib/event-morphology';
import {
  artifactTitle,
  executionPreview,
  extractBlueprintFiles,
} from '@/lib/artifact-preview';

export interface CastOptions {
  mode: 'auto' | 'audit' | 'design';
  privacy: 'local_only' | 'provider_scoped' | 'full_case';
  subjects: {
    id: string;
    kind: 'directory' | 'file' | 'git' | 'url' | 'text';
    locator: string;
  }[];
  constraints: string[];
}

type Tab =
  | 'observe'
  | 'candidates'
  | 'experiments'
  | 'artifacts'
  | 'ledger'
  | 'record'
  | 'anatomy';
type Model = ReturnType<typeof deriveEventMorphology>;
export interface Props {
  client: JevyrClient;
  impulse: string;
  onImpulse: (value: string) => void;
  sealed: boolean;
  specimen: boolean;
  caseId: string | null;
  cast: (impulse: string, options: CastOptions) => Promise<unknown>;
  events: JevyrPublicEvent[];
  model: Model;
  liveCursor: number;
  focusSequence?: number;
  onFocus: (sequence: number | undefined) => void;
  stage: string;
  transport: string;
  authenticity: string;
  notice: string;
  outcome?: AuthenticatedTerminalRecord;
  anatomy: ReactNode;
}

export function shortDigest(value?: string | null) {
  return value ? value.replace(/^sha256:/, '').slice(0, 14) : 'Not available';
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : 'The request could not be completed.';
}

export function readableBytes(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function Json({ value }: { value: unknown }) {
  return <pre className="source-text">{JSON.stringify(value, null, 2)}</pre>;
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function Readiness({ client }: { client: JevyrClient }) {
  const [report, setReport] =
    useState<Awaited<ReturnType<JevyrClient['readiness']>>>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await client.readiness(controller.signal);
        if (!controller.signal.aborted) {
          setReport(next);
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 10000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client]);
  return (
    <section className="readiness" aria-label="Runtime readiness">
      <div className="section-label">01 / Capacity</div>
      <h2>
        {error
          ? 'Runtime unavailable'
          : !report
            ? 'Reading the runtime…'
            : report.ready
              ? 'Ready to work'
              : 'Capacity is incomplete'}
      </h2>
      <p className="muted">
        Checked before you seal. A configured model is not proof of a successful
        inference.
      </p>
      {error && <output className="warning">{error}</output>}
      {report && (
        <>
          <dl className="readiness-facts">
            <div>
              <dt>Reasoning</dt>
              <dd>{report.models.mode.replaceAll('-', ' ')}</dd>
            </div>
            <div>
              <dt>Forge</dt>
              <dd>{report.forge.status}</dd>
            </div>
            <div>
              <dt>Sealed assays</dt>
              <dd>
                {report.assays.count} · {report.assays.status}
              </dd>
            </div>
          </dl>
          <ul className="plain-list">
            {report.blockers.map((blocker) => (
              <li key={`${blocker.component}:${blocker.code}`}>
                <strong>{blocker.component}</strong>
                <p>{blocker.detail}</p>
              </li>
            ))}
          </ul>
          <details>
            <summary>Runtime details</summary>
            <Json value={report} />
          </details>
        </>
      )}
    </section>
  );
}

function Cast({
  client,
  impulse,
  onImpulse,
  cast,
}: Pick<Props, 'client' | 'impulse' | 'onImpulse' | 'cast'>) {
  const [mode, setMode] = useState<CastOptions['mode']>('auto');
  const [privacy, setPrivacy] = useState<CastOptions['privacy']>('local_only');
  const [subjectKind, setSubjectKind] =
    useState<CastOptions['subjects'][number]['kind']>('directory');
  const [locator, setLocator] = useState('');
  const [subjects, setSubjects] = useState<CastOptions['subjects']>([]);
  const [constraints, setConstraints] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [recent, setRecent] = useState<string[]>([]);
  const [caseLocator, setCaseLocator] = useState('');
  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      try {
        const stored: unknown = JSON.parse(
          localStorage.getItem('jevyr.recent-case-ids') ?? '[]',
        );
        if (Array.isArray(stored))
          setRecent(
            stored
              .filter((id): id is string => typeof id === 'string')
              .slice(0, 8),
          );
      } catch {
        /* Storage is optional; no case content is persisted here. */
      }
    });
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <div className="cast-layout">
      <section className="cast-editor">
        <div className="section-label">One input. An independent outcome.</div>
        <h1>
          What should
          <br />
          Jevyr confront?
        </h1>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError('');
            void cast(impulse, {
              mode,
              privacy,
              subjects,
              constraints: constraints
                .split('\n')
                .map((value) => value.trim())
                .filter(Boolean),
            }).catch((failure: unknown) => {
              setError(errorMessage(failure));
              setPending(false);
            });
          }}
        >
          <label htmlFor="jevyr-impulse">The task</label>
          <textarea
            id="jevyr-impulse"
            value={impulse}
            onChange={(event) => onImpulse(event.target.value)}
            maxLength={4000}
            rows={5}
            required
            placeholder="An idea to make real. A thing to take apart. Describe what matters and what would count as evidence."
          />
          <fieldset className="mode-selector">
            <legend>Direction</legend>
            {(
              [
                ['auto', 'Let the task decide'],
                ['design', 'Create + test'],
                ['audit', 'Examine + judge'],
              ] as const
            ).map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <details className="cast-materials">
            <summary>
              Attach subjects & constraints{' '}
              <span>
                {subjects.length ? `${subjects.length} attached` : 'Optional'}
              </span>
            </summary>
            <p className="muted">
              Local paths refer to the daemon’s machine. Subjects are captured
              at Seal, not read continuously.
            </p>
            <div className="subject-entry">
              <label>
                Kind
                <select
                  aria-label="Subject kind"
                  value={subjectKind}
                  onChange={(event) =>
                    setSubjectKind(event.target.value as typeof subjectKind)
                  }
                >
                  <option value="directory">Local folder</option>
                  <option value="file">Local file</option>
                  <option value="git">Git repository</option>
                  <option value="url">URL</option>
                  <option value="text">Text</option>
                </select>
              </label>
              <label>
                Location or text
                <input
                  value={locator}
                  onChange={(event) => setLocator(event.target.value)}
                  placeholder={
                    subjectKind === 'directory'
                      ? 'C:\\project or /path/to/project'
                      : 'Subject locator or text'
                  }
                />
              </label>
              <button
                type="button"
                disabled={!locator.trim()}
                onClick={() => {
                  setSubjects((current) => [
                    ...current,
                    {
                      id: `subject_${crypto.randomUUID()}`,
                      kind: subjectKind,
                      locator: locator.trim(),
                    },
                  ]);
                  setLocator('');
                }}
              >
                Attach
              </button>
            </div>
            <ul className="subject-list">
              {subjects.map((subject) => (
                <li key={subject.id}>
                  <span>
                    <small>{subject.kind}</small>
                    {subject.locator}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${subject.locator}`}
                    onClick={() =>
                      setSubjects((current) =>
                        current.filter((item) => item.id !== subject.id),
                      )
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <label htmlFor="constraints">Constraints · one per line</label>
            <textarea
              id="constraints"
              rows={3}
              value={constraints}
              onChange={(event) => setConstraints(event.target.value)}
              placeholder="Boundaries that must survive testing."
            />
          </details>
          <label className="privacy-label" htmlFor="privacy">
            Where may the case be processed?
          </label>
          <select
            id="privacy"
            value={privacy}
            onChange={(event) =>
              setPrivacy(event.target.value as typeof privacy)
            }
          >
            <option value="local_only">
              Local only · no provider-network models
            </option>
            <option value="provider_scoped">
              Configured providers · scoped disclosure
            </option>
            <option value="full_case">
              Configured providers · full case disclosure
            </option>
          </select>
          <div className="seal-foot">
            <p>
              After Seal, there is no follow-up prompt.
              <br />
              Observation cannot change the task.
            </p>
            <button
              type="submit"
              className="primary-action"
              disabled={!impulse.trim() || pending}
            >
              {pending ? 'Sealing…' : 'Seal the case ↗'}
            </button>
          </div>
          {error && (
            <p role="alert" className="warning">
              {error}
            </p>
          )}
        </form>
      </section>
      <aside className="cast-aside">
        <Readiness client={client} />
        <section className="case-library">
          <div className="section-label">02 / Return to a case</div>
          <p>Reopening is read-only. A new task needs a new seal.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (caseLocator.trim())
                window.location.assign(
                  `/?case=${encodeURIComponent(caseLocator.trim())}`,
                );
            }}
          >
            <label htmlFor="case-locator">Case identifier</label>
            <div className="inline-form">
              <input
                id="case-locator"
                value={caseLocator}
                onChange={(event) => setCaseLocator(event.target.value)}
                required
                placeholder="case_…"
              />
              <button type="submit">Open</button>
            </div>
          </form>
          {recent.length > 0 && (
            <ul className="plain-list">
              {recent.map((id) => (
                <li key={id}>
                  <a href={`/?case=${encodeURIComponent(id)}`}>{id}</a>
                </li>
              ))}
            </ul>
          )}
          <details className="connection-help">
            <summary>Use the command line</summary>
            <p className="muted">From your Jevyr workspace:</p>
            <pre className="source-text">
              {
                'pnpm jevyr up\npnpm jevyr doctor\npnpm jevyr cast "Your task"\npnpm jevyr watch CASE_ID\npnpm jevyr replay CASE_ID'
              }
            </pre>
            <p className="muted">
              The CLI and Chamber observe the same daemon. Closing this browser
              does not interrupt a sealed case.
            </p>
          </details>
        </section>
      </aside>
    </div>
  );
}

function ArtifactInspector({
  client,
  caseId,
  terminal,
  expectedIndex,
}: {
  client: JevyrClient;
  caseId: string | null;
  terminal: boolean;
  expectedIndex?: string;
}) {
  const [artifacts, setArtifacts] = useState<readonly ArtifactMeta[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [verified, setVerified] = useState<VerifiedArtifact>();
  const [error, setError] = useState('');
  const [indexError, setIndexError] = useState('');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState('');
  const [indexAuthenticated, setIndexAuthenticated] = useState(false);
  const [artifactView, setArtifactView] = useState<'visual' | 'source'>('visual');
  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const index = await client.artifactList(caseId, controller.signal);
        if (expectedIndex) {
          const canonical = (value: unknown): string =>
            value === null || typeof value !== 'object'
              ? JSON.stringify(value)
              : Array.isArray(value)
                ? `[${value.map(canonical).join(',')}]`
                : `{${Object.keys(value)
                    .sort()
                    .map(
                      (key) =>
                        `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
                    )
                    .join(',')}}`;
          const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(canonical(index)),
          );
          const actual = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
          if (actual !== expectedIndex)
            throw new Error(
              'Artifact index does not match the authenticated terminal closure.',
            );
        }
        if (!controller.signal.aborted) {
          setArtifacts((current) =>
            JSON.stringify(current) === JSON.stringify(index.artifacts)
              ? current
              : index.artifacts,
          );
          setIndexAuthenticated(Boolean(expectedIndex));
          setIndexError('');
          setSelectedId(current => current || index.artifacts.find(item => item.name.startsWith('candidate-blueprint-'))?.id || index.artifacts[0]?.id || '');
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setIndexError(errorMessage(failure));
          setIndexAuthenticated(false);
        }
      } finally {
        if (!terminal && !controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 3000);
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [client, caseId, terminal, expectedIndex]);
  useEffect(() => {
    if (!caseId || !selectedId) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setVerified(undefined);
      setFile('');
      setArtifactView('visual');
      setLoading(true);
    });
    void client
      .fetchArtifact(caseId, selectedId, controller.signal)
      .then((artifact) => {
        const indexed = artifacts.find((item) => item.id === selectedId);
        if (
          !indexed ||
          indexed.digest !== artifact.meta.digest ||
          indexed.size !== artifact.meta.size ||
          indexed.name !== artifact.meta.name
        )
          throw new Error(
            'Artifact metadata changed since the displayed index.',
          );
        if (!controller.signal.aborted) {
          setVerified(artifact);
          setError('');
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, caseId, selectedId, artifacts]);
  const content = useMemo(() => {
    if (
      !verified ||
      !/json|text|javascript|xml|yaml|svg/.test(verified.meta.mediaType)
    )
      return null;
    const decoded = new TextDecoder().decode(verified.data);
    try {
      return { text: decoded, json: JSON.parse(decoded) as unknown };
    } catch {
      return { text: decoded, json: undefined };
    }
  }, [verified]);
  const files = useMemo(() => extractBlueprintFiles(content?.json), [content]);
  const effectiveFile = file || files[0]?.path || '__artifact__';
  const source = files.find((entry) => entry.path === effectiveFile);
  const execution = executionPreview(content?.json);
  const download = () => {
    if (!verified) return;
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(verified.data)], {
        type: 'application/octet-stream',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download =
      verified.meta.name.split(/[\\/]/).at(-1) || 'jevyr-artifact';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="artifact-browser">
      <div className="artifact-list">
        <label htmlFor="artifact-filter">Artifacts · {artifacts.length}</label>
        <input
          id="artifact-filter"
          placeholder="Filter filenames"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <ul>
          {[...artifacts]
            .sort(
              (left, right) =>
                Number(right.name.startsWith('candidate-blueprint')) -
                  Number(left.name.startsWith('candidate-blueprint')) ||
                left.name.localeCompare(right.name),
            )
            .filter((entry) =>
              entry.name.toLowerCase().includes(filter.toLowerCase()),
            )
            .map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  aria-pressed={selectedId === entry.id}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <span>{artifactTitle(entry.name)}</span>
                  <small>{readableBytes(entry.size)}</small>
                </button>
              </li>
            ))}
        </ul>
        {!artifacts.length && (
          <p className="muted">
            {caseId
              ? 'No persisted artifacts have arrived.'
              : 'Specimen only. No real files exist.'}
          </p>
        )}
      </div>
      <div className="artifact-preview">
        {indexError && (
          <p role="alert" className="warning">
            {indexError}
          </p>
        )}
        {error && (
          <p role="alert" className="warning">
            {error}
          </p>
        )}
        {loading && <output>Retrieving and verifying bytes…</output>}
        {verified ? (
          <>
            <header className="preview-heading">
              <div>
                <h3>{artifactTitle(verified.meta.name)}</h3>
                <p className="muted">
                  SHA-256 verified
                  {indexAuthenticated
                    ? ' · index authenticated'
                    : ' · live index, not terminal-authenticated'}
                </p>
              </div>
              <button type="button" onClick={download}>
                Download verified file ↓
              </button>
            </header>
            <code className="full-digest">{verified.meta.digest}</code>
            <details>
              <summary>Exact filename & metadata</summary>
              <Json value={verified.meta} />
            </details>
            {files.length > 0 && (
              <label className="file-selector">
                Blueprint files
                <select
                  aria-label="Blueprint file"
                  value={effectiveFile}
                  onChange={(event) => setFile(event.target.value)}
                >
                  <option value="__artifact__">Full artifact</option>
                  {files.map((entry) => (
                    <option key={entry.path} value={entry.path}>
                      {entry.path}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <fieldset className="visual-artifact-switch" aria-label="Artifact view">
              <button type="button" aria-pressed={artifactView === 'visual'} onClick={() => setArtifactView('visual')}>Visual preview</button>
              <button type="button" aria-pressed={artifactView === 'source'} onClick={() => setArtifactView('source')}>Source & output</button>
            </fieldset>
            {artifactView === 'visual' && caseId ? (
              <ArtifactVisual key={`${verified.meta.digest}:${effectiveFile}`} client={client} caseId={caseId} artifact={verified} source={source ?? (content && /\.(?:html?|svg)$/i.test(verified.meta.name) ? { path: verified.meta.name, content: content.text } : undefined)} index={artifacts} />
            ) : source ? (
              <>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([source.content], {
                        type: 'application/octet-stream',
                      }),
                    );
                    const link = document.createElement('a');
                    link.href = url;
                    link.download =
                      source.path.split(/[\\/]/).at(-1) || 'source.txt';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  Download source file ↓
                </button>
                <pre className="source-text">
                  {source.content.slice(0, 200000)}
                </pre>
              </>
            ) : execution ? (
              <div className="execution-preview">
                <h3>Executed command</h3>
                <code>{execution.command}</code>
                <p>
                  Exit code: {execution.exitCode ?? 'Not reported'} ·{' '}
                  {execution.truncated
                    ? 'Output may be incomplete'
                    : 'Capture complete'}
                </p>
                <h3>Standard output</h3>
                <pre className="source-text">
                  {execution.stdout === undefined
                    ? 'Capture unavailable or not valid UTF-8.'
                    : execution.stdout || '(empty)'}
                </pre>
                <h3>Standard error</h3>
                <pre className="source-text">
                  {execution.stderr === undefined
                    ? 'Capture unavailable or not valid UTF-8.'
                    : execution.stderr || '(empty)'}
                </pre>
                <details>
                  <summary>Complete execution artifact</summary>
                  <Json value={content?.json} />
                </details>
              </div>
            ) : content ? (
              <pre className="source-text">
                {(content.json
                  ? JSON.stringify(content.json, null, 2)
                  : content.text
                ).slice(0, 200000)}
              </pre>
            ) : (
              <p>Binary artifact. Download it to inspect locally.</p>
            )}
            <p className="muted">
              Verified artifacts only. Source code is never executed by the Chamber.
              Static document previews are limited to 200,000 characters.
            </p>
          </>
        ) : (
          !loading && (
            <Empty title="Inspect what actually exists">
              Select an artifact to verify its bytes, read its contents, or
              download it. Claims of a file are not files.
            </Empty>
          )
        )}
      </div>
    </section>
  );
}

function Observation({
  props,
  onTab,
}: {
  props: Props;
  onTab: (tab: Tab) => void;
}) {
  const { events, model, outcome } = props;
  const [now, setNow] = useState<number>();
  const ended = props.transport === 'ended';
  useEffect(() => {
    if (ended) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ended]);
  const last = events.at(-1);
  const at = last?.observedAt ? Date.parse(last.observedAt) : NaN;
  const silenceSeconds =
    now !== undefined && Number.isFinite(at)
      ? Math.max(0, Math.floor((now - at) / 1000))
      : undefined;
  const phases = [
    { label: 'Seal', stages: ['cast', 'snapshot', 'seal'] },
    { label: 'Interpret', stages: ['self_scan', 'interpret'] },
    { label: 'Create', stages: ['diverge', 'recombine'] },
    { label: 'Execute', stages: ['embody', 'challenge'] },
    { label: 'Judge', stages: ['assay', 'reflex'] },
    {
      label: 'Close',
      stages: ['crystallize', 'sign', 'memory_tribunal', 'terminate'],
    },
  ];
  const phase = phases.findIndex((item) =>
    item.stages.includes(last?.stage?.toLowerCase() ?? ''),
  );
  const embodied = model.candidates.filter((candidate) =>
    candidate.statusHistory.some((moment) => moment.status === 'embodied'),
  );
  const meters = model.resourcePressure.resources.filter((resource) =>
    [
      'mindInvocations',
      'inputTokens',
      'outputTokens',
      'forgeWallMillis',
    ].includes(resource.name),
  );
  return (
    <section className="observation-workspace">
      <ol className="phase-line" aria-label="Observed lifecycle">
        {phases.map((item, index) => (
          <li
            key={item.label}
            data-state={
              index < phase || (ended && !couchState(model, events, props.transport, outcome).interrupted)
                ? 'visited'
                : index === phase
                  ? 'current'
                  : 'unobserved'
            }
          >
            <span>{String(index + 1).padStart(2, '0')}</span>
            {item.label}
          </li>
        ))}
      </ol>
      <div className="observation-columns">
        <div className="activity-column">
          <div className="section-label">
            {ended ? 'Final public activity' : 'Happening now'}
          </div>
          <h2>
            {ended
              ? couchState(model, events, props.transport, outcome).interrupted
                ? 'Run interrupted before judgment'
                : outcome
                ? `Judgment: ${outcome.payload.verdict.judgment}`
                : 'The stream has closed.'
              : (last?.summary ?? 'Waiting for the daemon’s first event.')}
          </h2>
          <p className="muted">
            {ended
              ? couchState(model, events, props.transport, outcome).interrupted
                ? 'This run was interrupted. Its saved ideas remain available, but it did not complete its judgment. A new run requires a new case.'
                : 'This run has ended. It will not generate further events. Start a new case for a new task.'
              : `Updates arrive automatically over ${props.transport === 'polling' ? 'cursor-based long polling' : 'the live event stream'}. ${silenceSeconds === undefined ? '' : `Last public event ${silenceSeconds}s ago.`} No new event means no new public observation—not invented progress.`}
          </p>
          {outcome && (
            <div className="outcome-strip">
              <div>
                <small>Creation</small>
                <strong>{outcome.payload.verdict.creation}</strong>
              </div>
              <div>
                <small>Embodiment</small>
                <strong>{outcome.payload.verdict.embodiment}</strong>
              </div>
              <button type="button" onClick={() => onTab('record')}>
                Read the basis →
              </button>
            </div>
          )}
          <div className="activity-title">
            <h3>{ended ? 'How it ended' : 'Live activity'}</h3>
            <button type="button" onClick={() => onTab('ledger')}>
              Full ledger · {events.length} →
            </button>
          </div>
          <ol className="activity-feed" aria-label="Latest public events">
            {events
              .slice(-12)
              .reverse()
              .map((event) => (
                <li key={event.sequence}>
                  <button
                    type="button"
                    onClick={() => {
                      props.onFocus(event.sequence);
                      onTab('ledger');
                    }}
                  >
                    <code>{String(event.sequence).padStart(4, '0')}</code>
                    <div>
                      <small>
                        {event.actor?.id ?? event.stage} · {event.kind}
                      </small>
                      <p>{event.summary}</p>
                    </div>
                  </button>
                </li>
              ))}
          </ol>
        </div>
        <aside className="work-column">
          <div className="section-label">Concrete work</div>
          <div className="work-count">
            <span>{embodied.length}</span>
            <div>
              candidates executed
              <small>{model.candidates.length} publicly proposed</small>
            </div>
          </div>
          <button
            type="button"
            className="wide-action"
            onClick={() => onTab('artifacts')}
          >
            Open generated files & execution output ↗
          </button>
          <h3>Experiments</h3>
          {model.assays.length === 0 ? (
            <p className="muted">
              {ended
                ? 'No assay was recorded. This is not a pass.'
                : 'No result yet. Experiments appear when the runtime publishes them.'}
            </p>
          ) : (
            model.assays.map((assay) => (
              <article className="experiment-summary" key={assay.id}>
                <span data-outcome={assay.status}>{assay.status}</span>
                <p>{assay.summary}</p>
                <button
                  type="button"
                  className="text-action"
                  onClick={() => {
                    props.onFocus(assay.lastSequence);
                    onTab('experiments');
                  }}
                >
                  Inspect evidence →
                </button>
              </article>
            ))
          )}
          <h3>Measured work</h3>
          <dl className="work-meters">
            {meters.map((meter) => (
              <div key={meter.name}>
                <dt>
                  {
                    (
                      {
                        mindInvocations: 'Model calls',
                        inputTokens: 'Input tokens',
                        outputTokens: 'Output tokens',
                        forgeWallMillis: 'Sandbox time (ms)',
                      } as Record<string, string>
                    )[meter.name]
                  }
                </dt>
                <dd>
                  {meter.used?.toLocaleString() ?? 'Not reported'}
                  <small>
                    {meter.measurement.replaceAll('_', ' ').toLowerCase()}
                  </small>
                </dd>
              </div>
            ))}
          </dl>
          <p className="muted">
            Resource use describes effort, not intelligence or quality.
          </p>
          <button
            type="button"
            className="wide-action"
            onClick={() => onTab('anatomy')}
          >
            See the trace’s visual anatomy ↗
          </button>
        </aside>
      </div>
    </section>
  );
}

export function ChamberWorkspace(props: Props) {
  const { client, sealed, caseId, events, model, outcome } = props;
  const [tab, setTab] = useState<Tab>('observe');
  const [view, setView] = useState<'couch' | 'inspect'>('couch');
  const [candidateId, setCandidateId] = useState('');
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const readableState = couchState(model, events, props.transport, outcome, props.focusSequence !== undefined);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') !== 'inspect') return;
    let disposed = false;
    queueMicrotask(() => { if (!disposed) setView('inspect'); });
    return () => { disposed = true; };
  }, []);
  const [genomeLab, setGenomeLab] = useState(false);
  useEffect(() => {
    if (!caseId) return;
    window.history.replaceState(
      null,
      '',
      `/?case=${encodeURIComponent(caseId)}`,
    );
    try {
      const old: unknown = JSON.parse(
        localStorage.getItem('jevyr.recent-case-ids') ?? '[]',
      );
      localStorage.setItem(
        'jevyr.recent-case-ids',
        JSON.stringify(
          [
            caseId,
            ...(Array.isArray(old)
              ? old.filter((id) => typeof id === 'string' && id !== caseId)
              : []),
          ].slice(0, 12),
        ),
      );
    } catch {
      /* Private browsing and storage failures do not affect the observer. */
    }
  }, [caseId]);
  const orderedCandidates = [...model.candidates].sort(
    (left, right) =>
      Number(
        right.statusHistory.some((moment) => moment.status === 'embodied'),
      ) -
      Number(left.statusHistory.some((moment) => moment.status === 'embodied')),
  );
  const selected =
    orderedCandidates.find((candidate) => candidate.id === candidateId) ??
    orderedCandidates[0];
  const candidateEvents = events.filter(
    (event) =>
      event.sequence <= model.cursor &&
      selected &&
      JSON.stringify(event.payload ?? '').includes(selected.id),
  );
  const inspectedEvent =
    props.focusSequence === undefined
      ? undefined
      : events.find((event) => event.sequence === props.focusSequence);
  return (
    <main className="chamber-workspace">
      <header className="workspace-header">
        <button
          type="button"
          className="wordmark"
          onClick={() => window.location.assign('/')}
          aria-label="Jevyr — new case"
        >
          <img className="wordmark-mark" src="/jevyr-mark.svg" alt="" aria-hidden="true" />
          <span className="wordmark-name">JEVYR</span>
          <span className="wordmark-slash" aria-hidden="true">/</span>
        </button>
        <div className="header-identity">
          <span>
            {!sealed
              ? 'The independent chamber'
              : (caseId ??
                (props.specimen ? 'ANATOMY SPECIMEN' : 'CAST UNCONFIRMED'))}
          </span>
          {sealed && (
            <small>
              {caseId
                ? 'Sealed · observation only'
                : props.specimen
                  ? 'Illustrative events · no execution or proof'
                  : 'Acknowledgement unavailable · no automatic resubmission'}
            </small>
          )}
        </div>
        <div className="header-actions">
          {!sealed && <a href="/connections">Connections</a>}
          {sealed && <fieldset className="workspace-view-switch" aria-label="Viewing mode">
            <button type="button" aria-pressed={view === 'couch'} onClick={() => setView('couch')}>Couch</button>
            <button type="button" aria-pressed={view === 'inspect'} onClick={() => setView('inspect')}>Inspect</button>
          </fieldset>}
          <button type="button" aria-pressed={genomeLab} onClick={() => setGenomeLab(!genomeLab)}>{genomeLab ? 'Return to case' : 'Genome Lab'}</button>
          {caseId && (
            <button
              type="button"
              onClick={() =>
                void navigator.clipboard
                  .writeText(window.location.href)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }
            >
              {copied ? 'Link copied' : 'Copy case link'}
            </button>
          )}
          {sealed && (
            <button type="button" onClick={() => window.location.assign('/')}>
              New case ↗
            </button>
          )}
        </div>
      </header>
      {genomeLab ? <GenomeLab client={client} /> : !sealed ? (
        <Cast
          client={client}
          impulse={props.impulse}
          onImpulse={props.onImpulse}
          cast={props.cast}
        />
      ) : view === 'couch' ? (
        <CouchMode key={caseId ?? 'specimen'} workspace={props} inspect={(next = 'candidates') => { setTab(next); setView('inspect'); }} />
      ) : (
        <>
          <section className="case-present">
            <div>
              <div className="section-label">
                {props.focusSequence === undefined
                  ? 'Current state'
                  : `Replay / event ${props.focusSequence}`}
              </div>
              <h1>
                {readableState.interrupted ? 'Run interrupted' : props.transport === 'ended'
                  ? outcome
                    ? outcome.payload.verdict.selectedCandidateId
                      ? 'Case complete'
                      : 'No candidate selected'
                    : props.specimen
                      ? 'Specimen complete'
                      : 'Verifying the outcome'
                  : props.stage}
              </h1>
              <p>
                {model.candidates.length
                  ? `${model.candidates.length} candidates · ${model.assays.length} experiments · ${model.evidence.length} evidence records`
                  : 'Waiting for the first inspectable work.'}
              </p>
            </div>
            <div className="case-status">
              <span className="transport-state" data-mode={props.transport}>
                {props.transport === 'ended'
                  ? 'Stream closed'
                  : props.transport}
              </span>
              <span>{props.authenticity}</span>
              <span>Observed through {props.liveCursor}</span>
              {props.focusSequence !== undefined && (
                <button type="button" onClick={() => props.onFocus(undefined)}>
                  Return to live →
                </button>
              )}
            </div>
          </section>
          <output className="observer-notice">{props.notice}</output>
          {props.impulse && (
            <details className="frozen-task">
              <summary>Sealed task</summary>
              <p>{props.impulse}</p>
            </details>
          )}
          <nav className="workspace-tabs" aria-label="Case inspection">
            {(
              [
                ['observe', 'Observe'],
                ['candidates', 'Candidates'],
                ['experiments', 'Experiments & evidence'],
                ['artifacts', 'Files'],
                ['ledger', 'Live ledger'],
                ['record', 'Outcome'],
                ['anatomy', 'Anatomy'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={tab === id ? 'page' : undefined}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="workspace-content">
            {tab === 'observe' && <Observation props={props} onTab={setTab} />}
            {tab === 'candidates' && (
              <section className="candidate-workspace">
                <aside className="candidate-index">
                  <div className="section-label">
                    Public proposals / {model.candidates.length}
                  </div>
                  {orderedCandidates.map((candidate, index) => (
                    <button
                      type="button"
                      className="candidate-row"
                      key={candidate.id}
                      aria-pressed={selected?.id === candidate.id}
                      onClick={() => setCandidateId(candidate.id)}
                    >
                      <span className="candidate-ordinal">
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <span>
                        <strong>
                          {(candidate.statusHistory[0]?.summary ?? candidate.id)
                            .replace(/\s*\[.*$/, '')
                            .slice(0, 110)}
                        </strong>
                        <small>
                          {candidate.currentStatus} · generation{' '}
                          {candidate.generation ?? 'undisclosed'}
                        </small>
                      </span>
                    </button>
                  ))}
                  {!model.candidates.length && (
                    <p className="muted">
                      No candidate has been publicly proposed.
                    </p>
                  )}
                </aside>
                <div className="candidate-detail">
                  {selected ? (
                    <>
                      <div className="section-label">
                        {selected.currentStatus} /{' '}
                        {selected.feasibility
                          ? `Reported ${selected.feasibility}`
                          : 'Feasibility not established'}
                      </div>
                      <h2>
                        {selected.statusHistory.find((moment) => moment.summary)
                          ?.summary ?? selected.id}
                      </h2>
                      <dl className="candidate-facts">
                        <div>
                          <dt>Parents</dt>
                          <dd>
                            {selected.parentIds.join(', ') ||
                              (selected.parentDisclosure === 'declared'
                                ? 'Declared root'
                                : 'Not disclosed')}
                          </dd>
                        </div>
                        <div>
                          <dt>Assays</dt>
                          <dd>{selected.assayIds.length}</dd>
                        </div>
                        <div>
                          <dt>Artifact references</dt>
                          <dd>{selected.artifactDigests.length}</dd>
                        </div>
                      </dl>
                      <p className="muted">
                        A model proposal is not proof of feasibility. The
                        experiment and evidence records carry separate
                        authority.
                      </p>
                      <h3>What changed</h3>
                      <ol className="history-list">
                        {selected.statusHistory.map((moment) => (
                          <li key={`${moment.sequence}:${moment.status}`}>
                            <button
                              type="button"
                              onClick={() => {
                                props.onFocus(moment.sequence);
                                setTab('ledger');
                              }}
                            >
                              #{moment.sequence}
                            </button>
                            <div>
                              <strong>{moment.status}</strong>
                              <p>{moment.summary}</p>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <h3>Published candidate material</h3>
                      {candidateEvents.map((event) => (
                        <details key={event.sequence}>
                          <summary>
                            #{event.sequence} · {event.kind}
                          </summary>
                          <Json value={event.payload} />
                        </details>
                      ))}
                      <button
                        className="text-action"
                        type="button"
                        onClick={() => setTab('artifacts')}
                      >
                        Inspect persisted files →
                      </button>
                    </>
                  ) : (
                    <Empty title="No imagined progress">
                      Proposals will appear here with their genealogy, state
                      changes, and artifact references as the runtime publishes
                      them.
                    </Empty>
                  )}
                </div>
              </section>
            )}
            {tab === 'experiments' && (
              <section className="evidence-workspace">
                <div>
                  <div className="section-label">
                    Sealed obligations / {model.obligations.length}
                  </div>
                  {model.obligations.map((obligation) => (
                    <article className="evidence-entry" key={obligation.id}>
                      <div className="entry-heading">
                        <code>{obligation.id}</code>
                        <span data-outcome={obligation.resolution}>
                          {obligation.resolution}
                        </span>
                      </div>
                      <p>
                        {obligation.statement ??
                          'The statement has not been disclosed in the public trace.'}
                      </p>
                      <small>
                        {obligation.critical ? 'Critical' : 'Non-critical'} ·{' '}
                        {obligation.assayIds.length} linked assays
                      </small>
                    </article>
                  ))}
                  {!model.obligations.length && (
                    <p className="muted">No public obligation records yet.</p>
                  )}
                  <h2>Experiments</h2>
                  {model.assays.map((assay) => (
                    <article className="evidence-entry" key={assay.id}>
                      <div className="entry-heading">
                        <code>{assay.id}</code>
                        <span data-outcome={assay.status}>{assay.status}</span>
                      </div>
                      <p>{assay.summary}</p>
                      <small>
                        Candidate {assay.candidateId ?? 'not attributed'} ·{' '}
                        {assay.evidenceIds.length} evidence links
                      </small>
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => {
                          props.onFocus(assay.lastSequence);
                          setTab('ledger');
                        }}
                      >
                        Inspect event #{assay.lastSequence} →
                      </button>
                    </article>
                  ))}
                  {!model.assays.length && (
                    <Empty title="No experiment recorded">
                      An empty assay list does not mean the case passed. See the
                      Outcome for any blocked or inconclusive result.
                    </Empty>
                  )}
                </div>
                <div>
                  <div className="section-label">
                    Evidence / {model.evidence.length}
                  </div>
                  {model.evidence.map((evidence) => (
                    <article className="evidence-entry" key={evidence.id}>
                      <div className="entry-heading">
                        <code>{evidence.id}</code>
                        <span>{evidence.authority.replaceAll('_', ' ')}</span>
                      </div>
                      <p>{evidence.summary}</p>
                      <small>
                        Supports {evidence.supports.length} · refutes{' '}
                        {evidence.refutes.length}
                      </small>
                      <details>
                        <summary>Provenance & relationships</summary>
                        <Json value={evidence} />
                      </details>
                    </article>
                  ))}
                  {!model.evidence.length && (
                    <Empty title="Evidence is still absent">
                      Model reports, sandbox observations, and inspected
                      artifacts will be distinguished here. They are not
                      interchangeable.
                    </Empty>
                  )}
                </div>
              </section>
            )}
            {tab === 'artifacts' && (
              <ArtifactInspector
                client={client}
                caseId={caseId}
                terminal={props.transport === 'ended'}
                expectedIndex={outcome?.terminal.payload.artifactIndexDigest}
              />
            )}
            {tab === 'ledger' && (
              <section className="ledger-workspace">
                <div>
                  <label htmlFor="event-filter">
                    Public ledger · {events.length} accepted events
                  </label>
                  <input
                    id="event-filter"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Filter kind, stage, or summary"
                  />
                  <ol className="ledger-list">
                    {events
                      .filter((event) =>
                        `${event.kind} ${event.stage} ${event.summary}`
                          .toLowerCase()
                          .includes(query.toLowerCase()),
                      )
                      .slice()
                      .reverse()
                      .map((event) => (
                        <li key={event.sequence}>
                          <button
                            type="button"
                            aria-pressed={
                              props.focusSequence === event.sequence
                            }
                            onClick={() => props.onFocus(event.sequence)}
                          >
                            <code>
                              {String(event.sequence).padStart(4, '0')}
                            </code>
                            <span>
                              <strong>{event.kind}</strong>
                              <small>{event.summary}</small>
                            </span>
                            <span>{event.stage}</span>
                          </button>
                        </li>
                      ))}
                  </ol>
                </div>
                <aside className="event-inspector">
                  {inspectedEvent ? (
                    <>
                      <div className="section-label">
                        Exact public event / {inspectedEvent.sequence}
                      </div>
                      <h2>{inspectedEvent.kind}</h2>
                      <p>{inspectedEvent.summary}</p>
                      <Json value={inspectedEvent} />
                    </>
                  ) : (
                    <Empty title="Inspect an event">
                      Select an entry to replay the case at that cursor. The
                      live observer keeps running; replay never sends input.
                    </Empty>
                  )}
                </aside>
              </section>
            )}
            {tab === 'record' && (
              <section className="record-workspace">
                {outcome ? (
                  <>
                    <div className="section-label">
                      Authenticated terminal record
                    </div>
                    <h2>
                      {outcome.payload.verdict.judgment.replaceAll('_', ' ')}
                    </h2>
                    <p>
                      Selected candidate:{' '}
                      <code>
                        {outcome.payload.verdict.selectedCandidateId ?? 'None'}
                      </code>
                    </p>
                    <dl className="verdict-facts">
                      {(
                        [
                          'integrity',
                          'creation',
                          'embodiment',
                          'judgment',
                        ] as const
                      ).map((key) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{outcome.payload.verdict[key]}</dd>
                        </div>
                      ))}
                    </dl>
                    <h3>Basis</h3>
                    {outcome.payload.verdict.basis.map((basis, index) => (
                      <article
                        className="verdict-basis"
                        key={`${basis.code}:${index}`}
                      >
                        <small>{basis.code.replaceAll('_', ' ')}</small>
                        <p>{basis.summary}</p>
                        <details>
                          <summary>Evidence & obligation references</summary>
                          <Json value={basis} />
                        </details>
                      </article>
                    ))}
                    <h3>Reflex</h3>
                    <p>
                      Pass {outcome.payload.reflex.loop} ·{' '}
                      {outcome.payload.reflex.decision.replaceAll('_', ' ')}
                    </p>
                    {outcome.payload.reflex.materialFindings.length ? (
                      outcome.payload.reflex.materialFindings.map(
                        (finding, index) => (
                          <article
                            className="verdict-basis"
                            key={`${finding.code}:${index}`}
                          >
                            <small>{finding.code.replaceAll('_', ' ')}</small>
                            <p>{finding.summary}</p>
                          </article>
                        ),
                      )
                    ) : (
                      <p className="muted">
                        No material findings were recorded.
                      </p>
                    )}
                    <details>
                      <summary>Exact Reflex report</summary>
                      <Json value={outcome.payload.reflex} />
                    </details>
                    <details>
                      <summary>
                        Complete signed Record & verification scope
                      </summary>
                      <Json value={outcome} />
                    </details>
                    <p className="muted">
                      Authenticated against the daemon’s advertised key and
                      exact ledger closure. Persisted evidence has not been
                      independently replayed by this browser. Signature validity
                      is not a guarantee that a design works.
                    </p>
                  </>
                ) : (
                  <Empty
                    title={
                      props.authenticity.includes('refused')
                        ? 'Authentication refused'
                        : 'No authenticated outcome yet'
                    }
                  >
                    {caseId
                      ? 'Only a Record bound to the verified Seal, complete ledger, and terminal artifact index can appear here. Transport completion alone is not approval.'
                      : 'The specimen has no signed Record and cannot approve anything.'}
                  </Empty>
                )}
                <section className="resource-register">
                  <h3>Observed resources</h3>
                  <p className="muted">
                    Missing meters remain missing. Attempt count is not a
                    quality score.
                  </p>
                  <dl>
                    {model.resourcePressure.resources.map((resource) => (
                      <div key={resource.name}>
                        <dt>{resource.name}</dt>
                        <dd>
                          {resource.used?.toLocaleString() ?? 'Unmetered'} /{' '}
                          {resource.ceiling?.toLocaleString() ?? 'Unknown'}{' '}
                          <small>{resource.measurement}</small>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </section>
            )}
            {tab === 'anatomy' && (
              <section className="anatomy-view">
                <div className="anatomy-caption">
                  <h2>The shape of the trace</h2>
                  <p>
                    Candidate lineage, evidence, and resource pressure derived
                    from the selected event cursor. This is a projection, not an
                    image of a mind.
                  </p>
                </div>
                <div className="anatomy-canvas">{props.anatomy}</div>
              </section>
            )}
          </div>
          <footer className="workspace-footer">
            <span>Watching changes nothing.</span>
            <code>{shortDigest(model.continuity.headDigest)}</code>
            <span>{model.continuity.state} · public trace</span>
          </footer>
        </>
      )}
    </main>
  );
}
