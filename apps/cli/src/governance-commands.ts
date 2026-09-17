import { createPrivateKey } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JEVYR_BONE_DIGEST, parseJsonBytes } from "@jevyr/core";
import { loadGenomeStartupSelection, loadGovernanceTrust, loadPresetStartupSelection } from "@jevyr/daemon";
import { GenomeRegistry, PresetRegistry, assertGrowthProposal, assertStoredGenome, assertPairedTrialSealedBindings, validatePairedFixtureCorpus, derivePhysicalReproducibility, compileGenomeBenchmark, compileGenomeRuntimeProfile, createGenomePreset, genomePromotionPayload, promoteGenome, signGenomeBenchmark, signGenomePreset, stageDescendant, verifyGenomeBenchmark, type GenomeBenchmarkReport, type SignedGenomeBenchmark, type PairedGenomeTrial, type PairedFixtureCorpus } from "@jevyr/growth";
import { canonicalize, digestJson, sha256Digest, validateSealedCase, type DsseEnvelope, type JsonValue } from "@jevyr/protocol";
import { assertArtifactList, assertCasePolicyDescriptor, assertSealReceipt } from "@jevyr/sdk";
import { flag, option, type ParsedArguments } from "./arguments.js";
import { verifyLocalProof } from "./local-proof.js";

const json = (value: unknown) => value as JsonValue;
function exact(value: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) throw new TypeError(`${label} has unknown or missing fields`);
  return value as Record<string, unknown>;
}
async function readJson(path: string): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 32 * 1048576) throw new TypeError("Governance input must be an ordinary bounded singly-linked file");
  const bytes = await readFile(path), after = await lstat(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new Error("Governance input changed while read");
  return parseJsonBytes(bytes, "Governance input");
}
function required(args: ParsedArguments, key: string): string {
  const value = option(args, key); if (value === undefined || !value.trim()) throw new TypeError(`--${key} is required`); return value;
}
async function output(args: ParsedArguments, base: string, value: unknown, message: string): Promise<number> {
  const report = option(args, "report");
  if (report) {
    const handle = await open(resolve(base, report), "wx", 0o600);
    try { await handle.writeFile(`${canonicalize(json(value))}\n`); await handle.sync(); } finally { await handle.close(); }
  }
  process.stdout.write(flag(args, "json") ? `${JSON.stringify(value, null, 2)}\n` : `${message}\n${report ? `Saved ${resolve(base, report)}\n` : ""}`);
  return 0;
}
function explicitSigningKey(args: ParsedArguments, env: NodeJS.ProcessEnv) {
  const reference = required(args, "signing-key-ref");
  if (!/^env:[A-Z][A-Z0-9_]{0,127}$/u.test(reference)) throw new TypeError("--signing-key-ref must name env:VARIABLE");
  const pem = env[reference.slice(4)];
  if (!pem || pem.length > 16384 || !pem.startsWith("-----BEGIN PRIVATE KEY-----")) throw new TypeError("Explicit signing key reference is unavailable or invalid");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Benchmark and preset signing requires Ed25519");
  return key;
}

