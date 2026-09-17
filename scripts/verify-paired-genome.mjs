import assert from "node:assert/strict";
import { createPublicKey } from "node:crypto";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { keyIdFor } from "../packages/core/dist/index.js";
import { compileGenomeBenchmark, validatePairedFixtureCorpus, verifyGenomeBenchmark } from "../packages/growth/dist/index.js";
import { replayTrialProofs } from "../apps/cli/dist/governance-commands.js";

if (process.argv.length !== 3) throw new TypeError("Usage: node scripts/verify-paired-genome.mjs PAIRED_BENCHMARK_DIRECTORY");
const directory = resolve(process.argv[2]);
async function json(path) {
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= 32 * 1024 * 1024);
  const bytes = await readFile(path), after = await lstat(path);
  assert.equal(bytes.length, before.size); assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.mtimeMs, before.mtimeMs);
  return JSON.parse(bytes.toString("utf8"));
}
const publicIdentity = await json(join(directory, "benchmark-public-key.json"));
const key = createPublicKey(publicIdentity.publicKeyPem);
assert.equal(keyIdFor(key), publicIdentity.keyId);
const report = verifyGenomeBenchmark(await json(join(directory, "benchmark.json")), new Map([[publicIdentity.keyId, key]]));
const input = await json(join(directory, "input.json"));
assert.deepEqual(compileGenomeBenchmark(input.configurations, input.trials), report);
for (const proof of input.proofs) {
  const part = relative(directory, resolve(directory, proof.directory));
  assert.ok(part && !part.startsWith("..") && !isAbsolute(part), "Paired proof reference escaped its retained experiment");
}
await replayTrialProofs(input.proofs, report, directory, validatePairedFixtureCorpus(input.corpus));
const result = {
  protocol: "jevyr.paired-genome-proof-verification/1", valid: true, directory,
  benchmarkDigest: report.digest, benchmarkSignerKeyId: publicIdentity.keyId,
  configurations: report.configurations.length, trials: report.trials.length,
  proofBindings: input.proofs.map(proof => ({ ...proof, directory: relative(directory, resolve(directory, proof.directory)).split("\\").join("/") })),
  judgments: Object.fromEntries([...new Set(report.trials.map(trial => trial.judgment))].map(judgment => [judgment, report.trials.filter(trial => trial.judgment === judgment).length])),
  scope: "Independently authenticated terminal proofs, complete replay, revealed seed/provider/profile/corpus bindings, physical observation digests, and signed benchmark metric recomputation. No fresh OCI execution, governance promotion, or general model-performance claim.",
  limitations: report.limitations,
};
const output = join(directory, "independent-verification.json");
await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify({ valid: true, output, benchmarkDigest: report.digest, trials: result.trials, judgments: result.judgments }) + "\n");
