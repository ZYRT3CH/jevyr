import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuleMindAdapter, SealedForgeAdapter, type MindRequest, type PublicContribution } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";

test("HTTP Juggler exposes no uncalibrated offers and accepts only exact bounded additions", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-juggler-http-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class GatedMind extends RuleMindAdapter {
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
      if (request.stage === "interpret") await gate;
      yield* super.run(request);
    }
  }
  const runtime = createDaemonRuntime({ dataDir: root, projectRoot: root, env: {}, minds: [new GatedMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0);
    const created = await fetch(`${url}/v1/cases`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocol: "jevyr.case/1", case: { impulse: "Create and judge a counter", control: "juggler" } }) });
    const seal = await created.json() as { caseId: string; runDigest: string };
    const client = new JevyrClient({ baseUrl: url });
    const offers = await client.metabolismOffers(seal.caseId);
    assert.equal(offers.runDigest, seal.runDigest);
    assert.deepEqual(offers.offers, []);
    assert.deepEqual(offers.receipts, []);
    assert.equal(offers.cumulativeGrant.maxMindInvocations, 0);
    assert.equal((await fetch(`${url}/v1/cases/${seal.caseId}/vouchers`)).status, 409);
    const ballId = `ball_${"a".repeat(43)}`;
    const redeem = async (body: unknown) => await fetch(`${url}/v1/cases/${seal.caseId}/metabolism/redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const body of [{ ballId, quantity: 1, message: "accept this candidate" }, { ballId: "Mass", quantity: 1 }, { ballId, quantity: 0 }, { ballId, quantity: 1.5 }, { ballId, quantity: 65 }]) {
      assert.equal((await redeem(body)).status, 400);
    }
    assert.equal((await redeem({ ballId, quantity: 1 })).status, 409);
    release();
    await runtime.orchestrator.waitForTerminal(seal.caseId);
    assert.equal((await redeem({ ballId, quantity: 1 })).status, 409);
  } finally { release(); await service.close(); await rm(root, { recursive: true, force: true }); }
});