/** Every trial must reference a separately pinned, fully replayed terminal proof. Fixture labels and finite vectors remain signed operator measurements. */
export async function replayTrialProofs(raw: unknown, report: GenomeBenchmarkReport, base: string, corpus: PairedFixtureCorpus): Promise<void> {
  if (!Array.isArray(raw) || raw.length !== report.trials.length) throw new TypeError("Exactly one pinned local proof per trial is required");
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = exact(item, ["recordDigest", "directory", "signerKeyId"], "Trial proof reference");
    if (typeof entry.recordDigest !== "string" || seen.has(entry.recordDigest) || typeof entry.directory !== "string" || typeof entry.signerKeyId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(entry.signerKeyId)) throw new TypeError("Trial proof references require unique Record digests, directories, and pinned signer identities");
    seen.add(entry.recordDigest);
    const root = resolve(base, entry.directory), verified = await verifyLocalProof(root, entry.signerKeyId);
    if (!verified.valid) throw new TypeError(`Benchmark proof replay failed: ${verified.problems.join("; ")}`);
    const trial = report.trials.find(row => row.recordDigest === entry.recordDigest);
    const record = await readJson(join(root, "record.json")) as {genomeDigest:string; verdict:{evidenceDigest:string; judgment:string; integrity:string}};
    const seal = assertSealReceipt(await readJson(join(root, "seal-receipt.json")));
    if (digestJson(json(record)) !== verified.recordDigest || seal.runDigest !== verified.runDigest || seal.caseDigest !== verified.caseDigest || seal.policyDigest !== verified.policyDigest) throw new TypeError("Benchmark proof documents changed after their authenticated replay");
    const { directory: ignored, ...portableReplay } = verified;
    if (!trial || verified.recordDigest !== trial.recordDigest || trial.replayDigest !== digestJson(json(portableReplay)) || record.verdict.evidenceDigest !== trial.evidenceDigest || (record.verdict.integrity === "INVALID" ? "INVALID" : record.verdict.judgment) !== trial.judgment || seal.subjectMaterialCaptureDigest !== trial.subjectDigest
      || report.configurations.find(config => config.configurationDigest === trial.configurationDigest)?.genomeDigest !== record.genomeDigest) throw new TypeError("Trial measurements do not bind the replayed Record, evidence, subject, Genome or replay digest");
    const validation = validateSealedCase(await readJson(join(root, "sealed-case.json")));
    if (!validation.ok || !validation.value) throw new TypeError("Trial proof lacks a valid revealed sealed Case and seed");
    const sealed = validation.value;
    for (const key of ["caseId", "submissionDigest", "subjectMaterialCaptureDigest", "caseDigest", "runDigest", "sealedAt", "policyVersion", "policyDigest", "genomeVersion", "genomeDigest", "intentContractDigest"] as const) {
      if (sealed[key] !== seal[key]) throw new TypeError(`Benchmark sealed Case differs from authenticated Seal in ${key}`);
    }
    if (sealed.searchEnvelope.digest !== seal.searchDigest) throw new TypeError("Benchmark sealed search envelope differs from authenticated Seal");
    const policy = await assertCasePolicyDescriptor(await readJson(join(root, "policy-descriptor.json")), seal.caseId);
    if (policy.artifact.digest !== seal.policyDigest) throw new TypeError("Benchmark policy differs from authenticated Seal");
    assertPairedTrialSealedBindings(trial, report.configurations.find(config => config.configurationDigest === trial.configurationDigest)!, corpus, sealed,
      (policy.artifact.descriptor as {policy:Record<string,unknown>}).policy);
    const inventory = assertArtifactList(await readJson(join(root, "artifact-index.json")), seal.caseId);
    if (digestJson(json(inventory)) !== verified.artifactIndexDigest) throw new TypeError("Benchmark artifact inventory changed after authenticated replay");
    const observations: unknown[] = [];
    for (const meta of inventory.artifacts.filter(artifact => artifact.mediaType === "application/vnd.jevyr.tool-observation+json")) {
      const bytes = await readFile(join(root, "artifacts", `${meta.id}.blob`));
      if (bytes.length !== meta.size || sha256Digest(bytes) !== meta.digest) throw new TypeError("Benchmark physical artifact changed after proof replay");
      observations.push(parseJsonBytes(bytes, "Benchmark physical observation"));
    }
    if (derivePhysicalReproducibility(observations).digest !== trial.physicalObservationDigest) throw new TypeError("Trial physical reproducibility digest differs from authenticated observations");
  }
}

