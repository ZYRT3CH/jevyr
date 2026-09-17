import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { compileGenomeBenchmark, derivePhysicalReproducibility, signGenomeBenchmark, type PairedGenomeTrial } from "../packages/growth/dist/index.js";
import { generateSigningKeyPair } from "../packages/core/dist/index.js";
import { digestJson, sha256Digest, validateSealedCase, type JsonValue } from "../packages/protocol/dist/index.js";
import { verifyLocalProof } from "../apps/cli/dist/local-proof.js";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "artifacts", "paired-genome-1788576098360"));
const output = join(root, `recompiled-${Date.now()}`);
await mkdir(output, { recursive: true });
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const hash = (value: unknown) => digestJson(value as JsonValue);
const original = await json(join(root, "input.json"));
const corpus = await json(join(root, "corpus.json"));
const trials: PairedGenomeTrial[] = [];
const physical: unknown[] = [];
for (const before of original.trials as PairedGenomeTrial[]) {
  const ref = original.proofs.find((entry: { recordDigest: string }) => entry.recordDigest === before.recordDigest);
  if (!ref) throw new Error("Missing original proof");
  const proof = resolve(ref.directory);
  const seal = await json(join(proof, "seal-receipt.json"));
  const policy = await json(join(proof, "policy-descriptor.json"));
  const stored = await json(join(dirname(proof), ".jevyr", "cases", seal.caseId, "status.json"));
  const valid = validateSealedCase(stored.sealed);
  if (!valid.ok || !valid.value || valid.value.caseDigest !== seal.caseDigest || valid.value.runDigest !== seal.runDigest) throw new Error("Stored normalized Case no longer matches its Seal");
  // Supplement disclosure with already-sealed bytes; original signed documents,
  // reports and metrics are preserved. This performs no new Case or assay.
  const specPath = join(proof, "sealed-case.json");
  await writeFile(specPath, JSON.stringify(valid.value, null, 2), { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST" || hash(await json(specPath)) !== hash(valid.value)) throw error;
  });
  const replay = await verifyLocalProof(proof, ref.signerKeyId);
  if (!replay.valid) throw new Error(`Original proof no longer replays: ${replay.problems.join("; ")}`);
  const index = await json(join(proof, "artifact-index.json"));
  const observations: any[] = [], blueprints = new Map<string, any>();
  for (const meta of index.artifacts) {
    if (!["application/vnd.jevyr.tool-observation+json", "application/vnd.jevyr.candidate-blueprint+json"].includes(meta.mediaType)) continue;
    const bytes = await readFile(join(proof, "artifacts", `${meta.id}.blob`));
    if (sha256Digest(bytes) !== meta.digest) throw new Error("Authenticated artifact bytes changed during metric extraction");
    const value = JSON.parse(bytes.toString("utf8"));
    if (meta.mediaType === "application/vnd.jevyr.tool-observation+json") observations.push(value);
    else blueprints.set(value.blueprintDigest, value);
  }
  const cells = observations.filter(entry => entry.metadata?.assayId && entry.metadata?.candidateId && entry.metadata.admissible === true
    && entry.oracle?.execution?.mode === "docker" && entry.oracle.execution.state === "exited" && ["PASSED", "FAILED"].includes(entry.metadata.typedOracleStatus));
  const candidateIds = [...new Set(cells.map(entry => entry.metadata.candidateId))] as string[];
  const lanes = candidateIds.flatMap((candidateId, index) => {
    const selected = cells.filter(entry => entry.metadata.candidateId === candidateId);
    const family = /fixture-family:([ab])/u.exec(JSON.stringify(blueprints.get(selected[0]?.metadata.candidateBlueprintDigest) ?? ""))?.[1];
    if (selected.length !== corpus.predicates.length || !family) return [];
    return [{ laneId: `candidate-${index}`, familyId: `fixture-${family}`, findings: corpus.predicates.map((predicate: { id: string }) => selected.find(entry => entry.metadata.assayId === predicate.id)?.metadata.typedOracleStatus === "FAILED") }];
  });
  const measurement = derivePhysicalReproducibility(observations);
  const { directory: ignored, ...portable } = replay;
  const trial = { ...before, seedDigest: sha256Digest(valid.value.intent.seed), providerSnapshotDigest: hash(policy.artifact.descriptor.policy.mindCapabilities),
    replayDigest: hash(portable), lanes, physicalObservationDigest: measurement.digest };
  trials.push(trial); physical.push({ recordDigest: trial.recordDigest, measurement, families: lanes.map(lane => lane.familyId) });
}
const input = { configurations: original.configurations, trials, proofs: original.proofs, corpus };
const report = compileGenomeBenchmark(input.configurations, input.trials);
const key = generateSigningKeyPair();
const files = { "input.json": input, "benchmark.json": signGenomeBenchmark(report, key.privateKeyPem, key.keyId),
  "benchmark-public-key.json": { keyId: key.keyId, publicKeyPem: key.publicKeyPem, authority: "local-benchmark-only" },
  "physical-measurements.json": physical,
  "recompilation.json": { protocol: "jevyr.benchmark-recompilation/1", originalReportDigest: hash(await json(join(root, "benchmark.json"))),
    processorDigest: sha256Digest(await readFile(import.meta.filename)), sourceRoot: root, reportDigest: report.digest, newExecutions: 0,
    changes: ["Candidate families are derived using inner blueprintDigest rather than CAS wrapper digest.", "Provider and seed identities are derived from authenticated sealed policy and Case.", "Physical command-result reproducibility is separate from run-specific evidence identity.", "Dependent finite fixtures receive descriptive metrics without population confidence claims."],
    scope: corpus.scope, originalSignedDocumentsPreserved: true } };
for (const [name, value] of Object.entries(files)) await writeFile(join(output, name), JSON.stringify(value, null, 2), { flag: "wx" });
process.stdout.write(`${JSON.stringify({ output, trials: trials.length, pareto: report.pareto, metrics: report.results })}\n`);
