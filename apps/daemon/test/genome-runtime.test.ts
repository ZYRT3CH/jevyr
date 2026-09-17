import assert from "node:assert/strict";
import { test } from "node:test";
import type { GenomeRuntimeProfile } from "@jevyr/growth";
import { sha256Digest } from "@jevyr/protocol";
import { DEFAULT_SEARCH_PROFILE } from "@jevyr/runtime";
import { composeGenomeRuntime } from "../src/genome-runtime.js";

function profile(): GenomeRuntimeProfile {
  return {
    protocol: "jevyr.genome-runtime-profile/1",
    profileDigest: sha256Digest("compiled-profile"),
    sourceGenomeDigest: sha256Digest("source-genome"),
    boneDigest: sha256Digest("bone"),
    generation: 3,
    enabledModules: [
      "jevyr.nursery-governor",
      "jevyr.archive-curator",
      "jevyr.late-memory-gate",
    ],
    nursery: { saturationWindow: 8, challengeInterval: 2 },
    archive: { capacity: 23, minimumNovelty: 0.17 },
    lateMemory: { recallLimit: 3, weight: 0.19 },
  };
}

test("Genome composition tightens morphology without changing one physical resource permission", () => {
  const project = structuredClone(DEFAULT_SEARCH_PROFILE);
  project.nursery.saturationWindow = 20;
  project.nursery.challengeInterval = 7;
  const composed = composeGenomeRuntime(project, 0.11, profile());

  assert.deepEqual(composed.searchProfile.resources, project.resources);
  assert.equal(composed.searchProfile.attemptSafetyCeiling, project.attemptSafetyCeiling);
  assert.equal(composed.searchProfile.nursery.minimumAttempts, project.nursery.minimumAttempts);
  assert.equal(composed.searchProfile.nursery.independentLineages, project.nursery.independentLineages);
  assert.equal(composed.searchProfile.nursery.saturationWindow, 8);
  assert.equal(composed.searchProfile.nursery.challengeInterval, 2);
  assert.deepEqual(composed.archive, { capacity: 23, minimumNovelty: 0.17 });
  assert.deepEqual(composed.growthPolicy.lateMemory, { recallLimit: 3, maximumWeight: 0.11 });
  assert.equal(composed.growthPolicy.genomeRuntimeProfileDigest, profile().profileDigest);
});

test("without a promoted Genome composition preserves the built-in runtime behavior", () => {
  const composed = composeGenomeRuntime(DEFAULT_SEARCH_PROFILE, 0.2);
  assert.deepEqual(composed.searchProfile, DEFAULT_SEARCH_PROFILE);
  assert.deepEqual(composed.archive, { capacity: 4_096, minimumNovelty: 0 });
  assert.deepEqual(composed.growthPolicy.lateMemory, { recallLimit: 12, maximumWeight: 0.2 });
  assert.equal(composed.growthPolicy.source, "built-in-baseline");
  assert.equal(composed.growthPolicy.genomeRuntimeProfileDigest, undefined);
});

test("a promoted Genome cannot widen the built-in late-memory exposure boundary", () => {
  const base = profile();
  const expansive: GenomeRuntimeProfile = {
    ...base,
    lateMemory: { recallLimit: 32, weight: 0.8 },
  };

  const composed = composeGenomeRuntime(DEFAULT_SEARCH_PROFILE, 0.2, expansive);

  assert.deepEqual(composed.growthPolicy.lateMemory, {
    recallLimit: 12,
    maximumWeight: 0.2,
  });
});
