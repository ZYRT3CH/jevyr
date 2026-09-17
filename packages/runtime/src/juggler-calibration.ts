import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { digestJson, sha256Digest, METABOLIC_KINDS, METABOLIC_RESOURCE_KEYS, METABOLIC_WORK_FOR_KIND, assertMetabolicResourceVector, type MetabolicResourceVector, type MetabolicKind, type MetabolicInterval, type MetabolicCalibrationSummary, type JsonValue } from "@jevyr/protocol";

export interface MetabolicCalibrationAction {
  readonly id: string;
  readonly origin: "baseline" | MetabolicKind;
  readonly metric: "baseline" | "general" | "unfamiliarFamilies" | "counterbelief" | "isolatedLanes" | "scentContinuation";
  readonly family: string;
  readonly lane: string;
  readonly observationDigest: string;
}
export interface MetabolicCalibrationTrial {
  readonly seed: string;
  readonly dose: number;
  readonly trace: readonly MetabolicCalibrationAction[];
  readonly replicationTraceDigest: string;
  readonly defects: readonly { id: string; expected: "REJECT"; observed: "ACCEPT" | "REJECT" | "UNPROVEN" | "NOT_APPLICABLE" }[];
  readonly replicationDefectsDigest: string;
  readonly identicalEvidence: { evidenceDigest: string; baselineVerdictDigest: string; doseVerdictDigest: string };
  readonly observationArtifactDigests: readonly string[];
  readonly addedResourceUse: MetabolicResourceVector;
}
export interface MetabolicCalibrationReport {
  readonly protocol: "jevyr.metabolic-calibration/1";
  readonly kind: MetabolicKind;
  readonly scope: string;
  readonly implementationDigest: string;
  readonly suiteDigest: string;
  readonly confidence: 0.95;
  readonly nonInferiorityMargin: number;
  readonly trials: readonly MetabolicCalibrationTrial[];
  readonly digest: string;
}
export interface VerifiedMetabolicCalibration {
  readonly kind: MetabolicKind;
  readonly summary: MetabolicCalibrationSummary;
  readonly maximumDose: number;
  readonly implementationDigest: string;
}
const issuedCalibrations = new WeakSet<object>();

/** Boundaries, not statistical declarations, determine which implementation was measured. */
export function metabolicImplementationDigest(): string {
  const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  const component = (name: string, location: URL) => ({ name, digest: sha256Digest(readFileSync(location)) });
  // Workspace dependencies may resolve to compiled exports even when this module is TS.
  const dependencyComponent = (specifier: string, name: string) => {
    const entry = pathToFileURL(createRequire(import.meta.url).resolve(specifier));
    const dependencyExtension = entry.pathname.endsWith(".ts") ? ".ts" : ".js";
    return new URL(`./${name}${dependencyExtension}`, entry);
  };
  return digestJson({ protocol: "jevyr.metabolic-implementation/2", scope: "finite-provider-scheduler-admission-and-metering-components", components: [
    component("growth/nursery.js", dependencyComponent("@jevyr/growth", "nursery")),
    ...["metabolism", "canonical", "case-identity", "provenance"].map(name => component(`protocol/${name}.js`, dependencyComponent("@jevyr/protocol", name))),
    ...["juggler-live", "juggler-calibration", "juggler", "adaptive-search", "search-budget", "evidence-scheduler", "inertia-scent", "revision-investigation", "metabolic-reproduction", "memory-reproduction", "metabolism-replay", "orchestrator", "phenotype", "mind-metering", "capability-card", "canonical", "task-source-inspection", "adapters/prompt", "adapters/rule-mind"].map(name => component(`runtime/${name}.js`, new URL(`./${name}${extension}`, import.meta.url))),
    ...["baseline-revision", "repository-evaluation-plan", "repository-evaluation-observer", "repository-evaluation-closure", "repository-test-controller", "repository-observer-replay"].map(name => component(`runtime/${name}.js`, new URL(`./${name}${extension}`, import.meta.url))),
    component("runtime/repository-test-controller-runner.mjs", new URL("./repository-test-controller-runner.mjs", import.meta.url)),
  ] });
}
function hash(value: unknown): string { return digestJson(value as JsonValue); }
function integer(value: unknown, low: number, high: number): value is number { return Number.isSafeInteger(value) && Number(value) >= low && Number(value) <= high; }
function digest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Reflect.ownKeys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)) || Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !Object.hasOwn(entry, "value"))) throw new TypeError("Calibration contains unknown, missing or accessor fields");
}

