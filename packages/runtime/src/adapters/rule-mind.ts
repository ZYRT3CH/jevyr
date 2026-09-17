import { seededUnit, stableId } from "../canonical.js";
import type { CapabilityCard, MindAdapter, MindInvocationResult, MindRequest, ProbeResult, PublicContribution } from "../contracts.js";
import { conservativeUsage } from "../mind-metering.js";
import { makePublicMindPrompt, publicMindCaseId } from "./prompt.js";

const STRATEGIES = [
  "invert the assumed direction of control",
  "make the substrate carry both state and constraint",
  "split creation from the authority to judge it",
  "treat failure as durable anatomy rather than discarded output",
  "look for the smallest discriminating experiment",
  "preserve incompatible mechanisms until evidence separates them",
] as const;

function terms(impulse: string): string[] {
  const stop = new Set(["that", "this", "with", "from", "have", "will", "what", "your", "there", "about"]);
  return [...new Set(impulse.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? [])]
    .filter((word) => !stop.has(word))
    .slice(0, 6);
}

function contribution(request: MindRequest, index: number, value: Omit<PublicContribution, "id">): PublicContribution {
  return {
    id: stableId("rule", {
      caseId: publicMindCaseId(request),
      stage: request.stage,
      seed: request.seed,
      index,
      summary: value.summary,
    }),
    ...value,
    tags: [...(value.tags ?? []), "rule-mind", "deterministic"],
  };
}

export class RuleMindAdapter implements MindAdapter {
  readonly capability: CapabilityCard = {
    id: "mind.rule.v1",
    kind: "mind",
    displayName: "Rule Mind",
    version: "1.0.0",
    transport: "in-process",
    trust: "local-deterministic",
    modalities: ["text", "structured-data"],
    network: "none",
    canExecuteTools: false,
    deterministic: true,
    limits: { maxContributions: 6 },
  };

  async probe(): Promise<ProbeResult> {
    return {
      available: true,
      observedAt: new Date().toISOString(),
      latencyMs: 0,
      version: this.capability.version,
      detail: "Built-in deterministic contributor; no credentials or network required.",
    };
  }

  async runMetered(request: MindRequest): Promise<MindInvocationResult> {
    const contributions: PublicContribution[] = [];
    for await (const item of this.run(request)) contributions.push(item);
    const rawOutput = JSON.stringify({ contributions });
    return Object.freeze({
      contributions: Object.freeze(contributions),
      ...conservativeUsage(makePublicMindPrompt(request), rawOutput),
    });
  }

  async *run(request: MindRequest): AsyncIterable<PublicContribution> {
    const nouns = terms(request.sealed.intent.impulse);
    const subject = nouns.length ? nouns.join(", ") : "the sealed impulse";
    const choose = (offset: number): string =>
      STRATEGIES[Math.floor(seededUnit(request.seed, offset) * STRATEGIES.length)] ?? STRATEGIES[0];

    if (request.stage === "interpret") {
      yield contribution(request, 0, {
        kind: "interpretation",
        summary: `Read the case literally as a demand concerning ${subject}.`,
        body: "This interpretation preserves explicit nouns and verbs without inferring a preferred answer.",
      });
      yield contribution(request, 1, {
        kind: "interpretation",
        summary: `Read the case structurally: ${choose(1)}.`,
        body: "This interpretation changes the mechanism while keeping the stated end condition fixed.",
      });
      yield contribution(request, 2, {
        kind: "interpretation",
        summary: "Read the case adversarially: identify what observation would make its premise collapse.",
        body: "A useful creation must expose its own disconfirming condition.",
      });
      return;
    }

    if (request.stage === "diverge") {
      for (let index = 0; index < 4; index += 1) {
        const strategy = choose(index + 10);
        yield contribution(request, index, {
          kind: "candidate",
          summary: `Candidate ${index + 1}: ${strategy}.`,
          body: `Apply the mechanism to ${subject}; retain it only if a concrete assay can distinguish it from the other candidates.`,
          feasibility: index === 0 ? "BUILDABLE_NOW" : index === 3 ? "LAWFUL_BUT_OPEN" : "BRIDGEABLE",
        });
      }
      return;
    }

    if (request.stage === "recombine") {
      const candidates = request.publicFacts.filter((fact) => fact.kind === "candidate");
      const parentIds = candidates.slice(0, 3).map((item) => item.id);
      yield contribution(request, 0, {
        kind: "candidate",
        summary: "Flagship recombination: couple substrate-level state with an independently testable discriminator.",
        body: "The construction may generate freely, but acceptance is compiled only from observations bound to the sealed case.",
        parentIds,
        feasibility: "BUILDABLE_NOW",
      });
      return;
    }

    if (request.stage === "challenge") {
      const flagship = [...request.publicFacts].reverse().find((fact) => fact.kind === "candidate");
      yield contribution(request, 0, {
        kind: "challenge",
        summary: "The proposal may merely rename familiar orchestration while claiming substrate-level novelty.",
        body: "Discriminate by removing visual and narrative language, then test whether the mechanism still changes behavior.",
        ...(flagship ? { parentIds: [flagship.id] } : {}),
      });
      yield contribution(request, 1, {
        kind: "test-plan",
        summary: "Replay identical sealed evidence under paraphrased preference language and compare the compiled axes.",
        body: "Any verdict change without evidence change is evaluator leakage.",
      });
      return;
    }

    if (request.stage === "reflex") {
      yield contribution(request, 0, {
        kind: "reflex",
        summary: "The current case has generated candidates, but model prose alone cannot establish that the flagship works.",
        body: "Keep judgment UNPROVEN unless an executed observation covers the critical claim.",
      });
    }
  }
}
