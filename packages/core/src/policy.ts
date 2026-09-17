import { isSha256Digest, type CaseEvent, type Feasibility, type IntentContract, type JevyrVerdict, type VerdictBasis } from "@jevyr/protocol";
import { EvidenceGraph } from "./evidence.js";
import { evaluateInvestigationAudits } from "./investigation-audits.js";
import { assessFormalCounterexamples } from "./formal-counterexamples.js";
import { assertPolicyParity, evaluateWasmPolicy } from "./wasm-policy.js";
import { isCandidateScopedAssay, originalSubjectPurpose, type OriginalSubjectContext } from "./original-subject.js";

export const DEFAULT_POLICY_VERSION = "jevyr.bone/1" as const;
export const DECISIVE_EVIDENCE_WEIGHT = 3;

export interface Obligation {
  id: string;
  statement: string;
  critical: boolean;
  /** Legacy callers default to assayable; compiled intent contracts always set this explicitly. */
  assayability?: "assayable" | "unassayable";
}

export interface CandidateAssessment {
  id: string;
  feasibility: Feasibility;
  survived: boolean;
  selected: boolean;
  embodiment: "built" | "not_built" | "failed";
}

export interface AssayAssessment {
  id: string;
  status: "planned" | "running" | "passed" | "failed" | "inconclusive" | "blocked";
  critical: boolean;
  evidenceIds: readonly string[];
  obligationId?: string;
  candidateId?: string;
  scope?: "closed_population";
  populationIds?: readonly string[];
}

export interface IntegrityIssue {
  code: string;
  summary: string;
  severity: "warning" | "fatal";
  phase: "pre_judgment" | "post_judgment";
  evidenceIds?: readonly string[];
}

export interface PolicyInput {
  policyVersion?: string;
  /** Digest of the immutable intent contract from which obligations were compiled. */
  intentContractDigest: string;
  /** Needed only for mathematical authority; every semantic qualifier stays bound. */
  intentContract?: IntentContract;
  formalProofKernelDigest?: string;
  originalSubjectContext?: OriginalSubjectContext;
  graph: EvidenceGraph;
  obligations: readonly Obligation[];
  candidates: readonly CandidateAssessment[];
  assays: readonly AssayAssessment[];
  integrityIssues?: readonly IntegrityIssue[];
  creationFailed?: boolean;
  /** Host ledger facts used for timing/genealogy checks; never prompt prose. */
  auditEvents?: readonly CaseEvent[];
}

export type CompiledVerdict = JevyrVerdict;

function basis(entry: VerdictBasis): VerdictBasis {
  return {
    ...entry,
    evidenceIds: [...entry.evidenceIds].sort(),
    ...(entry.obligationIds === undefined ? {} : { obligationIds: [...entry.obligationIds].sort() }),
    ...(entry.candidateIds === undefined ? {} : { candidateIds: [...entry.candidateIds].sort() }),
  };
}

function sortedBasis(entries: readonly VerdictBasis[]): readonly VerdictBasis[] {
  return [...entries].map(basis).sort((a, b) => a.code.localeCompare(b.code) || a.summary.localeCompare(b.summary));
}

/**
 * Compiles a verdict entirely from sealed obligations and the evidence graph.
 * The function has no clock, randomness, I/O, model call, or human-preference input.
 */
