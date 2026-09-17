import type { KeyObject } from "node:crypto";
import { decodeDsseJson, signJsonDsse, verifyDsse } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, type DsseEnvelope, type JsonValue } from "@jevyr/protocol";
import type { GenomeRuntimeProfile } from "./genome-compiler.js";

export const GENOME_BENCHMARK_PROTOCOL = "jevyr.genome-benchmark/2" as const;
export const GENOME_BENCHMARK_PAYLOAD_TYPE = "application/vnd.jevyr.genome-benchmark+json";
export const GENOME_METRICS = ["defectRecall", "falseAccusations", "unprovenRate", "reproducibility", "coverage", "wallMillis", "tokens", "laneCorrelation", "marginalEvidenceValue"] as const;
export type GenomeMetric = typeof GENOME_METRICS[number];
export interface BenchmarkMetric {
  readonly value: number | null;
  readonly interval95: readonly [number, number] | null;
  readonly observations: number;
  readonly method: "descriptive-rate" | "descriptive-mean" | "unmeasured";
  readonly reason: string | null;
}
export interface PairedBenchmarkConfiguration {
  readonly configurationDigest: string;
  readonly genomeDigest: string;
  readonly runtimeProfile: GenomeRuntimeProfile;
}
export interface PairedGenomeTrial {
  readonly caseKey: string;
  readonly corpusDigest: string;
  readonly subjectDigest: string;
  readonly seedDigest: string;
  readonly providerSnapshotDigest: string;
  readonly configurationDigest: string;
  readonly repeat: number;
  readonly recordDigest: string;
  readonly evidenceDigest: string;
  /** Independently derived exact physical command-result multiset, excluding run IDs and clocks. */
  readonly physicalObservationDigest: string | null;
  readonly replayDigest: string;
  readonly replayVerified: true;
  readonly judgment: "ACCEPT" | "REJECT" | "UNPROVEN" | "INVALID";
  /** Ground-truth labels come from the predeclared corpus, never from a Mind. */
  readonly criticalDefectIds: readonly string[];
  readonly reproducedDefectIds: readonly string[];
  readonly accusedDefectIds: readonly string[];
  readonly clean: boolean;
  readonly coverage: { readonly covered: number; readonly eligible: number } | null;
  readonly cost: { readonly wallMillis: number; readonly inputTokens: number; readonly outputTokens: number } | null;
  /** Comparable finite finding vectors; constant vectors have undefined correlation. */
  readonly lanes: readonly { readonly laneId: string; readonly familyId: string; readonly findings: readonly boolean[] }[];
  readonly marginal: { readonly additionalDecisiveEvidence: number; readonly additionalCostUnits: number } | null;
}
export interface GenomeBenchmarkReport {
  readonly protocol: typeof GENOME_BENCHMARK_PROTOCOL;
  readonly corpusDigest: string;
  readonly configurations: readonly PairedBenchmarkConfiguration[];
  readonly trials: readonly PairedGenomeTrial[];
  readonly pairedKeys: number;
  readonly results: readonly { readonly configurationDigest: string; readonly metrics: Readonly<Record<GenomeMetric, BenchmarkMetric>> }[];
  readonly pareto: readonly string[];
  readonly limitations: readonly string[];
  readonly digest: string;
}
export interface SignedGenomeBenchmark { readonly report: GenomeBenchmarkReport; readonly attestation: DsseEnvelope }

