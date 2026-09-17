import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { compileIntentContract, JEVYR_BONE_DIGEST, generateSigningKeyPair } from "../packages/core/dist/index.js";
import { createGenome, builtinGenomeModule, compileGenomeRuntimeProfile, compileGenomeBenchmark, signGenomeBenchmark, derivePhysicalReproducibility, type PairedGenomeTrial } from "../packages/growth/dist/index.js";
import { digestJson, sha256Digest, type JsonValue } from "../packages/protocol/dist/index.js";
import { DEFAULT_SEARCH_PROFILE, type MindAdapter, type MindRequest, type PublicContribution } from "../packages/runtime/dist/index.js";
import { createDaemonRuntime, createJevyrHttpService } from "../apps/daemon/dist/index.js";
import { JevyrClient } from "../packages/sdk/dist/index.js";
import { verifyLocalProof } from "../apps/cli/dist/local-proof.js";

const hash = (value: unknown): string => digestJson(value as JsonValue);
const root = resolve(import.meta.dirname, "..", "artifacts", `paired-genome-${Date.now()}`);
await mkdir(root, { recursive: true });
const implementationDigest = sha256Digest(await readFile(import.meta.filename));
const commands = Array.from({ length: 4 }, (_, index) => `node check-${index}.mjs`);
const impulse = `\`${commands[0]}\` exits with code 0.`;
const constraints = commands.slice(1).map((command) => `\`${command}\` exits with code 0.`);
const contract = compileIntentContract({ impulse, constraints, subjectIds: ["fixture-source"] });
const cases = [true, false].map((clean) => ({ caseKey: clean ? "clean-four-predicates" : "two-planted-defects", clean,
  files: commands.map((_command, index) => ({ path: `check-${index}.mjs`, content: `const input=${index};const actual=input+${!clean && index % 2 ? 2 : 1};const expected=input+1;console.log(JSON.stringify({input,actual,expected}));process.exit(actual===expected?0:9);` })),
  criticalDefectIds: clean ? [] : ["predicate-1", "predicate-3"],
}));
const corpus = { protocol: "jevyr.paired-genome-fixture/1", impulse, constraints, cases,
  scope: "Mechanical sealed-source reproductions across two unpromoted Genome profiles; no language model, no general defect-discovery claim.",
  predicates: commands.map((command, index) => ({ id: `predicate-${index}`, command, expectedExitCode: 0 })) };
const corpusDigest = hash(corpus);
await writeFile(join(root, "corpus.json"), JSON.stringify({ ...corpus, digest: corpusDigest }, null, 2), { flag: "wx" });
const genomes = [1, 2].map((interval) => createGenome({ protocol: "jevyr.genome/1", generation: 0, boneDigest: JEVYR_BONE_DIGEST,
  parentDigests: [], modules: [builtinGenomeModule("jevyr.nursery-governor")],
  parameters: { "jevyr.nursery-governor": { saturationWindow: 8, challengeInterval: interval } } }));
const configurations = genomes.map((genome) => {
  const body = { genomeDigest: genome.digest, runtimeProfile: compileGenomeRuntimeProfile(genome, { expectedBoneDigest: JEVYR_BONE_DIGEST }) };
  return { ...body, configurationDigest: hash(body) };
});

