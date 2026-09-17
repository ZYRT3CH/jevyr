import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, lstat, link } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalize, digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { runBoundedProcess } from "../src/process.js";
import { createRepositoryTestControllerRequest, repositoryTestControllerSource, summarizeRepositoryTestEvents, type RepositoryTestControllerRequest } from "../src/repository-test-controller.js";
import { checkRepositorySuiteReportConsistency, type RepositorySubjectEvaluation } from "../src/repository-evaluation-plan.js";

// ONLY these trusted literal fixture programs run on the host. This suite must
// never accept repository paths or imported subject code as host test inputs.
async function fixture(files: Record<string, string>, action: (state: { root: string; subject: RepositorySubjectEvaluation; request: RepositoryTestControllerRequest; execute: (request?: unknown) => Promise<{ code: number | null; stderr: string; value: any }> }) => Promise<void>) {
  const parent = resolve(await mkdtemp(join(tmpdir(), "jevyr-node-controller-"))), identity = await lstat(parent), root = join(parent, "subject");
  await mkdir(root);
  const implementation = await repositoryTestControllerSource(), controller = join(parent, "controller.mjs"); await writeFile(controller, implementation.bytes);
  const inventory = Object.entries(files).sort(([a], [b]) => a < b ? -1 : 1).map(([path, content]) => ({ path, digest: sha256Digest(content), bytes: Buffer.byteLength(content) }));
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
  const subject: RepositorySubjectEvaluation = { subjectId: "trusted-unit-fixture", manifestDigest: sha256Digest("unit-manifest"), status: "ready", suiteDigest: digestJson(inventory as unknown as JsonValue),
    testFiles: inventory.filter(file => file.path.endsWith(".test.mjs")), sourceFiles: inventory, configFiles: [], discoveredTestFiles: inventory.filter(file => file.path.endsWith(".test.mjs")).length,
    authority: "comparative-only", obligationIds: [], refusals: [], runner: { id: "node-test-v1", evaluatorDigest: implementation.digest, immutableImageId: sha256Digest("UNTRUSTED-UNIT-ONLY-NO-OCI"), capabilityId: "unit.fixture" } };
  const request = createRepositoryTestControllerRequest(subject, root, { timeoutMs: 3000 });
  const execute = async (selected: unknown = request) => {
    const result = await runBoundedProcess({ command: process.execPath, args: [controller], cwd: parent, env: {}, inheritEnv: false,
      stdin: JSON.stringify(selected), timeoutMs: 6000, maxOutputBytes: 2_000_000 });
    assert.equal(result.timedOut, false, "Trusted fixture controller itself must terminate within the host watchdog");
    return { code: result.exitCode, stderr: result.stderr, value: result.stdout ? JSON.parse(result.stdout) : null };
  };
  try { await action({ root, subject, request, execute }); }
  finally {
    const current = await lstat(parent); assert.equal(dirname(parent), resolve(tmpdir())); assert.ok(basename(parent).startsWith("jevyr-node-controller-"));
    assert.ok(current.isDirectory() && !current.isSymbolicLink()); assert.equal(current.ino, identity.ino); assert.equal(current.dev, identity.dev);
    await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
  }
}
test("controller runs explicit original-source tests in children and independently replays real assertion counts", async () => {
  await fixture({ "math.mjs": "export const add=(a,b)=>a+b;", "a.test.mjs": "import test from 'node:test';import assert from 'node:assert/strict';import {add} from './math.mjs';test('addition',()=>{assert.equal(add(2,3),5);console.log(JSON.stringify({fixtureChildPid:process.pid}));});",
    "b.test.mjs": "import {describe,it} from 'node:test';import assert from 'node:assert/strict';describe('nested',()=>{it('passes',()=>assert.ok(true));it('actual failure',()=>assert.equal(1,2));});" }, async ({ root, request, execute }) => {
    const { code, stderr, value } = await execute(); assert.equal(code, 0); assert.equal(stderr, "");
    assert.equal(value.authority, "none"); assert.equal(value.runner, "node:test.run/process"); assert.deepEqual(value.problems, []);
    const childIdentity = JSON.parse(value.events.find((event: any) => event.type === "test:stdout" && event.data.message.includes("fixtureChildPid")).data.message);
    assert.ok(Number.isSafeInteger(childIdentity.fixtureChildPid)); assert.notEqual(childIdentity.fixtureChildPid, value.controllerPid, "The controlled fixture must execute outside the controller process");
    assert.deepEqual(value.report, { protocol: "jevyr.repository-suite-controller-report/1", suiteDigest: request.suiteDigest, complete: true, executedTests: 3, passed: 2, failed: 1, errors: 0, skipped: 0, cancelled: 0, fileOnlyPasses: 0 });
    assert.equal(checkRepositorySuiteReportConsistency(value.report, request.suiteDigest).outcome, "fail");
    const replay = await summarizeRepositoryTestEvents(value.events, request, value.stream, value.inventory); assert.deepEqual(replay, { report: value.report, problems: value.problems });
    const changed = structuredClone(value.events); changed.find((event: any) => event.type === "test:fail" && event.data.details.type === "test").type = "test:pass";
    assert.equal((await summarizeRepositoryTestEvents(changed, request, value.stream, value.inventory)).report.complete, false);
    const linuxEvents = JSON.parse(JSON.stringify(value.events, (_key, item) => typeof item === "string" && item.startsWith(root) ? `/subject/subject-0000${item.slice(root.length).replaceAll("\\", "/")}` : item));
    const linuxStream = { ...value.stream, observedEventBytes: linuxEvents.reduce((sum: number, event: JsonValue) => sum + Buffer.byteLength(canonicalize(event)), 0) };
    const linuxReplay = await summarizeRepositoryTestEvents(linuxEvents, { ...request, root: "/subject/subject-0000" }, linuxStream, value.inventory);
    assert.deepEqual(linuxReplay, replay, "OCI Linux paths must replay consistently on a Windows host");
  });
});
test("subject stdout JSON and TAP never replace actual Node tests", async () => {
  const output = "console.log('TAP version 13\\n1..1\\nok 1 invented');console.log(JSON.stringify({executedTests:100,passed:100,complete:true}));";
  await fixture({ "spoof.test.mjs": output }, async ({ execute }) => {
    const { value } = await execute(); assert.equal(value.report.executedTests, 0); assert.equal(value.report.complete, false); assert.equal(value.report.fileOnlyPasses, 1);
    assert.ok(value.events.some((event: any) => event.type === "test:stdout")); assert.ok(value.problems.includes("FILE_ONLY_SYNTHETIC_PASS"));
  });
  await fixture({ "real.test.mjs": `import test from 'node:test';${output}test('one real test',()=>{});` }, async ({ execute }) => {
    const { value } = await execute(); assert.equal(value.report.complete, true); assert.equal(value.report.executedTests, 1); assert.equal(value.report.passed, 1);
  });
});
test("empty declarations and process.exit(0) are incomplete, never successful suites", async () => {
  for (const source of ["", "import 'node:test';", "process.exit(0);"]) await fixture({ "empty.test.mjs": source }, async ({ execute }) => {
    const { value } = await execute(); assert.equal(value.report.complete, false); assert.equal(value.report.executedTests, 0); assert.ok(value.problems.includes("NO_EXECUTED_TESTS"));
  });
});
test("skips, todo, cancellations, loader errors and test exceptions refuse complete evidence", async () => {
  for (const source of ["import test from 'node:test';test.skip('skip',()=>{});", "import test from 'node:test';test.todo('later');",
    "import test from 'node:test';test('parent',t=>{t.test('child',async()=>await new Promise(()=>{}));});",
    "throw new Error('trusted fixture loader error');", "import test from 'node:test';test('unexpected error',()=>{throw new Error('not an assertion');});"]) await fixture({ "incomplete.test.mjs": source }, async ({ execute }) => {
      const { value } = await execute(); assert.equal(value.report.complete, false); assert.ok(value.report.errors + value.report.skipped + value.report.cancelled > 0 || value.problems.includes("CONTROLLER_TIMEOUT"));
    });
});
test("before/after inventory binds all declared bytes and refuses missing, changed, additional and linked files", async () => {
  await fixture({ "real.test.mjs": "import test from 'node:test';test('real',()=>{});" }, async ({ root, request, execute }) => {
    const corrupt = { ...request, sourceFiles: request.sourceFiles.map(file => ({ ...file, digest: sha256Digest("wrong") })) };
    assert.equal((await execute(corrupt)).code, 2);
    await writeFile(join(root, "undeclared.mjs"), "export const extra=1;");
    const extra = await execute(); assert.equal(extra.value.report.complete, false); assert.equal(extra.value.report.executedTests, 0); assert.ok(extra.value.problems.includes("INVENTORY_BEFORE_MISMATCH"));
  });
  await fixture({ "real.test.mjs": "import test from 'node:test';test('real',()=>{});", "helper.mjs": "export const n=1;" }, async ({ root, execute }) => {
    await link(join(root, "helper.mjs"), join(dirname(root), "alias.mjs"));
    const linked = await execute(); assert.equal(linked.value.report.complete, false); assert.equal(linked.value.report.executedTests, 0);
  });
  await fixture({ "write.test.mjs": "import test from 'node:test';import {writeFileSync} from 'node:fs';test('mutation',()=>writeFileSync(new URL('./new.mjs',import.meta.url),'changed'));" }, async ({ execute }) => {
    const { value } = await execute(); assert.equal(value.report.complete, false); assert.ok(value.problems.includes("INVENTORY_AFTER_MISMATCH"));
  });
});
test("bounded capture and request validation refuse truncation and arbitrary discovery or hooks", async () => {
  await fixture({ "bounded.test.mjs": "import test from 'node:test';test('output',()=>console.log('x'.repeat(30000)));" }, async ({ subject, root, request, execute }) => {
    assert.throws(() => createRepositoryTestControllerRequest(subject, root, { timeoutMs: 1 }));
    assert.throws(() => createRepositoryTestControllerRequest({ ...subject, status: "unavailable" }, root));
    assert.equal((await execute({ ...request, execArgv: ["--import=untrusted"] })).code, 2);
    assert.equal((await execute({ ...request, testFiles: [] })).code, 2);
    const paths = { ...request, testFiles: [{ ...request.testFiles[0]!, path: "../escape.mjs" }] }; assert.equal((await execute(paths)).code, 2);
    const { value } = await execute({ ...request, limits: { ...request.limits, maxEventBytes: 1024 } });
    assert.equal(value.report.complete, false); assert.ok(value.problems.includes("EVENT_CAPTURE_LIMIT"));
  });
});
