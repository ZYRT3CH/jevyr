import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateQualificationConfig, qualificationDigest, qualificationHash, compareQualificationObservation, classifyProbeObservation, SOURCE_ASSAY_ID, PROBE_ASSAY_ID } from "./live-model-fixtures.mjs";
import { corpusForConfig } from "./generated-source-fixtures.mjs";

async function bytes(path, limit = 32 * 1024 * 1024) {
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit);
  const value = await readFile(path), after = await lstat(path);
  assert.equal(value.length, before.size); assert.equal(after.ino, before.ino); assert.equal(after.dev, before.dev); assert.equal(after.mtimeMs, before.mtimeMs);
  return value;
}
/** Retained implementation bytes are inspected, never imported or executed. */
export async function assertArchivedQualificationSources(directory, manifest) {
  const retained = [["runnerDigest", "runner-source.ts"], ["fixtureGeneratorDigest", "fixture-generator-source.mjs"], ["verifierDigest", "verifier-source.mjs"]];
  if (manifest.generatedFixtureGeneratorDigest !== undefined) retained.push(["generatedFixtureGeneratorDigest", "generated-fixture-generator-source.mjs"]);
  else assert.notEqual(manifest.config?.corpus?.kind, "generated", "A generated corpus requires its retained generator source identity");
  for (const [field, name] of retained) {
    assert.match(manifest[field], /^sha256:[a-f0-9]{64}$/u);
    assert.equal(qualificationHash(await bytes(join(directory, name))), manifest[field], `Retained ${name} differs from the predeclared source identity`);
  }
}
const json = async path => JSON.parse((await bytes(path)).toString("utf8"));
export const FINITE_CANDIDATE_COVERAGE = "admitted-finite-blueprints/1";
/** Call only after authenticating the ledger and replaying its population/blueprint bindings. */
export function qualificationCandidateCoverage(events, providerId, policy, populations = []) {
  assert.ok(policy === undefined || policy === FINITE_CANDIDATE_COVERAGE, "Unknown candidate coverage rule");
  const proposed = new Set(events.filter(event => event.kind === "candidate.status" && event.actor.kind === "mind" && event.actor.id === providerId).map(event => event.payload.candidateId));
  if (policy === undefined) return { candidates: [...proposed].sort(), conceptualOnly: [], rule: "legacy-all-model-candidate-events/1" };
  const admitted = new Set();
  for (const { digest, value } of populations) {
    const actionType = value.protocol === "jevyr.candidate-population/1" ? "candidate.population.close"
      : value.protocol === "jevyr.revision-population/1" ? "candidate.revision.population.close" : undefined;
    if (!actionType || !events.some(event => event.kind === "action.status" && event.actor.id === "jevyr.bone" && event.actor.kind === "kernel"
      && event.payload.actionType === actionType && event.payload.status === "completed"
      && (actionType === "candidate.population.close" || event.payload.actionId === digest)
      && event.payload.artifactDigests?.includes(digest))) continue;
    assert.equal(qualificationDigest(value), digest, "Population bytes changed");
    assert.ok(Array.isArray(value.candidates));
    for (const candidate of value.candidates) {
      assert.match(candidate.blueprintDigest, /^sha256:[a-f0-9]{64}$/u);
      assert.match(candidate.blueprintArtifactDigest, /^sha256:[a-f0-9]{64}$/u);
      if (proposed.has(candidate.candidateId)) admitted.add(candidate.candidateId);
    }
  }
  return { candidates: [...admitted].sort(), conceptualOnly: [...proposed].filter(id => !admitted.has(id)).sort(), rule: policy };
}
export function assertQualificationManifest(value) {
  const { digest, ...body } = value; assert.equal(qualificationDigest(body), digest);
  assert.equal(value.protocol, "jevyr.live-model-qualification/1");
  assert.ok(value.candidateCoverage === undefined || value.candidateCoverage === FINITE_CANDIDATE_COVERAGE, "Unknown candidate coverage rule");
  const config = validateQualificationConfig(value.config); assert.deepEqual(value.corpus, corpusForConfig(config));
  const { digest: implementationDigest, ...implementation } = value.implementation; assert.equal(qualificationDigest(implementation), implementationDigest);
  const schedule = [];
  for (const provider of config.providers) for (const seed of config.seeds) for (let repeat = 0; repeat < config.repeats; repeat++) for (const fixture of value.corpus.cases) {
    const identity = { providerId: provider.id, seed, repeat, caseKey: fixture.caseKey };
    schedule.push({ ...identity, attemptId: qualificationDigest(identity).slice(7, 31), directory: `attempt-${String(schedule.length + 1).padStart(3, "0")}` });
  }
  assert.deepEqual(value.planned, schedule, "The predeclared attempt denominator changed");
  return value;
}
function output(execution) {
  const capture = execution.stdoutCapture; assert.equal(capture.complete, true);
  const raw = Buffer.from(capture.data, "base64"); assert.equal(raw.toString("base64"), capture.data); assert.equal(raw.length, capture.byteLength); assert.equal(qualificationHash(raw), capture.digest);
  return JSON.parse(raw.toString("utf8"));
}

