import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { RepositorySelfJudge, selfJudgeOptions, type SelfJudgeCallbacks, type SelfJudgeResult } from "../src/self-judge.js";

const result = (patch: Partial<SelfJudgeResult> = {}): SelfJudgeResult => ({ caseId: "case_0123456789abcdef", runDigest: `sha256:${"a".repeat(64)}`, proofVerified: true, integrity: "VALID", bindingFailures: [], ...patch });
const failure = { code: "ARTIFACT_DIGEST_MISMATCH", evidenceDigest: `sha256:${"b".repeat(64)}` };
const forbiddenProposal = async () => { assert.fail("No verified binding failure authorized a proposal"); };
async function fixture<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "jevyr-self-judge-test-"));
  try { return await body(root); }
  finally {
    const rel = relative(resolve(tmpdir()), resolve(root));
    assert.ok(rel.startsWith("jevyr-self-judge-test-") && !rel.includes(sep));
    await rm(root, { recursive: true, force: true });
  }
}
async function put(root: string, path: string, text: string): Promise<void> { const target = join(root, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, text); }
const enabled = (root: string) => selfJudgeOptions({ JEVYR_SELF_JUDGE: "1" }, root);

test("self-judgment requires explicit finite configuration and disabled mode performs no capture", async () => {
  const disabled = new RepositorySelfJudge(selfJudgeOptions({}, "missing-source"), { runCase: async () => { assert.fail("disabled"); }, proposeOffspring: forbiddenProposal });
  disabled.start(); assert.deepEqual(await disabled.tick(), { status: "disabled" }); await disabled.stop();
  assert.throws(() => selfJudgeOptions({ JEVYR_SELF_JUDGE: "yes" }, "."), /explicitly/);
  for (const interval of ["0", "Infinity", "9999", "3600001", "10000.5"]) assert.throws(() => selfJudgeOptions({ JEVYR_SELF_JUDGE_INTERVAL_MS: interval }, "."), /interval/);
  assert.equal(selfJudgeOptions({ JEVYR_SELF_JUDGE: "1", JEVYR_SELF_JUDGE_INTERVAL_MS: "10000" }, ".").enabled, true);
});

test("source-only immutable snapshots bind exact bytes and remain quiet on unchanged or ignored changes", async () => fixture(async root => {
  await put(root, "src/index.ts", "export const value = 1;\n");
  await put(root, ".github/workflows/check.yml", "name: Check\n");
  for (const path of [".env", "credentials.json", "secrets/private.json", ".jevyr/policy.json", ".git/config.json", "node_modules/x/index.js", "artifacts/report.json", ".tmp/temp.ts", "dist/index.js", "asset.png"]) await put(root, path, "excluded");
  let calls = 0, snapshotRoot = "";
  const activities: unknown[] = [];
  const watcher = new RepositorySelfJudge(enabled(root), { proposeOffspring: forbiddenProposal, onActivity: event => activities.push(event), runCase: async ({ submission, manifest }) => {
    calls++;
    assert.equal(submission.case.control, "sovereign"); assert.equal(submission.case.privacy, "local_only");
    assert.equal(submission.case.seed, manifest.digest.slice(7));
    assert.deepEqual(manifest.files.map(file => file.path), [".github/workflows/check.yml", "src/index.ts"]);
    const { digest, ...body } = manifest; assert.equal(digestJson(body as unknown as JsonValue), digest);
    snapshotRoot = submission.case.subjects!.find(subject => subject.id === "own-repository")!.locator;
    const manifestPath = submission.case.subjects!.find(subject => subject.id === "self-judge-manifest")!.locator;
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), manifest);
    for (const file of manifest.files) {
      const bytes = await readFile(join(snapshotRoot, file.path));
      assert.equal(bytes.length, file.size); assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, file.digest);
    }
    assert.ok(!JSON.stringify(manifest).includes(root));
    if (calls === 2) { await put(root, "src/index.ts", "export const value = 3;\n"); assert.equal(await readFile(join(snapshotRoot, "src/index.ts"), "utf8"), "export const value = 2;\n"); }
    return result();
  } });
  assert.equal((await watcher.tick()).status, "judged"); await assert.rejects(access(snapshotRoot));
  await utimes(join(root, "src/index.ts"), new Date(), new Date()); await put(root, "artifacts/new.json", "ignored change");
  assert.deepEqual(await watcher.tick(), { status: "unchanged" }); assert.equal(calls, 1); assert.equal(activities.length, 1);
  await put(root, "src/index.ts", "export const value = 2;\n");
  assert.equal((await watcher.tick()).status, "judged"); assert.equal(calls, 2);
  assert.equal(await readFile(join(root, "src/index.ts"), "utf8"), "export const value = 3;\n");
  await watcher.stop();
}));

