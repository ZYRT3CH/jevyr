import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { compileIntentContract } from "@jevyr/core";
import { createSearchEnvelope } from "@jevyr/protocol";
import {
  ClaudeCliMindAdapter,
  CodexAppServerMindAdapter,
  CodexCliMindAdapter,
  DEFAULT_SEARCH_PROFILE,
  type MindRequest,
  type PublicContribution,
} from "../src/index.js";
import {
  quarantinedProviderEnvironment,
  withQuarantinedMindWorkspace,
} from "../src/adapters/process-quarantine.js";
import { codexBoundaryConfig, CODEX_PERMISSION_PROFILE } from "../src/adapters/codex-boundary.js";
import { secretReference } from "../src/secret-broker.js";
import { MindMeteredFailure } from "../src/mind-metering.js";
const codexAuthorization={model:"fixture-model",credential:secretReference("FIXTURE_CODEX_KEY","https://api.openai.com"),secretBroker:{authorization:()=>"Bearer fixture-key"}};

const contract = compileIntentContract({ impulse: "Inspect the sealed specimen without ambient workspace access" });

function request(signal = new AbortController().signal): MindRequest {
  return {
    stage: "interpret",
    role: "interpreter",
    seed: "process-quarantine-test",
    constraints: [],
    publicFacts: [],
    signal,
    sealed: {
      protocol: "jevyr.case/1",
      caseId: "case_process_quarantine",
      submissionDigest: `sha256:${"0".repeat(64)}`,
      caseDigest: `sha256:${"1".repeat(64)}`,
      runDigest: `sha256:${"2".repeat(64)}`,
      sealedAt: "2026-09-04T12:00:00.000Z",
      policyVersion: "jevyr.bone/1",
      policyDigest: `sha256:${"3".repeat(64)}`,
      genomeVersion: "jevyr.genome/1",
      genomeDigest: `sha256:${"4".repeat(64)}`,
      searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
      intentContractDigest: contract.digest,
      intentContract: contract,
      intent: {
        impulse: "Inspect the sealed specimen without ambient workspace access",
        mode: "auto",
        subjects: [],
        constraints: [],
        requestedAssays: [],
        privacy: "local_only",
        control: "sovereign",
        seed: "process-quarantine-test",
      },
      subjects: [],
    },
  };
}

async function absent(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch {
    return true;
  }
}

test("quarantined mind workspaces start empty, scrub ambient pointers, and are removed", async () => {
  let workspace = "";
  await withQuarantinedMindWorkspace(async (directory) => {
    workspace = directory;
    const env = quarantinedProviderEnvironment(directory, {
      PATH: process.env.PATH,
      PWD: process.cwd(),
      INIT_CWD: process.cwd(),
      PROJECT_CWD: process.cwd(),
      CUSTOM_WORKSPACE_FILE: join(process.cwd(), "private.txt"),
      PROVIDER_AUTH_TOKEN: "preserved",
    });
    assert.equal(env.PWD, directory);
    assert.equal(env.INIT_CWD, undefined);
    assert.equal(env.PROJECT_CWD, undefined);
    assert.equal(env.CUSTOM_WORKSPACE_FILE, undefined);
    assert.equal(env.PROVIDER_AUTH_TOKEN, "preserved");
    assert.deepEqual(await readdir(directory), []);
  });
  assert.equal(await absent(workspace), true);
});

test("command-backed minds execute in a fresh directory and clean it after process close", async () => {
  const source = [
    'const fs = require("node:fs");',
    "const body = JSON.stringify({ pwd: process.env.PWD, entries: fs.readdirSync(\".\") });",
    "const text = JSON.stringify({ contributions: [{ kind: \"observation\", summary: process.cwd(), body }] });",
    "process.stdout.write(JSON.stringify({ result: text }));",
  ].join("\n");
  const adapter = new ClaudeCliMindAdapter({
    command: process.execPath,
    launcherArgs: ["-e", source, "--"],
  });
  const invoke = async (): Promise<PublicContribution[]> => {
    const contributions: PublicContribution[] = [];
    for await (const contribution of adapter.run(request())) contributions.push(contribution);
    return contributions;
  };
  const first = await invoke();
  const second = await invoke();
  assert.equal(first.length, 1);
  assert.equal(second.length, 1);
  const contribution = first[0];
  const secondContribution = second[0];
  assert.ok(contribution);
  assert.ok(secondContribution);
  assert.notEqual(contribution.summary, secondContribution.summary);
  assert.notEqual(contribution.summary, process.cwd());
  assert.match(contribution.summary, /jevyr-mind-/);
  assert.deepEqual(JSON.parse(contribution.body ?? "{}"), { pwd: contribution.summary, entries: [] });
  assert.equal(await absent(contribution.summary), true);
  assert.equal(await absent(secondContribution.summary), true);
});

