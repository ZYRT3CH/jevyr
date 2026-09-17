import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  TemporalDeep,
  stageMemory,
  type MemoryCandidate,
  type MemoryEvidenceObservation,
} from "@jevyr/memory";
import {
  digestJson,
  sha256Digest,
  type DsseEnvelope,
  type JevyrVerdict,
  type JsonValue,
  type MemoryInfluencePayload,
  type SealedCase,
  type SignedRecord,
} from "@jevyr/protocol";
import {
  bindVerifiedCommittedMemoryCase,
  compareCommittedMemoryCases,
  encodeMemoryReconciliationEvidence,
  projectMemoryCandidate,
  reconciliationObservations,
} from "../src/memory-reconciliation.js";

const projectId = "project-temporal-reconciliation";
const intentDigest = sha256Digest("shared-intent-contract");
const materialDigest = sha256Digest("shared-subject-material");
const searchProfileDigest = sha256Digest("seed-independent-search-envelope-profile");
const lineageStore = new TemporalDeep();

after(() => lineageStore.close());

function caseFixture(
  label: string,
  stagedAt: string,
  options: {
    readonly intentDigest?: string;
    readonly materialDigest?: string;
    readonly mechanism?: string;
    readonly judgment?: JevyrVerdict["judgment"];
    readonly feasibility?: JevyrVerdict["feasibilityByCandidate"];
    readonly selectedCandidateId?: string;
    readonly basisCodes?: readonly string[];
    readonly influences?: readonly string[];
    readonly projectId?: string;
    readonly caseDigest?: string;
  } = {},
) {
  const mechanism = options.mechanism ?? "shared-mechanism";
  const policyInput = {
    protocol: "jevyr.effective-policy/1",
    assayFrontierDigest: sha256Digest(`assay:${mechanism}`),
  };
  const policyDescriptor = {
    protocol: "jevyr.policy-descriptor/1",
    version: "jevyr.bone/1",
    policy: policyInput,
  } as unknown as JsonValue;
  const policyDigest = digestJson(policyDescriptor);
  const caseDigest = options.caseDigest ?? sha256Digest(`case:${label}`);
  const runDigest = sha256Digest(`run:${label}`);
  const resolvedIntentDigest = options.intentDigest ?? intentDigest;
  const resolvedMaterialDigest = options.materialDigest ?? materialDigest;
  const sealed = {
    protocol: "jevyr.sealed-case/1",
    caseId: `case_${label.padEnd(8, "x")}`,
    submissionDigest: sha256Digest(`submission:${label}`),
    subjectMaterialCaptureDigest: resolvedMaterialDigest,
    caseDigest,
    runDigest,
    sealedAt: stagedAt,
    policyVersion: "jevyr.bone/1",
    policyDigest,
    genomeVersion: "jevyr.genome/1",
    genomeDigest: sha256Digest(`genome:${mechanism}`),
    searchEnvelope: { digest: searchProfileDigest },
    intentContractDigest: resolvedIntentDigest,
    intentContract: {},
    intent: {},
    subjects: [],
  } as unknown as SealedCase;
  const feasibility = options.feasibility ?? {
    [`candidate-${label}-a`]: "BRIDGEABLE",
    [`candidate-${label}-b`]: "BUILDABLE_NOW",
  };
  const selectedCandidateId = options.selectedCandidateId
    ?? Object.keys(feasibility).find((id) => feasibility[id] === "BUILDABLE_NOW");
  const verdict: JevyrVerdict = {
    policyVersion: "jevyr.bone/1",
    intentContractDigest: resolvedIntentDigest,
    evidenceDigest: sha256Digest(`evidence:${label}`),
    integrity: "VALID",
    creation: "CONCEIVED",
    embodiment: "BUILT",
    judgment: options.judgment ?? "ACCEPT",
    ...(selectedCandidateId === undefined ? {} : { selectedCandidateId }),
    feasibilityByCandidate: feasibility,
    basis: (options.basisCodes ?? ["SEALED_OBLIGATIONS_SATISFIED"]).map((code) => ({
      code,
      summary: `Case-local summary for ${code}`,
      evidenceIds: [`evidence-${label}`],
    })),
  };
  const influences: readonly MemoryInfluencePayload[] = (options.influences ?? []).map(
    (memoryDigest): MemoryInfluencePayload => ({
      memoryDigest,
      influence: "seeded_hypothesis",
      summary: "Case-local admitted memory influence.",
      weight: 0.1,
    }),
  );
  const record: SignedRecord = {
    protocol: "jevyr.record/1",
    caseDigest,
    runDigest,
    policyDigest,
    genomeDigest: sealed.genomeDigest,
    searchDigest: searchProfileDigest,
    intentContractDigest: resolvedIntentDigest,
    eventHeadDigest: sha256Digest(`event-head:${label}`),
    verdict,
    reflex: {
      loop: 1,
      reviewedEvidenceDigest: verdict.evidenceDigest,
      intentContractDigest: resolvedIntentDigest,
      challengedNodeIds: [],
      materialFindings: [],
      decision: "confirm",
    },
    memoryInfluences: influences,
    crystallizedAt: new Date(Date.parse(stagedAt) + 1_000).toISOString(),
  };
  const envelope: DsseEnvelope = {
    payloadType: "application/vnd.jevyr.record+json",
    payload: Buffer.from(JSON.stringify(record)).toString("base64"),
    signatures: [{ keyid: sha256Digest("key"), sig: Buffer.from(label).toString("base64") }],
  };
  const candidate = projectMemoryCandidate({
    projectId: options.projectId ?? projectId,
    sealed,
    verdict,
    memoryInfluences: influences,
    policyDescriptor,
  });
  const memory = stageMemory(candidate);
  const committed = bindVerifiedCommittedMemoryCase({
    memory,
    stagedAt,
    sealed,
    record,
    recordEnvelope: envelope,
    policyDescriptor,
    projectId: options.projectId ?? projectId,
  });
  return { committed, sealed, record, envelope, policyDescriptor, candidate };
}

