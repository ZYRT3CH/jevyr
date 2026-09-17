import type { ReflexPayload } from "@jevyr/protocol";
import { DECISIVE_EVIDENCE_WEIGHT, type CompiledVerdict, type PolicyInput } from "./policy.js";
import { evaluateInvestigationAudits } from "./investigation-audits.js";
import { assessFormalCounterexamples } from "./formal-counterexamples.js";
import { isCandidateScopedAssay, originalSubjectPurpose } from "./original-subject.js";

export interface ReflexOptions {
  loop: 1 | 2;
  canAcquireMaterialEvidence: boolean;
}

export type IntentBoundReflexPayload = ReflexPayload;

/** A deterministic meta-check over evidence coverage, never a second model-authored verdict. */
export function evaluateReflex(provisional: CompiledVerdict, input: PolicyInput, options: ReflexOptions): IntentBoundReflexPayload {
  if (provisional.evidenceDigest !== input.graph.digest()) throw new Error("Reflex received a verdict for a different evidence graph");
  if (provisional.intentContractDigest !== input.intentContractDigest) throw new Error("Reflex received a verdict for a different intent contract");
  const findings: ReflexPayload["materialFindings"][number][] = [];
  const investigation = evaluateInvestigationAudits(input);
  const formal = assessFormalCounterexamples(input);
  const originalSubject = originalSubjectPurpose(input) !== undefined;
  const judgmentAssays = originalSubject ? input.assays.filter(assay => !isCandidateScopedAssay(assay)) : input.assays;
  if (formal.rejectedEvidenceIds.length > 0) findings.push({ code: "FORMAL_PROOF_INVALID", summary: "A formal counterexample failed independent sealed-statement or arithmetic verification.", evidenceIds: formal.rejectedEvidenceIds });
  for (const finding of investigation.findings) findings.push({ code: finding.code, summary: finding.summary, evidenceIds: finding.evidenceIds });

  if (input.obligations.filter((obligation) => obligation.critical).length === 0) {
    findings.push({ code: "NO_CRITICAL_OBLIGATIONS", summary: "No critical obligation was sealed, so acceptance cannot be discriminating.", evidenceIds: [] });
  }
  for (const obligation of [...input.obligations].filter((entry) => entry.critical).sort((a, b) => a.id.localeCompare(b.id))) {
    if (formal.verified.some((proof) => proof.obligationId === obligation.id)) continue;
    if (obligation.assayability === "unassayable") {
      findings.push({ code: "UNASSAYABLE_OBLIGATION", summary: `Critical obligation ${obligation.id} has no truth-conditional oracle.`, evidenceIds: [] });
      continue;
    }
    const support = input.graph.strongestSupport(obligation.id, originalSubject);
    const refutation = input.graph.strongestRefutation(obligation.id, originalSubject);
    if (support.weight < DECISIVE_EVIDENCE_WEIGHT && refutation.weight < DECISIVE_EVIDENCE_WEIGHT) {
      findings.push({ code: "EVIDENCE_AUTHORITY_GAP", summary: `Critical obligation ${obligation.id} has no decisive observation.`, evidenceIds: [...new Set([...support.evidenceIds, ...refutation.evidenceIds])].sort() });
    }
  }
  for (const assay of [...judgmentAssays].filter((entry) => entry.critical && entry.status !== "passed" && entry.status !== "failed").sort((a, b) => a.id.localeCompare(b.id))) {
    findings.push({ code: "UNRESOLVED_ASSAY", summary: `Critical assay ${assay.id} remains ${assay.status}.`, evidenceIds: [...assay.evidenceIds].sort() });
  }
  if (input.candidates.filter((candidate) => candidate.selected).length > 1) {
    findings.push({ code: "AMBIGUOUS_SELECTION", summary: "The run selected multiple candidates.", evidenceIds: [] });
  }

  const challengedNodeIds = [...new Set([
    ...input.obligations.filter((obligation) => obligation.critical).map((obligation) => obligation.id),
    ...judgmentAssays.filter((assay) => assay.critical).map((assay) => assay.id),
  ])].sort();
  const canResolveWithEvidence = findings.some((finding) => finding.code !== "UNASSAYABLE_OBLIGATION");
  const decision: ReflexPayload["decision"] = findings.length === 0
    ? "confirm"
    : options.loop === 1 && options.canAcquireMaterialEvidence && canResolveWithEvidence ? "repeat_once" : "revise";

  return Object.freeze({
    loop: options.loop,
    reviewedEvidenceDigest: provisional.evidenceDigest,
    challengedNodeIds,
    materialFindings: findings.sort((a, b) => a.code.localeCompare(b.code) || a.summary.localeCompare(b.summary)),
    decision,
    intentContractDigest: input.intentContractDigest,
    audits: [...investigation.audits, {
      audit: "evidence_coverage_provenance",
      status: findings.some((finding) => ["NO_CRITICAL_OBLIGATIONS", "UNASSAYABLE_OBLIGATION", "EVIDENCE_AUTHORITY_GAP", "UNRESOLVED_ASSAY"].includes(finding.code)) ? "failed" as const : "passed" as const,
      summary: formal.verified.length === 0
        ? "Checked sealed critical obligations against independently admitted execution edges and assay completion."
        : "Checked sealed critical obligations against independently admitted execution edges, verified formal counterexamples, and assay completion.",
      evidenceIds: [...new Set([...formal.verified.map((proof) => proof.evidenceId), ...input.obligations.flatMap((obligation) => [...input.graph.strongestSupport(obligation.id, originalSubject).evidenceIds, ...input.graph.strongestRefutation(obligation.id, originalSubject).evidenceIds])])].sort(),
    }].sort((a, b) => a.audit.localeCompare(b.audit)),
  });
}

export function assertReflexComplete(verdict: CompiledVerdict, reports: readonly IntentBoundReflexPayload[]): IntentBoundReflexPayload {
  if (reports.length === 0) throw new Error("A Jevyr record cannot crystallize without the mandatory Reflex evaluation");
  if (reports.length > 2) throw new Error("Reflex is hard-capped at two loops");
  if (reports[0]?.loop !== 1 || (reports.length === 2 && reports[1]?.loop !== 2)) throw new Error("Reflex loops must be contiguous and begin at one");
  if (reports.at(-1)?.reviewedEvidenceDigest !== verdict.evidenceDigest) throw new Error("The final Reflex loop reviewed a different evidence graph than the final verdict");
  if (reports.at(-1)?.intentContractDigest !== verdict.intentContractDigest) throw new Error("The final Reflex loop reviewed a different intent contract than the final verdict");
  if (reports[0]?.decision === "repeat_once" && reports.length !== 2) throw new Error("Reflex requested its one permitted repeat, but the repeat is absent");
  const final = reports.at(-1);
  if (final?.decision === "repeat_once") throw new Error("The second Reflex loop may not request a third loop");
  if (final && final.materialFindings.length > 0 && verdict.judgment === "ACCEPT") throw new Error("The final Reflex has unresolved material findings; its required downgrade was not applied");
  return final as IntentBoundReflexPayload;
}