export async function runGovernanceCommand(args: ParsedArguments, base: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dataDir = resolve(base, env.JEVYR_DATA_DIR ?? ".jevyr");
  const trust = loadGovernanceTrust(env, base), genome = loadGenomeStartupSelection(env, base, dataDir);
  const registry = new GenomeRegistry(genome.registryRoot);
  const presetRegistry = new PresetRegistry(env.JEVYR_PRESET_REGISTRY_DIR === undefined ? resolve(dataDir, "presets") : resolve(base, env.JEVYR_PRESET_REGISTRY_DIR));
  const action = args.positionals[0];
  if (args.command === "preset") {
    if (action === "off" || action === "wild") {
      const selection = await presetRegistry.select(null, trust.keys);
      return output(args, base, { selection, applies: "next-runtime-startup", sealedCasesChanged: false }, "Wild selected. Preset restrictions are removed at the next runtime startup; sealed cases are unchanged.");
    }
    if (action === "use") {
      const target = await presetRegistry.read(args.positionals[1]!, trust.keys);
      if (target.preset.configuration.genomeDigest !== digestJson(genome.repositorySealProfile.genomeDescriptor) || target.preset.configuration.runtimeProfile.boneDigest !== JEVYR_BONE_DIGEST) throw new TypeError("Preset targets a different active Genome or Bone");
      const selection = await presetRegistry.select(args.positionals[1]!, trust.keys);
      return output(args, base, { selection, applies: "next-runtime-startup", sealedCasesChanged: false }, "Preset selected for the next runtime startup. Sealed cases are unchanged.");
    }
    if (action === "save") {
      const benchmark = await readJson(resolve(base, required(args, "file"))) as SignedGenomeBenchmark;
      const report = verifyGenomeBenchmark(benchmark, trust.keys);
      const preset = createGenomePreset(required(args, "name"), report, required(args, "configuration"));
      const signed = signGenomePreset(preset, benchmark, trust.keys, explicitSigningKey(args, env));
      const receipt = await presetRegistry.save(signed, trust.keys);
      return output(args, base, { receipt, signed, selected: false }, `Saved signed Pareto preset ${receipt.digest}. Selection is explicit.`);
    }
    throw new TypeError("preset requires save, use, off, or wild");
  }
  if (args.command === "genome") {
    if (action === "inspect") {
      const presets = loadPresetStartupSelection(env, base, dataDir, genome);
      return output(args, base, { active: genome.descriptor, preset: presets.descriptor, genomes: await registry.listGenomes(), proposals: await registry.listProposals(), promotions: await registry.listPromotions(), presets: (await presetRegistry.list(trust.keys)).map(value => value.preset) }, "Genome and preset inspection complete. Use --json for exact signed provenance.");
    }
    if (action === "propose") {
      const bundle = exact(await readJson(resolve(base, required(args, "file"))), ["parent", "proposal", "benchmarks"], "Genome proposal import");
      assertStoredGenome(bundle.parent); assertGrowthProposal(bundle.proposal);
      const parent = bundle.parent, proposal = bundle.proposal;
      const replayedProposal = stageDescendant(parent, proposal.descendant, proposal.benchmarkEvidence, proposal.damageEvidence, proposal.novelty);
      if (canonicalize(json(replayedProposal)) !== canonicalize(json(proposal))) throw new TypeError("Proposal admission decision does not replay under current governance gates");
      compileGenomeRuntimeProfile(proposal.descendant, { expectedBoneDigest: JEVYR_BONE_DIGEST });
      if (proposal.parentDigest !== parent.digest || !Array.isArray(bundle.benchmarks) || bundle.benchmarks.length < 1 || bundle.benchmarks.length > 32) throw new TypeError("Proposal needs its exact parent and signed paired benchmark evidence");
      const reports = bundle.benchmarks.map(value => verifyGenomeBenchmark(value, trust.keys));
      if (proposal.benchmarkEvidence.some(entry => !reports.some(report => report.digest === entry.evidenceDigest && report.configurations.some(config => config.genomeDigest === parent.digest) && report.configurations.some(config => config.genomeDigest === proposal.descendant.digest)))) throw new TypeError("Every proposed benchmark evidence digest must bind a verified paired parent/descendant report");
      await registry.storeGenome(parent); await registry.storeGenome(proposal.descendant); const receipt = await registry.storeProposal(proposal);
      return output(args, base, { receipt, proposal, promotionPayload: proposal.decision === "STAGED" ? genomePromotionPayload(proposal) : null }, `Stored ${proposal.decision} offspring ${proposal.proposalDigest}. Promotion requires a separate human governance signature.`);
    }
    if (action === "promote") {
      const proposal = await registry.readProposal(args.positionals[1]!);
      const attestation = await readJson(resolve(base, required(args, "attestation"))) as DsseEnvelope;
      const promoted = promoteGenome(proposal, attestation, trust.keys);
      compileGenomeRuntimeProfile(promoted.genome, { expectedBoneDigest: JEVYR_BONE_DIGEST });
      const stored = await registry.storePromotion(promoted, trust.keys), pointer = await registry.activatePromotion(stored.digest, trust.keys);
      return output(args, base, { pointer, applies: "next-runtime-startup" }, `Verified externally signed promotion ${stored.digest}. Active at the next runtime startup.`);
    }
    throw new TypeError("genome requires inspect, propose, or promote");
  }
  if (args.command === "benchmark") {
    if (action === "compare") {
      const signed = await readJson(resolve(base, required(args, "file")));
      const report = verifyGenomeBenchmark(signed, trust.keys);
      return output(args, base, { report, signaturesVerified: true }, `Verified ${report.pairedKeys} paired keys. Pareto configurations: ${report.pareto.join(", ") || "none; required measurements are absent"}.`);
    }
    const input = exact(await readJson(resolve(base, required(args, "file"))), ["configurations", "trials", "proofs", "corpus"], "Paired benchmark input");
    const report = compileGenomeBenchmark(input.configurations as GenomeBenchmarkReport["configurations"], input.trials as PairedGenomeTrial[]);
    await replayTrialProofs(input.proofs, report, base, validatePairedFixtureCorpus(input.corpus));
    if (action === "build") return output(args, base, report, `Replayed ${report.trials.length} pinned terminal proofs and bound their seeds, providers, profiles, fixtures and physical results. Ground truth remains scoped to the declared fixture.`);
    if (action === "run") {
      const signed = signGenomeBenchmark(report, explicitSigningKey(args, env));
      verifyGenomeBenchmark(signed, trust.keys);
      return output(args, base, signed, `Replayed and explicitly signed ${report.trials.length} recorded trial measurements. No new case was executed.`);
    }
  }
  throw new TypeError("Unsupported governance command");
}