type Committed = ReturnType<typeof caseFixture>["committed"];

function lineagesFor(target: Committed, source: Committed) {
  return {
    targetAncestry: lineageStore.verifiedMemoryLineage(
      target.projectId,
      target.memory.candidate.sourceMemoryDigests,
    ),
    sourceInfluences: lineageStore.verifiedMemoryLineage(
      source.projectId,
      source.memory.candidate.sourceMemoryDigests,
    ),
  };
}

function compareCases(target: Committed, source: Committed) {
  return compareCommittedMemoryCases(target, source, lineagesFor(target, source));
}

function admitCandidate(
  candidate: MemoryCandidate,
  stagedAt: string,
  label: string,
) {
  const memory = lineageStore.stage(candidate, stagedAt);
  const observedAt = new Date(Date.parse(stagedAt) + 60_000).toISOString();
  const observation = (
    suffix: string,
    kind: "REPRODUCTION" | "CONTAMINATION",
    passed?: boolean,
  ): MemoryEvidenceObservation => ({
    protocol: "jevyr.memory-evidence-observation/1",
    observationId: `lineage:${label}:${suffix}`,
    kind,
    sourceCaseDigest: sha256Digest(`lineage-case:${label}:${suffix}`),
    sourceRunDigest: sha256Digest(`lineage-run:${label}:${suffix}`),
    evidenceDigest: sha256Digest(`lineage-evidence:${label}:${suffix}`),
    observedAt,
    ...(kind === "CONTAMINATION" ? { passed: passed as boolean } : {}),
  }) as MemoryEvidenceObservation;
  const admitted = lineageStore.reconcileEvidenceBatch(memory.digest, [
    observation("reproduction-a", "REPRODUCTION"),
    observation("reproduction-b", "REPRODUCTION"),
    observation("contamination", "CONTAMINATION", true),
  ], observedAt);
  assert.equal(admitted.decision.decision, "ADMIT");
  return memory;
}

