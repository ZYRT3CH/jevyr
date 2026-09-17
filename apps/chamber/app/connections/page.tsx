'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { JevyrClient, JevyrHttpError, type JevyrReadiness, type ConnectionProfile, type ModelConnection, type ConnectionsView, type ConnectionModelList, type ConnectionMcpTest } from '@jevyr/sdk';
import { defaultDaemonOrigin } from '@/lib/daemon-origin';
import styles from './connections.module.css';

type Section = 'local' | 'cloud' | 'mcp';
type Service = 'ollama' | 'lm-studio' | 'custom';
const SERVICES = {
  ollama: { label: 'Ollama', hint: 'Port 11434', baseUrl: 'http://127.0.0.1:11434/v1/', provider: 'ollama' },
  'lm-studio': { label: 'LM Studio', hint: 'Port 1234', baseUrl: 'http://127.0.0.1:1234/v1/', provider: 'lm-studio' },
  custom: { label: 'Another service', hint: 'Compatible API', baseUrl: 'http://127.0.0.1:8080/v1/', provider: 'openai-compatible' },
} as const;
const EMPTY_PROFILE: ConnectionProfile = { protocol: 'jevyr.connection-profile/1', models: [], mcpServerIds: [] };

function localOrigin(input: string): string {
  const value = new URL(input);
  if (value.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname)
    || value.username || value.password || value.pathname !== '/' || value.search || value.hash) {
    throw new Error('Use a local daemon address, such as http://127.0.0.1:4317.');
  }
  return value.origin;
}
function message(error: unknown): string {
  if (error instanceof JevyrHttpError) {
    if (error.status === 401) return 'This daemon needs its team access token. Enter it in Daemon connection below.';
    if (error.status === 403) return 'Connection settings are available only from the permitted local Chamber. Open this page using the address printed by the launcher.';
    if (error.status === 404) return 'This daemon does not have connection setup yet. Restart it with the updated application.';
    if (error.status === 409) return 'Settings changed in another window. Reload saved settings, review your selection, then save again.';
  }
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return 'Cannot reach the daemon. Start Jevyr, then check the address below and refresh.';
  return error instanceof Error ? error.message : 'The connection could not be checked.';
}
function sourceLabel(value: ModelConnection): string {
  return value.provider === 'ollama' ? 'Ollama' : value.provider === 'lm-studio' ? 'LM Studio' : value.remoteDisclosure === 'none' ? 'Local API' : 'Cloud API';
}
function resultText(value: ConnectionModelList): string {
  if (value.status === 'available') return value.models.length
    ? `${value.models.length} model${value.models.length === 1 ? '' : 's'} listed by this service. Select a model below.`
    : 'The service responded, but listed no models. Download or load a model in the service, then check again.';
  const code = value.code.toLowerCase();
  if (/credential|auth|401|403/.test(code)) return 'The service needs a valid credential. Check its reference below, then restart Jevyr if you have added a key.';
  if (/timeout|timed/.test(code)) return 'The service did not respond in time. Check that its server is running, then try again.';
  return 'Could not list models. Check the address and make sure the service exposes a compatible /v1/models endpoint.';
}

