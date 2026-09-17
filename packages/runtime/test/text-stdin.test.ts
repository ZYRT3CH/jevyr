import assert from "node:assert/strict";
import { test } from "node:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope } from "@jevyr/protocol";
import { configuredMindAdapters, knownAdapterProbes, TextStdinMindAdapter, parsePublicContributions, DEFAULT_SEARCH_PROFILE, type MindRequest } from "../src/index.js";

const contract = compileIntentContract({ impulse: "Create and judge a counter" });
const output = JSON.stringify({ contributions: [{ kind: "claim", summary: "One finite public claim." }] });
const emit = (text: string) => `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(text)}));`;

function request(): MindRequest {
  return {
    stage: "interpret", role: "interpreter", seed: "stdin-invocation-a", constraints: [], publicFacts: [],
    preparedPublicPrompt: "Only this public projection — æ.", signal: new AbortController().signal,
    maxInputTokens: 10_000, maxOutputTokens: 100_000,
    sealed: {
      protocol: "jevyr.case/1", caseId: "case_1234567812345678", submissionDigest: `sha256:${"0".repeat(64)}`,
      caseDigest: `sha256:${"1".repeat(64)}`, runDigest: `sha256:${"2".repeat(64)}`, subjectMaterialCaptureDigest: `sha256:${"9".repeat(64)}`,
      sealedAt: "2026-09-05T12:00:00.000Z", policyVersion: "jevyr.bone/1", policyDigest: `sha256:${"3".repeat(64)}`,
      genomeVersion: "jevyr.genome/1", genomeDigest: `sha256:${"4".repeat(64)}`, searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
      intentContractDigest: contract.digest, intentContract: contract,
      intent: { impulse: "Unprojected private Case bytes", mode: "auto", subjects: [{ id: "private", kind: "file", locator: join(process.cwd(), "private.txt") }], constraints: [], requestedAssays: [], privacy: "provider_scoped", control: "sovereign", seed: "case-seed" }, subjects: [],
    },
  };
}

async function absent(path: string): Promise<boolean> { try { await access(path); return false; } catch { return true; } }

test("text/stdin startup configuration is explicit, immutable and changes its sealed capability identity", () => {
  const env = { JEVYR_STDIN_COMMAND: process.execPath, JEVYR_STDIN_ARGS_JSON: JSON.stringify(["-e", emit(output)]) };
  const adapter = configuredMindAdapters(env)[0]!;
  assert.equal(adapter.capability.id, "mind.text-stdin.configured");
  assert.equal(adapter.capability.network, "unrestricted");
  assert.equal(adapter.capability.canExecuteTools, true);
  assert.equal(adapter.capability.trust, "quarantined");
  assert.ok(knownAdapterProbes(env).some((mind) => mind.capability.id === adapter.capability.id));
  assert.equal(configuredMindAdapters(env)[0]!.capability.version, adapter.capability.version);
  const changed = configuredMindAdapters({ ...env, JEVYR_STDIN_ARGS_JSON: JSON.stringify(["-e", emit(output) + "\n"]) })[0]!;
  assert.notEqual(changed.capability.version, adapter.capability.version);
  assert.equal(JSON.stringify(adapter.capability).includes(process.execPath), false);
  assert.throws(() => new TextStdinMindAdapter({ command: process.execPath, cwd: process.cwd() } as never), /does not accept cwd/u);
  for (const invalid of [
    { JEVYR_STDIN_ARGS_JSON: "[]" },
    { JEVYR_STDIN_COMMAND: "" },
    { ...env, JEVYR_STDIN_ARGS_JSON: "not JSON" },
    { ...env, JEVYR_STDIN_ARGS_JSON: '{"args":[]}' },
    { ...env, JEVYR_STDIN_ARGS_JSON: "[3]" },
    { ...env, JEVYR_STDIN_ARGS_JSON: JSON.stringify(["nul\0byte"]) },
    { ...env, JEVYR_STDIN_TIMEOUT_MS: "00" },
    { ...env, JEVYR_STDIN_TIMEOUT_MS: "86400001" },
  ]) assert.throws(() => configuredMindAdapters(invalid));
});

test("text/stdin gets only the projected prompt in a fresh workspace and meters both exact output pipes", async () => {
  const source = `
    const fs = require('node:fs');
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => input += chunk);
    process.stdin.on('end', () => {
      const body = JSON.stringify({input,pwd:process.env.PWD,entries:fs.readdirSync('.'),init:process.env.INIT_CWD,workspace:process.env.CUSTOM_WORKSPACE_FILE,daemon:process.env.JEVYR_STDIN_ARGS_JSON,hasAuth:Boolean(process.env.PROVIDER_AUTH_TOKEN)});
      process.stdout.write(JSON.stringify({contributions:[{kind:'observation',summary:process.cwd(),body}]}));
      process.stderr.write('bounded diagnostic æ');
    });`;
  const adapter = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", source] }, {
    ...process.env, INIT_CWD: process.cwd(), CUSTOM_WORKSPACE_FILE: join(process.cwd(), "private.txt"),
    JEVYR_STDIN_ARGS_JSON: JSON.stringify([process.cwd()]), PROVIDER_AUTH_TOKEN: "installation-auth",
  });
  const invoked = request();
  const result = await adapter.runMetered(invoked);
  assert.equal(result.contributions.length, 1);
  const contribution = result.contributions[0]!;
  const body = JSON.parse(contribution.body!);
  assert.equal(body.input, invoked.preparedPublicPrompt);
  assert.equal(body.input.includes(invoked.sealed.intent.impulse), false);
  assert.equal(body.pwd, contribution.summary);
  assert.notEqual(body.pwd, process.cwd());
  assert.deepEqual(body.entries, []);
  assert.equal(body.init, undefined);
  assert.equal(body.workspace, undefined);
  assert.equal(body.daemon, undefined);
  assert.equal(body.hasAuth, true);
  assert.equal(await absent(body.pwd), true, "temporary workspace must be removed after completion");
  const raw = JSON.stringify({ contributions: [{ kind: "observation", summary: contribution.summary, body: contribution.body }] });
  assert.equal(result.transmittedInputBytes, Buffer.byteLength(invoked.preparedPublicPrompt!));
  assert.equal(result.receivedOutputBytes, Buffer.byteLength(raw + "bounded diagnostic æ"));
  assert.equal(result.tokenUsage.input.tokens, result.transmittedInputBytes);
  assert.equal(result.tokenUsage.output.tokens, result.receivedOutputBytes);
  assert.equal(result.tokenUsage.output.measurement, "UPPER_BOUND");
});

