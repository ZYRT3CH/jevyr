/** Start the frozen compiled runtime with a TEST-only signed preset in a new
 * isolated store. HTTP mutations are disabled. No real governance key is used. */
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, dirname, relative, isAbsolute } from "node:path";
import { keyIdFor, JEVYR_BONE_DIGEST } from "@jevyr/core";
import { createGenomePreset, signGenomePreset, verifyGenomeBenchmark, validatePairedFixtureCorpus, PresetRegistry, type StoredGenome } from "@jevyr/growth";
import { canonicalize, digestJson, type JsonValue } from "@jevyr/protocol";
import { RuleMindAdapter, SealedForgeAdapter } from "@jevyr/runtime";
import { createDaemonRuntime } from "../dist/runtime.js";
import { createJevyrHttpService } from "../dist/server.js";
import { replayTrialProofs } from "../../cli/dist/governance-commands.js";
import { JevyrClient } from "../../../packages/sdk/dist/index.js";

if (process.argv.length !== 4) throw new TypeError("Usage: current-genome-lab-ui-fixture.ts ABSOLUTE_PAIRED_BENCHMARK_DIRECTORY ABSOLUTE_SELF_PROOF_DIRECTORY");
const benchmarkRoot = resolve(process.argv[2]!);
const selfRoot = resolve(process.argv[3]!);
const output = join(dirname(benchmarkRoot), `genome-lab-current-ui-${Date.now()}`);
const json = (value: unknown) => value as JsonValue;
const read = async (path: string) => { const bytes = await readFile(path); if (bytes.length > 4_194_304) throw new Error("QA input exceeds read bound"); return JSON.parse(bytes.toString("utf8")); };
const signedBenchmark = await read(join(benchmarkRoot, "benchmark.json"));
const publicBenchmark = await read(join(benchmarkRoot, "benchmark-public-key.json"));
const benchmarkKey = createPublicKey(publicBenchmark.publicKeyPem);
if (keyIdFor(benchmarkKey) !== publicBenchmark.keyId) throw new Error("Benchmark public key changed");
const report = verifyGenomeBenchmark(signedBenchmark, new Map([[publicBenchmark.keyId, benchmarkKey]]));
const selected = report.configurations.find(value => value.configurationDigest === report.pareto[0]);
if (!selected || selected.runtimeProfile.boneDigest !== JEVYR_BONE_DIGEST) throw new Error("Benchmark is not measured for the current Bone; no current preset fixture may be selected");
const input = await read(join(benchmarkRoot, "input.json"));
await replayTrialProofs(input.proofs, report, benchmarkRoot, validatePairedFixtureCorpus(input.corpus));
const trial = report.trials.find(value => value.configurationDigest === selected.configurationDigest)!;
const proof = input.proofs.find((value: { recordDigest: string }) => value.recordDigest === trial.recordDigest);
const proofPath = resolve(benchmarkRoot, proof.directory), part = relative(benchmarkRoot, proofPath);
if (part.startsWith("..") || isAbsolute(part)) throw new Error("Fixture proof reference escaped benchmark store");
const genomeArtifact = await read(join(dirname(proofPath), ".jevyr", "descriptors", `${selected.genomeDigest.slice(7)}.json`));
if (genomeArtifact.digest !== selected.genomeDigest || digestJson(json(genomeArtifact.descriptor)) !== selected.genomeDigest) throw new Error("Measured Genome artifact changed");
const genome: StoredGenome = { digest: selected.genomeDigest, body: genomeArtifact.descriptor };

