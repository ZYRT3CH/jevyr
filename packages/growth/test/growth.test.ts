import { describe, expect, it } from "vitest";
import {
  generateSigningKeyPair,
} from "@jevyr/core";
import { sha256Digest, type JsonValue } from "@jevyr/protocol";
import {
  GENOME_PROTOCOL,
  QualityDiversityArchive,
  createDescendant,
  createGenome,
  promoteGenome,
  runFarFrontierSearch,
  selectArchiveFlagship,
  signGenomePromotion,
  stageDescendant,
  type BenchmarkObservation,
  type CandidateEvaluation,
  type DamageTrial,
  type SearchCandidate,
} from "../src/index.js";

function evaluation(
  overrides: Partial<CandidateEvaluation> = {},
): CandidateEvaluation {
  return {
    integrity: true,
    embodied: true,
    criticalTestsExecuted: true,
    unresolvedCritical: 0,
    scores: {
      discrimination: 0.7,
      robustness: 0.8,
      parsimony: 0.5,
      feasibility: 0.9,
      evidenceCoverage: 0.8,
      resourceEfficiency: 0.6,
    },
    evidenceDigests: [sha256Digest("evidence")],
    failureReasons: [],
    effortUnits: 1,
    ...overrides,
  };
}

function candidate(
  id: string,
  ordinal: number,
  coordinate: number,
): SearchCandidate {
  return {
    id,
    ordinal,
    lineage: "lineage-01",
    phase: "DIVERSIFY",
    parentIds: [],
    publicSummary: "candidate " + id,
    payload: { id },
    descriptor: {
      semantic: [coordinate],
      mechanism: [coordinate],
      causal: [coordinate],
      implementation: [coordinate],
    },
  };
}

describe("quality-diversity archive", () => {
  it("preserves distinct niches and scars candidates without evidence", () => {
    const archive = new QualityDiversityArchive({
      binsPerDimension: 5,
      elitesPerNiche: 2,
      minimumNovelty: 0.01,
    });
    expect(archive.consider(candidate("near", 1, 0.1), evaluation()).accepted).toBe(true);
    expect(archive.consider(candidate("far", 2, 0.9), evaluation()).accepted).toBe(true);
    expect(
      archive.consider(
        candidate("empty", 3, 0.5),
        evaluation({ evidenceDigests: [] }),
      ).accepted,
    ).toBe(false);
    expect(archive.niches).toBe(2);
    expect(archive.entries()).toHaveLength(2);
    expect(archive.graveyard()[0]?.reasons).toContain(
      "no evidence digest supports the candidate",
    );
  });

  it("selects a flagship by measured Pareto evidence with id only as an exact tie-break", () => {
    const archive = new QualityDiversityArchive({ binsPerDimension: 5, elitesPerNiche: 2, minimumNovelty: 0 });
    archive.consider(candidate("aaa-flattering-prose", 1, 0.1), evaluation({
      scores: { ...evaluation().scores, resourceEfficiency: 0.1 },
    }));
    archive.consider(candidate("zzz-measured-winner", 2, 0.9), evaluation({
      scores: { ...evaluation().scores, resourceEfficiency: 0.9 },
    }));
    expect(selectArchiveFlagship(archive.entries())?.candidate.id).toBe("zzz-measured-winner");
    expect(selectArchiveFlagship([])).toBeUndefined();
  });

  it("enforces a global measured-survivor capacity across distinct niches", () => {
    const archive = new QualityDiversityArchive({
      binsPerDimension: 5,
      elitesPerNiche: 2,
      minimumNovelty: 0,
      capacity: 1,
    });
    archive.consider(candidate("first", 1, 0.1), evaluation({
      scores: { ...evaluation().scores, robustness: 0.2 },
    }));
    const stronger = archive.consider(candidate("stronger", 2, 0.9), evaluation({
      scores: { ...evaluation().scores, robustness: 0.95 },
    }));

    expect(stronger.accepted).toBe(true);
    expect(archive.entries().map((entry) => entry.candidate.id)).toEqual(["stronger"]);
    expect(archive.niches).toBe(1);
    expect(stronger.displaced.map((entry) => entry.candidate.id)).toContain("first");
    expect(archive.graveyard().at(-1)?.reasons).toContain(
      "global archive capacity retained a stronger measured set",
    );
  });

  it("evicts a crowded niche before erasing distinct measured territory", () => {
    const archive = new QualityDiversityArchive({
      binsPerDimension: 5,
      elitesPerNiche: 2,
      minimumNovelty: 0,
      capacity: 2,
    });
    archive.consider(candidate("same-a", 1, 0.1), evaluation());
    archive.consider(candidate("same-b", 2, 0.11), evaluation());
    archive.consider(candidate("distinct", 3, 0.9), evaluation({
      scores: { ...evaluation().scores, robustness: 0.1 },
    }));

    expect(archive.size).toBe(2);
    expect(archive.niches).toBe(2);
    expect(archive.entries().map((entry) => entry.candidate.id)).toContain("distinct");
  });
});

