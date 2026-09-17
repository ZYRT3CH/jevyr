import type { KeyObject } from "node:crypto";
import { decodeDsseJson, signJsonDsse, verifyDsse } from "@jevyr/core";
import { canonicalize, digestJson, isSha256Digest, type DsseEnvelope, type JsonValue } from "@jevyr/protocol";
import { compileGenomeBenchmark, verifyGenomeBenchmark, type GenomeBenchmarkReport, type PairedBenchmarkConfiguration, type SignedGenomeBenchmark } from "./paired-benchmarks.js";

export const GENOME_PRESET_PAYLOAD_TYPE = "application/vnd.jevyr.preset+json";
export interface GenomePreset {
  readonly protocol: "jevyr.preset/1";
  readonly name: string;
  readonly configuration: PairedBenchmarkConfiguration;
  readonly benchmarkDigest: string;
  readonly corpusDigest: string;
  readonly digest: string;
}
export interface SignedGenomePreset {
  readonly preset: GenomePreset;
  readonly benchmark: SignedGenomeBenchmark;
  readonly attestation: DsseEnvelope;
}
export interface PresetSelection {
  readonly protocol: "jevyr.preset-selection/1";
  readonly mode: "preset" | "wild";
  readonly presetDigest: string | null;
  readonly digest: string;
}
const json = (value: unknown) => value as JsonValue;
function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

/** Builds a reviewable inert value. Saving/using it additionally requires two verified signatures. */
export function createGenomePreset(name: string, report: GenomeBenchmarkReport, configurationDigest: string): GenomePreset {
  if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/u.test(name) || name !== name.trim()) throw new TypeError("Preset name must be 1–80 plain characters");
  const replayed = compileGenomeBenchmark(report.configurations, report.trials);
  if (canonicalize(json(replayed)) !== canonicalize(json(report))) throw new TypeError("Preset benchmark metrics do not replay");
  const configuration = report.configurations.find(entry => entry.configurationDigest === configurationDigest);
  if (!configuration || !report.pareto.includes(configurationDigest)) throw new TypeError("Preset must select a measured Pareto-efficient configuration");
  if (report.trials.some(trial => trial.configurationDigest === configurationDigest && trial.judgment === "INVALID")) throw new TypeError("Infrastructure-invalid trials cannot authorize a preset");
  const body = { protocol: "jevyr.preset/1" as const, name, configuration, benchmarkDigest: report.digest, corpusDigest: report.corpusDigest };
  return freeze({ ...body, digest: digestJson(json(body)) });
}

/** Explicit caller-supplied key only; neither saving nor startup ever generates a signature. */
export function signGenomePreset(preset: GenomePreset, benchmark: SignedGenomeBenchmark, keys: ReadonlyMap<string, KeyObject | string>, privateKey: KeyObject | string, keyId?: string): SignedGenomePreset {
  const report = verifyGenomeBenchmark(benchmark, keys);
  const rebuilt = createGenomePreset(preset.name, report, preset.configuration.configurationDigest);
  if (canonicalize(json(rebuilt)) !== canonicalize(json(preset))) throw new TypeError("Preset digest or benchmark binding differs");
  return freeze({ preset: rebuilt, benchmark, attestation: signJsonDsse(GENOME_PRESET_PAYLOAD_TYPE, json(rebuilt), privateKey, keyId) });
}

export function verifyGenomePreset(raw: unknown, keys: ReadonlyMap<string, KeyObject | string>): SignedGenomePreset {
  const signed = exact(raw, ["preset", "benchmark", "attestation"], "Signed preset");
  const preset = exact(signed.preset, ["protocol", "name", "configuration", "benchmarkDigest", "corpusDigest", "digest"], "Preset") as unknown as GenomePreset;
  const report = verifyGenomeBenchmark(signed.benchmark, keys);
  const rebuilt = createGenomePreset(preset.name, report, preset.configuration.configurationDigest);
  const envelope = signed.attestation as DsseEnvelope;
  if (canonicalize(json(rebuilt)) !== canonicalize(json(preset)) || envelope?.payloadType !== GENOME_PRESET_PAYLOAD_TYPE
    || !verifyDsse(envelope, keys) || canonicalize(json(decodeDsseJson(envelope))) !== canonicalize(json(preset))) throw new Error("Preset failed benchmark replay, Pareto, digest, or trusted signature verification");
  return freeze(structuredClone(signed)) as unknown as SignedGenomePreset;
}

export function presetSelection(presetDigest: string | null): PresetSelection {
  if (presetDigest !== null && !isSha256Digest(presetDigest)) throw new TypeError("Invalid preset selection digest");
  const body = { protocol: "jevyr.preset-selection/1" as const, mode: presetDigest === null ? "wild" as const : "preset" as const, presetDigest };
  return Object.freeze({ ...body, digest: digestJson(json(body)) });
}
export function validatePresetSelection(value: unknown): PresetSelection {
  const raw = exact(value, ["protocol", "mode", "presetDigest", "digest"], "Preset selection");
  const rebuilt = presetSelection(raw.presetDigest as string | null);
  if (canonicalize(json(raw)) !== canonicalize(json(rebuilt))) throw new TypeError("Preset selection digest mismatch");
  return rebuilt;
}
