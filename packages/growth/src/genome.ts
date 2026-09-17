import type { KeyObject } from "node:crypto";
import {
  decodeDsseJson,
  signJsonDsse,
  verifyDsse,
} from "@jevyr/core";
import {
  digestJson,
  isSha256Digest,
  type DsseEnvelope,
  type JsonValue,
} from "@jevyr/protocol";
import {
  GENOME_PROMOTION_PAYLOAD_TYPE,
  GENOME_PROTOCOL,
  GROWTH_PROPOSAL_PROTOCOL,
  type BenchmarkObservation,
  type DamageTrial,
  type GenomeAdmissionPolicy,
  type GenomeBody,
  type GenomeModule,
  type GenomePromotionPayload,
  type GrowthProposal,
  type PromotedGenome,
  type StoredGenome,
} from "./types.js";

export const DEFAULT_GENOME_ADMISSION_POLICY: GenomeAdmissionPolicy =
  Object.freeze({
    requiredSuites: Object.freeze([
      "bone-invariants",
      "historical-regressions",
      "held-out-adversarial",
      "anchoring-contamination",
      "resource-bounds",
    ]),
    maximumHeldOutRegression: 0,
    minimumMaterialGain: 0.01,
    minimumDamageTrials: 4,
    minimumNovelty: 0.02,
  });

function validateModule(module: GenomeModule) {
  if (!module.id.trim()) throw new TypeError("Genome module id cannot be empty.");
  if (!module.version.trim())
    throw new TypeError("Genome module version cannot be empty.");
  if (!isSha256Digest(module.artifactDigest))
    throw new TypeError("Genome module artifactDigest must be a SHA-256 digest.");
  if (!module.publicPurpose.trim())
    throw new TypeError("Genome module publicPurpose cannot be empty.");
}

function freezeBody(body: GenomeBody): GenomeBody {
  const modules = body.modules.map((module) =>
    Object.freeze({
      ...module,
      permissions: Object.freeze([...module.permissions]),
    }),
  );
  const ids = new Set<string>();
  for (const module of modules) {
    validateModule(module);
    if (ids.has(module.id))
      throw new TypeError("Genome module ids must be unique.");
    ids.add(module.id);
  }
  if (!Number.isInteger(body.generation) || body.generation < 0)
    throw new RangeError("Genome generation must be a non-negative integer.");
  if (!isSha256Digest(body.boneDigest))
    throw new TypeError("Genome boneDigest must be a SHA-256 digest.");
  if (!body.parentDigests.every(isSha256Digest))
    throw new TypeError("Every parent digest must be a SHA-256 digest.");
  return Object.freeze({
    protocol: GENOME_PROTOCOL,
    generation: body.generation,
    boneDigest: body.boneDigest,
    parentDigests: Object.freeze([...body.parentDigests]),
    modules: Object.freeze(modules),
    parameters: Object.freeze(structuredClone(body.parameters)),
  });
}

export function createGenome(body: GenomeBody): StoredGenome {
  const frozen = freezeBody(body);
  const digest = digestJson(frozen as unknown as JsonValue);
  return Object.freeze({ digest, body: frozen });
}

export interface DescendantMutation {
  modules?: readonly GenomeModule[];
  parameters?: Readonly<Record<string, JsonValue>>;
}

/**
 * Creates an offspring value. The parent is immutable and its Bone digest is
 * copied, never proposed as a mutation target.
 */
export function createDescendant(
  parent: StoredGenome,
  mutation: DescendantMutation,
): StoredGenome {
  assertGenomeDigest(parent);
  return createGenome({
    protocol: GENOME_PROTOCOL,
    generation: parent.body.generation + 1,
    boneDigest: parent.body.boneDigest,
    parentDigests: Object.freeze([parent.digest]),
    modules: mutation.modules ?? parent.body.modules,
    parameters: mutation.parameters ?? parent.body.parameters,
  });
}

export function assertGenomeDigest(genome: StoredGenome) {
  const actual = digestJson(genome.body as unknown as JsonValue);
  if (actual !== genome.digest)
    throw new Error("Genome body does not match its content digest.");
}

function evidenceIsValid(
  observations: readonly BenchmarkObservation[],
  trials: readonly DamageTrial[],
) {
  return [...observations, ...trials].every((entry) =>
    isSha256Digest(entry.evidenceDigest),
  );
}

