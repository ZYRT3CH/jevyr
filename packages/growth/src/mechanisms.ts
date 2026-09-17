import type { MechanismIntakeRecord } from "./types.js";

const NOT_RUN = Object.freeze({
  status: "not_run" as const,
  evidenceDigests: Object.freeze([]),
});
const NO_BENCHMARK = Object.freeze({
  resultDigests: Object.freeze([]),
});

/**
 * Citations enter Jevyr as falsifiable intake records, never as authority.
 * Nothing is ADOPTED until its reproduction and paired benchmark have evidence.
 */
export const MECHANISM_INTAKE: readonly MechanismIntakeRecord[] = Object.freeze([
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "aims-typed-uncertainty",
    source: {
      uri: "https://arxiv.org/abs/2607.16544",
      version: "arXiv:2607.16544",
    },
    domainAssumptions: [
      "uncertainty has distinguishable origins",
      "candidate mechanisms can be separated by corrective experiments",
    ],
    proposedTransfer:
      "Represent uncertainty by origin and require a discriminating action instead of a confidence adjective.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "apeiron-trace-binding",
    source: {
      uri: "https://aclanthology.org/2026.findings-acl.188/",
      version: "Findings of ACL 2026",
    },
    domainAssumptions: [
      "builder and evaluator can be isolated",
      "behavior can be rebound to component and source traces",
    ],
    proposedTransfer:
      "Keep builders and evaluators independent and bind observed behavior through trace to responsible source.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "ald-deterministic-shell",
    source: {
      uri: "https://arxiv.org/abs/2601.09980",
      version: "arXiv:2601.09980",
    },
    domainAssumptions: [
      "model behavior is stochastic",
      "experimental initial conditions can be recorded and replayed",
    ],
    proposedTransfer:
      "Place stochastic proposals inside a deterministic seeded shell; expose cross-seed variance, anchoring, and memory contamination.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "map-elites-case-archive",
    source: {
      uri: "https://arxiv.org/abs/1504.04909",
      version: "arXiv:1504.04909",
    },
    domainAssumptions: [
      "behavior descriptors are measurable",
      "local niche competition preserves useful diversity",
    ],
    proposedTransfer:
      "Retain Pareto survivors across independent semantic, mechanism, causal, and implementation niches.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "poet-coevolved-challenges",
    source: {
      uri: "https://arxiv.org/abs/1901.01753",
      version: "arXiv:1901.01753",
    },
    domainAssumptions: [
      "problems and solutions admit compatible encodings",
      "solutions can transfer between generated environments",
    ],
    proposedTransfer:
      "Allow surviving candidates to provoke discriminating challenges and transfer stepping stones between niches.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "dgm-direct-self-edit",
    source: {
      uri: "https://arxiv.org/abs/2505.22954",
      version: "arXiv:2505.22954",
    },
    domainAssumptions: [
      "agent source can be safely modified and empirically validated",
      "benchmarks adequately represent net benefit",
    ],
    proposedTransfer:
      "Do not transfer direct modification of the active organism; the Soma cannot rewrite Bone or itself.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "REJECTED",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "dgm-lineage-archive",
    source: {
      uri: "https://arxiv.org/abs/2505.22954",
      version: "arXiv:2505.22954",
    },
    domainAssumptions: [
      "diverse descendants can retain useful stepping stones",
      "empirical validation can compare descendants",
    ],
    proposedTransfer:
      "Borrow only the lineage archive: descendants are quarantined values and never replace a running organism.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "nca-homeostatic-damage",
    source: {
      uri: "https://distill.pub/2020/growing-ca/",
      version: "doi:10.23915/distill.00023",
    },
    domainAssumptions: [
      "local update rules can converge toward a stable morphology",
      "damage exposure can broaden a basin of attraction",
    ],
    proposedTransfer:
      "Translate damage exposure into corruption, tool-loss, resource-loss, and adversarial-input trials for descendants.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "funsearch-island-evolution",
    source: {
      uri: "https://www.nature.com/articles/s41586-023-06924-6",
      version: "Nature 625 (2024)",
    },
    domainAssumptions: [
      "candidates are executable programs",
      "an evaluator can score correctness automatically",
    ],
    proposedTransfer:
      "Use isolated islands and asynchronous embodiment only where executable discriminators exist.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
  {
    protocol: "jevyr.mechanism-intake/1",
    id: "modes-open-ended-measurement",
    source: {
      uri: "https://direct.mit.edu/artl/article/25/1/50/2915/The-MODES-Toolbox-Measurements-of-Open-Ended",
      version: "Artificial Life 25(1), 2019",
    },
    domainAssumptions: [
      "open-ended dynamics require longitudinal rather than anecdotal measurement",
    ],
    proposedTransfer:
      "Measure change, novelty, complexity, and ecological potential separately; never call endless execution growth.",
    reproduction: NOT_RUN,
    benchmark: NO_BENCHMARK,
    status: "EXPERIMENTAL",
  },
]);

export function mechanismById(id: string): MechanismIntakeRecord | undefined {
  return MECHANISM_INTAKE.find((record) => record.id === id);
}