const json = (value: unknown) => value as JsonValue;
function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`${label} must be a bounded integer`);
}
function digest(value: unknown, label: string): asserts value is string {
  if (!isSha256Digest(value)) throw new TypeError(`${label} must be a SHA-256 digest`);
}
function ids(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 1024 || new Set(value).size !== value.length || value.some(item => typeof item !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(item))) throw new TypeError(`${label} must contain unique finite identifiers`);
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export function validateBenchmarkConfiguration(raw: unknown): PairedBenchmarkConfiguration {
  const value = exact(raw, ["configurationDigest", "genomeDigest", "runtimeProfile"], "Benchmark configuration");
  digest(value.configurationDigest, "configurationDigest"); digest(value.genomeDigest, "genomeDigest");
  const profile = exact(value.runtimeProfile, ["protocol", "profileDigest", "sourceGenomeDigest", "boneDigest", "generation", "enabledModules", "nursery", "archive", "lateMemory"], "Runtime profile");
  if (profile.protocol !== "jevyr.genome-runtime-profile/1" || profile.sourceGenomeDigest !== value.genomeDigest) throw new TypeError("Benchmark configuration has no exact source Genome");
  digest(profile.boneDigest, "boneDigest"); digest(profile.profileDigest, "profileDigest"); integer(profile.generation, "generation");
  ids(profile.enabledModules, "enabledModules");
  if (profile.enabledModules.some(id => !["jevyr.nursery-governor", "jevyr.archive-curator", "jevyr.late-memory-gate"].includes(id))) throw new TypeError("Preset contains a non-built-in Genome module");
  const nursery = exact(profile.nursery, ["saturationWindow", "challengeInterval"], "Nursery knobs");
  integer(nursery.saturationWindow, "saturationWindow", 8, 4096); integer(nursery.challengeInterval, "challengeInterval", 1, 256);
  const archive = exact(profile.archive, ["capacity", "minimumNovelty"], "Archive knobs");
  integer(archive.capacity, "capacity", 8, 4096);
  if (typeof archive.minimumNovelty !== "number" || !Number.isFinite(archive.minimumNovelty) || archive.minimumNovelty < 0.01 || archive.minimumNovelty > 1) throw new TypeError("Invalid preset novelty threshold");
  const memory = exact(profile.lateMemory, ["recallLimit", "weight"], "Late memory knobs");
  integer(memory.recallLimit, "recallLimit", 0, 32);
  if (typeof memory.weight !== "number" || !Number.isFinite(memory.weight) || memory.weight < 0 || memory.weight > 0.2) throw new TypeError("Invalid preset late memory weight");
  const { profileDigest: ignored, ...body } = profile;
  if (ignored !== digestJson(json(body)) || value.configurationDigest !== digestJson(json({ genomeDigest: value.genomeDigest, runtimeProfile: profile }))) throw new TypeError("Benchmark configuration digest mismatch");
  return freeze(structuredClone(value)) as unknown as PairedBenchmarkConfiguration;
}

