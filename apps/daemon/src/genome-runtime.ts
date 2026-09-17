import type { GenomeRuntimeProfile } from "@jevyr/growth";
import type { SealedSearchProfile } from "@jevyr/protocol";
import {
  ASSAY_ARCHIVE_V1,
  compileRuntimeGrowthPolicy,
  type AssayArchiveGenomeKnobs,
  type RuntimeGrowthPolicy,
} from "@jevyr/runtime";

export interface ComposedGenomeRuntime {
  readonly searchProfile: SealedSearchProfile;
  readonly archive: AssayArchiveGenomeKnobs;
  readonly growthPolicy: RuntimeGrowthPolicy;
}

/**
 * Project policy owns physical permission. A promoted Genome may only tighten
 * nursery persistence and the measured archive; it never expands resources.
 */
export function composeGenomeRuntime(
  projectSearch: SealedSearchProfile,
  projectMaximumLateWeight: number,
  runtimeProfile?: GenomeRuntimeProfile,
): ComposedGenomeRuntime {
  const nursery = runtimeProfile === undefined
    ? Object.freeze({ ...projectSearch.nursery })
    : Object.freeze({
        ...projectSearch.nursery,
        saturationWindow: Math.min(
          projectSearch.nursery.saturationWindow,
          runtimeProfile.nursery.saturationWindow,
        ),
        challengeInterval: Math.min(
          projectSearch.nursery.challengeInterval,
          runtimeProfile.nursery.challengeInterval,
          projectSearch.nursery.saturationWindow,
          runtimeProfile.nursery.saturationWindow,
        ),
      });
  const searchProfile: SealedSearchProfile = Object.freeze({
    attemptSafetyCeiling: projectSearch.attemptSafetyCeiling,
    nursery,
    resources: Object.freeze({ ...projectSearch.resources }),
    seedDerivation: projectSearch.seedDerivation,
  });
  const archive: AssayArchiveGenomeKnobs = Object.freeze(runtimeProfile === undefined
    ? {
        capacity: ASSAY_ARCHIVE_V1.capacity,
        minimumNovelty: ASSAY_ARCHIVE_V1.minimumNovelty,
      }
    : {
        capacity: Math.min(ASSAY_ARCHIVE_V1.capacity, runtimeProfile.archive.capacity),
        minimumNovelty: Math.max(
          ASSAY_ARCHIVE_V1.minimumNovelty,
          runtimeProfile.archive.minimumNovelty,
        ),
      });
  const lateMemory = Object.freeze(runtimeProfile === undefined
    ? {
        recallLimit: 12,
        maximumWeight: Math.min(0.2, projectMaximumLateWeight),
      }
    : {
        recallLimit: Math.min(12, runtimeProfile.lateMemory.recallLimit),
        maximumWeight: Math.min(projectMaximumLateWeight, runtimeProfile.lateMemory.weight),
      });
  const growthPolicy = compileRuntimeGrowthPolicy({
    source: runtimeProfile === undefined ? "built-in-baseline" : "governance-genome",
    ...(runtimeProfile === undefined
      ? {}
      : { genomeRuntimeProfileDigest: runtimeProfile.profileDigest }),
    nursery,
    archive,
    lateMemory,
  });
  return Object.freeze({ searchProfile, archive, growthPolicy });
}
