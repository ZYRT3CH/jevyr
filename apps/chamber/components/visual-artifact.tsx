'use client';

import { useEffect, useState } from 'react';
import { recognizeStaticDocument, recordedLineFrames, sha256Text, type LineFrames, type StaticDocument } from '@/lib/visual-artifact';
import { extractBlueprintFiles } from '@/lib/artifact-preview';
import { canonicalJson } from '@/lib/couch-state';
import type { ArtifactMeta, JevyrClient, VerifiedArtifact } from '@jevyr/sdk';

function extent(data: LineFrames) {
  let min = Infinity;
  let max = -Infinity;
  for (const frame of data.frames) { min = Math.min(min, frame.left, frame.right); max = Math.max(max, frame.left, frame.right); }
  return { min, span: Math.max(1e-9, max - min) };
}

export function LineFramePlayer({ data }: { data: LineFrames }) {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [startIndex, setStartIndex] = useState(0);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    queueMicrotask(() => { if (!disposed && !motion.matches) setPlaying(true); });
    const stop = () => { if (motion.matches) setPlaying(false); };
    motion.addEventListener('change', stop);
    return () => { disposed = true; motion.removeEventListener('change', stop); };
  }, []);
  useEffect(() => {
    if (!playing) return;
    let request: number;
    let start: number | undefined;
    const tick = (now: number) => {
      start ??= now;
      const next = Math.min(data.frames.length - 1, startIndex + Math.floor((now - start) / 100));
      setIndex(next);
      if (next < data.frames.length - 1) request = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [playing, startIndex, data.frames.length]);
  const frame = data.frames[Math.min(index, data.frames.length - 1)]!;
  const { min, span } = extent(data);
  const y = (v: number) => 82 - (v - min) / span * 64;
  return <section className="visual-artifact-player" aria-label="Recorded visual output">
    <h3>{data.title}</h3>
    <figure className="visual-artifact-field" aria-label={`Sample ${index + 1}: first line ${frame.left.toFixed(4)}, second line ${frame.right.toFixed(4)}`}>
      <div className="visual-line-first" style={{ top: `${y(frame.left)}%` }} />
      <div className="visual-line-second" style={{ top: `${y(frame.right)}%` }} />
      <figcaption>— First line · ┄ Second line</figcaption>
    </figure>
    <div className="visual-artifact-controls">
      <button type="button" onClick={() => { const next = index === data.frames.length - 1 ? 0 : index; setIndex(next); setStartIndex(next); setPlaying(!playing); }}>{playing ? 'Pause' : index === data.frames.length - 1 ? 'Replay' : 'Play'}</button>
      <label>Sample {index + 1} / {data.frames.length}<input aria-label="Recorded sample" type="range" min="0" max={data.frames.length - 1} value={index} onChange={event => { setPlaying(false); setIndex(Number(event.target.value)); }} /></label>
      <output>t {frame.t.toFixed(2)} · gap {frame.gap.toFixed(4)}</output>
    </div>
    <p className="muted">Recorded values, displayed at 10 samples per second. No source code is executed. This rendering does not establish the proposal’s claims.</p>
  </section>;
}

export function StaticArtifact({ value }: { value: StaticDocument }) {
  return <section className="visual-static-artifact" aria-label="Static artifact preview">
    {value.kind === 'svg'
      // SVG image documents cannot execute scripts or access the parent page.
      // eslint-disable-next-line next/no-img-element
      ? <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(value.document)}`} alt="Saved SVG artifact" />
      : <iframe title="Saved HTML artifact — static preview" sandbox="" referrerPolicy="no-referrer" srcDoc={value.document} />}
    <p className="muted">Static {value.kind.toUpperCase()} preview. Scripts, forms, and network resources are disabled.</p>
  </section>;
}

export function ArtifactVisual({ client, caseId, artifact, source, index }: {
  client: JevyrClient; caseId: string; artifact: VerifiedArtifact;
  source?: { path: string; content: string }; index: readonly ArtifactMeta[];
}) {
  const [frames, setFrames] = useState<LineFrames>();
  const [notice, setNotice] = useState('Looking for a recognized visual artifact…');
  const doc = source ? recognizeStaticDocument(source.path, source.content) : undefined;
  const staticKind = doc?.kind;
  const sourcePath = source?.path;
  const sourceText = source?.content;
  useEffect(() => {
    if (staticKind) return;
    const abort = new AbortController();
    const inspect = async () => {
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(artifact.data));
        let result: LineFrames | undefined;
        if (sourcePath !== undefined && sourceText !== undefined && typeof value.blueprintDigest === 'string') {
          for (const meta of index.filter(meta => meta.mediaType === 'application/vnd.jevyr.tool-observation+json' && meta.size <= 1_000_000).slice(0, 128)) {
            const observation = await client.fetchArtifact(caseId, meta.id, abort.signal);
            if (observation.meta.digest !== meta.digest) throw new Error('Execution artifact changed during retrieval.');
            result = await recordedLineFrames(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observation.data)), { blueprintDigest: value.blueprintDigest, path: sourcePath, content: sourceText });
            if (result) break;
          }
        } else if (sourcePath === undefined) result = await recordedLineFrames(value);
        if (!abort.signal.aborted) {
          setFrames(result);
          setNotice(result ? '' : 'No supported visual output is available yet. Source remains available; arbitrary code is not run here.');
        }
      } catch {
        if (!abort.signal.aborted) { setFrames(undefined); setNotice('Visual output could not be verified. Source remains available.'); }
      }
    };
    void inspect();
    return () => abort.abort();
  }, [client, caseId, artifact, sourcePath, sourceText, index, staticKind]);
  return doc ? <StaticArtifact value={doc} /> : frames ? <LineFramePlayer key={artifact.meta.digest} data={frames} /> : <output className="muted">{notice}</output>;
}

/** Couch is an observer: artifact retrieval never invokes a model or executes source. */
export function CandidateArtifact({ client, caseId, candidateId, artifactDigests, expectedIndex, live }: {
  client: JevyrClient; caseId: string; candidateId: string; artifactDigests: readonly string[]; expectedIndex?: string; live: boolean;
}) {
  const [bundle, setBundle] = useState<{ artifact: VerifiedArtifact; index: readonly ArtifactMeta[] }>();
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const index = await client.artifactList(caseId, abort.signal);
        if (expectedIndex && await sha256Text(canonicalJson(index)) !== expectedIndex) throw new Error('Artifact index failed closure verification.');
        const meta = index.artifacts.find(item => item.name === `candidate-blueprint-${candidateId}.json` && artifactDigests.includes(item.digest));
        if (meta && meta.size <= 1_000_000) {
          const artifact = await client.fetchArtifact(caseId, meta.id, abort.signal);
          if (artifact.meta.digest !== meta.digest) throw new Error('Source artifact failed verification.');
          if (!abort.signal.aborted) setBundle(current => current?.artifact.meta.digest === artifact.meta.digest && canonicalJson(current.index) === canonicalJson(index.artifacts) ? current : { artifact, index: index.artifacts });
        }
        if (!abort.signal.aborted) setError('');
      } catch { if (!abort.signal.aborted) { setBundle(undefined); setError('Saved artifact could not be verified.'); } }
      finally { if (live && !abort.signal.aborted) timer = setTimeout(() => void refresh(), 3000); }
    };
    void refresh();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [client, caseId, candidateId, artifactDigests, expectedIndex, live]);
  if (error) return <p role="alert">{error}</p>;
  if (!bundle) return <p className="muted">{live ? 'Watching for this idea’s saved prototype…' : 'This idea has no saved prototype to render.'}</p>;
  let files: { path: string; content: string }[];
  try { files = extractBlueprintFiles(JSON.parse(new TextDecoder().decode(bundle.artifact.data))); } catch { return <p>Source format is not readable.</p>; }
  const source = files.find(file => recognizeStaticDocument(file.path, file.content)) ?? files[0];
  return <>
    <ArtifactVisual key={`${bundle.artifact.meta.digest}:${source?.path}`} client={client} caseId={caseId} artifact={bundle.artifact} source={source} index={bundle.index} />
    <details><summary>Source · {source?.path ?? 'artifact'}</summary><pre className="source-text">{source?.content.slice(0, 200000)}</pre></details>
  </>;
}
