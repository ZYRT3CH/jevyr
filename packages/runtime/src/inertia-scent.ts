import { assertMetabolicReceipt, canonicalize, digestJson, type JsonValue, type MetabolicReceipt } from "@jevyr/protocol";

export const INERTIA_SCENT_POLICY = Object.freeze({ protocol: "jevyr.inertia-scent-policy/1", measurement: "HEURISTIC", baselineThreshold: 0.5, lowering: "baseline-threshold-divided-by-one-plus-cumulative-inertia", value: "critical-signal-divided-by-observed-attempts-and-presealed-cost", minimumExecutedObservations: 1, maximumHistory: 4096, maximumQuantity: 64, preservesBaseline: true, verdictAuthority: "none" });
export interface ScentObservation {
  readonly candidateId: string;
  readonly observationDigest: string;
  readonly assayId: string;
  readonly obligationId?: string;
  readonly status: "PASSED" | "FAILED" | "BLOCKED";
  readonly decisive: boolean;
  readonly costUnits: number;
}
export interface EvidenceScent {
  readonly candidateId: string;
  readonly assayId: string;
  readonly obligationId: string;
  readonly observationDigests: readonly string[];
  readonly executedObservations: number;
  readonly costUnits: number;
  readonly valuePerCost: number;
  readonly measurement: "HEURISTIC";
}
export interface InertiaContinuationDecision {
  readonly protocol: "jevyr.inertia-continuation/1";
  readonly receiptDigest: string;
  readonly caseDigest: string;
  readonly runDigest: string;
  readonly quantity: number;
  readonly cumulativeDose: number;
  readonly baselineThreshold: number;
  readonly loweredThreshold: number;
  readonly criticalObligationIds: readonly string[];
  readonly history: readonly ScentObservation[];
  readonly historyDigest: string;
  readonly excludedCandidateIds: readonly string[];
  readonly selected: readonly EvidenceScent[];
  readonly measurement: "HEURISTIC";
  readonly baselineUnchanged: true;
  readonly verdictAuthority: "none";
  readonly digest: string;
}
const SHA = /^sha256:[a-f0-9]{64}$/u;
const boundedId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
function captureHistory(history: readonly ScentObservation[], critical: readonly string[]): readonly ScentObservation[] {
  if (!Array.isArray(history) || history.length > INERTIA_SCENT_POLICY.maximumHistory || !Array.isArray(critical) || critical.length > 256 || critical.some(id => !boundedId(id)) || new Set(critical).size !== critical.length) throw new TypeError("Inertia requires bounded observed history and sealed critical identities");
  const observations = new Map<string, ScentObservation>();
  for (const input of history) {
    if (!input || typeof input !== "object" || Object.keys(input).some(key => !["candidateId", "observationDigest", "assayId", "obligationId", "status", "decisive", "costUnits"].includes(key)) || !boundedId(input.candidateId) || !SHA.test(input.observationDigest) || !boundedId(input.assayId) || input.obligationId !== undefined && !boundedId(input.obligationId) || !["PASSED", "FAILED", "BLOCKED"].includes(input.status) || typeof input.decisive !== "boolean" || !Number.isSafeInteger(input.costUnits) || input.costUnits < 1 || input.costUnits > 1_000_000_000) throw new TypeError("Inertia history must contain exact finite tool observations");
    const copied = Object.freeze({ ...input });
    const previous = observations.get(input.observationDigest);
    if (previous && canonicalize(previous as unknown as JsonValue) !== canonicalize(copied as unknown as JsonValue)) throw new TypeError("An Inertia observation digest has inconsistent bindings");
    observations.set(input.observationDigest, copied);
  }
  return Object.freeze([...observations.values()]);
}

/** Method estimate from physical probe history, never a verdict probability or authority edge. */
export function assessEvidenceScents(history: readonly ScentObservation[], criticalObligationIds: readonly string[]): readonly EvidenceScent[] {
  const captured = captureHistory(history, criticalObligationIds), critical = new Set(criticalObligationIds);
  const groups = new Map<string, ScentObservation[]>();
  for (const observation of captured) {
    if (!observation.obligationId || !critical.has(observation.obligationId)) continue;
    const key = canonicalize([observation.candidateId, observation.assayId, observation.obligationId]);
    const group = groups.get(key) ?? []; group.push(observation); groups.set(key, group);
  }
  const scents: EvidenceScent[] = [];
  for (const group of groups.values()) {
    const executed = group.filter(value => value.status !== "BLOCKED"), latest = executed.at(-1);
    if (!latest || latest.status === "PASSED" && latest.decisive) continue;
    const signal = latest.status === "FAILED" && latest.decisive ? 2 : 1;
    const valuePerCost = signal / (1 + executed.length) / latest.costUnits;
    scents.push(Object.freeze({ candidateId: latest.candidateId, assayId: latest.assayId, obligationId: latest.obligationId!, observationDigests: Object.freeze(executed.map(value => value.observationDigest)), executedObservations: executed.length, costUnits: latest.costUnits, valuePerCost, measurement: "HEURISTIC" }));
  }
  return Object.freeze(scents.sort((left, right) => right.valuePerCost - left.valuePerCost || left.candidateId.localeCompare(right.candidateId) || left.assayId.localeCompare(right.assayId)));
}

