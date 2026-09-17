import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { test } from "node:test";
import { RuleMindAdapter, SealedForgeAdapter, type MindRequest } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";
import { replayAuthenticatedCase } from "../../cli/src/replay.js";

// The diagnostic receipt is module-branded. Use the same source/compiled runtime
// selected by the daemon, so the test never mixes two independent WeakMaps.
const { runModelToolLoop } = await import(new URL("./model-tool-loop.js", import.meta.resolve("@jevyr/runtime")).href) as typeof import("../../../packages/runtime/src/model-tool-loop.js");

for (const failedStage of ["interpret", "diverge"] as const) test(`signed closure retains digest-only ${failedStage} failure context without granting it evidence authority`, async () => {
  const root = await mkdtemp(join(tmpdir(), "judge-failed-investigation-"));
  class FailedInvestigator extends RuleMindAdapter {
    override async runMetered(request: MindRequest) {
      if (request.stage !== failedStage) return super.runMetered(request);
      let round = 0;
      return runModelToolLoop(request, { adapterId: this.capability.id, encode: messages => JSON.stringify(messages), async send() {
        round++;
        return JSON.stringify({ choices: [{ finish_reason: round === 1 ? "tool_calls" : "stop", message: round === 1 ? { tool_calls: [{ id: "obligations", type: "function", function: { name: "list_critical_obligations", arguments: "{}" } }] } : { content: '{"private_response_marker":true}' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
      } });
    }
  }
  const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new FailedInvestigator()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const draft = await client.createDraft({ case: { impulse: "Construct an inspectable finite program", privacy: "local_only", control: "sovereign" } });
    const receipt = (await client.sealDraft(draft.draftId, draft.revision, draft.startup.policyDigest)).receipt!;
    const signed = await client.waitForAuthenticatedRecord(receipt.caseId);
    const events = await runtime.events.read(receipt.caseId);
    const failures = events.filter(event => event.stage === failedStage && event.kind === "action.status" && event.payload.actionType === "investigation.model-tool-loop" && event.payload.status === "failed");
    assert.ok(failures.length > 0);
    const artifacts = (await client.artifactList(receipt.caseId)).artifacts.filter(artifact => artifact.mediaType === "application/vnd.jevyr.model-investigation-failure+json");
    assert.ok(artifacts.length > 0);
    for (const artifact of artifacts) {
      assert.ok(failures.some(event => event.kind === "action.status" && event.payload.artifactDigests?.includes(artifact.digest)));
      const verified = await client.fetchArtifact(receipt.caseId, artifact.id), text = new TextDecoder().decode(verified.data), body = JSON.parse(text);
      assert.equal(body.boundary, "FINAL_CONTRIBUTION"); assert.equal(body.providerRounds, 2); assert.equal(body.authority, "context-only");
      assert.equal(body.tools[0].name, "list_critical_obligations"); assert.equal(body.tools[0].status, "observed");
      assert.equal(text.includes("private_response_marker"), false);
      assert.equal(events.some(event => event.kind === "evidence.observed" && JSON.stringify(event.payload).includes(artifact.digest)), false);
    }
    assert.equal(signed.payload.verdict.integrity, "INVALID");
    const replay = await replayAuthenticatedCase(client, receipt.caseId, signed.payload);
    assert.equal(replay.valid, true, JSON.stringify(replay.problems));
  } finally {
    await service.close();
    assert.equal(dirname(root), tmpdir()); assert.ok(basename(root).startsWith("judge-failed-investigation-"));
    await rm(root, { recursive: true, force: true });
  }
});
