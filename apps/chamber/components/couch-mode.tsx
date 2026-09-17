'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Props as WorkspaceProps } from './chamber-workspace';
import { JevyrSubstrate } from './jevyr-substrate';
import { CandidateArtifact } from './visual-artifact';
import {
  canonicalJson,
  couchState,
  ideaTitle,
  jsonObject,
  publicIdeaText,
  textDigest,
  type PublicIdeaText,
} from '@/lib/couch-state';

type Props = {
  workspace: WorkspaceProps;
  inspect: (tab?: 'candidates' | 'artifacts' | 'ledger' | 'record') => void;
};

export function CouchMode({ workspace: p, inspect }: Props) {
  const state = couchState(
    p.model,
    p.events,
    p.transport,
    p.outcome,
    p.focusSequence !== undefined,
  );
  const [selectedId, setSelectedId] = useState('');
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  const [texts, setTexts] = useState<PublicIdeaText[]>([]);
  const [textError, setTextError] = useState('');
  const [loading, setLoading] = useState(true);
  const root = useRef<HTMLElement>(null);
  const expectedIndex = p.outcome?.terminal.payload.artifactIndexDigest;
  const cache = useRef(new Map<string, unknown>());
  const ideas = useMemo(
    () =>
      [...p.model.candidates].sort(
        (left, right) =>
          left.firstSequence - right.firstSequence ||
          left.id.localeCompare(right.id),
      ),
    [p.model.candidates],
  );
  const resultCandidateId = state.ended && !state.interrupted
    ? p.outcome?.payload.verdict.selectedCandidateId
    : undefined;
  const selected =
    ideas.find((idea) => idea.id === selectedId) ??
    (follow
      ? ideas.find((idea) => idea.id === resultCandidateId) ?? ideas.at(-1)
      : ideas[0]);
  const currentIndex = ideas.findIndex((idea) => idea.id === selected?.id);
  const selectedTitle = selected
    ? ideaTitle(selected.statusHistory[0]?.summary ?? selected.id)
    : '';
  const text =
    texts.find((item) => item.candidateId === selected?.id) ??
    (ideas.filter(
      (idea) =>
        ideaTitle(idea.statusHistory[0]?.summary ?? '') === selectedTitle,
    ).length === 1
      ? texts.find(
          (item) => !item.candidateId && item.summary === selectedTitle,
        )
      : undefined);
  const visibleEvents = useMemo(
    () => p.events.filter((event) => event.sequence <= p.model.cursor),
    [p.events, p.model.cursor],
  );

  useEffect(() => {
    if (!p.caseId || p.specimen) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const index = await p.client.artifactList(p.caseId!, abort.signal);
        if (
          expectedIndex &&
          (await textDigest(canonicalJson(index))) !== expectedIndex
        )
          throw new Error(
            'The saved idea index does not match the signed closure.',
          );
        const relevant = index.artifacts
          .filter(
            (item) =>
              item.name.startsWith('public-idea-') ||
              item.name.startsWith('mcp-sampling-receipt-'),
          )
          .slice(0, 256);
        const next: PublicIdeaText[] = [];
        for (const meta of relevant) {
          if (meta.size > 1_048_576) continue;
          let document = cache.current.get(meta.digest);
          if (!document) {
            const verified = await p.client.fetchArtifact(
              p.caseId!,
              meta.id,
              abort.signal,
            );
            if (verified.meta.digest !== meta.digest)
              throw new Error('An idea artifact changed during retrieval.');
            document = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(verified.data),
            );
            cache.current.set(meta.digest, document);
          }
          const item = jsonObject(document);
          if (item?.protocol === 'jevyr.public-idea/1') {
            const idea = publicIdeaText(item, meta.digest);
            if (idea) next.push(idea);
          } else if (
            item?.protocol === 'jevyr.mcp-sampling-receipt/1' &&
            typeof item.outputDigest === 'string' &&
            /^sha256:[a-f0-9]{64}$/.test(item.outputDigest)
          ) {
            const key = `response:${item.outputDigest}`;
            let recovered = cache.current.get(key);
            if (!recovered) {
              const response = await fetch(
                `${p.client.baseUrl}/v1/cases/${encodeURIComponent(p.caseId!)}/public-responses/${item.outputDigest.slice(7)}`,
                { signal: abort.signal, cache: 'no-store' },
              );
              if (response.status === 404) continue;
              if (!response.ok)
                throw new Error(
                  'Saved public idea text could not be retrieved.',
                );
              const value: unknown = await response.json();
              const wrapper = jsonObject(value);
              if (
                wrapper?.protocol !== 'jevyr.public-response-cache/1' ||
                typeof wrapper.text !== 'string' ||
                wrapper.text.length > 2_000_000 ||
                (await textDigest(wrapper.text)) !== item.outputDigest
              )
                throw new Error(
                  'Recovered idea text does not match its recorded response hash.',
                );
              recovered = JSON.parse(wrapper.text);
              cache.current.set(key, recovered);
            }
            const contributions = jsonObject(recovered)?.contributions;
            if (Array.isArray(contributions))
              for (const contribution of contributions.slice(0, 6)) {
                if (jsonObject(contribution)?.kind !== 'candidate') continue;
                const idea = publicIdeaText(
                  contribution,
                  item.outputDigest,
                  true,
                );
                if (idea) next.push(idea);
              }
          }
        }
        if (!abort.signal.aborted) {
          setTexts(next);
          setTextError('');
        }
      } catch (error) {
        if (!abort.signal.aborted) {
          setTexts([]);
          setTextError(
            error instanceof Error
              ? error.message
              : 'Idea text is unavailable.',
          );
        }
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          if (p.transport !== 'ended')
            timer = setTimeout(() => void refresh(), 3000);
        }
      }
    };
    void refresh();
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [p.client, p.caseId, p.specimen, p.transport, expectedIndex]);

  useEffect(() => {
    const update = () =>
      setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);

  const choose = (id: string) => {
    setSelectedId(id);
    setFollow(false);
    setCopyNotice('');
  };
  const move = (direction: number) => {
    const idea = ideas[currentIndex + direction];
    if (idea) choose(idea.id);
  };
  const readSelected = async () => {
    try {
      await navigator.clipboard.writeText(
        `${selectedTitle}\n\n${text?.body ?? 'Only the proposal title was preserved.'}\n\nUnverified proposal from Jevyr case ${p.caseId}.`,
      );
      setCopyNotice('Copied');
    } catch {
      setCopyNotice('Copy unavailable');
    }
  };

  return (
    <section className="couch-mode" ref={root} aria-label="Couch mode">
      <div className="couch-topline">
        <span
          className="couch-connection"
          data-state={
            state.interrupted ? 'interrupted' : state.ended ? 'closed' : 'live'
          }
        >
          <i aria-hidden="true" />
          {state.connection}
        </span>
        <div className="couch-controls">
          <button
            type="button"
            aria-pressed={paused}
            onClick={() => setPaused(!paused)}
          >
            {paused ? 'Resume motion' : 'Still view'}
          </button>
          <button
            type="button"
            onClick={() => {
              const request = document.fullscreenElement
                ? document.exitFullscreen()
                : root.current?.requestFullscreen();
              void request?.catch(() =>
                setCopyNotice('Fullscreen unavailable'),
              );
            }}
          >
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        </div>
      </div>
      <div className="couch-stage">
        <div className="couch-visual">
          <div className="couch-impulse">
            <span>The request</span>
            <h1>{p.impulse || 'A sealed Jevyr case'}</h1>
          </div>
          <JevyrSubstrate
            events={visibleEvents}
            sealed={p.sealed}
            activeIndex={0}
            morphology={p.model}
            focusSequence={p.focusSequence}
            stopped={paused || state.ended || state.interrupted}
          />
          <div
            className="couch-now"
            aria-live="polite"
            aria-atomic="true"
          >
            <span className="couch-eyebrow">
              {state.interrupted
                ? 'Interrupted'
                : state.ended
                  ? 'The result'
                  : 'Right now'}
            </span>
            <h2>{state.title}</h2>
            <p>{state.detail}</p>
          </div>
          <div className="couch-form-caption">
            A form drawn from this run’s public events. Watching does not steer
            it.
          </div>
        </div>
        <aside className="couch-reader" aria-label="Read an idea">
          <div className="couch-reader-head">
            <span>
              {selected
                ? `Idea ${currentIndex + 1} / ${ideas.length}`
                : 'Ideas will appear here'}
            </span>
            <button
              type="button"
              aria-pressed={follow}
              onClick={() => {
                setSelectedId(follow ? (selected?.id ?? '') : '');
                setFollow(!follow);
              }}
            >
              {state.ended
                ? follow ? 'Following the result' : 'Follow the result'
                : follow ? 'Following new ideas' : 'Follow new ideas'}
            </button>
          </div>
          {selected ? (
            <>
              <span className="couch-idea-status">
                {selected.id === resultCandidateId ? 'Selected by Jevyr · ' : ''}
                {selected.statusHistory.some(
                  (moment) => moment.status === 'embodied',
                )
                  ? 'Prototype executed · not proof of the idea'
                  : 'Proposed · not tested'}
              </span>
              <h2>{selectedTitle}</h2>
              {p.caseId && !p.specimen && (
                <CandidateArtifact key={selected.id} client={p.client} caseId={p.caseId} candidateId={selected.id} artifactDigests={selected.artifactDigests} expectedIndex={expectedIndex} live={!state.ended && !state.interrupted} />
              )}
              <div className="couch-idea-body">
                {text?.body ? (
                  <p>{text.body}</p>
                ) : (
                  <p className="muted">
                    {loading || (!text && p.transport !== 'ended')
                      ? 'Retrieving the saved idea…'
                      : 'The full explanation is not available in the readable artifacts for this run.'}
                  </p>
                )}
              </div>
              {textError && (
                <p role="alert" className="warning">
                  {textError}
                </p>
              )}
              <div className="couch-idea-foot">
                <small>
                  {text
                    ? `${expectedIndex ? 'Signed provenance checked' : 'Content hash checked · live record'}${text.recovered ? ' · recovered from the model response' : ''}. This does not prove the proposal.`
                    : 'The displayed title comes from the public event log.'}
                </small>
                <div className="couch-reader-actions">
                  <button type="button" onClick={() => void readSelected()}>
                    {copyNotice || 'Copy idea'}
                  </button>
                  <button type="button" onClick={() => inspect('artifacts')}>
                    See saved files ↗
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="couch-waiting">
              <h2>
                {state.ended
                  ? 'No idea was published.'
                  : 'Room for the first idea.'}
              </h2>
              <p>
                {state.ended
                  ? 'This run ended before an inspectable proposal was saved.'
                  : 'The form and this reading space update when Jevyr publishes work. There is nothing to invent while we wait.'}
              </p>
              {textError && <p role="alert">{textError}</p>}
            </div>
          )}
          <div className="couch-reader-navigation">
            <button
              type="button"
              disabled={currentIndex <= 0}
              onClick={() => move(-1)}
              aria-label="Previous idea"
            >
              ← Previous
            </button>
            <button
              type="button"
              disabled={currentIndex < 0 || currentIndex >= ideas.length - 1}
              onClick={() => move(1)}
              aria-label="Next idea"
            >
              Next →
            </button>
          </div>
        </aside>
      </div>
      <div className="couch-facts" aria-label="What this run has produced">
        <div>
          <strong>{state.count}</strong>
          <span>ideas proposed</span>
        </div>
        <div>
          <strong>{state.compiled}</strong>
          <span>code sketches saved</span>
        </div>
        <div>
          <strong>{state.executed}</strong>
          <span>prototypes executed</span>
        </div>
        <div className="couch-judgment">
          <strong>
            {state.interrupted
              ? 'Not reached'
              : (p.outcome?.payload.verdict.judgment?.replaceAll('_', ' ') ??
                'In progress')}
          </strong>
          <span>final judgment</span>
        </div>
        <button
          type="button"
          onClick={() => inspect(state.interrupted ? 'ledger' : 'record')}
        >
          {state.interrupted ? 'Why it stopped ↗' : 'Inspect the evidence ↗'}
        </button>
      </div>
      {p.focusSequence !== undefined && (
        <button
          type="button"
          className="couch-return"
          onClick={() => p.onFocus(undefined)}
        >
          You are reading history. Return to the latest state →
        </button>
      )}
      <section className="couch-ideas" aria-label="All ideas from this run">
        <div className="couch-section-head">
          <h2>
            Ideas from this run<span>{ideas.length}</span>
          </h2>
          <p>
            {state.interrupted
              ? 'Saved, not discarded. None is a final answer from this interrupted run.'
              : 'Proposals are possibilities, not findings. Read them as they arrive.'}
          </p>
        </div>
        <ol>
          {ideas.map((idea, index) => (
            <li key={idea.id}>
              <button
                type="button"
                aria-pressed={selected?.id === idea.id}
                onClick={() => {
                  choose(idea.id);
                  root.current
                    ?.querySelector('.couch-reader')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }}
              >
                <span>{String(index + 1).padStart(2, '0')}</span>
                <strong>
                  {ideaTitle(idea.statusHistory[0]?.summary ?? idea.id)}
                </strong>
                <small>
                  {idea.id === resultCandidateId ? 'Selected · ' : ''}
                  {idea.statusHistory.some(
                    (moment) => moment.status === 'embodied',
                  )
                    ? 'Prototype ran'
                    : 'Not tested'}
                </small>
                <span aria-hidden="true">↗</span>
              </button>
            </li>
          ))}
        </ol>
      </section>
      <details className="couch-provenance">
        <summary>Connection and provenance</summary>
        <p>{p.notice}</p>
        <p>
          {p.authenticity} · observed through event {p.model.cursor}
        </p>
        {state.failure && <p>{state.failure}</p>}
        <button type="button" onClick={() => inspect('ledger')}>
          Open the full event log
        </button>
      </details>
    </section>
  );
}