test("concurrent ticks are deduplicated and shutdown aborts only the active self Case", async () => fixture(async root => {
  await put(root, "index.ts", "export {};\n");
  let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0, snapshotRoot = "";
  const watcher = new RepositorySelfJudge(enabled(root), { proposeOffspring: forbiddenProposal, runCase: async ({ signal, submission }) => {
    calls++; snapshotRoot = submission.case.subjects![0]!.locator; entered();
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    assert.equal(signal.aborted, true); return result({ integrity: "INVALID" });
  } });
  const active = watcher.tick(); await ready;
  assert.deepEqual(await watcher.tick(), { status: "busy" });
  await watcher.stop(); assert.equal((await active).status, "judged"); assert.equal(calls, 1);
  assert.deepEqual(await watcher.tick(), { status: "stopped" }); await assert.rejects(access(snapshotRoot));
}));

test("only independently verified binding failures or reproduced critical REJECT defects enter quarantine", async () => fixture(async root => {
  await put(root, "index.ts", "export {};\n");
  for (const state of [result(), result({ integrity: "INVALID" }), result({ integrity: "INVALID", proofVerified: false, bindingFailures: [failure] }), result({ integrity: "VALID", bindingFailures: [failure] }), result({ integrity: "INVALID", bindingFailures: [failure] }), result({ judgment: "REJECT", reproducedDefects: [failure] }), result({ judgment: "UNPROVEN", reproducedDefects: [failure] }), result({ judgment: "REJECT", proofVerified: false, reproducedDefects: [failure] })]) {
    const proposals: unknown[] = [];
    const watcher = new RepositorySelfJudge(enabled(root), { runCase: async () => state, proposeOffspring: async proposal => { proposals.push(proposal); } });
    const tick = await watcher.tick(); assert.equal(tick.status, "judged");
    const expected = state.proofVerified && (state.integrity === "INVALID" && state.bindingFailures.length > 0 || state.integrity === "VALID" && state.judgment === "REJECT" && (state.reproducedDefects?.length ?? 0) > 0);
    assert.equal(proposals.length, expected ? 1 : 0); if (tick.status === "judged") assert.equal(tick.proposalRecorded, expected);
    assert.deepEqual(await watcher.tick(), { status: "unchanged" }); assert.equal(proposals.length, expected ? 1 : 0);
    await watcher.stop();
  }
}));

test("source bounds and hard-link rejection happen before any Case or proposal", async () => fixture(async root => {
  await put(root, "one.ts", "12345");
  const callbacks: SelfJudgeCallbacks = { runCase: async () => { assert.fail("capture must fail before Case"); }, proposeOffspring: forbiddenProposal };
  const boundedWatcher = new RepositorySelfJudge({ ...enabled(root), maximumFileBytes: 4 }, callbacks);
  await assert.rejects(boundedWatcher.tick(), /byte bound/); await boundedWatcher.stop();
  await link(join(root, "one.ts"), join(root, "two.ts"));
  const linkedWatcher = new RepositorySelfJudge(enabled(root), callbacks);
  await assert.rejects(linkedWatcher.tick(), /aliased/); await linkedWatcher.stop();
}));

test("a failed proposal write retries the same verified intake without recasting unchanged source", async () => fixture(async root => {
  await put(root, "index.ts", "export {};\n"); let cases = 0, proposals = 0;
  const watcher = new RepositorySelfJudge(enabled(root), { runCase: async () => { cases++; return result({ judgment: "REJECT", reproducedDefects: [failure] }); }, proposeOffspring: async () => { if (++proposals === 1) throw new Error("temporary proposal storage failure"); } });
  await assert.rejects(watcher.tick(), /temporary proposal/);
  assert.equal((await watcher.tick()).status, "judged"); assert.equal(cases, 1); assert.equal(proposals, 2);
  assert.deepEqual(await watcher.tick(), { status: "unchanged" }); await watcher.stop();
}));

test("directory links cannot introduce outside source into the manifest", async () => fixture(async root => {
  const project = join(root, "project"), outside = join(root, "outside");
  await put(project, "index.ts", "export {};\n"); await put(outside, "secret.ts", "outside");
  await symlink(outside, join(project, "linked"), process.platform === "win32" ? "junction" : "dir");
  const watcher = new RepositorySelfJudge(enabled(project), { proposeOffspring: forbiddenProposal, runCase: async ({ manifest }) => { assert.deepEqual(manifest.files.map(file => file.path), ["index.ts"]); return result(); } });
  assert.equal((await watcher.tick()).status, "judged"); await watcher.stop();
}));

test("an interrupted or malformed callback leaves source untouched and removes its temporary snapshot", async () => fixture(async root => {
  await put(root, "index.ts", "export {};\n"); let snapshot = "";
  const watcher = new RepositorySelfJudge(enabled(root), { proposeOffspring: forbiddenProposal, runCase: async ({ submission }) => { snapshot = submission.case.subjects![0]!.locator; return result({ runDigest: "unbound" }); } });
  await assert.rejects(watcher.tick(), /invalid ordinary Case result/); await assert.rejects(access(snapshot));
  assert.equal(await readFile(join(root, "index.ts"), "utf8"), "export {};\n"); await watcher.stop();
}));