test("process-backed adapters reject caller-selected working directories and report tool capability honestly", () => {
  assert.throws(
    () => new CodexCliMindAdapter({ cwd: process.cwd() } as never),
    /does not accept cwd/,
  );
  assert.throws(
    () => new ClaudeCliMindAdapter({ cwd: process.cwd() } as never),
    /does not accept cwd/,
  );
  assert.throws(
    () => new CodexAppServerMindAdapter({ cwd: process.cwd() } as never),
    /does not accept cwd/,
  );
  assert.equal(new CodexCliMindAdapter().capability.canExecuteTools, false);
  assert.equal(new CodexAppServerMindAdapter().capability.canExecuteTools, false);
  assert.equal(new ClaudeCliMindAdapter().capability.canExecuteTools, false);
});

test("process-backed capability probes cannot observe the daemon working directory", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "jevyr-process-probe-test-"));
  const marker = join(fixture, "probe.json");
  const source = [
    'const fs = require("node:fs");',
    `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, entries: fs.readdirSync(".") }));`,
    'process.stdout.write("fixture-provider 1.0\\n");',
  ].join("\n");
  try {
    const result = await new CodexCliMindAdapter({
      command: process.execPath,
      launcherArgs: ["-e", source, "--"],
    }).probe();
    const observed = JSON.parse(await readFile(marker, "utf8")) as { cwd: string; pwd: string; entries: string[] };
    assert.equal(result.available, false); // Legacy Codex inference deliberately stays closed.
    assert.equal(observed.pwd, observed.cwd);
    assert.notEqual(observed.cwd, process.cwd());
    assert.deepEqual(observed.entries, []);
    assert.equal(await absent(observed.cwd), true);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function fakeAppServerSource(marker: string, outcome: "completed" | "failed" | "silent" | "stubborn" | "tool-failed"): string {
  return [
    'const fs = require("node:fs");',
    'const readline = require("node:readline");',
    `const marker = ${JSON.stringify(marker)};`,
    "let threadCwd = null;",
    `const config = ${JSON.stringify(codexBoundaryConfig("CONFIG_CONTEXT_PLACEHOLDER"))};`,
    `config.permissions[${JSON.stringify(CODEX_PERMISSION_PROFILE)}].filesystem = { ":minimal": "read", [process.cwd()]: "read" };`,
    ...(outcome === "stubborn"
      ? ["setInterval(() => undefined, 1_000);", "process.on(\"SIGTERM\", () => undefined);"]
      : []),
    "const record = () => fs.writeFileSync(marker, JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, pid: process.pid, threadCwd }));",
    "record();",
    "const send = (value) => process.stdout.write(JSON.stringify(value) + \"\\n\");",
    "const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });",
    "lines.on(\"line\", (line) => {",
    "  const message = JSON.parse(line);",
    "  if (typeof message.id !== \"number\") return;",
    ...(outcome === "tool-failed" ? [
      '  if (message.id === 777 && message.result) { fs.writeFileSync(marker, JSON.stringify({ ...JSON.parse(fs.readFileSync(marker,"utf8")), toolBytes: Buffer.byteLength(message.result.contentItems[0].text) })); send({method:"turn/completed",params:{threadId:"thread-1",turn:{id:"turn-1",status:"failed"}}}); return; }',
    ] : []),
    "  if (message.method === \"initialize\") send({ id: message.id, result: { userAgent: \"jevyr/0.153.1 fixture\", codexHome: process.env.CODEX_HOME } });",
    "  if (message.method === \"config/read\") send({ id: message.id, result: {config} });",
    "  if (message.method === \"account/login/start\") send({ id: message.id, result: {type:\"apiKey\"} });",
    "  if (message.method === \"thread/start\") {",
    "    threadCwd = message.params.cwd; record();",
    `    send({id:message.id,result:{thread:{id:"thread-1"},cwd:threadCwd,model:message.params.model,modelProvider:"openai",approvalPolicy:"never",activePermissionProfile:{id:${JSON.stringify(CODEX_PERMISSION_PROFILE)},extends:null},instructionSources:[],runtimeWorkspaceRoots:[]}});`,
    "  }",
    "  if (message.method === \"turn/start\") {",
    "    send({ jsonrpc: \"2.0\", id: message.id, result: { turn: { id: \"turn-1\" } } });",
    ...(outcome === "tool-failed" ? ['    setTimeout(() => send({id:777,method:"item/tool/call",params:{threadId:"thread-1",turnId:"turn-1",callId:"source-call",tool:"list_subject_files",arguments:{}}}), 10);'] : []),
    ...(outcome === "completed" || outcome === "failed"
      ? [
          "    setTimeout(() => {",
          "      const text = JSON.stringify({ contributions: [{ kind: \"observation\", summary: process.cwd(), body: JSON.stringify({ pwd: process.env.PWD, entries: fs.readdirSync(\".\"), threadCwd }) }] });",
          "      send({method:\"thread/tokenUsage/updated\",params:{threadId:\"thread-1\",turnId:\"turn-1\",tokenUsage:{total:{inputTokens:100,outputTokens:40}}}});",
          "      send({ jsonrpc: \"2.0\", method: \"item/completed\", params: { threadId:\"thread-1\",turnId:\"turn-1\",item: { type: \"agentMessage\", text } } });",
          `      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId:"thread-1",turn: { id: "turn-1", status: ${JSON.stringify(outcome)} } } });`,
          "    }, 10);",
        ]
      : []),
    "  }",
    "});",
  ].join("\n");
}

async function readMarker(marker: string): Promise<{ cwd: string; pwd: string; pid: number; threadCwd: string }> {
  return JSON.parse(await readFile(marker, "utf8")) as {
    cwd: string;
    pwd: string;
    pid: number;
    threadCwd: string;
  };
}

test("Codex adapter preserves metered source-tool failure through process and quarantine cleanup", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "jevyr-app-metering-test-")), marker = join(fixture, "process.json");
  try {
    const adapter = new CodexAppServerMindAdapter({ ...codexAuthorization, command: process.execPath,
      launcherArgs: ["-e", fakeAppServerSource(marker, "tool-failed"), "--"], timeoutMs: 5_000, shutdownGraceMs: 250 });
    const input = { ...request(), investigationTools: true, preparedPublicPrompt: "A finite projected subject request." };
    let chargedInputBytes = 0;
    await assert.rejects(adapter.runMetered(input), (error: unknown): boolean => {
      assert.ok(error instanceof MindMeteredFailure);
      chargedInputBytes = error.transmittedInputBytes;
      assert.equal(error.message.includes("fixture-key"), false);
      return true;
    });
    const observed = JSON.parse(await readFile(marker, "utf8"));
    assert.ok(observed.toolBytes > 0);
    assert.ok(chargedInputBytes >= (Buffer.byteLength(input.preparedPublicPrompt) + observed.toolBytes) * 4);
    assert.equal(await absent(observed.cwd), true);
    assert.throws(() => process.kill(observed.pid, 0));
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("Codex app-server uses its quarantine for both child and thread and exits before cleanup", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "jevyr-app-server-test-"));
  const marker = join(fixture, "process.json");
  try {
    const adapter = new CodexAppServerMindAdapter({
      ...codexAuthorization,
      command: process.execPath,
      launcherArgs: ["-e", fakeAppServerSource(marker, "completed"), "--"],
      timeoutMs: 5_000,
      shutdownGraceMs: 250,
    });
    const contributions: PublicContribution[] = [];
    for await (const contribution of adapter.run(request())) contributions.push(contribution);
    const observed = await readMarker(marker);
    assert.equal(contributions[0]?.summary, observed.cwd);
    assert.equal(observed.pwd, observed.cwd);
    assert.equal(observed.threadCwd, observed.cwd);
    assert.notEqual(observed.cwd, process.cwd());
    assert.deepEqual(JSON.parse(contributions[0]?.body ?? "{}"), {
      pwd: observed.cwd,
      entries: [],
      threadCwd: observed.cwd,
    });
    assert.equal(await absent(observed.cwd), true);
    assert.throws(() => process.kill(observed.pid, 0));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Codex app-server timeout waits for child termination before removing its quarantine", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "jevyr-app-server-timeout-test-"));
  const marker = join(fixture, "process.json");
  try {
    const adapter = new CodexAppServerMindAdapter({
      ...codexAuthorization,
      command: process.execPath,
      launcherArgs: ["-e", fakeAppServerSource(marker, "stubborn"), "--"],
      timeoutMs: 200,
      shutdownGraceMs: 50,
    });
    await assert.rejects(async () => {
      for await (const _ of adapter.run(request())) {
        // No contribution can cross a timed-out provider boundary.
      }
    });
    const observed = await readMarker(marker);
    assert.equal(observed.threadCwd, observed.cwd);
    assert.equal(await absent(observed.cwd), true);
    assert.throws(() => process.kill(observed.pid, 0));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Codex app-server failed turns still terminate before quarantine cleanup", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "jevyr-app-server-failure-test-"));
  const marker = join(fixture, "process.json");
  try {
    const adapter = new CodexAppServerMindAdapter({
      ...codexAuthorization,
      command: process.execPath,
      launcherArgs: ["-e", fakeAppServerSource(marker, "failed"), "--"],
      timeoutMs: 5_000,
      shutdownGraceMs: 250,
    });
    await assert.rejects(async () => {
      for await (const _ of adapter.run(request())) {
        // Failed provider turns cannot publish contributions.
      }
    }, /isolated native harness/);
    const observed = await readMarker(marker);
    assert.equal(await absent(observed.cwd), true);
    assert.throws(() => process.kill(observed.pid, 0));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