class ReproductionMind implements MindAdapter {
  readonly capability;
  constructor(readonly family: string) {
    this.capability = Object.freeze({ id: `mind.fixture.${family}`, kind: "mind" as const, displayName: `Mechanical reproduction ${family}`, version: implementationDigest,
      transport: "in-process" as const, trust: "local-deterministic" as const, modalities: ["text" as const], network: "none" as const, canExecuteTools: false, deterministic: true,
      limits: { providerId: `fixture-${family}`, modelId: `reproduction-${family}`, modelFamily: `fixture-${family}` } });
  }
  async probe() { return { available: true, observedAt: new Date().toISOString(), latencyMs: 0, detail: "Mechanical test fixture; not a reasoning model" }; }
  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    if (request.stage !== "diverge") return;
    const source = request.subjectProjection?.files.find((file) => file.subjectId === "fixture-source");
    if (!source) throw new Error("The reproduction fixture did not receive its sealed source projection");
    const files = JSON.parse(source.text) as { path: string; content: string }[];
    yield { id: `fixture_${this.family}_${request.seed.slice(-16)}`, kind: "candidate", summary: `Reproduce the sealed predicate bundle in ${this.family}`, feasibility: "BUILDABLE_NOW",
      candidateBlueprintSource: { protocol: "jevyr.candidate-blueprint/1", files: files.map((file) => ({ ...file, content: `// fixture-family:${this.family}\n${file.content}\n// lineage ${request.seed}` })) } };
  }
  async runMetered(request: MindRequest) {
    const contributions: PublicContribution[] = []; for await (const contribution of this.run(request)) contributions.push(contribution);
    return { contributions, tokenUsage: { input: { tokens: 0, measurement: "MEASURED" as const }, output: { tokens: 0, measurement: "MEASURED" as const } },
      transmittedInputBytes: 0, receivedOutputBytes: Buffer.byteLength(JSON.stringify(contributions)) };
  }
}
const minds = [new ReproductionMind("a"), new ReproductionMind("b")];
const seeds = [sha256Digest("paired-genome-seed-1").slice(7)];
const trials: PairedGenomeTrial[] = [];
const proofs: { recordDigest: string; directory: string; signerKeyId: string }[] = [];
const diagnostics: unknown[] = [];
const search = { ...DEFAULT_SEARCH_PROFILE, nursery: { ...DEFAULT_SEARCH_PROFILE.nursery, minimumAttempts: 2, saturationWindow: 16, independentLineages: 2, challengeInterval: 3 },
  resources: { ...DEFAULT_SEARCH_PROFILE.resources, maxMindInvocations: 9, maxInputTokens: 3_000_000, maxOutputTokens: 80_000, maxWallMillis: 900_000,
    maxGeneratedBytes: 3_000_000, maxWritableBytes: 128_000_000, maxArtifactBytes: 64_000_000, maxTotalAssayCost: 32, concurrentLineages: 2 } };
const assays = commands.map((command, index) => {
  const obligation = contract.criticalObligations.find((entry) => entry.oracle?.kind === "command_exit_code" && entry.oracle.operand === command);
  if (!obligation) throw new Error(`Fixture failed to bind command ${command}`);
  return { assayId: `predicate-${index}`, costUnits: 1, tool: "forge.command", args: { command: "node", args: [`check-${index}.mjs`] }, obligationId: obligation.id, timeoutMs: 30_000 };
});