export default function ConnectionsPage() {
  const [api, setApi] = useState(defaultDaemonOrigin);
  const [address, setAddress] = useState(defaultDaemonOrigin);
  const [token, setToken] = useState('');
  const [pendingToken, setPendingToken] = useState('');
  const client = useMemo(() => new JevyrClient({ baseUrl: api, headers: token ? { authorization: `Bearer ${token}` } : {} }), [api, token]);
  const [view, setView] = useState<ConnectionsView>();
  const [readiness, setReadiness] = useState<JevyrReadiness>();
  const [selection, setSelection] = useState<ConnectionProfile>(EMPTY_PROFILE);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [section, setSection] = useState<Section>('local');
  const [service, setService] = useState<Service>('ollama');
  const [endpoint, setEndpoint] = useState(SERVICES.ollama.baseUrl as string);
  const [model, setModel] = useState('');
  const [label, setLabel] = useState('');
  const [transport, setTransport] = useState<'native' | 'structured'>('native');
  const [family, setFamily] = useState('');
  const [credentialId, setCredentialId] = useState('');
  const [disclosure, setDisclosure] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [modelList, setModelList] = useState<ConnectionModelList>();
  const [mcpTests, setMcpTests] = useState<Record<string, ConnectionMcpTest>>({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copied, setCopied] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const value = query.get('api');
    if (value) { try { const origin = localOrigin(value); setApi(origin); setAddress(origin); } catch { setError('The supplied daemon address is not a local HTTP origin.'); } }
    if (['local', 'cloud', 'mcp'].includes(query.get('tab') ?? '')) switchSection(query.get('tab') as Section);
    setInitialized(true);
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async (replace = false, signal?: AbortSignal) => {
    setLoading(true); setError('');
    const results = await Promise.allSettled([client.connections(signal), client.readiness(signal)]);
    if (signal?.aborted || !mounted.current) return;
    const settings = results[0], health = results[1];
    if (settings.status === 'fulfilled') {
      setView(settings.value);
      if (replace || !dirtyRef.current) {
        setSelection(settings.value.saved ?? { ...EMPTY_PROFILE, models: settings.value.active.models, mcpServerIds: settings.value.active.mcpServerIds });
        dirtyRef.current = false; setDirty(false);
      }
    } else setError(message(settings.reason));
    if (health.status === 'fulfilled') setReadiness(health.value);
    else { setReadiness(undefined); if (settings.status === 'fulfilled') setError(message(health.reason)); }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    if (!initialized) return;
    mounted.current = true;
    const controller = new AbortController();
    setView(undefined); setReadiness(undefined);
    dirtyRef.current = false; setDirty(false); setSelection(EMPTY_PROFILE); setNotice('');
    void refresh(true, controller.signal);
    return () => controller.abort();
  }, [refresh, initialized]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function changeSelection(value: ConnectionProfile) { setSelection(value); dirtyRef.current = true; setDirty(true); setNotice(''); }
  function clearTest() { setModelList(undefined); setError(''); }
  function switchSection(next: Section) {
    setSection(next); setEditingId(undefined); setModel(''); setLabel(''); setModelList(undefined); setError('');
    setTransport('native'); setFamily(''); setDisclosure(false);
    setEndpoint(next === 'cloud' ? 'https://api.openai.com/v1/' : SERVICES.ollama.baseUrl);
    setService('ollama'); setCredentialId(next === 'cloud' ? 'openai-env' : '');
  }
  function chooseService(next: Service) {
    setService(next); setEndpoint(SERVICES[next].baseUrl); setModel(''); setLabel(''); setEditingId(undefined); clearTest();
  }
  function connection(requireModel = true): ModelConnection {
    const parsed = new URL(endpoint.trim());
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('The service address must not contain a key, user name, query, or fragment.');
    if (section === 'local' && (!local || !['http:', 'https:'].includes(parsed.protocol))) throw new Error('Local models need a loopback address. Use Cloud API for an endpoint on another machine.');
    if (section === 'cloud' && (!disclosure || parsed.protocol !== 'https:')) throw new Error('Cloud connections require HTTPS and the provider-disclosure checkbox.');
    const credential = view?.credentials.find(value => value.id === credentialId);
    if (credentialId && (!credential || credential.origin !== parsed.origin)) throw new Error('Choose a credential registered for this service’s exact origin.');
    if (requireModel && !model.trim()) throw new Error('Select or enter a model identifier.');
    return {
      id: editingId ?? `model-${crypto.randomUUID().slice(0, 12)}`,
      label: label.trim() || model.trim() || (section === 'cloud' ? 'Cloud model' : SERVICES[service].label),
      provider: section === 'cloud' ? 'openai-compatible' : SERVICES[service].provider,
      baseUrl: parsed.toString(), model: model.trim() || 'model-list-check', transport,
      ...(family.trim() ? { modelFamily: family.trim() } : {}),
      ...(credentialId ? { credentialId } : {}), remoteDisclosure: section === 'cloud' ? 'case-policy' : 'none',
    };
  }
  async function action(name: string, operation: () => Promise<void>) {
    setBusy(name); setError(''); setNotice('');
    try { await operation(); } catch (failure) { setError(message(failure)); } finally { if (mounted.current) setBusy(''); }
  }
  async function discover() {
    await action('models', async () => {
      const value = await client.connectionModels(connection(false)); setModelList(value);
      if (value.status === 'available' && !model && value.models.length === 1) setModel(value.models[0]!.id);
    });
  }
  function addModel() {
    try {
      const value = connection();
      if (!editingId && selection.models.length >= 8) throw new Error('A startup selection can contain up to eight models.');
      if (selection.models.some(entry => entry.id !== value.id && entry.baseUrl === value.baseUrl && entry.model === value.model)) throw new Error('This model is already in your next-launch selection. Use Edit to change it.');
      changeSelection({ ...selection, models: editingId ? selection.models.map(entry => entry.id === editingId ? value : entry) : [...selection.models, value] });
      setEditingId(undefined); setModel(''); setLabel(''); setFamily(''); setModelList(undefined);
      setNotice(`${value.label} added to the selection. Save the selection to use it on the next launch.`);
    } catch (failure) { setError(message(failure)); }
  }
  function edit(value: ModelConnection) {
    setSection(value.remoteDisclosure === 'none' ? 'local' : 'cloud');
    setService(value.provider === 'openai-compatible' ? 'custom' : value.provider);
    setEndpoint(value.baseUrl); setModel(value.model); setLabel(value.label); setTransport(value.transport);
    setFamily(value.modelFamily ?? '');
    setCredentialId(value.credentialId ?? ''); setDisclosure(value.remoteDisclosure === 'case-policy');
    setEditingId(value.id); clearTest();
    document.getElementById('connection-editor')?.scrollIntoView({ behavior: 'instant', block: 'start' });
  }
  async function save() {
    if (!view) return;
    await action('save', async () => {
      const updated = await client.saveConnections(view.revision, selection);
      setView(updated); setSelection(updated.saved ?? EMPTY_PROFILE); dirtyRef.current = false; setDirty(false);
      setNotice(updated.restartRequired ? 'Selection saved. Close the Jevyr launcher after running cases finish, then open it again. Refresh this page to verify the active models.' : 'Selection saved and matches this startup.');
    });
  }
  async function copy(name: string, value: string) {
    try { await navigator.clipboard.writeText(value); setCopied(name); }
    catch { setError('Clipboard access was unavailable. Select and copy the displayed configuration.'); }
  }
  const selectedCredential = view?.credentials.find(value => value.id === credentialId);
  const additionalMinds = readiness?.models.adapters.filter(value => value.role === 'reasoning' && value.transport !== 'http') ?? [];
  const permitted = view?.permissions.canConfigure === true;
  const editable = permitted && !busy && !loading;
  const query = `?api=${encodeURIComponent(api)}`;
  const mcpConfig = JSON.stringify({ mcpServers: { jevyr: { command: 'judge', args: ['mcp', 'serve', '--url', api] } } }, null, 2);
  const credentialConfig = JSON.stringify({ protocol: 'jevyr.connection-credentials/1', credentials: [{ id: 'my-provider', label: 'My cloud provider', origin: 'https://your-provider.example', reference: 'env:JEVYR_PROVIDER_KEY' }] }, null, 2);
  const activeCount = readiness?.models.reasoningConfiguredCount;
  const activeModels = view?.active.models ?? [];

  return <main className={styles.page}>
    <header className={styles.header}>
      <a className={styles.brand} href="/">JEVYR /</a><a href="/">Chamber</a><a href={`/airlock${query}`}>Airlock</a><a href="/connections" aria-current="page">Connections</a>
    </header>
    <div className={styles.intro}><div><p className={styles.eyebrow}>Your machine. Your models.</p><h1>Bring your own intelligence.</h1><p>Connect the models and tools you want Jevyr to work with. Start locally, add a cloud provider, or connect through MCP.</p></div>
      <button className={styles.secondary} disabled={loading || Boolean(busy)} onClick={() => void refresh()}>{loading ? 'Checking…' : 'Refresh status'}</button>
    </div>
    <div className={styles.flow} aria-label="Connection workflow">
      <div><span className={styles.step}>01 / CONNECT</span><strong>{activeCount === undefined ? 'Check your runtime' : `${activeCount} model${activeCount === 1 ? '' : 's'} active now`}</strong><small>{readiness ? `${readiness.models.reasoningAvailableCount} responding · ${readiness.models.mode.replaceAll('-', ' ')}` : 'Waiting for the local daemon'}</small></div><span aria-hidden="true">→</span>
      <div><span className={styles.step}>02 / CHOOSE</span><strong>{selection.models.length} selected for next launch</strong><small>{dirty ? 'Unsaved changes' : view?.restartRequired ? 'Saved · restart to apply' : 'Choose models and permitted tools'}</small></div><span aria-hidden="true">→</span>
      <div><span className={styles.step}>03 / INVESTIGATE</span><strong>Review, then seal.</strong><small>Set disclosure and resources in the Airlock.</small></div>
    </div>
    {error && <div className={styles.error} role="alert"><p>{error}</p><button disabled={loading || Boolean(busy)} onClick={() => void refresh(true)}>Reload saved settings</button><a href="#daemon-connection">Daemon connection</a></div>}
    {notice && <div className={styles.notice} role="status"><p>{notice}</p></div>}
    {view && !permitted && <div className={styles.notice}><p>{view.permissions.reason ?? 'This runtime does not permit connection changes from this page.'}</p></div>}
    <div className={styles.layout}>
      <div className={styles.main} id="connection-editor">
        <nav className={styles.tabs} aria-label="Connection type">{([['local', 'Local models'], ['cloud', 'Cloud API'], ['mcp', 'MCP']] as const).map(([value, title]) => <button key={value} aria-pressed={section === value} disabled={Boolean(busy)} onClick={() => switchSection(value)}>{title}</button>)}</nav>
        {section !== 'mcp' ? <section className={styles.panel} aria-labelledby="model-heading">
          <h2 id="model-heading">{editingId ? 'Edit your connection' : section === 'local' ? 'Intelligence on your machine.' : 'Add a cloud model.'}</h2>
          <p className={styles.lede}>{section === 'local' ? 'Start the model server you already use, then list its available models.' : 'Use your own account with an OpenAI-compatible service. Jevyr keeps the key in the daemon’s credential broker.'}</p>
          {section === 'local' && <div className={styles.choices}>{(Object.keys(SERVICES) as Service[]).map(value => <button key={value} disabled={!editable} aria-pressed={service === value} onClick={() => chooseService(value)}>{SERVICES[value].label}<small>{SERVICES[value].hint}</small></button>)}</div>}
          <form onSubmit={event => { event.preventDefault(); addModel(); }}>
            <fieldset disabled={!editable} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}><div className={styles.form}>
              <label>Service address<input type="url" required maxLength={2048} value={endpoint} onChange={event => { setEndpoint(event.target.value); clearTest(); }} spellCheck={false} /><small>{section === 'local' ? 'The server runs outside Jevyr. Model files stay with that service.' : 'Use its HTTPS API base address, usually ending in /v1/.'}</small></label>
              {section === 'cloud' && <>
                <label>Credential reference<select value={credentialId} onChange={event => { setCredentialId(event.target.value); clearTest(); }}><option value="">No credential</option>{view?.credentials.map(value => <option key={value.id} value={value.id}>{value.label} · {value.available ? 'available' : 'not supplied'}</option>)}</select><small>{selectedCredential ? `Bound to ${selectedCredential.origin}. ${selectedCredential.available ? 'The daemon has this credential.' : 'Supply the named credential before restarting.'}` : 'Choose a credential already registered for this provider.'}</small></label>
                {credentialId === 'openai-env' && !selectedCredential?.available && <div className={styles.notice}><p><strong>Supply your OpenAI key once, outside this page.</strong></p><p>Make <code>OPENAI_API_KEY</code> available to the Jevyr launcher through your environment or secret manager, then restart. Only its reference is saved here.</p></div>}
                <label className={styles.check}><input type="checkbox" checked={disclosure} onChange={event => { setDisclosure(event.target.checked); clearTest(); }} /><span>Allow this provider when the Case permits cloud disclosure.<small>Local-only Cases remain local. Listing models sends a service request and its credential; it sends no Case content.</small></span></label>
              </>}
              <button type="button" className={styles.secondary} onClick={() => void discover()} disabled={!editable || (section === 'cloud' && !disclosure)}>{busy === 'models' ? 'Checking service…' : 'Find available models'}</button>
              {modelList && <div className={styles.result} data-state={modelList.status === 'available' ? 'ok' : 'bad'} role="status"><p><span className={styles.statusDot} data-state={modelList.status === 'available' ? 'ok' : 'bad'} />{resultText(modelList)}</p><small className={styles.subtle}>Availability only. No inference or investigation was run.</small></div>}
              {modelList && modelList.models.length > 0 && <label>Available models<select aria-label="Available models" value={modelList.models.some(value => value.id === model) ? model : ''} onChange={event => setModel(event.target.value)}><option value="">Select a model</option>{modelList.models.map(value => <option key={value.id} value={value.id}>{value.id}</option>)}</select></label>}
              <label>Model identifier<input required maxLength={256} value={model} onChange={event => setModel(event.target.value)} placeholder="Select above, or enter the exact model ID" spellCheck={false} /><small>Use a chat model with structured output support. A listed model has not yet been qualified for investigations.</small></label>
              <details className={styles.advanced}><summary>Name and tool format</summary><div className={styles.two}>
                <label>Display name<input aria-label="Display name" maxLength={128} value={label} onChange={event => setLabel(event.target.value)} placeholder={model || 'My model'} /></label>
                <label>Tool format<select aria-label="Tool format" value={transport} onChange={event => setTransport(event.target.value as 'native' | 'structured')}><option value="native">Native function calls</option><option value="structured">Structured JSON requests</option></select></label>
              </div><label>Model family · optional<input aria-label="Model family · optional" maxLength={256} value={family} onChange={event => setFamily(event.target.value)} placeholder="An explicitly known model family" /><small>Records declared provenance. A family label does not prove independent reasoning.</small></label><p>Both formats require structured JSON output. Use the format supported by your server and model; Jevyr does not switch formats during a Case.</p></details>
              <button type="submit" className={styles.primary}>{editingId ? 'Update selection' : 'Add to next-launch selection'}</button>
            </div></fieldset>
          </form>
          {section === 'local' ? <details className={styles.advanced}><summary>Starting your model service</summary><p><strong>Ollama:</strong> start Ollama and install a model there. Its default compatible address is <code>http://127.0.0.1:11434/v1/</code>.</p><p><strong>LM Studio:</strong> open its Developer tab, start the local server, and select or load a chat model. Listed models may also be available for loading on demand.</p><p><a href="https://docs.ollama.com/api/openai-compatibility" target="_blank" rel="noreferrer">Ollama setup ↗</a> · <a href="https://lmstudio.ai/docs/developer/openai-compat/models" target="_blank" rel="noreferrer">LM Studio setup ↗</a></p></details>
            : <details className={styles.advanced}><summary>Other providers and credential registration</summary><p>For another compatible provider, register its origin and a secret reference in <code>.jevyr/connection-credentials.json</code>, then restart. Supply the actual key in the named environment variable. A reference can only be used with its registered origin.</p><pre className={styles.code}>{credentialConfig}</pre><button onClick={() => void copy('credentials', credentialConfig)}>{copied === 'credentials' ? 'Copied' : 'Copy reference example'}</button><p>The native Codex and Claude agent harnesses use separate startup configuration. This HTTP form does not configure those harnesses.</p><p><a href="https://developers.openai.com/api/reference/resources/models/methods/list" target="_blank" rel="noreferrer">OpenAI model availability ↗</a></p></details>}
        </section> : <section className={styles.panel} aria-labelledby="mcp-heading">
          <h2 id="mcp-heading">Connect in either direction.</h2><p className={styles.lede}>Use Jevyr from an MCP app, or let an investigation consult tools you have registered.</p>
          <article className={styles.mcpCard}><h3>Your app → Jevyr</h3><p>Add Jevyr as a local MCP server in a client that supports stdio servers. The Jevyr daemon must already be running.</p>
            <div className={styles.copyRow}><strong>MCP client configuration</strong><button onClick={() => void copy('mcp', mcpConfig)}>{copied === 'mcp' ? 'Copied' : 'Copy JSON'}</button></div><pre className={styles.code}>{mcpConfig}</pre>
            <p>Use the installed <code>judge</code> command, or replace it with its absolute path if your MCP client cannot find it.</p><p>The client can submit a question, inspect status, and retrieve the result. Jevyr uses its configured investigators; connecting a client does not automatically use that client’s model.</p>
            <details className={styles.advanced}><summary>If your daemon needs an access token</summary><p>The MCP bridge also needs <code>JEVYR_HTTP_TOKEN_REF=env:YOUR_TOKEN_VARIABLE</code> and the named token in its own process environment. The token entered in this page is not transferred to the MCP client or copied into this JSON.</p></details>
          </article>
          <article className={styles.mcpCard}><h3>Jevyr → your tools</h3><p>Select from tools registered at daemon startup. A connection test starts that registered server and checks its handshake; it does not execute a Case’s tool calls.</p>
            {view?.mcpServers.length ? <ul className={styles.mcpList}>{view.mcpServers.map(server => <li key={server.id}><div className={styles.row}><label className={styles.check}><input type="checkbox" disabled={!editable} checked={selection.mcpServerIds.includes(server.id)} onChange={event => changeSelection({ ...selection, mcpServerIds: event.target.checked ? [...selection.mcpServerIds, server.id] : selection.mcpServerIds.filter(id => id !== server.id) })} /><span>{server.label}<small>{server.allowedTools.join(', ') || 'No tools permitted'}</small></span></label><button disabled={!editable} onClick={() => void action(`mcp-${server.id}`, async () => { const result = await client.testMcpConnection(server.id); setMcpTests(previous => ({ ...previous, [server.id]: result })); })}>{busy === `mcp-${server.id}` ? 'Checking…' : 'Test connection'}</button></div>{mcpTests[server.id] && <p className={styles.result} role="status" data-state={mcpTests[server.id]!.status === 'available' ? 'ok' : 'bad'}>{mcpTests[server.id]!.status === 'available' ? 'Registered server responded.' : 'Server did not pass its connection check. Check the operator’s server configuration.'}</p>}</li>)}</ul>
              : <div className={styles.empty}>No external MCP servers are registered for this startup.</div>}
            <p>Case calls require a disclosure policy that permits the external witness. Local-only Cases cannot use these stdio witnesses, even when the program is on this machine.</p>
            <details className={styles.advanced}><summary>Registering a tool server</summary><p>Point <code>JEVYR_MCP_WITNESSES_FILE</code> at the operator’s server configuration before launch. It declares the executable, permitted tool names, and planned calls. Restart, then select the registered server here.</p><p>Tool output is treated as an external observation. Register only programs you intend to run on this machine; stdio alone is not a sandbox.</p></details>
          </article>
          <details className={styles.advanced}><summary>Can my MCP client supply its model?</summary><p>The separate compatibility sampling path requires a client that advertises sampling and a Case that permits provider disclosure. It is not enabled by the standard client configuration above and is not advertised as a normal tool. Use a configured local or cloud investigator for the standard workflow.</p></details>
        </section>}
      </div>
      <aside className={styles.sidebar} aria-label="Connection summary">
        <section><div className={styles.asideHeader}><h2>Active now</h2><span className={styles.badge}>{loading ? 'Checking' : readiness ? 'Live runtime' : 'Offline'}</span></div>
          {activeModels.length ? <ul className={styles.modelList}>{activeModels.map(value => <li key={value.id}><strong>{value.label}</strong><small>{value.model}</small><small>{sourceLabel(value)} · {value.transport === 'native' ? 'function calls' : 'structured JSON'}</small></li>)}</ul>
            : readiness?.models.reasoningConfiguredCount ? <ul className={styles.modelList}>{readiness.models.adapters.filter(value => value.role === 'reasoning').map(value => <li key={value.id}><strong>{value.id}</strong><small>{value.network} · {value.probe.status}</small></li>)}</ul>
            : <p className={styles.empty}>{loading ? 'Reading the runtime…' : readiness ? 'No reasoning model configured. The template fallback can exercise the lifecycle.' : 'Start Jevyr to see its active models.'}</p>}
          {readiness && <p className={styles.subtle}><span className={styles.statusDot} data-state={readiness.forge.usable ? 'ok' : 'bad'} />{readiness.forge.usable ? 'Execution sandbox available' : 'Execution sandbox unavailable'}</p>}
          {activeModels.length > 0 && additionalMinds.length > 0 && <><p className={styles.subtle}>Also configured outside this page:</p><ul className={styles.modelList}>{additionalMinds.map(value => <li key={value.id}><strong>{value.id}</strong><small>{value.probe.status} · retained on next launch</small></li>)}</ul></>}
          <p className={styles.subtle}>Availability is separate from model quality and the evidence needed for a verdict.</p>
        </section>
        <section><div className={styles.asideHeader}><h2>Next launch</h2><span className={styles.badge}>{dirty ? 'Unsaved' : view?.restartRequired ? 'Restart needed' : 'Selection'}</span></div>
          {selection.models.length ? <ul className={styles.modelList}>{selection.models.map(value => <li key={value.id}><div className={styles.modelHead}><div><strong>{value.label}</strong><small>{value.model}</small><small>{sourceLabel(value)}</small></div><div><button disabled={!editable} aria-label={`Edit ${value.label}`} onClick={() => edit(value)}>Edit</button><button disabled={!editable} aria-label={`Remove ${value.label}`} onClick={() => changeSelection({ ...selection, models: selection.models.filter(model => model.id !== value.id) })}>×</button></div></div></li>)}</ul> : <p className={styles.empty}>No HTTP models selected. Other configured investigators remain. The template fallback is used only when none remain.</p>}
          {selection.mcpServerIds.length > 0 && <p className={styles.subtle}>{selection.mcpServerIds.length} registered MCP server{selection.mcpServerIds.length === 1 ? '' : 's'} selected.</p>}
          <button className={styles.primary} disabled={!editable || !dirty} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save next-launch selection'}</button>
          <p className={styles.subtle}>{view?.restartRequired ? 'After running cases finish, close and reopen the launcher. Refresh this page to confirm your selection is active.' : 'Models and tools are fixed when the daemon starts. Saved changes apply when it next starts.'}</p>
          <div className={styles.asideLinks}><a href={`/airlock${query}`}>Open Airlock →</a>{dirty && <button disabled={Boolean(busy)} onClick={() => void refresh(true)}>Discard edits</button>}</div>
        </section>
        <details id="daemon-connection" className={styles.advanced}><summary>Daemon connection</summary><form className={styles.daemonFields} onSubmit={event => { event.preventDefault(); try { const origin = localOrigin(address); if (origin === api && pendingToken === token) void refresh(true); else { setApi(origin); setToken(pendingToken); } } catch (failure) { setError(message(failure)); } }}><label>Local daemon address<input type="url" required value={address} onChange={event => setAddress(event.target.value)} /></label><label>Team access token<input type="password" autoComplete="off" value={pendingToken} onChange={event => setPendingToken(event.target.value)} /></label><p>This optional access token stays in this page’s memory. It is separate from model-provider credentials.</p><button disabled={Boolean(busy) || loading} type="submit">Connect to daemon</button></form></details>
      </aside>
    </div>
    <footer className={styles.footer}><span>One question. An autonomous investigation. An inspectable result.</span><span>Local setup · no model downloads or inference from this page</span></footer>
  </main>;
}