export function compileVerdict(input: PolicyInput): CompiledVerdict {
  if (!isSha256Digest(input.intentContractDigest)) throw new TypeError("Policy input requires a valid intentContractDigest");
  const issues = [...(input.integrityIssues ?? [])].sort((a, b) => a.code.localeCompare(b.code));
  const formal = assessFormalCounterexamples(input);
  const originalSubject = originalSubjectPurpose(input) !== undefined;
  if (formal.rejectedEvidenceIds.length > 0) issues.push({ code: "FORMAL_PROOF_INVALID", summary: "A claimed formal certificate did not bind the exact sealed obligation, controlled grammar, or counterexample arithmetic.", severity: "fatal", phase: "pre_judgment", evidenceIds: formal.rejectedEvidenceIds });
  const fatal = issues.filter((issue) => issue.severity === "fatal");
  const invalidBeforeJudgment = fatal.some((issue) => issue.phase === "pre_judgment");
  const candidates = [...input.candidates].sort((a, b) => a.id.localeCompare(b.id));
  const assays = [...input.assays].sort((a, b) => a.id.localeCompare(b.id));
  const obligations = [...input.obligations].sort((a, b) => a.id.localeCompare(b.id));
  const bases: VerdictBasis[] = [];
  const audit = evaluateInvestigationAudits(input);
  const auditInvalid = audit.findings.some((finding) => finding.impact === "invalid");
  const auditUnproven = audit.findings.some((finding) => finding.impact === "unproven");
  for (const finding of audit.findings) bases.push({ code: `REFLEX_${finding.code}`, summary: finding.summary, evidenceIds: finding.evidenceIds });

  for (const issue of issues) {
    bases.push({ code: `INTEGRITY_${issue.code}`, summary: issue.summary, evidenceIds: issue.evidenceIds ?? [] });
  }

  const surviving = candidates.filter((candidate) => candidate.survived && candidate.feasibility !== "CONTRADICTED");
  const creation = input.creationFailed || candidates.length === 0
    ? "FAILED" as const
    : surviving.length === 0 ? "NO_SURVIVOR" as const : "CONCEIVED" as const;
  if (creation === "FAILED") bases.push({ code: "CREATION_FAILED", summary: originalSubject ? "No assessable candidate was produced; the sealed requirement concerns the unchanged original subject." : "The required creative branch produced no assessable candidate.", evidenceIds: [] });
  if (creation === "NO_SURVIVOR") bases.push({ code: "NO_SURVIVOR", summary: "Every conceived candidate was contradicted or invalidated.", evidenceIds: [], candidateIds: candidates.map((candidate) => candidate.id) });

  const selected = candidates.find((candidate) => candidate.selected);
  const duplicateSelections = candidates.filter((candidate) => candidate.selected).length > 1;
  if (duplicateSelections) bases.push({ code: "MULTIPLE_SELECTIONS", summary: "More than one candidate was marked selected.", evidenceIds: [], candidateIds: candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.id) });
  const embodiment = selected?.embodiment === "built"
    ? "BUILT" as const
    : selected?.embodiment === "failed" || candidates.some((candidate) => candidate.embodiment === "failed")
      ? "FAILED" as const
      : "NOT_BUILT" as const;

  const judgmentAssays = originalSubject ? assays.filter(assay => !isCandidateScopedAssay(assay)) : assays;
  const criticalFailedAssays = judgmentAssays.filter((assay) => assay.critical && assay.status === "failed");
  const criticalOpenAssays = judgmentAssays.filter((assay) => assay.critical && assay.status !== "passed" && assay.status !== "failed");
  if (originalSubject) for (const assay of assays.filter(isCandidateScopedAssay)) bases.push({ code: "CANDIDATE_ASSAY_ASSESSMENT", summary: `Candidate assay ${assay.id} ended ${assay.status}; this assesses generated material and does not adjudicate the unchanged original subject.`, evidenceIds: assay.evidenceIds,
    ...(assay.candidateId === undefined ? assay.populationIds === undefined ? {} : { candidateIds: assay.populationIds } : { candidateIds: [assay.candidateId] }) });
  const unassayable = obligations.filter((obligation) => obligation.critical && obligation.assayability === "unassayable");
  const missingProof: Obligation[] = [];
  const decisiveRefutations: Array<{ obligation: Obligation; evidenceIds: readonly string[] }> = [];

  for (const obligation of obligations.filter((entry) => entry.critical)) {
    const formalRefutations = formal.verified.filter((proof) => proof.obligationId === obligation.id);
    if (formalRefutations.length > 0) {
      bases.push({ code: "FORMAL_COUNTEREXAMPLE_VERIFIED", summary: `The admitted empty input requires a negative output length under the exact sealed mapping requirement; finite output sequences have nonnegative length. This refutes the original obligation: ${obligation.statement}`, evidenceIds: formalRefutations.map((proof) => proof.evidenceId), obligationIds: [obligation.id] });
      continue;
    }
    const support = input.graph.strongestSupport(obligation.id, originalSubject);
    const refutation = input.graph.strongestRefutation(obligation.id, originalSubject);
    if (refutation.weight >= DECISIVE_EVIDENCE_WEIGHT && refutation.weight >= support.weight) {
      decisiveRefutations.push({ obligation, evidenceIds: refutation.evidenceIds });
    } else if (obligation.assayability === "unassayable") {
      bases.push({
        code: "UNASSAYABLE_OBLIGATION",
        summary: `Critical obligation has no truth-conditional oracle: ${obligation.statement}`,
        evidenceIds: [],
        obligationIds: [obligation.id],
      });
    } else if (support.weight < DECISIVE_EVIDENCE_WEIGHT) {
      missingProof.push(obligation);
    }
  }

  for (const entry of decisiveRefutations) {
    bases.push({
      code: "OBLIGATION_REFUTED",
      summary: `Critical obligation was refuted: ${entry.obligation.statement}`,
      evidenceIds: entry.evidenceIds,
      obligationIds: [entry.obligation.id],
    });
  }
  for (const obligation of missingProof) {
    const strongest = input.graph.strongestSupport(obligation.id, originalSubject);
    bases.push({
      code: strongest.weight > 0 ? "INSUFFICIENT_AUTHORITY" : "MISSING_EVIDENCE",
      summary: strongest.weight > 0
        ? `Critical obligation has only non-decisive support: ${obligation.statement}`
        : `Critical obligation is unproven: ${obligation.statement}`,
      evidenceIds: strongest.evidenceIds,
      obligationIds: [obligation.id],
    });
  }
  for (const assay of criticalFailedAssays) {
    bases.push(assay.scope === "closed_population"
      ? { code: "ADMITTED_POPULATION_EXHAUSTED", summary: "Every member of the closed admitted population failed a critical bound assay. This rejects that finite population and makes no impossibility claim about unexamined solutions.", evidenceIds: assay.evidenceIds, candidateIds: assay.populationIds ?? [] }
      : { code: "CRITICAL_ASSAY_FAILED", summary: `Critical assay ${assay.id} failed.`, evidenceIds: assay.evidenceIds, ...(assay.obligationId === undefined ? {} : { obligationIds: [assay.obligationId] }), ...(assay.candidateId === undefined ? {} : { candidateIds: [assay.candidateId] }) });
  }
  for (const assay of criticalOpenAssays) {
    bases.push({ code: "CRITICAL_ASSAY_OPEN", summary: `Critical assay ${assay.id} ended ${assay.status}.`, evidenceIds: assay.evidenceIds, ...(assay.obligationId === undefined ? {} : { obligationIds: [assay.obligationId] }), ...(assay.candidateId === undefined ? {} : { candidateIds: [assay.candidateId] }) });
  }

  if (selected?.feasibility === "CONTRADICTED") {
    bases.push({ code: "SELECTED_CONTRADICTED", summary: "The selected candidate is contradicted by the evidence.", evidenceIds: [], candidateIds: [selected.id] });
  }

  let judgment: JevyrVerdict["judgment"];
  if (invalidBeforeJudgment || auditInvalid) judgment = "NOT_APPLICABLE";
  else if ((!originalSubject && duplicateSelections) || criticalFailedAssays.length > 0 || decisiveRefutations.length > 0 || formal.verified.length > 0 || (!originalSubject && selected?.feasibility === "CONTRADICTED")) judgment = "REJECT";
  else if ((originalSubject && duplicateSelections) || auditUnproven || obligations.filter((entry) => entry.critical).length === 0 || unassayable.length > 0 || missingProof.length > 0 || criticalOpenAssays.length > 0 || (creation !== "CONCEIVED" && !originalSubject)) judgment = "UNPROVEN";
  else judgment = "ACCEPT";

  if (judgment === "ACCEPT") bases.push({ code: "SEALED_OBLIGATIONS_SATISFIED", summary: originalSubject ? "The exact original-subject obligation has independently admitted support; creation and embodiment remain separate assessments." : "All critical sealed obligations have decisive support and all critical assays passed.", evidenceIds: originalSubject ? obligations.flatMap(obligation => input.graph.strongestSupport(obligation.id, true).evidenceIds) : assays.filter((assay) => assay.critical).flatMap((assay) => assay.evidenceIds), obligationIds: obligations.filter((entry) => entry.critical).map((entry) => entry.id) });

  const feasibilityByCandidate: Record<string, Feasibility> = {};
  for (const candidate of candidates) feasibilityByCandidate[candidate.id] = candidate.feasibility;
  const axes = evaluateWasmPolicy(input, audit.findings);
  assertPolicyParity({ integrity: fatal.length === 0 && !auditInvalid ? "VALID" : "INVALID", creation, embodiment, judgment }, axes);

  return Object.freeze({
    policyVersion: input.policyVersion ?? DEFAULT_POLICY_VERSION,
    intentContractDigest: input.intentContractDigest,
    evidenceDigest: input.graph.digest(),
    ...axes,
    ...(selected === undefined ? {} : { selectedCandidateId: selected.id }),
    feasibilityByCandidate: Object.freeze(feasibilityByCandidate),
    basis: sortedBasis(bases),
  });
}
