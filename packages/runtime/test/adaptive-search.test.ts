import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { createSearchEnvelope } from "@jevyr/protocol";
import { compileIntentContract } from "@jevyr/core";
import {
  DEFAULT_SEARCH_PROFILE,
  MindMeteredFailure,
  OpenAICompatibleMindAdapter,
  RuleMindAdapter,
  runAdaptiveSearch,
  type CapabilityCard,
  type MindAdapter,
  type MindInvocationResult,
  type MindRequest,
  type ProbeResult,
  type PublicContribution,
  type SealedCaseContext,
} from "../src/index.js";

const SEARCH_INTENT_CONTRACT = compileIntentContract({ impulse: "Grow an unfamiliar self-discriminating mechanism" });

const sealed: SealedCaseContext = {
  protocol: "jevyr.case/1",
  caseId: "case_search_12345678",
  submissionDigest: `sha256:${"0".repeat(64)}`,
  caseDigest: `sha256:${"a".repeat(64)}`,
  runDigest: `sha256:${"b".repeat(64)}`,
  sealedAt: "2026-09-04T12:00:00.000Z",
  policyVersion: "jevyr.bone/1",
  policyDigest: `sha256:${"d".repeat(64)}`,
  genomeVersion: "jevyr.genome/1",
  genomeDigest: `sha256:${"e".repeat(64)}`,
  searchEnvelope: createSearchEnvelope(DEFAULT_SEARCH_PROFILE),
  intentContractDigest: SEARCH_INTENT_CONTRACT.digest,
  intentContract: SEARCH_INTENT_CONTRACT,
  intent: {
    impulse: "Grow an unfamiliar self-discriminating mechanism",
    mode: "auto",
    subjects: [],
    constraints: [],
    requestedAssays: [],
    privacy: "local_only",
    control: "sovereign",
    seed: "fixed",
  },
  subjects: [],
};

function sealedForCalls(
  maxMindInvocations: number,
  resourceOverrides: Partial<typeof DEFAULT_SEARCH_PROFILE.resources> = {},
): SealedCaseContext {
  return {
    ...sealed,
    searchEnvelope: createSearchEnvelope({
      ...DEFAULT_SEARCH_PROFILE,
      nursery: {
        minimumAttempts: 1,
        saturationWindow: 100,
        independentLineages: 3,
        challengeInterval: 2,
      },
      resources: {
        ...DEFAULT_SEARCH_PROFILE.resources,
        maxMindInvocations,
        maxWallMillis: 60_000,
        maxSingleInvocationMillis: 10_000,
        maxGeneratedBytes: 1_000_000,
        concurrentLineages: 3,
        ...resourceOverrides,
      },
    }),
  };
}

test("adaptive runtime spends sealed effort rather than chasing its astronomical safety ceiling", async () => {
  const observed: string[] = [];
  const outcome = await runAdaptiveSearch({
    sealed: sealedForCalls(4),
    minds: [new RuleMindAdapter()],
    publicFacts: [],
    signal: new AbortController().signal,
    observe: (entry) => observed.push(entry.type),
  });
  assert.equal(outcome.nursery.profile.attemptSafetyCeiling, "1500000000000000000000");
  assert.equal(outcome.nursery.attempted, 4);
  assert.equal(outcome.nursery.resources.mindInvocations, 4);
  assert.equal(outcome.nursery.termination, "RESOURCE_EXHAUSTED");
  assert.equal(observed.at(-1), "nursery.completed");
  assert.ok(outcome.hypotheses.length > 0);
  assert.equal(outcome.hypotheses.every((candidate) => candidate.tags?.includes("not-assay-backed")), true);
});

class RecordingMind implements MindAdapter {
  readonly seenCandidateCounts: number[] = [];
  readonly seenFacts: (readonly PublicContribution[])[] = [];
  readonly capability: CapabilityCard = {
    id: "mind.recording",
    kind: "mind",
    displayName: "Recording Mind",
    version: "1",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: ["text"],
    network: "none",
    canExecuteTools: false,
    deterministic: true,
  };

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "available" };
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    this.seenFacts.push(structuredClone(request.publicFacts));
    this.seenCandidateCounts.push(request.publicFacts.filter((fact) => fact.kind === "candidate").length);
    const ordinal = this.seenCandidateCounts.length;
    yield {
      id: `source_${ordinal}`,
      kind: "candidate",
      summary: `Mechanism ${ordinal} changes a distinct causal boundary.`,
      feasibility: "BRIDGEABLE",
      tags: [`mechanism-${ordinal}`],
    };
  }
}

test("independent exile lineages cannot observe one another before later ecological phases", async () => {
  const mind = new RecordingMind();
  const outcome = await runAdaptiveSearch({
    sealed: sealedForCalls(4),
    minds: [mind],
    publicFacts: [{ id: "reading", kind: "interpretation", summary: "A fixed pre-divergence reading." }],
    signal: new AbortController().signal,
  });
  assert.deepEqual(mind.seenCandidateCounts.slice(0, 3), [0, 0, 0]);
  assert.ok((mind.seenCandidateCounts[3] ?? 0) > 0);
  assert.equal(outcome.nursery.resources.inputTokenMeasurement, "UPPER_BOUND");
  assert.equal(outcome.nursery.resources.outputTokenMeasurement, "UPPER_BOUND");
});