describe("far-frontier search", () => {
  it("reaches the sealed safety ceiling when novelty keeps arriving", async () => {
    const observations: string[] = [];
    const result = await runFarFrontierSearch(
      {
        async propose(context) {
          const coordinate = (context.ordinal % 17) / 16;
          return {
            publicSummary: "proposal " + context.ordinal,
            payload: { ordinal: context.ordinal },
            descriptor: {
              semantic: [coordinate],
              mechanism: [((context.ordinal * 3) % 17) / 16],
              causal: [((context.ordinal * 5) % 17) / 16],
              implementation: [((context.ordinal * 7) % 17) / 16],
            },
          };
        },
        async evaluate(next) {
          return evaluation({
            integrity: next.ordinal % 11 !== 0,
            evidenceDigests: [sha256Digest("candidate-" + next.ordinal)],
            scores: {
              ...evaluation().scores,
              robustness: Math.min(1, 0.5 + next.ordinal / 100),
            },
          });
        },
        async inventChallenge(context) {
          return {
            publicSummary: "challenge at " + context.ordinal,
            payload: { ordinal: context.ordinal } as JsonValue,
            evidenceDigest: sha256Digest("challenge-" + context.ordinal),
          };
        },
      },
      {
        attemptSafetyCeiling: "40",
        effortCeiling: 100,
        minimumAttempts: 40,
        saturationWindow: 10,
        minimumNiches: 2,
        independentLineages: 8,
        challengeInterval: 4,
        binsPerDimension: 5,
        elitesPerNiche: 2,
        minimumNovelty: 0,
        seed: 7,
      },
      (observation) => observations.push(observation.type),
    );
    expect(result.attempted).toBe(40);
    expect(observations.filter((type) => type === "candidate.proposed")).toHaveLength(40);
    expect(observations.at(-1)).toBe("search.completed");
    expect(result.flagship).toBeDefined();
    expect(result.archive.length).toBeGreaterThan(1);
    expect(result.graveyard.some((entry) => !entry.evaluation.integrity)).toBe(true);
    expect(result.challenges.length).toBeGreaterThan(0);
  });

  it("stops when measured discovery saturates instead of fetishizing attempt count", async () => {
    const result = await runFarFrontierSearch(
      {
        async propose(context) {
          return {
            publicSummary: "same niche " + context.ordinal,
            payload: { ordinal: context.ordinal },
            descriptor: {
              semantic: [0.5],
              mechanism: [0.5],
              causal: [0.5],
              implementation: [0.5],
            },
          };
        },
        async evaluate(next) {
          return evaluation({
            evidenceDigests: [sha256Digest("candidate-" + next.ordinal)],
          });
        },
      },
      {
        attemptSafetyCeiling: "100",
        effortCeiling: 100,
        minimumAttempts: 4,
        saturationWindow: 3,
        minimumNiches: 1,
        independentLineages: 2,
        challengeInterval: 4,
        binsPerDimension: 5,
        elitesPerNiche: 1,
        minimumNovelty: 0,
        seed: 7,
      },
    );

    expect(result.termination).toBe("SATURATED");
    expect(result.attempted).toBe(4);
    expect(result.profile.attemptSafetyCeiling).toBe("100");
  });

  it("obeys the physical effort envelope and refuses an overrun", async () => {
    const operator = {
      async propose(context: { ordinal: number }) {
        return {
          publicSummary: "metered " + context.ordinal,
          payload: { ordinal: context.ordinal },
          descriptor: {
            semantic: [0.1],
            mechanism: [0.2],
            causal: [0.3],
            implementation: [0.4],
          },
        };
      },
      async evaluate() {
        return evaluation({ effortUnits: 5 });
      },
    };

    await expect(
      runFarFrontierSearch(operator, {
        attemptSafetyCeiling: "99",
        effortCeiling: 4,
        minimumAttempts: 1,
        saturationWindow: 1,
        minimumNiches: 1,
        independentLineages: 1,
        challengeInterval: 1,
        binsPerDimension: 2,
        elitesPerNiche: 1,
        minimumNovelty: 0,
        seed: 1,
      }),
    ).rejects.toThrow(/sealed effort authorization/);
  });

  it("requires integral physical effort so an astronomical guard cannot outlive its meter", async () => {
    const profile = {
      attemptSafetyCeiling: "1500000000000000000000",
      effortCeiling: 4,
      minimumAttempts: 1,
      saturationWindow: 1,
      minimumNiches: 1,
      independentLineages: 1,
      challengeInterval: 1,
      binsPerDimension: 2,
      elitesPerNiche: 1,
      minimumNovelty: 0,
      seed: 1,
    };
    const operator = {
      async propose(context: { ordinal: number }) {
        return {
          publicSummary: `fractional meter ${context.ordinal}`,
          payload: { ordinal: context.ordinal },
          descriptor: {
            semantic: [0.1],
            mechanism: [0.2],
            causal: [0.3],
            implementation: [0.4],
          },
        };
      },
      async evaluate() {
        return evaluation({ effortUnits: Number.MIN_VALUE });
      },
    };

    await expect(runFarFrontierSearch(operator, profile)).rejects.toThrow(
      /invalid effort measurement/,
    );
    await expect(
      runFarFrontierSearch(operator, {
        ...profile,
        attemptSafetyCeiling: "9".repeat(129),
      }),
    ).rejects.toThrow(/at most 128 digits/);
  });

  it("accepts an astronomically remote safety ceiling without trying to spend it", async () => {
    const result = await runFarFrontierSearch(
      {
        async propose(context) {
          const coordinate = context.ordinal / 10;
          return {
            publicSummary: "bounded by physics " + context.ordinal,
            payload: { ordinal: context.ordinal },
            descriptor: {
              semantic: [coordinate],
              mechanism: [coordinate],
              causal: [coordinate],
              implementation: [coordinate],
            },
          };
        },
        async evaluate(next) {
          return evaluation({
            evidenceDigests: [sha256Digest("bounded-" + next.ordinal)],
            effortUnits: 1,
          });
        },
      },
      {
        attemptSafetyCeiling: "1500000000000000000000",
        effortCeiling: 4,
        minimumAttempts: 1,
        saturationWindow: 10,
        minimumNiches: 100,
        independentLineages: 4,
        challengeInterval: 2,
        binsPerDimension: 5,
        elitesPerNiche: 1,
        minimumNovelty: 0,
        seed: 1,
      },
    );

    expect(result.termination).toBe("EFFORT_EXHAUSTED");
    expect(result.attempted).toBe(4);
    expect(result.profile.attemptSafetyCeiling).toBe(
      "1500000000000000000000",
    );
  });
});

