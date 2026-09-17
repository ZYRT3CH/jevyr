import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { MindRequest, PublicContribution } from "../packages/runtime/src/index.js";
const R = await import("../packages/runtime/dist/index.js"), D = await import("../apps/daemon/dist/index.js"), S = await import("../packages/sdk/dist/index.js");
const { exportLocalProof } = await import("../apps/cli/dist/local-proof.js");
const directory = resolve(process.argv[2]!), root = resolve(process.argv[3] ?? `artifacts/lifecycle-inertia-${Date.now()}`);
assert.equal(JSON.parse(await readFile(join(directory, "independent-verification.json"), "utf8")).valid, true);
await mkdir(join(root, ".jevyr"), { recursive: true }); await cp(directory, join(root, ".jevyr", "metabolic-calibrations"), { recursive: true, force: false, errorOnExist: true });
const search = { ...R.DEFAULT_SEARCH_PROFILE, nursery: { ...R.DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 3, saturationWindow: 2, independentLineages: 2 }, resources: { ...R.DEFAULT_SEARCH_PROFILE.resources, concurrentLineages: 2, maxMindInvocations: 8, maxInputTokens: 3_000_000, maxOutputTokens: 100_000, maxGeneratedBytes: 2_000_000, maxWallMillis: 900_000, maxSingleInvocationMillis: 180_000, maxForgeWallMillis: 180_000, maxWritableBytes: 128_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 128 } };
await writeFile(join(root, ".jevyr", "policy.json"), JSON.stringify({ protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false, reflex: { required: true, maximumLoops: 2 }, forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: "node:24-alpine", limits: { memoryMb: 1024, pidsLimit: 256 } }, memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search }));
await writeFile(join(root, ".jevyr", "assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [{ assayId: "inertia.physical.node", costUnits: 3, tool: "forge.command", args: { command: "node", args: ["experiment.mjs"] }, timeoutMs: 30_000 }] }));
let release!: () => void; const gate = new Promise<void>(resolveGate => { release = resolveGate; });
const calls: { stage: string; seed: string; parentIds: readonly string[]; revision: boolean }[] = [];
class InertiaFixture extends R.RuleMindAdapter {
  override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage === "interpret") await gate;
    calls.push({ stage: request.stage, seed: request.seed, parentIds: request.revision?.parentCandidateIds ?? [], revision: !!request.revision });
    if (request.stage !== "diverge" && !request.revision) return;
    const revision = !!request.revision;
    yield { id: `candidate_${request.seed.slice(0, 20)}`, kind: "candidate", summary: `${revision ? "Revised" : "Initial"} finite arithmetic check ${request.seed.slice(0, 8)}`, parentIds: request.revision?.parentCandidateIds ?? [], feasibility: "BUILDABLE_NOW", candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: "experiment.mjs", content: `// ${request.seed}\nconst actual=${revision ? "2+3" : "2-3"};process.stdout.write(JSON.stringify({actual,expected:5}));process.exit(actual===5?0:9);` }], command: { executable: "node", args: ["experiment.mjs"] } } };
  }
}
const runtime = D.createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new InertiaFixture()] }); await runtime.ready();
const service = D.createJevyrHttpService({ runtime }), { url } = await service.listen(0), client = new S.JevyrClient({ baseUrl: url });
try {
  const seal = await client.cast({ case: { impulse: "`node experiment.mjs` exits with code 0.", control: "juggler", privacy: "local_only", seed: "19".repeat(32) } });
  assert.ok(!(await client.metabolismOffers(seal.caseId)).offers.some(offer => offer.kind === "Inertia")); release();
  let redemption: Awaited<ReturnType<typeof client.redeemMetabolism>> | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const offers = await client.metabolismOffers(seal.caseId), offered = offers.offers.find(offer => offer.kind === "Inertia");
    if (offered) { redemption = await client.redeemMetabolism(seal.caseId, offered.ballId, 1); break; }
    if (offers.admission === "closed") break;
    await delay(25);
  }
  const status = await runtime.orchestrator.waitForTerminal(seal.caseId, 900_000), authenticated = await client.waitForAuthenticatedRecord(seal.caseId), events = await runtime.events.read(seal.caseId);
  const proof = join(root, "proof"), independent = await exportLocalProof(client, seal.caseId, proof);
  await writeFile(join(root, "independent-verification.json"), JSON.stringify(independent, null, 2));
  const decisions = [];
  for (const meta of (await client.artifactList(seal.caseId)).artifacts.filter(meta => meta.mediaType === "application/vnd.jevyr.inertia-continuation+json")) decisions.push(JSON.parse((await readFile(join(proof, "artifacts", `${meta.id}.blob`))).toString("utf8")));
  const report = { protocol: "jevyr.inertia-lifecycle-proof/1", root, caseId: seal.caseId, status, verdict: authenticated.payload.verdict, proofDirectory: proof, independent, redemption: redemption ?? null, decisions, calls, scope: "Actual HTTP dose after physical failures, lower heuristic continuation threshold, shared production parent-bound revision, added Docker assay, signed receipt and independently replayed closure. Controlled finite fixture; no general model efficacy claim." };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  assert.ok(redemption, "A physical below-threshold scent must expose its calibrated Inertia dose while work remains"); assert.equal(independent.valid, true, JSON.stringify(independent.problems));
  assert.equal(decisions.length, 1); assert.equal(decisions[0].receiptDigest, redemption.receipt.digest); assert.equal(decisions[0].baselineThreshold, 0.5); assert.equal(decisions[0].loweredThreshold, 0.25);
  assert.equal(calls.filter(call => call.revision).length, 1); assert.deepEqual(calls.find(call => call.revision)!.parentIds, decisions[0].selected.map((value: { candidateId: string }) => value.candidateId));
  assert.ok(events.some(event => event.kind === "action.status" && event.payload.actionType === "metabolism.execution" && event.payload.status === "completed"));
  assert.equal(authenticated.payload.verdict.integrity, "VALID"); assert.equal(authenticated.payload.verdict.judgment, "ACCEPT");
  console.log(JSON.stringify({ root, caseId: seal.caseId, judgment: authenticated.payload.verdict.judgment, lowerThreshold: decisions[0].loweredThreshold, actualRevisionCalls: calls.filter(call => call.revision).length, replay: independent.valid }));
} finally { release(); await service.close(); }
