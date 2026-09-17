import { describe, expect, it } from "vitest";
import { runHypothesisNursery, type NurseryProfile } from "../src/index.js";

function profile(overrides: Partial<NurseryProfile> = {}): NurseryProfile {
  return {
    attemptSafetyCeiling: "1500000000000000000000",
    minimumAttempts: 1,
    saturationWindow: 100,
    independentLineages: 3,
    challengeInterval: 2,
    seed: 41,
    resources: {
      maxMindInvocations: 4,
      maxInputTokens: 1_000_000,
      maxOutputTokens: 1_000_000,
      maxWallMillis: 60_000,
      maxGeneratedBytes: 1_000_000,
      maxSingleInvocationMillis: 10_000,
    },
    ...overrides,
  };
}

describe("untrusted hypothesis nursery", () => {
  it("rejects a guard too large to parse as bounded protocol control", async () => {
    await expect(
      runHypothesisNursery(
        { async propose() { return []; } },
        profile({ attemptSafetyCeiling: "9".repeat(129) }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/at most 128 digits/);
  });

  it("stops on measured calls despite an astronomically remote loop guard", async () => {
    const result = await runHypothesisNursery(
      {
        async propose(context) {
          return [{
            publicSummary: `Hypothesis ${context.ordinal}`,
            payload: { mechanism: context.ordinal },
            declaredMechanisms: [`mechanism-${context.ordinal}`],
          }];
        },
      },
      profile(),
      new AbortController().signal,
    );
    expect(result.termination).toBe("RESOURCE_EXHAUSTED");
    expect(result.attempted).toBe(4);
    expect(result.resources.mindInvocations).toBe(4);
    expect(result.specimens).toHaveLength(4);
  });

  it("calls exact-content saturation what it is and never behavioral novelty", async () => {
    const result = await runHypothesisNursery(
      { async propose() { return [{ publicSummary: "Identical public hypothesis", payload: { mechanism: "same" } }]; } },
      profile({
        minimumAttempts: 2,
        saturationWindow: 2,
        resources: { ...profile().resources, maxMindInvocations: 10 },
      }),
      new AbortController().signal,
    );
    expect(result.termination).toBe("HYPOTHESIS_SATURATED");
    expect(result.attempted).toBe(3);
    expect(result.specimens).toHaveLength(1);
    expect(result.scars.every((scar) => scar.code === "DUPLICATE")).toBe(true);
  });

  it("keeps the first independent lineages mutually blind", async () => {
    const parentCounts: number[] = [];
    await runHypothesisNursery(
      {
        async propose(context) {
          parentCounts.push(context.parents.length);
          return [{ publicSummary: `Lineage output ${context.ordinal}`, payload: { ordinal: context.ordinal } }];
        },
      },
      profile(),
      new AbortController().signal,
    );
    expect(parentCounts.slice(0, 3)).toEqual([0, 0, 0]);
    expect(parentCounts[3]).toBeGreaterThan(0);
  });

  it("uses the sealed challenge interval as the coevolution cadence", async () => {
    const phases: string[] = [];
    await runHypothesisNursery(
      {
        async propose(context) {
          phases.push(context.phase);
          return [{ publicSummary: `Cadence ${context.ordinal}`, payload: { ordinal: context.ordinal } }];
        },
      },
      profile({
        independentLineages: 2,
        challengeInterval: 3,
        resources: { ...profile().resources, maxMindInvocations: 8 },
      }),
      new AbortController().signal,
    );
    expect(phases).toEqual([
      "EXILE",
      "EXILE",
      "DIVERSIFY",
      "RECOMBINE",
      "COEVOLVE",
      "INVERT",
      "DIVERSIFY",
      "COEVOLVE",
    ]);
  });

  it("refuses to admit a response that crosses its sealed byte envelope", async () => {
    const result = await runHypothesisNursery(
      { async propose() { return [{ publicSummary: "This response is larger than ten encoded bytes.", payload: { large: true } }]; } },
      profile({
        resources: { ...profile().resources, maxGeneratedBytes: 10, maxMindInvocations: 2 },
      }),
      new AbortController().signal,
    );
    expect(result.specimens).toHaveLength(0);
    expect(result.scars).toContainEqual(expect.objectContaining({ code: "RESOURCE_OVERRUN" }));
    expect(result.termination).toBe("RESOURCE_EXHAUSTED");
  });

  it("denies an invocation before the Mind runs when its exact input upper bound cannot fit", async () => {
    let invocations = 0;
    const result = await runHypothesisNursery(
      {
        inputTokenUpperBound: () => 11,
        async propose() {
          invocations += 1;
          return [{ publicSummary: "This must never run", payload: null }];
        },
      },
      profile({
        resources: { ...profile().resources, maxInputTokens: 10 },
      }),
      new AbortController().signal,
    );
    expect(invocations).toBe(0);
    expect(result.resources.mindInvocations).toBe(0);
    expect(result.resources.inputTokens).toBe(0);
    expect(result.specimens).toHaveLength(0);
    expect(result.scars[0]?.summary).toContain("Mind was not invoked");
    expect(result.termination).toBe("RESOURCE_EXHAUSTED");
  });

  it("charges one metered invocation but refuses every proposal after an output-token overrun", async () => {
    const result = await runHypothesisNursery(
      {
        inputTokenUpperBound: () => 5,
        async propose() {
          return {
            proposals: [{ publicSummary: "A well-formed but over-budget hypothesis", payload: { valid: true } }],
            tokenUsage: {
              input: { tokens: 3, measurement: "MEASURED" },
              output: { tokens: 11, measurement: "MEASURED" },
            },
          } as const;
        },
      },
      profile({
        resources: { ...profile().resources, maxMindInvocations: 2, maxOutputTokens: 10 },
      }),
      new AbortController().signal,
    );
    expect(result.resources.mindInvocations).toBe(1);
    expect(result.resources.inputTokens).toBe(3);
    expect(result.resources.outputTokens).toBe(11);
    expect(result.resources.inputTokenMeasurement).toBe("MEASURED");
    expect(result.resources.outputTokenMeasurement).toBe("MEASURED");
    expect(result.specimens).toHaveLength(0);
    expect(result.scars).toContainEqual(expect.objectContaining({ code: "RESOURCE_OVERRUN" }));
  });

  it("charges only an operator-declared per-call output reservation on opaque failure", async () => {
    const caps: number[] = [];
    const chargedAfterFailure: number[] = [];
    const result = await runHypothesisNursery(
      {
        outputTokenUpperBound(context) {
          const cap = Math.ceil(
            context.resourcesRemaining.maxOutputTokens
              / context.resourcesRemaining.maxMindInvocations,
          );
          caps.push(cap);
          return cap;
        },
        async propose() {
          throw new Error("opaque provider failure");
        },
      },
      profile({
        resources: { ...profile().resources, maxMindInvocations: 3, maxOutputTokens: 11 },
      }),
      new AbortController().signal,
      (observation) => {
        if (observation.type === "hypothesis.scarred") {
          chargedAfterFailure.push(observation.resources.outputTokens);
        }
      },
    );
    expect(caps).toEqual([4, 4, 3]);
    expect(chargedAfterFailure).toEqual([4, 8, 11]);
    expect(result.resources.mindInvocations).toBe(3);
    expect(result.resources.outputTokens).toBe(11);
    expect(result.resources.outputTokenMeasurement).toBe("UPPER_BOUND");
    expect(result.scars).toHaveLength(3);
    expect(result.termination).toBe("RESOURCE_EXHAUSTED");
  });

  it("rejects an output reservation that cannot fit before invoking the operator", async () => {
    let invocations = 0;
    const result = await runHypothesisNursery(
      {
        outputTokenUpperBound: () => 11,
        async propose() {
          invocations += 1;
          return [];
        },
      },
      profile({ resources: { ...profile().resources, maxOutputTokens: 10 } }),
      new AbortController().signal,
    );
    expect(invocations).toBe(0);
    expect(result.resources.mindInvocations).toBe(0);
    expect(result.resources.outputTokens).toBe(0);
    expect(result.scars[0]?.summary).toContain("Mind was not invoked");
    expect(result.termination).toBe("RESOURCE_EXHAUSTED");
  });

  it("does not let a malformed failure receipt undercharge its reservations", async () => {
    const result = await runHypothesisNursery(
      {
        inputTokenUpperBound: () => 5,
        outputTokenUpperBound: () => 4,
        async propose() {
          return {
            proposals: [],
            failure: "claimed metered failure",
            tokenUsage: {
              input: { tokens: 0, measurement: "MEASURED" },
              output: { tokens: 0, measurement: "MEASURED" },
            },
          } as const;
        },
      },
      profile({
        resources: { ...profile().resources, maxMindInvocations: 1, maxOutputTokens: 10 },
      }),
      new AbortController().signal,
    );
    expect(result.resources.inputTokens).toBe(5);
    expect(result.resources.outputTokens).toBe(4);
    expect(result.resources.inputTokenMeasurement).toBe("UPPER_BOUND");
    expect(result.resources.outputTokenMeasurement).toBe("UPPER_BOUND");
    expect(result.scars[0]?.summary).toContain("conservatively upper-bound");
  });

  it("labels deterministic byte fallback as UPPER_BOUND and never as measured", async () => {
    const result = await runHypothesisNursery(
      {
        async propose() {
          return [{ publicSummary: "Locally returned complete boundary", payload: { local: true } }];
        },
      },
      profile({ resources: { ...profile().resources, maxMindInvocations: 1 } }),
      new AbortController().signal,
    );
    expect(result.resources.inputTokens).toBeGreaterThan(0);
    expect(result.resources.outputTokens).toBeGreaterThan(0);
    expect(result.resources.inputTokenMeasurement).toBe("UPPER_BOUND");
    expect(result.resources.outputTokenMeasurement).toBe("UPPER_BOUND");
  });
});