describe("constitutional genome growth", () => {
  const boneDigest = sha256Digest("bone-v1");
  const moduleDigest = sha256Digest("module-v1");
  const parent = createGenome({
    protocol: GENOME_PROTOCOL,
    generation: 0,
    boneDigest,
    parentDigests: [],
    modules: [
      {
        id: "diverge",
        version: "1.0.0",
        artifactDigest: moduleDigest,
        permissions: ["propose"],
        publicPurpose: "Produce blind alternatives.",
      },
    ],
    parameters: { lineages: 8 },
  });

  function observations(): BenchmarkObservation[] {
    return [
      "bone-invariants",
      "historical-regressions",
      "held-out-adversarial",
      "anchoring-contamination",
      "resource-bounds",
    ].map((suite, index) => ({
      suite,
      heldOut: suite === "held-out-adversarial",
      invariant: suite === "bone-invariants",
      passed: true,
      score: index === 2 ? 0.92 : 1,
      parentScore: index === 2 ? 0.8 : 1,
      evidenceDigest: sha256Digest("suite-" + suite),
    }));
  }

  function damage(): DamageTrial[] {
    return [
      "CORRUPTION",
      "RESOURCE_LOSS",
      "ADVERSARIAL_INPUT",
      "TOOL_LOSS",
    ].map((kind, index) => ({
      id: "damage-" + index,
      kind: kind as DamageTrial["kind"],
      passed: true,
      recoveredToBone: true,
      evidenceDigest: sha256Digest("damage-" + index),
    }));
  }

  it("stages an immutable offspring and requires signed governance to promote", () => {
    const descendant = createDescendant(parent, {
      parameters: { lineages: 16 },
    });
    const proposal = stageDescendant(
      parent,
      descendant,
      observations(),
      damage(),
      0.3,
    );
    expect(proposal.decision).toBe("STAGED");
    expect(parent.body.parameters.lineages).toBe(8);
    expect(descendant.body.boneDigest).toBe(parent.body.boneDigest);

    const keys = generateSigningKeyPair();
    const attestation = signGenomePromotion(
      proposal,
      keys.privateKeyPem,
      keys.keyId,
    );
    const promoted = promoteGenome(
      proposal,
      attestation,
      new Map([[keys.keyId, keys.publicKeyPem]]),
    );
    expect(promoted.promoted).toBe(true);
    expect(promoted.genome.digest).toBe(descendant.digest);
  });

  it("rejects a descendant that attempts to change Bone", () => {
    const mutant = createGenome({
      ...parent.body,
      generation: 1,
      parentDigests: [parent.digest],
      boneDigest: sha256Digest("hostile-bone"),
    });
    const proposal = stageDescendant(
      parent,
      mutant,
      observations(),
      damage(),
      0.3,
    );
    expect(proposal.decision).toBe("REJECTED");
    expect(proposal.reasons).toContain(
      "Bone mutation is constitutionally inadmissible",
    );
  });
});