function lineageCandidate(
  label: string,
  sourceMemoryDigests: readonly string[] = [],
  candidateProjectId = projectId,
): MemoryCandidate {
  return {
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: "descriptor",
    abstractSummary: `Verified lineage fixture ${label}.`,
    content: { descriptor: label },
    sourceMemoryDigests,
    evidenceDigests: [sha256Digest(`lineage-origin:${label}`)],
    projectId: candidateProjectId,
    caseDigest: sha256Digest(`lineage-origin-case:${label}`),
  };
}

test("distinct run seeds can reproduce an exact signed task/mechanism/outcome", () => {
  const target = caseFixture("target", "2026-09-04T10:00:00.000Z");
  const source = caseFixture("source", "2026-09-05T10:00:00.000Z", {
    caseDigest: target.record.caseDigest,
  });
  assert.equal(target.record.caseDigest, source.record.caseDigest);
  assert.notEqual(target.record.runDigest, source.record.runDigest);
  assert.equal(target.record.searchDigest, source.record.searchDigest);
  assert.notDeepEqual(
    Object.keys(target.record.verdict.feasibilityByCandidate),
    Object.keys(source.record.verdict.feasibilityByCandidate),
  );
  const comparison = compareCases(target.committed, source.committed);
  assert.equal(comparison.classification, "REPRODUCTION");
  assert.equal(comparison.taskExact, true);
  assert.equal(comparison.mechanismExact, true);
  assert.equal(comparison.outcomeExact, true);

  const outcome = encodeMemoryReconciliationEvidence(comparison, "OUTCOME");
  const contamination = encodeMemoryReconciliationEvidence(comparison, "CONTAMINATION");
  assert.notEqual(outcome.digest, contamination.digest);
  const first = reconciliationObservations(
    comparison,
    outcome.digest,
    contamination.digest,
    source.record.crystallizedAt,
  );
  const retry = reconciliationObservations(
    comparison,
    outcome.digest,
    contamination.digest,
    source.record.crystallizedAt,
  );
  assert.deepEqual(retry, first);
  assert.deepEqual(first.map((entry) => entry.kind), ["REPRODUCTION", "CONTAMINATION"]);
  assert.ok(first.every((entry) => entry.sourceRunDigest === source.record.runDigest));
});

test("same task and mechanism with a different exact outcome is a counterexample", () => {
  const target = caseFixture("counter-target", "2026-09-04T10:00:00.000Z");
  const source = caseFixture("counter-source", "2026-09-05T10:00:00.000Z", {
    caseDigest: target.record.caseDigest,
    judgment: "REJECT",
    basisCodes: ["CRITICAL_ASSAY_FAILED"],
  });
  const comparison = compareCases(target.committed, source.committed);
  assert.equal(comparison.classification, "COUNTEREXAMPLE");
  assert.equal(comparison.outcomeExact, false);
});

test("task changes and mechanism changes remain diagnostics without Tribunal edges", () => {
  const target = caseFixture("incomparable-target", "2026-09-04T10:00:00.000Z");
  const changedTask = caseFixture("changed-task", "2026-09-05T10:00:00.000Z", {
    materialDigest: sha256Digest("different-material"),
  });
  const taskComparison = compareCases(target.committed, changedTask.committed);
  assert.equal(taskComparison.classification, "INCOMPARABLE_TASK");
  assert.throws(
    () => encodeMemoryReconciliationEvidence(taskComparison, "OUTCOME"),
    /Excluded comparison/,
  );
  assert.doesNotThrow(() => encodeMemoryReconciliationEvidence(taskComparison, "EXCLUSION"));

  const changedMechanism = caseFixture("changed-mechanism", "2026-09-05T10:00:00.000Z", {
    caseDigest: target.record.caseDigest,
    mechanism: "different-mechanism",
    judgment: "REJECT",
    basisCodes: ["CRITICAL_ASSAY_FAILED"],
  });
  const mechanismComparison = compareCases(target.committed, changedMechanism.committed);
  assert.equal(mechanismComparison.classification, "INCOMPARABLE_MECHANISM");
  assert.equal(mechanismComparison.outcomeExact, false);
  assert.throws(
    () => reconciliationObservations(
      mechanismComparison,
      sha256Digest("outcome"),
      sha256Digest("contamination"),
      changedMechanism.record.crystallizedAt,
    ),
    /Excluded comparison/,
  );
});

