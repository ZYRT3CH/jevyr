import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { qualificationDigest, qualificationHash } from "../benchmarks/live-model-fixtures.mjs";
import { verifyLiveModelQualification } from "../benchmarks/verify-live-model-qualification.mjs";
import { attemptFailureCategories, priorOverrideSummary } from "../benchmarks/prior-override-measurement.mjs";

const root = resolve(process.argv[2]);
const verification = await verifyLiveModelQualification(root, { development: process.argv.includes("--development") });
const json = async path => JSON.parse(await readFile(path, "utf8"));
const optional = async path => { try { await access(path); } catch { return null; } return json(path); };
const sealed = (value, label) => { const { digest, ...body } = value; assert.equal(qualificationDigest(body), digest, `${label} digest mismatch`); return value; };
const manifest = await json(join(root, "manifest.json"));
const attempts = [], failureCategoryCounts = {};
for (const planned of manifest.planned) {
  const checked = verification.attempts.find(value => value.attemptId === planned.attemptId), fixture = manifest.corpus.cases.find(value => value.caseKey === planned.caseKey);
  const directory = join(root, planned.directory), result = await json(join(directory, "result.json"));
  const invocations = await json(join(directory, "invocations.json"));
  const observations = [];
  if (checked.checks?.fullReplay) {
    const proof = join(directory, "proof"), index = await json(join(proof, "artifact-index.json"));
    for (const meta of index.artifacts.filter(value => value.mediaType === "application/vnd.jevyr.tool-observation+json")) {
      const path = join(proof, "artifacts", `${meta.id}.blob`), raw = await readFile(path);
      assert.equal(qualificationHash(raw), meta.digest); assert.equal(raw.length, meta.size);
      const observation = JSON.parse(raw.toString("utf8")), execution = observation.oracle?.execution;
      if (execution?.mode !== "docker" || execution.state !== "exited") continue;
      const streams = {};
      for (const channel of ["stdout", "stderr"]) {
        const capture = execution[`${channel}Capture`], data = Buffer.from(capture.data, "base64");
        assert.equal(data.toString("base64"), capture.data); assert.equal(data.length, capture.byteLength); assert.equal(qualificationHash(data), capture.digest);
        streams[channel] = { digest: capture.digest, complete: capture.complete, byteLength: data.length, text: data.subarray(0, 8192).toString("utf8"), textTruncated: data.length > 8192 };
      }
      observations.push({ artifact: `${planned.directory}/proof/artifacts/${meta.id}.blob`, artifactDigest: meta.digest,
        assayId: observation.metadata.assayId, candidateId: observation.metadata.candidateId, exitCode: execution.exitCode, ...streams });
    }
  }
  const defective = fixture.expectedJudgment === "REJECT", failure = attemptFailureCategories({ checked, result, invocations, defective });
  for (const category of failure.categories) failureCategoryCounts[category] = (failureCategoryCounts[category] ?? 0) + 1;
  attempts.push({ providerId: planned.providerId, seed: planned.seed, caseKey: planned.caseKey, pairKey: fixture.pairKey ?? null, template: fixture.template ?? "clamp", defective, caseId: result.caseId, proof: `${planned.directory}/proof`,
    qualified: checked.qualified, checks: checked.checks ?? null, verificationError: checked.error ?? null,
    verdict: { integrity: result.verdict?.integrity ?? null, judgment: result.verdict?.judgment ?? null },
    modelInvocations: invocations.invocations.length,
    failedModelInvocations: invocations.invocations.filter(value => value.status !== "RETURNED").map(value => ({ ordinal: value.ordinal, stage: value.stage, error: value.error, transmittedInputUpperBound: value.transmittedInputUpperBound })),
    probeRows: checked.probeRows ?? [], failureCategories: failure.categories, primaryFailure: failure.primary, providerFailureKinds: failure.providerFailureKinds, observations });
}
const recovery = await optional(join(root, "recovery-measurement.json")), blindArm = await optional(join(root, "blind-arm", "report.json"));
if (recovery) { sealed(recovery, "recovery-measurement.json"); assert.equal(recovery.manifestDigest, manifest.digest, "recovery measurement belongs to another manifest"); }
if (blindArm) { sealed(blindArm, "blind-arm/report.json"); assert.equal(blindArm.manifestDigest, manifest.digest, "blind arm belongs to another manifest"); }
const generated = manifest.corpus.kind === "generated";
const body = { protocol: "jevyr.live-model-qualification-summary/1", manifestDigest: manifest.digest, corpusKind: manifest.corpus.kind ?? "fixed",
  planned: verification.planned, attempted: verification.attempted, qualified: verification.qualified,
  authenticatedReplays: attempts.filter(value => value.checks?.fullReplay).length,
  exactSourceInspections: attempts.filter(value => value.checks?.actualSourceInspection).length,
  modelInvocations: attempts.reduce((sum, value) => sum + value.modelInvocations, 0),
  failedModelInvocations: attempts.reduce((sum, value) => sum + value.failedModelInvocations.length, 0),
  distinctExecutedObservationArtifacts: attempts.reduce((sum, value) => sum + value.observations.length, 0),
  failureCategoryCounts, priorOverride: priorOverrideSummary({ manifest, verification }),
  recovery: recovery ? { protocol: recovery.protocol, measured: recovery.measured, strictQualified: recovery.strictQualified, firstCorrect: recovery.firstCorrect, selectedCorrect: recovery.selectedCorrect, latestRevisionCorrect: recovery.latestRevisionCorrect, firstLineageEventuallyDelivered: recovery.firstLineageEventuallyDelivered } : null,
  blindArm: blindArm ? { protocol: blindArm.protocol, planned: blindArm.planned, generated: blindArm.generated, executed: blindArm.executed, blindEqualsIntended: blindArm.blindEqualsIntended, defective: blindArm.defective, clean: blindArm.clean } : null,
  attempts, scope: manifest.corpus.scope,
  interpretation: `Qualification retains the predeclared exact probe contract. Correct immutable-source verdicts, model probes that expose a defect, provider failures, output-contract failures and diagnostic classifications remain distinct observations. No general model ranking or population accuracy estimate is inferred from ${verification.planned} predeclared attempts.${generated ? " The corpus is a bounded generated fixture family, not customer workloads." : ""}` };
const summary = { ...body, digest: qualificationDigest(body) };
await writeFile(join(root, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ root, planned: summary.planned, attempted: summary.attempted, qualified: summary.qualified, authenticatedReplays: summary.authenticatedReplays, distinctExecutedObservationArtifacts: summary.distinctExecutedObservationArtifacts, modelInvocations: summary.modelInvocations, failedModelInvocations: summary.failedModelInvocations,
  priorOverrideRateByProbe: summary.priorOverride.priorOverrideRateByProbe, failureCategoryCounts, recovery: summary.recovery ? { firstCorrect: summary.recovery.firstCorrect, selectedCorrect: summary.recovery.selectedCorrect, latestRevisionCorrect: summary.recovery.latestRevisionCorrect } : null }));