test("EXILE cannot inherit a candidate or repair emitted during INTERPRET", async () => {
  const mind = new RecordingMind();
  const publicFacts: readonly PublicContribution[] = Object.freeze([
    { id: "interpretation", kind: "interpretation", summary: "The shared sealed problem statement." },
    { id: "premature-candidate", kind: "candidate", summary: "A preferred answer invented during INTERPRET." },
    { id: "premature-repair", kind: "repair", summary: "An anchored repair emitted before the blind wave." },
  ]);
  const observedVisible: string[][] = [];
  await runAdaptiveSearch({ sealed: sealedForCalls(4), minds: [mind], publicFacts, signal: new AbortController().signal,
    observe(entry) { if (entry.audit) observedVisible.push([...entry.audit.visibleCandidateIds]); },
  });
  assert.equal(mind.seenFacts.length, 4);
  for (const facts of mind.seenFacts.slice(0, 3)) assert.deepEqual(facts.map((fact) => fact.id), ["interpretation"]);
  assert.deepEqual(mind.seenCandidateCounts.slice(0, 3), [0, 0, 0]);
  assert.ok(mind.seenFacts[3]?.some((fact) => fact.id === "premature-candidate"));
  assert.deepEqual(observedVisible, [[], [], []]);
  assert.equal(publicFacts.length, 3, "filtering the blind view must not mutate sealed shared facts");
});

test("adaptive archive identities are reproducible for the same sealed run and profile", async () => {
  const run = async () => await runAdaptiveSearch({
    sealed: sealedForCalls(3),
    minds: [new RuleMindAdapter()],
    publicFacts: [],
    signal: new AbortController().signal,
  });
  const [left, right] = await Promise.all([run(), run()]);
  assert.deepEqual(
    left.nursery.specimens.map((entry) => entry.id),
    right.nursery.specimens.map((entry) => entry.id),
  );
});

class SelfMutatingMind implements MindAdapter {
  readonly capability = {
    id: "mind.adaptive.original",
    kind: "mind" as const,
    displayName: "Adaptive original",
    version: "1",
    transport: "in-process" as const,
    trust: "local-deterministic" as const,
    modalities: ["text" as const],
    network: "none" as const,
    canExecuteTools: false,
    deterministic: true,
  };

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "available" };
  }

  async *run(): AsyncIterable<PublicContribution> {
    const live = this.capability as unknown as Record<string, unknown>;
    live.id = "mind.adaptive.mutated";
    live.displayName = "Adaptive mutated";
    live.network = "unrestricted";
    yield {
      id: "adaptive_mutation_candidate",
      kind: "candidate",
      summary: "A self-mutating adapter cannot rewrite its admitted provenance.",
    };
  }
}

test("adaptive observations retain the admitted capability after an adapter mutates its live card", async () => {
  const observedSources: CapabilityCard[] = [];
  await runAdaptiveSearch({
    sealed: sealedForCalls(1),
    minds: [new SelfMutatingMind()],
    publicFacts: [],
    signal: new AbortController().signal,
    observe(entry) {
      if (entry.source !== undefined) observedSources.push(entry.source);
    },
  });
  assert.ok(observedSources.length > 0);
  assert.equal(observedSources.every((source) => source.id === "mind.adaptive.original"), true);
  assert.equal(observedSources.every((source) => source.displayName === "Adaptive original"), true);
  assert.equal(observedSources.every((source) => source.network === "none"), true);
});

test("adaptive search refuses a pre-call input reservation that cannot fit the sealed budget", async () => {
  const mind = new RecordingMind();
  const outcome = await runAdaptiveSearch({
    sealed: sealedForCalls(2, { maxInputTokens: 1 }),
    minds: [mind],
    publicFacts: [],
    signal: new AbortController().signal,
  });
  assert.equal(mind.seenCandidateCounts.length, 0);
  assert.equal(outcome.nursery.resources.mindInvocations, 0);
  assert.equal(outcome.nursery.resources.inputTokens, 0);
  assert.equal(outcome.nursery.termination, "RESOURCE_EXHAUSTED");
  assert.match(outcome.nursery.scars[0]?.summary ?? "", /Mind was not invoked/);
});

