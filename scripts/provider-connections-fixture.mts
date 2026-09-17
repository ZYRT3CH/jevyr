// Isolated connection-setup proof. No Case, model inference, or root settings writes.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createJevyrHttpService } from '../apps/daemon/src/server.js';

const output = resolve(process.argv[2] ?? `artifacts/provider-connections-fixture-${Date.now()}`);
await mkdir(output, { recursive: true });
const project = await mkdtemp(join(tmpdir(), 'jevyr-connections-proof-'));
const witnessPath = join(project, 'witness.mjs'), callsPath = join(project, 'mcp-methods.jsonl');
await writeFile(witnessPath, `import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({input:process.stdin})) {
  const value = JSON.parse(line);
  appendFileSync(process.argv[2], JSON.stringify({method:value.method})+'\\n');
  if (!Object.hasOwn(value,'id')) continue;
  const result = value.method === 'initialize'
    ? { protocolVersion:value.params.protocolVersion, capabilities:{tools:{}}, serverInfo:{name:'Synthetic connection fixture',version:'1'} }
    : value.method === 'tools/list' ? {tools:[{name:'fixture.read',description:'Synthetic registration only',inputSchema:{type:'object',properties:{},additionalProperties:false}}]} : {};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:value.id,result})+'\\n');
}
`);
const witnessConfig = join(project, 'witnesses.json');
await writeFile(witnessConfig, JSON.stringify({ protocol: 'jevyr.mcp-witnesses/1', servers: [{ id: 'fixture', displayName: 'Synthetic reference tool', command: process.execPath, args: [witnessPath, callsPath], allowedTools: ['fixture.read'], operationTimeoutMs: 3000 }], calls: [] }));
const env = { JEVYR_OLLAMA_MODEL: 'qwen3-coder:30b-32k', JEVYR_OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1/', JEVYR_OLLAMA_INVESTIGATION_TRANSPORT: 'native', JEVYR_MCP_WITNESSES_FILE: witnessConfig };
let port = 0;
let service: ReturnType<typeof createJevyrHttpService>;
async function start() {
  service = createJevyrHttpService({ projectRoot: project, env, allowedOrigins: ['http://localhost:3002', 'http://localhost:3001'], forgeConfig: { mode: 'observe-only' } });
  await service.listen(port, '127.0.0.1');
  const address = service.server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind TCP');
  port = address.port;
  const info = { protocol: 'jevyr.connection-fixture/1', project, output, daemon: `http://127.0.0.1:${port}`, chamber: `http://localhost:3002/connections?api=${encodeURIComponent(`http://127.0.0.1:${port}`)}`, noInference: true, mcp: 'synthetic initialize/tools-list fixture' };
  await writeFile(join(output, 'fixture.json'), JSON.stringify(info, null, 2));
  console.log(JSON.stringify(info));
}
await start();
let stopped = false;
async function stop() { if (!stopped) { stopped = true; await service.close(); } }
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
const input = createInterface({ input: process.stdin });
for await (const command of input) {
  if (command.trim() === 'restart') {
    await service.close(); await start();
    const view = await (await fetch(`http://127.0.0.1:${port}/v1/settings/connections`, { headers: { origin: 'http://localhost:3002' } })).json();
    await writeFile(join(output, 'after-restart.json'), JSON.stringify(view, null, 2));
    console.log(JSON.stringify({ event: 'restarted', view }));
  } else if (command.trim() === 'stop') { break; }
}
await stop();
let methods: unknown[] = [];
try { methods = (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(value => JSON.parse(value)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
await writeFile(join(output, 'mcp-methods.json'), JSON.stringify(methods, null, 2));
console.log(JSON.stringify({ event: 'stopped', output, methods }));
