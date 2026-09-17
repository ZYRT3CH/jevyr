import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { qualificationDigest, qualificationHash, PROBE_ASSAY_ID } from "./live-model-fixtures.mjs";
import { assertQualificationManifest, verifyLiveModelQualification } from "./verify-live-model-qualification.mjs";

const POLICY = Object.freeze({ protocol: "jevyr.probe-recovery-measurement/1", authority: "diagnostic-only",
  first: "first-admitted-original-blueprint-by-proposal-sequence-then-first-physical-attempt",
  selected: "signed-Record-selected-candidate-then-last-physical-attempt",
  revised: "last-admitted-revision-by-closure-sequence-then-last-physical-attempt",
  correctness: "unchanged-exact-original-source-comparison-after-full-signed-replay",
  retention: "all-admitted-candidates-all-physical-attempts-all-parent-failures",
  strictQualification: "unchanged-no-failure-erasure", maximumBaselineRounds: 2,
  denominator: "all-predeclared-attempts-including-unmeasured-failed-or-missing-probes" });
export const RECOVERY_ANALYZER_ARCHIVE = "recovery-analyzer-source.mjs";
async function bytes(path, limit = 32 * 1024 * 1024) {
  const before = await lstat(path); assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= limit);
  const value = await readFile(path), after = await lstat(path);
  assert.equal(value.byteLength, before.size); assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.mtimeMs, before.mtimeMs);
  return value;
}
const json = async path => JSON.parse((await bytes(path)).toString("utf8"));
export function recoveryMeasurementDeclaration(analyzerBytes) {
  assert.ok(analyzerBytes instanceof Uint8Array && analyzerBytes.byteLength > 0 && analyzerBytes.byteLength <= 1_048_576);
  const body = { ...POLICY, analyzerDigest: qualificationHash(analyzerBytes) };
  return Object.freeze({ ...body, digest: qualificationDigest(body) });
}
export function assertRecoveryMeasurementDeclaration(value, analyzerBytes) {
  assert.ok(value, "Recovery measurement was not declared before dispatch; historical cohorts cannot be rescored");
  assert.deepEqual(value, recoveryMeasurementDeclaration(analyzerBytes), "Recovery declaration differs from the exact loaded analyzer and fixed selection rules");
  return value;
}

/** Pure chronology/consistency summary only. The public verifier below supplies
 * its inputs exclusively after signed proof and exact source-output replay. */
export function summarizeProbeRecoveryChronology({ originalCandidates, revisions, physicalRows, selectedCandidateId, strictQualified, failedProviderCalls }) {
  assert.ok(Array.isArray(originalCandidates) && originalCandidates.length <= 4096);
  assert.ok(Array.isArray(revisions) && revisions.length <= POLICY.maximumBaselineRounds);
  assert.ok(Array.isArray(physicalRows) && physicalRows.length <= 10_000);
  const initial = [...originalCandidates].sort((a, b) => a.proposalSequence - b.proposalSequence || a.candidateId.localeCompare(b.candidateId));
  const revised = [...revisions].sort((a, b) => a.closureSequence - b.closureSequence);
  const candidates = [...initial.map(value => value.candidateId), ...revised.map(value => value.candidateId)];
  assert.equal(new Set(candidates).size, candidates.length, "A revision cannot replace an existing candidate");
  const parents = new Map();
  const priorCandidates = new Set(initial.map(value => value.candidateId));
  for (const revision of revised) {
    assert.ok(priorCandidates.has(revision.parentCandidateId), "Revision parent must precede its child");
    assert.ok(!parents.has(revision.candidateId)); parents.set(revision.candidateId, revision.parentCandidateId);
    priorCandidates.add(revision.candidateId);
  }
  for (const row of physicalRows) {
    assert.ok(candidates.includes(row.candidateId), "Physical probe lacks a committed candidate");
    assert.ok(Number.isSafeInteger(row.startedSequence) && row.startedSequence > 0);
  }
  assert.equal(new Set(physicalRows.map(row => row.invocationId)).size, physicalRows.length, "Physical attempts must be deduplicated by invocation identity");
  // Select identities and chronological positions without consulting matched.
  const pick = (candidateId, first = false) => {
    if (!candidateId) return { status: "NOT_SELECTED", candidateId: null, invocationId: null, correct: false };
    const rows = physicalRows.filter(row => row.candidateId === candidateId).sort((a, b) => a.startedSequence - b.startedSequence);
    const row = first ? rows[0] : rows.at(-1);
    return row ? { status: row.executed ? "EXECUTED" : "NOT_EXECUTED", candidateId, invocationId: row.invocationId,
      correct: row.executed && row.matched, artifactDigests: row.artifactDigests } : { status: "NOT_EXECUTED", candidateId, invocationId: null, correct: false };
  };
  const firstCandidateId = initial[0]?.candidateId, latestCandidateId = revised.at(-1)?.candidateId;
  const first = pick(firstCandidateId, true), selected = pick(selectedCandidateId), latestRevision = pick(latestCandidateId);
  let cursor = latestCandidateId, descends = false;
  const visited = new Set();
  while (cursor && parents.has(cursor)) {
    assert.ok(!visited.has(cursor), "Revision ancestry must be acyclic"); visited.add(cursor); cursor = parents.get(cursor);
    if (cursor === firstCandidateId) descends = true;
  }
  return { strictQualified, failedProviderCalls, first, selected, latestRevision,
    latestRevisionDescendsFromFirst: descends,
    firstLineageEventuallyDelivered: first.status === "EXECUTED" && !first.correct && descends && latestRevision.correct,
    allCandidates: candidates.map(candidateId => ({ candidateId, parentCandidateId: parents.get(candidateId) ?? null,
      attempts: physicalRows.filter(row => row.candidateId === candidateId).sort((a, b) => a.startedSequence - b.startedSequence) })),
    failedPhysicalAttempts: physicalRows.filter(row => !row.executed || !row.matched).length,
    unexecutedCandidates: candidates.filter(candidateId => !physicalRows.some(row => row.candidateId === candidateId && row.executed)),
    interpretation: "Chronological delivery diagnostics only. A later correct child does not erase a failed parent, provider failure, or strict qualification failure." };
}