class OverrunMind implements MindAdapter {
  readonly capability: CapabilityCard = {
    id: "mind.output-overrun",
    kind: "mind",
    displayName: "Output Overrun Mind",
    version: "1",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: ["text"],
    network: "none",
    canExecuteTools: false,
    deterministic: true,
  };

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "available" };
  }

  async runMetered(): Promise<MindInvocationResult> {
    return {
      contributions: [{ id: "overrun", kind: "candidate", summary: "This candidate must not cross admission." }],
      tokenUsage: {
        input: { tokens: 3, measurement: "MEASURED" },
        output: { tokens: 11, measurement: "MEASURED" },
      },
      transmittedInputBytes: 1_000,
      receivedOutputBytes: 100,
    };
  }

  async *run(): AsyncIterable<PublicContribution> {
    throw new Error("adaptive search must use the single metered invocation path");
  }
}

test("adaptive search charges a metered Mind exactly once and rejects its output overrun", async () => {
  const outcome = await runAdaptiveSearch({
    sealed: sealedForCalls(2, { maxOutputTokens: 10 }),
    minds: [new OverrunMind()],
    publicFacts: [],
    signal: new AbortController().signal,
  });
  assert.equal(outcome.nursery.resources.mindInvocations, 1);
  assert.equal(outcome.nursery.resources.inputTokens, 3);
  assert.equal(outcome.nursery.resources.outputTokens, 11);
  assert.equal(outcome.nursery.resources.outputTokenMeasurement, "MEASURED");
  assert.equal(outcome.hypotheses.length, 0);
  assert.equal(outcome.nursery.termination, "RESOURCE_EXHAUSTED");
});

class FailingMeteredMind implements MindAdapter {
  readonly caps: number[] = [];
  readonly promptBytes: number[] = [];
  readonly capability: CapabilityCard = {
    id: "mind.metered-failure",
    kind: "mind",
    displayName: "Metered Failure Mind",
    version: "1",
    transport: "http",
    trust: "quarantined",
    modalities: ["text"],
    network: "loopback",
    canExecuteTools: false,
    deterministic: true,
  };

  async probe(): Promise<ProbeResult> {
    return { available: true, observedAt: sealed.sealedAt, latencyMs: 0, detail: "available" };
  }

  async runMetered(request: MindRequest): Promise<MindInvocationResult> {
    this.caps.push(request.maxOutputTokens ?? -1);
    const bytes = Buffer.byteLength(request.preparedPublicPrompt ?? "", "utf8");
    this.promptBytes.push(bytes);
    throw new MindMeteredFailure("two-attempt provider failure", bytes * 2);
  }

  async *run(): AsyncIterable<PublicContribution> {
    throw new Error("adaptive search must use the metered failure path");
  }
}

test("adaptive failures charge a bounded share while retaining exact retry input accounting", async () => {
  const mind = new FailingMeteredMind();
  const failureOutputCharges: number[] = [];
  const outcome = await runAdaptiveSearch({
    sealed: sealedForCalls(3, { maxOutputTokens: 11 }),
    minds: [mind],
    publicFacts: [],
    signal: new AbortController().signal,
    observe(observation) {
      if (observation.type === "hypothesis.scarred") {
        failureOutputCharges.push(observation.resources.outputTokens);
      }
    },
  });
  assert.deepEqual(mind.caps, [4, 4, 3]);
  assert.deepEqual(failureOutputCharges, [4, 8, 11]);
  assert.equal(
    outcome.nursery.resources.inputTokens,
    mind.promptBytes.reduce((total, bytes) => total + (bytes * 2), 0),
  );
  assert.equal(outcome.nursery.resources.inputTokenMeasurement, "UPPER_BOUND");
  assert.equal(outcome.nursery.resources.outputTokenMeasurement, "UPPER_BOUND");
  assert.equal(outcome.nursery.resources.mindInvocations, 3);
  assert.equal(outcome.nursery.scars.length, 3);
});

test("OpenAI-compatible provider integer usage is measured and the sealed output cap is transmitted", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          contributions: [{
            kind: "candidate",
            summary: "Provider-metered causal mechanism.",
            blueprint: {
              protocol: "jevyr.candidate-blueprint/1",
              files: [{ path: "candidate.mjs", content: "process.stdout.write('finite candidate\\n');\n" }],
              command: { executable: "node", args: ["candidate.mjs"] },
            },
          }],
        }) } }],
        usage: { prompt_tokens: 17, completion_tokens: 9 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an IP test address");
    const outcome = await runAdaptiveSearch({
      sealed: sealedForCalls(1, { maxOutputTokens: 23 }),
      minds: [new OpenAICompatibleMindAdapter({
        id: "mind.test-provider",
        displayName: "Test Provider",
        baseUrl: `http://127.0.0.1:${address.port}/v1/`,
        model: "fixture",
      })],
      publicFacts: [],
      signal: new AbortController().signal,
    });
    assert.equal(outcome.nursery.resources.inputTokens, 17);
    assert.equal(outcome.nursery.resources.outputTokens, 9);
    assert.equal(outcome.nursery.resources.inputTokenMeasurement, "MEASURED");
    assert.equal(outcome.nursery.resources.outputTokenMeasurement, "MEASURED");
    assert.equal(requestBody?.max_tokens, 23);
    assert.equal(outcome.hypotheses.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
