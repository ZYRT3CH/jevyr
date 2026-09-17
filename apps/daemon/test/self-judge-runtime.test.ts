import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createRuntimeSelfJudge } from "../src/self-judge-runtime.js";
import { readSelfJudgeRequests } from "../src/self-judge-inspection.js";

test("the repository watcher creates one actual signed self-Case and leaves unchanged source quiet", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-self-runtime-"));
  await writeFile(join(root, "index.ts"), "export const value = 1;\n");
  const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const driver = createRuntimeSelfJudge(runtime, { JEVYR_SELF_JUDGE: "1" });
  try {
    const first = await driver.tick();
    assert.equal(first.status, "judged");
    if (first.status !== "judged") throw new Error("Expected an actual self-judgment Case");
    assert.equal(first.proposalRecorded, false);
    const record = await runtime.repository.record(first.caseId);
    assert.equal(record?.verdict.integrity, "VALID");
    assert.equal(record?.verdict.judgment, "UNPROVEN");
    assert.ok(await runtime.repository.recordEnvelope(first.caseId));
    assert.ok(await runtime.repository.terminalReceipt(first.caseId));
    assert.equal((await driver.tick()).status, "unchanged");
    assert.equal((await readdir(join(root, ".jevyr", "cases"))).length, 1);
  } finally { await driver.stop(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("an authenticated unavailable sealed investigator creates a quarantined self-failure intake", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-self-failure-"));
  await writeFile(join(root, "index.ts"), "export const value = 1;\n");
  class UnavailableMind extends RuleMindAdapter {
    override async probe() { return { available: false, observedAt: new Date().toISOString(), latencyMs: 0, detail: "Controlled unavailable investigator fixture" }; }
  }
  const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new UnavailableMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const driver = createRuntimeSelfJudge(runtime, { JEVYR_SELF_JUDGE: "1" });
  try {
    const result = await driver.tick();
    assert.equal(result.status, "judged");
    if (result.status !== "judged") throw new Error("Expected signed failed self Case");
    assert.equal(result.proposalRecorded, true);
    const record = await runtime.repository.record(result.caseId);
    assert.equal(record?.verdict.integrity, "INVALID");
    const { requests } = await readSelfJudgeRequests(runtime.genome.registryRoot);
    assert.equal(requests.length, 1); assert.equal(requests[0]?.source.caseId, result.caseId);
    assert.ok(requests[0]?.source.recordDigest); assert.equal(requests[0]?.activeGenomeChanged, false);
    const failure = requests[0]!.failures.find(value => value.code === "INTEGRITY_PROVIDER_FAILURE");
    assert.ok(failure);
    const events = await runtime.events.read(result.caseId);
    assert.ok(events.some(event => event.eventDigest === failure.evidenceDigest && event.actor.kind === "kernel"));
    assert.equal((await driver.tick()).status, "unchanged");
    assert.equal((await readSelfJudgeRequests(runtime.genome.registryRoot)).requests.length, 1);
  } finally { await driver.stop(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
