import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { GenomeRegistry } from "@jevyr/growth";
import type { DaemonRuntime } from "./runtime.js";
import { readSelfJudgeRequests } from "./self-judge-inspection.js";

/** Public inspection only; the startup selection remains bound until restart. */
export async function readGenomeLab(runtime: DaemonRuntime): Promise<unknown> {
  const registry = new GenomeRegistry(runtime.genome.registryRoot);
  const selfJudgment = await readSelfJudgeRequests(registry.root);
  let names: string[];
  try { names = (await readdir(join(registry.root, "proposals"))).filter((name) => /^[a-f0-9]{64}\.json$/u.test(name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const offspring = await Promise.all(names.slice(0, 256).map(async (name) => {
    const proposal = await registry.readProposal(`sha256:${name.slice(0, -5)}`);
    return { proposalDigest: proposal.proposalDigest, parentDigest: proposal.parentDigest, genomeDigest: proposal.descendant.digest,
      decision: proposal.decision, reasons: proposal.reasons, benchmarkEvidence: proposal.benchmarkEvidence, damageEvidence: proposal.damageEvidence };
  }));
  return {
    protocol: "jevyr.genome-lab/1",
    active: { version: runtime.repository.genomeVersion, digest: runtime.repository.genomeDigest, source: runtime.genome.source, selectionDigest: runtime.genome.descriptorDigest, descriptor: runtime.genome.descriptor },
    preset: { mode: runtime.preset.signed ? "preset" : "wild", selectionDigest: runtime.preset.descriptorDigest, descriptor: runtime.preset.descriptor, applies: "next-runtime-startup" },
    governance: { startupBound: true, requiresBenchmarkEvidence: true, requiresGovernanceSignature: true, semanticPromotion: false },
    offspring, selfJudgmentRequests: selfJudgment.requests, truncated: names.length > 256 || selfJudgment.truncated,
  };
}