/** Record-prefix binding closes the read-after-replay seam without trusting a
 * caller-supplied 'verified' bit or importing archived analyzer code. */
export function assertRecoveryTraceBinding(checked, record, events, verifyEventChain) {
  assert.equal(qualificationDigest(record), checked.recordDigest, "Recovery Record differs from the authenticated qualification Record");
  const position = events.findIndex(event => event.eventDigest === record.eventHeadDigest);
  assert.ok(position >= 0, "Recovery transcript omits its signed Record prefix");
  const prefix = events.slice(0, position + 1), chain = verifyEventChain(prefix);
  assert.equal(chain.valid, true); assert.equal(chain.headDigest, record.eventHeadDigest);
  assert.ok(prefix.every(event => event.caseDigest === record.caseDigest && event.runDigest === record.runDigest));
  return prefix;
}

export async function verifyProbeRecovery(directory, options = {}) {
  const root = resolve(directory), manifest = assertQualificationManifest(await json(join(root, "manifest.json")));
  const loaded = await bytes(new URL(import.meta.url), 1_048_576);
  assertRecoveryMeasurementDeclaration(manifest.recoveryMeasurement, loaded);
  assert.equal(qualificationHash(await bytes(join(root, RECOVERY_ANALYZER_ARCHIVE), 1_048_576)), manifest.recoveryMeasurement.analyzerDigest);
  // All old strict checks, exact source comparisons and signed budget replay
  // happen first. This diagnostic never supplies substitute correctness values.
  const strict = await verifyLiveModelQualification(root, options);
  const C = await import(`../packages/core/${options.development ? "src" : "dist"}/index.js`);
  const attempts = [];
  for (const planned of manifest.planned) {
    const checked = strict.attempts.find(value => value.attemptId === planned.attemptId);
    if (!checked?.checks?.fullReplay) {
      attempts.push({ attemptId: planned.attemptId, measured: false, strictQualified: checked?.qualified === true, reason: checked?.error ?? "Full signed replay unavailable" }); continue;
    }
    try {
      const proof = join(root, planned.directory, "proof"), record = await json(join(proof, "record.json"));
      const events = assertRecoveryTraceBinding(checked, record, await json(join(proof, "events.json")), C.verifyEventChain);
      const policy = (await json(join(proof, "policy-descriptor.json"))).artifact.descriptor;
      assert.equal(qualificationDigest(policy), record.policyDigest);
      assert.equal(policy.policy.executionRevisions.maximumBaselineRounds, 2);
      const index = await json(join(proof, "artifact-index.json"));
      const artifact = async digest => {
        const metadata = index.artifacts.find(value => value.digest === digest); assert.ok(metadata); assert.match(metadata.id, /^artifact_[a-f0-9]{24}$/u);
        const raw = await bytes(join(proof, "artifacts", `${metadata.id}.blob`)); assert.equal(raw.length, metadata.size); assert.equal(qualificationHash(raw), digest);
        return JSON.parse(raw.toString("utf8"));
      };
      const admitted = new Set(checked.candidateCoverage.candidates), revisions = [];
      for (const event of events.filter(event => event.kind === "action.status" && event.actor.kind === "kernel" && event.actor.id === "jevyr.bone"
        && event.payload.actionType === "candidate.revision.population.close" && event.payload.status === "completed")) {
        assert.equal(event.payload.artifactDigests.length, 1); const revision = await artifact(event.payload.artifactDigests[0]);
        assert.equal(revision.protocol, "jevyr.revision-population/1"); assert.equal(revision.receiptDigest, undefined, "This sovereign diagnostic cannot admit additive work");
        assert.equal(revision.candidates.length, 1); assert.equal(revision.parentCandidateIds.length, 1);
        const candidateId = revision.candidates[0].candidateId; assert.ok(admitted.has(candidateId));
        revisions.push({ candidateId, parentCandidateId: revision.parentCandidateIds[0], closureSequence: event.sequence, round: revision.round });
      }
      assert.ok(revisions.length <= 2 && revisions.every(value => [1, 2].includes(value.round)));
      const children = new Set(revisions.map(value => value.candidateId));
      const originalCandidates = [...admitted].filter(id => !children.has(id)).map(candidateId => {
        const proposal = events.find(event => event.kind === "candidate.status" && event.actor.kind === "mind" && event.actor.id === planned.providerId
          && event.payload.status === "proposed" && event.payload.candidateId === candidateId);
        assert.ok(proposal); return { candidateId, proposalSequence: proposal.sequence };
      });
      const physical = new Map();
      for (const row of checked.probeRows) {
        const observation = await artifact(row.artifactDigest), invocationId = observation.invocationId;
        assert.equal(observation.metadata.assayId, PROBE_ASSAY_ID); assert.equal(observation.metadata.candidateId, row.candidateId);
        assert.ok(events.some(event => event.kind === "evidence.observed" && event.payload.contentDigest === row.artifactDigest), "Probe is outside the signed Record prefix");
        const started = events.find(event => event.kind === "action.status" && event.actor.kind === "forge" && event.payload.actionId === invocationId && event.payload.status === "started");
        assert.ok(started, "Physical probe lacks its authenticated start");
        const existing = physical.get(invocationId);
        if (existing) {
          assert.equal(existing.candidateId, row.candidateId); assert.equal(existing.executionDigest, qualificationDigest(observation.oracle?.execution ?? null));
          existing.matched &&= row.matched; existing.executed &&= row.executed; existing.artifactDigests.push(row.artifactDigest); if (row.reason) existing.reasons.push(row.reason);
        } else physical.set(invocationId, { invocationId, candidateId: row.candidateId, startedSequence: started.sequence,
          executionDigest: qualificationDigest(observation.oracle?.execution ?? null), executed: row.executed, matched: row.matched, artifactDigests: [row.artifactDigest], reasons: row.reason ? [row.reason] : [] });
      }
      const measurement = summarizeProbeRecoveryChronology({ originalCandidates, revisions, physicalRows: [...physical.values()],
        selectedCandidateId: record.verdict.selectedCandidateId, strictQualified: checked.qualified, failedProviderCalls: checked.failedProviderCalls });
      attempts.push({ attemptId: planned.attemptId, caseId: checked.caseId, measured: true, recordDigest: checked.recordDigest, ...measurement });
    } catch (error) {
      attempts.push({ attemptId: planned.attemptId, measured: false, strictQualified: checked.qualified, failedProviderCalls: checked.failedProviderCalls,
        strictProbeRows: checked.probeRows, reason: error.message });
    }
  }
  const body = { protocol: "jevyr.probe-recovery-report/1", manifestDigest: manifest.digest, declarationDigest: manifest.recoveryMeasurement.digest,
    planned: manifest.planned.length, measured: attempts.filter(value => value.measured).length, strictQualified: strict.qualified,
    firstCorrect: attempts.filter(value => value.first?.correct).length, selectedCorrect: attempts.filter(value => value.selected?.correct).length,
    latestRevisionCorrect: attempts.filter(value => value.latestRevision?.correct).length,
    firstLineageEventuallyDelivered: attempts.filter(value => value.firstLineageEventuallyDelivered).length, attempts,
    strictVerification: strict,
    scope: "Additional predeclared finite delivery diagnostic, not a replacement qualification gate, quality ranking, or release-readiness claim." };
  return { ...body, digest: qualificationDigest(body) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.ok(process.argv[2] && process.argv.slice(3).every(value => value === "--development"));
  const report = await verifyProbeRecovery(process.argv[2], { development: process.argv.includes("--development") });
  await writeFile(join(resolve(process.argv[2]), "recovery-strict-verification.json"), JSON.stringify(report.strictVerification, null, 2) + "\n", { flag: "wx" });
  await writeFile(join(resolve(process.argv[2]), "recovery-measurement.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ planned: report.planned, measured: report.measured, strictQualified: report.strictQualified,
    firstCorrect: report.firstCorrect, selectedCorrect: report.selectedCorrect, latestRevisionCorrect: report.latestRevisionCorrect }));
  if (report.measured !== report.planned) process.exitCode = 1;
}
