'use client';

import { useEffect, useMemo, useState } from 'react';
import { JevyrClient, type AirlockDraft, type AirlockChoices, type CastSubmission } from '@jevyr/sdk';
import styles from './surface.module.css';
import { MetabolicControls } from '@/components/metabolic-controls';
import { defaultDaemonOrigin } from '@/lib/daemon-origin';

const DEFAULT_API = defaultDaemonOrigin();
function lines(value: string): string[] { return value.split('\n').map((line) => line.trim()).filter(Boolean); }

export default function AirlockPage() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_API);
  const [token, setToken] = useState('');
  const client = useMemo(() => new JevyrClient({ baseUrl, headers: token ? { authorization: `Bearer ${token}` } : {} }), [baseUrl, token]);
  const [draft, setDraft] = useState<AirlockDraft>();
  const [impulse, setImpulse] = useState('');
  const [constraints, setConstraints] = useState('');
  const [assays, setAssays] = useState('');
  const [subjects, setSubjects] = useState('[]');
  const [privacy, setPrivacy] = useState<'local_only' | 'provider_scoped' | 'full_case'>('local_only');
  const [control, setControl] = useState<'juggler' | 'sovereign'>('juggler');
  const [mode, setMode] = useState<'auto' | 'audit' | 'design'>('auto');
  const [seed, setSeed] = useState('');
  const [choices, setChoices] = useState<AirlockChoices>({});
  const [resources, setResources] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(true);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<string>();
  const [abortAccepted, setAbortAccepted] = useState(false);
  const editable = !draft || draft.state === 'DRAFT';
  const caseId = draft?.receipt?.caseId;
  useEffect(() => {
    const query = new URLSearchParams(window.location.search), api = query.get('api');
    if (api) { try { const value = new URL(api); if (['http:', 'https:'].includes(value.protocol) && !value.username && !value.password) setBaseUrl(value.toString()); } catch { /* Keep the configured address. */ } }
    const kind = query.get('subject-kind'), locator = query.get('subject-locator');
    if ((kind === 'file' || kind === 'directory') && locator && locator.length <= 4096 && !/[\u0000-\u001f]/u.test(locator)) setSubjects(JSON.stringify([{ id: 'source', kind, locator }], null, 2));
  }, []);
  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const frame of client.liveEvents(caseId, { signal: controller.signal })) {
          setProgress((previous) => [...previous.slice(-7), `${frame.event.sequence} · ${frame.event.stage} · ${frame.event.kind}`]);
        }
        const closure = await client.waitForAuthenticatedRecord(caseId, { signal: controller.signal });
        const verdict = closure.payload.verdict;
        setOutcome(`${verdict.integrity} / ${verdict.embodiment} / ${verdict.judgment}`);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Observation failed'); }
    })();
    return () => controller.abort();
  }, [caseId, client]);

  function change(operation: () => void) { operation(); setDirty(true); }
  async function action(operation: () => Promise<void>) {
    setBusy(true); setError('');
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'The operation failed'); }
    finally { setBusy(false); }
  }
  async function save() {
    const value: CastSubmission = { protocol: 'jevyr.case/1', case: { impulse, privacy, control, mode,
      constraints: lines(constraints), requestedAssays: lines(assays), subjects: JSON.parse(subjects), ...(seed.trim() ? { seed: seed.trim() } : {}) } };
    const selected = { ...choices, ...(resources.trim() !== '{}' ? { resourceCeiling: JSON.parse(resources) } : { resourceCeiling: {} }) };
    const saved = draft ? await client.replaceDraft(draft.draftId, draft.revision, value, undefined, selected) : await client.createDraft(value);
    setDraft(saved); setSeed(saved.submission.case.seed ?? ''); setDirty(false);
    window.history.replaceState(null, '', `/airlock#${saved.draftId}`);
  }
  function loadFields(value: AirlockDraft) {
    setDraft(value); setImpulse(value.submission.case.impulse); setSeed(value.submission.case.seed ?? '');
    setConstraints((value.submission.case.constraints ?? []).join('\n')); setAssays((value.submission.case.requestedAssays ?? []).join('\n'));
    setSubjects(JSON.stringify(value.submission.case.subjects ?? [], null, 2)); setPrivacy(value.submission.case.privacy ?? 'local_only');
    setControl(value.submission.case.control ?? 'juggler'); setMode(value.submission.case.mode ?? 'auto'); setDirty(false);
    setChoices(value.choices); setResources(JSON.stringify(value.choices.resourceCeiling ?? {}, null, 2));
  }
  return <main className={styles.airlock}>
    <header className={styles.header}><a href="/">← Chamber</a><span>JEVYR / AIRLOCK</span><a href={`/connections?api=${encodeURIComponent(baseUrl)}`}>Connections</a><a href="/genome-lab">Genome Lab</a><span className={styles.state}>{draft?.state ?? 'NEW DRAFT'}</span></header>
    <div className={styles.heading}><div><h1>Before the seal.</h1><p>Shape the question, inspect the claims, then release an autonomous investigation.</p></div><span className={styles.revision}>{draft ? `Revision ${draft.revision}` : 'Editable'}</span></div>
    <details className={styles.connection}><summary>Daemon connection</summary><div className={styles.row}>
      <label>Address<input value={baseUrl} disabled={Boolean(draft)} onChange={(event) => setBaseUrl(event.target.value)} /></label>
      <label>Team access token<input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /><small>Held in this page’s memory only.</small></label>
    </div></details>
    <div className={styles.grid}>
      <section aria-labelledby="submission-heading"><h2 id="submission-heading">The question</h2>
        <form onSubmit={(event) => { event.preventDefault(); void action(save); }}>
          <fieldset disabled={busy || !editable}>
            <label>Impulse<textarea required rows={5} placeholder="What should be built, tested, or disproved?" value={impulse} onChange={(event) => change(() => setImpulse(event.target.value))} /></label>
            <div className={styles.row}>
              <label>Investigation<select value={mode} onChange={(event) => change(() => setMode(event.target.value as typeof mode))}><option value="auto">Auto</option><option value="audit">Audit</option><option value="design">Design</option></select></label>
              <label>Control<select value={control} onChange={(event) => change(() => setControl(event.target.value as typeof control))}><option value="juggler">Juggler · additive work</option><option value="sovereign">Sovereign · observe only</option></select></label>
            </div>
            <label>Privacy<select value={privacy} onChange={(event) => change(() => setPrivacy(event.target.value as typeof privacy))}><option value="local_only">Keep work on this machine</option><option value="provider_scoped">Permit scoped provider disclosure</option><option value="full_case">Permit full Case disclosure to configured providers</option></select></label>
            <details><summary>Constraints, subjects, and tests</summary>
              <label>Constraints · one per line<textarea rows={3} value={constraints} onChange={(event) => change(() => setConstraints(event.target.value))} /></label>
              <label>Requested tests · one per line<textarea rows={3} value={assays} onChange={(event) => change(() => setAssays(event.target.value))} /></label>
              <label>Subject references · JSON<textarea className={styles.code} rows={5} value={subjects} onChange={(event) => change(() => setSubjects(event.target.value))} spellCheck={false} /><small>Example: [{'{"id":"source","kind":"directory","locator":"C:/project"}'}]</small></label>
            </details>
            <label>Seed<input className={styles.code} pattern="[a-f0-9]{64}" value={seed} placeholder="Generated as 256 random bits when saved" onChange={(event) => change(() => setSeed(event.target.value))} /><small>Lock 64 lowercase hexadecimal characters, or leave blank to generate 256 random bits.</small></label>
            {draft && <details><summary>Investigation permissions</summary>
              <div className={styles.row}>
                <label>Preset<select value={choices.preset ?? 'startup'} onChange={(event) => change(() => setChoices(previous => ({ ...previous, preset: event.target.value as 'startup' | 'wild' })))}><option value="startup">Use the selected startup preset</option><option value="wild">Wild · remove preset restrictions now</option></select></label>
                <label>Sandbox<select value={choices.sandbox ?? 'configured'} onChange={(event) => change(() => setChoices(previous => ({ ...previous, sandbox: event.target.value as 'configured' | 'observe_only' })))}><option value="configured">Use the configured execution body</option><option value="observe_only">Observe only · no execution body</option></select></label>
              </div>
              <p className={styles.status}>Wild changes this draft. The startup Genome and project permission limits remain bound.</p>
              <fieldset><legend>Configured capabilities</legend>{(draft.startup.availableCapabilities ?? draft.startup.capabilities).map(capability => <label className={styles.checkbox} key={capability.id}>
                <input type="checkbox" checked={(choices.capabilityIds ?? (draft.startup.availableCapabilities ?? draft.startup.capabilities).map(value => value.id)).includes(capability.id)} onChange={event => change(() => setChoices(previous => {
                  const selected = previous.capabilityIds ?? (draft.startup.availableCapabilities ?? draft.startup.capabilities).map(value => value.id);
                  return { ...previous, capabilityIds: event.target.checked ? [...selected, capability.id] : selected.filter(id => id !== capability.id) };
                }))} /><span>{capability.displayName ?? capability.id}<small>{capability.network}</small></span>
              </label>)}</fieldset>
              <label>Lower resource ceilings · JSON<textarea className={styles.code} rows={4} value={resources} onChange={event => change(() => setResources(event.target.value))} spellCheck={false} /><small>Leave empty braces to use startup limits. Values may only reduce the limits shown in the preview. Zero denies a resource.</small></label>
            </details>}
            <button className={styles.primary} type="submit">{busy ? 'Working…' : draft ? 'Save revision & inspect' : 'Save draft & inspect'}</button>
          </fieldset>
        </form>
        {!draft && <button className={styles.restore} onClick={() => void action(async () => {
          const id = window.location.hash.slice(1); if (!id) throw new Error('Open an Airlock URL containing a draft identifier to restore it.');
          loadFields(await client.draft(id));
        })}>Restore draft from this address</button>}
      </section>
      <section aria-labelledby="preview-heading" className={styles.preview}><h2 id="preview-heading">What will be judged</h2>
        {!draft ? <p className={styles.empty}>Save the draft to inspect its inferred obligations and the daemon’s available capabilities.</p> : <>
          <p className={styles.status}>{dirty ? 'Edits are unsaved. Save a new revision before sealing.' : `${draft.preview.criticalObligations.length} critical obligations · ${draft.preview.ambiguities.length} ambiguities`}</p>
          <ol className={styles.claims}>{draft.preview.criticalObligations.map((claim) => <li key={claim.id}><p>{claim.statement}</p><span>{claim.assayability}</span></li>)}</ol>
          {draft.preview.ambiguities.length > 0 && <details><summary>Ambiguities to retain</summary><pre>{JSON.stringify(draft.preview.ambiguities, null, 2)}</pre></details>}
          <details><summary>Capabilities & hard ceilings</summary>
            <ul>{draft.startup.capabilities.map((capability) => <li key={capability.id}>{capability.displayName ?? capability.id} · {capability.network}</li>)}</ul>
            <pre>{JSON.stringify(draft.startup.searchEnvelope.profile.resources, null, 2)}</pre>
            <p>These ceilings and the active Genome come from the daemon’s startup configuration.</p>
            <p className={styles.code}>{draft.startup.genomeVersion}<br />{draft.startup.genomeDigest}</p>
          </details>
          <details><summary>Exact policy & seed binding</summary><p className={styles.code}>{draft.startup.policyDigest}</p><pre>{JSON.stringify(draft.startup.policy, null, 2)}</pre></details>
          {editable ? <div className={styles.seal}><p>Sealing captures subject bytes and closes semantic editing. Critical claims need executable evidence.</p><button className={styles.primary} disabled={dirty || busy} onClick={() => void action(async () => {
            setDraft(await client.sealDraft(draft.draftId, draft.revision, draft.startup.policyDigest));
          })}>Seal & run autonomously</button></div> : <div className={styles.seal}>
            <p className={styles.code}>{caseId ?? 'Admission did not complete. This draft cannot be retried.'}</p>
            {progress.length > 0 && <ol aria-label="Live investigation stages" className={styles.trace}>{progress.map((entry) => <li key={entry}>{entry}</li>)}</ol>}
            {outcome ? <p role="status">Authenticated closure: <strong>{outcome}</strong></p> : <p role="status">{abortAccepted ? 'Abort accepted. Waiting for INVALID closure.' : 'The sealed investigation is running.'}</p>}
            {caseId && !outcome && <button disabled={busy || abortAccepted} onClick={() => void action(async () => { await client.abort(caseId); setAbortAccepted(true); })}>Emergency abort · INVALID</button>}
            {caseId && control === 'juggler' && <MetabolicControls client={client} caseId={caseId} />}
            {caseId && outcome && <p><a href={`/record?case=${encodeURIComponent(caseId)}&api=${encodeURIComponent(baseUrl)}`}>Open the signed Record and evidence paths</a></p>}
          </div>}
        </>}
      </section>
    </div>
    {error && <p role="alert" className={styles.error}>{error}</p>}
  </main>;
}
