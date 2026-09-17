import { canonicalize, type IntentContract, type JsonValue } from "@jevyr/protocol";
import type { AssayFrontier } from "./assay-frontier.js";
import { compileExperimentCapability, evaluateComparativeExperiment } from "./experiment-capability.js";
import { assessEvidenceScents, INERTIA_SCENT_POLICY, type ScentObservation } from "./inertia-scent.js";
import type { FeedbackInput } from "./revision-investigation.js";

export const BASELINE_REVISION_POLICY = Object.freeze({
  protocol: "jevyr.baseline-revision-eligibility/1",
  priority: "unresolved-critical-failure-then-comparative-socket-failure",
  comparativeScope: "exact-presealed-candidate-experiment-with-admissible-nonzero-exit",
  threshold: INERTIA_SCENT_POLICY.baselineThreshold,
  value: "two-divided-by-one-plus-prior-executed-observations-and-presealed-cost",
  ancestry: "committed-population-then-latest-revision-child",
  verdictAuthority: "none",
  inertia: "unchanged-critical-only",
} as const);
export type BaselineRevisionVersion = "legacy-critical-only" | "observed-comparative-repair";
export interface BaselineRevisionChoice {
  readonly candidateId: string;
  readonly assayId: string;
  readonly purpose: "critical-failure" | "comparative-socket-failure";
  readonly observationDigests: readonly string[];
  readonly valuePerCost: number;
  readonly verdictAuthority: "none";
}
export interface BaselineRevisionInput {
  /** Already authenticated physical inputs, never model-supplied results. */
  readonly inputs: readonly FeedbackInput[];
  readonly contract: IntentContract;
  readonly frontier: AssayFrontier;
  readonly candidateIds: readonly string[];
  readonly lastRevisionCandidateId?: string;
  readonly policyVersion: BaselineRevisionVersion | undefined;
}
const same = (left: unknown, right: unknown) => canonicalize(left as JsonValue) === canonicalize(right as JsonValue);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const history = (inputs: readonly FeedbackInput[]): readonly ScentObservation[] => inputs.map(input => ({
  candidateId: input.candidateId, assayId: input.assayId, observationDigest: input.observationDigest,
  ...(input.evaluation?.obligationId ? { obligationId: input.evaluation.obligationId } : {}),
  status: input.admissible && input.evaluation?.decisive ? input.evaluation.status : "BLOCKED",
  decisive: input.admissible && input.evaluation?.decisive === true, costUnits: input.costUnits,
}));

/** A bounded method choice. Selecting a repair does not mint an Intent edge or
 * widen the original frontier, the shared Reflex cap, or an Inertia grant. */
export function selectBaselineRevision(input: BaselineRevisionInput): BaselineRevisionChoice | undefined {
  if (input.policyVersion === undefined) return undefined;
  if (!["legacy-critical-only", "observed-comparative-repair"].includes(input.policyVersion)) throw new TypeError("Unknown baseline revision policy");
  if (input.inputs.length > INERTIA_SCENT_POLICY.maximumHistory || input.candidateIds.length > 4096
    || new Set(input.candidateIds).size !== input.candidateIds.length) throw new TypeError("Baseline revision history and population must be bounded");
  const candidates = new Set(input.candidateIds), critical = input.contract.criticalObligations.map(obligation => obligation.id);
  const eligible = (candidateId: string) => candidates.has(candidateId) && (!input.lastRevisionCandidateId || candidateId === input.lastRevisionCandidateId);
  const fullySupported = [...new Set(input.inputs.map(item => item.candidateId))].some(candidateId => critical.length > 0
    && critical.every(id => input.inputs.some(item => item.candidateId === candidateId && item.admissible && item.evaluation?.obligationId === id && item.evaluation.status === "PASSED")));
  if (!fullySupported) {
    const scent = assessEvidenceScents(history(input.inputs), critical).find(item => item.valuePerCost >= BASELINE_REVISION_POLICY.threshold && eligible(item.candidateId));
    if (scent) return Object.freeze({ candidateId: scent.candidateId, assayId: scent.assayId, purpose: "critical-failure",
      observationDigests: scent.observationDigests, valuePerCost: scent.valuePerCost, verdictAuthority: "none" });
  }
  if (input.policyVersion === "legacy-critical-only") return undefined;
  // Recompile the allowed sockets from the sealed contract/frontier. Merely
  // naming an evaluation ID absent from the critical set is not sufficient.
  const capability = compileExperimentCapability(input.frontier, input.contract);
  const experiments = new Map(capability.experiments.filter(experiment => experiment.authority === "comparative-only").map(experiment => [experiment.assayId, experiment]));
  const groups = new Map<string, FeedbackInput[]>();
  for (const item of input.inputs) {
    if (!eligible(item.candidateId) || !experiments.has(item.assayId)) continue;
    const key = canonicalize([item.candidateId, item.assayId]), group = groups.get(key) ?? [];
    group.push(item); groups.set(key, group);
  }
  const choices: BaselineRevisionChoice[] = [];
  for (const group of groups.values()) {
    const latest = group.at(-1)!, experiment = experiments.get(latest.assayId)!;
    const checked = (item: FeedbackInput): boolean => {
      if (!item.admissible || !item.evaluation?.decisive || !item.observation.oracle || item.costUnits !== experiment.costUnits) return false;
      const replayed = evaluateComparativeExperiment(experiment, item.observation.oracle);
      return replayed.decisive && same(replayed, item.evaluation);
    };
    // A later pass or blocked/invalid observation cannot be hidden behind an
    // earlier failure. Only an actually exited, currently failed socket qualifies.
    if (!checked(latest) || latest.evaluation?.status !== "FAILED") continue;
    const observations = group.filter(checked), digests = [...new Set(observations.map(item => item.observationDigest))];
    const valuePerCost = 2 / (1 + digests.length) / experiment.costUnits;
    if (valuePerCost < BASELINE_REVISION_POLICY.threshold) continue;
    choices.push(Object.freeze({ candidateId: latest.candidateId, assayId: latest.assayId, purpose: "comparative-socket-failure",
      observationDigests: Object.freeze(digests), valuePerCost, verdictAuthority: "none" }));
  }
  return choices.sort((left, right) => right.valuePerCost - left.valuePerCost || compare(left.candidateId, right.candidateId) || compare(left.assayId, right.assayId))[0];
}