test("shared lineage, non-later chronology, same identity, and project mismatch are excluded", () => {
  const target = caseFixture("boundary-target", "2026-09-04T10:00:00.000Z");
  admitCandidate(target.candidate, target.committed.stagedAt, "boundary-target");
  const descendant = admitCandidate(
    lineageCandidate("boundary-descendant", [target.committed.memory.digest]),
    "2026-09-04T11:00:00.000Z",
    "boundary-descendant",
  );
  const contaminated = caseFixture("contaminated", "2026-09-05T10:00:00.000Z", {
    caseDigest: target.record.caseDigest,
    influences: [descendant.digest],
  });
  const contaminatedComparison = compareCases(target.committed, contaminated.committed);
  assert.equal(contaminatedComparison.classification, "CONTAMINATED_EXCLUDED");
  assert.deepEqual(contaminatedComparison.sharedMemoryInfluenceDigests, [target.committed.memory.digest]);

  const unrelated = admitCandidate(
    lineageCandidate("unrelated-lineage"),
    "2026-09-04T12:00:00.000Z",
    "unrelated-lineage",
  );
  const clean = caseFixture("clean-influenced", "2026-09-05T12:00:00.000Z", {
    caseDigest: target.record.caseDigest,
    influences: [unrelated.digest],
  });
  assert.equal(compareCases(target.committed, clean.committed).classification, "REPRODUCTION");

  const notLater = caseFixture("not-later", "2026-09-03T10:00:00.000Z");
  assert.equal(
    compareCases(target.committed, notLater.committed).classification,
    "NON_LATER_EXCLUDED",
  );
  assert.equal(
    compareCases(target.committed, target.committed).classification,
    "SAME_ORIGIN_EXCLUDED",
  );
  const anotherProject = caseFixture("another-project", "2026-09-05T10:00:00.000Z", {
    projectId: "different-project",
  });
  assert.equal(
    compareCases(target.committed, anotherProject.committed).classification,
    "PROJECT_MISMATCH_EXCLUDED",
  );
});

test("comparison rejects a structurally copied lineage that did not pass Temporal Deep", () => {
  const target = caseFixture("forged-lineage-target", "2026-09-04T10:00:00.000Z");
  const source = caseFixture("forged-lineage-source", "2026-09-05T10:00:00.000Z", {
    caseDigest: target.record.caseDigest,
  });
  const verified = lineagesFor(target.committed, source.committed);
  assert.throws(() => compareCommittedMemoryCases(target.committed, source.committed, {
    targetAncestry: structuredClone(verified.targetAncestry),
    sourceInfluences: verified.sourceInfluences,
  }), /exact closure issued by Temporal Deep/);
});

test("record projection binding rejects a mutated committed candidate", () => {
  const fixture = caseFixture("mutated", "2026-09-04T10:00:00.000Z");
  const mutated: MemoryCandidate = {
    ...fixture.candidate,
    evidenceDigests: [sha256Digest("fabricated-evidence")],
  };
  assert.throws(() => bindVerifiedCommittedMemoryCase({
    memory: stageMemory(mutated),
    stagedAt: fixture.committed.stagedAt,
    sealed: fixture.sealed,
    record: fixture.record,
    recordEnvelope: fixture.envelope,
    policyDescriptor: fixture.policyDescriptor,
    projectId,
  }), /deterministic signed Record projection/);
});
