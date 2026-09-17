import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile, link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import type { CaseSubmission, SealReceipt } from "@jevyr/protocol";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { parseMultipartCast, processDropFolder, serveJsonl } from "../src/transports.js";
import { serveMcpBackend } from "../src/mcp.js";
import { parseA2aCast } from "../src/a2a.js";

const submission: CaseSubmission = { protocol: "jevyr.case/1", case: { impulse: "Create and judge a small counter", privacy: "local_only", control: "sovereign", seed: "transport-equivalence", subjects: [{ id: "subject-1", kind: "text", locator: "A counter with an increment button." }] } };
function multipart(parts: readonly [string, string | Buffer][], boundary = "jevyr-boundary"): Buffer {
  return Buffer.concat([...parts.flatMap(([name, bytes]) => [Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`), Buffer.from(bytes), Buffer.from("\r\n")]), Buffer.from(`--${boundary}--\r\n`)]);
}
async function* input(bytes: string | Buffer): AsyncIterable<Uint8Array> { yield Buffer.from(bytes); }
const a2a = (value: CaseSubmission, returnImmediately = true) => ({ message: { role: "ROLE_USER", messageId: "test-submission", parts: [{ data: value }] }, configuration: { returnImmediately } });

test("CLI, HTTP JSON, multipart uploads, JSONL, drop bundle, MCP, and A2A seal identical Case identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-transports-"));
  const runtime = createDaemonRuntime({ dataDir: join(root, "store"), minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime });
  const receipts: SealReceipt[] = [];
  try {
    const { url } = await service.listen(0);
    assert.ok(service.fastify.version.startsWith("5."));
    const json = await fetch(`${url}/v1/cases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission) });
    assert.equal(json.status, 202);
    receipts.push(await json.json() as SealReceipt);
    const cli = await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL("../../cli/node_modules/tsx/dist/cli.mjs", import.meta.url)),
      "--conditions=development", fileURLToPath(new URL("../../cli/src/main.ts", import.meta.url)),
      "cast", submission.case.impulse, "--seed", submission.case.seed!,
      "--subject", `text:${submission.case.subjects![0]!.locator}`, "--privacy", "local_only", "--control", "sovereign", "--url", url, "--json",
    ], { cwd: root, windowsHide: true, timeout: 30_000 });
    receipts.push(JSON.parse(cli.stdout) as SealReceipt);
    const uploaded = structuredClone(submission);
    uploaded.case.subjects![0]!.locator = "upload:subject-1";
    const form = await fetch(`${url}/v1/cases`, { method: "POST", headers: { "content-type": "multipart/form-data; boundary=jevyr-boundary" }, body: multipart([["case", JSON.stringify(uploaded)], ["subject:subject-1", submission.case.subjects![0]!.locator]]) });
    assert.equal(form.status, 202, await form.clone().text());
    receipts.push(await form.json() as SealReceipt);
    const jsonl: string[] = [];
    await serveJsonl(runtime, { input: input(`${JSON.stringify({ protocol: "jevyr.jsonl/1", id: 1, operation: "cast", submission })}\n`), send: (line) => { jsonl.push(line); } });
    receipts.push(JSON.parse(jsonl[0]!).result as SealReceipt);
    assert.ok(["terminated", "invalid"].includes((await runtime.status(receipts.at(-1)!.caseId))!.lifecycle), "EOF must let sealed lifecycle close");
    const signedReads: any[] = [];
    await serveJsonl(runtime, { input: input(["seal-envelope", "terminal-envelope"].map((operation, index) => JSON.stringify({ protocol: "jevyr.jsonl/1", id: index, operation, caseId: receipts.at(-1)!.caseId })).concat(JSON.stringify({ protocol: "jevyr.jsonl/1", id: 3, operation: "trust" })).join("\n")), send: (line) => { signedReads.push(JSON.parse(line)); } });
    assert.ok(signedReads[0].result.signatures.length > 0);
    assert.ok(signedReads[1].result.signatures.length > 0);
    assert.equal(signedReads[2].result.protocol, "jevyr.trust-bundle/1");
    const folder = join(root, "drop");
    await mkdir(join(folder, "bundle.staging"), { recursive: true });
    await writeFile(join(folder, "bundle.staging", "case.json"), JSON.stringify(submission));
    assert.deepEqual(await processDropFolder(runtime, folder), []);
    await rename(join(folder, "bundle.staging"), join(folder, "bundle.ready"));
    const results = await processDropFolder(runtime, folder);
    assert.equal(results[0]?.state, "done");
    receipts.push(JSON.parse(await readFile(join(folder, results[0]!.bundle, "seal.json"), "utf8")) as SealReceipt);
    assert.ok(JSON.parse(await readFile(join(folder, results[0]!.bundle, "terminal.json"), "utf8")));
    assert.ok(JSON.parse(await readFile(join(folder, results[0]!.bundle, "terminal-envelope.json"), "utf8")).signatures.length > 0);
    assert.ok(JSON.parse(await readFile(join(folder, results[0]!.bundle, "seal-envelope.json"), "utf8")).signatures.length > 0);
    assert.deepEqual(await processDropFolder(runtime, folder), [], "finished bundles cannot be recast");
    const mcp: string[] = [];
    await serveMcpBackend({ ready: async () => await runtime.ready(), cast: async (intent) => (await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: intent })).receipt, status: async (id) => await runtime.status(id), record: async (id) => await runtime.repository.record(id) }, { input: input(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jevyr_cast", arguments: submission.case } })}\n`), send: (line) => { mcp.push(line); } });
    receipts.push(JSON.parse(JSON.parse(mcp[0]!).result.content[0].text));
    const peer = await fetch(`${url}/a2a/message:send`, { method: "POST", headers: { "content-type": "application/a2a+json", "a2a-version": "1.0" }, body: JSON.stringify(a2a(submission)) });
    assert.equal(peer.status, 200, await peer.clone().text());
    const peerTask = (await peer.json() as any).task;
    receipts.push(peerTask.metadata.seal);
    assert.equal(new Set(receipts.map((receipt) => receipt.caseDigest)).size, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.submissionDigest)).size, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.subjectMaterialCaptureDigest)).size, 1);
    assert.equal(new Set(receipts.map((receipt) => receipt.runDigest)).size, receipts.length);
    await Promise.all(receipts.map(async (receipt) => await runtime.orchestrator.waitForTerminal(receipt.caseId)));
    const status = await fetch(`${url}/a2a/tasks/${peerTask.id}`, { headers: { "a2a-version": "1.0" } });
    const completed = await status.json() as any;
    assert.equal(completed.status.state, (await runtime.status(peerTask.id))?.lifecycle === "invalid" ? "TASK_STATE_FAILED" : "TASK_STATE_COMPLETED");
    assert.ok(completed.metadata.terminalEnvelope);
    const lab = await fetch(`${url}/v1/genome-lab`);
    const genome = await lab.json() as any;
    assert.equal(genome.active.digest, runtime.repository.genomeDigest);
    assert.equal(genome.governance.semanticPromotion, false);
    assert.equal(JSON.stringify(genome).includes(root), false);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("multipart refuses duplicate keys, malformed UTF-8, undeclared uploads, filenames and missing boundaries", () => {
  const type = "multipart/form-data; boundary=jevyr-boundary";
  assert.deepEqual(parseMultipartCast(multipart([["case", JSON.stringify(submission)]]), type), submission);
  for (const parts of [
    [["case", JSON.stringify(submission)], ["case", JSON.stringify(submission)]],
    [["case", JSON.stringify(submission)], ["subject:unknown", "unsealed"]],
    [["case", '{"protocol":"jevyr.case/1","case":{"impulse":"a","impulse":"b"}}']],
    [["case", Buffer.from([0xff, 0x80])]],
  ] as [string, string | Buffer][][]) assert.throws(() => parseMultipartCast(multipart(parts), type));
  assert.throws(() => parseMultipartCast(multipart([["case", JSON.stringify(submission)]]).subarray(0, -10), type));
  assert.throws(() => parseMultipartCast(Buffer.from(`--jevyr-boundary\r\nContent-Disposition: form-data; name="case"; filename="../escape"\r\n\r\n{}\r\n--jevyr-boundary--\r\n`), type), /safe/u);
  assert.throws(() => parseMultipartCast(multipart([["case", JSON.stringify(submission)]]), "multipart/form-data; boundary=x; boundary=y"));
});