for (const fixture of cases) for (const seed of seeds) for (let repeat = 0; repeat < 2; repeat++) for (let configIndex = 0; configIndex < genomes.length; configIndex++) {
  const directory = join(root, `${fixture.caseKey}-r${repeat}-g${configIndex}`);
  await mkdir(join(directory, ".jevyr"), { recursive: true });
  await writeFile(join(directory, ".jevyr", "policy.json"), JSON.stringify({ protocol: "jevyr.policy/1", policyVersion: "bone-v1", semanticContinuation: false,
    reflex: { required: true, maximumLoops: 2 }, forge: { network: "denied", source: "read_only", missingDocker: "INVALID", dockerImage: "node:24-alpine" },
    memory: { firstWave: "amnesic", maximumLateInfluence: 0.2 }, growth: { liveBoneMutation: false, promotion: "signed_governance" }, search }));
  await writeFile(join(directory, ".jevyr", "assay-frontier.json"), JSON.stringify({ protocol: "jevyr.assay-frontier/1", assays }));
  const runtime = createDaemonRuntime({ projectRoot: directory, dataDir: join(directory, ".jevyr"), env: {}, minds, benchmarkGenome: genomes[configIndex]! });
  const service = createJevyrHttpService({ runtime, env: {} });
  try {
    const { url } = await service.listen(0);
    const client = new JevyrClient({ baseUrl: url });
    const seal = await client.cast({ case: { impulse, constraints, control: "sovereign", privacy: "local_only", seed,
      subjects: [{ id: "fixture-source", kind: "text", locator: JSON.stringify(fixture.files), mediaType: "application/json" }] } });
    process.stdout.write(`${JSON.stringify({ phase: "sealed", root, fixture: fixture.caseKey, repeat, configIndex, caseId: seal.caseId })}\n`);
    const authenticated = await client.waitForAuthenticatedRecord(seal.caseId);
    const events = await runtime.events.read(seal.caseId);
    const proof = join(directory, "proof"); await mkdir(join(proof, "artifacts"), { recursive: true });
    const artifactIndex = await client.artifactList(seal.caseId);
    const attestations = await client.verifiedRunAttestations(seal.caseId);
    const documents = { "record.json": authenticated.payload, "record.dsse.json": authenticated.envelope, "seal-receipt.json": seal,
      "seal.dsse.json": await client.sealEnvelope(seal.caseId), "terminal-receipt.json": authenticated.terminal.payload, "terminal.dsse.json": authenticated.terminal.envelope,
      "trust.json": await client.trustBundle(), "events.json": events, "sealed-case.json": await client.verifiedSealedCase(seal.caseId), "intent-contract.json": await client.intentContract(seal.caseId), "policy-descriptor.json": await client.policyDescriptor(seal.caseId), "artifact-index.json": artifactIndex, "run-attestations.json": attestations.payload };
    for (const [name, value] of Object.entries(documents)) await writeFile(join(proof, name), JSON.stringify(value, null, 2));
    await writeFile(join(proof, "canonical-record.json"), attestations.canonicalRecord, { flag: "wx" });
    const observations: any[] = [];
    const blueprints = new Map<string, any>();
    for (const meta of artifactIndex.artifacts) {
      const value = await client.fetchArtifact(seal.caseId, meta.id);
      await writeFile(join(proof, "artifacts", `${meta.id}.blob`), value.data);
      if (meta.mediaType === "application/vnd.jevyr.tool-observation+json") observations.push(JSON.parse(Buffer.from(value.data).toString("utf8")));
      if (meta.mediaType === "application/vnd.jevyr.candidate-blueprint+json") { const blueprint = JSON.parse(Buffer.from(value.data).toString("utf8")); blueprints.set(blueprint.blueprintDigest, blueprint); }
    }
    const verified = await verifyLocalProof(proof, authenticated.keyId);
    await writeFile(join(proof, "replay.json"), JSON.stringify(verified, null, 2));
    if (!verified.valid) throw new Error(`Independent replay failed: ${verified.problems.join("; ")}`);
    const cells = observations.filter((entry) => entry.metadata?.assayId && entry.metadata?.candidateId && entry.metadata?.admissible === true
      && entry.oracle?.execution?.mode === "docker" && entry.oracle.execution.state === "exited" && ["PASSED", "FAILED"].includes(entry.metadata.typedOracleStatus));
    const candidateIds = [...new Set(observations.map((entry) => entry.metadata?.candidateId).filter(Boolean))] as string[];
    const accusations = [...new Set(cells.filter((entry) => entry.metadata.typedOracleStatus === "FAILED").map((entry) => entry.metadata.assayId))] as string[];
    const resources = events.filter((event) => event.kind === "search.status").at(-1)?.payload.resources ?? [];
    const resource = (name: string) => resources.find((entry: any) => entry.name === name);
    const tokenInput = resource("inputTokens"), tokenOutput = resource("outputTokens");
    const { directory: _directory, ...portableReplay } = verified;
    const record = authenticated.payload;
    const judgment = record.verdict.integrity === "INVALID" ? "INVALID" : record.verdict.judgment;
    if (judgment === "NOT_APPLICABLE") throw new Error("A non-invalid benchmark Record has no applicable judgment");
    const lanes = candidateIds.flatMap((candidateId, index) => {
      const candidateCells = cells.filter((entry) => entry.metadata.candidateId === candidateId);
      if (candidateCells.length !== assays.length) return [];
      const blueprintText = JSON.stringify(blueprints.get(candidateCells[0]?.metadata.candidateBlueprintDigest) ?? "");
      const family = /fixture-family:([ab])/u.exec(blueprintText)?.[1];
      if (!family) return [];
      return [{ laneId: `candidate-${index}`, familyId: `fixture-${family}`, findings: assays.map((assay) => candidateCells.find((entry) => entry.metadata.assayId === assay.assayId)?.metadata.typedOracleStatus === "FAILED") }];
    });
    const uniqueCells = new Set(cells.map((entry) => `${entry.metadata.candidateId}/${entry.metadata.assayId}`));
    const providerSnapshotDigest = hash((documents["policy-descriptor.json"].artifact.descriptor as any).policy.mindCapabilities);
    const trial: PairedGenomeTrial = { caseKey: fixture.caseKey, corpusDigest, subjectDigest: seal.subjectMaterialCaptureDigest, seedDigest: sha256Digest(seed), providerSnapshotDigest,
      configurationDigest: configurations[configIndex]!.configurationDigest, repeat, recordDigest: hash(record), evidenceDigest: record.verdict.evidenceDigest,
      replayDigest: hash(portableReplay), replayVerified: true, judgment,
      physicalObservationDigest: derivePhysicalReproducibility(observations).digest,
      criticalDefectIds: fixture.criticalDefectIds, reproducedDefectIds: accusations.filter((id) => fixture.criticalDefectIds.includes(id)), accusedDefectIds: accusations, clean: fixture.clean,
      coverage: candidateIds.length ? { covered: uniqueCells.size, eligible: candidateIds.length * assays.length } : null,
      cost: tokenInput?.measurement === "MEASURED" && tokenOutput?.measurement === "MEASURED" && tokenInput.used !== null && tokenOutput.used !== null
        ? { wallMillis: Math.max(0, Date.parse(authenticated.terminal.payload.closedAt) - Date.parse(seal.sealedAt)), inputTokens: tokenInput.used, outputTokens: tokenOutput.used } : null,
      lanes, marginal: uniqueCells.size > 1 ? { additionalDecisiveEvidence: uniqueCells.size - 1, additionalCostUnits: cells.slice(1).reduce((sum, entry) => sum + (entry.metadata.boneAccounting?.costUnitsCharged ?? 0), 0) } : null };
    trials.push(trial); proofs.push({ recordDigest: trial.recordDigest, directory: proof, signerKeyId: authenticated.keyId });
    diagnostics.push({ caseId: seal.caseId, fixture: fixture.caseKey, repeat, configIndex, measuredCells: cells.length, candidateIds, laneFamilies: lanes.map((lane) => lane.familyId), tokenInput, tokenOutput });
    await writeFile(join(directory, "measurement.json"), JSON.stringify(trial, null, 2));
    await writeFile(join(root, "progress.json"), JSON.stringify({ configurations, trials, proofs, diagnostics }, null, 2));
    process.stdout.write(`${JSON.stringify({ phase: "measured", fixture: fixture.caseKey, repeat, configIndex, judgment: trial.judgment, replayVerified: true, cells: cells.length })}\n`);
  } finally { await service.close(); }
}
const report = compileGenomeBenchmark(configurations, trials);
const key = generateSigningKeyPair();
// Dedicated experiment identity; never installed as governance trust.
const signed = signGenomeBenchmark(report, key.privateKeyPem, key.keyId);
await writeFile(join(root, "benchmark-public-key.json"), JSON.stringify({ keyId: key.keyId, publicKeyPem: key.publicKeyPem, authority: "local-benchmark-only" }, null, 2));
await writeFile(join(root, "benchmark.json"), JSON.stringify(signed, null, 2));
await writeFile(join(root, "input.json"), JSON.stringify({ configurations, trials, proofs, corpus: { ...corpus, digest: corpusDigest } }, null, 2));
await writeFile(join(root, "scope.json"), JSON.stringify({ corpusDigest, providerSnapshotDigests: [...new Set(trials.map(trial => trial.providerSnapshotDigest))], implementationDigest, empirical: true, languageModelUsed: false,
  scope: corpus.scope, activeGenomeChanged: false, experimentGenomesPromoted: false,
  measurementNotes: ["Token use is zero because these mechanical providers have no model/tokenizer; source/output bytes are charged separately.", "Marginal value counts additional distinct resolved candidate-predicate cells after the first, per actual declared assay cost.", "Fixture families share the same reproduction algorithm; correlation is measured association, not an independence claim.", "Physical reproducibility compares exact command-result multisets; signed evidence digests separately retain wall-clock and receipt differences."] }, null, 2));
process.stdout.write(`${JSON.stringify({ phase: "complete", root, trials: trials.length, configurations: configurations.length, reportDigest: report.digest, pareto: report.pareto, limitations: report.limitations })}\n`);
