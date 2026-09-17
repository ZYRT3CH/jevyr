import { LIFECYCLE_STAGES, type CaseEvent, type InvestigationAuditReceipt, type ReflexPayload } from "@jevyr/protocol";
import type { PolicyInput } from "./policy.js";
import { originalSubjectPurpose } from "./original-subject.js";

export interface InvestigationAuditFinding {
  code: string;
  summary: string;
  evidenceIds: readonly string[];
  impact: "unproven" | "invalid";
}

type Receipt<K extends InvestigationAuditReceipt["kind"]> = { id: string; receipt: Extract<InvestigationAuditReceipt, { kind: K }> };
type Audit = NonNullable<ReflexPayload["audits"]>[number];

/** The ledger contains host-observed commitments, never a model's independence score. */
export function evaluateInvestigationAudits(input: PolicyInput): { findings: readonly InvestigationAuditFinding[]; audits: readonly Audit[] } {
  const findings: InvestigationAuditFinding[] = [];
  const audits: Audit[] = [];
  const events = input.auditEvents ?? [];
  const nodes = input.graph.snapshot().nodes;
  const receipts = <K extends InvestigationAuditReceipt["kind"]>(kind: K): Receipt<K>[] => nodes.flatMap((node) => {
    if (node.authority !== "deterministic_tool" || node.metadata === null || typeof node.metadata !== "object" || Array.isArray(node.metadata)) return [];
    const receipt = (node.metadata as Record<string, unknown>).audit as InvestigationAuditReceipt | undefined;
    return receipt?.kind === kind ? [{ id: node.id, receipt: receipt as Extract<InvestigationAuditReceipt, { kind: K }> }] : [];
  });
  const add = (code: string, summary: string, evidenceIds: readonly string[], impact: InvestigationAuditFinding["impact"] = "unproven") => findings.push({ code, summary, evidenceIds: [...new Set(evidenceIds)].sort(), impact });
  const report = (audit: string, status: Audit["status"], summary: string, evidenceIds: readonly string[] = []) => audits.push({ audit, status, summary, evidenceIds: [...new Set(evidenceIds)].sort() });
  const lineages = receipts("lineage_commitment");
  const commitmentIds = lineages.map((entry) => entry.id);
  const providers = new Set(lineages.map((entry) => entry.receipt.providerId));
  const models = new Set(lineages.map((entry) => `${entry.receipt.providerId}/${entry.receipt.modelId}`));
  const seeds = new Set(lineages.map((entry) => entry.receipt.seedCommitment));
  const lineageIds = new Set(lineages.map((entry) => entry.receipt.lineageId));
  const seedVerified = lineages.length > 0 && lineages.every((entry) => entry.receipt.seedEnforcement === "honored");
  report("provider_seed_lineage_correlation", lineages.length < 2 || !seedVerified ? "unmeasured" : providers.size < 2 || seeds.size < lineages.length || lineageIds.size < lineages.length ? "failed" : "passed",
    lineages.length === 0 ? "No runtime lineage commitments were recorded; independence is unmeasured."
      : `${lineages.length} invocation commitments disclose ${providers.size} provider(s), ${models.size} model(s), ${seeds.size} seed(s), and ${lineageIds.size} lineage(s). Seed enforcement is ${seedVerified ? "observed" : "unverified"}; distinct names do not establish statistical independence.`, commitmentIds);
  for (const entry of lineages) {
    if (entry.receipt.visibleCandidateIds.length > 0) add("BLIND_LINEAGE_LEAK", `Blind lineage ${entry.receipt.lineageId} saw earlier candidate commitments.`, [entry.id], "invalid");
    if (entry.receipt.memoryDigests.length > 0) add("FIRST_WAVE_MEMORY_CONTAMINATION", `Blind lineage ${entry.receipt.lineageId} received memory before committing.`, [entry.id], "invalid");
  }

  const candidateEvents = events.filter((event): event is CaseEvent<"candidate.status"> => event.kind === "candidate.status");
  const divergenceClosed = events.find((event) => event.kind === "stage.status" && event.stage === "diverge" && event.payload.status === "completed")?.sequence;
  const earlySelections = candidateEvents.filter((event) => event.payload.status === "selected" && divergenceClosed !== undefined && event.sequence < divergenceClosed);
  for (const event of earlySelections) add("PREMATURE_CONVERGENCE", `Candidate ${event.payload.candidateId} was selected before blind divergence closed.`, [event.payload.candidateId]);
  const roots = new Set(lineages.flatMap((entry) => entry.receipt.candidateIds));
  report("premature_convergence", earlySelections.length ? "failed" : roots.size < 2 ? "unmeasured" : "passed", earlySelections.length ? "Selection preceded the blind commitment boundary." : roots.size < 2 ? "Fewer than two committed candidate roots are disclosed; competing initial conditions were not demonstrated." : "Multiple initial candidate commitments precede selection.", commitmentIds);

  const boundaries = receipts("evaluator_boundary");
  for (const { id, receipt } of boundaries) {
    if (receipt.sealedOracleDigest !== receipt.appliedOracleDigest || receipt.untrustedOracleInput) add("EVALUATOR_ORACLE_MUTATION", "The evaluator used an altered oracle or accepted oracle instructions from the evaluated material.", [id], "invalid");
    if (receipt.builderId === receipt.evaluatorId) add("EVALUATOR_BUILDER_OVERLAP", "Builder and evaluator have the same runtime identity; an independent evaluation is missing.", [id]);
  }
  report("evaluator_gaming", boundaries.length === 0 ? "unmeasured" : findings.some((entry) => entry.code.startsWith("EVALUATOR_")) ? "failed" : "passed", boundaries.length ? "Compared runtime builder/evaluator identities and sealed/applied oracle digests." : "No runtime evaluator-boundary receipt was recorded.", boundaries.map((entry) => entry.id));

  const assumptions = receipts("assumption_check");
  for (const { id, receipt } of assumptions) if (receipt.sealedAssumptionsDigest !== receipt.appliedAssumptionsDigest) add("HIDDEN_ASSUMPTION_CHANGE", "Applied assumptions differ from their sealed commitment.", [id], "invalid");
  const lineageAssumptions = new Set(lineages.map((entry) => entry.receipt.assumptionDigest));
  if (lineageAssumptions.size > 1) add("LINEAGE_ASSUMPTION_DRIFT", "Blind lineages received different assumption commitments without a sealed comparison.", commitmentIds);
  report("hidden_assumption_changes", assumptions.length === 0 ? "unmeasured" : findings.some((entry) => entry.code.includes("ASSUMPTION")) ? "failed" : "passed", assumptions.length ? "Compared applied assumptions with their sealed commitments." : "No runtime assumption-check receipt was recorded.", assumptions.map((entry) => entry.id));

  const memories = receipts("memory_validation");
  const contaminated = new Set(memories.filter((entry) => entry.receipt.contaminated).map((entry) => entry.receipt.memoryDigest));
  let changed = true;
  while (changed) {
    changed = false;
    for (const { receipt } of memories) if (!contaminated.has(receipt.memoryDigest) && receipt.derivedFromDigests.some((digest) => contaminated.has(digest))) { contaminated.add(receipt.memoryDigest); changed = true; }
  }
  const influences = events.filter((event): event is CaseEvent<"memory.influence"> => event.kind === "memory.influence");
  for (const event of influences) {
    if (LIFECYCLE_STAGES.indexOf(event.stage) < LIFECYCLE_STAGES.indexOf("recombine") || (divergenceClosed !== undefined && event.sequence < divergenceClosed)) add("FIRST_WAVE_MEMORY_CONTAMINATION", "A memory influence crossed the amnesic first-wave boundary.", [], "invalid");
    if (event.payload.weight > 0.2) add("MEMORY_WEIGHT_EXCEEDED", "Memory influence exceeded the constitutional 0.2 maximum.", [], "invalid");
    if (contaminated.has(event.payload.memoryDigest)) add("TRANSITIVE_MEMORY_CONTAMINATION", "An influential memory depends transitively on an invalidated memory.", memories.filter((entry) => contaminated.has(entry.receipt.memoryDigest)).map((entry) => entry.id), "invalid");
  }
  const missingMemoryChecks = influences.some((event) => !memories.some((entry) => entry.receipt.memoryDigest === event.payload.memoryDigest));
  report("memory_contamination", findings.some((entry) => entry.code.includes("MEMORY")) ? "failed" : missingMemoryChecks ? "unmeasured" : "passed", missingMemoryChecks ? "Influential memory lacks a current validation receipt; provenance closure is unmeasured." : "Checked first-wave timing, influence limits, and recorded transitive invalidation closure.", memories.map((entry) => entry.id));

  for (const axis of ["preference_wording", "initial_condition"] as const) {
    const probes = receipts("paired_probe").filter((entry) => entry.receipt.axis === axis);
    const pairs = new Set(probes.map((entry) => entry.receipt.pairId));
    let measured = 0;
    let failed = false;
    for (const pairId of pairs) {
      const pair = probes.filter((entry) => entry.receipt.pairId === pairId);
      const baseline = pair.filter((entry) => entry.receipt.arm === "baseline");
      const variant = pair.filter((entry) => entry.receipt.arm === "variant");
      if (baseline.length !== 1 || variant.length !== 1) continue;
      const left = baseline[0]!.receipt;
      const right = variant[0]!.receipt;
      if (left.obligationDigest !== right.obligationDigest || left.evidenceDigest !== right.evidenceDigest) continue;
      measured += 1;
      if (left.outcomeDigest !== right.outcomeDigest) {
        failed = true;
        add(axis === "preference_wording" ? "PREFERENCE_WORDING_SENSITIVITY" : "INITIAL_CONDITION_ANCHORING", `Paired ${axis} probe changed its outcome while obligations and admissible evidence remained identical.`, pair.map((entry) => entry.id));
      }
    }
    report(axis, failed ? "failed" : measured ? "passed" : "unmeasured", measured ? `Compared ${measured} complete paired probe(s) with identical obligations and evidence.` : "No complete paired probe with identical obligations and evidence was recorded.", probes.map((entry) => entry.id));
  }

  const terminals = receipts("terminal_claim");
  for (const { id, receipt } of terminals) {
    const support = input.graph.strongestSupport(receipt.claimId, originalSubjectPurpose(input)?.obligationId === receipt.claimId);
    const cited = receipt.evidenceIds.filter((evidenceId) => support.evidenceIds.includes(evidenceId));
    if (support.weight < 3 || cited.length === 0) add("UNTESTED_TERMINAL_CLAIM", `Terminal claim ${receipt.claimId} has no cited independently verified execution supporting that exact claim.`, [id, ...receipt.evidenceIds]);
  }
  report("untested_terminal_claims", findings.some((entry) => entry.code === "UNTESTED_TERMINAL_CLAIM") ? "failed" : terminals.length ? "passed" : "unmeasured", terminals.length ? "Checked terminal claim citations against authoritative support edges." : "No separately asserted terminal claims were disclosed; sealed critical obligations are checked by the judgment kernel.", terminals.map((entry) => entry.id));
  return { findings: findings.sort((a, b) => a.code.localeCompare(b.code) || a.summary.localeCompare(b.summary)), audits: audits.sort((a, b) => a.audit.localeCompare(b.audit)) };
}