function validateTrial(raw: unknown): PairedGenomeTrial {
  const value = exact(raw, ["caseKey", "corpusDigest", "subjectDigest", "seedDigest", "providerSnapshotDigest", "configurationDigest", "repeat", "recordDigest", "evidenceDigest", "physicalObservationDigest", "replayDigest", "replayVerified", "judgment", "criticalDefectIds", "reproducedDefectIds", "accusedDefectIds", "clean", "coverage", "cost", "lanes", "marginal"], "Paired trial");
  if (typeof value.caseKey !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(value.caseKey)) throw new TypeError("Invalid paired case key");
  for (const key of ["corpusDigest", "subjectDigest", "seedDigest", "providerSnapshotDigest", "configurationDigest", "recordDigest", "evidenceDigest", "replayDigest"]) digest(value[key], key);
  if (value.physicalObservationDigest !== null) digest(value.physicalObservationDigest, "physicalObservationDigest");
  integer(value.repeat, "repeat", 0, 64);
  if (value.replayVerified !== true || !["ACCEPT", "REJECT", "UNPROVEN", "INVALID"].includes(String(value.judgment))) throw new TypeError("Benchmark trial requires verified replay and a finite verdict");
  for (const key of ["criticalDefectIds", "reproducedDefectIds", "accusedDefectIds"]) ids(value[key], key);
  if (typeof value.clean !== "boolean" || value.clean && (value.criticalDefectIds as string[]).length !== 0) throw new TypeError("Clean ground truth contradicts its defect labels");
  if ((value.reproducedDefectIds as string[]).some(id => !(value.accusedDefectIds as string[]).includes(id))) throw new TypeError("Reproduced defect must occur in the binding accusation set");
  if (value.coverage !== null) {
    const coverage = exact(value.coverage, ["covered", "eligible"], "Coverage");
    integer(coverage.eligible, "eligible", 1); integer(coverage.covered, "covered", 0, coverage.eligible as number);
  }
  if (value.cost !== null) {
    const cost = exact(value.cost, ["wallMillis", "inputTokens", "outputTokens"], "Cost");
    for (const key of ["wallMillis", "inputTokens", "outputTokens"]) integer(cost[key], key);
    integer((cost.inputTokens as number) + (cost.outputTokens as number), "combined tokens");
  }
  if (!Array.isArray(value.lanes) || value.lanes.length > 256) throw new TypeError("Invalid lane observations");
  const laneIds = new Set(); let vectorLength: number | undefined;
  for (const rawLane of value.lanes) {
    const lane = exact(rawLane, ["laneId", "familyId", "findings"], "Lane");
    ids([lane.laneId], "Lane identity"); ids([lane.familyId], "Lane family identity");
    if (laneIds.has(lane.laneId) || !Array.isArray(lane.findings) || lane.findings.length > 1024 || lane.findings.some(value => typeof value !== "boolean") || vectorLength !== undefined && vectorLength !== lane.findings.length) throw new TypeError("Lane vectors are not unique and comparable");
    laneIds.add(lane.laneId); vectorLength = lane.findings.length;
  }
  if (value.marginal !== null) {
    const marginal = exact(value.marginal, ["additionalDecisiveEvidence", "additionalCostUnits"], "Marginal evidence");
    integer(marginal.additionalDecisiveEvidence, "additionalDecisiveEvidence"); integer(marginal.additionalCostUnits, "additionalCostUnits", 1);
  }
  return freeze(structuredClone(value)) as unknown as PairedGenomeTrial;
}

