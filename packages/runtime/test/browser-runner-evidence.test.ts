import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const html = '<button>Advance</button><span id="count">0</span><script src="counter.js"></script>';
const script = 'let count=0;document.querySelector("button").onclick=()=>count++;';

// The real standalone evaluator runs in a child, against its real HTTP file server.
// Only Playwright is replaced here, allowing deterministic browser and capture errors.
const playwrightFixture = `
import { writeFile } from 'node:fs/promises';
const fixture = process.env.JEVYR_BROWSER_FIXTURE;
let value = '0', origin;
const page = {
  setDefaultTimeout() {}, on() {},
  async goto(url) { origin = new URL(url).origin; await fetch(url); await fetch(origin + '/counter.js'); },
  locator() { return {
    async click() { value = fixture === 'wrong' ? '2' : '1'; }, async fill(text) { value = text; },
    async textContent() { return fixture === 'huge' ? 'x'.repeat(20000) : value; }, async count() { return 9; },
  }; },
  coverage: { async startJSCoverage() {}, async stopJSCoverage() {
    if (fixture === 'capture-failed') throw new Error('coverage unavailable');
    return [{ scriptId: '1', url: origin + '/counter.js', source: ${JSON.stringify(script)}, functions: [{ functionName: 'handler', ranges: [{ startOffset: 0, endOffset: 12, count: 1 }] }] },
      { scriptId: '2', url: '', source: fixture === 'oversize-script' ? 'x'.repeat(524289) : 'let dynamic=1;', functions: [] }];
  } },
  async screenshot({ path }) { if (fixture === 'capture-failed') throw new Error('screenshot unavailable'); await writeFile(path, 'fresh screenshot'); },
};
const context = {
  async route() {}, async newPage() { return page; },
  tracing: { async start() {}, async stop({ path }) { if (fixture === 'capture-failed') throw new Error('trace unavailable'); await writeFile(path, 'fresh trace'); } },
};
export const chromium = { async launch() { return { async newContext() { return context; }, async close() { if (fixture === 'capture-failed') throw new Error('browser close unavailable'); } }; } };
`;

async function runFixture(fixture: string, steps: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), "jevyr-browser-runner-test-"));
  try {
    const work = join(root, "work");
    const dependency = join(root, "node_modules", "playwright");
    await mkdir(work); await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, "package.json"), JSON.stringify({ type: "module", exports: "./index.mjs" }));
    await writeFile(join(dependency, "index.mjs"), playwrightFixture);
    await copyFile(new URL("../../../scripts/browser-forge/browser-probe.mjs", import.meta.url), join(root, "runner.mjs"));
    await writeFile(join(work, "index.html"), html); await writeFile(join(work, "counter.js"), script);
    // Preexisting candidate artifacts must never substitute for failed captures.
    await writeFile(join(work, "jevyr.browser.png"), "counterfeit screenshot");
    await writeFile(join(work, "jevyr.browser.trace.zip"), "counterfeit trace");
    const spec = { protocol: "jevyr.browser-probe/1", entry: "index.html", steps };
    const result = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((done) => {
      execFile(process.execPath, [join(root, "runner.mjs"), Buffer.from(JSON.stringify(spec)).toString("base64url")], {
        cwd: work, windowsHide: true, timeout: 10_000, maxBuffer: 1_048_576,
        env: { ...process.env, JEVYR_BROWSER_FIXTURE: fixture },
      }, (error, stdout, stderr) => done({ exitCode: typeof error?.code === "number" ? error.code : error ? -1 : 0, stdout, stderr }));
    });
    assert.equal(result.stderr, "");
    const raw = await readFile(join(work, "jevyr.browser.observation.json"), "utf8");
    const report = JSON.parse(raw);
    assert.equal(JSON.parse(result.stdout).reportDigest, digest(raw));
    for (const artifact of report.artifacts) assert.equal(artifact.digest, digest(await readFile(join(work, artifact.path))));
    return { ...result, report };
  } finally {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + (process.platform === "win32" ? "\\" : "/")));
    await rm(root, { recursive: true, force: true });
  }
}

test("browser failed text and count assertions retain observed behavior and source-linked runtime bytes", async () => {
  const { report, exitCode } = await runFixture("wrong", [{ action: "click", selector: "button" }, { action: "assert-text", selector: "#count", expected: "1" }]);
  assert.equal(exitCode, 1); assert.equal(report.passed, false); assert.equal(report.evidenceComplete, true);
  assert.deepEqual(report.events[1], { index: 1, action: "assert-text", selector: "#count", expected: "1", status: "failed", observed: "2", failure: "Assertion 1 text mismatch" });
  assert.equal(report.runtime[0].source.sourceDigest, digest(script));
  assert.equal(report.runtime[0].sourceText, script);
  assert.equal(report.runtime[1].url, "anonymous");
  assert.equal(report.runtime[1].scriptDigest, digest(report.runtime[1].sourceText));
  assert.equal(report.attributionIsCausation, false);
  const count = await runFixture("wrong", [{ action: "assert-count", selector: "p", expected: 1 }]);
  assert.equal(count.report.events[0].observed, 9); assert.equal(count.report.events[0].expected, 1);
});

test("browser report bounds failed text while preserving its exact digest and length", async () => {
  const { report } = await runFixture("huge", [{ action: "assert-text", selector: "p", expected: "small" }]);
  const event = report.events[0];
  assert.equal(event.observed.length, 8192); assert.equal(event.observedTruncated, true);
  assert.equal(event.observedLength, 20_000); assert.equal(event.observedDigest, digest("x".repeat(20_000)));
});

test("browser salvages assertion outcomes after capture and cleanup failure without accepting stale artifacts", async () => {
  const { report, exitCode } = await runFixture("capture-failed", [{ action: "assert-text", selector: "#count", expected: "0" }]);
  assert.equal(exitCode, 0); assert.equal(report.assertionsPassed, true); assert.equal(report.evidenceComplete, false);
  assert.deepEqual(report.collectionFailures.map((failure: { phase: string }) => failure.phase), ["coverage", "screenshot", "trace", "browser-close"]);
  assert.deepEqual(report.artifacts, []); assert.equal(report.coverageComplete, false);
});

test("browser source-budget omissions remain visible and cannot satisfy complete trace evidence", async () => {
  const { report } = await runFixture("oversize-script", [{ action: "assert-text", selector: "#count", expected: "0" }]);
  assert.equal(report.evidenceComplete, false); assert.equal(report.runtimeComplete, false);
  assert.equal(report.runtime[1].sourceComplete, false); assert.equal(report.runtime[1].sourceText, undefined);
  assert.equal(report.runtime[1].sourceByteLength, 524289);
  assert.equal(report.runtime[1].sourceOmission, "script-source-budget");
});