function selectedScents(history: readonly ScentObservation[], critical: readonly string[], cumulativeDose: number, quantity: number, excluded: readonly string[]): readonly EvidenceScent[] {
  const threshold = INERTIA_SCENT_POLICY.baselineThreshold / (1 + cumulativeDose);
  const seen = new Set(excluded);
  return Object.freeze(assessEvidenceScents(history, critical).filter(scent => {
    if (seen.has(scent.candidateId) || scent.valuePerCost >= INERTIA_SCENT_POLICY.baselineThreshold || scent.valuePerCost < threshold) return false;
    seen.add(scent.candidateId); return true;
  }).slice(0, quantity));
}

/** Offers only quantities for which every smaller selectable dose is also fulfillable. */
export function maximumInertiaQuantity(history: readonly ScentObservation[], critical: readonly string[], cumulativeDose = 0, maximumAdditional = 64, excluded: readonly string[] = []): number {
  if (!Number.isSafeInteger(cumulativeDose) || cumulativeDose < 0 || cumulativeDose > 64 || !Number.isSafeInteger(maximumAdditional) || maximumAdditional < 0 || maximumAdditional > 64 || !Array.isArray(excluded) || excluded.length > 4096 || excluded.some(id => !boundedId(id))) throw new TypeError("Inertia quantities and exclusions must be bounded");
  let available = 0;
  for (let quantity = 1; quantity <= Math.min(maximumAdditional, 64 - cumulativeDose); quantity++) {
    if (selectedScents(history, critical, cumulativeDose + quantity, quantity, excluded).length !== quantity) break;
    available = quantity;
  }
  return available;
}

/** Requires a previously authenticated/admitted receipt; the returned plan cannot authorize tools. */
export function planInertiaContinuation(receipt: MetabolicReceipt, history: readonly ScentObservation[], critical: readonly string[], excluded: readonly string[] = []): InertiaContinuationDecision {
  assertMetabolicReceipt(receipt);
  if (receipt.kind !== "Inertia") throw new TypeError("An Inertia continuation requires an Inertia receipt");
  const cumulativeDose = receipt.cumulativeQuantities.Inertia, priorDose = cumulativeDose - receipt.quantity;
  if (maximumInertiaQuantity(history, critical, priorDose, receipt.quantity, excluded) < receipt.quantity) throw new Error("No sufficient below-threshold physical evidence scents can fulfill this Inertia dose");
  const captured = captureHistory(history, critical);
  const body = { protocol: "jevyr.inertia-continuation/1" as const, receiptDigest: receipt.digest, caseDigest: receipt.caseDigest, runDigest: receipt.runDigest, quantity: receipt.quantity, cumulativeDose, baselineThreshold: INERTIA_SCENT_POLICY.baselineThreshold, loweredThreshold: INERTIA_SCENT_POLICY.baselineThreshold / (1 + cumulativeDose), criticalObligationIds: Object.freeze([...critical].sort()), history: captured, historyDigest: digestJson(captured as unknown as JsonValue), excludedCandidateIds: Object.freeze([...new Set(excluded)].sort()), selected: selectedScents(captured, critical, cumulativeDose, receipt.quantity, excluded), measurement: "HEURISTIC" as const, baselineUnchanged: true as const, verdictAuthority: "none" as const };
  return Object.freeze({ ...body, digest: digestJson(body as unknown as JsonValue) });
}

export function assertInertiaContinuationDecision(value: InertiaContinuationDecision, receipt: MetabolicReceipt, history: readonly ScentObservation[], critical: readonly string[], excluded: readonly string[] = []): void {
  const expected = planInertiaContinuation(receipt, history, critical, excluded);
  if (canonicalize(value as unknown as JsonValue) !== canonicalize(expected as unknown as JsonValue)) throw new TypeError("Inertia decision differs from its signed dose and physical history");
}
