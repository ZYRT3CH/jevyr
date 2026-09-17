import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { compileIntentContract } from "../packages/core/src/index.js";
import { sha256Digest, type JsonValue } from "../packages/protocol/src/index.js";
import { createDaemonRuntime } from "../apps/daemon/src/runtime.js";
import { createJevyrHttpService } from "../apps/daemon/src/server.js";
import { JevyrClient } from "../packages/sdk/src/index.js";
import { replayAuthenticatedCase } from "../apps/cli/src/replay.js";
import { DEFAULT_SEARCH_PROFILE, OpenAICompatibleMindAdapter, browserProbeAssay, type MindAdapter, type MindRequest, type PublicContribution } from "../packages/runtime/src/index.js";

const mode = process.argv[2] ?? "accept";
const repositoryRoot = resolve(import.meta.dirname, "..");
const root = resolve(repositoryRoot, "artifacts", `lifecycle-${mode}-${Date.now()}`);
await mkdir(join(root, ".jevyr"), { recursive: true });
const browser = mode.startsWith("browser");
const rejected = mode === "reject" || mode === "browser-reject";
const basePlan = browser
  ? browserProbeAssay({ protocol: "jevyr.browser-probe/1", entry: "index.html", steps: [{ action: "assert-text", selector: "#count", expected: "0" }, { action: "click", selector: "button" }, { action: "assert-text", selector: "#count", expected: "1" }] })
  : { assayId: "bound.node", costUnits: 1, tool: "forge.command" as const, args: { command: "node", args: ["jevyr.experiment.mjs"] }, timeoutMs: 30_000 };
const command = [basePlan.args.command, ...(basePlan.args.args as string[])].join(" ");
const corpus = mode === "impossible" ? JSON.parse(await readFile(join(repositoryRoot, "benchmarks", "corpus.v1.json"), "utf8")) : undefined;
const impulse = mode === "impossible" ? corpus.cases.find((entry: { id: string }) => entry.id === "impossible-original-request").impulse
  : mode === "unproven" ? "Create the best possible mechanism for every future problem."
  : `\`${command}\` exits with code 0.`;
