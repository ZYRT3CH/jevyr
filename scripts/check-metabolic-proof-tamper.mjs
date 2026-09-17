import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalize, digestJson, sha256Digest } from "../packages/protocol/dist/index.js";
import { verifyMetabolicExperiment } from "../benchmarks/verify-metabolic-calibration.mjs";

const original = resolve(process.argv[2]);
const altered = resolve(`artifacts/metabolic-proof-tamper-${Date.now()}`);
await cp(original, altered, { recursive: true, errorOnExist: true, force: false });
const report = JSON.parse(await readFile(join(altered, "Mass.json"), "utf8"));
const trial = report.trials[0];
let mutated = false;
for (let index = 0; index < trial.observationArtifactDigests.length; index++) {
  const digest = trial.observationArtifactDigests[index];
  const value = JSON.parse(await readFile(join(altered, "artifacts", `${digest.slice(7)}.json`), "utf8"));
  if (value.protocol !== "jevyr.metabolic-host-oracle/1") continue;
  value.sourceText = "console.log('fabricated oracle output');";
  value.sourceDigest = sha256Digest(value.sourceText);
  const bytes = canonicalize(value); const replacement = sha256Digest(bytes);
  await writeFile(join(altered, "artifacts", `${replacement.slice(7)}.json`), bytes);
  trial.observationArtifactDigests[index] = replacement; mutated = true; break;
}
assert.equal(mutated, true);
const { digest: _, ...body } = report;
await writeFile(join(altered, "Mass.json"), canonicalize({ ...body, digest: digestJson(body) }));
let reason;
try { await verifyMetabolicExperiment(altered); }
catch (error) { reason = error.message; }
assert.ok(reason, "A forged execution claim with recomputed digests must be rejected");
const result = { protocol: "jevyr.metabolic-adversarial-check/1", rejected: true, mutation: "Changed claimed oracle program and recomputed artifact/reference/report digests while preserving favorable statistics", original, altered, reason };
await writeFile(join(altered, "adversarial-check.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ rejected: true, report: join(altered, "adversarial-check.json") }));