test("text/stdin probe uses its configured argv in quarantine without exposing provider diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-stdin-probe-"));
  const marker = join(root, "probe.json");
  try {
    const probe = `require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify({cwd:process.cwd(),entries:require('node:fs').readdirSync('.')}));process.stdout.write('provider-secret-diagnostic');`;
    const adapter = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", "process.exit(1)"], probeArgs: ["-e", probe] });
    const result = await adapter.probe();
    assert.equal(result.available, true);
    assert.equal(JSON.stringify(result).includes("provider-secret"), false);
    const captured = JSON.parse(await readFile(marker, "utf8"));
    assert.deepEqual(captured.entries, []);
    assert.notEqual(captured.cwd, process.cwd());
    assert.equal(await absent(captured.cwd), true);
    assert.equal((await new TextStdinMindAdapter({ command: process.execPath }).probe()).available, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("text/stdin rejects malformed documents, duplicate JSON keys, replacement UTF-8 and self-reported usage", async () => {
  for (const text of [
    `Here is my answer: ${output}`, `\`\`\`json\n${output}\n\`\`\``, `${output}\n${output}`,
    '{"contributions":[{"kind":"claim","summary":"a","summary":"b"}]}',
    JSON.stringify({ contributions: [{ kind: "claim", summary: "fine" }], usage: { input_tokens: 0, output_tokens: 0 } }),
  ]) {
    const adapter = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", emit(text)] });
    await assert.rejects(adapter.runMetered(request()), /complete structured UTF-8 contributions/u);
  }
  const invalid = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from([0xff,0x80])));"] });
  await assert.rejects(invalid.runMetered(request()), /complete structured UTF-8 contributions/u);
});

test("text/stdin refuses unembodiable DIVERGE output and admits finite structured candidates", async () => {
  const divergent = { ...request(), stage: "diverge", role: "divergent" } as const;
  const noSource = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", emit(JSON.stringify({ contributions: [{ kind: "candidate", summary: "A counter idea" }] }))] });
  await assert.rejects(noSource.runMetered(divergent), /complete structured/u);
  const finite = JSON.stringify({ contributions: [{ kind: "candidate", summary: "A finite counter", blueprint: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: "main.py", content: "print(1)\n" }] } }] });
  const adapter = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", emit(finite)] });
  const result = await adapter.runMetered(divergent);
  assert.equal(result.contributions[0]!.candidateBlueprintSource?.protocol, "jevyr.candidate-blueprint/1");
});

test("text/stdin fails before spawn for exhausted input and kills excessive, timed-out or failed outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-stdin-limits-"));
  try {
    const marker = join(root, "spawned");
    const executable = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'spawned');${emit(output)}`] });
    await assert.rejects(executable.runMetered({ ...request(), maxInputTokens: 1 }), (error: any) => error.transmittedInputBytes === 0 && /sealed token grant/u.test(error.message));
    assert.equal(await absent(marker), true);
    await assert.rejects(executable.runMetered({ ...request(), signal: AbortSignal.abort() }), (error: any) => error.transmittedInputBytes === 0);
    assert.equal(await absent(marker), true);
    const excess = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", `${emit(output)}process.stderr.write('x'.repeat(10000));`], maxOutputBytes: 1000 });
    await assert.rejects(excess.runMetered({ ...request(), maxOutputTokens: 500 }), /bounded output grant/u);
    const timeout = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", "setTimeout(()=>{},10000)"], timeoutMs: 100 });
    await assert.rejects(timeout.runMetered(request()), /timed out/u);
    const failure = new TextStdinMindAdapter({ command: process.execPath, args: ["-e", "process.stderr.write('secret-private-provider-diagnostic');process.exit(3)"] });
    await assert.rejects(failure.runMetered(request()), (error: Error) => /did not exit successfully/u.test(error.message) && !error.message.includes("secret"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identical provider statements retain IDs within an invocation and differ between invocation seeds", () => {
  const first = request();
  const same = parsePublicContributions(output, "mind.text-stdin.configured", first, { strictStructured: true })[0]!.id;
  assert.equal(parsePublicContributions(output, "mind.text-stdin.configured", { ...first }, { strictStructured: true })[0]!.id, same);
  assert.notEqual(parsePublicContributions(output, "mind.text-stdin.configured", { ...first, seed: "stdin-invocation-b" }, { strictStructured: true })[0]!.id, same);
});