export function stageDescendant(
  parent: StoredGenome,
  descendant: StoredGenome,
  benchmarkEvidence: readonly BenchmarkObservation[],
  damageEvidence: readonly DamageTrial[],
  novelty: number,
  policy: GenomeAdmissionPolicy = DEFAULT_GENOME_ADMISSION_POLICY,
): GrowthProposal {
  assertGenomeDigest(parent);
  assertGenomeDigest(descendant);
  const reasons: string[] = [];

  if (!descendant.body.parentDigests.includes(parent.digest))
    reasons.push("descendant lineage does not name the supplied parent");
  if (descendant.body.generation !== parent.body.generation + 1)
    reasons.push("descendant generation is not exactly one step after its parent");
  if (descendant.body.boneDigest !== parent.body.boneDigest)
    reasons.push("Bone mutation is constitutionally inadmissible");
  if (!evidenceIsValid(benchmarkEvidence, damageEvidence))
    reasons.push("all benchmark and damage observations require evidence digests");
  if (!Number.isFinite(novelty) || novelty < policy.minimumNovelty)
    reasons.push("descendant does not meet the minimum novelty criterion");

  for (const suite of policy.requiredSuites) {
    if (!benchmarkEvidence.some((observation) => observation.suite === suite))
      reasons.push("required benchmark suite is absent: " + suite);
  }
  for (const observation of benchmarkEvidence) {
    if (!Number.isFinite(observation.score) || !Number.isFinite(observation.parentScore)) {
      reasons.push("benchmark scores must be finite: " + observation.suite);
      continue;
    }
    if (observation.invariant && !observation.passed)
      reasons.push("constitutional invariant failed: " + observation.suite);
    if (
      observation.heldOut &&
      observation.score <
        observation.parentScore - policy.maximumHeldOutRegression
    )
      reasons.push("held-out regression exceeded tolerance: " + observation.suite);
  }
  if (
    !benchmarkEvidence.some(
      (observation) =>
        observation.passed &&
        observation.score - observation.parentScore >= policy.minimumMaterialGain,
    )
  )
    reasons.push("no benchmark shows a material gain over the parent");

  const validDamage = damageEvidence.filter(
    (trial) => trial.passed && trial.recoveredToBone,
  );
  if (validDamage.length < policy.minimumDamageTrials)
    reasons.push("insufficient damage trials recovered to Bone");

  const evidence = Object.freeze(
    benchmarkEvidence.map((observation) =>
      Object.freeze({ ...observation }),
    ),
  );
  const damage = Object.freeze(
    damageEvidence.map((trial) => Object.freeze({ ...trial })),
  );
  const decision = reasons.length === 0 ? "STAGED" : "REJECTED";
  const proposalBody = {
    protocol: GROWTH_PROPOSAL_PROTOCOL,
    parentDigest: parent.digest,
    descendant,
    benchmarkEvidence: evidence,
    damageEvidence: damage,
    novelty,
    decision,
    reasons,
  } as unknown as JsonValue;
  const proposalDigest = digestJson(proposalBody);
  return Object.freeze({
    protocol: GROWTH_PROPOSAL_PROTOCOL,
    proposalDigest,
    parentDigest: parent.digest,
    descendant,
    benchmarkEvidence: evidence,
    damageEvidence: damage,
    novelty,
    decision,
    reasons: Object.freeze(reasons),
  });
}

export function genomePromotionPayload(
  proposal: GrowthProposal,
): GenomePromotionPayload {
  if (proposal.decision !== "STAGED")
    throw new Error("A rejected descendant cannot be promoted.");
  return Object.freeze({
    protocol: "jevyr.genome-promotion/1",
    proposalDigest: proposal.proposalDigest,
    descendantDigest: proposal.descendant.digest,
    scope: "GOVERNANCE_ONLY",
  });
}

export function signGenomePromotion(
  proposal: GrowthProposal,
  privateKey: KeyObject | string,
  keyId?: string,
): DsseEnvelope {
  return signJsonDsse(
    GENOME_PROMOTION_PAYLOAD_TYPE,
    genomePromotionPayload(proposal) as unknown as JsonValue,
    privateKey,
    keyId,
  );
}

export function promoteGenome(
  proposal: GrowthProposal,
  attestation: DsseEnvelope,
  governanceKeys: ReadonlyMap<string, KeyObject | string>,
): PromotedGenome {
  if (proposal.decision !== "STAGED")
    throw new Error("A rejected descendant cannot be promoted.");
  if (attestation.payloadType !== GENOME_PROMOTION_PAYLOAD_TYPE)
    throw new Error("Promotion attestation has the wrong payload type.");
  if (!verifyDsse(attestation, governanceKeys))
    throw new Error("Promotion attestation signature is invalid.");
  const payload = decodeDsseJson<GenomePromotionPayload>(attestation);
  if (
    payload.protocol !== "jevyr.genome-promotion/1" ||
    payload.scope !== "GOVERNANCE_ONLY" ||
    payload.proposalDigest !== proposal.proposalDigest ||
    payload.descendantDigest !== proposal.descendant.digest
  )
    throw new Error("Promotion attestation does not bind this descendant.");
  return Object.freeze({
    genome: proposal.descendant,
    proposalDigest: proposal.proposalDigest,
    attestation,
    promoted: true,
  });
}

export interface GenomeDiff {
  added: readonly GenomeModule[];
  removed: readonly GenomeModule[];
  changed: readonly { before: GenomeModule; after: GenomeModule }[];
  parameterKeysChanged: readonly string[];
}

export function diffGenomes(
  parent: StoredGenome,
  descendant: StoredGenome,
): GenomeDiff {
  const before = new Map(parent.body.modules.map((module) => [module.id, module]));
  const after = new Map(descendant.body.modules.map((module) => [module.id, module]));
  const added = [...after.values()].filter((module) => !before.has(module.id));
  const removed = [...before.values()].filter((module) => !after.has(module.id));
  const changed = [...before.entries()]
    .filter(([id, module]) => {
      const next = after.get(id);
      return (
        next !== undefined &&
        digestJson(module as unknown as JsonValue) !==
          digestJson(next as unknown as JsonValue)
      );
    })
    .map(([id, module]) => ({
      before: module,
      after: after.get(id) as GenomeModule,
    }));
  const keys = new Set([
    ...Object.keys(parent.body.parameters),
    ...Object.keys(descendant.body.parameters),
  ]);
  const parameterKeysChanged = [...keys]
    .filter(
      (key) =>
        digestJson((parent.body.parameters[key] ?? null) as JsonValue) !==
        digestJson((descendant.body.parameters[key] ?? null) as JsonValue),
    )
    .sort();
  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    changed: Object.freeze(changed),
    parameterKeysChanged: Object.freeze(parameterKeysChanged),
  });
}
