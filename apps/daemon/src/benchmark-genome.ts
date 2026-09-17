import { JEVYR_BONE_DESCRIPTOR, JEVYR_BONE_DIGEST } from "@jevyr/core";
import { assertStoredGenome, compileGenomeRuntimeProfile, type StoredGenome } from "@jevyr/growth";
import { digestJson, type JsonValue } from "@jevyr/protocol";
import { selectedStartupBone, type LoadedGenomeStartupSelection } from "./genome-startup.js";

/** Explicit embedder-only laboratory selection. This never writes a registry,
 * signs governance, or promotes a strategy. Every Case discloses the experiment.
 */
export function selectBenchmarkGenome(value: StoredGenome, base: LoadedGenomeStartupSelection): LoadedGenomeStartupSelection {
  assertStoredGenome(value);
  const genome = structuredClone(value);
  const { bone, boneDigest } = selectedStartupBone(base);
  const runtimeProfile = compileGenomeRuntimeProfile(genome, { expectedBoneDigest: boneDigest });
  const descriptor = {
    protocol: "jevyr.genome-startup-selection/1",
    selection: { mode: "benchmark-experiment", genomeVersion: genome.body.protocol, genomeDigest: genome.digest, generation: genome.body.generation },
    promoted: false, registryMutation: false, promotionAuthority: "none",
    activeStartupSelectionDigest: base.descriptorDigest,
    pointerRead: "startup-once",
    runtimeCompilation: { mode: "built-in-catalog-only", boneDigest, bone, runtimeProfileDigest: runtimeProfile.profileDigest, runtimeProfile },
  } as unknown as JsonValue;
  return Object.freeze({ registryRoot: base.registryRoot, source: "benchmark-experiment", runtimeProfile,
    repositorySealProfile: Object.freeze({ genomeVersion: genome.body.protocol, genomeDescriptor: genome.body as unknown as JsonValue,
      ...(base.repositorySealProfile.policyVersion ? { policyVersion: base.repositorySealProfile.policyVersion } : {}) }),
    descriptor, descriptorDigest: digestJson(descriptor) });
}