await mkdir(output, { recursive: false });
const testKey = generateKeyPairSync("ed25519"), testKeyId = keyIdFor(testKey.publicKey);
const keys = new Map([[publicBenchmark.keyId, benchmarkKey], [testKeyId, testKey.publicKey]]);
const trust = { protocol: "jevyr.genome-governance-trust/1", keys: [...keys].map(([keyId, key]) => ({ keyId, algorithm: "Ed25519", publicKeyPem: key.export({ type: "spki", format: "pem" }).toString() })) };
const trustPath = join(output, "TEST-ONLY-public-governance-trust.json");
await writeFile(trustPath, JSON.stringify(trust, null, 2), { flag: "wx" });
const registry = new PresetRegistry(join(output, "presets"));
const preset = createGenomePreset("TEST QA ONLY - current paired fixture", report, selected.configurationDigest);
const signed = signGenomePreset(preset, signedBenchmark, keys, testKey.privateKey, testKeyId);
await registry.save(signed, keys); await registry.select(preset.digest, keys);
const genomeRegistry = join(output, "genome-registry");
// Independently replay the actual self-failure before copying its quarantined intake.
const { verifySelfJudgmentProof } = await import(new URL("../../../benchmarks/verify-self-judgment-proof.mjs", import.meta.url).href);
const verifiedSelf = await verifySelfJudgmentProof(selfRoot);
const self = await read(join(selfRoot, "report.json"));
if (self.offspringRequests.length !== 1 || !verifiedSelf.valid) throw new Error("Self-failure QA source is not the verified retained proof");
const request = self.offspringRequests[0], { digest, ...body } = request;
if (digestJson(json(body)) !== digest || digest !== verifiedSelf.quarantinedRequestDigest || request.source.recordDigest !== verifiedSelf.recordDigest) throw new Error("Copied self-failure request changed");
await mkdir(join(genomeRegistry, "self-judge-requests"), { recursive: true });
await writeFile(join(genomeRegistry, "self-judge-requests", `${digest.slice(7)}.json`), canonicalize(json(request)), { flag: "wx" });
const runtime = createDaemonRuntime({ projectRoot: output, dataDir: join(output, "store"), benchmarkGenome: genome,
  minds: [new RuleMindAdapter()], forge: new SealedForgeAdapter({ mode: "observe-only" }),
  env: { JEVYR_GENOME_GOVERNANCE_TRUST_FILE: trustPath, JEVYR_GENOME_REGISTRY_DIR: genomeRegistry, JEVYR_PRESET_REGISTRY_DIR: registry.root } });
const service = createJevyrHttpService({ runtime, env: {} });
service.fastify.addHook("onRequest", async (request, reply) => {
  reply.header("x-jevyr-fixture", "test-only-current-genome-qa");
  if (request.method !== "GET" && request.method !== "OPTIONS") return reply.code(405).send({ error: "Read-only TEST fixture; no Case or governance mutations" });
});
const { url } = await service.listen(4331, "127.0.0.1");
const view = await new JevyrClient({ baseUrl: url }).genomeLab();
if (view.active.digest !== selected.genomeDigest || view.preset?.mode !== "preset" || view.selfJudgmentRequests?.length !== 1) throw new Error("Current startup fixture failed its real SDK projection");
await writeFile(join(output, "genome-lab.json"), JSON.stringify(view, null, 2), { flag: "wx" });
const result = { protocol: "jevyr.genome-lab-ui-fixture/1", url, pid: process.pid, output, historical: false, currentSelection: true,
  executionBuild: "frozen-compiled-runtime",
  currentBoneDigest: JEVYR_BONE_DIGEST, measuredBoneDigest: selected.runtimeProfile.boneDigest, benchmarkDigest: report.digest,
  presetDigest: preset.digest, testOnlyGovernanceKeyId: testKeyId, privateKeyPersisted: false, configurations: report.configurations.length,
  trials: report.trials.length, quarantinedRequestDigest: digest, selfJudgmentProof: selfRoot, selfJudgmentRecordDigest: verifiedSelf.recordDigest, mutations: false, activeGenomeChanged: false,
  scope: "Actual isolated frozen compiled startup with a matching-Bone measured paired preset and explicit TEST governance; no real registry or Genome promotion. Quarantined self-failure is independently replayed from its separately retained proof." };
await writeFile(join(output, "report.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify(result) + "\n");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void service.close(); });
