import {
  canonicalize,
  digestJson,
  isSha256Digest,
  type JsonValue,
  type SearchNurseryProfile,
} from "@jevyr/protocol";
import type { AssayArchiveGenomeKnobs } from "./assay-frontier.js";

export const RUNTIME_GROWTH_POLICY_PROTOCOL = "jevyr.runtime-growth-policy/1" as const;

export interface LateMemoryRuntimePolicy {
  readonly recallLimit: number;
  readonly maximumWeight: number;
}

export interface RuntimeGrowthPolicyInput {
  readonly source: "built-in-baseline" | "governance-genome";
  readonly genomeRuntimeProfileDigest?: string;
  readonly nursery: SearchNurseryProfile;
  readonly archive: AssayArchiveGenomeKnobs;
  readonly lateMemory: LateMemoryRuntimePolicy;
}

export interface RuntimeGrowthPolicy extends RuntimeGrowthPolicyInput {
  readonly protocol: typeof RUNTIME_GROWTH_POLICY_PROTOCOL;
  readonly digest: string;
}

function positiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${field} must be a positive safe integer`);
  }
}

/** Canonicalize the only growth controls that may alter a sealed run. */
export function compileRuntimeGrowthPolicy(input: RuntimeGrowthPolicyInput): RuntimeGrowthPolicy {
  if (input.source === "governance-genome") {
    if (!isSha256Digest(input.genomeRuntimeProfileDigest)) {
      throw new TypeError("A governance Genome growth policy requires its compiled profile digest");
    }
  } else if (input.genomeRuntimeProfileDigest !== undefined) {
    throw new TypeError("The built-in growth policy cannot claim a Genome profile digest");
  }
  positiveInteger(input.nursery.minimumAttempts, "nursery.minimumAttempts");
  positiveInteger(input.nursery.saturationWindow, "nursery.saturationWindow");
  positiveInteger(input.nursery.independentLineages, "nursery.independentLineages");
  positiveInteger(input.nursery.challengeInterval, "nursery.challengeInterval");
  if (!Number.isSafeInteger(input.archive.capacity) || input.archive.capacity < 1 || input.archive.capacity > 4_096) {
    throw new TypeError("archive.capacity must be a safe integer between 1 and 4096");
  }
  if (!Number.isFinite(input.archive.minimumNovelty) || input.archive.minimumNovelty < 0 || input.archive.minimumNovelty > 1) {
    throw new TypeError("archive.minimumNovelty must be a finite number in [0, 1]");
  }
  if (!Number.isSafeInteger(input.lateMemory.recallLimit) || input.lateMemory.recallLimit < 0 || input.lateMemory.recallLimit > 32) {
    throw new TypeError("lateMemory.recallLimit must be a safe integer between 0 and 32");
  }
  if (!Number.isFinite(input.lateMemory.maximumWeight) || input.lateMemory.maximumWeight < 0 || input.lateMemory.maximumWeight > 0.2) {
    throw new TypeError("lateMemory.maximumWeight must be a finite number in [0, 0.2]");
  }
  if (input.lateMemory.recallLimit === 0 && input.lateMemory.maximumWeight !== 0) {
    throw new TypeError("lateMemory.maximumWeight must be zero when recallLimit is zero");
  }
  const body = Object.freeze({
    protocol: RUNTIME_GROWTH_POLICY_PROTOCOL,
    source: input.source,
    ...(input.genomeRuntimeProfileDigest === undefined
      ? {}
      : { genomeRuntimeProfileDigest: input.genomeRuntimeProfileDigest }),
    nursery: Object.freeze({ ...input.nursery }),
    archive: Object.freeze({ ...input.archive }),
    lateMemory: Object.freeze({ ...input.lateMemory }),
  });
  return Object.freeze({
    ...body,
    digest: digestJson(body as unknown as JsonValue),
  });
}

export function verifyRuntimeGrowthPolicy(value: RuntimeGrowthPolicy): RuntimeGrowthPolicy {
  if (value.protocol !== RUNTIME_GROWTH_POLICY_PROTOCOL || !isSha256Digest(value.digest)) {
    throw new TypeError("Runtime growth policy protocol or digest is invalid");
  }
  const compiled = compileRuntimeGrowthPolicy({
    source: value.source,
    ...(value.genomeRuntimeProfileDigest === undefined
      ? {}
      : { genomeRuntimeProfileDigest: value.genomeRuntimeProfileDigest }),
    nursery: value.nursery,
    archive: value.archive,
    lateMemory: value.lateMemory,
  });
  if (canonicalize(compiled as unknown as JsonValue) !== canonicalize(value as unknown as JsonValue)) {
    throw new TypeError("Runtime growth policy is not canonical");
  }
  return compiled;
}
