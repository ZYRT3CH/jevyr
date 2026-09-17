import { resolve } from "node:path";
import { JEVYR_BONE_DIGEST } from "@jevyr/core";
import { PresetRegistry, type GenomeRuntimeProfile, type SignedGenomePreset } from "@jevyr/growth";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { loadGovernanceTrust, selectedStartupBone, type LoadedGenomeStartupSelection } from "./genome-startup.js";

export interface LoadedPresetStartupSelection {
  readonly registryRoot: string;
  readonly signed?: SignedGenomePreset;
  readonly runtimeProfile?: GenomeRuntimeProfile;
  readonly descriptor: JsonValue;
  readonly descriptorDigest: string;
}

/** Snapshot local operator selection once. It cannot promote a Genome or alter Bone. */
export function loadPresetStartupSelection(env: NodeJS.ProcessEnv, projectRoot: string, dataDir: string, genome: LoadedGenomeStartupSelection): LoadedPresetStartupSelection {
  const configured = env.JEVYR_PRESET_REGISTRY_DIR;
  if (configured !== undefined && (!configured.trim() || configured.includes("\0"))) throw new TypeError("JEVYR_PRESET_REGISTRY_DIR must be a nonempty path");
  const registryRoot = configured === undefined ? resolve(dataDir, "presets") : resolve(projectRoot, configured);
  const trust = loadGovernanceTrust(env, projectRoot);
  const { selection, signed } = new PresetRegistry(registryRoot).readSelectionSync(trust.keys);
  const genomeDigest = digestJson(genome.repositorySealProfile.genomeDescriptor);
  if (signed && (signed.preset.configuration.genomeDigest !== genomeDigest || signed.preset.configuration.runtimeProfile.boneDigest !== selectedStartupBone(genome).boneDigest)) throw new TypeError("Selected preset targets a different startup-bound Genome or Bone");
  const selected = signed?.preset.configuration.runtimeProfile;
  const active = genome.runtimeProfile;
  // Compose restrictions with the active Genome; a preset never widens its bounds.
  const composed = selected === undefined ? active : active === undefined ? selected : (() => {
    const body = {
      ...active,
      nursery: { saturationWindow: Math.min(active.nursery.saturationWindow, selected.nursery.saturationWindow), challengeInterval: Math.min(active.nursery.challengeInterval, selected.nursery.challengeInterval) },
      archive: { capacity: Math.min(active.archive.capacity, selected.archive.capacity), minimumNovelty: Math.max(active.archive.minimumNovelty, selected.archive.minimumNovelty) },
      lateMemory: { recallLimit: Math.min(active.lateMemory.recallLimit, selected.lateMemory.recallLimit), weight: Math.min(active.lateMemory.weight, selected.lateMemory.weight) },
    };
    const { profileDigest: ignored, ...digestBody } = body;
    return Object.freeze({ ...body, profileDigest: digestJson(digestBody as unknown as JsonValue) });
  })();
  const descriptor = {
    protocol: "jevyr.preset-startup-selection/1", selection,
    genomeDigest, governanceTrustDigest: trust.digest,
    preset: signed?.preset ?? null,
    benchmark: signed?.benchmark ?? null,
    attestation: signed?.attestation ?? null,
    effectiveRuntimeProfile: composed ?? null,
    pointerRead: "startup-once", scope: "narrowing-only",
    wildMeaning: "remove-preset-restrictions; active-Genome-and-project-policy-remain",
  } as unknown as JsonValue;
  return Object.freeze({ registryRoot, ...(signed ? { signed } : {}), ...(composed ? { runtimeProfile: composed } : {}), descriptor, descriptorDigest: digestJson(descriptor) });
}
