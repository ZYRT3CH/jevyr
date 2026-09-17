import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuleMindAdapter, SealedForgeAdapter, type MindRequest, type PublicContribution } from "@jevyr/runtime";
import { createDaemonRuntime } from "../src/runtime.js";
import { createJevyrHttpService } from "../src/server.js";
import { AirlockDraftStore } from "../src/airlock.js";
import { createHttpAccess } from "../src/http-auth.js";
import { JevyrClient } from "../../../packages/sdk/src/client.js";

test("Airlock drafts edit optimistically, bind the preview policy, seal once, and abort to signed INVALID", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-airlock-control-"));
  class SlowMind extends RuleMindAdapter {
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
      await delay(60_000, undefined, { signal: request.signal });
      yield* super.run(request);
    }
  }
  const runtime = createDaemonRuntime({ dataDir: join(root, "store"), projectRoot: root, env: {}, minds: [new SlowMind()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0);
    const request = async (path: string, body: unknown, method = "POST") => await fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const created = await request("/v1/drafts", { protocol: "jevyr.case/1", case: { impulse: "Build a counter" } });
    assert.equal(created.status, 201);
    const first = await created.json() as any;
    assert.equal(first.state, "DRAFT"); assert.equal(first.submission.case.control, "juggler");
    assert.match(first.submission.case.seed, /^[a-f0-9]{64}$/u);
    assert.ok(first.preview.criticalObligations.length);
    const path = `/v1/drafts/${first.draftId}`;
    const changed = { ...first.submission, case: { ...first.submission.case, impulse: "Build an observable counter", control: "sovereign" } };
    const edited = await request(path, { revision: 1, submission: changed }, "PATCH");
    assert.equal(edited.status, 200);
    assert.equal((await request(path, { revision: 1, submission: changed }, "PATCH")).status, 409);
    assert.equal((await request(`${path}/seal`, { revision: 2, policyDigest: `sha256:${"0".repeat(64)}` })).status, 409);
    const body = { revision: 2, policyDigest: first.startup.policyDigest };
    const simultaneous = await Promise.all([request(`${path}/seal`, body), request(`${path}/seal`, body)]);
    assert.deepEqual(simultaneous.map((response) => response.status).sort(), [202, 409]);
    const sealed = await simultaneous.find((response) => response.status === 202)!.json() as any;
    assert.equal(sealed.state, "SEALED"); assert.equal(sealed.receipt.submissionDigest, sealed.submissionDigest);
    assert.equal((await request(path, { revision: 2, submission: changed }, "PATCH")).status, 409);
    const caseId = sealed.receipt.caseId;
    assert.equal((await request(`/v1/cases/${caseId}/abort`, { reason: "accept" })).status, 400);
    assert.equal((await request(`/runs/${caseId}/abort`, {})).status, 202);
    await runtime.orchestrator.waitForTerminal(caseId, 10_000);
    const record = await runtime.repository.record(caseId);
    assert.equal(record?.verdict.integrity, "INVALID");
    const verified = await new JevyrClient({ baseUrl: url }).waitForAuthenticatedRecord(caseId);
    assert.ok(verified);
    assert.equal((await request(`/v1/cases/${caseId}/abort`, {})).status, 409);
    assert.equal((await readdir(join(root, "store", "cases"))).length, 1);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("an uncertain draft seal stays closed across store instances and never retries Cast", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-airlock-restart-"));
  try {
    const store = new AirlockDraftStore(root);
    const draft = await store.create({ protocol: "jevyr.case/1", case: { impulse: "Inspect an interrupted seal" } });
    let calls = 0;
    await assert.rejects(store.seal(draft.draftId, { revision: 1 }, async () => { calls++; throw new Error("interrupted admission"); }));
    const reopened = new AirlockDraftStore(root);
    assert.equal((await reopened.read(draft.draftId)).state, "FAILED");
    await assert.rejects(reopened.seal(draft.draftId, { revision: 1 }, async () => { calls++; throw new Error("must not call"); }), /sealed once/u);
    assert.equal(calls, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("team bearer access protects every private HTTP transport and never accepts URL tokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-team-access-"));
  const token = "test-only-" + "x".repeat(48);
  const env = { JEVYR_HTTP_TOKEN_REF: "env:JUDGE_TEAM_TOKEN", JUDGE_TEAM_TOKEN: token };
  const runtime = createDaemonRuntime({ dataDir: root, projectRoot: root, env: {}, minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env });
  try {
    const { url } = await service.listen(0);
    assert.equal((await fetch(`${url}/health`)).status, 200);
    for (const path of ["/v1/capabilities", "/v1/genome-lab", "/v1/trust", "/v1/drafts", "/mcp/client-run", "/a2a/message:send"]) {
      assert.equal((await fetch(`${url}${path}`)).status, 401, path);
    }
    assert.equal((await fetch(`${url}/v1/trust?token=${token}`)).status, 401);
    assert.equal((await fetch(`${url}/v1/trust`, { headers: { authorization: `Bearer ${token}wrong` } })).status, 401);
    const response = await fetch(`${url}/v1/trust`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.ok(!(await response.text()).includes(token));
    assert.equal(createHttpAccess({ JEVYR_ALLOW_REMOTE_BIND: "1" }).allowRemoteBind, false);
    assert.equal(createHttpAccess({ ...env, JEVYR_ALLOW_REMOTE_BIND: "1" }).allowRemoteBind, true);
    assert.throws(() => createHttpAccess({ JEVYR_HTTP_TOKEN_REF: token }), /broker reference/u);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("Airlock choices narrow only the selected Case and remain authenticated after closure", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-airlock-choices-"));
  class GatedMind extends RuleMindAdapter {
    override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
      await delay(60_000, undefined, { signal: request.signal }); yield* super.run(request);
    }
  }
  const mind = new GatedMind();
  const runtime = createDaemonRuntime({ dataDir: root, projectRoot: root, env: {}, minds: [mind], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const first = await client.createDraft({ case: { impulse: "Inspect this selected capability", privacy: "local_only", control: "sovereign" } });
    const maximum = first.startup.searchEnvelope.profile.resources;
    const choices = { capabilityIds: [mind.capability.id], preset: "wild" as const, sandbox: "observe_only" as const,
      resourceCeiling: { maxWallMillis: Math.max(maximum.maxSingleInvocationMillis, Math.floor(maximum.maxWallMillis / 2)), maxNetworkBytes: 0,
        maxForgeWallMillis: Math.floor(maximum.maxForgeWallMillis / 2), maxForgeCpuMillis: Math.floor(maximum.maxForgeCpuMillis / 2),
        maxWritableBytes: Math.floor(maximum.maxWritableBytes / 2), maxWritableInodes: Math.floor(maximum.maxWritableInodes / 2),
        maxArtifactBytes: Math.floor(maximum.maxArtifactBytes / 2), maxTotalAssayCost: Math.floor(maximum.maxTotalAssayCost / 2) } };
    await assert.rejects(client.replaceDraft(first.draftId, 1, first.submission, undefined, { capabilityIds: ["invented.authority"] }), /unconfigured/u);
    await assert.rejects(client.replaceDraft(first.draftId, 1, first.submission, undefined, { resourceCeiling: { maxMindInvocations: maximum.maxMindInvocations + 1 } }), /widen/u);
    assert.equal((await client.draft(first.draftId)).revision, 1);
    const edited = await client.replaceDraft(first.draftId, 1, first.submission, undefined, choices);
    assert.notEqual(edited.startup.policyDigest, first.startup.policyDigest);
    assert.equal(edited.startup.searchEnvelope.profile.resources.maxNetworkBytes, 0);
    assert.deepEqual(edited.choices, choices);
    assert.equal((edited.startup.policy as any).policy.assayFrontier.aggregateLimits.maxForgeWallMillis, choices.resourceCeiling.maxForgeWallMillis);
    assert.equal(runtime.repository.policyDigest, first.startup.policyDigest);
    const sealed = await client.sealDraft(edited.draftId, edited.revision, edited.startup.policyDigest);
    const original = await client.createDraft({ case: { impulse: "A separate baseline Case", control: "sovereign" } });
    assert.equal(original.startup.policyDigest, first.startup.policyDigest);
    await client.abort(sealed.receipt!.caseId);
    const closed = await client.waitForAuthenticatedRecord(sealed.receipt!.caseId);
    assert.equal(closed.payload.verdict.integrity, "INVALID");
    const specification = await client.verifiedSealedCase(sealed.receipt!.caseId);
    assert.equal(specification.searchEnvelope.profile.resources.maxNetworkBytes, 0);
    assert.equal(specification.policyDigest, edited.startup.policyDigest);
    const restored = await client.draft(edited.draftId);
    assert.equal(restored.startup.policyDigest, edited.startup.policyDigest);
    assert.deepEqual(restored.choices, choices);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("seeded reruns authenticate and reuse captured bytes after the original file changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "jevyr-frozen-rerun-")), source = join(root, "source.txt");
  await writeFile(source, "Original captured source, before any run");
  const runtime = createDaemonRuntime({ dataDir: join(root, "store"), projectRoot: root, env: {}, minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }) });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0), client = new JevyrClient({ baseUrl: url });
    const receipt = await client.cast({ case: { impulse: "Assess the meaning of this source", seed: "a".repeat(64), control: "sovereign", privacy: "local_only", subjects: [{ id: "source", kind: "file", locator: source }] } });
    await client.waitForAuthenticatedRecord(receipt.caseId);
    await writeFile(source, "Changed host file must never enter a controlled reproduction");
    const same = await client.reproduceCase(receipt.caseId, "same");
    await client.waitForAuthenticatedRecord(same.caseId);
    assert.equal(same.caseDigest, receipt.caseDigest);
    assert.notEqual(same.runDigest, receipt.runDigest);
    assert.equal(same.subjectMaterialCaptureDigest, receipt.subjectMaterialCaptureDigest);
    const changed = await client.reproduceCase(receipt.caseId, "new");
    await client.waitForAuthenticatedRecord(changed.caseId);
    assert.notEqual(changed.caseDigest, receipt.caseDigest);
    assert.equal(changed.subjectMaterialCaptureDigest, receipt.subjectMaterialCaptureDigest);
    const original = await client.verifiedSealedCase(receipt.caseId), repeated = await client.verifiedSealedCase(same.caseId), renewed = await client.verifiedSealedCase(changed.caseId);
    assert.equal(repeated.intent.seed, original.intent.seed);
    assert.notEqual(renewed.intent.seed, original.intent.seed);
    assert.deepEqual(repeated.subjects, original.subjects);
    const originalPhenotype = (await client.artifactList(receipt.caseId)).artifacts.find(item => item.mediaType === "application/vnd.jevyr.phenotype+json");
    const repeatedPhenotype = (await client.artifactList(same.caseId)).artifacts.find(item => item.mediaType === "application/vnd.jevyr.phenotype+json");
    assert.ok(originalPhenotype); assert.equal(repeatedPhenotype?.digest, originalPhenotype.digest);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
