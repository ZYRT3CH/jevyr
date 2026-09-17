import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuleMindAdapter, SealedForgeAdapter, type CapabilityCard, type MindRequest, type PublicContribution } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";

test("Airlock selection retains startup adapter identities despite mutable cards and caller-owned arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-airlock-identity-"));
  class CountedMind extends RuleMindAdapter {
    calls = 0;
    override readonly capability: CapabilityCard;
    constructor(id: string) { super(); this.capability = { ...new RuleMindAdapter().capability, id }; }
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> { this.calls++; yield* super.run(request); }
  }
  const selected = new CountedMind("mind.selected"), excluded = new CountedMind("mind.excluded");
  const supplied = [selected, excluded];
  const runtime = createDaemonRuntime({ dataDir: root, projectRoot: root, env: {}, minds: supplied, forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const preview = runtime.previewAirlock();
    supplied.splice(0, supplied.length, excluded);
    assert.equal(runtime.minds.length, 2);
    assert.throws(() => (runtime.minds as unknown as CountedMind[]).splice(0, 1), TypeError);
    assert.throws(() => (preview.availableCapabilities as CapabilityCard[]).pop(), TypeError);
    assert.throws(() => (runtime.witnesses.adapters as unknown as unknown[]).push(excluded), TypeError);
    assert.throws(() => (runtime.witnesses.calls as unknown as unknown[]).push({}), TypeError);
    (selected.capability as { id: string }).id = "mind.renamed-after-startup";
    (excluded.capability as { id: string }).id = "mind.selected";
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const draft = await client.createDraft({ case: { impulse: "Inspect with exactly the selected investigator", control: "sovereign", privacy: "local_only" } });
    const edited = await client.replaceDraft(draft.draftId, draft.revision, draft.submission, undefined, { capabilityIds: ["mind.selected"], sandbox: "observe_only" });
    assert.deepEqual(edited.startup.capabilities.filter(card => card.kind === "mind").map(card => card.id), ["mind.selected"]);
    const sealed = await client.sealDraft(edited.draftId, edited.revision, edited.startup.policyDigest);
    await client.waitForAuthenticatedRecord(sealed.receipt!.caseId);
    assert.ok(selected.calls > 0);
    assert.equal(excluded.calls, 0);
    const events = await runtime.events.read(sealed.receipt!.caseId);
    assert.ok(events.filter(event => event.actor.kind === "mind").every(event => event.actor.id === "mind.selected"));
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