const unmeasured = (reason: string): BenchmarkMetric => ({ value: null, interval95: null, observations: 0, method: "unmeasured", reason });
function rate(successes: number, total: number, reason: string): BenchmarkMetric {
  if (!total) return unmeasured(reason);
  return { value: successes / total, interval95: null, observations: total, method: "descriptive-rate", reason: "Recorded fixture frequencies only; repeated trials are not independent population samples" };
}
function mean(values: readonly number[], reason: string): BenchmarkMetric {
  if (!values.length) return unmeasured(reason);
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return { value: average, interval95: null, observations: values.length, method: "descriptive-mean", reason: "Recorded fixture average only; no independence or inferential confidence interval is asserted" };
}
function correlation(left: readonly boolean[], right: readonly boolean[]): number | undefined {
  if (left.length < 2 || left.length !== right.length) return undefined;
  const l = left.filter(Boolean).length / left.length, r = right.filter(Boolean).length / right.length;
  const denominator = Math.sqrt(l * (1 - l) * r * (1 - r));
  if (denominator === 0) return undefined;
  return (left.reduce((sum, value, index) => sum + Number(value) * Number(right[index]), 0) / left.length - l * r) / denominator;
}
const pairKey = (trial: PairedGenomeTrial) => canonicalize(json([trial.caseKey, trial.seedDigest, trial.providerSnapshotDigest, trial.repeat]));
function metrics(trials: readonly PairedGenomeTrial[]): Readonly<Record<GenomeMetric, BenchmarkMetric>> {
  const clean = trials.filter(trial => trial.clean), repeats = new Map<string, PairedGenomeTrial[]>(), laneCorrelations: number[] = [];
  let defects = 0, reproduced = 0;
  for (const trial of trials) {
    defects += trial.criticalDefectIds.length;
    reproduced += trial.criticalDefectIds.filter(id => trial.reproducedDefectIds.includes(id)).length;
    const key = canonicalize(json([trial.caseKey, trial.seedDigest, trial.providerSnapshotDigest]));
    const group = repeats.get(key) ?? []; group.push(trial); repeats.set(key, group);
    for (let l = 0; l < trial.lanes.length; l++) for (let r = l + 1; r < trial.lanes.length; r++) {
      if (trial.lanes[l]!.familyId === trial.lanes[r]!.familyId) continue;
      const value = correlation(trial.lanes[l]!.findings, trial.lanes[r]!.findings); if (value !== undefined) laneCorrelations.push(value);
    }
  }
  const repeatGroups = [...repeats.values()].filter(group => group.length > 1);
  const repeatComparisons = repeatGroups.map(group => group.every(trial => trial.physicalObservationDigest === group[0]!.physicalObservationDigest && trial.judgment === group[0]!.judgment));
  return {
    defectRecall: rate(reproduced, defects, "No predeclared critical defects"),
    falseAccusations: rate(clean.filter(trial => trial.judgment === "REJECT" || trial.accusedDefectIds.length > 0).length, clean.length, "No predeclared clean cases"),
    unprovenRate: rate(trials.filter(trial => trial.judgment === "UNPROVEN").length, trials.length, "No trials"),
    reproducibility: repeatGroups.some(group => group.some(trial => trial.physicalObservationDigest === null)) ? unmeasured("Repeated trials lack complete authenticated physical command observations") : rate(repeatComparisons.filter(Boolean).length, repeatComparisons.length, "No repeated identical seed/provider/configuration trials"),
    coverage: trials.some(trial => !trial.coverage) ? unmeasured("Coverage is absent for one or more trials") : mean(trials.map(trial => trial.coverage!.covered / trial.coverage!.eligible), "Coverage was not measured"),
    wallMillis: trials.some(trial => !trial.cost) ? unmeasured("Cost is absent for one or more trials") : mean(trials.map(trial => trial.cost!.wallMillis), "Execution wall cost was not measured"),
    tokens: trials.some(trial => !trial.cost) ? unmeasured("Cost is absent for one or more trials") : mean(trials.map(trial => trial.cost!.inputTokens + trial.cost!.outputTokens), "Token cost was not measured"),
    laneCorrelation: mean(laneCorrelations, "No nonconstant cross-family lane pairs"),
    marginalEvidenceValue: trials.some(trial => !trial.marginal) ? unmeasured("Marginal evidence/cost is absent for one or more trials") : mean(trials.map(trial => trial.marginal!.additionalDecisiveEvidence / trial.marginal!.additionalCostUnits), "No measured marginal evidence/cost pairs"),
  };
}

