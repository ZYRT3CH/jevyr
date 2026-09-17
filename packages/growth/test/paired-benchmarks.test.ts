import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyIdFor } from "@jevyr/core";
import { digestJson, sha256Digest, type JsonValue } from "@jevyr/protocol";
import { compileGenomeBenchmark, compileGenomeRuntimeProfile, createGenome, createGenomePreset, PresetRegistry, signGenomeBenchmark, signGenomePreset, verifyGenomeBenchmark, verifyGenomePreset, type PairedGenomeTrial } from "../src/index.js";

const hash = sha256Digest;
function fixture() {
  const configs = [0, 1].map(generation => {
    const genome = createGenome({ protocol: "jevyr.genome/1", generation, boneDigest: hash("bone"), parentDigests: [], modules: [], parameters: {} });
    const body = { genomeDigest: genome.digest, runtimeProfile: compileGenomeRuntimeProfile(genome, { expectedBoneDigest: hash("bone") }) };
    return { ...body, configurationDigest: digestJson(body as unknown as JsonValue) };
  });
  const trials: PairedGenomeTrial[] = [];
  for (const clean of [true, false]) for (const repeat of [0, 1]) for (const [index, config] of configs.entries()) {
    trials.push({ caseKey: clean ? "clean" : "defect", corpusDigest: hash("corpus"), subjectDigest: hash(String(clean)), seedDigest: hash("seed"), providerSnapshotDigest: hash("providers"), configurationDigest: config.configurationDigest, repeat,
      recordDigest: hash(`${clean}/${repeat}/${index}`), evidenceDigest: hash(`${clean}/${repeat}/${index}`), physicalObservationDigest: hash(`physical/${clean}/${index}`), replayDigest: hash(`replay/${clean}/${repeat}/${index}`), replayVerified: true,
      judgment: clean ? "ACCEPT" : "REJECT", clean, criticalDefectIds: clean ? [] : ["bug"], reproducedDefectIds: clean ? [] : ["bug"], accusedDefectIds: clean ? [] : ["bug"],
      coverage: { covered: index ? 9 : 10, eligible: 10 }, cost: { wallMillis: index ? 200 : 100, inputTokens: 10, outputTokens: 20 },
      lanes: [{ laneId: "one", familyId: "a", findings: [true, false, true, false] }, { laneId: "two", familyId: "b", findings: [true, true, false, false] }],
      marginal: { additionalDecisiveEvidence: 1, additionalCostUnits: index ? 2 : 1 },
    });
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519"), keys = new Map([[keyIdFor(publicKey), publicKey]]);
  const report = compileGenomeBenchmark(configs, trials), benchmark = signGenomeBenchmark(report, privateKey);
  const preset = signGenomePreset(createGenomePreset("Measured", report, configs[0]!.configurationDigest), benchmark, keys, privateKey);
  return { configs, trials, keys, privateKey, report, benchmark, preset };
}

describe("paired Genome measurements and signed presets", () => {
  it("computes paired metrics and Pareto without collapsing axes", () => {
    const f = fixture(), best = f.report.results.find(row => row.configurationDigest === f.configs[0]!.configurationDigest)!;
    expect(best.metrics.defectRecall.value).toBe(1);
    expect(best.metrics.falseAccusations.value).toBe(0);
    expect(best.metrics.reproducibility.value).toBe(1);
    expect(best.metrics.reproducibility.observations).toBe(2);
    expect(best.metrics.defectRecall).toMatchObject({ method: "descriptive-rate", interval95: null });
    expect(best.metrics.laneCorrelation.value).toBe(0);
    expect(f.report.pareto).toEqual([f.configs[0]!.configurationDigest]);
    expect(verifyGenomePreset(f.preset, f.keys).preset.digest).toBe(f.preset.preset.digest);
    expect(() => createGenomePreset("Dominated", f.report, f.configs[1]!.configurationDigest)).toThrow(/Pareto/u);
  });
  it("keeps incomplete physical observations unmeasured and counts repeat groups once", () => {
    const f = fixture();
    const report = compileGenomeBenchmark(f.configs, f.trials.map(row => row.repeat === 1 ? { ...row, physicalObservationDigest: null } : row));
    expect(report.results.every(row => row.metrics.reproducibility.method === "unmeasured")).toBe(true);
    expect(report.pareto).toEqual([]);
    const changed = compileGenomeBenchmark(f.configs, f.trials.map(row => row.repeat === 1 && row.clean ? { ...row, physicalObservationDigest: hash("changed-output") } : row));
    expect(changed.results.every(row => row.metrics.reproducibility.value === 0.5 && row.metrics.reproducibility.observations === 2)).toBe(true);
  });
  it("rejects missing arms and changed subject, seed, or provider snapshots", () => {
    const f = fixture();
    expect(() => compileGenomeBenchmark(f.configs, f.trials.slice(1))).toThrow(/absent/u);
    for (const field of ["subjectDigest", "seedDigest", "providerSnapshotDigest"] as const) {
      const trials = structuredClone(f.trials); trials[0] = { ...trials[0]!, [field]: hash("changed") };
      expect(() => compileGenomeBenchmark(f.configs, trials)).toThrow(/subjects|absent/u);
    }
  });
  it("refuses missing measurements and infrastructure-invalid preset admission", () => {
    const f = fixture(), trials = f.trials.map(row => ({ ...row, cost: null }));
    const report = compileGenomeBenchmark(f.configs, trials);
    expect(report.pareto).toEqual([]);
    expect(report.results[0]!.metrics.tokens.value).toBeNull();
    expect(() => createGenomePreset("Missing", report, f.configs[0]!.configurationDigest)).toThrow(/Pareto/u);
    const invalid = compileGenomeBenchmark(f.configs, f.trials.map(row => row.configurationDigest === f.configs[0]!.configurationDigest ? { ...row, judgment: "INVALID" as const } : row));
    expect(() => createGenomePreset("Invalid", invalid, f.configs[0]!.configurationDigest)).toThrow(/invalid/u);
  });
  it("recomputes signed metrics and refuses untrusted or altered envelopes", () => {
    const f = fixture(), forged = structuredClone(f.benchmark);
    (forged.report.results[0]!.metrics.coverage as {value: number}).value = 0.123;
    expect(() => verifyGenomeBenchmark(forged, f.keys)).toThrow();
    expect(() => verifyGenomeBenchmark(f.benchmark, new Map())).toThrow();
    const preset = structuredClone(f.preset); (preset.preset as {name:string}).name = "Injected";
    expect(() => verifyGenomePreset(preset, f.keys)).toThrow();
  });
  it("atomically selects/off without mutating a prior snapshot and fails closed on missing signed bytes", async () => {
    const f = fixture(), root = await mkdtemp(join(tmpdir(), "jevyr-presets-"));
    try {
      const registry = new PresetRegistry(root);
      expect((await registry.save(f.preset, f.keys)).status).toBe("STORED");
      await registry.select(f.preset.preset.digest, f.keys);
      const prior = registry.readSelectionSync(f.keys);
      await registry.select(null, f.keys);
      expect(registry.readSelectionSync(f.keys).selection.mode).toBe("wild");
      expect(prior.selection.mode).toBe("preset");
      await registry.select(f.preset.preset.digest, f.keys);
      await unlink(join(root, "objects", `${f.preset.preset.digest.slice(7)}.json`));
      expect(() => registry.readSelectionSync(f.keys)).toThrow();
      await writeFile(join(root, "selection.json"), '{"mode":"wild"}');
      expect(() => registry.readSelectionSync(f.keys)).toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