/** Wilson 95% interval from actual Bernoulli counts; never accepts supplied CI endpoints. */
export function wilsonInterval(successes: number, total: number): MetabolicInterval {
  if (!integer(total, 1, 1_000_000) || !integer(successes, 0, total)) throw new TypeError("Wilson interval requires bounded observed counts");
  const z = 1.959963984540054;
  const p = successes / total, denominator = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator;
  return Object.freeze({ lower: Math.max(0, center - half), upper: Math.min(1, center + half), confidence: 0.95 });
}
function difference(doseSuccesses: number, doseTotal: number, baselineSuccesses: number, baselineTotal: number): MetabolicInterval {
  const dose = wilsonInterval(doseSuccesses, doseTotal), baseline = wilsonInterval(baselineSuccesses, baselineTotal);
  return Object.freeze({ lower: Math.max(-1, dose.lower - baseline.upper), upper: Math.min(1, dose.upper - baseline.lower), confidence: 0.95 });
}

/** Recompute trace metrics, recall and reproducibility from every retained paired trial. */
export function verifyMetabolicCalibration(value: unknown, expectedImplementationDigest = metabolicImplementationDigest()): VerifiedMetabolicCalibration {
  exact(value, ["protocol", "kind", "scope", "implementationDigest", "suiteDigest", "confidence", "nonInferiorityMargin", "trials", "digest"]);
  if (value.protocol !== "jevyr.metabolic-calibration/1" || !METABOLIC_KINDS.includes(value.kind as MetabolicKind) || value.confidence !== 0.95
    || value.implementationDigest !== expectedImplementationDigest || !digest(value.suiteDigest) || typeof value.scope !== "string" || value.scope.length < 8 || value.scope.length > 2048
    || typeof value.nonInferiorityMargin !== "number" || value.nonInferiorityMargin <= 0 || value.nonInferiorityMargin > 0.1
    || !Array.isArray(value.trials) || value.trials.length > 65_536) throw new TypeError("Calibration identity, scope, confidence or margin is invalid");
  const { digest: claimed, ...body } = value;
  if (hash(body) !== claimed) throw new TypeError("Calibration content digest differs");
  const report = value as unknown as MetabolicCalibrationReport;
  const pairs = new Map<string, Map<number, MetabolicCalibrationTrial>>();
  for (const trial of report.trials) {
    exact(trial, ["seed", "dose", "trace", "replicationTraceDigest", "defects", "replicationDefectsDigest", "identicalEvidence", "observationArtifactDigests", "addedResourceUse"]);
    assertMetabolicResourceVector(trial.addedResourceUse);
    if (trial.dose === 0 && METABOLIC_RESOURCE_KEYS.some((key) => trial.addedResourceUse[key] !== 0)) throw new TypeError("Dose zero claims added resource use");
    if (typeof trial.seed !== "string" || !/^[a-f0-9]{64}$/u.test(trial.seed) || !integer(trial.dose, 0, 64) || !Array.isArray(trial.trace) || trial.trace.length < 1 || trial.trace.length > 4096
      || !Array.isArray(trial.defects) || trial.defects.length < 1 || trial.defects.length > 4096 || !Array.isArray(trial.observationArtifactDigests) || trial.observationArtifactDigests.length < 1 || !trial.observationArtifactDigests.every(digest)) throw new TypeError("Calibration trial is unbounded or missing measured artifacts");
    exact(trial.identicalEvidence, ["evidenceDigest", "baselineVerdictDigest", "doseVerdictDigest"]);
    if (!Object.values(trial.identicalEvidence).every(digest) || trial.identicalEvidence.baselineVerdictDigest !== trial.identicalEvidence.doseVerdictDigest) throw new TypeError("Identical-evidence verdict changed under a metabolic dose");
    for (const action of trial.trace) {
      exact(action, ["id", "origin", "metric", "family", "lane", "observationDigest"]);
      if (typeof action.id !== "string" || action.id.length > 256 || typeof action.family !== "string" || action.family.length > 256 || typeof action.lane !== "string" || action.lane.length > 256 || !digest(action.observationDigest)
        || action.origin !== "baseline" && action.origin !== report.kind || action.metric !== (action.origin === "baseline" ? "baseline" : METABOLIC_WORK_FOR_KIND[report.kind])) throw new TypeError("Calibration trace does not describe the measured baseline or intended dose effect");
    }
    if (new Set(trial.trace.map((action) => action.id)).size !== trial.trace.length) throw new TypeError("Calibration duplicates an action identity");
    for (const result of trial.defects) {
      exact(result, ["id", "expected", "observed"]);
      if (typeof result.id !== "string" || result.id.length > 256 || result.expected !== "REJECT" || typeof result.observed !== "string" || !["ACCEPT", "REJECT", "UNPROVEN", "NOT_APPLICABLE"].includes(result.observed)) throw new TypeError("Calibration defect outcome is invalid");
    }
    if (new Set(trial.defects.map((result) => result.id)).size !== trial.defects.length) throw new TypeError("Calibration repeats a planted defect identity");
    const doses = pairs.get(trial.seed) ?? new Map<number, MetabolicCalibrationTrial>();
    if (doses.has(trial.dose)) throw new TypeError("Calibration repeats a seed-dose trial");
    doses.set(trial.dose, trial); pairs.set(trial.seed, doses);
  }
  if (pairs.size < 64) throw new TypeError("Calibration needs at least 64 complete paired seeds");
  const doses = [...pairs.values().next().value!.keys()].sort((a, b) => a - b);
  if (doses.length < 3 || doses.some((dose, index) => dose !== index)) throw new TypeError("Calibration requires contiguous doses starting at zero, including one and two");
  const counts = doses.map(() => ({ detected: 0, defects: 0, reproduced: 0, trials: 0 }));
  const maximumObservedUnitResources = Object.fromEntries(METABOLIC_RESOURCE_KEYS.map((key) => [key, 0])) as unknown as Record<typeof METABOLIC_RESOURCE_KEYS[number], number>;
  for (const paired of pairs.values()) {
    if (hash([...paired.keys()].sort((a, b) => a - b)) !== hash(doses)) throw new TypeError("Calibration cannot omit a difficult arm or seed");
    const baseline = paired.get(0)!;
    if (baseline.trace.some((action) => action.origin !== "baseline")) throw new TypeError("Dose zero contains hidden metabolic work");
    let previousMetric = 0;
    for (const dose of doses) {
      const trial = paired.get(dose)!;
      if (dose > 0) for (const key of METABOLIC_RESOURCE_KEYS) maximumObservedUnitResources[key] = Math.max(maximumObservedUnitResources[key], Math.ceil(trial.addedResourceUse[key] / dose));
      if (hash(trial.trace.slice(0, baseline.trace.length)) !== hash(baseline.trace) || trial.trace.slice(baseline.trace.length).some((action) => action.origin === "baseline")) throw new TypeError("A dose removed, replaced, reordered or duplicated baseline work");
      if (trial.identicalEvidence.evidenceDigest !== baseline.identicalEvidence.evidenceDigest || trial.identicalEvidence.baselineVerdictDigest !== baseline.identicalEvidence.baselineVerdictDigest) throw new TypeError("Paired verdict invariance did not hold evidence fixed");
      if (hash(trial.defects.map((result) => result.id)) !== hash(baseline.defects.map((result) => result.id))) throw new TypeError("Recall arms do not contain the same planted defects");
      const metric = trial.trace.filter((action) => action.metric === METABOLIC_WORK_FOR_KIND[report.kind]).length;
      if (metric !== dose || metric < previousMetric) throw new TypeError("Dose does not monotonically add its exact intended work metric");
      if (report.kind === "Refraction" || report.kind === "Fission") {
        const dimension = report.kind === "Refraction" ? "family" : "lane";
        const original = new Set(baseline.trace.map((action) => action[dimension]));
        const additions = trial.trace.slice(baseline.trace.length).map((action) => action[dimension]);
        if (new Set(additions).size !== dose || additions.some((identity) => original.has(identity))) throw new TypeError("A dose repeated a baseline or already explored family/lane");
      }
      previousMetric = metric;
      // One seed is one Bernoulli unit. Correlated mutations inside its suite
      // cannot manufacture a narrower interval by being counted independently.
      counts[dose]!.detected += Number(trial.defects.every((result) => result.observed === "REJECT"));
      counts[dose]!.defects++;
      counts[dose]!.reproduced += Number(trial.replicationTraceDigest === hash(trial.trace) && trial.replicationDefectsDigest === hash(trial.defects));
      counts[dose]!.trials++;
    }
  }
  let recallDifference: MetabolicInterval = { lower: 1, upper: -1, confidence: 0.95 }, reproducibilityDifference: MetabolicInterval = { lower: 1, upper: -1, confidence: 0.95 };
  if (counts[0]!.detected < 1 || wilsonInterval(counts[0]!.reproduced, counts[0]!.trials).lower < 0.9) throw new TypeError("Calibration baseline lacks observed defect recall or reproducibility");
  for (const dose of doses.slice(1)) {
    const count = counts[dose]!, baseline = counts[0]!;
    const recall = difference(count.detected, count.defects, baseline.detected, baseline.defects);
    const reproducibility = difference(count.reproduced, count.trials, baseline.reproduced, baseline.trials);
    if (recall.lower < -report.nonInferiorityMargin || reproducibility.lower < -report.nonInferiorityMargin) throw new TypeError("Calibration does not establish declared recall or reproducibility non-inferiority");
    recallDifference = { lower: Math.min(recallDifference.lower, recall.lower), upper: Math.max(recallDifference.upper, recall.upper), confidence: 0.95 };
    reproducibilityDifference = { lower: Math.min(reproducibilityDifference.lower, reproducibility.lower), upper: Math.max(reproducibilityDifference.upper, reproducibility.upper), confidence: 0.95 };
  }
  const verified = Object.freeze({ kind: report.kind, maximumDose: doses.at(-1)!, implementationDigest: expectedImplementationDigest,
    summary: Object.freeze({ digest: report.digest, scope: report.scope, pairedSeeds: pairs.size, doses: Object.freeze(doses), monotonic: true as const, identicalEvidenceJudgment: true as const, recallDifference: Object.freeze(recallDifference), reproducibilityDifference: Object.freeze(reproducibilityDifference), nonInferiorityMargin: report.nonInferiorityMargin, maximumObservedUnitResources: Object.freeze(maximumObservedUnitResources) }) });
  issuedCalibrations.add(verified);
  return verified;
}
export function assertVerifiedMetabolicCalibration(value: VerifiedMetabolicCalibration): void {
  if (!issuedCalibrations.has(value)) throw new TypeError("Only independently rederived metabolic calibration can authorize exposure");
}
export function metabolicCalibrationSetDigest(values: readonly VerifiedMetabolicCalibration[]): string {
  for (const value of values) assertVerifiedMetabolicCalibration(value);
  if (new Set(values.map((value) => value.kind)).size !== values.length) throw new TypeError("Calibration set repeats a kind");
  return hash({ protocol: "jevyr.metabolic-calibration-set/1", reports: [...values].map((value) => ({ kind: value.kind, digest: value.summary.digest })).sort((a, b) => a.kind.localeCompare(b.kind)) });
}
