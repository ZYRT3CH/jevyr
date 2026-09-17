import { digestJson, type IntentContract, type JsonValue } from "@jevyr/protocol";
import type { SealedAssayPlan } from "./assay-frontier.js";
import type { ExperimentCapability } from "./experiment-capability.js";
import type { InvestigationPhenotype } from "./phenotype.js";

export const EVIDENCE_SCHEDULER_POLICY = Object.freeze({ protocol: "jevyr.evidence-value-scheduler/1", authority: "method-only", estimate: "coverage-and-cost-heuristic-not-calibrated-probability", preservesBaseline: true });
export interface InvestigationCell { readonly candidateId: string; readonly plan: SealedAssayPlan }
export interface SchedulerObservation { readonly candidateId: string; readonly assayId: string; readonly obligationId?: string; readonly decisive: boolean; readonly outcome: "PASSED" | "FAILED" | "BLOCKED"; readonly costUnits: number }
export interface EvidenceSchedulingDecision {
  readonly protocol: "jevyr.evidence-scheduling-decision/1";
  readonly candidateId: string;
  readonly assayId: string;
  readonly family: string;
  readonly obligationId: string | null;
  readonly predictedCoverageValue: number;
  readonly costUnits: number;
  readonly valuePerCost: number;
  readonly measurement: "HEURISTIC";
  readonly observedDecisive: number;
  readonly remainingCells: number;
  readonly phenotypeDigest: string;
  readonly digest: string;
}

export function assayFamily(plan: SealedAssayPlan): string {
  if (plan.requestedAssay) return "requested-assay";
  if (plan.sealedTestSuite) return "sealed-test-suite";
  if (plan.sealedSubjectDigest) return "sealed-subject";
  return plan.obligationId ? "intent-command" : "comparative-command";
}

/** Picks only an existing sealed cell. Neither model prose nor heuristic scores are evidence. */
export class EvidenceValueScheduler {
  readonly #pending: InvestigationCell[];
  readonly #observations: SchedulerObservation[] = [];
  readonly #critical: ReadonlySet<string>;
  readonly #experiments: ExperimentCapability;
  readonly #phenotype: InvestigationPhenotype;
  constructor(candidates: readonly string[], plans: readonly SealedAssayPlan[], contract: IntentContract, experiments: ExperimentCapability, phenotype: InvestigationPhenotype) {
    this.#pending = [...candidates].sort().flatMap(candidateId => plans.map(plan => ({ candidateId, plan })));
    this.#critical = new Set(contract.criticalObligations.map(obligation => obligation.id));
    this.#experiments = experiments;
    this.#phenotype = phenotype;
  }
  get remaining(): number { return this.#pending.length; }
  observe(observation: SchedulerObservation): void { this.#observations.push(Object.freeze({ ...observation })); }
  next(): { readonly cell: InvestigationCell; readonly decision: EvidenceSchedulingDecision } | undefined {
    const scored = this.#pending.map((cell, index) => {
      const obligationId = cell.plan.obligationId ?? this.#experiments.experiments.find(experiment => experiment.assayId === cell.plan.assayId)?.obligationId;
      const family = assayFamily(cell.plan);
      const decisive = this.#observations.filter(observation => observation.decisive);
      const covered = decisive.some(observation => observation.candidateId === cell.candidateId && observation.obligationId === obligationId);
      const failedCandidate = decisive.some(observation => observation.candidateId === cell.candidateId && observation.outcome === "FAILED");
      const crossCandidateContradiction = obligationId !== undefined && decisive.some(observation => observation.obligationId === obligationId && observation.outcome === "FAILED" && observation.candidateId !== cell.candidateId);
      const familyObserved = this.#observations.some(observation => observation.assayId === cell.plan.assayId);
      const criticalValue = obligationId && this.#critical.has(obligationId) && !covered ? this.#phenotype.scheduler.criticalWeight : 1;
      const predictedCoverageValue = (criticalValue + (familyObserved ? 0 : this.#phenotype.scheduler.noveltyWeight) + (crossCandidateContradiction ? this.#phenotype.scheduler.contradictionWeight : 0)) / (failedCandidate ? 4 : 1);
      const valuePerCost = predictedCoverageValue / Math.pow(Math.max(1, cell.plan.costUnits), this.#phenotype.scheduler.costExponent);
      const familyRank = this.#phenotype.portfolio.indexOf(family);
      return { cell, index, obligationId: obligationId ?? null, family, predictedCoverageValue, valuePerCost, familyRank: familyRank < 0 ? Number.MAX_SAFE_INTEGER : familyRank };
    }).sort((a, b) => b.valuePerCost - a.valuePerCost || a.familyRank - b.familyRank || a.cell.candidateId.localeCompare(b.cell.candidateId) || a.cell.plan.assayId.localeCompare(b.cell.plan.assayId));
    const selected = scored[0];
    if (!selected) return undefined;
    this.#pending.splice(selected.index, 1);
    const body = { protocol: "jevyr.evidence-scheduling-decision/1" as const, candidateId: selected.cell.candidateId, assayId: selected.cell.plan.assayId, family: selected.family, obligationId: selected.obligationId, predictedCoverageValue: selected.predictedCoverageValue, costUnits: selected.cell.plan.costUnits, valuePerCost: selected.valuePerCost, measurement: "HEURISTIC" as const, observedDecisive: this.#observations.filter(observation => observation.decisive).length, remainingCells: this.#pending.length, phenotypeDigest: this.#phenotype.digest };
    return { cell: selected.cell, decision: Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) }) };
  }
}