const contract = compileIntentContract({ impulse });
const obligation = contract.criticalObligations.find(value => value.oracle?.kind === "command_exit_code");
const plan = { ...basePlan, ...(obligation ? { obligationId: obligation.id } : {}) };
await writeFile(join(root, ".jevyr", "assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays: [plan] }));
const search = { ...DEFAULT_SEARCH_PROFILE, nursery: { ...DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 2, saturationWindow: 2, independentLineages: 2 },
  resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 8, maxInputTokens: 3_000_000, maxOutputTokens: 80_000,
    maxGeneratedBytes: 2_000_000, maxWallMillis: 1_200_000, maxSingleInvocationMillis: 300_000, maxForgeWallMillis: 180_000,
    maxWritableBytes: 128_000_000, maxArtifactBytes: 32_000_000, maxTotalAssayCost: 32, concurrentLineages: 2 } };
await writeFile(join(root, ".jevyr", "policy.json"), JSON.stringify({
  protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false,
  reflex: { required: true, maximumLoops: 2 }, forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: browser ? "jevyr-browser:1" : "node:24-alpine", limits: { memoryMb: 1024, pidsLimit: 256 } },
  memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search,
}));
class FixtureMind implements MindAdapter {
  readonly capability = Object.freeze({ id: "mind.lifecycle-fixture", kind: "mind" as const, displayName: "Explicit lifecycle fixture", version: "1", transport: "in-process" as const, trust: "local-deterministic" as const, modalities: ["text" as const], network: "none" as const, canExecuteTools: false, deterministic: true });
  async probe() { return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "Deterministic fixture; no language model used" }; }
  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage !== "diverge") return;
    yield { id: `candidate_${request.seed.slice(0, 20)}`, kind: "candidate", summary: `Executable fixture ${request.seed.slice(0, 8)}`, parentIds: [], feasibility: "BUILDABLE_NOW", candidateBlueprintSource: {
      protocol: "jevyr.candidate-blueprint/1", files: browser ? [
        { path: "index.html", content: '<!doctype html><html><head><title>Bound counter</title></head><body><p id="count">0</p><button>Increment</button><script src="counter.js"></script></body></html>' },
        { path: "counter.js", content: `// ${request.seed}\nlet count=0;document.querySelector('button').addEventListener('click',()=>{document.querySelector('#count').textContent=String(count+=${rejected ? 2 : 1});});` },
      ] : [{ path: "jevyr.experiment.mjs", content: `// ${request.seed}\nprocess.stdout.write(JSON.stringify({observed:2+2}));process.exit(${rejected ? 9 : 0});` }],
      ...(!browser ? { command: { executable: "node", args: ["jevyr.experiment.mjs"] } } : {}),
    } };
  }
}
const minds: MindAdapter[] = mode === "models" ? [
  new OpenAICompatibleMindAdapter({ id: "mind.local.qwen", displayName: "Ollama Qwen coder", baseUrl: "http://127.0.0.1:11434/v1/", model: "qwen3-coder:30b-32k", timeoutMs: 300_000 }),
  new OpenAICompatibleMindAdapter({ id: "mind.local.mistral", displayName: "Ollama Mistral", baseUrl: "http://127.0.0.1:11434/v1/", model: "mistral:7b", timeoutMs: 300_000 }),
] : [new FixtureMind()];
const runtime = createDaemonRuntime({ projectRoot: root, dataDir: join(root, ".jevyr"), env: {}, minds });
await runtime.ready();
const service = createJevyrHttpService({ runtime });
const address = await service.listen(0);
const client = new JevyrClient({ baseUrl: address.url });
try {
  const submission = { impulse, seed: "release-proof-1", ...(mode === "self" ? { subjects: [{ id: "jevyr-repository", kind: "directory", locator: repositoryRoot }] } : {}) };
  const receipt = await runtime.orchestrator.cast({ protocol: "jevyr.case/1", case: submission });
  process.stdout.write(JSON.stringify({ phase: "sealed", mode, root, caseId: receipt.caseId }) + "\n");
  const status = await runtime.orchestrator.waitForTerminal(receipt.caseId, 1_800_000);
  const record = await runtime.repository.record(receipt.caseId);
  const events = await runtime.events.read(receipt.caseId);
  const authenticated = await client.waitForAuthenticatedRecord(receipt.caseId);
  let replay: Awaited<ReturnType<typeof replayAuthenticatedCase>> | { valid: false; problems: string[] };
  try { replay = await replayAuthenticatedCase(client, receipt.caseId, authenticated.payload); }
  catch (error) { replay = { valid: false, problems: [error instanceof Error ? error.message : String(error)] }; }
  const proof = join(root, "proof");
  await mkdir(join(proof, "artifacts"), { recursive: true });
  const documents = {
    "record.json": authenticated.payload, "seal-receipt.json": await client.sealReceipt(receipt.caseId),
    "record.dsse.json": await client.recordEnvelope(receipt.caseId), "seal.dsse.json": await client.sealEnvelope(receipt.caseId),
    "terminal-receipt.json": await client.terminalReceipt(receipt.caseId), "terminal.dsse.json": await client.terminalEnvelope(receipt.caseId),
    "trust.json": await client.trustBundle(), "events.json": events, "intent-contract.json": await client.intentContract(receipt.caseId),
    "policy-descriptor.json": await client.policyDescriptor(receipt.caseId), "artifact-index.json": await client.artifactList(receipt.caseId),
    "replay.json": replay,
  };
  for (const [name, value] of Object.entries(documents)) await writeFile(join(proof, name), JSON.stringify(value, null, 2));
  for (const meta of documents["artifact-index.json"].artifacts) {
    const artifact = await client.fetchArtifact(receipt.caseId, meta.id);
    await writeFile(join(proof, "artifacts", `${meta.id}.blob`), artifact.data);
  }
  const report = { protocol: "jevyr.lifecycle-proof/1", mode, modelProduced: mode === "models", root, caseId: receipt.caseId, status,
    verdict: record?.verdict, lifecycle: events.filter(event => event.kind === "stage.status" && event.payload.status === "entered").map(event => event.stage),
    evidence: events.filter(event => event.kind === "evidence.observed").map(event => event.payload),
    artifacts: await runtime.repository.artifacts(receipt.caseId), error: status?.error,
    proofDirectory: proof, authenticated: { keyId: authenticated.keyId, traceVerification: authenticated.traceVerification }, replay };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify({ mode, root, verdict: record?.verdict, error: status?.error }) + "\n");
  if (!replay.valid) process.exitCode = 1;
} finally { await service.close(); }