/** Offline comparison; source and model code are never executed by this verifier. */
export async function verifyQualificationAttempt(directory, attemptId, options = {}) {
  const root = resolve(directory), manifest = assertQualificationManifest(await json(join(root, "manifest.json")));
  await assertArchivedQualificationSources(root, manifest);
  const planned = manifest.planned.find(value => value.attemptId === attemptId); assert.ok(planned);
  const fixture = manifest.corpus.cases.find(value => value.caseKey === planned.caseKey), provider = manifest.config.providers.find(value => value.id === planned.providerId);
  const source = options.development ? "src" : "dist";
  const P = await import(`../packages/protocol/${source}/index.js`);
  const C = await import(`../packages/core/${source}/index.js`);
  const { verifyLocalProof } = await import(`../apps/cli/${source}/local-proof.js`);
  const proof = join(root, planned.directory, "proof"), replay = await verifyLocalProof(proof, options.expectedSignerKeyId);
  assert.equal(replay.valid, true, JSON.stringify(replay.problems));
  const seal = await json(join(proof, "seal-receipt.json")), record = await json(join(proof, "record.json")), events = await json(join(proof, "events.json"));
  assert.equal(qualificationDigest(record), replay.recordDigest); assert.equal(seal.runDigest, replay.runDigest); assert.equal(seal.caseDigest, replay.caseDigest); assert.equal(seal.policyDigest, replay.policyDigest);
  const chain = C.verifyEventChain(events); assert.equal(chain.valid, true); assert.equal(chain.headDigest, replay.eventHeadDigest);
  const validCase = P.validateSealedCase(await json(join(proof, "sealed-case.json"))); assert.equal(validCase.ok, true); const sealed = validCase.value;
  for (const key of ["caseId", "caseDigest", "runDigest", "policyDigest", "genomeDigest", "subjectMaterialCaptureDigest", "intentContractDigest", "submissionDigest", "sealedAt"]) assert.equal(sealed[key], seal[key]);
  assert.equal(sealed.searchEnvelope.digest, seal.searchDigest); assert.equal(sealed.intent.seed, planned.seed); assert.equal(sealed.intent.impulse, manifest.corpus.impulse); assert.deepEqual(sealed.intent.constraints, manifest.corpus.constraints);
  assert.equal(sealed.intent.privacy, "local_only"); assert.equal(sealed.intent.control, "sovereign");
  assert.equal(P.createSearchEnvelope(manifest.search).digest, sealed.searchEnvelope.digest);
  const policy = await json(join(proof, "policy-descriptor.json")); assert.equal(qualificationDigest(policy.artifact.descriptor), seal.policyDigest);
  const byAssayId = (left, right) => left.assayId.localeCompare(right.assayId);
  assert.deepEqual([...policy.artifact.descriptor.policy.assayFrontier.assays].sort(byAssayId), [...manifest.plans].sort(byAssayId), "The executed assay frontier differs from the predeclared immutable truth and comparative probes");
  const minds = policy.artifact.descriptor.policy.mindCapabilities; assert.equal(minds.length, 1); const capability = minds[0];
  assert.equal(capability.id, provider.id); assert.equal(capability.limits.modelId, provider.model); assert.equal(capability.limits.modelFamily, provider.modelFamily);
  assert.equal(capability.limits.adapterClass, "model"); assert.equal(capability.limits.providerId, new URL(provider.baseUrl).origin); assert.equal(capability.limits.investigationTransport, provider.investigationTransport);
  assert.equal(capability.limits.qualificationManifestDigest, manifest.digest); assert.equal(capability.limits.providerReportedModelDigest, provider.modelDigest); assert.equal(capability.limits.investigationImplementationDigest, manifest.implementation.digest);
  const snapshot = options.providerSnapshot; assert.ok(snapshot); const { digest: snapshotDigest, ...snapshotBody } = snapshot;
  assert.equal(qualificationDigest(snapshotBody), snapshotDigest); assert.deepEqual(snapshot.provider, provider); assert.equal(snapshot.modelDigest, provider.modelDigest); assert.equal(capability.limits.providerSnapshotDigest, snapshotDigest);
  const materials = join(proof, "subject-materials"), capture = await json(join(materials, "capture.json"));
  assert.equal(capture.captureDigest, seal.subjectMaterialCaptureDigest); assert.equal(capture.captureDigest, qualificationDigest({ protocol: capture.protocol, bindings: capture.bindings }));
  assert.deepEqual(capture.bindings.map(value => value.subjectId), ["fixture-source"]);
  const binding = capture.bindings[0]; assert.match(binding.manifestDigest, /^sha256:[a-f0-9]{64}$/u);
  const manifestBytes = await bytes(join(materials, "manifests", binding.manifestDigest.slice(7))); assert.equal(qualificationHash(manifestBytes), binding.manifestDigest);
  const captured = JSON.parse(manifestBytes.toString("utf8")); assert.equal(captured.availability, "MATERIALIZED"); assert.equal(captured.subjectId, binding.subjectId); assert.equal(captured.subjectDigest, binding.subjectDigest);
  assert.deepEqual(captured.entries.map(value => value.path).sort(), fixture.files.map(value => value.path).sort());
  let total = 0;
  for (const entry of captured.entries) {
    assert.match(entry.blobDigest, /^sha256:[a-f0-9]{64}$/u);
    const raw = await bytes(join(materials, "blobs", entry.blobDigest.slice(7))); assert.equal(qualificationHash(raw), entry.blobDigest); assert.equal(raw.length, entry.byteLength);
    assert.equal(raw.toString("utf8"), fixture.files.find(value => value.path === entry.path).content); total += raw.length;
  }
  assert.equal(total, captured.byteLength); assert.equal(total, binding.byteLength);
  const materializationDigest = qualificationDigest({ protocol: "jevyr.subject-materialization/1", subjects: [{ subjectId: "fixture-source", availability: "MATERIALIZED", relativeRoot: "subject-0000", manifestDigest: binding.manifestDigest, files: captured.entries.length, byteLength: total }] });
  const index = await json(join(proof, "artifact-index.json")); assert.equal(qualificationDigest(index), replay.artifactIndexDigest);
  const models = new Set(events.filter(event => event.kind === "candidate.status" && event.actor.kind === "mind" && event.actor.id === provider.id).map(event => event.payload.candidateId));
  const sourceRows = [], probeRows = [], inspections = [], populations = [];
  for (const meta of index.artifacts) {
    if (!["application/vnd.jevyr.tool-observation+json", "application/vnd.jevyr.model-investigation+json", "application/vnd.jevyr.candidate-population+json", "application/vnd.jevyr.revision-population+json"].includes(meta.mediaType)) continue;
    const raw = await bytes(join(proof, "artifacts", `${meta.id}.blob`)); assert.equal(raw.length, meta.size); assert.equal(qualificationHash(raw), meta.digest); const value = JSON.parse(raw.toString("utf8"));
    if (["application/vnd.jevyr.candidate-population+json", "application/vnd.jevyr.revision-population+json"].includes(meta.mediaType)) {
      populations.push({ digest: meta.digest, value }); continue;
    }
    if (meta.mediaType === "application/vnd.jevyr.model-investigation+json") {
      assert.equal(value.runDigest, seal.runDigest); assert.equal(value.adapterId, provider.id);
      for (const tool of value.tools) if (tool.status === "observed" && ["read_subject_lines", "search_subject"].includes(tool.name) && tool.sourceDigests.includes(fixture.sourceDigest)) inspections.push({ artifactDigest: meta.digest, tool });
      continue;
    }
    const assayId = value.metadata?.assayId;
    if (![SOURCE_ASSAY_ID, PROBE_ASSAY_ID].includes(assayId)) continue;
    const execution = value.oracle?.execution, boundary = value.oracle?.subjectBoundary;
    const row = { artifactDigest: meta.digest, candidateId: value.metadata.candidateId, executed: execution?.mode === "docker" && execution.state === "exited", exitCode: execution?.exitCode ?? null, classification: null, matched: false, reason: null };
    // Diagnostic classification is recorded before the strict comparison so a later strict failure cannot erase it.
    if (row.executed && assayId === PROBE_ASSAY_ID) { try { row.classification = classifyProbeObservation(output(execution), fixture); } catch { row.classification = "MALFORMED"; } }
    try {
      assert.ok(row.executed); assert.equal(value.metadata.planBoundAtSeal, true); assert.equal(value.metadata.executionAuthorityStatus, "VERIFIED"); assert.equal(value.metadata.aggregateAdmissible, true); assert.equal(execution.shell, false);
      assert.equal(boundary.captureDigest, seal.subjectMaterialCaptureDigest); assert.equal(boundary.materializationDigest, materializationDigest); assert.equal(boundary.sealedSubjectReadOnly, true); assert.equal(boundary.originalSubjectAccessible, false); assert.equal(boundary.beforeDigest, boundary.afterDigest);
      assert.equal(execution.command, "node"); assert.deepEqual(execution.args, [assayId === SOURCE_ASSAY_ID ? "/subject/subject-0000/truth-oracle.mjs" : "jevyr.experiment.mjs"]);
      assert.equal(execution.exitCode, assayId === SOURCE_ASSAY_ID ? fixture.expectedExitCode : 0);
      assert.ok(compareQualificationObservation(output(execution), fixture));
      if (assayId === PROBE_ASSAY_ID) assert.ok(models.has(row.candidateId), "Executed probe lacks its authenticated model-origin candidate");
      row.matched = true;
    } catch (error) { row.reason = error.message; }
    (assayId === SOURCE_ASSAY_ID ? sourceRows : probeRows).push(row);
  }
  const candidateCoverage = qualificationCandidateCoverage(events, provider.id, manifest.candidateCoverage, populations);
  const candidates = candidateCoverage.candidates;
  const checks = { fullReplay: true, correctJudgment: record.verdict.integrity === "VALID" && record.verdict.judgment === fixture.expectedJudgment,
    immutableTruthObserved: sourceRows.length > 0 && sourceRows.every(row => row.matched), actualModelCandidate: candidates.length > 0,
    actualSourceInspection: inspections.length > 0, everyModelCandidateAssayed: candidates.length > 0 && candidates.every(id => probeRows.some(row => row.candidateId === id && row.executed)),
    everyExecutedProbeMatches: probeRows.length > 0 && probeRows.every(row => row.matched) };
  return { protocol: "jevyr.live-model-attempt-verification/1", attemptId, caseId: seal.caseId, recordDigest: replay.recordDigest, qualified: Object.values(checks).every(Boolean), checks,
    sourceRows, probeRows, inspections, candidateCoverage, configuredProvider: provider, scope: "Finite source/probe behavior and authenticated runtime provenance; provider metadata and local invocation diagnostics are not remote model attestations." };
}

