import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, digestJson, METABOLIC_RESOURCE_KEYS, type JsonValue } from "@jevyr/protocol";
import { RuleMindAdapter, SealedForgeAdapter, metabolicImplementationDigest, METABOLIC_REPRODUCTION_MEDIA_TYPE, verifyMetabolicReproductionPlan, type MindRequest, type PublicContribution } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";
import { replayAuthenticatedCase } from "../../cli/src/replay.js";

const hash = (value: unknown) => digestJson(value as JsonValue);
/** Explicit schema fixture, never installed outside this temporary test and
 * never cited as measured calibration or an executable quality experiment. */
async function schemaCalibration(root: string) {
  const raw = "UNIT FIXTURE: no empirical execution claim", observationDigest = hash(raw);
  const trials = Array.from({ length: 64 }, (_, index) => [0, 1, 2].map(dose => {
    const trace = [{ id: `baseline:${index}`, origin: "baseline", metric: "baseline", family: "zero", lane: "baseline", observationDigest }, ...Array.from({ length: dose }, (_, i) => ({ id: `dose:${index}:${i}`, origin: "Mass", metric: "general", family: `fixture-${i}`, lane: `fixture-${i}`, observationDigest }))];
    const defects = [{ id: "schema-defect", expected: "REJECT", observed: "REJECT" }];
    return { seed: index.toString(16).padStart(64, "0"), dose, trace, replicationTraceDigest: hash(trace), defects, replicationDefectsDigest: hash(defects), identicalEvidence: { evidenceDigest: observationDigest, baselineVerdictDigest: observationDigest, doseVerdictDigest: observationDigest }, observationArtifactDigests: [observationDigest], addedResourceUse: Object.fromEntries(METABOLIC_RESOURCE_KEYS.map(key => [key, key === "maxMindInvocations" ? dose : 0])) };
  })).flat();
  const body = { protocol: "jevyr.metabolic-calibration/1", kind: "Mass", scope: raw, implementationDigest: metabolicImplementationDigest(), suiteDigest: observationDigest, confidence: 0.95, nonInferiorityMargin: 0.1, trials };
  const directory = join(root, ".jevyr", "metabolic-calibrations");
  await mkdir(join(directory, "artifacts"), { recursive: true });
  await writeFile(join(directory, "Mass.json"), canonicalize({ ...body, digest: hash(body) } as JsonValue));
  await writeFile(join(directory, "artifacts", `${observationDigest.slice(7)}.json`), canonicalize(raw));
}

test("controlled Juggler reruns issue fresh source-checkpoint grants, retain control, and independently replay same/new seeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-metabolic-rerun-"));
  await schemaCalibration(root);
  let release!: () => void, held = true, mutateContext = false;
  let gate = new Promise<void>(resolve => { release = resolve; });
  class GatedMind extends RuleMindAdapter {
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> { if (request.stage === "interpret" && held) await gate; if (request.stage === "interpret" && mutateContext) yield { id: "changed_context", kind: "observation", summary: "An actual investigator output changed after the source run" }; yield* super.run(request); }
  }
  const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new GatedMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const source = await client.cast({ case: { impulse: "Inspect one finite mechanism", control: "juggler", privacy: "local_only", seed: "d".repeat(64) } });
    const offer = (await client.metabolismOffers(source.caseId)).offers.find(offer => offer.kind === "Mass"); assert.ok(offer);
    const originalGrant = await client.redeemMetabolism(source.caseId, offer.ballId, 1);
    held = false; release();
    const sourceRecord = await client.waitForAuthenticatedRecord(source.caseId);
    assert.equal(sourceRecord.payload.verdict.integrity, "VALID");
    assert.equal((await replayAuthenticatedCase(client, source.caseId, sourceRecord.payload)).valid, true);
    const sourceEvents = await runtime.events.read(source.caseId);
    assert.equal(sourceEvents.some(event => event.kind === "action.status" && event.payload.actionType === "investigation.metabolic-checkpoint" && event.stage === "assay"), true);
    for (const seedMode of ["same", "new"] as const) {
      held = true; gate = new Promise<void>(resolve => { release = resolve; });
      const repeated = await client.reproduceCase(source.caseId, seedMode);
      assert.equal((await runtime.repository.status(repeated.caseId))!.sealed.intent.control, "juggler");
      assert.equal((await client.metabolismOffers(repeated.caseId)).offers.length, 0);
      await assert.rejects(client.redeemMetabolism(repeated.caseId, offer.ballId, 1), /Controlled Juggler|not currently offered|rejected|409/u);
      const refused = await fetch(`${url}/v1/cases/${repeated.caseId}/metabolism/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ballId: offer.ballId, quantity: 1 }) });
      assert.equal(refused.ok, false);
      held = false; release();
      const result = await client.waitForAuthenticatedRecord(repeated.caseId);
      const status = (await runtime.repository.status(repeated.caseId))!;
      assert.equal(result.payload.verdict.integrity, "VALID", status.error);
      assert.equal(status.sealed.intent.seed === "d".repeat(64), seedMode === "same");
      const events = await runtime.events.read(repeated.caseId);
      const freshAction = events.find(event => event.kind === "action.status" && event.payload.actionType === "metabolism.grant"); assert.ok(freshAction?.kind === "action.status");
      assert.notEqual(freshAction.payload.actionId, originalGrant.receipt.digest);
      const replay = await replayAuthenticatedCase(client, repeated.caseId, result.payload);
      assert.equal(replay.valid, true, JSON.stringify(replay.problems));
      const meta = (await runtime.repository.artifacts(repeated.caseId)).find(meta => meta.mediaType === METABOLIC_REPRODUCTION_MEDIA_TYPE)!;
      const bytes = (await runtime.repository.artifact(repeated.caseId, meta.id))!.data;
      const plan = JSON.parse(bytes.toString("utf8"));
      const trust = await runtime.repository.publicTrustBundle(), keys = new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem]));
      assert.equal((await verifyMetabolicReproductionPlan(plan, keys)).sourceRecordDigest, hash(sourceRecord.payload));
      const tampered = structuredClone(plan); tampered.checkpoints[0].ordinal++;
      await assert.rejects(verifyMetabolicReproductionPlan(tampered, keys), /differs/u);
      await assert.rejects(verifyMetabolicReproductionPlan(plan, new Map()), /authenticated/u);
      const historical = structuredClone(plan); delete historical.sourcePolicyDescriptor.policy.metabolicCheckpoints;
      await assert.rejects(verifyMetabolicReproductionPlan(historical, keys), /historical timing replay is unsupported/u);
    }
    mutateContext = true;
    const changed = await client.reproduceCase(source.caseId, "same");
    const changedRecord = await client.waitForAuthenticatedRecord(changed.caseId);
    assert.equal(changedRecord.payload.verdict.integrity, "INVALID");
    assert.match((await runtime.repository.status(changed.caseId))!.error ?? "", /METABOLIC_REPRODUCTION_CONTEXT_CHANGED/u);
  } finally { held = false; release(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
