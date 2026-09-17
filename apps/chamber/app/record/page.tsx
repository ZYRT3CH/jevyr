'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { JevyrClient, canonicalJson, sha256Digest, type ArtifactList, type AuthenticatedTerminalRecord, type CaseEvent, type SealedCase, type VerifiedArtifact, type VerifiedRunAttestations } from '@jevyr/sdk';
import styles from '../airlock/surface.module.css';
import { defaultDaemonOrigin } from '@/lib/daemon-origin';

type Material = { record: AuthenticatedTerminalRecord; sealed: SealedCase; events: CaseEvent[]; index: ArtifactList; canReproduce: boolean; attestations?: VerifiedRunAttestations };
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export default function RecordPage() {
  const [address, setAddress] = useState(defaultDaemonOrigin);
  const [token, setToken] = useState('');
  const [caseId, setCaseId] = useState('');
  const [material, setMaterial] = useState<Material>();
  const [artifact, setArtifact] = useState<VerifiedArtifact>();
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [ledgerPage, setLedgerPage] = useState(0);
  const viewEpoch = useRef(0);
  const loadRequest = useRef<AbortController | undefined>(undefined);
  const artifactRequest = useRef<AbortController | undefined>(undefined);
  const client = useMemo(() => new JevyrClient({ baseUrl: address, headers: token ? { authorization: `Bearer ${token}` } : {} }), [address, token]);
  useEffect(() => { const query = new URLSearchParams(window.location.search); setCaseId(query.get('case') ?? ''); if (query.get('api')) setAddress(query.get('api')!); setReady(true); }, []);
  useEffect(() => () => { viewEpoch.current++; loadRequest.current?.abort(); artifactRequest.current?.abort(); }, []);
  function reset() {
    viewEpoch.current++; loadRequest.current?.abort(); artifactRequest.current?.abort();
    setMaterial(undefined); setArtifact(undefined); setLedgerPage(0); setError(''); setBusy(false);
  }
  async function load() {
    if (!/^case_[a-f0-9]{16}$/.test(caseId)) { setError('Enter a complete Case identifier.'); return; }
    reset();
    const epoch = viewEpoch.current, controller = new AbortController(); loadRequest.current = controller;
    setBusy(true);
    try {
      const deadline = setTimeout(() => controller.abort(), 120_000);
      try {
        const events: CaseEvent[] = [];
        for await (const frame of client.liveEvents(caseId, { signal: controller.signal })) { if (events.length >= 100_000) throw new Error('Use the CLI for this ledger: browser inspection is bounded to 100,000 events.'); events.push(frame.event); }
        const [record, sealed, index] = await Promise.all([client.waitForAuthenticatedRecord(caseId, { signal: controller.signal }), client.verifiedSealedCase(caseId, controller.signal), client.artifactList(caseId, controller.signal)]);
        if (await sha256Digest(canonicalJson(index)) !== record.terminal.payload.artifactIndexDigest || events.at(-1)?.eventDigest !== record.terminal.payload.eventHeadDigest) throw new Error('The displayed ledger or artifact index differs from the signed terminal closure.');
        let attestations: VerifiedRunAttestations | undefined;
        const policy = await client.verifiedPolicyDescriptor(caseId, controller.signal);
        const descriptor = policy.binding.artifact.descriptor as unknown as { policy?: { runAttestations?: string; metabolicCheckpoints?: { protocol?: string } } };
        if (descriptor.policy?.runAttestations) attestations = await client.verifiedRunAttestations(caseId, controller.signal);
        const canReproduce = sealed.intent.control === 'sovereign' || descriptor.policy?.metabolicCheckpoints?.protocol === 'jevyr.metabolic-checkpoints/1';
        if (viewEpoch.current === epoch && !controller.signal.aborted) setMaterial({ record, sealed, index, events, canReproduce, ...(attestations ? { attestations } : {}) });
      } finally { clearTimeout(deadline); }
    } catch (failure) { if (viewEpoch.current === epoch) setError(failure instanceof Error ? failure.message : 'The Record could not be authenticated'); }
    finally { if (viewEpoch.current === epoch) setBusy(false); }
  }
  async function inspect(id: string) {
    if (!material) return;
    artifactRequest.current?.abort();
    const epoch = viewEpoch.current, controller = new AbortController(); artifactRequest.current = controller;
    const isCurrent = () => viewEpoch.current === epoch && artifactRequest.current === controller && !controller.signal.aborted;
    setError(''); setArtifact(undefined);
    try {
      const bytes = await client.fetchArtifact(caseId, id, controller.signal), pinned = material.index.artifacts.find(value => value.id === id);
      if (!pinned || canonicalJson(bytes.meta) !== canonicalJson(pinned)) throw new Error('Artifact metadata differs from the signed inventory.');
      if (isCurrent()) { setArtifact(bytes); document.getElementById('artifact-inspection')?.scrollIntoView(); }
    } catch (failure) { if (isCurrent()) setError(failure instanceof Error ? failure.message : 'Artifact verification failed'); }
  }
  const evidenceEvent = (id: string) => material?.events.find(event => event.kind === 'evidence.observed' && event.payload.evidenceId === id);
  function openEvent(event: CaseEvent) {
    setLedgerPage(Math.floor((material?.events.findIndex(value => value.eventDigest === event.eventDigest) ?? 0) / 100));
    setTimeout(() => { const element = document.getElementById(`event-${event.sequence}`); element?.setAttribute('open', ''); element?.scrollIntoView(); }, 0);
  }
  const artifactButtons = (value: unknown) => {
    const text = canonicalJson(value);
    return material?.index.artifacts.filter(entry => text.includes(entry.digest)).map(entry => <button key={entry.id} onClick={() => void inspect(entry.id)}>Inspect {entry.name}</button>);
  };
  const referencedArtifactButtons = () => {
    if (!artifact || artifact.data.length > 1_048_576) return null;
    try { return artifactButtons(JSON.parse(new TextDecoder().decode(artifact.data))); } catch { return null; }
  };
  return <main className={styles.airlock}>
    <header className={styles.header}><a href="/">← Chamber</a><span>JEVYR / RECORD</span><a href="/airlock">Airlock</a><a href="/genome-lab">Genome Lab</a></header>
    <h1>The frozen evidence.</h1>
    <form onSubmit={event => { event.preventDefault(); void load(); }}><fieldset disabled={!ready || busy || Boolean(material)}><div className={styles.row}>
      <label>Daemon address<input value={address} onChange={event => setAddress(event.target.value)} /></label>
      <label>Case identifier<input value={caseId} onChange={event => setCaseId(event.target.value)} /></label>
      <label>Team access token<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} /></label>
    </div><button type="submit">{busy ? 'Authenticating closure…' : 'Read authenticated Record'}</button></fieldset></form>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {material && <>
      <button onClick={reset}>Inspect another Case</button>
      <p>Authenticated Seal, Record, complete ledger, and terminal artifact inventory against the daemon’s advertised key. The browser verifies identity and bytes; use independent CLI replay to recheck the verdict from physical evidence.</p>
      <dl className="verdict-facts">{(['integrity', 'creation', 'embodiment', 'judgment'] as const).map(axis => <div key={axis}><dt>{axis}</dt><dd>{material.record.payload.verdict[axis]}</dd></div>)}</dl>
      <h2>Binding findings and unresolved claims</h2>
      {material.record.payload.verdict.basis.map((basis, index) => <article key={`${basis.code}:${index}`} className="verdict-basis"><h3>{basis.code.replaceAll('_', ' ')}</h3><p>{basis.summary}</p>
        {basis.evidenceIds.length === 0 ? <p>No binding observation is cited for this basis.</p> : <ul>{basis.evidenceIds.map(id => { const event = evidenceEvent(id); return <li key={id}>{event ? <a href={`#event-${event.sequence}`} onClick={() => openEvent(event)}>Open evidence {id}</a> : <span>Unresolved reference: <code>{id}</code></span>}</li>; })}</ul>}
        <details><summary>Exact claim and candidate bindings</summary><pre>{pretty(basis)}</pre></details>
      </article>)}
      <h2>Seed, subject, and investigation method</h2><p>Revealed seed: <code className={styles.code}>{material.sealed.intent.seed}</code></p>
      <p>Case: <code className={styles.code}>{material.sealed.caseDigest}</code></p><p>Genome: <code className={styles.code}>{material.sealed.genomeDigest}</code></p>
      {material.index.artifacts.filter(value => value.mediaType === 'application/vnd.jevyr.phenotype+json').map(value => <button key={value.id} onClick={() => void inspect(value.id)}>Inspect signed Phenotype artifact</button>)}
      <details><summary>Exact sealed subjects, privacy, capabilities and ceilings</summary><pre>{pretty(material.sealed)}</pre></details>
      <h2>Provenance and replay</h2><pre>{`judge replay ${caseId}${material.canReproduce ? `\njudge replay ${caseId} --same-seed\njudge replay ${caseId} --new-seed` : ''}`}</pre>
      {material.sealed.intent.control === 'juggler' && <p>{material.canReproduce ? 'A seeded rerun creates fresh signed additions from this recorded sequence. Same-seed requires exact investigation checkpoints. New-seed preserves addition order and uses the first eligible checkpoint in each original stage; it does not reproduce the original timing or candidate trajectory. Missing eligibility closes INVALID.' : 'This historical Juggler Case has no reproducible admission checkpoints. Its existing proof can be verified; seeded execution reruns cannot infer the missing timing.'}</p>}
      {material.attestations ? <details><summary>Verified SLSA production and in-toto advisory statements</summary><p>No SLSA level or external build certification is claimed.</p><pre>{pretty(material.attestations)}</pre></details> : <p>This historical Case has no required production-attestation sidecars.</p>}
      <details><summary>Exact signed Record and terminal closure</summary><pre>{pretty(material.record)}</pre></details>
      <section id="artifact-inspection"><h2>Verified artifact inspection</h2>{artifact ? <><p>{artifact.meta.name} · {artifact.meta.size} bytes · <code className={styles.code}>{artifact.meta.digest}</code></p>
        <p>Untrusted artifact text is displayed as text and never executed.</p><pre>{new TextDecoder().decode(artifact.data.slice(0, 131_072))}{artifact.data.length > 131_072 ? '\n[Preview bounded to 128 KiB]' : ''}</pre>
        <div aria-label="Referenced inventory artifacts">{referencedArtifactButtons()}</div>
        <button onClick={() => { const url = URL.createObjectURL(new Blob([new Uint8Array(artifact.data)], { type: 'application/octet-stream' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = artifact.meta.name.replaceAll(/[\\/]/g, '_'); anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download verified bytes</button></> : <p>Choose a ledger artifact to inspect its exact command, oracle, output, source binding, or reproduction recipe.</p>}</section>
      <h2>Exact ordered ledger · {material.events.length} events</h2>
      <details><summary>Complete signed artifact inventory · {material.index.artifacts.length}</summary>{material.index.artifacts.map(entry => <p key={entry.id}><button onClick={() => void inspect(entry.id)}>Inspect {entry.name}</button> <code className={styles.code}>{entry.digest}</code></p>)}</details>
      <p>Page {ledgerPage + 1} of {Math.max(1, Math.ceil(material.events.length / 100))} · 100 events per page</p>
      <button disabled={ledgerPage === 0} onClick={() => setLedgerPage(value => value - 1)}>Previous events</button>{' '}
      <button disabled={(ledgerPage + 1) * 100 >= material.events.length} onClick={() => setLedgerPage(value => value + 1)}>Next events</button>
      {material.events.slice(ledgerPage * 100, (ledgerPage + 1) * 100).map(event => <details id={`event-${event.sequence}`} key={event.eventDigest}><summary>{event.sequence} · {event.stage} · {event.kind}</summary><p>{'summary' in event.payload ? event.payload.summary : event.actor.id}</p><pre>{pretty(event)}</pre>{artifactButtons(event.payload)}</details>)}
    </>}
  </main>;
}