export async function verifyLiveModelQualification(directory, options = {}) {
  const root = resolve(directory), manifest = assertQualificationManifest(await json(join(root, "manifest.json"))), report = await json(join(root, "report.json"));
  await assertArchivedQualificationSources(root, manifest);
  assert.equal(report.manifestDigest, manifest.digest); assert.equal(report.planned, manifest.planned.length);
  const attempts = [];
  for (const planned of manifest.planned) {
    try {
      const result = await json(join(root, planned.directory, "result.json")); assert.equal(result.attemptId, planned.attemptId); assert.equal(result.manifestDigest, manifest.digest);
      assert.deepEqual(report.attempts.find(value => value.attemptId === planned.attemptId), result);
      const invocation = await json(join(root, planned.directory, "invocations.json")); assert.equal(invocation.attemptId, planned.attemptId);
      const failedProviderCalls = invocation.invocations.filter(value => value.status !== "RETURNED").length;
      const verification = await verifyQualificationAttempt(root, planned.attemptId, { ...options, expectedSignerKeyId: result.signerKeyId, providerSnapshot: result.providerSnapshot });
      assert.equal(result.providerSnapshot.digest, result.providerSnapshotAfter.digest);
      const { digest: afterDigest, ...afterBody } = result.providerSnapshotAfter; assert.equal(qualificationDigest(afterBody), afterDigest);
      attempts.push({ ...verification, failedProviderCalls, qualified: verification.qualified && failedProviderCalls === 0 && !result.error && !result.closeError });
    } catch (error) { attempts.push({ attemptId: planned.attemptId, qualified: false, error: error.message }); }
  }
  assert.equal(report.attempted, report.attempts.length); assert.ok(report.attempts.length <= manifest.planned.length);
  return { protocol: "jevyr.live-model-qualification-verification/1", manifestDigest: manifest.digest, planned: manifest.planned.length, attempted: report.attempted,
    qualified: attempts.filter(value => value.qualified).length, valid: attempts.every(value => value.qualified), attempts,
    scope: manifest.corpus.scope, denominator: manifest.denominator };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await verifyLiveModelQualification(process.argv[2], { development: process.argv.includes("--development") });
  await writeFile(join(resolve(process.argv[2]), "independent-verification.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" }); console.log(JSON.stringify(result));
  if (!result.valid) process.exitCode = 1;
}
