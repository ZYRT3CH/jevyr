import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { MindRequest, PublicContribution } from "../packages/runtime/src/index.js";
const R = await import("../packages/runtime/dist/index.js");
const P = await import("../packages/protocol/dist/index.js");
const D = await import("../apps/daemon/dist/index.js");
const S = await import("../packages/sdk/dist/index.js");
const { replayAuthenticatedCase } = await import("../apps/cli/dist/replay.js");
const { exportLocalProof } = await import("../apps/cli/dist/local-proof.js");
const calibrationDirectory = resolve(process.argv[2]!);
const root = resolve(process.argv[3] ?? `artifacts/lifecycle-metabolism-${Date.now()}`);
const independent = JSON.parse(await readFile(join(calibrationDirectory, "independent-verification.json"), "utf8"));
assert.equal(independent.valid, true);
await mkdir(join(root, ".jevyr"), { recursive: true });
await cp(calibrationDirectory, join(root, ".jevyr", "metabolic-calibrations"), { recursive: true, errorOnExist: true, force: false });
const search = { ...R.DEFAULT_SEARCH_PROFILE, nursery: { ...R.DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 2, saturationWindow: 2, independentLineages: 2 }, resources: { ...R.DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 8, maxInputTokens: 3_000_000, maxOutputTokens: 100_000, maxGeneratedBytes: 2_000_000, maxWallMillis: 1_200_000, maxSingleInvocationMillis: 300_000, maxForgeWallMillis: 180_000, maxWritableBytes: 128_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 32, concurrentLineages: 2 } };
await writeFile(join(root, ".jevyr", "policy.json"), JSON.stringify({ protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false, reflex: { required: true, maximumLoops: 2 }, forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: "node:24-alpine", limits: { memoryMb: 1024, pidsLimit: 256 } }, memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search }));
await writeFile(join(root, ".jevyr", "assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [{ assayId: "bound.metabolic.node", costUnits: 1, tool: "forge.command", args: { command: "node", args: ["jevyr.experiment.mjs"] }, timeoutMs: 30_000 }] }));
let release!: () => void; const gate = new Promise<void>(resolveGate => { release = resolveGate; });
const calls: { stage: string; seed: string; additive: string | null }[] = [];
class GatedFixture extends R.RuleMindAdapter {
  override async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage === "interpret") await gate;
    const additive = request.constraints.find(text => text.startsWith("Additive "))?.split(" ")[1] ?? null;
    calls.push({ stage: request.stage, seed: request.seed, additive });
    if (request.stage !== "diverge") return;
    yield { id: `candidate_${request.seed.slice(0, 20)}`, kind: "candidate", summary: `${additive ?? "Baseline"} executable probe ${request.seed.slice(0, 8)}`, body: "Check a concrete arithmetic equality with a process exit status.", parentIds: [], feasibility: "BUILDABLE_NOW", candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: [{ path: "jevyr.experiment.mjs", content: `// ${request.seed}\nconst observed=2+2;process.stdout.write(JSON.stringify({observed}));process.exit(observed===4?0:9);` }], command: { executable: "node", args: ["jevyr.experiment.mjs"] } } };
  }
}
const runtime = D.createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds: [new GatedFixture()] });
await runtime.ready();
const service = D.createJevyrHttpService({ runtime });
const { url } = await service.listen(0);
const client = new S.JevyrClient({ baseUrl: url });
try {
  const seal = await client.cast({ case: { impulse: "`node jevyr.experiment.mjs` exits with code 0.", seed: "live-metabolic-signed-proof-1", control: "juggler" } });
  const initial = await client.metabolismOffers(seal.caseId);
  const redemptions = [];
  for (const kind of ["Mass", "Fission"]) {
    const offered = initial.offers.find(offer => offer.kind === kind); assert.ok(offered);
    redemptions.push(await client.redeemMetabolism(seal.caseId, offered.ballId, 1));
  }
  console.log(JSON.stringify({ phase: "signed-grants", caseId: seal.caseId, root, receipts: redemptions.map(value => value.receipt.digest) }));
  release();
  const status = await runtime.orchestrator.waitForTerminal(seal.caseId, 900_000);
  const authenticated = await client.waitForAuthenticatedRecord(seal.caseId);
  const events = await runtime.events.read(seal.caseId);
  const replay = await replayAuthenticatedCase(client, seal.caseId, authenticated.payload);
  const proof = join(root, "proof"), independent = await exportLocalProof(client, seal.caseId, proof);
  await writeFile(join(root, "independent-verification.json"), JSON.stringify(independent, null, 2));
  const allEvents = Array.isArray(events) ? events : events.events;
  const grants = allEvents.filter(event => event.kind === "action.status" && event.payload.actionType === "metabolism.grant");
  const admitted = allEvents.filter(event => event.kind === "action.status" && event.payload.actionType === "metabolism.admitted");
  const executions = allEvents.filter(event => event.kind === "evidence.observed" && event.payload.evidenceType === "sandbox_execution");
  const executedCandidateIds = [...new Set(executions.map(event => event.payload.candidateId))];
  const report = { protocol: "jevyr.lifecycle-proof/1", mode: "metabolism", modelProduced: false, root, caseId: seal.caseId, status, verdict: authenticated.payload.verdict, proofDirectory: proof, authenticated: { keyId: authenticated.keyId, traceVerification: authenticated.traceVerification }, replay, metabolicReceipts: redemptions, calls, actualSandboxExecutions: executions.length, executedCandidateIds, repeatedSandboxObservations: executions.length - executedCandidateIds.length, baselineCalls: calls.filter(call => call.stage === "diverge" && call.additive === null).length, addedCalls: calls.filter(call => call.additive !== null).length, scope: "Actual HTTP quantity redemption, independent SDK signature checks, durable grant/admission ledger prefixes, extra finite candidate generation and Docker assays; deterministic fixture, not a language-model quality estimate. Sandbox observations include repeated selected-candidate evidence when present." };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  assert.equal(grants.length, 2); assert.equal(admitted.length, 2);
  for (const grant of grants) assert.ok(admitted.some(event => event.payload.actionId === grant.payload.actionId && event.sequence > grant.sequence));
  assert.deepEqual(calls.filter(call => call.additive !== null).map(call => call.additive), ["Mass", "Fission"]);
  assert.equal(executedCandidateIds.length, report.baselineCalls + report.addedCalls);
  assert.equal(authenticated.payload.verdict.integrity, "VALID"); assert.equal(authenticated.payload.verdict.judgment, "ACCEPT");
  assert.equal(replay.valid, true, JSON.stringify(replay.problems));
  assert.equal(independent.valid, true, JSON.stringify(independent.problems));
  console.log(JSON.stringify({ root, caseId: seal.caseId, verdict: authenticated.payload.verdict, extraCalls: report.addedCalls, actualSandboxExecutions: executions.length, replay: replay.valid }));
} finally { release(); await service.close(); }
