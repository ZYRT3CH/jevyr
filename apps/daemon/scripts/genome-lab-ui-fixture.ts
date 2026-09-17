/** Read-only HISTORICAL UI fixture. No daemon Cast, real registry, or current
 * Genome selection is changed. Run with tsx --conditions=development. */
import Fastify from "fastify";
import { generateKeyPairSync, createPublicKey } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keyIdFor, JEVYR_BONE_DIGEST } from "@jevyr/core";
import { createGenomePreset, signGenomePreset, verifyGenomeBenchmark, PresetRegistry } from "@jevyr/growth";
import { digestJson, canonicalize, type JsonValue } from "@jevyr/protocol";
import { verifySealEnvelope, verifyRecordEnvelope, verifyTerminalEnvelope } from "../../../packages/sdk/src/index.js";
import { readGenomeLab } from "../src/genome-lab.js";
import type { DaemonRuntime } from "../src/runtime.js";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const output = join(root, "artifacts", `genome-lab-ui-${Date.now()}`);
const benchmarkRoot = join(root, "artifacts/paired-genome-1788576098360/recompiled-1788578267653");
const pairedProof = join(root, "artifacts/paired-genome-1788576098360/two-planted-defects-r0-g0/proof");
const selfRoot = join(root, "artifacts/self-judgment-defect-1788582363705");
const json = (value: unknown) => value as JsonValue;
async function read(path: string) {
  const bytes = await readFile(path);
  if (bytes.byteLength > 4_194_304) throw new Error("Fixture input exceeds its bound");
  return JSON.parse(bytes.toString("utf8"));
}
async function save(name: string, value: unknown) { await writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" }); }
await mkdir(output, { recursive: false });
const benchmark = await read(join(benchmarkRoot, "benchmark.json"));
const publicBenchmark = await read(join(benchmarkRoot, "benchmark-public-key.json"));
const benchmarkKey = createPublicKey(publicBenchmark.publicKeyPem);
if (keyIdFor(benchmarkKey) !== publicBenchmark.keyId) throw new Error("Benchmark public key identity changed");
const report = verifyGenomeBenchmark(benchmark, new Map([[publicBenchmark.keyId, benchmarkKey]]));
const selected = report.configurations.find(value => value.configurationDigest === report.pareto[0]);
if (!selected) throw new Error("Retained report has no measured Pareto configuration");

// Verify the archived startup source as public signed material. This is not a
// new claim of current-Bone execution or independent physical-evidence replay.
const trust = await read(join(pairedProof, "trust.json"));
const seal = await verifySealEnvelope(await read(join(pairedProof, "seal.dsse.json")), trust, await read(join(pairedProof, "seal-receipt.json")));
const record = await verifyRecordEnvelope(await read(join(pairedProof, "record.dsse.json")), trust, await read(join(pairedProof, "record.json")));
const terminal = await verifyTerminalEnvelope(await read(join(pairedProof, "terminal.dsse.json")), trust, await read(join(pairedProof, "terminal-receipt.json")));
const policy = await read(join(pairedProof, "policy-descriptor.json"));
if (seal.keyId !== record.keyId || seal.keyId !== terminal.keyId || record.payload.runDigest !== seal.payload.runDigest
  || terminal.payload.recordDigest !== digestJson(json(record.payload)) || policy.policyDigest !== seal.payload.policyDigest
  || digestJson(json(policy.artifact.descriptor)) !== seal.payload.policyDigest || selected.genomeDigest !== seal.payload.genomeDigest) throw new Error("Historical proof binding mismatch");
const archivedSelection = policy.artifact.descriptor.policy.genomeSelection;
if (archivedSelection.runtimeCompilation.runtimeProfile.profileDigest !== selected.runtimeProfile.profileDigest) throw new Error("Historical preset and sealed runtime profile differ");

const testKeys = generateKeyPairSync("ed25519"), testKeyId = keyIdFor(testKeys.publicKey);
const keys = new Map([[publicBenchmark.keyId, benchmarkKey], [testKeyId, testKeys.publicKey]]);
const preset = createGenomePreset("HISTORICAL QA ONLY - retained paired fixture", report, selected.configurationDigest);
const signed = signGenomePreset(preset, benchmark, keys, testKeys.privateKey, testKeyId);
const registry = new PresetRegistry(join(output, "presets"));
await registry.save(signed, keys);
await registry.select(preset.digest, keys);
const selection = registry.readSelectionSync(keys);
const publicTrust = { protocol: "jevyr.genome-governance-trust/1", keys: [...keys].map(([keyId, key]) => ({ keyId, algorithm: "Ed25519", publicKeyPem: key.export({ type: "spki", format: "pem" }).toString() })) };
await save("TEST-ONLY-public-governance-trust.json", publicTrust);
await save("signed-historical-preset.json", signed);

const selfReport = await read(join(selfRoot, "report.json"));
const selfVerified = await read(join(selfRoot, "self-proof-verification.json"));
const requests = selfReport.offspringRequests;
if (!selfVerified.valid || !Array.isArray(requests) || requests.length !== 1) throw new Error("Retained self-failure verification is missing");
const intake = requests[0], { digest: requestDigest, ...requestBody } = intake;
if (digestJson(json(requestBody)) !== requestDigest || requestDigest !== selfVerified.quarantinedRequestDigest
  || intake.source.recordDigest !== selfVerified.recordDigest || intake.source.caseId !== selfVerified.caseId || intake.activeGenomeChanged !== false || intake.governanceSignature !== null) throw new Error("Self-failure intake binding changed");
const genomeRegistry = join(output, "genome-registry");
await mkdir(join(genomeRegistry, "self-judge-requests"), { recursive: true });
await writeFile(join(genomeRegistry, "self-judge-requests", `${requestDigest.slice(7)}.json`), canonicalize(json(intake)), { flag: "wx" });

const presetDescriptor = { protocol: "jevyr.preset-startup-selection/1", selection: selection.selection, genomeDigest: selected.genomeDigest,
  governanceTrustDigest: digestJson(json(publicTrust)), preset, benchmark, attestation: signed.attestation,
  effectiveRuntimeProfile: selected.runtimeProfile, pointerRead: "historical-ui-fixture-only", scope: "read-only; cannot execute under current Bone",
  wildMeaning: "remove-preset-restrictions; active-Genome-and-project-policy-remain" };
// The fixture exposes the real read-only API projection, using archived source
// identity and an unmistakable visible label. There is no executable runtime.
const archivedView = {
  repository: { genomeVersion: "HISTORICAL VIEW - not current startup", genomeDigest: selected.genomeDigest },
  genome: { registryRoot: genomeRegistry, source: "benchmark-experiment", descriptor: archivedSelection, descriptorDigest: digestJson(json(archivedSelection)) },
  preset: { signed, descriptor: presetDescriptor, descriptorDigest: digestJson(json(presetDescriptor)) },
} as unknown as DaemonRuntime;
const response = await readGenomeLab(archivedView);
await save("genome-lab.json", response);
const server = Fastify({ logger: false, bodyLimit: 1024 });
server.addHook("onRequest", async (request, reply) => {
  const origin = request.headers.origin;
  if (origin) {
    const parsed = new URL(origin);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return reply.code(403).send({ error: "Local QA origin required" });
    reply.header("access-control-allow-origin", origin).header("vary", "Origin");
  }
  reply.header("cache-control", "no-store").header("x-jevyr-fixture", "historical-read-only-qa");
  if (request.method !== "GET" && request.method !== "OPTIONS") return reply.code(405).send({ error: "Read-only historical QA fixture; no Case or governance mutations exist" });
});
server.options("/*", async (_request, reply) => reply.header("access-control-allow-methods", "GET, OPTIONS").header("access-control-allow-headers", "content-type").code(204).send());
server.get("/v1/genome-lab", async () => response);
server.get("/fixture", async () => ({ scope: "HISTORICAL READ-ONLY UI FIXTURE", currentBoneDigest: JEVYR_BONE_DIGEST, measuredBoneDigest: selected.runtimeProfile.boneDigest, currentSelection: false, testGovernanceKey: testKeyId }));
const url = await server.listen({ port: 4330, host: "127.0.0.1" });
const fixtureReport = { protocol: "jevyr.genome-lab-ui-fixture/1", url, pid: process.pid, output, historical: true,
  currentSelection: false, mutations: false, currentBoneDigest: JEVYR_BONE_DIGEST, measuredBoneDigest: selected.runtimeProfile.boneDigest,
  benchmarkDigest: report.digest, presetDigest: preset.digest, testOnlyGovernanceKeyId: testKeyId, privateKeyPersisted: false,
  configurations: report.configurations.length, trials: report.trials.length, quarantinedRequestDigest: requestDigest,
  scope: "Verified retained benchmark/signatures and copied verified self-failure intake. UI coverage only; no fresh execution or current Genome admission." };
await save("report.json", fixtureReport);
process.stdout.write(JSON.stringify(fixtureReport) + "\n");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void server.close(); });