test("JSONL isolates oversized and malformed lines and refuses semantic continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-jsonl-"));
  const runtime = createDaemonRuntime({ dataDir: root, minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  try {
    const writes: any[] = [];
    const lines = ["x".repeat(1_048_577), '{"protocol":"jevyr.jsonl/1","id":1,"operation":"cast","submission":{},"submission":{}}', JSON.stringify({ protocol: "jevyr.jsonl/1", id: 2, operation: "continue", caseId: "case_0000000000000000", submission }), JSON.stringify({ protocol: "jevyr.jsonl/1", id: 3, operation: "cast", submission })];
    await serveJsonl(runtime, { input: input(`${lines.join("\n")}\n`), send: (line) => { writes.push(JSON.parse(line)); } });
    assert.equal(writes.length, 4);
    assert.ok(writes.slice(0, 3).every((line) => typeof line.error === "string"));
    assert.equal(writes[3].result.protocol, "jevyr.seal/1");
    assert.equal((await readdir(join(root, "cases"))).length, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("atomic drop rejects linked or extra material without writing outside the claimed root", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-drop-security-"));
  const runtime = createDaemonRuntime({ dataDir: join(root, "store"), minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  try {
    const outside = join(root, "outside");
    const folder = join(root, "drop");
    await mkdir(outside); await mkdir(folder);
    await writeFile(join(outside, "case.json"), JSON.stringify(submission));
    await symlink(outside, join(folder, "linked.ready"), "junction");
    await mkdir(join(folder, "hardlink.ready"));
    await link(join(outside, "case.json"), join(folder, "hardlink.ready", "case.json"));
    await mkdir(join(folder, "extra.ready"));
    await writeFile(join(folder, "extra.ready", "case.json"), JSON.stringify(submission));
    await writeFile(join(folder, "extra.ready", "extra.txt"), "not part of the Case");
    await mkdir(join(folder, "stale.processing"));
    await writeFile(join(folder, "stale.processing", "case.json"), JSON.stringify(submission));
    const results = await processDropFolder(runtime, folder);
    assert.equal(results.length, 3);
    assert.ok(results.every((entry) => entry.state === "failed" && !entry.caseId));
    assert.deepEqual(await readdir(outside), ["case.json"]);
    assert.ok((await readdir(folder)).includes("stale.processing"));
    assert.deepEqual(await processDropFolder(runtime, folder), []);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("A2A rejects all task/context continuation and caller verdict fields before Cast", () => {
  assert.deepEqual(parseA2aCast(a2a(submission)).submission, submission);
  for (const key of ["taskId", "contextId", "approval", "verdict", "continue"]) {
    const value = a2a(submission) as any;
    value.message[key] = "case_0000000000000000";
    assert.throws(() => parseA2aCast(value));
  }
  const metadata = { ...a2a(submission), metadata: { verdict: "ACCEPT" } };
  assert.throws(() => parseA2aCast(metadata));
});

test("A2A streams digest-bound progress through signed closure and refuses terminal subscription", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-a2a-stream-"));
  const runtime = createDaemonRuntime({ dataDir: root, minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime });
  try {
    const { url } = await service.listen(0);
    const headers = { "content-type": "application/a2a+json", "a2a-version": "1.0" };
    const refused = await fetch(`${url}/a2a/message:stream`, { method: "POST", headers: { ...headers, "last-event-id": "1" }, body: JSON.stringify(a2a(submission)) });
    assert.equal(refused.status, 400);
    const response = await fetch(`${url}/a2a/message:stream`, { method: "POST", headers, body: JSON.stringify(a2a(submission)) });
    assert.equal(response.status, 200);
    const frames = (await response.text()).split("\n\n").flatMap((frame) => frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))));
    const task = frames[0].task;
    assert.ok(task.id.startsWith("case_"));
    const events = frames.flatMap((frame) => frame.statusUpdate?.status.message?.parts?.map((part: any) => part.data) ?? []);
    assert.ok(events.length > 0);
    assert.ok(events.every((event) => event.caseDigest === task.metadata.caseDigest && event.runDigest === task.metadata.runDigest));
    assert.equal(frames.at(-1).statusUpdate.status.state, (await runtime.status(task.id))?.lifecycle === "invalid" ? "TASK_STATE_FAILED" : "TASK_STATE_COMPLETED");
    assert.ok(frames.at(-1).statusUpdate.metadata.terminalEnvelope);
    const terminal = await fetch(`${url}/a2a/tasks/${task.id}:subscribe`, { method: "POST", headers, body: "{}" });
    assert.equal(terminal.status, 409);
    assert.equal((await readdir(join(root, "cases"))).length, 1);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
