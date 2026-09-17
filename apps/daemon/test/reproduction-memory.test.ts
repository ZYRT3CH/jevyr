import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TemporalDeep } from "@jevyr/memory";
import { createReproductionMemoryGuard, REPRODUCTION_MEMORY_MEDIA_TYPE, RuleMindAdapter, SealedForgeAdapter, verifyReproductionMemoryGuard, type MindRequest, type PublicContribution } from "@jevyr/runtime";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";

test("controlled rerun invalidates changed late memory before hint exposure and binds the original signed Record", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-rerun-memory-"));
  let armMutation = false, mutated = false;
  const retrieve = TemporalDeep.prototype.retrieve;
  class MutatingMind extends RuleMindAdapter {
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
      if (armMutation && request.stage === "interpret") mutated = true;
      yield* super.run(request);
    }
  }
  TemporalDeep.prototype.retrieve = function(request) {
    if (!mutated) return retrieve.call(this, request);
    return [{ memoryDigest: digestJson("later admitted hint"), scope: "PROJECT", kind: "strategy", abstractSummary: "A hint that was absent from the source run", content: {}, weight: 0.12, influence: "strategy_selected" }];
  };
  const runtime = createDaemonRuntime({ dataDir: root, projectRoot: root, env: {}, minds: [new MutatingMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const original = await client.cast({ case: { impulse: "Inspect the exact task", seed: "c".repeat(64), privacy: "local_only", control: "sovereign" } });
    const originalRecord = await client.waitForAuthenticatedRecord(original.caseId);
    const envelope = (await runtime.repository.recordEnvelope(original.caseId))!, trust = await runtime.repository.publicTrustBundle();
    const keys = new Map(trust.keys.map(key => [key.keyId, key.publicKeyPem]));
    const guard = createReproductionMemoryGuard(envelope, keys);
    assert.deepEqual(guard.expectedInfluences, []);
    assert.throws(() => verifyReproductionMemoryGuard({ ...guard, expectedInfluences: [{ memoryDigest: digestJson("forged"), influence: "strategy_selected", summary: "Forged source hint", weight: 0.1 }] }, keys), /differs/u);
    assert.throws(() => createReproductionMemoryGuard({ ...envelope, signatures: [] }, keys), /authenticated/u);
    armMutation = true;
    const repeated = await client.reproduceCase(original.caseId, "same");
    const repeatedRecord = await client.waitForAuthenticatedRecord(repeated.caseId);
    assert.equal(mutated, true);
    assert.equal(repeatedRecord.payload.verdict.integrity, "INVALID");
    const status = (await runtime.repository.status(repeated.caseId))!;
    assert.match(status.error ?? "", /REPRODUCTION_MEMORY_CHANGED/u);
    const events = await runtime.events.read(repeated.caseId);
    assert.equal(events.filter(event => event.kind === "memory.influence").length, 0);
    const action = events.find(event => event.kind === "action.status" && event.payload.actionType === "investigation.reproduction-memory");
    assert.ok(action && action.kind === "action.status" && action.payload.status === "failed");
    const meta = (await runtime.repository.artifacts(repeated.caseId)).find(artifact => artifact.mediaType === REPRODUCTION_MEMORY_MEDIA_TYPE)!;
    assert.deepEqual(action.payload.artifactDigests, [meta.digest]);
    const artifact = (await runtime.repository.artifact(repeated.caseId, meta.id))!;
    const comparison = JSON.parse(artifact.data.toString("utf8"));
    assert.equal(comparison.source.sourceRecordDigest, digestJson(originalRecord.payload as unknown as JsonValue));
    assert.deepEqual(comparison.source.sourceEnvelope, envelope);
    assert.equal(comparison.matches, false);
  } finally {
    TemporalDeep.prototype.retrieve = retrieve;
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