export function compileGenomeBenchmark(configurationsInput: readonly PairedBenchmarkConfiguration[], trialsInput: readonly PairedGenomeTrial[]): GenomeBenchmarkReport {
  if (!Array.isArray(configurationsInput) || configurationsInput.length < 2 || configurationsInput.length > 16 || !Array.isArray(trialsInput) || trialsInput.length < 4 || trialsInput.length > 2048) throw new TypeError("A paired benchmark requires 2–16 configurations and 4–2048 trial observations");
  const configurations = configurationsInput.map(validateBenchmarkConfiguration).sort((a, b) => a.configurationDigest.localeCompare(b.configurationDigest));
  if (new Set(configurations.map(config => config.configurationDigest)).size !== configurations.length) throw new TypeError("Duplicate benchmark configuration");
  const trials = trialsInput.map(validateTrial).sort((a, b) => pairKey(a).localeCompare(pairKey(b)) || a.configurationDigest.localeCompare(b.configurationDigest));
  const corpusDigest = trials[0]!.corpusDigest, groups = new Map<string, PairedGenomeTrial[]>();
  for (const trial of trials) {
    if (trial.corpusDigest !== corpusDigest || !configurations.some(config => config.configurationDigest === trial.configurationDigest)) throw new TypeError("Trial corpus/configuration mismatch");
    const key = pairKey(trial), group = groups.get(key) ?? [];
    if (group.some(entry => entry.configurationDigest === trial.configurationDigest)) throw new TypeError("Duplicate trial inside a paired key");
    if (group.some(entry => entry.subjectDigest !== trial.subjectDigest || entry.clean !== trial.clean || canonicalize(json(entry.criticalDefectIds)) !== canonicalize(json(trial.criticalDefectIds)))) throw new TypeError("Paired configurations changed subjects or ground truth");
    group.push(trial); groups.set(key, group);
  }
  if ([...groups.values()].some(group => group.length !== configurations.length)) throw new TypeError("Paired benchmark has an absent configuration arm");
  const results = configurations.map(config => ({ configurationDigest: config.configurationDigest, metrics: metrics(trials.filter(trial => trial.configurationDigest === config.configurationDigest)) }));
  const higherIsBetter = new Set<GenomeMetric>(["defectRecall", "reproducibility", "coverage", "marginalEvidenceValue"]);
  const comparable = results.filter(result => GENOME_METRICS.every(key => result.metrics[key].value !== null));
  const pareto = comparable.filter(candidate => !comparable.some(other => other !== candidate
    && GENOME_METRICS.every(key => higherIsBetter.has(key) ? other.metrics[key].value! >= candidate.metrics[key].value! : other.metrics[key].value! <= candidate.metrics[key].value!)
    && GENOME_METRICS.some(key => other.metrics[key].value !== candidate.metrics[key].value))).map(result => result.configurationDigest);
  const limitations = ["Paired seeds and provider snapshot digests do not assert deterministic providers.", "All rates and means are descriptive fixture measurements. Repeated cases and seeds do not supply independent population samples; no inferential confidence intervals are reported.", "Reproducibility counts case/seed/provider groups whose every repeat has identical judgment and exact physical command-result multiset. Run IDs, clocks and candidate source bytes are outside this metric; signed evidence digests remain separately authenticated.", "Lane correlation is association across predeclared finding vectors, not causal independence."];
  if (trials.some(trial => trial.judgment === "INVALID")) limitations.push("INVALID trials remain explicit infrastructure failures; they do not become UNPROVEN or a favorable outcome.");
  if (results.some(result => GENOME_METRICS.some(key => result.metrics[key].value === null))) limitations.push("Unmeasured dimensions prevent Pareto preset admission for that configuration.");
  const body = { protocol: GENOME_BENCHMARK_PROTOCOL, corpusDigest, configurations, trials, pairedKeys: groups.size, results, pareto, limitations };
  return freeze({ ...body, digest: digestJson(json(body)) });
}

export function verifyGenomeBenchmark(raw: unknown, keys: ReadonlyMap<string, KeyObject | string>): GenomeBenchmarkReport {
  const signed = exact(raw, ["report", "attestation"], "Signed Genome benchmark");
  const report = signed.report as GenomeBenchmarkReport, envelope = signed.attestation as DsseEnvelope;
  exact(report, ["protocol", "corpusDigest", "configurations", "trials", "pairedKeys", "results", "pareto", "limitations", "digest"], "Genome benchmark report");
  const rebuilt = compileGenomeBenchmark(report.configurations, report.trials);
  if (canonicalize(json(rebuilt)) !== canonicalize(json(report)) || envelope?.payloadType !== GENOME_BENCHMARK_PAYLOAD_TYPE || !verifyDsse(envelope, keys)
    || canonicalize(json(decodeDsseJson(envelope))) !== canonicalize(json(report))) throw new Error("Genome benchmark failed metric replay, digest, or trusted signature verification");
  return rebuilt;
}

/** Caller must explicitly provide a benchmark signing key; this is not promotion authority. */
export function signGenomeBenchmark(report: GenomeBenchmarkReport, privateKey: KeyObject | string, keyId?: string): SignedGenomeBenchmark {
  const rebuilt = compileGenomeBenchmark(report.configurations, report.trials);
  if (canonicalize(json(rebuilt)) !== canonicalize(json(report))) throw new TypeError("Cannot sign a non-replayable benchmark report");
  return freeze({ report: rebuilt, attestation: signJsonDsse(GENOME_BENCHMARK_PAYLOAD_TYPE, json(rebuilt), privateKey, keyId) });
}
