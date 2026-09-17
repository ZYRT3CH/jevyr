import { describe, expect, it } from "vitest";
import { sha256Digest } from "@jevyr/protocol";
import {
  TemporalDeep,
  adjudicateMemory,
  stageMemory,
  type MemoryCandidate,
  type TribunalEvidence,
} from "../src/index.js";

const projectId = "project-jevyr";
const caseDigest = sha256Digest("case");
const evidenceDigest = sha256Digest("origin");
const now = "2026-09-04T14:00:00.000Z";
const laterCaseA = sha256Digest("later-case-a");
const laterCaseB = sha256Digest("later-case-b");
const reviewCase = sha256Digest("review-case");

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    protocol: "jevyr.memory/1",
    scope: "PROJECT",
    kind: "strategy",
    abstractSummary: "Counterexamples should target causal boundaries.",
    content: {
      strategyFingerprint: "boundary-counterexample",
      descriptor: [0.2, 0.8],
    },
    sourceMemoryDigests: [],
    evidenceDigests: [evidenceDigest],
    projectId,
    caseDigest,
    ...overrides,
  };
}

function admit(deep: TemporalDeep, value = candidate()) {
  const memory = deep.stage(value, now);
  deep.appendEvidenceObservation(memory.digest, {
    protocol: "jevyr.memory-evidence-observation/1",
    observationId: `reproduction-a-${memory.digest.slice(-12)}`,
    kind: "REPRODUCTION",
    sourceCaseDigest: laterCaseA,
    evidenceDigest: sha256Digest(`reproduction-a-${memory.digest}`),
    observedAt: "2026-09-05T14:00:00.000Z",
  });
  deep.appendEvidenceObservation(memory.digest, {
    protocol: "jevyr.memory-evidence-observation/1",
    observationId: `reproduction-b-${memory.digest.slice(-12)}`,
    kind: "REPRODUCTION",
    sourceCaseDigest: laterCaseB,
    evidenceDigest: sha256Digest(`reproduction-b-${memory.digest}`),
    observedAt: "2026-09-06T14:00:00.000Z",
  });
  deep.appendEvidenceObservation(memory.digest, {
    protocol: "jevyr.memory-evidence-observation/1",
    observationId: `contamination-${memory.digest.slice(-12)}`,
    kind: "CONTAMINATION",
    sourceCaseDigest: reviewCase,
    evidenceDigest: sha256Digest(`contamination-${memory.digest}`),
    observedAt: "2026-09-07T14:00:00.000Z",
    passed: true,
  });
  return deep.adjudicateEvidence(memory.digest, "2026-09-08T14:00:00.000Z");
}

function tribunal(overrides: Partial<TribunalEvidence> = {}): TribunalEvidence {
  return {
    reproductionDigests: [sha256Digest("reproduction")],
    counterexampleDigests: [sha256Digest("counterexample")],
    unresolvedContradictions: 0,
    contaminationPassed: true,
    contaminationEvidenceDigest: sha256Digest("contamination"),
    privacyReviewPassed: true,
    privacyEvidenceDigest: sha256Digest("privacy"),
    ...overrides,
  };
}

describe("Memory Tribunal", () => {
  it("refuses raw-shaped content in the cross-project Self Archive", () => {
    const memory = stageMemory(
      candidate({
        scope: "SELF",
        projectId: undefined,
        caseDigest: undefined,
        sourceMemoryDigests: [sha256Digest("source-memory")],
        content: { rawPrompt: "private material" },
      }),
    );
    const decision = adjudicateMemory(memory, tribunal(), now);
    expect(decision.decision).toBe("REJECT");
    expect(decision.reasons).toContain(
      "cross-project content is not restricted to the abstract schema",
    );
  });
});

describe("Temporal Deep", () => {
  it("is amnesic during divergence and retrieves admitted memory late at low weight", () => {
    const deep = new TemporalDeep();
    const submitted = admit(deep);
    expect(submitted.decision.decision).toBe("ADMIT");

    expect(
      deep.retrieve({
        projectId,
        caseDigest,
        stage: "diverge",
        descriptor: [0.2, 0.8],
      }),
    ).toEqual([]);

    const retrieved = deep.retrieve({
      projectId,
      caseDigest,
      stage: "recombine",
      descriptor: [0.2, 0.8],
    });
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.weight).toBeLessThanOrEqual(0.2);

    deep.recordInfluence({
      caseDigest,
      memoryDigest: submitted.memory.digest,
      stage: "recombine",
      weight: retrieved[0]?.weight ?? 0,
      influence: "strategy_selected",
      summary: "Selected as a hypothesis seed, not evidence.",
      observedAt: now,
    });
    expect(deep.exportProject(projectId).influences).toHaveLength(1);
    deep.close();
  });

  it("uses tombstones rather than rewriting admitted history", () => {
    const deep = new TemporalDeep();
    const submitted = admit(deep);
    deep.tombstone(
      submitted.memory.digest,
      sha256Digest("correction-case"),
      "2026-09-04T15:00:00.000Z",
    );
    expect(
      deep.retrieve({
        projectId,
        caseDigest,
        stage: "assay",
      }),
    ).toEqual([]);
    const exported = deep.exportProject(projectId);
    expect(exported.records).toHaveLength(1);
    expect(exported.tombstones).toHaveLength(1);
    deep.close();
  });

  it("purges project memory and derived self abstractions together", () => {
    const deep = new TemporalDeep();
    const project = deep.submit(candidate(), tribunal(), now);
    deep.submit(
      candidate({
        scope: "SELF",
        projectId: undefined,
        caseDigest: undefined,
        sourceMemoryDigests: [project.memory.digest],
        content: {
          strategyFingerprint: "abstract-boundary-search",
          descriptor: [0.2, 0.8],
        },
      }),
      tribunal(),
      "2026-09-04T14:01:00.000Z",
    );
    const result = deep.purgeProject(projectId);
    expect(result.removedProjectRecords).toBe(1);
    expect(result.removedDerivedSelfRecords).toBe(1);
    expect(deep.exportProject(projectId).records).toHaveLength(0);
    deep.close();
  });
});
