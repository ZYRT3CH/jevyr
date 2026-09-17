import { constants } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUILTIN_GENOME_MODULE_CATALOG, GenomeRegistry, compileGenomeRuntimeProfile, createDescendant, createGenome, stageDescendant, type StoredGenome } from "@jevyr/growth";
import { canonicalize, digestJson, type JsonValue } from "@jevyr/protocol";
import type { SelfJudgeFailure } from "./self-judge.js";

const SHA = /^sha256:[a-f0-9]{64}$/u;
export interface SelfJudgeProposalSource {
  readonly manifestDigest: string;
  readonly caseId: string;
  readonly runDigest: string;
  readonly recordDigest?: string;
  readonly failures: readonly SelfJudgeFailure[];
}
export interface SelfJudgeProposalOptions {
  readonly registryRoot: string;
  readonly boneDigest: string;
  readonly sourceGenomeDigest: string;
  readonly activeGenome?: StoredGenome;
}
export interface SelfJudgeOffspringRequest {
  readonly protocol: "jevyr.self-judge-offspring-request/1";
  readonly source: { readonly manifestDigest: string; readonly caseId: string; readonly runDigest: string; readonly recordDigest: string | null; readonly genomeDigest: string };
  readonly failures: readonly SelfJudgeFailure[];
  readonly candidateGenomeDigest: string;
  readonly parentGenomeDigest: string | null;
  readonly growthProposalDigest: string | null;
  readonly decision: "REJECTED_PENDING_BENCHMARKS" | "REQUESTED_NO_GOVERNED_PARENT";
  readonly proposedChange: string;
  readonly benchmarkEvidence: readonly [];
  readonly damageEvidence: readonly [];
  readonly governanceSignature: null;
  readonly activeGenomeChanged: false;
  readonly digest: string;
}

function checkSource(source: SelfJudgeProposalSource): void {
  if (!SHA.test(source.manifestDigest) || !SHA.test(source.runDigest) || source.recordDigest !== undefined && !SHA.test(source.recordDigest) || !/^case_[a-f0-9]{16}$/u.test(source.caseId) || !Array.isArray(source.failures) || source.failures.length < 1 || source.failures.length > 64 || source.failures.some(failure => failure === null || typeof failure !== "object" || !/^[A-Z][A-Z0-9_]{1,127}$/u.test(failure.code) || !SHA.test(failure.evidenceDigest))) throw new TypeError("Self-judgment proposal requires a bounded verified source and failure evidence");
  const ids = source.failures.map(failure => `${failure.code}:${failure.evidenceDigest}`);
  if (new Set(ids).size !== ids.length) throw new TypeError("Self-judgment failure evidence must be unique");
}

async function storeRequest(root: string, request: SelfJudgeOffspringRequest): Promise<void> {
  const directory = join(root, "self-judge-requests"); await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== resolve(directory)) throw new Error("Self-judgment request directory must not be an alias");
  const path = join(directory, `${request.digest.slice(7)}.json`), bytes = canonicalize(request as unknown as JsonValue);
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { const info = await existing.stat(); if (!info.isFile() || info.nlink !== 1 || info.size !== Buffer.byteLength(bytes) || await existing.readFile("utf8") !== bytes) throw new Error("Existing self-judgment request differs from its content address"); }
    finally { await existing.close(); }
    return;
  }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

/** Failure intake only. This helper has no governance key or activation operation. */
export function createSelfJudgeProposalRecorder(options: SelfJudgeProposalOptions): (source: SelfJudgeProposalSource) => Promise<SelfJudgeOffspringRequest> {
  options = Object.freeze({ ...options });
  if (!SHA.test(options.boneDigest) || !SHA.test(options.sourceGenomeDigest)) throw new TypeError("Self-judgment Genome bindings must be digests");
  const root = resolve(options.registryRoot), registry = new GenomeRegistry(root);
  const parent = options.activeGenome === undefined ? undefined : structuredClone(options.activeGenome);
  if (parent !== undefined) {
    compileGenomeRuntimeProfile(parent, { expectedBoneDigest: options.boneDigest });
    if (parent.digest !== options.sourceGenomeDigest) throw new TypeError("Self-judgment parent differs from the sealed startup Genome");
  }
  let queue: Promise<unknown> = Promise.resolve();
  return source => {
    checkSource(source);
    const captured = structuredClone(source);
    const operation = queue.then(async () => {
      await registry.initialize();
      let candidate: StoredGenome, proposalDigest: string | null = null, proposedChange: string;
      if (parent !== undefined) {
        const parameters: Record<string, JsonValue> = { ...structuredClone(parent.body.parameters) };
        const value = parameters["jevyr.nursery-governor"];
        const nursery = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : undefined;
        if (nursery !== undefined && typeof nursery.challengeInterval === "number") {
          const next = Math.max(1, nursery.challengeInterval - 1);
          parameters["jevyr.nursery-governor"] = { ...nursery, challengeInterval: next };
          proposedChange = next === nursery.challengeInterval ? "Existing challenge cadence is already at its minimum; review-only descendant awaiting a measured repair." : `Propose challenge interval ${nursery.challengeInterval} → ${next}; efficacy is unmeasured.`;
        } else proposedChange = "No existing nursery parameter can be tightened; review-only descendant awaiting a measured repair.";
        candidate = createDescendant(parent, { parameters });
        compileGenomeRuntimeProfile(candidate, { expectedBoneDigest: options.boneDigest });
        const proposal = stageDescendant(parent, candidate, [], [], 0);
        if (proposal.decision !== "REJECTED") throw new Error("Unmeasured self-judgment offspring must remain rejected");
        await registry.storeGenome(parent); await registry.storeGenome(candidate); await registry.storeProposal(proposal);
        proposalDigest = proposal.proposalDigest;
      } else {
        const parameters = Object.fromEntries(BUILTIN_GENOME_MODULE_CATALOG.map(entry => [entry.module.id, Object.fromEntries(Object.entries(entry.descriptor.parameters).map(([key, value]) => [key, value.default]))]));
        candidate = createGenome({ protocol: "jevyr.genome/1", generation: 0, boneDigest: options.boneDigest, parentDigests: [], modules: BUILTIN_GENOME_MODULE_CATALOG.map(entry => entry.module), parameters });
        compileGenomeRuntimeProfile(candidate, { expectedBoneDigest: options.boneDigest });
        await registry.storeGenome(candidate);
        proposedChange = "Request a governed parent and a measured repair using the three existing built-in modules; the static startup descriptor is not fabricated into a promoted lineage.";
      }
      const body = { protocol: "jevyr.self-judge-offspring-request/1" as const, source: { manifestDigest: captured.manifestDigest, caseId: captured.caseId, runDigest: captured.runDigest, recordDigest: captured.recordDigest ?? null, genomeDigest: options.sourceGenomeDigest }, failures: captured.failures, candidateGenomeDigest: candidate.digest, parentGenomeDigest: parent?.digest ?? null, growthProposalDigest: proposalDigest, decision: parent === undefined ? "REQUESTED_NO_GOVERNED_PARENT" as const : "REJECTED_PENDING_BENCHMARKS" as const, proposedChange, benchmarkEvidence: [] as const, damageEvidence: [] as const, governanceSignature: null, activeGenomeChanged: false as const };
      const request = { ...body, digest: digestJson(body as unknown as JsonValue) };
      await storeRequest(root, request);
      return Object.freeze(request);
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
}
